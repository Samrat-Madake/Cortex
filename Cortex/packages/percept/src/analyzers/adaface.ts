// packages/percept/src/analyzers/adaface.ts
//
// ArcFace MobileFaceNet W600K face ReID model.
// Preprocessing follows common InsightFace/ArcFace reference conventions.
//
// Official parameters:
//   - Input: RGB, 112×112, normalize (pixel - 127.5) / 127.5
//   - Alignment: ARCFACE_DST template (5-point similarity transform)
//   - Output: 512d, needs L2 normalization
//   - Threshold: ~0.4 cosine (InsightFace/DeepFace standard)
//   - No flip test needed
//   - Dynamic batch supported

import type { ModelManager } from "../models/model-manager.js";
import type { BoundingBox } from "@cortex/shared";

// Dynamic import for sharp (optional dependency)
let sharpFn: any = null;
async function getSharp(): Promise<any> {
  if (sharpFn) return sharpFn;
  const mod = await import("sharp");
  sharpFn = mod.default ?? mod;
  return sharpFn;
}

/** L2-normalize an embedding vector. */
export function normalizeEmbedding(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i]! * vec[i]!;
  norm = Math.sqrt(norm);
  if (norm < 1e-10) return vec;
  const result = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) result[i] = vec[i]! / norm;
  return result;
}

// ── InsightFace ARCFACE_DST alignment template (112×112) ──
// Standard 5-point reference for ArcFace models.
// src1 + 8.0 on x-axis (centered in 112×112 canvas).
const ARCFACE_DST: [number, number][] = [
  [38.2946, 51.6963],  // left eye
  [73.5318, 51.5014],  // right eye
  [56.0252, 71.7366],  // nose tip
  [41.5493, 92.3655],  // left mouth corner
  [70.7299, 92.2041],  // right mouth corner
];

/**
 * Compute 2×3 similarity transform matrix from source landmarks to ARCFACE_DST.
 *
 * Uses least-squares estimation of [scale*cos, -scale*sin, tx; scale*sin, scale*cos, ty].
 * Pure TypeScript — no dependency on skimage or OpenCV.
 */
export function estimateSimilarityTransform(
  src: Array<{ x: number; y: number }>,
): Float64Array | null {
  if (src.length !== 5) return null;

  const dst = ARCFACE_DST;
  const n = 5;

  // Build linear system: for each point pair (sx,sy) → (dx,dy):
  //   dx = a*sx - b*sy + tx
  //   dy = b*sx + a*sy + ty
  // where a = scale*cos(θ), b = scale*sin(θ)
  // 4 unknowns: a, b, tx, ty
  // 2n equations → solve via normal equations

  let sx2 = 0, sxy = 0, sx = 0, sy = 0;
  let dxsx = 0, dxsy = 0, dysx = 0, dysy = 0;
  let dx_sum = 0, dy_sum = 0, sx_sum = 0, sy_sum = 0;

  for (let i = 0; i < n; i++) {
    const sxi = src[i]!.x, syi = src[i]!.y;
    const dxi = dst[i]![0], dyi = dst[i]![1];

    sx2 += sxi * sxi + syi * syi;
    sx_sum += sxi;
    sy_sum += syi;
    dx_sum += dxi;
    dy_sum += dyi;
    dxsx += dxi * sxi + dyi * syi;
    dxsy += dxi * syi - dyi * sxi;
  }

  // Solve 4x4 system:
  // [sx2,   0, sx_sum, sy_sum] [a ]   [dxsx  ]
  // [  0, sx2, -sy_sum, sx_sum] [b ]   [dxsy  ]  (negated for this formulation)
  // Actually, use the closed-form for similarity transform:
  // a = (sum(dx*sx + dy*sy)) / (sum(sx^2 + sy^2))  ... simplified when tx,ty are separated

  // More robust: solve via pseudoinverse of design matrix
  // A = [[sx, -sy, 1, 0], [sy, sx, 0, 1], ...] for each point
  // b = [dx, dy, ...]
  const A: number[][] = [];
  const B: number[] = [];
  for (let i = 0; i < n; i++) {
    const sxi = src[i]!.x, syi = src[i]!.y;
    const dxi = dst[i]![0], dyi = dst[i]![1];
    A.push([sxi, -syi, 1, 0]);
    B.push(dxi);
    A.push([syi, sxi, 0, 1]);
    B.push(dyi);
  }

  // Solve A^T A x = A^T b (4×4 normal equations)
  const ATA = Array.from({ length: 4 }, () => new Float64Array(4));
  const ATb = new Float64Array(4);

  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 2 * n; k++) s += A[k]![i]! * A[k]![j]!;
      ATA[i]![j] = s;
    }
    let s = 0;
    for (let k = 0; k < 2 * n; k++) s += A[k]![i]! * B[k]!;
    ATb[i] = s;
  }

  // Gaussian elimination with partial pivoting
  const aug = ATA.map((row, i) => [...row, ATb[i]!]);
  for (let col = 0; col < 4; col++) {
    let maxRow = col;
    for (let row = col + 1; row < 4; row++) {
      if (Math.abs(aug[row]![col]!) > Math.abs(aug[maxRow]![col]!)) maxRow = row;
    }
    [aug[col], aug[maxRow]] = [aug[maxRow]!, aug[col]!];
    if (Math.abs(aug[col]![col]!) < 1e-10) return null;
    const pivot = aug[col]![col]!;
    for (let j = col; j <= 4; j++) aug[col]![j]! /= pivot;
    for (let row = 0; row < 4; row++) {
      if (row === col) continue;
      const factor = aug[row]![col]!;
      for (let j = col; j <= 4; j++) aug[row]![j]! -= factor * aug[col]![j]!;
    }
  }

  const a = aug[0]![4]!, b = aug[1]![4]!, tx = aug[2]![4]!, ty = aug[3]![4]!;

  // Return 2×3 affine matrix [a, -b, tx; b, a, ty]
  return new Float64Array([a, -b, tx, b, a, ty]);
}

/**
 * Apply 2×3 affine warp to produce 112×112 aligned face image.
 * Pure TypeScript bilinear interpolation — replaces cv2.warpAffine.
 *
 * Input: RGB raw pixels (sharp output). Output: RGB Uint8Array 112×112.
 */
export function warpAffine(
  srcPixels: Uint8Array, srcW: number, srcH: number,
  M: Float64Array, dstSize: number,
): Uint8Array {
  const dst = new Uint8Array(dstSize * dstSize * 3);

  // Invert the affine matrix to map dst→src
  const a = M[0]!, b = M[1]!, tx = M[2]!;
  const c = M[3]!, d = M[4]!, ty = M[5]!;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-10) return dst;
  const invA = d / det, invB = -b / det;
  const invC = -c / det, invD = a / det;
  const invTx = -(invA * tx + invB * ty);
  const invTy = -(invC * tx + invD * ty);

  for (let dy = 0; dy < dstSize; dy++) {
    for (let dx = 0; dx < dstSize; dx++) {
      const sx = invA * dx + invB * dy + invTx;
      const sy = invC * dx + invD * dy + invTy;

      // Bilinear interpolation
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const x1 = x0 + 1, y1 = y0 + 1;
      const fx = sx - x0, fy = sy - y0;

      if (x0 < 0 || y0 < 0 || x1 >= srcW || y1 >= srcH) continue;

      const dstIdx = (dy * dstSize + dx) * 3;
      for (let ch = 0; ch < 3; ch++) {
        const v00 = srcPixels[(y0 * srcW + x0) * 3 + ch]!;
        const v01 = srcPixels[(y0 * srcW + x1) * 3 + ch]!;
        const v10 = srcPixels[(y1 * srcW + x0) * 3 + ch]!;
        const v11 = srcPixels[(y1 * srcW + x1) * 3 + ch]!;
        const val = v00 * (1 - fx) * (1 - fy) + v01 * fx * (1 - fy) +
                    v10 * (1 - fx) * fy + v11 * fx * fy;
        dst[dstIdx + ch] = Math.round(Math.max(0, Math.min(255, val)));
      }
    }
  }
  return dst;
}

/**
 * ArcFace MobileFaceNet W600K face ReID extractor.
 *
 * ArcFace-compatible model. Preprocessing follows common InsightFace conventions.
 */
export class AdaFaceExtractor {
  private modelManager: ModelManager;

  static readonly CROP_SIZE = 112;
  static readonly EMBED_DIM = 512;
  /** Minimum face crop size in pixels. */
  static readonly MIN_CROP_SIZE = 32;

  constructor(modelManager: ModelManager) {
    this.modelManager = modelManager;
  }

  /**
   * Extract face embedding from a frame using landmark-based alignment.
   *
   * @param frameBase64 - Full frame as base64 JPEG
   * @param faceBbox - Face bounding box (used as fallback if no landmarks)
   * @param landmarks - 5-point facial landmarks from RetinaFace (used for alignment)
   * @returns 512d L2-normalized embedding, or null if face too small
   */
  async extract(
    frameBase64: string,
    faceBbox: BoundingBox,
    landmarks?: Array<{ x: number; y: number }>,
  ): Promise<Float32Array | null> {
    if (faceBbox.width < AdaFaceExtractor.MIN_CROP_SIZE || faceBbox.height < AdaFaceExtractor.MIN_CROP_SIZE) {
      return null;
    }

    await this.modelManager.ensureLoaded("arcface-mbf");

    const sharp = await getSharp();
    const SZ = AdaFaceExtractor.CROP_SIZE;

    // Decode full frame
    const buf = Buffer.from(frameBase64, "base64");
    const meta = await sharp(buf).metadata();
    const srcW = meta.width!;
    const srcH = meta.height!;
    const rawBuf = await sharp(buf).removeAlpha().raw().toBuffer();
    const srcPixels = new Uint8Array(rawBuf); // RGB

    let alignedPixels: Uint8Array;

    if (landmarks && landmarks.length === 5) {
      // Landmark-based alignment (InsightFace standard)
      const M = estimateSimilarityTransform(landmarks);
      if (M) {
        alignedPixels = warpAffine(srcPixels, srcW, srcH, M, SZ);
      } else {
        // Fallback: crop + resize
        alignedPixels = await this.cropAndResizeFallback(sharp, buf, faceBbox, SZ);
      }
    } else {
      // No landmarks: crop + resize fallback
      alignedPixels = await this.cropAndResizeFallback(sharp, buf, faceBbox, SZ);
    }

    // Normalize: (pixel - 127.5) / 127.5, RGB order (InsightFace standard)
    const size = SZ * SZ;
    const float32 = new Float32Array(3 * size);
    for (let i = 0; i < size; i++) {
      float32[0 * size + i] = (alignedPixels[i * 3]! - 127.5) / 127.5;     // R
      float32[1 * size + i] = (alignedPixels[i * 3 + 1]! - 127.5) / 127.5; // G
      float32[2 * size + i] = (alignedPixels[i * 3 + 2]! - 127.5) / 127.5; // B
    }

    // Run inference (dynamic batch, use batch=1)
    const tensor = { data: float32, dims: [1, 3, SZ, SZ] };
    const outputs = await this.modelManager.engine.run("arcface-mbf", { "input.1": tensor });
    const embeddingTensor = outputs["516"] ?? Object.values(outputs)[0];
    if (!embeddingTensor) throw new Error("ArcFace output missing embedding tensor");

    const raw = new Float32Array((embeddingTensor.data as Float32Array).subarray(0, AdaFaceExtractor.EMBED_DIM));
    return normalizeEmbedding(raw);
  }

  /** Fallback: simple crop + resize when landmarks are not available. */
  private async cropAndResizeFallback(
    sharp: any, buf: Buffer, bbox: BoundingBox, size: number,
  ): Promise<Uint8Array> {
    const raw = await sharp(buf)
      .removeAlpha()
      .extract({ left: Math.round(bbox.x), top: Math.round(bbox.y), width: Math.round(bbox.width), height: Math.round(bbox.height) })
      .resize(size, size, { fit: "fill" })
      .raw()
      .toBuffer();
    return new Uint8Array(raw);
  }
}
