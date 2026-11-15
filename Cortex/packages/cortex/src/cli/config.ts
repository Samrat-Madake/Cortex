import { join } from "node:path";
import { resolveCortexHome, resolveCortexStateDir, canonicalize } from "@cortex/shared";

export interface CliConfig {
  homeDir: string;
  stateDir: string;
  dev: boolean;

  port: number;
  qdrantPort: number;
  qdrantGrpcPort: number;
  memPort: number;
  go2rtcApiPort: number;
  go2rtcRtspPort: number;
  go2rtcWebrtcPort: number;
  go2rtcListenAddr: string;
  go2rtcReuseExternal: boolean;

  binDir: string;
  modelsDir: string;
  pythonSourceDir: string;
}

function parseIntOr(val: string | undefined, fallback: number): number {
  if (!val) return fallback;
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseBoolOr(val: string | undefined, fallback: boolean): boolean {
  if (val === undefined) return fallback;
  const normalized = val.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function getArg(args: string[], name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

/**
 * Resolve all CLI config AFTER dotenv.config() has been called.
 * Priority: CLI args > env vars > .env (already loaded) > defaults.
 * Writes canonical values back to process.env for shared resolvers.
 */
export function resolveCliConfig(args: string[]): CliConfig {
  const dev = args.includes("--dev");

  // Directories — CLI args override env (env already merged with .env by dotenv)
  // CLI args must be canonicalized same as resolvers do
  const rawHomeDir = getArg(args, "home-dir");
  const rawStateDir = getArg(args, "state-dir");
  const homeDir = rawHomeDir ? canonicalize(rawHomeDir) : resolveCortexHome();
  const stateDir = rawStateDir ? canonicalize(rawStateDir) : resolveCortexStateDir();

  // Ports — CLI --port overrides env PORT
  const port = parseIntOr(getArg(args, "port") ?? process.env.PORT, 3210);
  const qdrantPort = parseIntOr(process.env.QDRANT_PORT, 6333);
  const qdrantGrpcPort = parseIntOr(process.env.QDRANT_GRPC_PORT, qdrantPort + 1);
  const memPort = parseIntOr(process.env.CORTEX_MEM_PORT, 8219);
  const go2rtcApiPort = parseIntOr(process.env.GO2RTC_API_PORT, 1984);
  const go2rtcRtspPort = parseIntOr(process.env.GO2RTC_RTSP_PORT, 8554);
  const go2rtcWebrtcPort = parseIntOr(process.env.GO2RTC_WEBRTC_PORT, 8555);
  const go2rtcListenAddr = process.env.GO2RTC_LISTEN_ADDR?.trim() || "127.0.0.1";
  const go2rtcReuseExternal = parseBoolOr(process.env.GO2RTC_REUSE_EXTERNAL, true);

  // Derived
  const binDir = join(homeDir, "bin");
  const modelsDir = join(homeDir, "models");
  const pythonSourceDir = dev
    ? join(process.cwd(), "services", "mem")
    : join(homeDir, "services", "mem");

  const config: CliConfig = {
    homeDir, stateDir, dev,
    port, qdrantPort, qdrantGrpcPort, memPort,
    go2rtcApiPort, go2rtcRtspPort, go2rtcWebrtcPort, go2rtcListenAddr, go2rtcReuseExternal,
    binDir, modelsDir, pythonSourceDir,
  };

  // Write back to process.env so shared resolvers see CLI values
  process.env.CORTEX_HOME = homeDir;
  process.env.CORTEX_STATE_DIR = stateDir;
  process.env.CORTEX_MODELS_DIR = modelsDir;
  process.env.PORT = String(port);
  process.env.QDRANT_PORT = String(qdrantPort);
  process.env.QDRANT_GRPC_PORT = String(qdrantGrpcPort);
  process.env.CORTEX_MEM_PORT = String(memPort);
  process.env.GO2RTC_API_PORT = String(go2rtcApiPort);
  process.env.GO2RTC_RTSP_PORT = String(go2rtcRtspPort);
  process.env.GO2RTC_WEBRTC_PORT = String(go2rtcWebrtcPort);
  process.env.GO2RTC_LISTEN_ADDR = go2rtcListenAddr;
  process.env.GO2RTC_REUSE_EXTERNAL = String(go2rtcReuseExternal);

  return config;
}

/** Resolve just homeDir (for setup command which doesn't need full config). */
export function resolveHomeDir(args: string[]): string {
  const rawHomeDir = getArg(args, "home-dir");
  const homeDir = rawHomeDir ? canonicalize(rawHomeDir) : resolveCortexHome();
  process.env.CORTEX_HOME = homeDir;
  return homeDir;
}
