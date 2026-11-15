// eval/benchmark/pipeline/frame-stream.ts
// Streaming frame extractor — yields JPEG frames one at a time from the unified
// local-file media source. No disk I/O, no batch memory accumulation.

import { LocalFileMediaSource, resolveFfmpegBin, resolveFfprobeBin } from "@cortex/cam";

export interface StreamFrame {
  /** JPEG image buffer (NOT base64). */
  jpeg: Buffer;
  /** Frame index (0-based, at source emission order). */
  index: number;
  /** Real media timestamp in ms on the video-normalized timeline. */
  timestampMs: number;
}

/**
 * Stream JPEG frames from a video file via ffmpeg image2pipe.
 * Yields frames one at a time as an async iterator.
 *
 * @param videoPath - Path to video file
 * @param fps - Extraction frame rate
 * @param maxDurationSec - Optional duration cap
 * @param maxLongEdge - Max long edge for downscale (default 1024)
 * @param maxShortEdge - Optional max short edge for auxiliary benchmark frame sources
 */
export async function* streamFrames(
  videoPath: string,
  fps: number,
  maxDurationSec?: number,
  maxLongEdge = 1024,
  ffmpegBin = resolveFfmpegBin(),
  maxShortEdge?: number,
  ffprobeBin = resolveFfprobeBin(undefined, ffmpegBin),
): AsyncGenerator<StreamFrame> {
  let frameIndex = 0;
  const frameQueue: Array<{ frame: StreamFrame; ack: () => void }> = [];
  const pendingAcks = new Set<() => void>();
  let resolveFrame: (() => void) | null = null;
  let rejectFrame: ((err: Error) => void) | null = null;
  let streamDone = false;
  let streamError: Error | null = null;

  const notifyFrame = () => {
    if (resolveFrame) {
      resolveFrame();
      resolveFrame = null;
      rejectFrame = null;
    }
  };

  const failStream = (err: Error) => {
    if (!streamError) {
      streamError = err;
      streamDone = true;
    }
    if (rejectFrame) {
      rejectFrame(err);
      resolveFrame = null;
      rejectFrame = null;
    } else {
      notifyFrame();
    }
  };

  const source = new LocalFileMediaSource({
    videoPath,
    fps,
    pacing: "fast",
    fullRate: false,
    maxDurationSec,
    maxLongEdge,
    maxShortEdge,
    ffmpegBin,
    ffprobeBin,
    onVideoFrame: (frame) => new Promise<void>((resolve) => {
      const ack = () => {
        pendingAcks.delete(ack);
        resolve();
      };
      pendingAcks.add(ack);
      frameQueue.push({
        frame: { jpeg: Buffer.from(frame.jpeg), index: frameIndex++, timestampMs: frame.ptsMs },
        ack,
      });
      notifyFrame();
    }),
  });
  void source.start()
    .then(() => {
      streamDone = true;
      notifyFrame();
    })
    .catch((err) => {
      failStream(err instanceof Error ? err : new Error(String(err)));
    });

  try {
    // Yield frames as they arrive
    while (true) {
      if (streamError) throw streamError;
      if (frameQueue.length > 0) {
        const next = frameQueue.shift()!;
        try {
          yield next.frame;
        } finally {
          next.ack();
        }
      } else if (streamDone) {
        break;
      } else {
        // Wait for next frame
        await new Promise<void>((resolve, reject) => {
          resolveFrame = resolve;
          rejectFrame = reject;
        });
      }
    }
  } finally {
    source.close();
    for (const ack of Array.from(pendingAcks)) ack();
  }
}
