import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { splitJpegFramesWithRemainder } from "./frame-extractor.js";
import { parseCompleteShowinfoLines, parseShowinfoPtsMs } from "./showinfo.js";

export type LocalFilePacing = "fast" | "realtime";

export interface LocalFileMediaSourceOptions {
  videoPath: string;
  fps: number;
  pacing: LocalFilePacing;
  fullRate?: boolean;
  maxDurationSec?: number;
  maxLongEdge?: number;
  maxShortEdge?: number;
  jpegQuality?: number;
  sampleRate?: number;
  ffmpegBin?: string;
  ffprobeBin?: string;
  onVideoFrame: (frame: VideoFrame) => void | Promise<void>;
  onAudioChunk?: (chunk: AudioChunk) => void | Promise<void>;
}

export interface VideoFrame {
  jpeg: Buffer<ArrayBufferLike>;
  /** Real media PTS normalized so the first video PTS is 0ms. */
  ptsMs: number;
}

export interface AudioChunk {
  pcm: Buffer<ArrayBufferLike>;
  /** Audio sample PTS on the same video-normalized timeline as VideoFrame. */
  ptsMs: number;
}

export interface MediaProbeInfo {
  hasAudio: boolean;
  videoStartTimeMs: number;
  audioStartTimeMs?: number;
  audioStartPtsMs?: number;
}

interface FfprobeStreamInfo {
  codec_type?: string;
  start_time?: string | number;
}

const DEFAULT_MAX_LONG_EDGE = 1024;
const DEFAULT_JPEG_QUALITY = 2;
const DEFAULT_SAMPLE_RATE = 16_000;

export function buildFfprobeArgs(videoPath: string): string[] {
  return [
    "-v", "error",
    "-show_entries", "stream=index,codec_type,start_time",
    "-of", "json",
    videoPath,
  ];
}

export function parseFfprobeMediaInfo(stdout: string): MediaProbeInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`Failed to parse ffprobe output: ${err instanceof Error ? err.message : String(err)}`);
  }

  const streams = Array.isArray((parsed as { streams?: unknown }).streams)
    ? ((parsed as { streams: unknown[] }).streams as FfprobeStreamInfo[])
    : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  if (!video) throw new Error("No video stream found");

  const audio = streams.find((stream) => stream.codec_type === "audio");
  const videoStartTimeMs = parseStartTimeMs(video.start_time);
  const audioStartTimeMs = audio ? parseStartTimeMs(audio.start_time) : undefined;

  return {
    hasAudio: Boolean(audio),
    videoStartTimeMs,
    audioStartTimeMs,
    audioStartPtsMs: audioStartTimeMs === undefined ? undefined : audioStartTimeMs - videoStartTimeMs,
  };
}

function parseStartTimeMs(value: string | number | undefined): number {
  if (value === undefined) return 0;
  const seconds = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(seconds) ? seconds * 1000 : 0;
}

export function buildLocalFileMediaArgs(options: {
  videoPath: string;
  fps: number;
  pacing: LocalFilePacing;
  fullRate?: boolean;
  hasAudio: boolean;
  sampleRate?: number;
  maxLongEdge?: number;
  maxShortEdge?: number;
  jpegQuality?: number;
  maxDurationSec?: number;
}): string[] {
  const args: string[] = [];
  if (options.pacing === "realtime") args.push("-re");
  // Keep duration as an input cap so video and audio outputs are bounded together.
  if (options.maxDurationSec !== undefined && options.maxDurationSec > 0) {
    args.push("-t", String(options.maxDurationSec));
  }
  args.push("-i", options.videoPath);

  const videoFilters = buildVideoFilters({
    fps: options.fps,
    fullRate: options.fullRate === true,
    maxLongEdge: options.maxLongEdge ?? DEFAULT_MAX_LONG_EDGE,
    maxShortEdge: options.maxShortEdge,
  });
  args.push(
    "-map", "0:v",
    // select preserves input PTS but does not define a CFR output rate.
    "-fps_mode", "vfr",
    "-vf", videoFilters.join(","),
    "-f", "image2pipe",
    "-vcodec", "mjpeg",
    "-q:v", String(options.jpegQuality ?? DEFAULT_JPEG_QUALITY),
    "pipe:1",
  );

  if (options.hasAudio) {
    args.push(
      "-map", "0:a",
      "-acodec", "pcm_s16le",
      "-ar", String(options.sampleRate ?? DEFAULT_SAMPLE_RATE),
      "-ac", "1",
      "-f", "s16le",
      "pipe:3",
    );
  }

  return args;
}

function buildVideoFilters(options: { fps: number; fullRate: boolean; maxLongEdge: number; maxShortEdge?: number }): string[] {
  const filters: string[] = [];
  if (!options.fullRate) {
    const interval = (1 / Math.max(1, options.fps)).toFixed(6);
    filters.push(`select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,${interval})'`);
  }
  filters.push("showinfo");
  if (options.maxShortEdge !== undefined && options.maxShortEdge > 0) {
    const edge = Math.floor(options.maxShortEdge);
    filters.push(`scale='if(gt(iw,ih),if(gt(ih,${edge}),${edge}*iw/ih,-2),if(gt(iw,${edge}),${edge}*ih/iw,-2))':'if(gt(iw,ih),if(gt(ih,${edge}),${edge},-2),if(gt(iw,${edge}),-2,${edge}))'`);
  } else if (options.maxLongEdge > 0) {
    const edge = Math.floor(options.maxLongEdge);
    filters.push(`scale='if(gte(iw,ih),min(${edge},iw),-2)':'if(gte(iw,ih),-2,min(${edge},ih))'`);
  }
  return filters;
}

export class LocalFileMediaSource {
  private readonly options: Required<Pick<LocalFileMediaSourceOptions, "ffmpegBin" | "ffprobeBin" | "sampleRate" | "maxLongEdge" | "jpegQuality">>
    & LocalFileMediaSourceOptions;
  private proc: ChildProcess | null = null;
  private activeVideoStdout: Readable | null = null;
  private activeAudioStdout: Readable | null = null;
  private activeStderr: Readable | null = null;
  private closed = false;

  constructor(options: LocalFileMediaSourceOptions) {
    this.options = {
      ...options,
      ffmpegBin: options.ffmpegBin ?? "ffmpeg",
      ffprobeBin: options.ffprobeBin ?? "ffprobe",
      sampleRate: options.sampleRate ?? DEFAULT_SAMPLE_RATE,
      maxLongEdge: options.maxLongEdge ?? DEFAULT_MAX_LONG_EDGE,
      jpegQuality: options.jpegQuality ?? DEFAULT_JPEG_QUALITY,
    };
  }

  async start(): Promise<void> {
    const probe = await runFfprobe(this.options.ffprobeBin, this.options.videoPath);
    if (this.closed) return;

    const args = buildLocalFileMediaArgs({
      videoPath: this.options.videoPath,
      fps: this.options.fps,
      pacing: this.options.pacing,
      fullRate: this.options.fullRate,
      hasAudio: probe.hasAudio,
      sampleRate: this.options.sampleRate,
      maxLongEdge: this.options.maxLongEdge,
      maxShortEdge: this.options.maxShortEdge,
      jpegQuality: this.options.jpegQuality,
      maxDurationSec: this.options.maxDurationSec,
    });
    const stdio: Array<"ignore" | "pipe"> = probe.hasAudio
      ? ["ignore", "pipe", "pipe", "pipe"]
      : ["ignore", "pipe", "pipe"];
    const proc = spawn(this.options.ffmpegBin, args, { stdio });
    this.proc = proc;

    try {
      await this.consumeProcess(proc, probe);
    } finally {
      if (this.proc === proc) this.proc = null;
      this.clearActiveStreams();
    }
  }

  close(): void {
    this.closed = true;
    this.resumeActiveStreams();
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    if (hasProcessExited(proc)) return;
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

  private async consumeProcess(proc: ChildProcess, probe: MediaProbeInfo): Promise<void> {
    const videoStdout = proc.stdout as Readable | null;
    const stderr = proc.stderr as Readable | null;
    const audioStdout = getAudioStdout(proc);
    this.activeVideoStdout = videoStdout;
    this.activeAudioStdout = audioStdout;
    this.activeStderr = stderr;
    const ptsQueue: number[] = [];
    let pendingVideo: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let videoRemainder: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderrRemainder = "";
    let videoChain = Promise.resolve();
    let videoResumeGeneration = 0;
    let audioChain = Promise.resolve();
    let audioResumeGeneration = 0;
    let audioSampleOffset = 0;
    let callbackError: unknown;
    const failFromCallback = (err: unknown): void => {
      if (callbackError === undefined) callbackError = err;
      this.close();
    };
    const enqueueVideoWork = (work: () => Promise<void>): void => {
      // Pause only when downstream async work is actually pending. Pausing as
      // soon as a JPEG arrives can deadlock when the matching showinfo PTS line
      // has not been read from stderr yet.
      videoStdout?.pause();
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
      if (!videoStdout?.isPaused()) return;
      if (pendingVideo.length > 0) return;
      const generation = ++videoResumeGeneration;
      void videoChain.finally(() => {
        if (!this.closed && generation === videoResumeGeneration && pendingVideo.length === 0) {
          videoStdout.resume();
        }
      }).catch(() => {});
    };

    stderr?.on("data", (chunk: Buffer) => {
      if (this.closed) return;
      const parsed = parseCompleteShowinfoLines(stderrRemainder + chunk.toString());
      stderrRemainder = parsed.remaining;
      for (const ptsMs of parsed.ptsMs) {
        ptsQueue.push(ptsMs - probe.videoStartTimeMs);
      }
      pendingVideo = this.flushVideoFrames(pendingVideo, ptsQueue, (work) => {
        enqueueVideoWork(work);
      });
      scheduleVideoResume();
    });

    const processVideoChunk = (chunk: Buffer): void => {
      if (this.closed) return;
      const split = splitJpegFramesWithRemainder(Buffer.concat([videoRemainder, chunk]));
      videoRemainder = split.remaining;
      pendingVideo = Buffer.concat([pendingVideo, ...split.frames]);
      pendingVideo = this.flushVideoFrames(pendingVideo, ptsQueue, (work) => {
        enqueueVideoWork(work);
      });
      scheduleVideoResume();
    };

    videoStdout?.on("data", (chunk: Buffer) => {
      if (this.closed) return;
      processVideoChunk(chunk);
    });

    audioStdout?.on("data", (chunk: Buffer) => {
      if (this.closed) return;
      audioStdout.pause();
      const ptsMs = (probe.audioStartPtsMs ?? 0) + (audioSampleOffset / this.options.sampleRate) * 1000;
      audioSampleOffset += Math.floor(chunk.length / 2);
      const audioChunk: AudioChunk = { pcm: Buffer.from(chunk), ptsMs };
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
        if (!this.closed && generation === audioResumeGeneration) audioStdout.resume();
      }).catch(() => {});
    });

    await waitForExit(proc, () => this.closed);
    await Promise.all([
      resumeAndWaitForEnd(videoStdout),
      resumeAndWaitForEnd(audioStdout),
      waitForReadableEnd(stderr),
    ]);
    if (!this.closed && stderrRemainder.length > 0) {
      for (const ptsMs of parseShowinfoPtsMs(stderrRemainder)) {
        ptsQueue.push(ptsMs - probe.videoStartTimeMs);
      }
      pendingVideo = this.flushVideoFrames(pendingVideo, ptsQueue, (work) => {
        enqueueVideoWork(work);
      });
      scheduleVideoResume();
    }
    await Promise.all([videoChain, audioChain]);
    if (callbackError !== undefined) throw callbackError;
  }

  private resumeActiveStreams(): void {
    this.activeVideoStdout?.resume();
    this.activeAudioStdout?.resume();
    this.activeStderr?.resume();
  }

  private clearActiveStreams(): void {
    this.activeVideoStdout = null;
    this.activeAudioStdout = null;
    this.activeStderr = null;
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
        const videoFrame: VideoFrame = { jpeg: Buffer.from(frame!), ptsMs };
        await this.options.onVideoFrame(videoFrame);
      });
    }
    return remaining;
  }
}

function hasProcessExited(proc: ChildProcess): boolean {
  return proc.exitCode != null || proc.signalCode != null;
}

function getAudioStdout(proc: ChildProcess): Readable | null {
  const stdio = proc.stdio as Array<NodeJS.ReadableStream | null> | undefined;
  return (stdio?.[3] as Readable | null | undefined) ?? null;
}

function resumeAndWaitForEnd(stream: Readable | null): Promise<void> {
  if (!stream) return Promise.resolve();
  stream.resume();
  return waitForReadableEnd(stream);
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

async function runFfprobe(ffprobeBin: string, videoPath: string): Promise<MediaProbeInfo> {
  const stdout = await collectProcessStdout(ffprobeBin, buildFfprobeArgs(videoPath));
  return parseFfprobeMediaInfo(stdout);
}

function collectProcessStdout(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${command} exited with code ${code ?? "unknown"}${stderr ? `: ${stderr.trim()}` : ""}`));
      }
    });
  });
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
        if (signal) {
          reject(new Error(`ffmpeg exited with signal ${signal}`));
        } else {
          resolve();
        }
      } else {
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });
  });
}
