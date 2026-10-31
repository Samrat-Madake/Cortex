// eval/benchmark/pipeline/video-frame-source.ts
//
// Unified interface for extracting video frames by timestamp range.
// Benchmark uses SingleFileFrameSource (one mp4), production uses
// RecordingFrameSource (directory of 30s recording chunks).

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveFfmpegBin, resolveFfprobeBin } from "@reflectworld/cam";
import { streamFrames } from "./frame-stream.js";

export interface ExtractedFrame {
  /** Base64-encoded JPEG data. */
  data: string;
  /** Absolute timestamp in milliseconds (relative to the video/session timeline). */
  timestampMs: number;
}

export interface ExtractFramesOptions {
  /** Absolute start time in milliseconds (in the video/session timeline). */
  startMs: number;
  /** Duration to extract in milliseconds. */
  durationMs: number;
  /** Extraction FPS. Default 1. */
  fps?: number;
  /** Max frames to return. Default 30. */
  maxFrames?: number;
  /** Max short edge in pixels. Omit or 0 for original resolution. */
  maxShortEdge?: number;
}

/** Abstract source for extracting video frames by timestamp range. */
export interface VideoFrameSource {
  extractFrames(opts: ExtractFramesOptions): Promise<ExtractedFrame[]>;
}

// ---------------------------------------------------------------------------
// Benchmark: single video file
// ---------------------------------------------------------------------------

/** Extracts frames from a single video file using absolute timestamp seek. */
export class SingleFileFrameSource implements VideoFrameSource {
  constructor(
    private readonly videoPath: string,
    private readonly ffmpegBin = resolveFfmpegBin(),
    private readonly ffprobeBin = resolveFfprobeBin(undefined, ffmpegBin),
  ) {}

  async extractFrames(opts: ExtractFramesOptions): Promise<ExtractedFrame[]> {
    if (!existsSync(this.videoPath)) {
      throw new Error(`Video file not found: ${this.videoPath}`);
    }

    const fps = opts.fps ?? 1;
    const maxFrames = opts.maxFrames ?? 30;
    const endMs = opts.startMs + Math.max(500, opts.durationMs);
    const frames: ExtractedFrame[] = [];
    for await (const frame of streamFrames(
      this.videoPath,
      fps,
      endMs / 1000,
      1024,
      this.ffmpegBin,
      opts.maxShortEdge,
      this.ffprobeBin,
    )) {
      if (frame.timestampMs < opts.startMs) continue;
      frames.push({ data: frame.jpeg.toString("base64"), timestampMs: frame.timestampMs });
      if (frames.length >= maxFrames) break;
    }
    return frames;
  }
}

// ---------------------------------------------------------------------------
// Production: directory of recording chunks
// ---------------------------------------------------------------------------

/**
 * Extracts frames from a directory of recording chunks (e.g. cam1_20260511_143000.mp4).
 * Automatically spans across multiple files when the requested range crosses a boundary.
 */
export class RecordingFrameSource implements VideoFrameSource {
  constructor(private readonly recordingDir: string) {}

  async extractFrames(opts: ExtractFramesOptions): Promise<ExtractedFrame[]> {
    if (!existsSync(this.recordingDir)) {
      throw new Error(`Recording directory not found: ${this.recordingDir}`);
    }

    const recordings = listRecordings(this.recordingDir);
    if (recordings.length === 0) {
      throw new Error(`No .mp4 recordings in: ${this.recordingDir}`);
    }

    const fps = opts.fps ?? 1;
    const maxFrames = opts.maxFrames ?? 30;
    const requestEndMs = opts.startMs + opts.durationMs;

    // Find all recording files that overlap the requested time range.
    const overlapping = findOverlappingRecordings(recordings, opts.startMs, requestEndMs);
    if (overlapping.length === 0) {
      throw new Error(
        `No recording covers time range ${opts.startMs}-${requestEndMs}ms. ` +
        `Available: ${recordings[0].wallStartMs}-${recordings[recordings.length - 1].wallEndMs}ms`,
      );
    }

    const scaleFilter = buildScaleFilter(opts.maxShortEdge);
    const allFrames: ExtractedFrame[] = [];

    for (const rec of overlapping) {
      if (allFrames.length >= maxFrames) break;

      // Calculate seek offset within this recording file.
      // Recording files have -reset_timestamps 1, so internal PTS starts at 0.
      const fileOffsetMs = Math.max(0, opts.startMs - rec.wallStartMs);
      const fileEndMs = Math.min(requestEndMs, rec.wallEndMs) - rec.wallStartMs;
      const fileDurationMs = fileEndMs - fileOffsetMs;
      if (fileDurationMs <= 0) continue;

      const remaining = maxFrames - allFrames.length;
      const vf = scaleFilter ? `fps=${fps},${scaleFilter}` : `fps=${fps}`;

      const frameDir = mkdtempSync(join(tmpdir(), "reflectworld-vfs-"));
      try {
        execFileSync(resolveFfmpegBin(), [
          "-y",
          "-ss", String(fileOffsetMs / 1000),
          "-i", rec.path,
          "-t", String(fileDurationMs / 1000),
          "-vf", vf,
          "-q:v", "2",
          join(frameDir, "frame_%04d.jpg"),
        ], { stdio: "pipe" });

        // Absolute timestamp = recording wall start + file offset + frame index offset
        const baseMs = rec.wallStartMs + fileOffsetMs;
        const frames = collectFrames(frameDir, remaining, baseMs, fps);
        allFrames.push(...frames);
      } finally {
        rmSync(frameDir, { recursive: true, force: true });
      }
    }

    return allFrames;
  }
}

// ---------------------------------------------------------------------------
// Benchmark: multi-clip session (e.g. HippoVlog multiple clips per session)
// ---------------------------------------------------------------------------

export interface TimelineClip {
  /** Absolute path to the clip file. */
  path: string;
  /** Session-absolute start time of this clip in milliseconds. */
  mediaStartMs: number;
  /** Duration of this clip in ms. Estimated from next clip start or left undefined. */
  mediaDurationMs?: number;
}

/**
 * Routes frame extraction to the correct clip file(s) within a multi-clip session.
 * Timestamps in ExtractFramesOptions are session-absolute; SessionFrameSource
 * translates them to clip-local offsets before delegating to SingleFileFrameSource.
 */
export class SessionFrameSource implements VideoFrameSource {
  private readonly clips: TimelineClip[];

  constructor(clips: TimelineClip[]) {
    this.clips = [...clips].sort((a, b) => a.mediaStartMs - b.mediaStartMs);
    if (this.clips.length === 0) {
      throw new Error("SessionFrameSource requires at least one clip");
    }
  }

  async extractFrames(opts: ExtractFramesOptions): Promise<ExtractedFrame[]> {
    const fps = opts.fps ?? 1;
    const maxFrames = opts.maxFrames ?? 30;
    const requestStartMs = opts.startMs;
    const requestEndMs = requestStartMs + opts.durationMs;

    // Find clips that overlap [requestStartMs, requestEndMs).
    const overlapping = this.findOverlappingClips(requestStartMs, requestEndMs);
    if (overlapping.length === 0) {
      throw new Error(
        `No clip covers time range ${requestStartMs}-${requestEndMs}ms. ` +
        `Available clips: ${this.clips.map(c => `${c.path}@${c.mediaStartMs}ms`).join(", ")}`,
      );
    }

    const allFrames: ExtractedFrame[] = [];

    for (const clip of overlapping) {
      if (allFrames.length >= maxFrames) break;

      const clipEndMs = this.clipEndMs(clip);
      // Calculate clip-local seek offset
      const clipLocalStartMs = Math.max(0, requestStartMs - clip.mediaStartMs);
      const clipLocalEndMs = Math.min(clipEndMs - clip.mediaStartMs, requestEndMs - clip.mediaStartMs);
      const clipDurationMs = clipLocalEndMs - clipLocalStartMs;
      if (clipDurationMs <= 0) continue;

      const remaining = maxFrames - allFrames.length;
      const singleSource = new SingleFileFrameSource(clip.path);
      // Delegate to SingleFileFrameSource with clip-local coordinates, then fix up timestamps.
      const frames = await singleSource.extractFrames({
        startMs: clipLocalStartMs,
        durationMs: clipDurationMs,
        fps,
        maxFrames: remaining,
        maxShortEdge: opts.maxShortEdge,
      });

      // Fix timestamps: SingleFileFrameSource returns clip-local ms → convert to session-absolute
      for (const frame of frames) {
        frame.timestampMs = clip.mediaStartMs + frame.timestampMs;
      }
      allFrames.push(...frames);
    }

    return allFrames.slice(0, maxFrames);
  }

  private findOverlappingClips(startMs: number, endMs: number): TimelineClip[] {
    return this.clips.filter(clip => {
      const clipEnd = this.clipEndMs(clip);
      return clip.mediaStartMs < endMs && clipEnd > startMs;
    });
  }

  private clipEndMs(clip: TimelineClip): number {
    if (clip.mediaDurationMs != null && clip.mediaDurationMs > 0) {
      return clip.mediaStartMs + clip.mediaDurationMs;
    }
    // Estimate: find next clip start, or assume 10 minutes as upper bound.
    const idx = this.clips.indexOf(clip);
    if (idx >= 0 && idx + 1 < this.clips.length) {
      return this.clips[idx + 1].mediaStartMs;
    }
    return clip.mediaStartMs + 600_000;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RecordingFile {
  path: string;
  filename: string;
  /** Wall-clock start time parsed from filename (ms since epoch). */
  wallStartMs: number;
  /** Estimated wall-clock end time (start + file duration or segment_time). */
  wallEndMs: number;
}

/** Parse recording filename like "cam1_20260511_143000.mp4" → wall-clock timestamp. */
function parseRecordingTimestamp(filename: string): number | null {
  // Match patterns: name_YYYYMMDD_HHMMSS.mp4
  const match = filename.match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.mp4$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}`).getTime();
}

/** List and sort all .mp4 recordings in a directory. */
function listRecordings(dir: string): RecordingFile[] {
  const files = readdirSync(dir)
    .filter(f => f.endsWith(".mp4"))
    .map(filename => {
      const wallStartMs = parseRecordingTimestamp(filename);
      if (wallStartMs === null || isNaN(wallStartMs)) return null;
      return { path: join(dir, filename), filename, wallStartMs, wallEndMs: 0 };
    })
    .filter((f): f is RecordingFile => f !== null)
    .sort((a, b) => a.wallStartMs - b.wallStartMs);

  // Estimate end times: each recording ends when the next one starts,
  // or after 60s for the last file (conservative upper bound).
  for (let i = 0; i < files.length; i++) {
    files[i].wallEndMs = i + 1 < files.length
      ? files[i + 1].wallStartMs
      : files[i].wallStartMs + 60_000;
  }

  return files;
}

/** Find recordings whose time range overlaps [startMs, endMs). */
function findOverlappingRecordings(recordings: RecordingFile[], startMs: number, endMs: number): RecordingFile[] {
  return recordings.filter(r => r.wallStartMs < endMs && r.wallEndMs > startMs);
}

/** Build ffmpeg scale filter for max short edge. Empty string if no scaling needed. */
function buildScaleFilter(maxShortEdge?: number): string {
  if (!maxShortEdge || maxShortEdge <= 0) return "";
  const s = maxShortEdge;
  return `scale='if(gt(iw,ih),if(gt(ih,${s}),${s}*iw/ih,-2),if(gt(iw,${s}),${s}*ih/iw,-2))':'if(gt(iw,ih),if(gt(ih,${s}),${s},-2),if(gt(iw,${s}),-2,${s}))'`;
}

/** Collect extracted JPEG frames from a directory into ExtractedFrame[]. */
function collectFrames(frameDir: string, maxFrames: number, baseMs: number, fps: number): ExtractedFrame[] {
  const files = readdirSync(frameDir)
    .filter(f => f.endsWith(".jpg"))
    .sort()
    .slice(0, maxFrames);

  return files.map((file, index) => ({
    data: readFileSync(join(frameDir, file)).toString("base64"),
    timestampMs: baseMs + Math.round((index / fps) * 1000),
  }));
}
