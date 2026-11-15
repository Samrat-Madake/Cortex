import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { writeStderr } from "@cortex/shared";

/** go2rtc RTSP does not support non-ASCII path names; map them to hex aliases. */
export function toRtspSafeName(name: string): string {
  if (/^[\x21-\x7e]+$/.test(name)) return name;
  return "_" + Buffer.from(name).toString("hex");
}

export interface Go2rtcManagerOptions {
  binPath: string;
  apiPort?: number;
  rtspPort?: number;
  webrtcPort?: number;
  /** Whether an already-running go2rtc on the API port may be reused. Defaults true for self-host compatibility. */
  reuseExternal?: boolean;
  /** Warning sink used when a potentially unsafe external go2rtc is reused. */
  onWarning?: (message: string) => void;
  configDir?: string;
  /**
   * Address go2rtc binds its api/rtsp/webrtc listeners to. Defaults to loopback
   * so Dashboard can proxy browser access safely. Set 0.0.0.0 only for
   * self-host deployments that intentionally expose go2rtc directly.
   */
  listenAddr?: string;
  /** Streams to include in go2rtc.yaml (needed for exec: sources that cannot be added via API). */
  initialStreams?: Record<string, string[]>;
}

export type Go2rtcRuntimeMode = "stopped" | "external" | "managed";

export class Go2rtcManager {
  private process: ChildProcess | null = null;
  private readonly binPath: string;
  private readonly apiPort: number;
  private readonly rtspPort: number;
  private readonly webrtcPort: number;
  private readonly reuseExternal: boolean;
  private readonly onWarning: (message: string) => void;
  private readonly listenAddr: string;
  private readonly configDir: string;
  private readonly apiBase: string;
  private readonly configStreams: Record<string, string[]>;
  private runtimeMode: Go2rtcRuntimeMode = "stopped";

  constructor(options: Go2rtcManagerOptions) {
    this.binPath = options.binPath;
    this.apiPort = options.apiPort ?? 1984;
    this.rtspPort = options.rtspPort ?? 8554;
    this.webrtcPort = options.webrtcPort ?? 8555;
    this.reuseExternal = options.reuseExternal ?? true;
    this.onWarning = options.onWarning ?? ((message) => writeStderr(message));
    this.listenAddr = options.listenAddr?.trim() || "127.0.0.1";
    this.configDir = options.configDir ?? join(dirname(options.binPath), "..");
    this.apiBase = `http://127.0.0.1:${this.apiPort}`;
    this.configStreams = { ...(options.initialStreams ?? {}) };
  }

  get isRunning(): boolean {
    if (this.runtimeMode === "external") return true;
    return this.process !== null && !this.process.killed;
  }

  get mode(): Go2rtcRuntimeMode {
    return this.runtimeMode;
  }

  get rtspBase(): string {
    return `rtsp://127.0.0.1:${this.rtspPort}`;
  }

  async start(): Promise<void> {
    if (this.runtimeMode === "managed" && this.isRunning) return;
    if (this.runtimeMode === "external") {
      if (await this.isHealthy()) return;
      this.runtimeMode = "stopped";
    }

    if (await this.isHealthy()) {
      if (!this.reuseExternal) {
        throw new Error(
          `go2rtc is already running at ${this.apiBase}; external reuse is disabled. ` +
          `Stop the existing process or set go2rtc_reuse_external=true.`,
        );
      }
      if (this.usesPrivateListenAddr()) {
        this.onWarning(
          `[go2rtc] Reusing an already-running external go2rtc at ${this.apiBase}. ` +
          `Configured listenAddr=${this.listenAddr} cannot be applied to external processes; ` +
          `ensure this go2rtc is not exposed publicly.`,
        );
      }
      this.runtimeMode = "external";
      return;
    }

    const configPath = this.writeConfig();
    this.process = spawn(this.binPath, ["-config", configPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process.stdout?.on("data", () => {});
    this.process.stderr?.on("data", () => {});
    try {
      await this.waitForHealthy(go2rtcStartTimeoutMs());
      this.runtimeMode = "managed";
    } catch (err) {
      const proc = this.process;
      if (proc) await this.terminateManagedProcess(proc);
      if (this.process === proc) this.process = null;
      this.runtimeMode = "stopped";
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.runtimeMode === "external") {
      this.runtimeMode = "stopped";
      return;
    }
    const proc = this.process;
    if (!proc) return;
    await this.terminateManagedProcess(proc);
    this.process = null;
    this.runtimeMode = "stopped";
  }

  private async terminateManagedProcess(proc: ChildProcess): Promise<void> {
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
        finish();
      }, 3000);
      proc.once("exit", finish);
      if (proc.exitCode !== null || proc.signalCode !== null) {
        finish();
        return;
      }
      proc.kill("SIGTERM");
    });
  }

  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.apiBase}/api`);
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Add a stream via go2rtc REST API.
   * Uses query params: PUT /api/streams?name={name}&src={sourceUrl}
   * Note: exec: sources are blocked by go2rtc security policy — use initialStreams config instead.
   */
  async addStream(name: string, sources: string[]): Promise<void> {
    if (sources.length === 0) {
      // Register empty stream placeholder
      const url = `${this.apiBase}/api/streams?name=${encodeURIComponent(name)}`;
      const res = await fetch(url, { method: "PUT" });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`go2rtc addStream failed: ${res.status} ${body}`.trim());
      }
      return;
    }
    for (const source of sources) {
      const url = `${this.apiBase}/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(source)}`;
      const res = await fetch(url, { method: "PUT" });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`go2rtc addStream failed: ${res.status} ${body}`.trim());
      }
    }
  }

  /**
   * Add a stream via config file and restart go2rtc.
   * Required for exec: sources which are blocked by go2rtc API security policy.
   */
  async addConfigStream(name: string, sources: string[]): Promise<void> {
    this.configStreams[name] = sources;
    if (this.isRunning) {
      await this.stop();
      await this.start();
    }
  }

  /** Check if a stream is already registered in the config. */
  hasConfigStream(name: string): boolean {
    return name in this.configStreams;
  }

  removeConfigStream(name: string): void {
    delete this.configStreams[name];
  }

  async removeStream(name: string): Promise<void> {
    const res = await fetch(
      `${this.apiBase}/api/streams?name=${encodeURIComponent(name)}`,
      { method: "DELETE" },
    );
    if (!res.ok) throw new Error(`go2rtc removeStream failed: ${res.status}`);
  }

  async listStreams(): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.apiBase}/api/streams`);
    if (!res.ok) throw new Error(`go2rtc listStreams failed: ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  async captureFrame(
    name: string,
    width?: number,
    height?: number,
  ): Promise<Buffer> {
    let url = `${this.apiBase}/api/frame.jpeg?src=${encodeURIComponent(name)}`;
    if (width) url += `&w=${width}`;
    if (height) url += `&h=${height}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`go2rtc captureFrame failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  private writeConfig(): string {
    const configPath = join(this.configDir, "go2rtc.yaml");
    const dir = dirname(configPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const lines = [
      "api:",
      `  listen: "${this.listenAddr}:${this.apiPort}"`,
      "rtsp:",
      `  listen: "${this.listenAddr}:${this.rtspPort}"`,
      "webrtc:",
      `  listen: "${this.listenAddr}:${this.webrtcPort}"`,
      "  ice_servers:",
      "    - urls: [stun:stun.l.google.com:19302]",
    ];

    // Write initial streams to config (needed for exec: sources)
    const streamNames = Object.keys(this.configStreams);
    if (streamNames.length > 0) {
      lines.push("streams:");
      for (const name of streamNames) {
        lines.push(`  ${name}:`);
        for (const src of this.configStreams[name]) {
          lines.push(`    - "${src}"`);
        }
        // go2rtc RTSP cannot route non-ASCII names; add hex alias
        const safe = toRtspSafeName(name);
        if (safe !== name) {
          lines.push(`  ${safe}:`);
          for (const src of this.configStreams[name]) {
            lines.push(`    - "${src}"`);
          }
        }
      }
    }

    lines.push("");
    writeFileSync(configPath, lines.join("\n"));
    return configPath;
  }

  private async waitForHealthy(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.isHealthy()) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`go2rtc did not become healthy within ${timeoutMs}ms`);
  }

  private usesPrivateListenAddr(): boolean {
    return this.listenAddr === "127.0.0.1" || this.listenAddr === "localhost" || this.listenAddr === "::1";
  }
}

function go2rtcStartTimeoutMs(): number {
  const raw = process.env.CORTEX_GO2RTC_START_TIMEOUT_MS ?? process.env.GO2RTC_START_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000;
}
