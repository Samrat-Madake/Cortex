/**
 * Centralized inference thresholds for all perception models.
 *
 * All confidence/threshold values live here so they can be reviewed
 * and tuned in one place instead of scattered across analyzers and providers.
 */

// ── Object Detection (YOLO26m) ──
/** Minimum confidence for YOLO26m general object detections. */
export const YOLO_CONFIDENCE = 0.25;
/** Per-class confidence overrides (keyed by COCO label). */
export const YOLO_CLASS_CONFIDENCE: Record<string, number> = {
  person: 0.7,
};
/** Minimum person bbox area as a fraction of full frame area. */
export const PERSON_MIN_BBOX_AREA_RATIO = 0.01;

// ── Face Detection (RetinaFace) ──
/** Pre-NMS confidence filter (low, casts a wide net). */
export const FACE_PRE_NMS_CONFIDENCE = 0.02;
/** Post-NMS visual confidence threshold (only high-quality faces survive). */
export const FACE_VIS_CONFIDENCE = 0.6;
/** Provider-level confidence for RetinaFace builtin. */
export const FACE_PROVIDER_CONFIDENCE = 0.8;

// ── ReID ──
/** Minimum cosine similarity for face ReID search to be considered a stable match. */
export const FACE_REID_MATCH_THRESHOLD = 0.6;
/**
 * Minimum Laplacian sharpness for face ReID use.
 * This is a hard blur gate: it should only reject faces too blurry to produce
 * meaningful embeddings, not every soft but still recognizable face.
 */
export const FACE_REID_MIN_SHARPNESS = 15;

// ── Subject Proposal: Face Clustering ──
/**
 * Cosine similarity threshold for merging face detections into one subject
 * within a segment. Intentionally stricter than cross-segment ReID matching
 * because a false merge (two people → one proposal) is worse than a false
 * split (one person → two proposals).
 */
export const FACE_CLUSTER_SIMILARITY_THRESHOLD = 0.50;

// ── Subject Proposal: Gallery Append ──
/**
 * Cosine similarity threshold for VLM-aggregated unmatched face to be
 * appended to an existing entity's gallery after a current-segment stable
 * anchor already exists. This is lower than the stable ReID match threshold
 * because it is an expansion check, not the first identity decision.
 * Only active when entity_id_source == "current_reid" (current segment has
 * a confirmed ReID anchor for this entity).
 */
export const GALLERY_APPEND_THRESHOLD = 0.6;

// ── Subject Proposal: Anonymous VLM Matching ──
/**
 * Minimum VLM-reported confidence to accept a cross-segment anonymous
 * subject match. Below this, the target is treated as a new anonymous
 * subject rather than updating an existing one.
 */
export const ANONYMOUS_MATCH_CONFIDENCE_THRESHOLD = 0.6;

// ── Body Pose (RTMPose) ──
/** Minimum keypoint confidence to consider a body part visible. */
export const POSE_KEYPOINT_CONFIDENCE = 0.3;

// ── Body ReID Search ──
/** Minimum cosine similarity for body ReID search match. */
export const BODY_REID_MATCH_THRESHOLD = 0.85;

// ── Multi-Frame Accumulator ──
/** Min face frames for entity creation. */
export const ACCUMULATOR_FACE_MIN_FRAMES = 2;
/** Min body frames for entity creation. */
export const ACCUMULATOR_BODY_MIN_FRAMES = 2;
/** Face pairwise cosine threshold for clique edge. */
export const ACCUMULATOR_FACE_CONSISTENCY = 0.6;
/** Body pairwise cosine threshold for clique edge. */
export const ACCUMULATOR_BODY_CONSISTENCY = 0.7;
/** Allow single-face initialization only for clearly high-quality, near-frontal faces. */
export const ACCUMULATOR_SINGLE_FACE_INIT_QUALITY = 0.8;
/** Maximum absolute yaw for high-confidence single-face initialization. */
export const ACCUMULATOR_SINGLE_FACE_INIT_MAX_YAW = 25;
/** Maximum absolute pitch for high-confidence single-face initialization. */
export const ACCUMULATOR_SINGLE_FACE_INIT_MAX_PITCH = 25;
/** Max pending face embeddings per WM target. */
export const PENDING_FACE_MAX = 5;
/** Max pending body embeddings per WM target. */
export const PENDING_BODY_MAX = 8;
/**
 * Minimum cosine margin required before parser can infer a missing
 * matched_wm_target from pending face continuity. This avoids hard-binding a
 * current target when multiple historical WM candidates are similarly plausible.
 */
export const WM_PENDING_FACE_MATCH_MARGIN = 0.05;
