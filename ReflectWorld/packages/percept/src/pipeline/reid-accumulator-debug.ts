import { cosineSimilarity } from "../analyzers/clique.js";
import { canAppendFaceGallery, faceReidRejectReason } from "../face-reid-policy.js";
import {
  ACCUMULATOR_BODY_CONSISTENCY,
  ACCUMULATOR_BODY_MIN_FRAMES,
  ACCUMULATOR_FACE_CONSISTENCY,
  ACCUMULATOR_FACE_MIN_FRAMES,
  ACCUMULATOR_SINGLE_FACE_INIT_MAX_PITCH,
  ACCUMULATOR_SINGLE_FACE_INIT_MAX_YAW,
  ACCUMULATOR_SINGLE_FACE_INIT_QUALITY,
} from "../thresholds.js";
import type { DIdEntry, WorkingMemoryTarget } from "../types.js";
import type { ParsedSubjectProposalTarget } from "../vlm-output-parser.js";

interface ReIdDebugBbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ReIdDebugPoint {
  x: number;
  y: number;
}

interface ReIdAccumulatorDebugFace {
  source: "current" | "pending";
  did: string;
  segment_id?: string;
  frame_idx?: number;
  class_name?: string;
  detection_confidence?: number;
  person_bbox?: ReIdDebugBbox;
  face_bbox?: ReIdDebugBbox;
  face_center?: ReIdDebugPoint;
  landmarks?: ReIdDebugPoint[];
  person_contains_face_center?: boolean;
  face_intersection_ratio?: number;
  has_face?: boolean;
  has_embedding?: boolean;
  landmarks_count?: number;
  quality?: number;
  match_score?: number;
  sharpness?: number;
  yaw?: number;
  pitch?: number;
  writable: boolean;
  reject_reason?: string;
}

export interface ReIdAccumulatorDebug {
  target_index: number;
  type: string;
  bbox_ids: string[];
  matched_wm_target: string | null;
  reid_unsafe_reason?: string;
  chosen_target_id?: string;
  matched_wm_has_entity: boolean;
  current_faces: ReIdAccumulatorDebugFace[];
  pending_faces: ReIdAccumulatorDebugFace[];
  current_face_count: number;
  pending_face_count: number;
  face_pool_count: number;
  current_body_count: number;
  pending_body_count: number;
  body_pool_count: number;
  thresholds: {
    face_min_frames: number;
    face_consistency: number;
    body_min_frames: number;
    body_consistency: number;
    single_face_init_quality: number;
    single_face_init_max_yaw: number;
    single_face_init_max_pitch: number;
  };
  single_face_init_candidate?: {
    did: string;
    quality?: number;
    yaw?: number;
    pitch?: number;
    eligible: boolean;
  };
  pairwise_face_cosine: Array<{ a: string; b: string; cosine: number; pass: boolean }>;
  max_pairwise_face_cosine?: number;
  has_face_pair_above_threshold: boolean;
  result?: Record<string, unknown>;
}

function reidWritableRejectReason(face: DIdEntry["face"] | undefined): string | undefined {
  return faceReidRejectReason(face, "append_gallery");
}

function debugBbox(bbox: DIdEntry["bbox"] | undefined): ReIdDebugBbox | undefined {
  if (!bbox) return undefined;
  return {
    x: Number(bbox.x.toFixed(2)),
    y: Number(bbox.y.toFixed(2)),
    width: Number(bbox.width.toFixed(2)),
    height: Number(bbox.height.toFixed(2)),
  };
}

function debugPoint(point: ReIdDebugPoint): ReIdDebugPoint {
  return {
    x: Number(point.x.toFixed(2)),
    y: Number(point.y.toFixed(2)),
  };
}

function debugBboxArea(bbox: DIdEntry["bbox"] | undefined): number {
  if (!bbox) return 0;
  return Math.max(0, bbox.width) * Math.max(0, bbox.height);
}

function debugBboxIntersectionArea(a: DIdEntry["bbox"] | undefined, b: DIdEntry["bbox"] | undefined): number {
  if (!a || !b) return 0;
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) return 0;
  return (x2 - x1) * (y2 - y1);
}

function debugPointInBbox(point: ReIdDebugPoint | undefined, bbox: DIdEntry["bbox"] | undefined): boolean | undefined {
  if (!point || !bbox) return undefined;
  return point.x >= bbox.x
    && point.x <= bbox.x + bbox.width
    && point.y >= bbox.y
    && point.y <= bbox.y + bbox.height;
}

export function buildReIdAccumulatorDebug(
  target: ParsedSubjectProposalTarget,
  targetIndex: number,
  matchedWmTarget: WorkingMemoryTarget | undefined,
  registry: Pick<Map<string, DIdEntry>, "get">,
): ReIdAccumulatorDebug {
  const currentFaces: ReIdAccumulatorDebugFace[] = [];
  const currentFacePool: Array<{ label: string; embedding: number[]; quality: number; yaw?: number; pitch?: number }> = [];
  let currentBodyCount = 0;

  for (const did of target.bbox_ids) {
    const entry = registry.get(did);
    const face = entry?.face;
    const faceCenter = face?.bbox
      ? { x: face.bbox.x + face.bbox.width / 2, y: face.bbox.y + face.bbox.height / 2 }
      : undefined;
    const faceArea = debugBboxArea(face?.bbox);
    const rejectReason = reidWritableRejectReason(face);
    const writable = rejectReason == null && canAppendFaceGallery(face);
    currentFaces.push({
      source: "current",
      did,
      frame_idx: entry?.frame_idx,
      class_name: entry?.class_name,
      detection_confidence: entry?.confidence,
      person_bbox: debugBbox(entry?.bbox),
      face_bbox: debugBbox(face?.bbox),
      face_center: faceCenter ? debugPoint(faceCenter) : undefined,
      landmarks: face?.landmarks?.map(debugPoint),
      person_contains_face_center: debugPointInBbox(faceCenter, entry?.bbox),
      face_intersection_ratio: faceArea > 0
        ? Number((debugBboxIntersectionArea(face?.bbox, entry?.bbox) / faceArea).toFixed(4))
        : undefined,
      has_face: Boolean(face),
      has_embedding: Boolean(face?.embedding?.length),
      landmarks_count: face?.landmarks?.length,
      quality: face?.quality,
      match_score: face?.match_score,
      sharpness: face?.sharpness,
      yaw: face?.pose?.yaw,
      pitch: face?.pose?.pitch,
      writable,
      reject_reason: writable ? undefined : rejectReason,
    });
    if (writable && face?.embedding?.length) {
      currentFacePool.push({
        label: `${did}@${targetIndex}`,
        embedding: face.embedding,
        quality: face.quality ?? 0,
        yaw: face.pose?.yaw,
        pitch: face.pose?.pitch,
      });
    }
    if (entry?.body?.embedding) currentBodyCount += 1;
  }

  const pendingFaces: ReIdAccumulatorDebugFace[] = (matchedWmTarget?.pending_face_embeddings ?? []).map((pending) => ({
    source: "pending",
    did: pending.did,
    segment_id: pending.segment_id,
    has_embedding: Boolean(pending.embedding?.length),
    quality: pending.quality,
    yaw: pending.yaw,
    pitch: pending.pitch,
    writable: Boolean(pending.embedding?.length),
    reject_reason: pending.embedding?.length ? undefined : "missing_embedding",
  }));

  const facePool = [
    ...currentFacePool,
    ...(matchedWmTarget?.pending_face_embeddings ?? [])
      .filter((pending) => pending.embedding?.length)
      .map((pending) => ({
        label: `${pending.did}@${pending.segment_id}`,
        embedding: pending.embedding,
        quality: pending.quality,
        yaw: pending.yaw,
        pitch: pending.pitch,
      })),
  ];

  const pairwiseFaceCosine: ReIdAccumulatorDebug["pairwise_face_cosine"] = [];
  for (let i = 0; i < facePool.length; i++) {
    for (let j = i + 1; j < facePool.length; j++) {
      const cosine = cosineSimilarity(facePool[i]!.embedding, facePool[j]!.embedding);
      pairwiseFaceCosine.push({
        a: facePool[i]!.label,
        b: facePool[j]!.label,
        cosine: Number(cosine.toFixed(4)),
        pass: cosine >= ACCUMULATOR_FACE_CONSISTENCY,
      });
    }
  }

  const maxPairwise = pairwiseFaceCosine.length
    ? Math.max(...pairwiseFaceCosine.map((item) => item.cosine))
    : undefined;
  const singleFaceInitCandidate = facePool.length === 1
    ? {
        did: facePool[0]!.label,
        quality: facePool[0]!.quality,
        yaw: facePool[0]!.yaw,
        pitch: facePool[0]!.pitch,
        eligible:
          facePool[0]!.quality >= ACCUMULATOR_SINGLE_FACE_INIT_QUALITY
          && facePool[0]!.yaw != null
          && Math.abs(facePool[0]!.yaw) <= ACCUMULATOR_SINGLE_FACE_INIT_MAX_YAW
          && facePool[0]!.pitch != null
          && Math.abs(facePool[0]!.pitch) <= ACCUMULATOR_SINGLE_FACE_INIT_MAX_PITCH,
      }
    : undefined;

  return {
    target_index: targetIndex,
    type: target.type,
    bbox_ids: target.bbox_ids,
    matched_wm_target: target.matched_wm_target,
    reid_unsafe_reason: target.reid_unsafe_reason,
    matched_wm_has_entity: Boolean(matchedWmTarget?.entity_id),
    current_faces: currentFaces,
    pending_faces: pendingFaces,
    current_face_count: currentFacePool.length,
    pending_face_count: pendingFaces.filter((face) => face.writable).length,
    face_pool_count: facePool.length,
    current_body_count: currentBodyCount,
    pending_body_count: matchedWmTarget?.pending_body_embeddings?.filter((pending) => pending.embedding?.length).length ?? 0,
    body_pool_count: currentBodyCount + (matchedWmTarget?.pending_body_embeddings?.filter((pending) => pending.embedding?.length).length ?? 0),
    thresholds: {
      face_min_frames: ACCUMULATOR_FACE_MIN_FRAMES,
      face_consistency: ACCUMULATOR_FACE_CONSISTENCY,
      body_min_frames: ACCUMULATOR_BODY_MIN_FRAMES,
      body_consistency: ACCUMULATOR_BODY_CONSISTENCY,
      single_face_init_quality: ACCUMULATOR_SINGLE_FACE_INIT_QUALITY,
      single_face_init_max_yaw: ACCUMULATOR_SINGLE_FACE_INIT_MAX_YAW,
      single_face_init_max_pitch: ACCUMULATOR_SINGLE_FACE_INIT_MAX_PITCH,
    },
    single_face_init_candidate: singleFaceInitCandidate,
    pairwise_face_cosine: pairwiseFaceCosine,
    max_pairwise_face_cosine: maxPairwise,
    has_face_pair_above_threshold: pairwiseFaceCosine.some((item) => item.pass),
  };
}
