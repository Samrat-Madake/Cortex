import { POSE_KEYPOINT_CONFIDENCE } from "../thresholds.js";

// COCO keypoint indices for body completeness gating.
const L_SHOULDER = 5;
const R_SHOULDER = 6;
const L_HIP = 11;
const R_HIP = 12;

export interface BodyCompletenessResult {
  /** Quality score: 1.0 = full, 0.5 = shoulders+no hips, 0 = skip. */
  score: number;
  /** Whether this crop should go through body ReID. */
  shouldExtractBody: boolean;
  /** Human-readable category for logging/tracing. */
  category: "full" | "torso_no_hip" | "insufficient";
}

/**
 * Score body completeness from pose keypoint confidences.
 *
 * Rule:
 *   Both shoulders visible + at least one hip -> score 1.0 (normal extraction)
 *   Both shoulders visible, no hip            -> score 0.5 (extract with reduced quality)
 *   Either shoulder missing                   -> score 0   (skip body ReID)
 */
export function scoreBodyCompleteness(
  keypoints: Array<{ x: number; y: number; confidence: number }>,
  threshold = POSE_KEYPOINT_CONFIDENCE,
): BodyCompletenessResult {
  const vis = (idx: number) => keypoints[idx]!.confidence >= threshold;

  if (!vis(L_SHOULDER) || !vis(R_SHOULDER)) {
    return { score: 0, shouldExtractBody: false, category: "insufficient" };
  }

  if (vis(L_HIP) || vis(R_HIP)) {
    return { score: 1.0, shouldExtractBody: true, category: "full" };
  }

  return { score: 0.5, shouldExtractBody: true, category: "torso_no_hip" };
}
