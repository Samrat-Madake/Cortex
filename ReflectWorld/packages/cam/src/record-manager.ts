import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { toRtspSafeName } from "./go2rtc-manager.js";
import { writeStderr } from "@reflectworld/shared";

/** Default per-camera recording quota: 2 GB. */
const DEFAULT_QUOTA_MB = 2048;
/** How often to check quota (ms). */
const QUOTA_CHECK_INTERVAL_MS = 60_000;

export interface RecordManagerOptions {
  ffmpegBin: string;
  rtspBase: string;
  outputDir: string;
  /** Per-camera recording quota in MB. Default 2048 (2GB). Set 0 to disable. */
  quotaPerCameraMB?: number;
  /** Media directory for keyframe cleanup (e.g. ~/.openclaw/media). */
  mediaDir?: string;
  /** Per-camera keyframe quota in MB. Default 200. Set 0 to disable. */
  keyframeQuotaMB?: number;
}

export interface RecordOptions {
  segmentSec?: number;
  /** Max recording duration in seconds. ffmpeg will stop automatically after this. */
  duration?: number;
  /** Override input URL (e.g. ClawCam RTSP URL that requires UDP transport). */
  inputOverride?: string;
  /** Called when the recording input reaches EOF naturally. */
  onEnd?: () => void;
}

export interface RecordingFile {
  name: string;
  path: string;
}

interface RecordingEntry {
  process: ChildProcess;
  stoppedByUser: boolean;
  onEnd?: () => void;
}

function isLocalMediaFile(input: string): boolean {
  return /\.(mp4|avi|mkv|mov|webm|flv|ts|m3u8|mpg|mpeg)$/i.test(input)
    && (input.startsWith("/") || input.startsWith("./") || !!input.match(/^[A-Z]:\\/));
}

export class RecordManager {
  private processes = new Map<string, RecordingEntry>();
  private readonly ffmpegBin: string;
  private readonly rtspBase: string;
  private readonly outputDir: string;
  private readonly quotaBytes: number;
  private readonly mediaDir: string | undefined;
  private readonly keyframeQuotaBytes: number;
  private quotaTimer: ReturnType<typeof setInterval> | null = null;
  private activeStreams = new Set<string>();

  constructor(options: RecordManagerOptions) {
    this.ffmpegBin = options.ffmpegBin;
    this.rtspBase = options.rtspBase;
    this.outputDir = options.outputDir;
    this.quotaBytes = (options.quotaPerCameraMB ?? DEFAULT_QUOTA_MB) * 1024 * 1024;
    this.mediaDir = options.mediaDir;
    this.keyframeQuotaBytes = (options.keyframeQuotaMB ?? 200) * 1024 * 1024;
  }

  /** Start continuous segmented recording (stream mode). All sources via go2rtc RTSP, zero-transcode copy. */
  startRecording(streamName: string, options?: RecordOptions): void {
    if (this.processes.has(streamName)) throw new Error(`"${streamName}" is already recording`);
    const segmentSec = options?.segmentSec ?? 30;
    const streamDir = join(this.outputDir, streamName);
    if (!existsSync(streamDir)) mkdirSync(streamDir, { recursive: true });

    const inputUrl = options?.inputOverride ?? `${this.rtspBase}/${toRtspSafeName(streamName)}`;
    const transportArgs = options?.inputOverride ? [] : ["-rtsp_transport", "tcp"];
    const localFileArgs = options?.inputOverride && isLocalMediaFile(options.inputOverride) ? ["-re"] : [];
    const durationArgs = options?.duration ? ["-t", String(options.duration)] : [];

    const args = [
      ...localFileArgs,
      ...transportArgs,
      "-i", inputUrl,
      ...durationArgs,
      "-c", "copy",
      "-an",
      "-f", "segment",
      "-segment_time", String(segmentSec),
      "-segment_format", "mp4",
      "-reset_timestamps", "1",
      "-strftime", "1",
      join(streamDir, `${streamName}_%Y%m%d_%H%M%S.mp4`),
    ];

    const proc = spawn(this.ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    proc.stderr?.on("data", () => {});
    proc.stdout?.on("data", () => {});
    const entry: RecordingEntry = {
      process: proc,
      stoppedByUser: false,
      onEnd: options?.onEnd,
    };
    proc.on("exit", () => {
      const current = this.processes.get(streamName);
      this.processes.delete(streamName);
      this.activeStreams.delete(streamName);
      if (this.activeStreams.size === 0 && this.quotaTimer) {
        clearInterval(this.quotaTimer);
        this.quotaTimer = null;
      }
      if (current && !current.stoppedByUser) {
        current.onEnd?.();
      }
    });
    this.processes.set(streamName, entry);
    this.activeStreams.add(streamName);
    this.startQuotaTimer();
  }

  /** Start single-file event recording. Stops after maxDurationSec or when stopRecording() is called.
   *  Returns the output file path so callers can bind it to the segment's raw_url. */
  startEventRecording(streamName: string, options?: { maxDurationSec?: number; inputOverride?: string }): string {
    if (this.processes.has(streamName)) return "";
    const maxDur = options?.maxDurationSec ?? 30;
    const streamDir = join(this.outputDir, streamName);
    if (!existsSync(streamDir)) mkdirSync(streamDir, { recursive: true });

    const inputUrl = options?.inputOverride ?? `${this.rtspBase}/${toRtspSafeName(streamName)}`;
    const transportArgs = options?.inputOverride ? [] : ["-rtsp_transport", "tcp"];
    const localFileArgs = options?.inputOverride && isLocalMediaFile(options.inputOverride) ? ["-re"] : [];
    const now = new Date();
    const ts = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
      "_",
      String(now.getHours()).padStart(2, "0"),
      String(now.getMinutes()).padStart(2, "0"),
      String(now.getSeconds()).padStart(2, "0"),
    ].join("");
    const outputPath = join(streamDir, `${streamName}_event_${ts}.mp4`);

    const args = [
      ...localFileArgs,
      ...transportArgs,
      "-i", inputUrl,
      "-t", String(maxDur),
      "-c", "copy",
      "-an",
      outputPath,
    ];

    const proc = spawn(this.ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    proc.stderr?.on("data", () => {});
    proc.stdout?.on("data", () => {});
    const entry: RecordingEntry = { process: proc, stoppedByUser: false };
    proc.on("exit", () => {
      this.processes.delete(streamName);
    });
    this.processes.set(streamName, entry);
    return outputPath;
  }

  stopRecording(streamName: string): boolean {
    const entry = this.processes.get(streamName);
    if (!entry) return false;
    entry.stoppedByUser = true;
    entry.process.kill("SIGINT");
    this.processes.delete(streamName);
    this.activeStreams.delete(streamName);
    // Final quota enforcement after stopping
    this.enforceQuota(streamName);
    if (this.activeStreams.size === 0 && this.quotaTimer) {
      clearInterval(this.quotaTimer);
      this.quotaTimer = null;
    }
    return true;
  }

  isRecording(streamName: string): boolean {
    return this.processes.has(streamName);
  }

  listRecordings(streamName: string): RecordingFile[] {
    const streamDir = join(this.outputDir, streamName);
    if (!existsSync(streamDir)) return [];
    return readdirSync(streamDir).filter(f => f.endsWith(".mp4") || f.endsWith(".jpg")).sort().map(name => ({ name, path: join(streamDir, name) }));
  }

  stopAll(): void {
    for (const name of [...this.processes.keys()]) this.stopRecording(name);
    if (this.quotaTimer) {
      clearInterval(this.quotaTimer);
      this.quotaTimer = null;
    }
  }

  // ── FIFO recording quota management ──

  private startQuotaTimer(): void {
    if (this.quotaTimer || this.quotaBytes <= 0) return;
    this.quotaTimer = setInterval(() => {
      for (const streamName of this.activeStreams) {
        this.enforceQuota(streamName);
      }
    }, QUOTA_CHECK_INTERVAL_MS);
  }

  /**
   * FIFO: delete oldest recordings for a camera until total size is under quota.
   * Returns number of files deleted.
   */
  enforceQuota(streamName: string): number {
    if (this.quotaBytes <= 0) return 0;
    const streamDir = join(this.outputDir, streamName);
    if (!existsSync(streamDir)) return 0;

    // List all recording files with stats, sorted oldest first
    const files = readdirSync(streamDir)
      .filter(f => f.endsWith(".mp4"))
      .map(name => {
        const path = join(streamDir, name);
        try {
          const st = statSync(path);
          return { name, path, size: st.size, mtime: st.mtimeMs };
        } catch { return null; }
      })
      .filter((f): f is NonNullable<typeof f> => f !== null)
      .sort((a, b) => a.mtime - b.mtime);

    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    if (totalSize <= this.quotaBytes) return 0;

    let currentSize = totalSize;
    let deleted = 0;
    for (const file of files) {
      if (currentSize <= this.quotaBytes) break;
      try {
        unlinkSync(file.path);
        currentSize -= file.size;
        deleted++;
      } catch { /* best-effort */ }
    }

    if (deleted > 0) {
      const freedMB = ((totalSize - currentSize) / 1024 / 1024).toFixed(0);
      writeStderr(`[cam:quota] ${streamName}: deleted ${deleted} oldest recordings, freed ${freedMB}MB`);
    }

    // Also enforce keyframe quota
    this.enforceKeyframeQuota(streamName);

    return deleted;
  }

  /** FIFO cleanup for keyframe images. */
  private enforceKeyframeQuota(streamName: string): void {
    if (!this.mediaDir || this.keyframeQuotaBytes <= 0) return;
    const kfDir = join(this.mediaDir, streamName, "keyframe");
    if (!existsSync(kfDir)) return;

    const files = readdirSync(kfDir)
      .filter(f => f.endsWith(".jpg"))
      .map(name => {
        const path = join(kfDir, name);
        try {
          const st = statSync(path);
          return { name, path, size: st.size, mtime: st.mtimeMs };
        } catch { return null; }
      })
      .filter((f): f is NonNullable<typeof f> => f !== null)
      .sort((a, b) => a.mtime - b.mtime);

    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    if (totalSize <= this.keyframeQuotaBytes) return;

    let currentSize = totalSize;
    let deleted = 0;
    for (const file of files) {
      if (currentSize <= this.keyframeQuotaBytes) break;
      try {
        unlinkSync(file.path);
        currentSize -= file.size;
        deleted++;
      } catch { /* best-effort */ }
    }

    if (deleted > 0) {
      const freedMB = ((totalSize - currentSize) / 1024 / 1024).toFixed(0);
      writeStderr(`[cam:quota] ${streamName}: deleted ${deleted} oldest keyframes, freed ${freedMB}MB`);
    }
  }
}
