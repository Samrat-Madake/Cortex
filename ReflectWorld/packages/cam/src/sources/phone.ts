import { execFileSync, execFile, spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Source } from "./types.js";
import type { FrameResult, SnapshotOptions } from "../types.js";

export interface DeviceInfo {
  device: string;
  nodeId: string;
  securityKey: string;
  server: string;
  nodeUrl: string;
}

interface ClawcamListedDevice {
  name: string;
  nodeId?: string;
  securityKey?: string;
  server?: string;
}

export interface PhoneStreamInfo {
  rtspUrl: string;
  rtspPort: number;
  rtspPath: string;
}

/** Check if clawcam CLI is installed and accessible. */
export function checkClawcamInstalled(): boolean {
  try {
    execFileSync("clawcam", ["--version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const PHONE_RTSP_PORT_BASE = 18554;
const PHONE_RTSP_PORT_SPAN = 500;

function phoneRtspPortSeed(name: string): number {
  const hash = Array.from(name).reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
  return PHONE_RTSP_PORT_BASE + (Math.abs(hash) % PHONE_RTSP_PORT_SPAN);
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    let settled = false;
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      server.removeAllListeners();
      if (available) {
        server.close(() => resolve(true));
      } else {
        resolve(false);
      }
    };
    server.once("error", () => finish(false));
    server.once("listening", () => finish(true));
    server.listen(port, "0.0.0.0");
  });
}

function isAddressInUseError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("EADDRINUSE") || message.includes("address already in use");
}

/**
 * PhoneSource — captures frames from a phone camera via ClawCam CLI.
 *
 * ClawCam turns any phone browser into a WebRTC camera source,
 * then bridges the stream to local RTSP for go2rtc consumption.
 *
 * Prerequisites:
 *   npm install -g clawcam
 *   clawcam setup <name>
 *   Open the nodeUrl on the phone browser and grant camera permissions.
 *
 * @see https://rtc.reflect.world
 */
export class PhoneSource implements Source {
  readonly name: string;
  private rtspProcess: ChildProcess | null = null;
  private streamInfo: PhoneStreamInfo | null = null;

  constructor(name: string) {
    this.name = name;
  }

  /**
   * Create a clawcam device for this phone source.
   * Returns the device info including nodeUrl for the user to open on phone.
   */
  createDevice(): DeviceInfo {
    if (!checkClawcamInstalled()) {
      throw new Error(
        "clawcam is not installed. Run: npm install -g clawcam",
      );
    }

    const output = execFileSync("clawcam", ["setup", this.name], {
      timeout: 30_000,
    });

    return JSON.parse(String(output).trim()) as DeviceInfo;
  }

  /** Remove the clawcam device config. */
  removeDevice(): boolean {
    try {
      execFileSync("clawcam", ["device", "remove", this.name], { timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  }

  /** Check if the device already exists in clawcam. */
  deviceExists(): boolean {
    return this.getDeviceInfo() !== null;
  }

  /** Return existing device setup info from clawcam, when available. */
  getDeviceInfo(): DeviceInfo | null {
    try {
      const output = execFileSync("clawcam", ["device", "list"], {
        timeout: 10_000,
      });
      const parsed = JSON.parse(String(output).trim()) as { devices?: ClawcamListedDevice[] } | ClawcamListedDevice[];
      const devices = Array.isArray(parsed) ? parsed : (parsed.devices ?? []);
      const device = devices.find((d) => d.name === this.name);
      if (!device?.nodeId || !device.securityKey) return null;
      const server = device.server ?? "https://rtc.reflect.world";
      return {
        device: device.name,
        nodeId: device.nodeId,
        securityKey: device.securityKey,
        server,
        nodeUrl: `${server.replace(/\/$/, "")}/node/${device.nodeId}#${device.securityKey}`,
      };
    } catch {
      return null;
    }
  }

  /** Capture a single frame from the phone camera. */
  snapshot(options?: SnapshotOptions): Promise<FrameResult> {
    const outputPath = join(tmpdir(), `cortex_phone_${this.name}_${Date.now()}.jpg`);
    const args = ["snapshot", "-d", this.name, "-o", outputPath];

    if (options?.quality) {
      args.push("-q", String(options.quality / 100));
    }
    if (options?.resolution?.width) {
      args.push("-W", String(options.resolution.width));
    }
    if (options?.resolution?.height) {
      args.push("-H", String(options.resolution.height));
    }

    args.push("-t", "15000"); // 15s timeout

    return new Promise((resolve, reject) => {
      execFile("clawcam", args, { timeout: 20_000 }, (err) => {
        if (err) {
          reject(new Error(`clawcam snapshot failed for ${this.name}: ${err.message}`));
          return;
        }

        if (!existsSync(outputPath)) {
          reject(new Error(`Snapshot file not found: ${outputPath}`));
          return;
        }

        const buffer = readFileSync(outputPath);
        resolve({
          data: buffer.toString("base64"),
          timestamp: Date.now(),
          source_name: this.name,
        });
      });
    });
  }

  /**
   * Start a ClawCam RTSP server (phone WebRTC → local RTSP).
   * Returns the RTSP URL for go2rtc / ffmpeg consumers.
   * Allocates unique RTSP port per device to avoid conflicts.
   */
  async startStream(options?: { width?: number; height?: number; fps?: number }): Promise<PhoneStreamInfo> {
    if (this.rtspProcess) {
      if (this.streamInfo) return this.streamInfo;
      throw new Error(`RTSP server for "${this.name}" is already starting`);
    }

    if (!checkClawcamInstalled()) {
      throw new Error("clawcam is not installed. Run: npm install -g clawcam");
    }

    const rtspPath = "/live";

    // Start from a stable per-device port for predictable URLs, but skip ports
    // left behind by stale clawcam processes or another same-name watch. Retry
    // EADDRINUSE because availability probing is not atomic across sessions.
    let lastPortError: unknown;
    for (let attempt = 0; attempt < PHONE_RTSP_PORT_SPAN; attempt++) {
      const seed = phoneRtspPortSeed(this.name);
      const rtspPort = PHONE_RTSP_PORT_BASE + ((seed - PHONE_RTSP_PORT_BASE + attempt) % PHONE_RTSP_PORT_SPAN);
      if (!(await isPortAvailable(rtspPort))) continue;
      try {
        return await this.spawnRtspServer(rtspPort, rtspPath, options);
      } catch (err) {
        if (!isAddressInUseError(err)) throw err;
        lastPortError = err;
      }
    }
    if (lastPortError) throw lastPortError;
    throw new Error(`No available phone RTSP port in ${PHONE_RTSP_PORT_BASE}-${PHONE_RTSP_PORT_BASE + PHONE_RTSP_PORT_SPAN - 1}`);
  }

  private spawnRtspServer(
    rtspPort: number,
    rtspPath: string,
    options?: { width?: number; height?: number; fps?: number },
  ): Promise<PhoneStreamInfo> {
    const args = [
      "rtsp", "-d", this.name,
      "--rtsp-port", String(rtspPort),
      "--rtsp-path", rtspPath,
    ];
    if (options?.width) args.push("-W", String(options.width));
    if (options?.height) args.push("-H", String(options.height));
    if (options?.fps) args.push("--fps", String(options.fps));

    return new Promise((resolve, reject) => {
      const proc = spawn("clawcam", args, { stdio: ["ignore", "pipe", "pipe"] });
      this.rtspProcess = proc;

      let resolved = false;
      let outputTail = "";
      const cleanup = () => {
        clearTimeout(timeout);
        if (this.rtspProcess === proc) this.rtspProcess = null;
        this.streamInfo = null;
      };
      const fail = (message: string) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        if (!proc.killed) proc.kill("SIGTERM");
        reject(new Error(message));
      };
      const appendOutput = (chunk: Buffer) => {
        outputTail = `${outputTail}${chunk.toString()}`.slice(-2000);
      };
      const timeout = setTimeout(() => {
        if (!resolved) {
          const detail = outputTail.trim();
          fail(`clawcam rtsp timed out for "${this.name}"${detail ? `: ${detail}` : ""}`);
        }
      }, 20_000);

      const rtspUrl = `rtsp://127.0.0.1:${rtspPort}${rtspPath}`;

      const onData = (chunk: Buffer) => {
        appendOutput(chunk);
        const text = chunk.toString();
        // clawcam outputs JSON like {"rtspUrl":"rtsp://...","rtspPort":...} when ready
        if (text.includes('"rtspUrl"') || text.includes("RTSP server listening")) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            this.streamInfo = { rtspUrl, rtspPort, rtspPath };
            resolve(this.streamInfo);
          }
        }
      };

      proc.stdout?.on("data", onData);
      proc.stderr?.on("data", onData);

      proc.on("error", (err) => {
        const detail = outputTail.trim();
        fail(`clawcam rtsp failed for "${this.name}": ${err.message}${detail ? `: ${detail}` : ""}`);
      });

      proc.on("exit", () => {
        this.rtspProcess = null;
        this.streamInfo = null;
        if (!resolved) {
          const detail = outputTail.trim();
          fail(`clawcam rtsp exited unexpectedly for "${this.name}"${detail ? `: ${detail}` : ""}`);
        }
      });
    });
  }

  /** Stop the ClawCam RTSP server. */
  stopStream(): void {
    if (this.rtspProcess) {
      this.rtspProcess.kill("SIGTERM");
      this.rtspProcess = null;
      this.streamInfo = null;
    }
  }

  /** Check if the RTSP server is currently active. */
  get isStreaming(): boolean {
    return this.rtspProcess !== null && !this.rtspProcess.killed;
  }

  /** Get the current stream info (RTSP URL, port, path). */
  getStreamInfo(): PhoneStreamInfo | null {
    return this.streamInfo;
  }
}
