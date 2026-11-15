// packages/percept/src/crop-utils.ts
// Utility for extracting and downscaling bbox crops from keyframe images.

import type { BoundingBox } from "@cortex/shared";

/** Target short edge for anonymous subject thumbnails. */
const ANON_CROP_SHORT_EDGE = 128;

/**
 * Crop a bbox region from a JPEG buffer and downscale to thumbnail size.
 * Returns a JPEG Buffer ready for disk storage.
 *
 * Uses sharp (already a project dependency via keyframe/media pipeline).
 */
export async function extractCrop(
  imageBuffer: Buffer,
  bbox: BoundingBox,
  shortEdge: number = ANON_CROP_SHORT_EDGE,
): Promise<Buffer> {
  const sharp = (await import("sharp")).default;

  const meta = await sharp(imageBuffer).metadata();
  const imgW = meta.width ?? 1;
  const imgH = meta.height ?? 1;

  // Clamp bbox to image bounds — handle fully out-of-bounds gracefully
  const left = Math.min(Math.max(0, Math.round(bbox.x)), imgW - 1);
  const top = Math.min(Math.max(0, Math.round(bbox.y)), imgH - 1);
  const right = Math.min(imgW, Math.max(left + 1, Math.round(bbox.x + bbox.width)));
  const bottom = Math.min(imgH, Math.max(top + 1, Math.round(bbox.y + bbox.height)));
  const width = right - left;
  const height = bottom - top;

  let pipeline = sharp(imageBuffer).extract({ left, top, width, height });

  // Downscale so the short edge = shortEdge (preserve aspect ratio)
  const cropShort = Math.min(width, height);
  if (cropShort > shortEdge) {
    const scale = shortEdge / cropShort;
    pipeline = pipeline.resize(
      Math.max(1, Math.round(width * scale)),
      Math.max(1, Math.round(height * scale)),
    );
  }

  return pipeline.jpeg({ quality: 80 }).toBuffer();
}
