import { spawn, type ChildProcess } from "node:child_process";
import { monitorBus } from "@cortex/shared";
import type { FrameResult } from "./types.js";
import { toRtspSafeName } from "./go2rtc-manager.js";
import { writeStderr } from "@cortex/shared";

export interface FrameExtractorOptions {
  ffmpegBin: string;
  rtspBase: string;
  healthCheck?: HealthCheckConfig;
}

export interface ExtractionOptions {
  fps: number;
  width: number;
  height: number;
  quality?: number;
  onFrame: (frame: FrameResult) => void | Promise<void>;
  inputOverride?: string;
  timestampMode?: "wall_clock" | "pts";
  loopLocalFile?: boolean;
  localFilePacing?: "realtime" | "fast";
  onEnd?: () => void;
  /** Local-file only: await onFrame and pause stdout while downstream is busy. */
  frameBackpressure?: boolean;
  /** Local-file only: informs paired consumers, e.g. audio, that video stdout is paused. */
  onBackpressureChange?: (paused: boolean) => void;
  /** Output all frames at source rate (no select/fps filter).
   *  fps is still tracked for downstream Percept decimation. */
  fullRate?: boolean;
}

export interface HealthCheckConfig {
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxRetries?: number;
}

const DEFAULT_HEALTH: Required<HealthCheckConfig> = {
  initialDelayMs: 5_000,
  maxDelayMs: 60_000,
  maxRetries: 5,
};

const LOCAL_MEDIA_FILE_RE = /\.(mp4|avi|mkv|mov|webm|flv|ts|m3u8|mpg|mpeg)$/i;
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const HOT_SWAP_TIMEOUT_MS = 3_000;
const DEFAULT_JPEG_QUALITY = 5;

interface ExtractionEntry {
  process: ChildProcess | null;
  options: ExtractionOptions;
  stoppedByUser: boolean;
  retryCount: number;
  retryTimer?: ReturnType<typeof setTimeout>;
  handoffTimer?: ReturnType<typeof setTimeout>;
  frameIndex: number;
  baseMediaTs: number;
  latestReceivedTs?: number;
  inputUrl: string;
  isLocalFile: boolean;
  shouldLoopLocalFile: boolean;
  /** Real PTS values (ms) parsed from ffmpeg showinfo stderr. */
  ptsQueue?: number[];
  /** Last real PTS received — used to estimate frame interval for fallback. */
  lastRealPts?: number;
  /** Estimated frame interval (ms) from real PTS deltas. */
  estimatedIntervalMs?: number;
  /** Local-file backpressure queue used when onFrame returns a Promise. */
  pendingFrames?: Buffer[];
  processingFrames?: boolean;
  stdoutPaused?: boolean;
}

interface ExtractionSlot {
  active: ExtractionEntry | null;
  pending: ExtractionEntry | null;
  lastEmittedTs: number;
  onFrame: (frame: FrameResult) => void | Promise<void>;
  options: ExtractionOptions;
}

function isLocalMediaFile(input: string): boolean {
  return LOCAL_MEDIA_FILE_RE.test(input);
}

function consumeJpegFrames(buffer: Buffer): { frames: Buffer[]; remaining: Buffer } {
  const frames: Buffer[] = [];
  let searchOffset = 0;
  let consumedUntil = 0;

  while (searchOffset < buffer.length) {
    const start = buffer.indexOf(SOI, searchOffset);
    if (start === -1) break;
    const end = buffer.indexOf(EOI, start + SOI.length);
    if (end === -1) {
      consumedUntil = start;
      return { frames, remaining: buffer.subarray(consumedUntil) };
    }
    consumedUntil = end + EOI.length;
    frames.push(buffer.subarray(start, consumedUntil));
    searchOffset = consumedUntil;
  }

  return {
    frames,
    remaining: consumedUntil > 0 ? buffer.subarray(consumedUntil) : Buffer.alloc(0),
  };
}

export function splitJpegFrames(buffer: Buffer): Buffer[] {
  return consumeJpegFrames(buffer).frames;
}

export function splitJpegFramesWithRemainder(buffer: Buffer): { frames: Buffer[]; remaining: Buffer } {
  const { frames, remaining } = consumeJpegFrames(buffer);
  return {
    frames: frames.map((frame) => Buffer.from(frame)),
    remaining: Buffer.from(remaining),
  };
}

function effectiveTimestampMode(options: ExtractionOptions): "wall_clock" | "pts" {
  return options.timestampMode ?? "wall_clock";
}

function effectiveLoopLocalFile(options: ExtractionOptions): boolean {
  return options.loopLocalFile !== false;
}

function effectiveQuality(options: ExtractionOptions): number {
  return options.quality ?? DEFAULT_JPEG_QUALITY;
}

function sameEffectiveOptions(current: ExtractionOptions, next: ExtractionOptions): boolean {
  return current.fps === next.fps
    && current.width === next.width
    && current.height === next.height
    && current.inputOverride === next.inputOverride
    && effectiveTimestampMode(current) === effectiveTimestampMode(next)
    && effectiveLoopLocalFile(current) === effectiveLoopLocalFile(next)
    && (current.localFilePacing ?? "realtime") === (next.localFilePacing ?? "realtime")
    && effectiveQuality(current) === effectiveQuality(next)
    && (current.fullRate ?? false) === (next.fullRate ?? false);
}

function isHotSwapEligible(current: ExtractionOptions, next: ExtractionOptions): boolean {
  // In fullRate mode, fps changes don't affect ffmpeg — no hot-swap needed.
  if (current.fullRate) return false;
  return current.fps !== next.fps && sameEffectiveOptions({ ...current, fps: next.fps }, next);
}

export class FrameExtractor {
  private slots = new Map<string, ExtractionSlot>();
  private shutdownRequested = false;
  private readonly ffmpegBin: string;
  private readonly rtspBase: string;
  private readonly healthCfg: Required<HealthCheckConfig>;

  constructor(options: FrameExtractorOptions) {
    this.ffmpegBin = options.ffmpegBin;
    this.rtspBase = options.rtspBase;
    this.healthCfg = { ...DEFAULT_HEALTH, ...options.healthCheck };
  }

  startExtraction(streamName: string, options: ExtractionOptions): void {
    this.shutdownRequested = false;
    if (this.slots.has(streamName)) throw new Error(`"${streamName}" is already extracting`);

    this.slots.set(streamName, {
      active: null,
      pending: null,
      lastEmittedTs: -1,
      onFrame: options.onFrame,
      options,
    });
    this.spawnActive(streamName, options, 0, 0);
  }

  updateExtraction(streamName: string, options: ExtractionOptions): void {
    const slot = this.slots.get(streamName);
    if (!slot?.active) {
      this.stopExtraction(streamName);
      this.shutdownRequested = false;
      this.startExtraction(streamName, options);
      return;
    }

    const current = slot.options;
    if (sameEffectiveOptions(current, options)) {
      slot.options = options;
      slot.onFrame = options.onFrame;
      if (slot.pending) {
        slot.pending.options = options;
      } else if (slot.active) {
        slot.active.options = options;
      }
      return;
    }

    // fullRate mode: fps only controls downstream Percept decimation, not ffmpeg.
    // If only fps changed, update inline without restarting ffmpeg.
    if (current.fullRate && sameEffectiveOptions({ ...current, fps: options.fps }, options)) {
      slot.options = options;
      slot.onFrame = options.onFrame;
      if (slot.active) slot.active.options = options;
      return;
    }

    if (isHotSwapEligible(current, options)) {
      this.hotSwap(streamName, options);
      return;
    }

    this.stopExtraction(streamName);
    this.shutdownRequested = false;
    this.startExtraction(streamName, options);
  }

  stopExtraction(streamName: string): boolean {
    const slot = this.slots.get(streamName);
    if (!slot) return false;

    if (slot.active) this.stopEntry(slot.active);
    if (slot.pending) this.stopEntry(slot.pending);
    this.slots.delete(streamName);
    return true;
  }

  stopAll(): void {
    this.shutdownRequested = true;
    for (const name of [...this.slots.keys()]) this.stopExtraction(name);
  }

  isExtracting(streamName: string): boolean {
    return this.slots.has(streamName);
  }

  getExtractionOptions(streamName: string): ExtractionOptions | null {
    return this.slots.get(streamName)?.options ?? null;
  }

  /** Update only the fps value without restarting ffmpeg (fullRate mode). */
  updateExtractionFpsOnly(streamName: string, fps: number): void {
    const slot = this.slots.get(streamName);
    if (slot) {
      slot.options = { ...slot.options, fps };
      if (slot.active) slot.active.options = { ...slot.active.options, fps };
      if (slot.pending) slot.pending.options = { ...slot.pending.options, fps };
    }
  }

  private hotSwap(streamName: string, options: ExtractionOptions): void {
    const slot = this.slots.get(streamName);
    if (!slot) return;

    if (slot.pending) {
      this.stopEntry(slot.pending);
      slot.pending = null;
    }

    // Clear stale retryTimer on active (e.g. reconnect placeholder with process=null)
    if (slot.active?.retryTimer) {
      clearTimeout(slot.active.retryTimer);
      slot.active.retryTimer = undefined;
    }

    slot.options = options;
    slot.onFrame = options.onFrame;

    const newIntervalMs = Math.round(1000 / Math.max(1, options.fps));
    const baseMediaTs = slot.lastEmittedTs + newIntervalMs;
    this.spawnPending(streamName, options, baseMediaTs);
  }

  private spawnActive(
    streamName: string,
    options: ExtractionOptions,
    retryCount: number,
    baseMediaTs: number,
  ): void {
    const slot = this.slots.get(streamName);
    if (!slot) return;

    const entry = this.createEntry(streamName, options, retryCount, baseMediaTs);
    slot.active = entry;
    slot.options = options;
    slot.onFrame = options.onFrame;
    this.spawnEntry(streamName, entry, "active");
  }

  private spawnPending(streamName: string, options: ExtractionOptions, baseMediaTs: number): void {
    const slot = this.slots.get(streamName);
    if (!slot) return;

    const entry = this.createEntry(streamName, options, 0, baseMediaTs);
    slot.pending = entry;

    entry.handoffTimer = setTimeout(() => {
      const liveSlot = this.slots.get(streamName);
      if (!liveSlot || liveSlot.pending !== entry) return;
      if (entry.latestReceivedTs != null) {
        liveSlot.lastEmittedTs = entry.latestReceivedTs - 1;
      }
      this.promotePending(streamName);
      monitorBus.publish("cam:hot_swap_timeout", {
        camera_id: streamName,
        waited_ms: HOT_SWAP_TIMEOUT_MS,
      }, streamName);
    }, HOT_SWAP_TIMEOUT_MS);

    const seekSec = entry.isLocalFile && slot.lastEmittedTs > 0
      ? slot.lastEmittedTs / 1000
      : 0;
    this.spawnEntry(streamName, entry, "pending", seekSec);
  }

  private spawnEntry(
    streamName: string,
    entry: ExtractionEntry,
    role: "active" | "pending",
    seekSec = 0,
  ): void {
    const args = this.buildArgs(entry, seekSec);
    const proc = spawn(this.ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    entry.process = proc;

    // Parse showinfo output from stderr to extract real video PTS.
    // Each showinfo line looks like:
    //   [Parsed_showinfo_1 @ 0x...] n:   0 pts:      0 pts_time:0        ...
    // We extract pts_time and push to entry.ptsQueue, consumed 1:1 by emitFrame.
    let stderrBuf = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      if (!entry.ptsQueue) return;
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split("\n");
      stderrBuf = lines.pop() ?? "";
      for (const line of lines) {
        const m = line.match(/pts_time:\s*([\d.]+)/);
        if (m) {
          const ptsMs = parseFloat(m[1]!) * 1000;
          entry.ptsQueue.push(ptsMs);
          // Estimate frame interval from consecutive real PTS values
          if (entry.lastRealPts !== undefined) {
            const delta = ptsMs - entry.lastRealPts;
            if (delta > 0 && delta < 200) {  // sanity: 5-200fps range
              entry.estimatedIntervalMs = delta;
            }
          }
          entry.lastRealPts = ptsMs;
        }
      }
    });

    let accumulated = Buffer.alloc(0) as Buffer;

    proc.stdout?.on("data", (chunk: Buffer) => {
      if (entry.stoppedByUser) return;
      entry.retryCount = 0;
      accumulated = Buffer.concat([accumulated, chunk]);
      const { frames, remaining } = consumeJpegFrames(accumulated);
      accumulated = remaining as Buffer;
      if (entry.options.frameBackpressure && entry.isLocalFile) {
        this.enqueueBackpressureFrames(streamName, entry, frames);
        return;
      }
      for (const frame of frames) {
        this.emitFrame(streamName, entry, frame);
      }
    });

    proc.on("exit", (code) => {
      const slot = this.slots.get(streamName);

      if (entry.stoppedByUser || this.shutdownRequested) {
        this.handleStoppedExit(streamName, entry, slot);
        return;
      }

      if (accumulated.length > 0) {
        const { frames } = consumeJpegFrames(accumulated);
        if (entry.options.frameBackpressure && entry.isLocalFile) {
          this.enqueueBackpressureFrames(streamName, entry, frames);
        } else {
          for (const frame of frames) {
            this.emitFrame(streamName, entry, frame);
          }
        }
      }

      if (!slot) return;

      if (slot.pending === entry) {
        this.clearEntryTimers(entry);
        slot.pending = null;
        if (slot.active) {
          slot.options = slot.active.options;
          slot.onFrame = slot.active.options.onFrame;
        } else {
          this.slots.delete(streamName);
        }
        writeStderr(`[cam:health] Hot swap pending process crashed for "${streamName}"`);
        return;
      }

      if (slot.active !== entry) {
        return;
      }

      if (slot.pending) {
        this.promotePending(streamName, false);
        return;
      }

      if (entry.isLocalFile && !entry.shouldLoopLocalFile) {
        this.slots.delete(streamName);
        entry.options.onEnd?.();
        return;
      }

      writeStderr(
        `[cam:health] ffmpeg exited unexpectedly for "${streamName}" (code=${code}), attempt ${entry.retryCount + 1}/${this.healthCfg.maxRetries}`,
      );
      this.scheduleReconnect(streamName, entry.options, entry.retryCount);
    });
  }

  private buildArgs(entry: ExtractionEntry, seekSec: number): string[] {
    const usePtsTimestamps = entry.options.timestampMode === "pts";
    const transportArgs = entry.options.inputOverride
      ? []
      : (entry.isLocalFile ? [] : ["-rtsp_transport", "tcp"]);
    // No -copyts needed: select filter (unlike fps filter) preserves
    // input PTS naturally — showinfo reports the real source frame time.
    const copyTsArgs: string[] = [];
    const realtimeArgs = (entry.options.localFilePacing ?? "realtime") === "realtime" ? ["-re"] : [];
    const fileArgs = entry.isLocalFile
      ? (entry.shouldLoopLocalFile ? ["-stream_loop", "-1", ...realtimeArgs] : realtimeArgs)
      : [];
    const seekArgs = entry.isLocalFile && seekSec > 0 ? ["-ss", seekSec.toFixed(3)] : [];
    const inputArgs = [...copyTsArgs, ...fileArgs, ...transportArgs, ...seekArgs, "-i", entry.inputUrl];
    const videoFilters: string[] = [];
    if (usePtsTimestamps && !entry.options.fullRate) {
      // Use `select` instead of `fps` filter for frame decimation.
      // fps filter has its own frame-selection algorithm that picks different
      // frames than sequential reads at the same PTS. select +
      // gte(t-prev_selected_t, interval) picks stable source frames and preserves
      // the input PTS (fps filter re-numbers PTS to 0,1,2,...).
      // Skipped in fullRate mode — all frames are output for downstream decimation.
      const interval = (1.0 / Math.max(1, entry.options.fps)).toFixed(6);
      videoFilters.push(`select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,${interval})'`);
    }
    if (usePtsTimestamps && entry.isLocalFile) {
      videoFilters.push("showinfo");
    }
    if (entry.options.height > 0) {
      // Downscale only: short edge capped at target height, preserve aspect ratio.
      // 4K (3840x2160) → 1280x720, 1080p → 1280x720, 640x480 → 640x480 (no upscale).
      const h = entry.options.height;
      videoFilters.push(
        `scale=-2:'min(${h},ih)'`,
      );
    }
    const filterArgs = videoFilters.length > 0 ? ["-vf", videoFilters.join(",")] : [];

    return [
      ...inputArgs,
      ...(usePtsTimestamps || entry.options.fullRate ? [] : ["-r", String(entry.options.fps)]),
      // -fps_mode drop: prevent ffmpeg from duplicating frames when using
      // select filter (which doesn't set a fixed output fps).
      ...(usePtsTimestamps ? ["-fps_mode", "drop"] : []),
      ...filterArgs,
      "-q:v", String(effectiveQuality(entry.options)),
      "-f", "image2pipe",
      "-vcodec", "mjpeg",
      "pipe:1",
    ];
  }

  private createEntry(
    streamName: string,
    options: ExtractionOptions,
    retryCount: number,
    baseMediaTs: number,
  ): ExtractionEntry {
    const inputUrl = options.inputOverride ?? `${this.rtspBase}/${toRtspSafeName(streamName)}`;
    const isLocalFile = isLocalMediaFile(inputUrl);
    return {
      process: null,
      options,
      stoppedByUser: false,
      retryCount,
      frameIndex: 0,
      baseMediaTs,
      inputUrl,
      isLocalFile,
      shouldLoopLocalFile: options.loopLocalFile !== false,
      // Queue of real PTS values parsed from ffmpeg showinfo stderr.
      // Each pts_time corresponds 1:1 with a JPEG frame from stdout.
      ptsQueue: [] as number[],
    };
  }

  private enqueueBackpressureFrames(streamName: string, entry: ExtractionEntry, frames: Buffer[]): void {
    if (frames.length === 0 || entry.stoppedByUser) return;
    entry.pendingFrames ??= [];
    entry.pendingFrames.push(...frames);
    this.pauseEntryStdout(entry);
    if (!entry.processingFrames) {
      void this.drainBackpressureFrames(streamName, entry);
    }
  }

  private async drainBackpressureFrames(streamName: string, entry: ExtractionEntry): Promise<void> {
    entry.processingFrames = true;
    try {
      while (!entry.stoppedByUser && entry.pendingFrames && entry.pendingFrames.length > 0) {
        const frame = entry.pendingFrames.shift()!;
        try {
          await Promise.resolve(this.emitFrame(streamName, entry, frame));
        } catch (err) {
          writeStderr(`[cam:frame] onFrame failed for "${streamName}": ${err instanceof Error ? err.message : err}`);
        }
      }
    } finally {
      entry.processingFrames = false;
      if (!entry.stoppedByUser && entry.pendingFrames?.length) {
        void this.drainBackpressureFrames(streamName, entry);
        return;
      }
      this.resumeEntryStdout(entry);
    }
  }

  private pauseEntryStdout(entry: ExtractionEntry): void {
    if (entry.stdoutPaused) return;
    entry.process?.stdout?.pause();
    entry.stdoutPaused = true;
    entry.options.onBackpressureChange?.(true);
  }

  private resumeEntryStdout(entry: ExtractionEntry): void {
    if (!entry.stdoutPaused) return;
    entry.process?.stdout?.resume();
    entry.stdoutPaused = false;
    entry.options.onBackpressureChange?.(false);
  }

  private emitFrame(streamName: string, entry: ExtractionEntry, frame: Buffer): void | Promise<void> {
    if (entry.stoppedByUser) return;
    const slot = this.slots.get(streamName);
    if (!slot) return;
    if (slot.active !== entry && slot.pending !== entry) return;

    let ts = this.nextFrameTimestamp(entry);
    if (slot.pending === entry && entry.options.timestampMode === "pts") {
      const intervalMs = Math.round(1000 / Math.max(1, entry.options.fps));
      const minPendingTs = slot.lastEmittedTs + intervalMs;
      if (ts < minPendingTs) {
        ts = minPendingTs;
        entry.baseMediaTs = ts - (entry.frameIndex - 1) * intervalMs;
      }
    }
    entry.latestReceivedTs = ts;
    if (ts <= slot.lastEmittedTs) return;

    if (slot.pending === entry) {
      this.promotePending(streamName);
    }

    const liveSlot = this.slots.get(streamName);
    if (!liveSlot) return;
    if (ts <= liveSlot.lastEmittedTs) return;
    liveSlot.lastEmittedTs = ts;

    return liveSlot.onFrame({
      data: frame.toString("base64"),
      timestamp: ts,
      source_name: streamName,
    });
  }

  private promotePending(streamName: string, killOldActive = true): void {
    const slot = this.slots.get(streamName);
    if (!slot?.pending) return;

    const pending = slot.pending;
    const oldActive = slot.active;
    this.clearEntryTimers(pending);

    slot.active = pending;
    slot.pending = null;
    slot.options = pending.options;
    slot.onFrame = pending.options.onFrame;

    if (killOldActive && oldActive) {
      this.stopEntry(oldActive);
    }
  }

  private scheduleReconnect(streamName: string, options: ExtractionOptions, currentRetry: number): void {
    const slot = this.slots.get(streamName);
    if (!slot || this.shutdownRequested) {
      this.slots.delete(streamName);
      return;
    }

    const nextRetry = currentRetry + 1;
    if (nextRetry > this.healthCfg.maxRetries) {
      writeStderr(`[cam:health] Max retries (${this.healthCfg.maxRetries}) exhausted for "${streamName}". Marking source unavailable.`);
      this.slots.delete(streamName);
      monitorBus.publish("cam:source_unavailable", {
        camera_id: streamName,
        reason: "ffmpeg process exited and reconnect retries exhausted",
        retries: this.healthCfg.maxRetries,
      }, streamName);
      return;
    }

    const delay = Math.min(
      this.healthCfg.initialDelayMs * Math.pow(2, nextRetry - 1),
      this.healthCfg.maxDelayMs,
    );

    writeStderr(`[cam:health] Reconnecting "${streamName}" in ${delay}ms (attempt ${nextRetry}/${this.healthCfg.maxRetries})`);
    monitorBus.publish("cam:source_reconnecting", {
      camera_id: streamName,
      attempt: nextRetry,
      max_retries: this.healthCfg.maxRetries,
      delay_ms: delay,
    }, streamName);

    const entry = this.createEntry(
      streamName,
      options,
      nextRetry,
      slot.lastEmittedTs + Math.round(1000 / Math.max(1, options.fps)),
    );
    entry.retryTimer = setTimeout(() => {
      const liveSlot = this.slots.get(streamName);
      if (!liveSlot || this.shutdownRequested) return;
      if (liveSlot.active !== entry) return;
      this.spawnActive(streamName, options, nextRetry, entry.baseMediaTs);
    }, delay);

    slot.active = entry;
    slot.options = options;
    slot.onFrame = options.onFrame;
  }

  private handleStoppedExit(
    streamName: string,
    entry: ExtractionEntry,
    slot: ExtractionSlot | undefined,
  ): void {
    this.clearEntryTimers(entry);
    if (!slot) return;
    if (slot.active === entry) slot.active = null;
    if (slot.pending === entry) slot.pending = null;
    if (!slot.active && !slot.pending) {
      this.slots.delete(streamName);
    }
  }

  private stopEntry(entry: ExtractionEntry): void {
    entry.stoppedByUser = true;
    this.resumeEntryStdout(entry);
    this.clearEntryTimers(entry);
    if (entry.process && typeof entry.process.kill === "function") {
      entry.process.kill("SIGTERM");
    }
  }

  private clearEntryTimers(entry: ExtractionEntry): void {
    if (entry.retryTimer) {
      clearTimeout(entry.retryTimer);
      entry.retryTimer = undefined;
    }
    if (entry.handoffTimer) {
      clearTimeout(entry.handoffTimer);
      entry.handoffTimer = undefined;
    }
  }

  private nextFrameTimestamp(entry: ExtractionEntry): number {
    if (entry.options.timestampMode === "pts") {
      // Prefer real PTS from ffmpeg showinfo (local file + -copyts).
      // Falls back to synthetic frameIndex × interval for RTSP streams
      // where showinfo is not added.
      if (entry.ptsQueue && entry.ptsQueue.length > 0) {
        const realPts = entry.ptsQueue.shift()!;
        entry.frameIndex++;
        return realPts;
      }
      // In fullRate mode, fps is the Percept decimation rate (e.g. 1fps),
      // not the actual video frame rate. Use the interval estimated from
      // real PTS deltas; fall back to fps-based interval in non-fullRate mode.
      const intervalMs = entry.options.fullRate
        ? (entry.estimatedIntervalMs ?? 33)  // estimated from video, default ~30fps
        : Math.round(1000 / Math.max(1, entry.options.fps));
      const ts = entry.baseMediaTs + entry.frameIndex * intervalMs;
      entry.frameIndex++;
      return ts;
    }

    return Date.now();
  }
}
