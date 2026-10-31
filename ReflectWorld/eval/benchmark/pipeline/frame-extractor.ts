// eval/benchmark/pipeline/frame-extractor.ts
import { LocalFileMediaSource, resolveFfmpegBin, resolveFfprobeBin } from "@reflectworld/cam";
import { mkdirSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import type { Frame } from "@reflectworld/shared";
import { streamFrames } from "./frame-stream.js";

export interface ExtractedAudio {
  buffer: Buffer;
  startPtsMs: number;
}

/**
 * Batch-extract JPEG frames from a video file at given fps.
 * Returns Frame[] sorted by timestamp.
 */
export async function extractFrames(
  videoPath: string,
  fps: number,
  outputDir: string,
  maxDurationSec?: number,
  ffmpegBin = resolveFfmpegBin(),
  ffprobeBin = resolveFfprobeBin(undefined, ffmpegBin),
): Promise<Frame[]> {
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  const maxLongEdge = 1024;
  const frames: Frame[] = [];
  for await (const frame of streamFrames(videoPath, fps, maxDurationSec, maxLongEdge, ffmpegBin, undefined, ffprobeBin)) {
    frames.push({
      data: frame.jpeg.toString("base64"),
      timestamp: frame.timestampMs,
      index: frame.index,
    });
  }
  return frames;
}

/**
 * Extract audio as PCM s16le 16kHz mono buffer from video file.
 * Returns null if video has no audio track.
 */
export async function extractAudio(
  videoPath: string,
  outputPath: string,
  maxDurationSec?: number,
  ffmpegBin = resolveFfmpegBin(),
  ffprobeBin = resolveFfprobeBin(undefined, ffmpegBin),
): Promise<ExtractedAudio | null> {
  try {
    if (existsSync(outputPath)) unlinkSync(outputPath);
    const chunks: Buffer[] = [];
    let firstAudioPtsMs = 0;
    let sawAudio = false;
    const source = new LocalFileMediaSource({
      videoPath,
      fps: 1,
      pacing: "fast",
      fullRate: false,
      maxDurationSec,
      ffmpegBin,
      ffprobeBin,
      onVideoFrame: () => {},
      onAudioChunk: (chunk) => {
        if (!sawAudio) {
          firstAudioPtsMs = chunk.ptsMs;
          sawAudio = true;
        }
        chunks.push(Buffer.from(chunk.pcm));
      },
    });
    await source.start();
    if (chunks.length === 0) return null;
    const audio = Buffer.concat(chunks);
    writeFileSync(outputPath, audio);
    return { buffer: audio, startPtsMs: firstAudioPtsMs };
  } catch (err) {
    const stderr = (err as { stderr?: Buffer })?.stderr?.toString().trim();
    const detail = stderr || (err instanceof Error ? err.message : String(err));
    console.error(`[benchmark] Audio extraction failed for ${videoPath}: ${detail}`);
    if (existsSync(outputPath)) unlinkSync(outputPath);
    return null; // no audio track
  }
}
