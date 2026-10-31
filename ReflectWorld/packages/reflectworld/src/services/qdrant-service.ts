/**
 * Qdrant service manager — subprocess lifecycle for a prepared Qdrant binary.
 *
 * Qdrant releases static binaries on GitHub:
 *   https://github.com/qdrant/qdrant/releases/download/v{ver}/qdrant-{target}.tar.gz
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveReflectWorldHome } from "@reflectworld/shared";
import {
  downloadFile,
  extractTarGz,
  makeExecutable,
  waitForHealthy,
  cleanupArchive,
  ensureDir,
  isServiceHealthy,
} from "./download.js";
import { writeStderr, writeStdout } from "@reflectworld/shared";

const QDRANT_VERSION = "1.17.1";
const QDRANT_LOG_TAIL_BYTES = 12_000;

function tailAppend(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return next.length > QDRANT_LOG_TAIL_BYTES ? next.slice(-QDRANT_LOG_TAIL_BYTES) : next;
}

function formatQdrantLogTail(stdoutTail: string, stderrTail: string): string {
  const sections: string[] = [];
  if (stderrTail.trim()) sections.push(`stderr:\n${stderrTail.trim()}`);
  if (stdoutTail.trim()) sections.push(`stdout:\n${stdoutTail.trim()}`);
  return sections.length ? `\n\nRecent Qdrant output:\n${sections.join("\n\n")}` : "";
}

export interface QdrantServiceOptions {
  stateDir: string;
  /** Read-only asset root (~/.reflectworld). Binaries live under homeDir/bin/. */
  homeDir?: string;
  httpPort?: number;
  grpcPort?: number;
}

export type QdrantRuntimeMode = "stopped" | "external" | "managed";

function getQdrantTargets(): string[] {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "darwin") {
    return [arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"];
  }
  if (platform === "linux") {
    if (arch === "arm64") {
      return ["aarch64-unknown-linux-musl", "aarch64-unknown-linux-gnu"];
    }
    return ["x86_64-unknown-linux-musl", "x86_64-unknown-linux-gnu"];
  }
  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

export function resolveQdrantBinary(homeDir?: string): string {
  const home = homeDir ?? resolveReflectWorldHome();
  const binPath = join(home, "bin", "qdrant");
  if (existsSync(binPath)) return binPath;
  throw new Error(
    `Qdrant binary is not prepared at ${binPath}. Run ` +
    "`npx tsx packages/reflectworld/scripts/setup-qdrant.ts` during environment setup.",
  );
}

export async function setupQdrantBinary(homeDir?: string): Promise<string> {
  const home = homeDir ?? resolveReflectWorldHome();
  const binDir = join(home, "bin");
  ensureDir(binDir);
  const binPath = join(binDir, "qdrant");
  if (existsSync(binPath)) return binPath;

  const targets = getQdrantTargets();
  const archivePath = join(binDir, `qdrant-${QDRANT_VERSION}-download.tar.gz`);
  let lastError: unknown;

  for (const target of targets) {
    const url = `https://github.com/qdrant/qdrant/releases/download/v${QDRANT_VERSION}/qdrant-${target}.tar.gz`;
    writeStdout(`[qdrant] Downloading Qdrant v${QDRANT_VERSION} for ${target}...`);
    try {
      await downloadFile(url, archivePath);
      extractTarGz(archivePath, binDir);
      makeExecutable(binPath);
      cleanupArchive(archivePath);
      writeStdout("[qdrant] Downloaded.");
      return binPath;
    } catch (err) {
      lastError = err;
      cleanupArchive(archivePath);
      writeStderr(`[qdrant] Download failed for target ${target}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(
    `Failed to download Qdrant v${QDRANT_VERSION} for targets: ${targets.join(", ")}. ` +
    `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

export class QdrantService {
  private process: ChildProcess | null = null;
  private stdoutTail = "";
  private stderrTail = "";
  private modeValue: QdrantRuntimeMode = "stopped";
  private readonly homeDir: string;
  private readonly stateDir: string;
  private readonly httpPort: number;
  private readonly grpcPort: number;
  private readonly storageDir: string;

  constructor(options: QdrantServiceOptions) {
    this.homeDir = options.homeDir ?? resolveReflectWorldHome();
    this.stateDir = options.stateDir;
    this.httpPort = options.httpPort ?? 6333;
    this.grpcPort = options.grpcPort ?? 6334;
    this.storageDir = join(this.stateDir, "qdrant-storage");
  }

  get endpoint(): string {
    return `http://127.0.0.1:${this.httpPort}`;
  }

  get mode(): QdrantRuntimeMode {
    return this.modeValue;
  }

  async start(): Promise<void> {
    // Skip if a real Qdrant instance is already healthy on the target port
    if (await isServiceHealthy(this.endpoint, "/healthz")) {
      this.modeValue = "external";
      writeStdout(`[qdrant] Reusing external service on port ${this.httpPort}`);
      return;
    }

    const binPath = resolveQdrantBinary(this.homeDir);
    ensureDir(this.storageDir);
    this.stdoutTail = "";
    this.stderrTail = "";

    this.process = spawn(binPath, [], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        QDRANT__SERVICE__HTTP_PORT: String(this.httpPort),
        QDRANT__SERVICE__GRPC_PORT: String(this.grpcPort),
        QDRANT__STORAGE__STORAGE_PATH: this.storageDir,
      },
    });

    this.process.stdout?.on("data", (chunk: Buffer) => {
      this.stdoutTail = tailAppend(this.stdoutTail, chunk);
    });
    this.process.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = tailAppend(this.stderrTail, chunk);
    });
    this.process.on("error", (err) => {
      this.stderrTail = tailAppend(this.stderrTail, Buffer.from(err.message));
      writeStderr("[qdrant] Process error:", err.message);
    });

    const startTimeoutMs = Math.max(
      30_000,
      Number.parseInt(process.env.QDRANT_START_TIMEOUT_MS ?? "", 10) || 30_000,
    );
    const healthy = await waitForHealthy(`${this.endpoint}/healthz`, startTimeoutMs);
    if (!healthy) {
      this.process.kill("SIGTERM");
      this.process = null;
      this.modeValue = "stopped";
      throw new Error(
        `Qdrant failed to start within ${Math.round(startTimeoutMs / 1000)}s` +
        formatQdrantLogTail(this.stdoutTail, this.stderrTail),
      );
    }
    this.modeValue = "managed";
    writeStdout(`[qdrant] Running on port ${this.httpPort}`);
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
      }, 3000);
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

}
