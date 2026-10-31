/**
 * ReflectWorld service manager — auto-start Python FastAPI service.
 *
 * Strategies (tried in order):
 * 1. Already running on target port → skip
 * 2. uv available → uv run uvicorn (fastest, recommended)
 * 3. python3 available → venv + pip install -e + uvicorn
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReflectWorldHome } from "@reflectworld/shared";
import { commandExists } from "./download.js";
import { writeStderr, writeStdout } from "@reflectworld/shared";

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);

// Walk up from current file to find the @reflectworld/reflectworld package root.
function findVmPkgRoot(startDir: string): string {
  let dir = startDir;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        if (pkg.name === "@reflectworld/reflectworld") return dir;
      } catch { /* skip unreadable package.json */ }
    }
    dir = dirname(dir);
  }
  return startDir;
}
const __vmPkgRoot = findVmPkgRoot(__dirname_local);
const MANAGED_SERVICE_HOST = "127.0.0.1";

export interface ReflectWorldServiceOptions {
  stateDir: string;
  /** Read-only asset root (~/.reflectworld). Binaries live under homeDir/bin/. */
  homeDir?: string;
  port?: number;
  qdrantHost?: string;
  qdrantPort?: number;
  /** Path to ReflectWorld source directory (default: auto-detect from monorepo). */
  sourceDir?: string;
  /** Optional isolated storage path for history DB and local memory artifacts. */
  storagePath?: string;
  /** Optional base Qdrant collection name. */
  collectionName?: string;
  /** When true, stream managed Python Mem stdout/stderr live. */
  verboseLogs?: boolean;
  /** Explicitly allow loading .env from sourceDir for managed Python service env. */
  loadDotEnv?: boolean;
}

export type ReflectWorldRuntimeMode = "stopped" | "external" | "uv" | "python";

interface ManagedLogTail {
  stdout: string;
  stderr: string;
}

class ManagedServiceStartupError extends Error {
  constructor(
    message: string,
    readonly allowFallback: boolean,
  ) {
    super(message);
    this.name = "ManagedServiceStartupError";
  }
}

interface ReflectWorldHealth {
  ok: boolean;
  collectionPrefix?: string;
}

function isReflectWorldDebugEnabled(): boolean {
  const values = [process.env.REFLECTWORLD_DEBUG, process.env.DEBUG].filter(Boolean).map((v) => String(v).toLowerCase());
  return values.some((value) =>
    value === "1" ||
    value === "true" ||
    value === "yes" ||
    value === "on" ||
    value === "reflectworld" ||
    value.includes("reflectworld:*") ||
    value.includes("reflectworld:mem")
  );
}

function appendTail(current: string, chunk: Buffer): string {
  return (current + chunk.toString("utf8")).slice(-4096);
}

export class ReflectWorldService {
  private process: ChildProcess | null = null;
  private modeValue: ReflectWorldRuntimeMode = "stopped";
  private port: number;
  private readonly qdrantHost: string;
  private readonly qdrantPort: number;
  private readonly homeDir: string;
  private readonly stateDir: string;
  private configuredSourceDir: string | undefined;
  private readonly sourceDir: string | null;
  private readonly storagePath?: string;
  private readonly collectionName?: string;
  private readonly verboseLogs: boolean;
  private readonly loadDotEnvEnabled: boolean;

  constructor(options: ReflectWorldServiceOptions) {
    this.homeDir = options.homeDir ?? resolveReflectWorldHome();
    this.stateDir = options.stateDir;
    this.port = options.port ?? 8219;
    this.qdrantHost = options.qdrantHost ?? "127.0.0.1";
    this.qdrantPort = options.qdrantPort ?? 6333;
    this.configuredSourceDir = options.sourceDir;
    this.sourceDir = options.sourceDir ?? this.detectSourceDir();
    this.storagePath = options.storagePath;
    this.collectionName = options.collectionName;
    this.verboseLogs = options.verboseLogs ?? isReflectWorldDebugEnabled();
    this.loadDotEnvEnabled = options.loadDotEnv ?? process.env.REFLECTWORLD_SERVICE_LOAD_DOTENV === "1";
  }

  get endpoint(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get mode(): ReflectWorldRuntimeMode {
    return this.modeValue;
  }

  async start(): Promise<void> {
    // 1. Already running? Reuse only if no custom collection prefix.
    // E2E/benchmark need their own Mem service with isolated collections.
    const health = await this.fetchHealth();
    if (health.ok) {
      if (this.collectionName) {
        if (health.collectionPrefix === this.collectionName) {
          this.modeValue = "external";
          writeStdout(`[reflectworld] Reusing external service on port ${this.port} for collection prefix ${this.collectionName}`);
          await this.ensureCollections({ required: true });
          return;
        }
        // Custom collection prefix differs from the running service — start our
        // own service without killing the existing process.
        const origPort = this.port;
        this.port = await this.findFreePort(this.port + 1);
        writeStdout(`[reflectworld] Port ${origPort} occupied by prefix ${health.collectionPrefix ?? "unknown"}, using ${this.port} for collection prefix ${this.collectionName}`);
      } else {
        this.modeValue = "external";
        writeStdout(`[reflectworld] Reusing external service on port ${this.port}`);
        return;
      }
    }

    // 2. uv? (fastest) — check homeDir/bin/uv first, then PATH
    let started = false;
    let lastStartError: unknown;
    const hasUv = existsSync(join(this.homeDir, "bin", "uv")) || commandExists("uv");
    if (hasUv && this.sourceDir) {
      try {
        await this.startUv();
        started = true;
      } catch (err) {
        lastStartError = err;
        writeStderr(`[reflectworld] uv start failed: ${err instanceof Error ? err.message : err}`);
        if (err instanceof ManagedServiceStartupError && !err.allowFallback) throw err;
      }
    }

    // 3. python3? — check sourceDir/.venv first, then PATH
    const hasPython = (this.sourceDir && existsSync(join(this.sourceDir, ".venv", "bin", "python"))) || commandExists("python3");
    if (!started && hasPython && this.sourceDir) {
      try {
        await this.startPython();
        started = true;
      } catch (err) {
        lastStartError = err;
        writeStderr(`[reflectworld] python3 start failed: ${err instanceof Error ? err.message : err}`);
        if (err instanceof ManagedServiceStartupError && !err.allowFallback) throw err;
      }
    }

    if (!started) {
      if (lastStartError) {
        const detail = lastStartError instanceof Error ? lastStartError.message : String(lastStartError);
        throw new Error(`Cannot start ReflectWorld managed memory service. Last error: ${detail}`);
      }
      throw new Error(
        "Cannot start ReflectWorld. Install uv (recommended) or Python 3.10+. " +
        `Or start ReflectWorld manually on port ${this.port}.`,
      );
    }

    try {
      await this.ensureCollections({ required: true });
    } catch (err) {
      await this.stop().catch(() => {});
      throw err;
    }
  }

  private async fetchHealth(timeoutMs = 2000): Promise<ReflectWorldHealth> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const resp = await fetch(`${this.endpoint}/health`, { signal: controller.signal });
      clearTimeout(timer);
      if (!resp.ok) return { ok: false };
      const body = await resp.json().catch(() => ({})) as Record<string, unknown>;
      return {
        ok: true,
        collectionPrefix: typeof body.collection_prefix === "string" ? body.collection_prefix : undefined,
      };
    } catch {
      return { ok: false };
    }
  }

  private async ensureCollections(options: { required?: boolean } = {}): Promise<void> {
    if (this.collectionName) {
      try {
        const resp = await fetch(`${this.endpoint}/ensure-collections`, { method: "POST" });
        if (!resp.ok) {
          throw new Error(`ensure-collections returned ${resp.status}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (options.required) throw new Error(`ensure-collections failed: ${message}`);
        writeStderr(`[reflectworld] ensure-collections failed: ${message}`);
      }
    }
  }

  async stop(): Promise<void> {
    if (this.modeValue === "external") {
      this.modeValue = "stopped";
      return;
    }
    const proc = this.process;
    if (!proc) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        if (proc.exitCode == null && !proc.killed) proc.kill("SIGKILL");
        finish();
      }, 5000);
      proc.once("exit", finish);
      if (proc.exitCode != null) {
        finish();
        return;
      }
      proc.kill("SIGTERM");
    });
    this.process = null;
    this.modeValue = "stopped";
  }

  /** Detect ReflectWorld Python source dir — works both in monorepo and after npm install. */
  private detectSourceDir(): string | null {
    const candidates = [
      this.configuredSourceDir,
      join(this.homeDir, "services", "mem"),
      join(__vmPkgRoot, "bundled-services", "mem"),
      join(__vmPkgRoot, "..", "..", "services", "mem"),
      join(process.cwd(), "services", "mem"),
    ];
    for (const dir of candidates) {
      if (!dir) continue;
      const resolved = resolve(dir);
      if (existsSync(join(resolved, "pyproject.toml"))) return resolved;
    }
    return null;
  }

  /** Find a free port starting from `start`. */
  private findFreePort(start: number): Promise<number> {
    return new Promise((resolve, reject) => {
      import("node:net").then(({ createServer }) => {
        const server = createServer();
        server.listen(start, "127.0.0.1", () => {
          const addr = server.address() as { port: number };
          server.close(() => resolve(addr.port));
        });
        server.on("error", () => {
          if (start < 65535) {
            this.findFreePort(start + 1).then(resolve, reject);
          } else {
            reject(new Error("No free port found"));
          }
        });
      });
    });
  }

  /** Load key=value pairs from a .env file (no interpolation). */
  private loadDotEnv(): Record<string, string> {
    if (!this.loadDotEnvEnabled) return {};
    if (!this.sourceDir) return {};
    // Look for .env in monorepo root (one level above services/mem)
    const candidates = [
      join(this.sourceDir, ".env"),
      join(this.sourceDir, "..", "..", ".env"),
    ];
    for (const p of candidates) {
      const resolved = resolve(p);
      if (!existsSync(resolved)) continue;
      const vars: Record<string, string> = {};
      for (const line of readFileSync(resolved, "utf-8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq < 1) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim();
        if (val) vars[key] = val;
      }
      return vars;
    }
    return {};
  }

  private envVars(): Record<string, string> {
    const env: Record<string, string> = {
      ...this.loadDotEnv(),
      ...process.env as Record<string, string>,
      QDRANT_HOST: this.qdrantHost,
      QDRANT_PORT: String(this.qdrantPort),
    };
    if (!env.MONITOR_WEBHOOK_URL) {
      const dashboardPort = env.DASHBOARD_PORT ?? env.MONITOR_PORT ?? env.PORT ?? "3211";
      env.MONITOR_WEBHOOK_URL = `http://127.0.0.1:${dashboardPort}/api/memory-event`;
    }
    if (this.storagePath) {
      env.STORAGE_PATH = this.storagePath;
    } else if (!env.STORAGE_PATH) {
      env.STORAGE_PATH = join(this.homeDir, "memory-state");
    }
    if (this.collectionName) env.COLLECTION_PREFIX = this.collectionName;
    return env;
  }

  private attachProcessLogs(prefix: string): ManagedLogTail {
    const logs: ManagedLogTail = { stdout: "", stderr: "" };
    this.process?.stdout?.on("data", (d: Buffer) => {
      logs.stdout = appendTail(logs.stdout, d);
      if (this.verboseLogs) writeStdout(`[${prefix}] ${d.toString().trimEnd()}`);
    });
    this.process?.stderr?.on("data", (d: Buffer) => {
      logs.stderr = appendTail(logs.stderr, d);
      if (this.verboseLogs) writeStdout(`[${prefix}] ${d.toString().trimEnd()}`);
    });
    return logs;
  }

  private formatProcessLogTail(logs: ManagedLogTail): string {
    const stdout = logs.stdout.trim();
    const stderr = logs.stderr.trim();
    if (!stdout && !stderr) return "";
    return [
      stderr ? `stderr_tail=${stderr}` : "",
      stdout ? `stdout_tail=${stdout}` : "",
    ].filter(Boolean).join(" ");
  }

  private async startUv(): Promise<void> {
    this.modeValue = "uv";

    const uvBin = existsSync(join(this.homeDir, "bin", "uv"))
      ? join(this.homeDir, "bin", "uv")
      : "uv";

    this.process = spawn(uvBin, [
      "run", "--project", this.sourceDir!,
      "uvicorn", "src.main:app", "--host", MANAGED_SERVICE_HOST, "--port", String(this.port),
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      env: this.envVars(),
      cwd: this.sourceDir!,
    });

    const logs = this.attachProcessLogs("reflectworld:uv");
    this.process.on("error", (err) => { writeStderr(`[reflectworld:uv] spawn error: ${err.message}`); });

    // First run: `uv run` resolves + downloads the entire dep tree on demand
    // (openai + google-generativeai + grpcio + numpy + ...), which on a cold
    // machine easily exceeds 90s. Use 5 minutes — still bounded, but gives
    // first-install time to finish. Subsequent runs hit the cache and return
    // in seconds.
    await this.waitForManagedHealth("uv", logs);
    writeStdout(`[reflectworld] Running via uv on port ${this.port}`);
  }

  private async startPython(): Promise<void> {
    this.modeValue = "python";

    const venvDir = join(this.sourceDir!, ".venv");

    // Create venv if needed
    if (!existsSync(join(venvDir, "bin", "python"))) {
      writeStdout("[reflectworld] Creating Python venv...");
      execFileSync("python3", ["-m", "venv", venvDir], { timeout: 30_000, stdio: "ignore" });
      // python -m venv ships an old bundled pip (often 21.2) that cannot
      // editable-install a pyproject.toml-only project. Upgrade pip /
      // setuptools / wheel first so PEP 660 editable installs work.
      writeStdout("[reflectworld] Upgrading pip + setuptools + wheel...");
      execFileSync(join(venvDir, "bin", "pip"), [
        "install", "--quiet", "--upgrade", "pip", "setuptools", "wheel",
      ], { timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
      writeStdout("[reflectworld] Installing dependencies...");
      execFileSync(join(venvDir, "bin", "pip"), [
        "install", "-e", this.sourceDir!,
      ], { timeout: 300_000, stdio: ["ignore", "pipe", "pipe"] });
    }

    const pythonBin = join(venvDir, "bin", "python");
    this.process = spawn(pythonBin, [
      "-m", "uvicorn", "src.main:app", "--host", MANAGED_SERVICE_HOST, "--port", String(this.port),
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      env: this.envVars(),
      cwd: this.sourceDir!,
    });

    const logs = this.attachProcessLogs("reflectworld:python");
    this.process.on("error", (err) => { writeStderr(`[reflectworld:python] spawn error: ${err.message}`); });

    await this.waitForManagedHealth("python", logs);
    writeStdout(`[reflectworld] Running via python venv on port ${this.port}`);
  }

  private async waitForManagedHealth(kind: "uv" | "python", logs: ManagedLogTail): Promise<void> {
    const child = this.process;
    if (!child) {
      throw new ManagedServiceStartupError(`ReflectWorld (${kind}) process was not started`, kind === "uv");
    }

    type WaitResult =
      | { type: "healthy" }
      | { type: "timeout" }
      | { type: "exit"; code: number | null; signal: NodeJS.Signals | null }
      | { type: "error"; error: Error };

    let cancelled = false;
    let cleanup = () => {};
    const processEvent = new Promise<WaitResult>((resolve) => {
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => resolve({ type: "exit", code, signal });
      const onError = (error: Error) => resolve({ type: "error", error });
      child.once("exit", onExit);
      child.once("error", onError);
      cleanup = () => {
        child.off("exit", onExit);
        child.off("error", onError);
      };
    });

    const healthEvent = this.waitForHealthOrCancel(300_000, () => cancelled);
    const result = await Promise.race([healthEvent, processEvent]);
    cancelled = true;
    cleanup();

    if (result.type === "healthy") return;

    const tail = this.formatProcessLogTail(logs);
    const detail = tail ? `. ${tail}` : "";
    this.process = null;
    this.modeValue = "stopped";

    if (result.type === "timeout") {
      child.kill("SIGTERM");
      throw new Error(`ReflectWorld (${kind}) failed to become healthy within 300s${detail}`);
    }

    if (result.type === "error") {
      throw new ManagedServiceStartupError(
        `ReflectWorld (${kind}) failed to spawn: ${result.error.message}${detail}`,
        kind === "uv",
      );
    }

    const exitStatus = result.signal
      ? `signal=${result.signal}`
      : `code=${result.code === null ? "unknown" : result.code}`;
    throw new ManagedServiceStartupError(
      `ReflectWorld (${kind}) exited during startup (${exitStatus})${detail}`,
      false,
    );
  }

  private async waitForHealthOrCancel(timeoutMs: number, isCancelled: () => boolean): Promise<{ type: "healthy" } | { type: "timeout" }> {
    const start = Date.now();
    while (!isCancelled() && Date.now() - start < timeoutMs) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      try {
        const res = await fetch(`${this.endpoint}/health`, { signal: controller.signal });
        if (res.ok) return { type: "healthy" };
      } catch { /* not ready yet */ }
      finally {
        clearTimeout(timer);
      }
      if (!isCancelled()) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    return { type: "timeout" };
  }
}
