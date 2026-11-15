import { spawn, type ChildProcess } from "node:child_process";
import type { ServerResponse } from "node:http";
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const FFMPEG_JOB_TIMEOUT_MS = 60_000;
const FFMPEG_KILL_GRACE_MS = 3_000;

export const PREVIEW_SUFFIXES = [".browser-h264.mp4", ".h264.mp4"] as const;
export const THUMBNAIL_SUFFIX = ".thumb.jpg";

interface FfmpegQueuedJob {
  resolveWithSlot: (release: () => void) => void;
  rejectQueued: (err: Error) => void;
}

export interface FfmpegJobRunnerOptions {
  ffmpegBin: string;
  maxJobs: number;
  maxQueue: number;
}

export class FfmpegJobRunner {
  private activeJobs = 0;
  private readonly activeProcesses = new Set<ChildProcess>();
  private readonly killTimers = new WeakMap<ChildProcess, ReturnType<typeof setTimeout>>();
  private readonly queue: FfmpegQueuedJob[] = [];

  constructor(private readonly options: FfmpegJobRunnerOptions) {}

  stop(): void {
    for (const ffmpeg of this.activeProcesses) {
      this.terminate(ffmpeg);
    }
    this.activeProcesses.clear();
    const stoppedError = this.abortError("job", "dashboard stopped");
    for (const queuedJob of this.queue.splice(0)) {
      queuedJob.rejectQueued(stoppedError);
    }
  }

  async runToFile(
    args: string[],
    outputPath: string,
    label: string,
    res?: ServerResponse,
  ): Promise<void> {
    if (this.clientDisconnected(res)) throw this.abortError(label, "client disconnected");
    const release = await this.acquireSlot(label, res);
    try {
      if (this.clientDisconnected(res)) throw this.abortError(label, "client disconnected");
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const ffmpeg = spawn(this.options.ffmpegBin, args, { stdio: ["ignore", "ignore", "pipe"] });
        this.activeProcesses.add(ffmpeg);
        let stderr = "";
        let settled = false;
        let abortReason: string | null = null;
        const timeout = setTimeout(() => {
          abortReason = `timed out after ${FFMPEG_JOB_TIMEOUT_MS}ms`;
          this.terminate(ffmpeg);
        }, FFMPEG_JOB_TIMEOUT_MS);
        timeout.unref?.();

        const cleanup = () => {
          clearTimeout(timeout);
          this.activeProcesses.delete(ffmpeg);
          res?.off("close", onResponseClose);
        };
        const finish = (err?: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (err) rejectPromise(err);
          else resolvePromise();
        };
        const onResponseClose = () => {
          if (!res || res.writableEnded) return;
          abortReason = "client disconnected";
          this.terminate(ffmpeg);
        };
        res?.on("close", onResponseClose);

        ffmpeg.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
          if (stderr.length > 4000) stderr = stderr.slice(-4000);
        });
        ffmpeg.on("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));
        ffmpeg.on("close", (code, signal) => {
          if (abortReason) {
            finish(this.abortError(label, abortReason));
          } else if (code === 0 && existsSync(outputPath)) {
            finish();
          } else {
            finish(new Error(`ffmpeg ${label} failed (${code ?? signal ?? "unknown"}): ${stderr}`));
          }
        });
      });
    } finally {
      release();
    }
  }

  private clientDisconnected(res?: ServerResponse): boolean {
    return Boolean(res?.destroyed && !res.writableEnded);
  }

  private abortError(label: string, reason: string): Error {
    return new Error(`ffmpeg ${label} aborted: ${reason}`);
  }

  private acquireSlot(label: string, res?: ServerResponse): Promise<() => void> | (() => void) {
    const acquire = (): (() => void) => {
      this.activeJobs += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.activeJobs = Math.max(0, this.activeJobs - 1);
        this.queue.shift()?.resolveWithSlot(acquire());
      };
    };
    if (this.activeJobs < this.options.maxJobs) return acquire();

    if (this.options.maxQueue <= 0 || this.queue.length >= this.options.maxQueue) {
      throw new Error(`ffmpeg ${label} busy: queue full (${this.options.maxQueue})`);
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let queuedJob!: FfmpegQueuedJob;
      const cleanup = () => {
        res?.off("close", onResponseClose);
      };
      const removeQueuedJob = () => {
        const index = this.queue.indexOf(queuedJob);
        if (index >= 0) this.queue.splice(index, 1);
      };
      const onResponseClose = () => {
        if (res?.writableEnded || settled) return;
        settled = true;
        removeQueuedJob();
        cleanup();
        reject(this.abortError(label, "client disconnected"));
      };
      queuedJob = {
        resolveWithSlot: (release) => {
          if (settled) {
            release();
            return;
          }
          settled = true;
          cleanup();
          if (this.clientDisconnected(res)) {
            release();
            reject(this.abortError(label, "client disconnected"));
            return;
          }
          resolve(release);
        },
        rejectQueued: (err: Error) => {
          if (settled) return;
          settled = true;
          removeQueuedJob();
          cleanup();
          reject(err);
        },
      };
      res?.on("close", onResponseClose);
      this.queue.push(queuedJob);
    });
  }

  private childExited(child: ChildProcess): boolean {
    return child.exitCode !== null || child.signalCode !== null;
  }

  private terminate(child: ChildProcess): void {
    if (this.childExited(child) || this.killTimers.has(child)) return;
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => {
      this.killTimers.delete(child);
      if (!this.childExited(child)) child.kill("SIGKILL");
    }, FFMPEG_KILL_GRACE_MS);
    this.killTimers.set(child, killTimer);
    child.once("close", () => {
      clearTimeout(killTimer);
      this.killTimers.delete(child);
    });
    killTimer.unref?.();
  }
}

export async function ensurePreviewVideoFile(input: {
  uploadsDir: string;
  previewCacheDir?: string | null;
  videoId: string;
  sourcePath: string;
  res?: ServerResponse;
  runFfmpegToFile: (
    args: string[],
    outputPath: string,
    label: string,
    res?: ServerResponse,
  ) => Promise<void>;
}): Promise<string> {
  const previewDir = input.previewCacheDir ?? join(input.uploadsDir, ".preview");
  if (!existsSync(previewDir)) mkdirSync(previewDir, { recursive: true });
  const previewName = `${input.videoId.replace(/[^a-zA-Z0-9._-]/g, "_")}${PREVIEW_SUFFIXES[0]}`;
  const previewPath = join(previewDir, previewName);
  if (existsSync(previewPath) && statSync(previewPath).mtimeMs >= statSync(input.sourcePath).mtimeMs) {
    return previewPath;
  }

  const tmpPath = `${previewPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await input.runFfmpegToFile([
      "-y",
      "-i", input.sourcePath,
      "-an",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-profile:v", "baseline",
      "-level:v", "4.0",
      "-pix_fmt", "yuv420p",
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-bf", "0",
      "-movflags", "+faststart",
      "-f", "mp4",
      tmpPath,
    ], tmpPath, "preview transcode", input.res);
    renameSync(tmpPath, previewPath);
  } finally {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }

  return previewPath;
}

export async function ensureThumbnailImageFile(input: {
  uploadsDir: string;
  previewCacheDir?: string | null;
  videoId: string;
  sourcePath: string;
  res?: ServerResponse;
  runFfmpegToFile: (
    args: string[],
    outputPath: string,
    label: string,
    res?: ServerResponse,
  ) => Promise<void>;
}): Promise<string> {
  const previewDir = input.previewCacheDir ?? join(input.uploadsDir, ".preview");
  if (!existsSync(previewDir)) mkdirSync(previewDir, { recursive: true });
  const thumbnailName = `${input.videoId.replace(/[^a-zA-Z0-9._-]/g, "_")}${THUMBNAIL_SUFFIX}`;
  const thumbnailPath = join(previewDir, thumbnailName);
  if (existsSync(thumbnailPath) && statSync(thumbnailPath).mtimeMs >= statSync(input.sourcePath).mtimeMs) {
    return thumbnailPath;
  }

  const tmpPath = `${thumbnailPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await input.runFfmpegToFile([
      "-y",
      "-ss", "0.2",
      "-i", input.sourcePath,
      "-frames:v", "1",
      "-vf", "scale=640:-2:force_original_aspect_ratio=decrease",
      "-q:v", "3",
      "-f", "image2",
      "-vcodec", "mjpeg",
      tmpPath,
    ], tmpPath, "thumbnail extract", input.res);
    renameSync(tmpPath, thumbnailPath);
  } finally {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }

  return thumbnailPath;
}
