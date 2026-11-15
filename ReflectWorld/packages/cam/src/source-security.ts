import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface SourceSecurityOptions {
  strict: boolean;
  allowHttp?: boolean;
  allowLocalSource?: boolean;
  allowPrivateNetwork?: boolean;
  resolveHost?: (hostname: string) => Promise<string[]>;
}

export type SourceValidationResult =
  | { ok: true }
  | { ok: false; code: string; error: string };

function envFlag(name: string, fallback = false): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function shouldUseStrictSourceValidation(params: Record<string, unknown>): boolean {
  const requested = typeof params._sourceSecurityMode === "string"
    ? params._sourceSecurityMode.trim().toLowerCase()
    : "";
  if (["local", "local_trusted", "trusted", "off", "false"].includes(requested)) return false;
  if (["strict", "public", "multi_user", "on", "true"].includes(requested)) return true;
  if (envFlag("CORTEX_SOURCE_SECURITY_STRICT") || envFlag("CORTEX_PUBLIC_MODE")) return true;
  return typeof params._dashboardUserId === "string" || typeof params._dashboardSessionId === "string";
}

export function defaultSourceSecurityOptions(strict: boolean, params: Record<string, unknown>): SourceSecurityOptions {
  return {
    strict,
    allowHttp: envFlag("CORTEX_ALLOW_INSECURE_HTTP_SOURCE"),
    allowLocalSource: params._allowLocalFileSource === true || envFlag("CORTEX_ALLOW_LOCAL_SOURCE"),
    allowPrivateNetwork: envFlag("CORTEX_ALLOW_PRIVATE_SOURCE"),
  };
}

export function sourceSecurityEnvWarnings(): string[] {
  if (!envFlag("CORTEX_PUBLIC_MODE")) return [];
  const warnings: string[] = [];
  if (envFlag("CORTEX_ALLOW_PRIVATE_SOURCE")) {
    warnings.push(
      "CORTEX_PUBLIC_MODE=true with CORTEX_ALLOW_PRIVATE_SOURCE=true allows private, loopback, link-local, and reserved source targets. Use only in trusted LAN deployments; do not enable it for public demos.",
    );
  }
  if (envFlag("CORTEX_ALLOW_LOCAL_SOURCE")) {
    warnings.push(
      "CORTEX_PUBLIC_MODE=true with CORTEX_ALLOW_LOCAL_SOURCE=true allows local file paths and local capture devices. Use only for trusted local deployments.",
    );
  }
  return warnings;
}

function isLocalPath(input: string): boolean {
  return input.startsWith("/") || input.startsWith("./") || input.startsWith("../") || /^[A-Z]:\\/i.test(input);
}

function isLocalCaptureDevice(input: string): boolean {
  return input === "usb" || input.startsWith("usb:") || input.startsWith("avfoundation://") || input.startsWith("v4l2://");
}

function normalizeHostname(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return hostname.slice(1, -1);
  return hostname;
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN;
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255 ? value : Number.NaN;
  });
  return bytes.every(Number.isFinite) ? bytes : null;
}

function ipv4InRange(bytes: number[], first: number, secondMin?: number, secondMax?: number): boolean {
  if (bytes[0] !== first) return false;
  if (secondMin == null) return true;
  return bytes[1] >= secondMin && bytes[1] <= (secondMax ?? secondMin);
}

export function isDisallowedNetworkAddress(address: string): boolean {
  const normalized = normalizeHostname(address).toLowerCase();
  const mapped = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
  const family = isIP(mapped);

  if (family === 4) {
    const bytes = parseIpv4(mapped);
    if (!bytes) return true;
    return (
      ipv4InRange(bytes, 0) ||
      ipv4InRange(bytes, 10) ||
      ipv4InRange(bytes, 100, 64, 127) ||
      ipv4InRange(bytes, 127) ||
      ipv4InRange(bytes, 169, 254) ||
      ipv4InRange(bytes, 172, 16, 31) ||
      ipv4InRange(bytes, 192, 0) ||
      ipv4InRange(bytes, 192, 168) ||
      ipv4InRange(bytes, 198, 18, 19) ||
      (bytes[0] === 198 && bytes[1] === 51 && bytes[2] === 100) ||
      (bytes[0] === 203 && bytes[1] === 0 && bytes[2] === 113) ||
      bytes[0] >= 224
    );
  }

  if (family === 6) {
    if (normalized === "::" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
    const first = Number.parseInt(normalized.split(":")[0] || "0", 16);
    if (!Number.isFinite(first)) return true;
    return (
      (first & 0xfe00) === 0xfc00 ||
      (first & 0xffc0) === 0xfe80 ||
      (first & 0xff00) === 0xff00
    );
  }

  return false;
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

async function resolvedAddresses(hostname: string, resolveHost?: (hostname: string) => Promise<string[]>): Promise<string[]> {
  const host = normalizeHostname(hostname);
  if (isIP(host)) return [host];
  return (resolveHost ?? defaultResolveHost)(host);
}

export async function validateSourceInputSecurity(
  raw: unknown,
  options: SourceSecurityOptions,
): Promise<SourceValidationResult> {
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, code: "invalid_source", error: "source must be a non-empty string" };
  }
  if (!options.strict) return { ok: true };

  const input = raw.trim();
  if (input === "phone" || input === "webcam") return { ok: true };
  if (isLocalCaptureDevice(input)) {
    if (options.allowLocalSource) return { ok: true };
    return { ok: false, code: "local_device_not_allowed", error: "Local capture devices are not allowed in strict source mode" };
  }
  if (isLocalPath(input)) {
    if (options.allowLocalSource) return { ok: true };
    return { ok: false, code: "local_path_not_allowed", error: "Local file paths are not allowed in strict source mode" };
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, code: "unsupported_source", error: "Only explicit rtsp, rtsps, https, or allowed http URLs are accepted in strict source mode" };
  }

  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (scheme === "file") {
    return { ok: false, code: "file_url_not_allowed", error: "file:// URLs are not allowed in strict source mode" };
  }
  if (scheme === "http" && !options.allowHttp) {
    return { ok: false, code: "http_not_allowed", error: "http:// sources are disabled in strict source mode; use https/rtsp or set CORTEX_ALLOW_INSECURE_HTTP_SOURCE=true" };
  }
  if (!["rtsp", "rtsps", "https"].includes(scheme) && !(scheme === "http" && options.allowHttp)) {
    return { ok: false, code: "unsupported_scheme", error: `Source scheme "${scheme}" is not allowed in strict source mode` };
  }

  let addresses: string[];
  try {
    addresses = await resolvedAddresses(url.hostname, options.resolveHost);
  } catch {
    return { ok: false, code: "source_host_unresolved", error: `Could not resolve source host "${url.hostname}"` };
  }
  if (addresses.length === 0) {
    return { ok: false, code: "source_host_unresolved", error: `Could not resolve source host "${url.hostname}"` };
  }
  if (!options.allowPrivateNetwork && addresses.some(isDisallowedNetworkAddress)) {
    return { ok: false, code: "private_network_not_allowed", error: `Source host "${url.hostname}" resolves to a private, local, or reserved network address` };
  }

  return { ok: true };
}
