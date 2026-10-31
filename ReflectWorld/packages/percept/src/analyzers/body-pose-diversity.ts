// packages/percept/src/analyzers/body-pose-diversity.ts
//
// Compute body gallery diversity metadata from RTMPose COCO-17 keypoints.
// Used to ensure body ReID gallery stores diverse viewpoints and visibility.

import { POSE_KEYPOINT_CONFIDENCE } from "../thresholds.js";

// ── COCO-17 keypoint indices ──
const NOSE = 0;
const L_SHOULDER = 5;
const R_SHOULDER = 6;
const L_HIP = 11;
const R_HIP = 12;
const L_KNEE = 13;
const R_KNEE = 14;

export type YawBin = "front" | "side" | "back";
export type VisibilityBin = "full" | "upper" | "partial";

export interface BodyDiversity {
  yaw_bin: YawBin;
  visibility: VisibilityBin;
  /** Raw shoulder width ratio 0-1. 1.0 = full front, 0.0 = pure side. */
  shoulder_ratio?: number;
}

/**
 * Compute body pose diversity metadata from COCO-17 keypoints.
 *
 * `shoulder_ratio` is a continuous 0-1 value (shoulder width / reference width).
 * Python bins it later for gallery slot selection.
 *
 * Falls back to defaults (yaw_bin="front", no shoulder_ratio) when both
 * shoulders are not visible — there is not enough geometric information
 * to estimate body orientation.
 */
export function computeBodyDiversity(
  keypoints: Array<{ x: number; y: number; confidence: number }>,
  threshold = POSE_KEYPOINT_CONFIDENCE,
): BodyDiversity {
  const vis = (idx: number): boolean => keypoints[idx]!.confidence >= threshold;
  const kp = (idx: number) => keypoints[idx]!;

  // ── Guard: need both shoulders to compute anything meaningful ──
  if (!vis(L_SHOULDER) || !vis(R_SHOULDER)) {
    return { yaw_bin: "front", visibility: "partial" };
  }

  // ── Visibility classification ──
  const hasHipL = vis(L_HIP);
  const hasHipR = vis(R_HIP);
  const hasKneeL = vis(L_KNEE);
  const hasKneeR = vis(R_KNEE);
  const hasAnyHip = hasHipL || hasHipR;
  const hasBothHips = hasHipL && hasHipR;
  const hasAnyKnee = hasKneeL || hasKneeR;

  let visibility: VisibilityBin;
  if (hasBothHips && hasAnyKnee) {
    visibility = "full";
  } else if (!hasAnyHip && !hasAnyKnee) {
    visibility = "upper";
  } else if (hasAnyHip && !hasBothHips) {
    // One hip visible, other missing — one-sided / partial
    visibility = "partial";
  } else if (hasBothHips && !hasAnyKnee) {
    // Both hips but no knees — still a reasonably complete torso
    visibility = "full";
  } else {
    // Remaining edge cases: no hips but has knee(s) — unusual, treat as partial
    visibility = "partial";
  }

  // ── Shoulder distance (Euclidean) ──
  const ls = kp(L_SHOULDER);
  const rs = kp(R_SHOULDER);
  const shoulderDist = Math.sqrt((ls.x - rs.x) ** 2 + (ls.y - rs.y) ** 2);

  // ── Reference width for normalizing shoulder distance ──
  // Best reference: hip width (both hips visible). Approximates full-frontal torso width.
  // Hip width is typically ~0.9-1.1x shoulder width for a front-facing person.
  // Fallback: use shoulder distance itself (assume front, ratio = 1.0).
  let refWidth: number;
  if (hasBothHips) {
    const lh = kp(L_HIP);
    const rh = kp(R_HIP);
    const hipDist = Math.sqrt((lh.x - rh.x) ** 2 + (lh.y - rh.y) ** 2);
    // Hip width as proxy for max frontal width. When person faces sideways,
    // shoulder distance compresses but hip distance also compresses — however
    // hip compression is less extreme for moderate turns. Use the larger of
    // hip distance and shoulder distance as reference to avoid ratio > 1.
    refWidth = Math.max(hipDist, shoulderDist);
  } else {
    // No hip reference available — cannot reliably determine absolute orientation.
    // Use shoulder distance alone; we still try to detect back via nose.
    refWidth = shoulderDist;
  }

  // Avoid division by zero for degenerate keypoints
  const ratio = refWidth > 1e-6 ? Math.min(1.0, Math.max(0.0, shoulderDist / refWidth)) : 1.0;

  // ── Yaw classification ──
  const hasNose = vis(NOSE);

  let yaw_bin: YawBin;
  if (!hasNose && ratio < 0.5) {
    // Nose not visible + shoulders compressed → person facing away
    yaw_bin = "back";
  } else if (ratio < 0.5) {
    yaw_bin = "side";
  } else {
    yaw_bin = "front";
  }

  return { yaw_bin, visibility, shoulder_ratio: ratio };
}
