// packages/percept/src/analyzers/rtmpose.ts

import type { ModelManager } from "../models/model-manager.js";
import type { BoundingBox } from "@cortex/shared";

/**
 * RTMPose SimCC decoder.
 * Input: person crop (JPEG buffer) + bounding box.
 * Output: 17 COCO keypoints with (x, y, confidence).
 *
 * Preprocessing follows rtmlib exactly:
 *   1. Compute center/scale from bbox (with 1.25 padding)
 *   2. Affine transform to 192x256
 *   3. Normalize with mean/std in pixel space: mean=[123.675,116.28,103.53]
 *
 * SimCC decoding:
 *   - Output: simcc_x (1,17,384), simcc_y (1,17,512)
 *   - Keypoint coord = argmax / simcc_split_ratio (2.0)
 *   - Confidence = min(max_x_logit, max_y_logit) — raw logit, NOT probability
 */

const MODEL_INPUT_W = 192;
const MODEL_INPUT_H = 256;
const SIMCC_SPLIT_RATIO = 2.0;
const MEAN: [number, number, number] = [123.675, 116.28, 103.53];
const STD: [number, number, number] = [58.395, 57.12, 57.375];

export const COCO_KEYPOINT_NAMES = [
  "nose", "left_eye", "right_eye", "left_ear", "right_ear",
  "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
  "left_wrist", "right_wrist", "left_hip", "right_hip",
  "left_knee", "right_knee", "left_ankle", "right_ankle",
] as const;

export interface PoseKeypoint {
  x: number;
  y: number;
  confidence: number;
  name: string;
}

// Dynamic import for sharp (optional dependency)
let sharpFn: any = null;
async function getSharp(): Promise<any> {
  if (sharpFn) return sharpFn;
  const mod = await import("sharp");
  sharpFn = mod.default ?? mod;
  return sharpFn;
}

/**
 * Compute center and scale from a bounding box with padding.
 * Matches rtmlib: bbox_xyxy2cs with padding=1.25.
 */
function bboxToCs(
  bbox: BoundingBox,
  padding = 1.25,
): { center: [number, number]; scale: [number, number] } {
  const x1 = bbox.x;
  const y1 = bbox.y;
  const x2 = bbox.x + bbox.width;
  const y2 = bbox.y + bbox.height;
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const w = (x2 - x1) * padding;
  const h = (y2 - y1) * padding;
  // Maintain aspect ratio matching model input
  const aspect = MODEL_INPUT_W / MODEL_INPUT_H;
  if (w > aspect * h) {
    return { center: [cx, cy], scale: [w, w / aspect] };
  }
  return { center: [cx, cy], scale: [aspect * h, h] };
}

/**
 * Build 2x3 affine matrix for top-down transform.
 * Maps from image space to model input space (forward),
 * and from model input space back to image space (inverse, for coordinate decode).
 */
function getAffineTransform(
  center: [number, number],
  scale: [number, number],
  outputSize: [number, number],
): { forward: Float64Array; inverse: Float64Array } {
  const [cx, cy] = center;
  const [sw, sh] = scale;
  const [ow, oh] = outputSize;

  const scaleX = ow / sw;
  const scaleY = oh / sh;
  const tx = ow / 2 - cx * scaleX;
  const ty = oh / 2 - cy * scaleY;

  const forward = new Float64Array([scaleX, 0, tx, 0, scaleY, ty]);
  const inverse = new Float64Array([1 / scaleX, 0, -tx / scaleX, 0, 1 / scaleY, -ty / scaleY]);

  return { forward, inverse };
}

export class RtmPoseEstimator {
  private modelManager: ModelManager;

  constructor(modelManager: ModelManager) {
    this.modelManager = modelManager;
  }

  /**
   * Estimate pose keypoints for a single person crop.
   *
   * @param imageBuffer - Full frame as JPEG buffer
   * @param bbox - Person bounding box in pixel coordinates
   * @returns Array of 17 COCO keypoints in original image coordinates
   */
  async estimate(imageBuffer: Buffer, bbox: BoundingBox): Promise<PoseKeypoint[]> {
    await this.modelManager.ensureLoaded("rtmpose-s");

    const sharp = await getSharp();
    const meta = await sharp(imageBuffer).metadata();
    const srcW = meta.width!;
    const srcH = meta.height!;

    // Compute center/scale with 1.25 padding
    const { center, scale } = bboxToCs(bbox);
    const { forward, inverse } = getAffineTransform(center, scale, [MODEL_INPUT_W, MODEL_INPUT_H]);

    // Decode full image to raw RGB (explicit sRGB to guarantee 3-channel output)
    const rawBuf = await sharp(imageBuffer).toColourspace("srgb").removeAlpha().raw().toBuffer();
    const srcPixels = new Uint8Array(rawBuf);

    // Apply affine transform: warp image to 192x256
    const warpedPixels = warpAffine(srcPixels, srcW, srcH, forward, MODEL_INPUT_W, MODEL_INPUT_H);

    // Normalize: (pixel - mean) / std, NCHW format
    const size = MODEL_INPUT_W * MODEL_INPUT_H;
    const float32 = new Float32Array(3 * size);
    for (let i = 0; i < size; i++) {
      float32[0 * size + i] = (warpedPixels[i * 3]! - MEAN[0]) / STD[0];
      float32[1 * size + i] = (warpedPixels[i * 3 + 1]! - MEAN[1]) / STD[1];
      float32[2 * size + i] = (warpedPixels[i * 3 + 2]! - MEAN[2]) / STD[2];
    }

    // Run inference
    const tensor = { data: float32, dims: [1, 3, MODEL_INPUT_H, MODEL_INPUT_W] };
    const outputs = await this.modelManager.engine.run("rtmpose-s", { input: tensor });

    // Decode SimCC outputs
    const simccX = outputs["simcc_x"]?.data as Float32Array;
    const simccY = outputs["simcc_y"]?.data as Float32Array;
    if (!simccX || !simccY) throw new Error("RTMPose output missing simcc_x or simcc_y");

    // simcc_x: (1, 17, 384), simcc_y: (1, 17, 512)
    const numKps = 17;
    const xBins = 384;
    const yBins = 512;
    const keypoints: PoseKeypoint[] = [];

    for (let k = 0; k < numKps; k++) {
      let maxXVal = -Infinity, maxXIdx = 0;
      let maxYVal = -Infinity, maxYIdx = 0;

      for (let i = 0; i < xBins; i++) {
        const v = simccX[k * xBins + i]!;
        if (v > maxXVal) { maxXVal = v; maxXIdx = i; }
      }
      for (let i = 0; i < yBins; i++) {
        const v = simccY[k * yBins + i]!;
        if (v > maxYVal) { maxYVal = v; maxYIdx = i; }
      }

      // SimCC coordinate in model input space
      const modelX = maxXIdx / SIMCC_SPLIT_RATIO;
      const modelY = maxYIdx / SIMCC_SPLIT_RATIO;

      // Transform back to original image coordinates
      const origX = inverse[0]! * modelX + inverse[1]! * modelY + inverse[2]!;
      const origY = inverse[3]! * modelX + inverse[4]! * modelY + inverse[5]!;

      // Confidence = min of the two 1D distribution maxima (raw logit, matches rtmlib)
      const confidence = Math.min(maxXVal, maxYVal);

      keypoints.push({
        x: origX,
        y: origY,
        confidence,
        name: COCO_KEYPOINT_NAMES[k],
      });
    }

    return keypoints;
  }
}

/**
 * Affine warp with bilinear interpolation (RGB).
 * Applies a 2x3 forward transform: dst(x,y) = src(M^-1 * [x,y,1]).
 */
function warpAffine(
  srcPixels: Uint8Array,
  srcW: number,
  srcH: number,
  M: Float64Array,
  dstW: number,
  dstH: number,
): Uint8Array {
  const dst = new Uint8Array(dstW * dstH * 3);

  // M is forward transform (src -> dst). We need inverse (dst -> src).
  const a = M[0]!, b = M[1]!, tx = M[2]!;
  const c = M[3]!, d = M[4]!, ty = M[5]!;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-10) return dst;
  const ia = d / det, ib = -b / det;
  const ic = -c / det, id = a / det;
  const itx = -(ia * tx + ib * ty);
  const ity = -(ic * tx + id * ty);

  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      const sx = ia * dx + ib * dy + itx;
      const sy = ic * dx + id * dy + ity;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 + 1 >= srcW || y0 + 1 >= srcH) continue;
      const fx = sx - x0, fy = sy - y0;
      const dstIdx = (dy * dstW + dx) * 3;
      for (let ch = 0; ch < 3; ch++) {
        const v00 = srcPixels[(y0 * srcW + x0) * 3 + ch]!;
        const v01 = srcPixels[(y0 * srcW + x0 + 1) * 3 + ch]!;
        const v10 = srcPixels[((y0 + 1) * srcW + x0) * 3 + ch]!;
        const v11 = srcPixels[((y0 + 1) * srcW + x0 + 1) * 3 + ch]!;
        dst[dstIdx + ch] = Math.round(
          v00 * (1 - fx) * (1 - fy) + v01 * fx * (1 - fy) +
          v10 * (1 - fx) * fy + v11 * fx * fy,
        );
      }
    }
  }
  return dst;
}
