import type { DIdEntry } from "./types.js";
import {
  ACCUMULATOR_SINGLE_FACE_INIT_MAX_PITCH,
  ACCUMULATOR_SINGLE_FACE_INIT_MAX_YAW,
  ACCUMULATOR_SINGLE_FACE_INIT_QUALITY,
  FACE_REID_MIN_SHARPNESS,
  FACE_REID_MATCH_THRESHOLD,
  GALLERY_APPEND_THRESHOLD,
} from "./thresholds.js";

type FaceEvidence = DIdEntry["face"];

const MIN_LANDMARKS = 5;
const MIN_REID_QUALITY = 0.5;
const MAX_APPEND_YAW = 90;
const MAX_APPEND_PITCH = 45;

function baseRejectReason(face: FaceEvidence | undefined): string | undefined {
  if (!face) return "missing_face";
  if (!face.embedding?.length) return "missing_embedding";
  if (!face.landmarks || face.landmarks.length < MIN_LANDMARKS) return `landmarks_lt_${MIN_LANDMARKS}`;
  if ((face.quality ?? 0) < MIN_REID_QUALITY) return `quality_lt_${MIN_REID_QUALITY}`;
  if (face.sharpness != null && face.sharpness < FACE_REID_MIN_SHARPNESS) return `sharpness_lt_${FACE_REID_MIN_SHARPNESS}`;
  if (!face.pose) return "missing_pose";
  if (Math.abs(face.pose.pitch) > MAX_APPEND_PITCH) return `pitch_gt_${MAX_APPEND_PITCH}`;
  return undefined;
}

/**
 * Existing ReID matches are treated as strong evidence when the face has a
 * usable embedding and sane pitch/blur/landmarks. Yaw is deliberately relaxed:
 * a high-quality side profile can be a valid match and gallery angle.
 */
export function canUseFaceEntityMatch(face: FaceEvidence | undefined): boolean {
  if (baseRejectReason(face)) return false;
  if (face!.entity_id && face!.match_score != null && face!.match_score < FACE_REID_MATCH_THRESHOLD) {
    return false;
  }
  return Math.abs(face!.pose!.yaw) <= MAX_APPEND_YAW;
}

/**
 * Gallery append should preserve pose diversity. Side profiles are allowed
 * when the embedding, sharpness, landmarks, quality, and pitch are usable.
 */
export function canAppendFaceGallery(face: FaceEvidence | undefined): boolean {
  if (!canUseFaceEntityMatch(face)) return false;
  if (face!.entity_id && face!.match_score != null && face!.match_score < GALLERY_APPEND_THRESHOLD) {
    return false;
  }
  return true;
}

/**
 * Single-face entity initialization is intentionally stricter than gallery
 * append. A side profile may enrich an existing gallery but should not create
 * a brand-new stable identity by itself.
 */
export function canInitFaceEntity(face: FaceEvidence | undefined): boolean {
  if (baseRejectReason(face)) return false;
  if ((face!.quality ?? 0) < ACCUMULATOR_SINGLE_FACE_INIT_QUALITY) return false;
  if (Math.abs(face!.pose!.yaw) > ACCUMULATOR_SINGLE_FACE_INIT_MAX_YAW) return false;
  if (Math.abs(face!.pose!.pitch) > ACCUMULATOR_SINGLE_FACE_INIT_MAX_PITCH) return false;
  return true;
}

export function faceReidRejectReason(
  face: FaceEvidence | undefined,
  action: "match" | "append_gallery" | "init_entity" = "append_gallery",
): string | undefined {
  const base = baseRejectReason(face);
  if (base) return base;
  if (face!.entity_id && face!.match_score != null && face!.match_score < FACE_REID_MATCH_THRESHOLD) {
    return `match_score_lt_${FACE_REID_MATCH_THRESHOLD}`;
  }
  if ((action === "match" || action === "append_gallery") && Math.abs(face!.pose!.yaw) > MAX_APPEND_YAW) {
    return `yaw_gt_${MAX_APPEND_YAW}`;
  }
  if (action === "append_gallery" && face!.entity_id && face!.match_score != null && face!.match_score < GALLERY_APPEND_THRESHOLD) {
    return `gallery_match_score_lt_${GALLERY_APPEND_THRESHOLD}`;
  }
  if (action === "init_entity") {
    if ((face!.quality ?? 0) < ACCUMULATOR_SINGLE_FACE_INIT_QUALITY) return `quality_lt_${ACCUMULATOR_SINGLE_FACE_INIT_QUALITY}`;
    if (Math.abs(face!.pose!.yaw) > ACCUMULATOR_SINGLE_FACE_INIT_MAX_YAW) return `yaw_gt_${ACCUMULATOR_SINGLE_FACE_INIT_MAX_YAW}`;
    if (Math.abs(face!.pose!.pitch) > ACCUMULATOR_SINGLE_FACE_INIT_MAX_PITCH) return `pitch_gt_${ACCUMULATOR_SINGLE_FACE_INIT_MAX_PITCH}`;
  }
  return undefined;
}

export function isReidWritableFace(face: FaceEvidence | undefined): boolean {
  return canAppendFaceGallery(face);
}
