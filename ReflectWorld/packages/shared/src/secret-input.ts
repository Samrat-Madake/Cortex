/** OpenClaw SecretRef shape used by plugin config secrets. */
export interface SecretRef {
  source: "env" | "file" | "exec";
  provider?: string;
  id: string;
}

export function isSecretRef(value: unknown): value is SecretRef {
  return typeof value === "object" && value !== null && "source" in value && "id" in value;
}

function warnSecretInput(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * Resolve an OpenClaw SecretInput (string | SecretRef) to a plain string.
 * Plain strings are used as-is. Env-backed SecretRefs read process.env[id].
 */
export function normalizeSecretInput(
  value: unknown,
  logPrefix = "cortex",
  warn: (message: string) => void = warnSecretInput,
): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (isSecretRef(value)) {
    if (value.source === "env") return process.env[value.id] || undefined;
    warn(`[${logPrefix}] SecretRef source "${value.source}" is not supported in plugin config; use plaintext or env source. id=${value.id}`);
  }
  return undefined;
}
