import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { streamFrames } from "../../../../eval/benchmark/pipeline/frame-stream.js";
import { resolveFfmpegBin } from "../binary-installer.js";
import { LocalFileMediaSource } from "../local-file-media-source.js";

function resolveFfprobeBin(ffmpegBin: string): string {
  const sibling = join(dirname(ffmpegBin), "ffprobe");
  return existsSync(sibling) ? sibling : "ffprobe";
}

function hasFfmpeg(ffmpegBin: string, ffprobeBin: string): boolean {
  try {
    execFileSync(ffmpegBin, ["-version"], { stdio: "ignore" });
    execFileSync(ffprobeBin, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function tryResolveFfmpegBin(): string | null {
  try {
    return resolveFfmpegBin();
  } catch {
    return null;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}

function createLongAudioVideo(ffmpegBin: string, videoPath: string, durationSec: number): void {
  execFileSync(ffmpegBin, [
    "-hide_banner",
    "-loglevel", "error",
    "-f", "lavfi",
    "-i", `testsrc=size=1280x720:rate=30:duration=${durationSec}`,
    "-f", "lavfi",
    "-i", `sine=frequency=440:sample_rate=16000:duration=${durationSec}`,
    "-map", "0:v",
    "-map", "1:a",
    "-c:v", "mpeg4",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-shortest",
    videoPath,
  ]);
}

describe("LocalFileMediaSource ffmpeg integration", () => {
  const resolvedFfmpegBin = tryResolveFfmpegBin();
  const resolvedFfprobeBin = resolvedFfmpegBin ? resolveFfprobeBin(resolvedFfmpegBin) : null;
  const runIfFfmpeg = resolvedFfmpegBin && resolvedFfprobeBin && hasFfmpeg(resolvedFfmpegBin, resolvedFfprobeBin) ? it : it.skip;
  const ffmpegBin = resolvedFfmpegBin ?? "ffmpeg";
  const ffprobeBin = resolvedFfprobeBin ?? "ffprobe";

  runIfFfmpeg("does not duplicate JPEG frames when select emits sparse PTS", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reflectworld-local-file-"));
    const videoPath = join(dir, "cfr.mp4");
    try {
      execFileSync(ffmpegBin, [
        "-hide_banner",
        "-loglevel", "error",
        "-f", "lavfi",
        "-i", "testsrc=size=160x90:rate=10:duration=3",
        "-an",
        "-c:v", "mpeg4",
        "-pix_fmt", "yuv420p",
        videoPath,
      ]);

      const pts: number[] = [];
      const source = new LocalFileMediaSource({
        videoPath,
        fps: 2,
        pacing: "fast",
        ffmpegBin,
        ffprobeBin,
        onVideoFrame: (frame) => {
          pts.push(frame.ptsMs);
        },
      });

      await withTimeout(source.start(), 5_000, "LocalFileMediaSource");

      expect(pts.length).toBeGreaterThanOrEqual(5);
      expect(pts.length).toBeLessThanOrEqual(7);
      expect(pts[0]).toBe(0);
      for (let i = 1; i < pts.length; i += 1) {
        expect(pts[i]!).toBeGreaterThan(pts[i - 1]!);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  runIfFfmpeg("completes long large local files with slow frame callbacks without dropping tail media", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reflectworld-local-file-"));
    const videoPath = join(dir, "large.mp4");
    try {
      createLongAudioVideo(ffmpegBin, videoPath, 20);

      const pts: number[] = [];
      const audioPts: number[] = [];
      let audioBytes = 0;
      const source = new LocalFileMediaSource({
        videoPath,
        fps: 1,
        pacing: "fast",
        ffmpegBin,
        ffprobeBin,
        onVideoFrame: async (frame) => {
          pts.push(frame.ptsMs);
          await new Promise((resolve) => setTimeout(resolve, 30));
        },
        onAudioChunk: (chunk) => {
          audioPts.push(chunk.ptsMs);
          audioBytes += chunk.pcm.length;
        },
      });

      await withTimeout(source.start(), 30_000, "Large LocalFileMediaSource");

      expect(pts.length).toBe(20);
      expect(pts[0]).toBe(0);
      expect(pts.at(-1)).toBe(19_000);
      expect(audioPts.length).toBeGreaterThan(0);
      expect(audioPts.at(-1)).toBeGreaterThan(19_000);
      expect(audioBytes).toBeGreaterThan(600_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 35_000);

  runIfFfmpeg("settles when closed while stdout is paused for backpressure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reflectworld-local-file-"));
    const videoPath = join(dir, "close-paused.mp4");
    try {
      createLongAudioVideo(ffmpegBin, videoPath, 20);

      let frames = 0;
      let source: LocalFileMediaSource;
      source = new LocalFileMediaSource({
        videoPath,
        fps: 5,
        pacing: "fast",
        ffmpegBin,
        ffprobeBin,
        onVideoFrame: async () => {
          frames += 1;
          if (frames === 1) {
            setTimeout(() => source.close(), 20);
          }
          await new Promise((resolve) => setTimeout(resolve, 120));
        },
        onAudioChunk: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
        },
      });

      await withTimeout(source.start(), 2_000, "LocalFileMediaSource close while paused");
      expect(frames).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  runIfFfmpeg("rejects cleanly when a frame callback fails while stdout is paused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reflectworld-local-file-"));
    const videoPath = join(dir, "fail-paused.mp4");
    try {
      createLongAudioVideo(ffmpegBin, videoPath, 20);
      const expected = new Error("callback failed");
      const source = new LocalFileMediaSource({
        videoPath,
        fps: 5,
        pacing: "fast",
        ffmpegBin,
        ffprobeBin,
        onVideoFrame: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          throw expected;
        },
      });

      await expect(withTimeout(source.start(), 2_000, "LocalFileMediaSource callback failure")).rejects.toThrow("callback failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  runIfFfmpeg("lets benchmark streamFrames settle when the consumer breaks early", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reflectworld-local-file-"));
    const videoPath = join(dir, "early-break.mp4");
    try {
      createLongAudioVideo(ffmpegBin, videoPath, 20);

      let frames = 0;
      await withTimeout((async () => {
        for await (const _frame of streamFrames(videoPath, 5, 20, 1024, ffmpegBin, undefined, ffprobeBin)) {
          frames += 1;
          if (frames >= 3) break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      })(), 2_000, "benchmark streamFrames early break");

      expect(frames).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  runIfFfmpeg("keeps sparse/VFR-style frame timestamps monotonic with real ffmpeg output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reflectworld-local-file-"));
    const videoPath = join(dir, "sparse.mp4");
    try {
      execFileSync(ffmpegBin, [
        "-hide_banner",
        "-loglevel", "error",
        "-f", "lavfi",
        "-i", "testsrc=size=160x90:rate=30:duration=3",
        "-vf", "select='not(mod(n,7))'",
        "-fps_mode", "vfr",
        "-an",
        "-c:v", "mpeg4",
        "-pix_fmt", "yuv420p",
        videoPath,
      ]);

      const pts: number[] = [];
      const source = new LocalFileMediaSource({
        videoPath,
        fps: 5,
        pacing: "fast",
        ffmpegBin,
        ffprobeBin,
        onVideoFrame: (frame) => {
          pts.push(frame.ptsMs);
        },
      });

      await withTimeout(source.start(), 5_000, "Sparse LocalFileMediaSource");

      expect(pts.length).toBeGreaterThanOrEqual(10);
      expect(pts[0]).toBe(0);
      expect(pts.at(-1)).toBeGreaterThan(2_000);
      for (let i = 1; i < pts.length; i += 1) {
        expect(pts[i]!).toBeGreaterThan(pts[i - 1]!);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  runIfFfmpeg("emits audio chunks on the video-normalized PTS timeline for delayed audio streams", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reflectworld-local-file-"));
    const videoPath = join(dir, "audio-offset.mp4");
    try {
      execFileSync(ffmpegBin, [
        "-hide_banner",
        "-loglevel", "error",
        "-f", "lavfi",
        "-i", "testsrc=size=160x90:rate=5:duration=2",
        "-itsoffset", "0.5",
        "-f", "lavfi",
        "-i", "sine=frequency=440:sample_rate=16000:duration=1.5",
        "-map", "0:v",
        "-map", "1:a",
        "-c:v", "mpeg4",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-shortest",
        videoPath,
      ]);

      const videoPts: number[] = [];
      const audioPts: number[] = [];
      const source = new LocalFileMediaSource({
        videoPath,
        fps: 1,
        pacing: "fast",
        ffmpegBin,
        ffprobeBin,
        onVideoFrame: (frame) => {
          videoPts.push(frame.ptsMs);
        },
        onAudioChunk: (chunk) => {
          audioPts.push(chunk.ptsMs);
        },
      });

      await withTimeout(source.start(), 8_000, "Audio offset LocalFileMediaSource");

      expect(videoPts[0]).toBe(0);
      expect(audioPts.length).toBeGreaterThan(0);
      expect(audioPts[0]).toBeGreaterThan(250);
      expect(audioPts[0]).toBeLessThan(800);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
