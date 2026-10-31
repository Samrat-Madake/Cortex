import { spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:os";

export interface LocalDeviceOptions {
  /** ffmpeg binary path. */
  ffmpegBin: string;
  /** go2rtc RTSP base URL, e.g. "rtsp://127.0.0.1:8554". */
  rtspBase: string;
  /** Capture width (default 1280). */
  width?: number;
  /** Capture height (default 720). */
  height?: number;
  /** Capture framerate (default 30). */
  fps?: number;
}

/**
 * Manages a self-spawned ffmpeg process that captures from a local device
 * (webcam / USB camera) and pushes RTSP to go2rtc.
 *
 * This avoids go2rtc's `exec:` source type, so adding/removing local devices
 * never requires a go2rtc restart.
 */
export class LocalDeviceSource {
  private process: ChildProcess | null = null;
  readonly name: string;
  private readonly opts: LocalDeviceOptions;

  constructor(name: string, opts: LocalDeviceOptions) {
    this.name = name;
    this.opts = opts;
  }

  get isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  /** Start ffmpeg capture → push RTSP to go2rtc. */
  async start(deviceInput: string): Promise<void> {
    if (this.isRunning) return;

    const width = this.opts.width ?? 1280;
    const height = this.opts.height ?? 720;
    const fps = this.opts.fps ?? 30;
    const rtspUrl = `${this.opts.rtspBase}/${this.name}`;

    const args = buildFfmpegArgs(deviceInput, width, height, fps, rtspUrl);

    this.process = spawn(this.opts.ffmpegBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Drain stdout/stderr to prevent buffer buildup
    this.process.stdout?.on("data", () => {});
    this.process.stderr?.on("data", () => {});

    this.process.on("exit", () => {
      this.process = null;
    });

    // Wait briefly for ffmpeg to start publishing
    await new Promise((r) => setTimeout(r, 1500));
  }

  /** Stop the ffmpeg capture process. */
  stop(): void {
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
    }
  }
}

/**
 * Build ffmpeg args for capturing from a local device and pushing RTSP.
 * Detects platform (macOS avfoundation / Linux v4l2) automatically.
 */
function buildFfmpegArgs(
  deviceInput: string,
  width: number,
  height: number,
  fps: number,
  rtspUrl: string,
): string[] {
  const os = platform();

  let inputFormat: string;
  let inputDevice: string;

  if (deviceInput.startsWith("avfoundation://")) {
    inputFormat = "avfoundation";
    inputDevice = `${deviceInput.replace("avfoundation://", "") || "0"}:none`;
  } else if (deviceInput.startsWith("v4l2://")) {
    inputFormat = "v4l2";
    inputDevice = deviceInput.replace("v4l2://", "") || "/dev/video0";
  } else if (deviceInput === "webcam" || deviceInput === "usb") {
    if (os === "darwin") {
      inputFormat = "avfoundation";
      inputDevice = "0:none";
    } else {
      inputFormat = "v4l2";
      inputDevice = "/dev/video0";
    }
  } else if (deviceInput.startsWith("usb:")) {
    const idx = deviceInput.split(":")[1] ?? "0";
    if (os === "darwin") {
      inputFormat = "avfoundation";
      inputDevice = `${idx}:none`;
    } else {
      inputFormat = "v4l2";
      inputDevice = `/dev/video${idx}`;
    }
  } else {
    // Fallback
    inputFormat = os === "darwin" ? "avfoundation" : "v4l2";
    inputDevice = deviceInput;
  }

  return [
    "-f", inputFormat,
    "-framerate", String(fps),
    "-video_size", `${width}x${height}`,
    "-i", inputDevice,
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-tune", "zerolatency",
    "-g", String(fps),
    "-f", "rtsp",
    "-rtsp_transport", "tcp",
    rtspUrl,
  ];
}
