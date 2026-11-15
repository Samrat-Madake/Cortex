import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveFfmpegBin } from "../binary-installer.js";
import { LiveMediaSource } from "../live-media-source.js";

function hasFfmpeg(ffmpegBin: string): boolean {
  try {
    execFileSync(ffmpegBin, ["-version"], { stdio: "ignore" });
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

function createVideoOnly(ffmpegBin: string, videoPath: string, durationSec: number): void {
  execFileSync(ffmpegBin, [
    "-hide_banner",
    "-loglevel", "error",
    "-f", "lavfi",
    "-i", `testsrc=size=160x90:rate=10:duration=${durationSec}`,
    "-an",
    "-c:v", "mpeg4",
    "-pix_fmt", "yuv420p",
    videoPath,
  ]);
}

describe("LiveMediaSource ffmpeg integration", () => {
  const resolvedFfmpegBin = tryResolveFfmpegBin();
  const runIfFfmpeg = resolvedFfmpegBin && hasFfmpeg(resolvedFfmpegBin) ? it : it.skip;
  const ffmpegBin = resolvedFfmpegBin ?? "ffmpeg";

  runIfFfmpeg("retries as video-only when the input has no audio stream", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-live-media-"));
    const videoPath = join(dir, "no-audio.mp4");
    try {
      createVideoOnly(ffmpegBin, videoPath, 2);

      const pts: number[] = [];
      let audioUnavailable = false;
      let audioChunks = 0;
      const source = new LiveMediaSource({
        inputUrl: videoPath,
        fps: 2,
        width: 160,
        height: 90,
        ffmpegBin,
        onVideoFrame: (frame) => {
          pts.push(frame.ptsMs);
        },
        onAudioChunk: () => {
          audioChunks += 1;
        },
        onAudioUnavailable: () => {
          audioUnavailable = true;
        },
      });

      await withTimeout(source.start(), 5_000, "LiveMediaSource no-audio retry");

      expect(audioUnavailable).toBe(true);
      expect(audioChunks).toBe(0);
      expect(pts.length).toBeGreaterThan(0);
      expect(pts[0]).toBe(0);
      for (let i = 1; i < pts.length; i += 1) {
        expect(pts[i]!).toBeGreaterThan(pts[i - 1]!);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
