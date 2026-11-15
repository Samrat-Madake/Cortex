import { writeStderr, type MediaUrls, type Segment } from "@cortex/shared";
import { MediaUploader } from "../media-uploader.js";

const ANIMATED_PREVIEW_FRAME_DELAY_MS = 200;

function looksLikeEncodedImage(data: string): boolean {
  const trimmed = data.trim();
  const payload = trimmed.startsWith("data:") ? trimmed.slice(trimmed.indexOf(",") + 1) : trimmed;
  return payload.startsWith("/9j/")
    || payload.startsWith("iVBOR")
    || payload.startsWith("UklGR");
}

export async function buildAnimatedSegmentPreviewBuffer(
  frames: Segment["frames"],
): Promise<Buffer | undefined> {
  if (frames.length < 2 || !frames.some((frame) => looksLikeEncodedImage(frame.data))) {
    return undefined;
  }

  const sharp = (await import("sharp")).default;
  const targetWidth = 320;
  const resizedFrames: Buffer[] = [];
  let frameWidth = targetWidth;
  let frameHeight = 0;

  for (const frame of frames) {
    if (!looksLikeEncodedImage(frame.data)) continue;
    const resized = await sharp(Buffer.from(frame.data, "base64"))
      .resize({ width: targetWidth, withoutEnlargement: true })
      .webp({ quality: 60 })
      .toBuffer();
    if (frameHeight === 0) {
      const meta = await sharp(resized).metadata();
      frameHeight = meta.height ?? Math.round(targetWidth * 9 / 16);
      frameWidth = meta.width ?? targetWidth;
    }
    resizedFrames.push(resized);
  }

  if (resizedFrames.length < 2 || frameHeight <= 0) return undefined;

  return sharp({
    create: {
      width: frameWidth,
      height: frameHeight * resizedFrames.length,
      channels: 4 as const,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      pageHeight: frameHeight,
    },
  }).composite(
    resizedFrames.map((buf, index) => ({
      input: buf,
      top: index * frameHeight,
      left: 0,
    })),
  ).webp({
    quality: 60,
    loop: 0,
    delay: Array(resizedFrames.length).fill(ANIMATED_PREVIEW_FRAME_DELAY_MS) as number[],
  }).toBuffer();
}

export interface SegmentMediaResult {
  segmentKeyframePaths: string[];
  selectedSegmentKeyframeIndex?: number;
  gifPath?: string;
  analysisMedia: MediaUrls;
}

export async function saveSegmentMedia(input: {
  segment: Segment;
  mediaUploader: MediaUploader;
  bestFrameIndex?: number;
  animatedPreview?: boolean;
}): Promise<SegmentMediaResult> {
  const { segment, mediaUploader } = input;

  const segmentKeyframePaths: string[] = [];
  let selectedSegmentKeyframeIndex: number | undefined;
  if (segment.frames.length > 0) {
    const bestFrameIdx = input.bestFrameIndex;
    const frameIdx = bestFrameIdx != null && bestFrameIdx >= 0 && bestFrameIdx < segment.frames.length
      ? bestFrameIdx
      : Math.floor(segment.frames.length / 2);
    selectedSegmentKeyframeIndex = frameIdx;
    const bestFrame = segment.frames[frameIdx]!;
    try {
      const buf = Buffer.from(bestFrame.data, "base64");
      const path = mediaUploader.saveKeyframe(segment.camera_id, segment.segment_id, frameIdx, buf);
      segmentKeyframePaths.push(path);
    } catch {
      // Non-fatal: continue without keyframe path.
    }
  }

  let gifPath: string | undefined;
  if (input.animatedPreview === true) {
    try {
      const animatedBuf = await buildAnimatedSegmentPreviewBuffer(segment.frames);
      if (animatedBuf) {
        gifPath = mediaUploader.saveGif(segment.camera_id, segment.segment_id, animatedBuf);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeStderr(`[perception] animated preview generation failed: ${msg}`);
    }
  }

  return {
    segmentKeyframePaths,
    selectedSegmentKeyframeIndex,
    gifPath,
    analysisMedia: MediaUploader.buildMediaUrls({
      rawPath: segment.raw_url,
      gifPath,
      keyframePaths: segmentKeyframePaths,
      cropPaths: [],
    }),
  };
}
