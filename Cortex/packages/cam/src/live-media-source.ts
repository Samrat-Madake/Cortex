import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { splitJpegFramesWithRemainder } from "./frame-extractor.js";

export interface LiveVideoFrame {
  jpeg: Buffer<ArrayBufferLike>;
  /** Stream PTS normalized so the first emitted video PTS is 0ms. */
  ptsMs: number;
}

export interface LiveAudioChunk {
  pcm: Buffer<ArrayBufferLike>;
  /** Audio sample PTS on the same normalized timeline as LiveVideoFrame. */
  ptsMs: number;
}

export interface LiveMediaSourceOptions {
  inputUrl: string;
  fps: number;
  width: number;
  height: number;
  fullRate?: boolean;
  sampleRate?: number;
  ffmpegBin?: string;
  jpegQuality?: number;
  rtspTransport?: "tcp" | "udp";
  onVideoFrame: (frame: LiveVideoFrame) => void | Promise<void>;
  onAudioChunk?: (chunk: LiveAudioChunk) => void | Promise<void>;
  onAudioUnavailable?: () => void;
}

const DEFAULT_SAMPLE_RATE = 16_000;
const DEFAULT_JPEG_QUALITY = 5;
const MAX_UNPAIRED_VIDEO_FRAMES = 30;

export function buildLiveMediaArgs(options: {
  inputUrl: string;
  fps: number;
  width: number;
  height: number;
  fullRate?: boolean;
  sampleRate?: number;
  jpegQuality?: number;
  audio?: boolean;
  rtspTransport?: "tcp" | "udp";
}): string[] {
  const transportArgs = /^rtsp:/i.test(options.inputUrl) ? ["-rtsp_transport", options.rtspTransport ?? "tcp"] : [];
  const filters = buildLiveVideoFilters(options);
  const args = [
    ...transportArgs,
    "-i", options.inputUrl,
    "-map", "0:v",
    // select preserves PTS but does not define a CFR output rate. Without
    // fps_mode drop, ffmpeg may duplicate JPEGs that have no matching showinfo PTS.
    "-fps_mode", "drop",
    "-vf", filters.join(","),
    "-f", "image2pipe",
    "-vcodec", "mjpeg",
    "-q:v", String(options.jpegQuality ?? DEFAULT_JPEG_QUALITY),
    "pipe:1",
  ];
  if (options.audio !== false) {
    args.push(
      "-map", "0:a?",
      "-af", "aresample=async=1:first_pts=0,ashowinfo",
      "-acodec", "pcm_s16le",
      "-ar", String(options.sampleRate ?? DEFAULT_SAMPLE_RATE),
      "-ac", "1",
      "-f", "s16le",
      "pipe:3",
    );
  }
  return args;
}

function buildLiveVideoFilters(options: { fps: number; width: number; height: number; fullRate?: boolean }): string[] {
  const filters: string[] = ["setpts=PTS-STARTPTS"];
  if (options.fullRate !== true) {
    const interval = (1 / Math.max(1, options.fps)).toFixed(6);
    filters.push(`select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,${interval})'`);
  }
  filters.push("showinfo");
  if (options.width > 0 && options.height > 0) {
    filters.push(`scale=${Math.floor(options.width)}:${Math.floor(options.height)}:force_original_aspect_ratio=decrease`);
  }
  return filters;
}

export class LiveMediaSource {
  private readonly options: Required<Pick<LiveMediaSourceOptions, "ffmpegBin" | "sampleRate" | "jpegQuality">>
    & LiveMediaSourceOptions;
  private proc: ChildProcess | null = null;
  private closed = false;
  private videoStdout: Readable | null = null;
  private audioStdout: Readable | null = null;
  private stderr: Readable | null = null;

  constructor(options: LiveMediaSourceOptions) {
    this.options = {
      ...options,
      ffmpegBin: options.ffmpegBin ?? "ffmpeg",
      sampleRate: options.sampleRate ?? DEFAULT_SAMPLE_RATE,
      jpegQuality: options.jpegQuality ?? DEFAULT_JPEG_QUALITY,
    };
  }

  async start(): Promise<void> {
    const wantsAudio = Boolean(this.options.onAudioChunk);
    try {
      await this.startOnce(wantsAudio);
    } catch (err) {
      if (this.closed || !wantsAudio || !isNoAudioOutputError(err)) throw err;
      this.options.onAudioUnavailable?.();
      if (this.closed) return;
      await this.startOnce(false);
    }
  }

  private async startOnce(audioEnabled: boolean): Promise<void> {
    const args = buildLiveMediaArgs({ ...this.options, audio: audioEnabled });
    const stdio: Array<"ignore" | "pipe"> = audioEnabled
      ? ["ignore", "pipe", "pipe", "pipe"]
      : ["ignore", "pipe", "pipe"];
    const proc = spawn(this.options.ffmpegBin, args, { stdio });
    this.proc = proc;
    this.videoStdout = proc.stdout;
    this.stderr = proc.stderr;
    this.audioStdout = audioEnabled ? proc.stdio[3] as Readable | null : null;

    try {
      await this.consumeProcess(proc);
    } finally {
      if (this.proc === proc) this.proc = null;
      this.videoStdout = null;
      this.audioStdout = null;
      this.stderr = null;
    }
  }

  close(): void {
    this.closed = true;
    this.videoStdout?.resume();
    this.audioStdout?.resume();
    this.stderr?.resume();
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    if (proc.exitCode != null || proc.signalCode != null) return;
    let exited = false;
    const escalation = setTimeout(() => {
      if (!exited) proc.kill("SIGKILL");
    }, 500);
    proc.once("exit", () => {
      exited = true;
      clearTimeout(escalation);
    });
    proc.kill("SIGTERM");
  }

  private async consumeProcess(proc: ChildProcess): Promise<void> {
    const videoPtsQueue: number[] = [];
    let pendingVideo = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
    let videoRemainder = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
    let stderrRemainder = "";
    let stderrTail = "";
    let videoBasePts: number | null = null;
    let audioStartOffsetMs: number | null = null;
    let firstAudioPts: number | null = null;
    let audioSampleOffset = 0;
    let videoChain = Promise.resolve();
    let videoResumeGeneration = 0;
    let audioChain = Promise.resolve();
    let audioResumeGeneration = 0;
    let callbackError: unknown;
    let lastQueuedVideoPts: number | null = null;
    let estimatedVideoIntervalMs = 1000 / Math.max(1, this.options.fps);

    const failFromCallback = (err: unknown): void => {
      if (callbackError === undefined) callbackError = err;
      this.close();
    };
    const queueVideoPts = (rawPtsMs: number): void => {
      if (videoBasePts === null) videoBasePts = rawPtsMs;
      const rawNormalized = Math.max(0, rawPtsMs - videoBasePts);
      let normalized = rawNormalized;
      if (lastQueuedVideoPts !== null) {
        if (rawNormalized > lastQueuedVideoPts) {
          const delta = rawNormalized - lastQueuedVideoPts;
          if (delta > 0 && delta < 10_000) estimatedVideoIntervalMs = delta;
        } else {
          normalized = lastQueuedVideoPts + Math.max(1, estimatedVideoIntervalMs);
        }
      }
      lastQueuedVideoPts = normalized;
      videoPtsQueue.push(normalized);
    };
    const queueSyntheticVideoPts = (): void => {
      const next = lastQueuedVideoPts === null
        ? 0
        : lastQueuedVideoPts + Math.max(1, estimatedVideoIntervalMs);
      lastQueuedVideoPts = next;
      videoPtsQueue.push(next);
    };
    const enqueueVideoWork = (work: () => Promise<void>): void => {
      // Pause only after a JPEG has a matching PTS and real downstream work is
      // pending. Pausing earlier can deadlock waiting for the showinfo line.
      proc.stdout?.pause();
      videoChain = videoChain.then(async () => {
        if (this.closed || callbackError !== undefined) return;
        try {
          await work();
        } catch (err) {
          failFromCallback(err);
        }
      });
    };
    const scheduleVideoResume = (): void => {
      if (!proc.stdout?.isPaused()) return;
      const generation = ++videoResumeGeneration;
      void videoChain.finally(() => {
        if (!this.closed && generation === videoResumeGeneration) {
          proc.stdout?.resume();
        }
      }).catch(() => {});
    };
    const synthesizeLaggingVideoPts = (): void => {
      const split = splitJpegFramesWithRemainder(pendingVideo);
      const missingPts = split.frames.length - videoPtsQueue.length - MAX_UNPAIRED_VIDEO_FRAMES;
      for (let i = 0; i < missingPts; i += 1) {
        queueSyntheticVideoPts();
      }
    };
    const flushPendingVideo = (): void => {
      pendingVideo = this.flushVideoFrames(pendingVideo, videoPtsQueue, enqueueVideoWork);
      synthesizeLaggingVideoPts();
      pendingVideo = this.flushVideoFrames(pendingVideo, videoPtsQueue, enqueueVideoWork);
      scheduleVideoResume();
    };

    proc.stderr?.on("data", (chunk: Buffer) => {
      if (this.closed) return;
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-8192);
      const parsed = parseLiveShowinfo(stderrRemainder + text);
      stderrRemainder = parsed.remaining;
      for (const ptsMs of parsed.videoPtsMs) {
        queueVideoPts(ptsMs);
      }
      if (audioStartOffsetMs === null && firstAudioPts !== null && videoBasePts !== null) {
        audioStartOffsetMs = firstAudioPts - videoBasePts;
      }
      if (audioStartOffsetMs === null && parsed.audioPtsMs.length > 0) {
        firstAudioPts = parsed.audioPtsMs[0]!;
        if (videoBasePts !== null) audioStartOffsetMs = firstAudioPts - videoBasePts;
      }
      flushPendingVideo();
    });

    proc.stdout?.on("data", (chunk: Buffer) => {
      if (this.closed) return;
      const split = splitJpegFramesWithRemainder(Buffer.concat([videoRemainder, chunk]));
      videoRemainder = split.remaining;
      pendingVideo = Buffer.concat([pendingVideo, ...split.frames]);
      flushPendingVideo();
    });

    this.audioStdout?.on("data", (chunk: Buffer) => {
      if (this.closed) return;
      this.audioStdout?.pause();
      const ptsMs = Math.max(0, (audioStartOffsetMs ?? 0) + (audioSampleOffset / this.options.sampleRate) * 1000);
      audioSampleOffset += Math.floor(chunk.length / 2);
      const audioChunk: LiveAudioChunk = { pcm: Buffer.from(chunk), ptsMs };
      audioChain = audioChain.then(async () => {
        if (this.closed || callbackError !== undefined) return;
        try {
          await this.options.onAudioChunk?.(audioChunk);
        } catch (err) {
          failFromCallback(err);
        }
      });
      const generation = ++audioResumeGeneration;
      void audioChain.finally(() => {
        if (!this.closed && generation === audioResumeGeneration) this.audioStdout?.resume();
      }).catch(() => {});
    });

    try {
      await waitForExit(proc, () => this.closed);
    } catch (err) {
      throw appendFfmpegError(err, stderrTail);
    }
    this.videoStdout?.resume();
    this.audioStdout?.resume();
    this.stderr?.resume();
    await Promise.all([
      waitForReadableEnd(this.videoStdout),
      waitForReadableEnd(this.audioStdout),
      waitForReadableEnd(this.stderr),
    ]);
    if (!this.closed && stderrRemainder.length > 0) {
      const parsed = parseLiveShowinfo(stderrRemainder);
      for (const ptsMs of parsed.videoPtsMs) {
        queueVideoPts(ptsMs);
      }
      flushPendingVideo();
    }
    await Promise.all([videoChain, audioChain]);
    if (callbackError !== undefined) throw callbackError;
  }

  private flushVideoFrames(
    pendingVideo: Buffer<ArrayBufferLike>,
    ptsQueue: number[],
    enqueue: (work: () => Promise<void>) => void,
  ): Buffer<ArrayBufferLike> {
    let remaining = pendingVideo;
    while (remaining.length > 0 && ptsQueue.length > 0) {
      const split = splitJpegFramesWithRemainder(remaining);
      if (split.frames.length === 0) return remaining;
      const [frame, ...rest] = split.frames;
      remaining = Buffer.concat([...rest, split.remaining]);
      const ptsMs = ptsQueue.shift()!;
      enqueue(async () => {
        await this.options.onVideoFrame({ jpeg: Buffer.from(frame!), ptsMs });
      });
    }
    return remaining;
  }
}

export function parseLiveShowinfo(buffer: string): { videoPtsMs: number[]; audioPtsMs: number[]; remaining: string } {
  const lines = buffer.split("\n");
  const remaining = lines.pop() ?? "";
  const videoPtsMs: number[] = [];
  const audioPtsMs: number[] = [];
  for (const line of lines) {
    const match = line.match(/pts_time:\s*(-?[\d.]+)/);
    if (!match) continue;
    const ptsMs = Number.parseFloat(match[1]!) * 1000;
    if (!Number.isFinite(ptsMs)) continue;
    if (line.includes("ashowinfo")) {
      audioPtsMs.push(ptsMs);
    } else if (line.includes("showinfo")) {
      videoPtsMs.push(ptsMs);
    }
  }
  return { videoPtsMs, audioPtsMs, remaining };
}

function waitForExit(proc: ChildProcess, isClosed: () => boolean = () => false): Promise<void> {
  return new Promise((resolve, reject) => {
    proc.on("error", reject);
    proc.on("exit", (code, signal) => {
      if (isClosed()) {
        resolve();
        return;
      }
      if (code === 0 || code === null) {
        if (signal) reject(new Error(`ffmpeg exited with signal ${signal}`));
        else resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });
  });
}

function waitForReadableEnd(stream: Readable | null): Promise<void> {
  if (!stream || stream.readableEnded || stream.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      stream.off("end", onEnd);
      stream.off("close", onEnd);
      stream.off("error", onError);
    };
    const onEnd = (): void => {
      cleanup();
      resolve();
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    stream.once("end", onEnd);
    stream.once("close", onEnd);
    stream.once("error", onError);
  });
}

function appendFfmpegError(err: unknown, stderrTail: string): Error {
  const base = err instanceof Error ? err.message : String(err);
  const tail = stderrTail.trim();
  return new Error(tail ? `${base}: ${tail}` : base);
}

function isNoAudioOutputError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("Output file does not contain any stream")
    || message.includes("Stream map '0:a?' matches no streams");
}
