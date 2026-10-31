// Keyframe quality assessment for faces and entities.
// Ported from the reference keyframe selector — all thresholds
// and scoring weights match the Python reference exactly.

// ── Config interfaces ──

import { writeStderr } from "@reflectworld/shared";

export interface FaceQualityConfig {
  minDetectionConfidence: number;
  minLaplacianVariance: number;
  minFacePixelArea: number;
  minLandmarkScore: number;
  allowedFaceAspectRatioRange: [number, number];
}

export interface EntityQualityConfig {
  minAreaRatio: number;
  minDetectionConfidence: number;
}

export interface QualityConfig {
  min_face_detection_confidence?: number;
  min_laplacian_variance?: number;
  min_face_pixel_area?: number;
  min_landmark_score?: number;
  face_aspect_ratio_range?: [number, number];
  min_entity_area_ratio?: number;
  min_entity_detection_confidence?: number;
}

export function defaultFaceQualityConfig(cfg?: QualityConfig): FaceQualityConfig {
  return {
    minDetectionConfidence: cfg?.min_face_detection_confidence ?? 0.97,
    minLaplacianVariance: cfg?.min_laplacian_variance ?? 100.0,
    minFacePixelArea: cfg?.min_face_pixel_area ?? 10000,
    minLandmarkScore: cfg?.min_landmark_score ?? 0.50,
    allowedFaceAspectRatioRange: cfg?.face_aspect_ratio_range ?? [0.55, 1.0],
  };
}

export function defaultEntityQualityConfig(cfg?: QualityConfig): EntityQualityConfig {
  return {
    minAreaRatio: cfg?.min_entity_area_ratio ?? 0.01,
    minDetectionConfidence: cfg?.min_entity_detection_confidence ?? 0.85,
  };
}

// ── Result types ──

export interface FaceQualityResult {
  detConf: number;
  blurVar: number;
  area: number;
  areaRatio: number;
  faceRatio: number;
  landmarkScore: number;
  gatePass: boolean;
}

export interface EntityQualityResult {
  width: number;
  height: number;
  area: number;
  frameArea: number;
  areaRatio: number;
  detConf: number;
  gatePass: boolean;
}

// ── Math helpers ──

function norm2(dx: number, dy: number): number {
  return Math.sqrt(dx * dx + dy * dy);
}

function clamp01(v: number): number {
  return Math.max(0.0, Math.min(1.0, v));
}

// ── 5-point landmark template (AdaFace for 112x112) ──

const LANDMARK_TEMPLATE: ReadonlyArray<[number, number]> = [
  [30.2946, 51.6963], // left eye
  [65.5318, 51.5014], // right eye
  [48.0252, 71.7366], // nose tip
  [33.5493, 92.3655], // left mouth corner
  [62.7299, 92.2041], // right mouth corner
];

// ── Similarity transform estimation (pure math, no OpenCV) ──

/**
 * Estimate a 2D similarity transform (rotation + uniform scale + translation)
 * from N>=2 point pairs via least squares.
 *
 * Returns a 2x3 affine matrix [[a, -b, tx], [b, a, ty]] or null on failure.
 */
export function estimateSimilarityTransform(
  src: ReadonlyArray<[number, number]>,
  dst: ReadonlyArray<[number, number]>,
): [number, number, number, number, number, number] | null {
  const n = src.length;
  if (n < 2 || n !== dst.length) return null;

  // Build normal equations for similarity transform:
  //   dst_x = a * src_x - b * src_y + tx
  //   dst_y = b * src_x + a * src_y + ty
  // Unknowns: a, b, tx, ty
  // Normal equations via ATA x = ATb (4x4 system)

  let sxsx = 0,
    sxsy = 0,
    sx = 0,
    sy = 0;
  let sxdx = 0,
    sxdy = 0,
    sydx = 0,
    sydy = 0;
  let dx = 0,
    dy = 0;

  for (let i = 0; i < n; i++) {
    const [sx_i, sy_i] = src[i];
    const [dx_i, dy_i] = dst[i];
    sxsx += sx_i * sx_i + sy_i * sy_i;
    sxsy += sx_i * sy_i - sy_i * sx_i; // always 0 for this formulation
    sx += sx_i;
    sy += sy_i;
    sxdx += sx_i * dx_i + sy_i * dy_i;
    sxdy += -sy_i * dx_i + sx_i * dy_i;
    sydx += sx_i * dy_i - sy_i * dx_i; // same as sxdy
    sydy += sy_i * dy_i + sx_i * dx_i; // same as sxdx
    dx += dx_i;
    dy += dy_i;
  }

  // Solve via Cramer's rule for the simplified system:
  //   [sxsx, 0,  sx, -sy] [a ]   [sxdx]
  //   [0,  sxsx, sy,  sx] [b ] = [sxdy]
  //   [sx,  sy,   n,   0] [tx]   [dx  ]
  //   [-sy, sx,   0,   n] [ty]   [dy  ]
  //
  // Simplify: let S = sxsx, U = sx, V = sy, D = n
  const S = sxsx;
  const U = sx;
  const V = sy;
  const D = n;
  const r0 = sxdx;
  const r1 = sxdy;
  const r2 = dx;
  const r3 = dy;

  // Solve 4x4 via block elimination
  // From rows 3,4: tx = (r2 - U*a - V*b) / D, ty = (r3 + V*a - U*b) / D
  // Substitute into rows 1,2:
  //   S*a + U*(r2 - U*a - V*b)/D - V*(r3 + V*a - U*b)/D - ... nah,
  //   let's just do the 2x2 reduced system for a,b.

  // From row 1: S*a - V*ty + U*tx = r0
  //             S*a + U*tx - V*ty = r0
  // From row 2: S*b + V*tx + U*ty = r1 (swapped sign convention)
  //             S*b + V*tx + U*ty = r1  ... let me redo carefully.

  // The system is:
  //   S*a       + U*tx - V*ty = r0   (1)
  //       S*b   + V*tx + U*ty = r1   (2)
  //   U*a + V*b + D*tx        = r2   (3)
  //  -V*a + U*b        + D*ty = r3   (4)

  // From (3): tx = (r2 - U*a - V*b) / D
  // From (4): ty = (r3 + V*a - U*b) / D
  // Sub into (1):
  //   S*a + U*(r2 - U*a - V*b)/D - V*(r3 + V*a - U*b)/D = r0
  //   S*a + (U*r2 - U^2*a - U*V*b)/D - (V*r3 + V^2*a - U*V*b)/D = r0
  //   S*a + (U*r2 - U^2*a - V*r3 - V^2*a)/D = r0
  //   S*a + (U*r2 - V*r3)/D - (U^2 + V^2)*a/D = r0
  //   a*(S - (U^2 + V^2)/D) = r0 - (U*r2 - V*r3)/D

  const UVsq = U * U + V * V;
  const denom_a = S - UVsq / D;
  if (Math.abs(denom_a) < 1e-12) return null;

  const a = (r0 - (U * r2 - V * r3) / D) / denom_a;

  // Sub into (2):
  //   S*b + V*(r2 - U*a - V*b)/D + U*(r3 + V*a - U*b)/D = r1
  //   S*b + (V*r2 - U*V*a - V^2*b + U*r3 + U*V*a - U^2*b)/D = r1
  //   S*b + (V*r2 + U*r3)/D - (U^2 + V^2)*b/D = r1
  //   b*(S - UVsq/D) = r1 - (V*r2 + U*r3)/D
  const b = (r1 - (V * r2 + U * r3) / D) / denom_a;

  const tx = (r2 - U * a - V * b) / D;
  const ty = (r3 + V * a - U * b) / D;

  return [a, -b, tx, b, a, ty];
}

/**
 * Apply a 2x3 affine matrix to a 2D point.
 */
function applyAffine(
  m: [number, number, number, number, number, number],
  x: number,
  y: number,
): [number, number] {
  return [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];
}

// ── Laplacian variance (blur metric) ──

/**
 * Compute Laplacian variance from a grayscale Uint8 buffer.
 *
 * Uses a 3x3 Laplacian kernel:
 *   [0, 1, 0]
 *   [1,-4, 1]
 *   [0, 1, 0]
 *
 * This is a pure-JS fallback; callers can substitute a sharp-based
 * implementation for better perf on large images.
 */
export function laplacianVariance(
  gray: Uint8Array,
  width: number,
  height: number,
): number {
  if (width < 3 || height < 3) return 0.0;

  let sum = 0;
  let sumSq = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      const lap =
        gray[idx - width] +
        gray[idx - 1] +
        gray[idx + 1] +
        gray[idx + width] -
        4 * gray[idx];
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }

  if (count === 0) return 0.0;
  const mean = sum / count;
  return sumSq / count - mean * mean;
}

// ── Landmark scoring ──

/**
 * Compute landmark-based front-facing score.
 * Weights: 0.40 * S_align + 0.25 * S_pose + 0.20 * S_sym + 0.15 * S_size
 *
 * @param kps5 Five 2D landmark points [[x,y], ...] in image coordinates.
 */
export function computeLandmarkScore(
  kps5: ReadonlyArray<[number, number]>,
): number {
  if (kps5.length !== 5) return 0.0;

  try {
    const dst = LANDMARK_TEMPLATE;

    // Estimate similarity transform src→dst
    const M = estimateSimilarityTransform(kps5, dst);

    // Aligned points (use transform if available, else raw)
    const aligned: Array<[number, number]> = kps5.map((p) =>
      M ? applyAffine(M, p[0], p[1]) : [p[0], p[1]],
    );

    // Alignment fit: RMS to template
    let sumSqDist = 0;
    for (let i = 0; i < 5; i++) {
      const dx = aligned[i][0] - dst[i][0];
      const dy = aligned[i][1] - dst[i][1];
      sumSqDist += dx * dx + dy * dy;
    }
    const rms = Math.sqrt(sumSqDist / 5);
    const sAlign = clamp01(1.0 - rms / 10.0);

    // Pose & symmetry in aligned space
    const [Lx, Ly] = aligned[0]; // left eye
    const [Rx, Ry] = aligned[1]; // right eye
    const [Nx, Ny] = aligned[2]; // nose
    const [MLx, MLy] = aligned[3]; // left mouth
    const [MRx, MRy] = aligned[4]; // right mouth

    const IOD = Math.max(norm2(Rx - Lx, Ry - Ly), 1e-6);

    // Roll from eye line
    const roll = Math.atan2(Ry - Ly, Rx - Lx);
    const rollScale = (15.0 * Math.PI) / 180.0;
    const scoreRoll = Math.exp(-((Math.abs(roll) / rollScale) ** 2));

    // Yaw proxy: nose-to-eyes imbalance
    const dNR = norm2(Nx - Rx, Ny - Ry);
    const dNL = norm2(Nx - Lx, Ny - Ly);
    const yawProxy = (dNR - dNL) / IOD;
    const scoreYaw = Math.exp(-((Math.abs(yawProxy) / 0.25) ** 2));

    // Pitch proxy: mouth-eye vertical ratio vs template
    const yEyeBar = (Ly + Ry) / 2.0;
    const yMouthBar = (MLy + MRy) / 2.0;
    const iodTpl = norm2(
      dst[1][0] - dst[0][0],
      dst[1][1] - dst[0][1],
    );
    const rRef =
      ((dst[3][1] + dst[4][1]) / 2.0 - (dst[0][1] + dst[1][1]) / 2.0) /
      Math.max(iodTpl, 1e-6);
    const pitchProxy = (yMouthBar - yEyeBar) / IOD - rRef;
    const scorePitch = Math.exp(-((Math.abs(pitchProxy) / 0.15) ** 2));

    const sPose = Math.min(scoreRoll, scoreYaw, scorePitch);

    // Symmetry by horizontal reflection around mid-eye x
    const xMid = (Lx + Rx) / 2.0;
    const deltaEye = Math.abs(Lx - (2.0 * xMid - Rx)) / IOD;
    const deltaMouth = Math.abs(MLx - (2.0 * xMid - MRx)) / IOD;
    const sSym = clamp01(1.0 - (deltaEye + deltaMouth) / 2.0);

    // Size proxy: IOD / face width (from raw landmarks, not aligned)
    let xMin = Infinity,
      xMax = -Infinity;
    for (const [px] of kps5) {
      if (px < xMin) xMin = px;
      if (px > xMax) xMax = px;
    }
    const widthRaw = Math.max(xMax - xMin, 1e-6);
    const ratio = norm2(kps5[1][0] - kps5[0][0], kps5[1][1] - kps5[0][1]) / widthRaw;
    const t0 = 0.18,
      t1 = 0.35;
    const sSize = clamp01((ratio - t0) / Math.max(t1 - t0, 1e-6));

    // Weighted final score
    const landmarkScore =
      0.40 * sAlign + 0.25 * sPose + 0.20 * sSym + 0.15 * sSize;
    return clamp01(landmarkScore);
  } catch {
    return 0.0;
  }
}

// ── QualityAssessor ──

export class QualityAssessor {
  readonly faceCfg: FaceQualityConfig;
  readonly entityCfg: EntityQualityConfig;

  constructor(config?: QualityConfig) {
    this.faceCfg = defaultFaceQualityConfig(config);
    this.entityCfg = defaultEntityQualityConfig(config);
  }

  /**
   * Evaluate face quality. All gate thresholds match the Python reference.
   *
   * @param faceWidth  Face crop width in pixels.
   * @param faceHeight Face crop height in pixels.
   * @param detConf    Detection confidence.
   * @param blurVar    Laplacian variance of the face crop (caller computes).
   * @param landmarks5 Optional 5-point landmarks as [[x,y], ...].
   * @param frameWidth Full frame width (for area ratio; 0 to skip).
   * @param frameHeight Full frame height.
   */
  evaluateFace(
    faceWidth: number,
    faceHeight: number,
    detConf: number,
    blurVar: number,
    landmarks5?: ReadonlyArray<[number, number]>,
    frameWidth?: number,
    frameHeight?: number,
  ): FaceQualityResult {
    try {
      const area = Math.max(0, faceWidth * faceHeight);
      const faceRatio = Math.min(faceWidth, faceHeight) / Math.max(Math.max(faceWidth, faceHeight), 1.0);

      const fW = frameWidth ?? 0;
      const fH = frameHeight ?? 0;
      const frameArea = Math.max(0, fW * fH);
      const areaRatio = frameArea > 0 ? area / frameArea : 0.0;

      // Landmark score
      let lmkScore = -1.0;
      if (landmarks5 && landmarks5.length === 5) {
        lmkScore = computeLandmarkScore(landmarks5);
      }

      // Gate checks — identical to Python
      const confOk = detConf >= this.faceCfg.minDetectionConfidence;
      const areaOk = area >= this.faceCfg.minFacePixelArea;
      const blurOk = blurVar >= this.faceCfg.minLaplacianVariance;
      const [lo, hi] = this.faceCfg.allowedFaceAspectRatioRange;
      const ratioOk = faceRatio >= lo && faceRatio <= hi;
      const lmkOk = lmkScore >= this.faceCfg.minLandmarkScore;
      const gatePass = confOk && areaOk && blurOk && ratioOk && lmkOk;

      return {
        detConf,
        blurVar,
        area,
        areaRatio,
        faceRatio,
        landmarkScore: lmkScore,
        gatePass,
      };
    } catch (err) {
      writeStderr("[keyframe] Face quality evaluation failed:", err);
      return {
        detConf,
        blurVar: 0.0,
        area: 0.0,
        areaRatio: 0.0,
        faceRatio: 0.0,
        landmarkScore: -1.0,
        gatePass: false,
      };
    }
  }

  /**
   * Evaluate entity quality.
   *
   * @param entityWidth  Entity crop width in pixels.
   * @param entityHeight Entity crop height in pixels.
   * @param frameWidth   Full frame width.
   * @param frameHeight  Full frame height.
   * @param detConf      Detection confidence.
   */
  evaluateEntity(
    entityWidth: number,
    entityHeight: number,
    frameWidth: number,
    frameHeight: number,
    detConf: number,
  ): EntityQualityResult {
    try {
      const area = Math.max(0, entityWidth * entityHeight);
      const frameArea = Math.max(0, frameWidth * frameHeight);
      const areaRatio = frameArea > 0 ? area / frameArea : 0.0;

      const areaOk = areaRatio >= this.entityCfg.minAreaRatio;
      const confOk = detConf >= this.entityCfg.minDetectionConfidence;
      const gatePass = areaOk && confOk;

      return { width: entityWidth, height: entityHeight, area, frameArea, areaRatio, detConf, gatePass };
    } catch (err) {
      writeStderr("[keyframe] Entity quality evaluation failed:", err);
      return {
        width: 0, height: 0, area: 0,
        frameArea: 0, areaRatio: 0, detConf, gatePass: false,
      };
    }
  }
}
