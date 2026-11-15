// packages/percept/src/analyzers/subject-proposal-analyzer.ts
// Segment-scoped face embedding clustering for subject proposal generation.
// Replaces ByteTrack-based identity grouping with face similarity clustering.

import type { BoundingBox, Frame } from "@cortex/shared";
import type { DetectionOutput, FaceDetection } from "../types.js";
import type { ModelRouter } from "../providers/model-router.js";
import { FACE_CLUSTER_SIMILARITY_THRESHOLD, FACE_REID_MIN_SHARPNESS } from "../thresholds.js";

/** Sharpness measurement for a face crop. */
export interface FaceSharpness {
  /** Laplacian variance computed on 112x112 normalized crop. */
  laplacianVariance: number;
  /** Whether this face is sharp enough for ReID embedding extraction. */
  usableForReid: boolean;
}

/** A qualified face detection ready for embedding extraction. */
export interface QualifiedFace {
  frameIndex: number;
  personBbox: BoundingBox;
  faceBbox: BoundingBox;
  faceLandmarks?: Array<{ x: number; y: number }>;
  faceConfidence: number;
  /** Face area as proportion of frame area (higher = better). */
  faceAreaRatio: number;
  /** Sharpness measurement (populated by measureFaceSharpness). */
  sharpness?: FaceSharpness;
}

export type FaceQualificationRejectReason =
  | "missing_face"
  | "face_short_edge_lt_min"
  | "face_clipped_visible_ratio_lt_min"
  | "face_vertical_span_invalid"
  | "face_pitch_ratio_lt_min";

export interface FaceQualificationDebug {
  frame_idx: number;
  detection_idx: number;
  person_bbox: BoundingBox;
  person_confidence: number;
  has_face: boolean;
  qualified: boolean;
  rejected_reason?: FaceQualificationRejectReason;
  face_bbox?: BoundingBox;
  face_confidence?: number;
  face_short_edge?: number;
  face_area_ratio?: number;
  face_visible_ratio?: number;
  landmarks_count?: number;
  pitch_ratio?: number;
}

/** A cluster of face detections belonging to the same person. */
export interface FaceCluster {
  /** Segment-scoped cluster ID, e.g. "cluster_0". */
  cluster_id: string;
  /** Best face detection in this cluster (highest quality). */
  best: QualifiedFace;
  /** ArcFace embedding of the best face. */
  embedding: number[];
  /** All members of this cluster. */
  members: QualifiedFace[];
}

/** Minimum face bbox short edge in pixels to qualify for ReID. */
const MIN_FACE_SHORT_EDGE = 40;

/**
 * Minimum pitch ratio for landmark-based face pose filtering.
 *
 * Pitch ratio = (mouth_center_y - eye_center_y) / inter_eye_distance.
 * Measures how "upright" the face is relative to its width.
 *
 * Normal frontal face: ~1.3-2.0.
 * Side profile: inter-eye distance is small → ratio becomes large → passes.
 * Head-down/head-up: vertical span compressed → ratio < 0.5 → rejected.
 */
const MIN_FACE_PITCH_RATIO = 0.5;

function computePitchRatio(face: FaceDetection): { pitchRatio?: number; verticalSpanInvalid?: boolean } {
  if (!face.landmarks || face.landmarks.length < 5) return {};
  const eyeCenterY = (face.landmarks[0]!.y + face.landmarks[1]!.y) / 2;
  const mouthCenterY = (face.landmarks[3]!.y + face.landmarks[4]!.y) / 2;
  const verticalSpan = mouthCenterY - eyeCenterY;
  if (verticalSpan <= 0) return { verticalSpanInvalid: true };
  const interEyeDx = face.landmarks[1]!.x - face.landmarks[0]!.x;
  const interEyeDy = face.landmarks[1]!.y - face.landmarks[0]!.y;
  const interEyeDist = Math.sqrt(interEyeDx * interEyeDx + interEyeDy * interEyeDy);
  if (interEyeDist <= 0) return {};
  return { pitchRatio: verticalSpan / interEyeDist };
}

function evaluateFaceQualification(
  det: DetectionOutput["detections"][number],
  frameIndex: number,
  detectionIndex: number,
  frameWidth: number,
  frameHeight: number,
  frameArea: number,
): { face?: QualifiedFace; debug: FaceQualificationDebug } {
  const baseDebug: FaceQualificationDebug = {
    frame_idx: frameIndex,
    detection_idx: detectionIndex,
    person_bbox: det.bbox,
    person_confidence: det.confidence,
    has_face: Boolean(det.face),
    qualified: false,
  };

  if (!det.face) {
    return { debug: { ...baseDebug, rejected_reason: "missing_face" } };
  }

  const face = det.face;
  const faceW = face.bbox.width;
  const faceH = face.bbox.height;
  const shortEdge = Math.min(faceW, faceH);
  const visibleW = Math.min(face.bbox.x + face.bbox.width, frameWidth) - Math.max(face.bbox.x, 0);
  const visibleH = Math.min(face.bbox.y + face.bbox.height, frameHeight) - Math.max(face.bbox.y, 0);
  const visibleRatio = faceW * faceH > 0 ? (visibleW * visibleH) / (faceW * faceH) : 0;
  const { pitchRatio, verticalSpanInvalid } = computePitchRatio(face);
  const debug: FaceQualificationDebug = {
    ...baseDebug,
    face_bbox: face.bbox,
    face_confidence: face.confidence,
    face_short_edge: shortEdge,
    face_area_ratio: (faceW * faceH) / frameArea,
    face_visible_ratio: visibleRatio,
    landmarks_count: face.landmarks?.length ?? 0,
    pitch_ratio: pitchRatio,
  };

  if (shortEdge < MIN_FACE_SHORT_EDGE) {
    return { debug: { ...debug, rejected_reason: "face_short_edge_lt_min" } };
  }

  // Skip faces clipped by image boundary (>90% on edge)
  if (face.bbox.x < 2 || face.bbox.y < 2 ||
      face.bbox.x + face.bbox.width > frameWidth - 2 || face.bbox.y + face.bbox.height > frameHeight - 2) {
    if (visibleW * visibleH < faceW * faceH * 0.9) {
      return { debug: { ...debug, rejected_reason: "face_clipped_visible_ratio_lt_min" } };
    }
  }

  if (face.landmarks && face.landmarks.length >= 5) {
    if (verticalSpanInvalid) {
      return { debug: { ...debug, rejected_reason: "face_vertical_span_invalid" } };
    }
    if (pitchRatio != null && pitchRatio < MIN_FACE_PITCH_RATIO) {
      return { debug: { ...debug, rejected_reason: "face_pitch_ratio_lt_min" } };
    }
  }

  return {
    face: {
      frameIndex,
      personBbox: det.bbox,
      faceBbox: face.bbox,
      faceLandmarks: face.landmarks,
      faceConfidence: face.confidence,
      faceAreaRatio: (faceW * faceH) / frameArea,
    },
    debug: { ...debug, qualified: true },
  };
}

/**
 * Collect qualified face detections from all frames' detection outputs.
 * Filters by quality: minimum face size, confidence, not clipped by boundary.
 */
export function collectQualifiedFaces(
  detectionOutputs: DetectionOutput[],
  frameWidth: number,
  frameHeight: number,
): QualifiedFace[] {
  const frameArea = frameWidth * frameHeight;
  const results: QualifiedFace[] = [];

  for (let fi = 0; fi < detectionOutputs.length; fi++) {
    const dets = detectionOutputs[fi]?.detections ?? [];
    for (let detectionIndex = 0; detectionIndex < dets.length; detectionIndex++) {
      const det = dets[detectionIndex]!;
      if (det.label !== "person") continue;
      const evaluated = evaluateFaceQualification(det, fi, detectionIndex, frameWidth, frameHeight, frameArea);
      if (evaluated.face) results.push(evaluated.face);
    }
  }

  return results;
}

export function collectFaceQualificationDebug(
  detectionOutputs: DetectionOutput[],
  frameWidth: number,
  frameHeight: number,
): FaceQualificationDebug[] {
  const frameArea = frameWidth * frameHeight;
  const debug: FaceQualificationDebug[] = [];

  for (let fi = 0; fi < detectionOutputs.length; fi++) {
    const dets = detectionOutputs[fi]?.detections ?? [];
    for (let detectionIndex = 0; detectionIndex < dets.length; detectionIndex++) {
      const det = dets[detectionIndex]!;
      if (det.label !== "person") continue;
      debug.push(evaluateFaceQualification(det, fi, detectionIndex, frameWidth, frameHeight, frameArea).debug);
    }
  }

  return debug;
}

/**
 * Hard blur rejection threshold for Laplacian variance on 112x112 normalized crop.
 *
 * Only rejects extreme blur (motion blur, severe defocus) where facial features
 * are completely indistinguishable. Conservative: better to let a borderline
 * face through than to reject a usable one.
 *
 * Calibration reference (112x112 crop):
 * - Extreme motion blur (face smeared): ~10-20
 * - Moderate blur (features soft but visible): ~40-80
 * - Sharp face: ~100-500+
 */
const HARD_BLUR_THRESHOLD = FACE_REID_MIN_SHARPNESS;

/** ArcFace input size used as normalization target for Laplacian computation. */
const BLUR_NORM_SIZE = 112;

/** Result of sharpness measurement: faces split into ReID-usable and blur-rejected. */
export interface SharpnessMeasurement {
  /** Faces sharp enough for ArcFace embedding extraction (Path A). */
  usable: QualifiedFace[];
  /** Faces rejected as too blurry — their person bboxes should go to Path B. */
  blurRejected: QualifiedFace[];
}

/**
 * Measure face sharpness and split into usable (Path A) and blur-rejected (Path B).
 *
 * Process: clamp bbox → crop → resize to 112x112 → greyscale → Laplacian variance.
 * Normalizing to 112x112 makes scores comparable across different face sizes.
 *
 * Must be called after collectQualifiedFaces and before extractFaceEmbeddings.
 */
export async function measureFaceSharpness(
  faces: QualifiedFace[],
  frames: Frame[],
  hardThreshold: number = HARD_BLUR_THRESHOLD,
): Promise<SharpnessMeasurement> {
  let sharpLib: any;
  try {
    const mod = await import("sharp");
    sharpLib = mod.default ?? mod;
  } catch {
    // sharp unavailable — treat all as usable (fail-open)
    return { usable: faces.map((f) => ({ ...f, sharpness: { laplacianVariance: -1, usableForReid: true } })), blurRejected: [] };
  }

  const usable: QualifiedFace[] = [];
  const blurRejected: QualifiedFace[] = [];

  for (const face of faces) {
    const frame = frames[face.frameIndex];
    if (!frame) { usable.push(face); continue; } // fail-open
    try {
      const imgBuf = Buffer.from(frame.data, "base64");
      const meta = await sharpLib(imgBuf).metadata();
      const imgW = meta.width ?? 1;
      const imgH = meta.height ?? 1;

      // Clamp face crop to image bounds
      const fx = Math.min(Math.max(0, Math.round(face.faceBbox.x)), imgW - 1);
      const fy = Math.min(Math.max(0, Math.round(face.faceBbox.y)), imgH - 1);
      const fw = Math.min(imgW - fx, Math.max(1, Math.round(face.faceBbox.width)));
      const fh = Math.min(imgH - fy, Math.max(1, Math.round(face.faceBbox.height)));

      // Crop → resize to 112x112 (ArcFace input size) → greyscale → raw pixels
      const raw = await sharpLib(imgBuf)
        .extract({ left: fx, top: fy, width: fw, height: fh })
        .resize(BLUR_NORM_SIZE, BLUR_NORM_SIZE)
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const lapVar = laplacianVariance(raw.data, raw.info.width, raw.info.height);
      const isUsable = lapVar >= hardThreshold;
      const annotated: QualifiedFace = { ...face, sharpness: { laplacianVariance: lapVar, usableForReid: isUsable } };

      if (isUsable) {
        usable.push(annotated);
      } else {
        blurRejected.push(annotated);
      }
    } catch {
      // Crop/measure failed — fail-open, keep for ReID
      usable.push({ ...face, sharpness: { laplacianVariance: -1, usableForReid: true } });
    }
  }

  return { usable, blurRejected };
}

/**
 * Compute Laplacian variance on a grayscale image buffer.
 * Laplacian kernel: [0,1,0; 1,-4,1; 0,1,0].
 * High variance = sharp, low variance = blurry.
 */
function laplacianVariance(data: Buffer, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      const lap =
        data[idx - width]! +
        data[idx - 1]! +
        data[idx + 1]! +
        data[idx + width]! -
        4 * data[idx]!;
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }

  if (count === 0) return 0;
  const mean = sum / count;
  return sumSq / count - mean * mean;
}

/**
 * Extract ArcFace embeddings for all qualified faces.
 * Returns parallel array of embeddings (undefined if extraction failed).
 */
export async function extractFaceEmbeddings(
  faces: QualifiedFace[],
  frames: Frame[],
  router: ModelRouter,
): Promise<Array<number[] | undefined>> {
  const faceReid = router.getReidProvider("face-reid");
  if (!faceReid) return faces.map(() => undefined);

  const results: Array<number[] | undefined> = [];
  for (const face of faces) {
    const frame = frames[face.frameIndex];
    if (!frame) { results.push(undefined); continue; }
    try {
      const imageBuffer = Buffer.from(frame.data, "base64");
      const result = await faceReid.extractEmbedding({
        imageBuffer,
        options: { bbox: face.faceBbox, landmarks: face.faceLandmarks },
      });
      results.push(result.embedding.length > 0
        ? Array.from(new Float32Array(result.embedding))
        : undefined);
    } catch {
      results.push(undefined);
    }
  }
  return results;
}

/**
 * Cluster face detections by embedding cosine similarity.
 *
 * Constraints:
 * - Merge only when cosine similarity > threshold.
 * - Cannot-link: two faces from the same frame never merge.
 *
 * Uses simple greedy agglomerative clustering (sufficient for typical
 * segment sizes of 5-30 faces across 10-25 frames).
 */
export function clusterFaces(
  faces: QualifiedFace[],
  embeddings: Array<number[] | undefined>,
  threshold: number = FACE_CLUSTER_SIMILARITY_THRESHOLD,
): FaceCluster[] {
  // Filter to faces with valid embeddings
  const indexed: Array<{ idx: number; face: QualifiedFace; emb: number[] }> = [];
  for (let i = 0; i < faces.length; i++) {
    const emb = embeddings[i];
    if (emb) indexed.push({ idx: i, face: faces[i]!, emb });
  }
  if (indexed.length === 0) return [];

  // Union-Find with cannot-link enforcement
  const parent = indexed.map((_, i) => i);
  function find(x: number): number {
    while (parent[x] !== x) { parent[x] = parent[parent[x]!]!; x = parent[x]!; }
    return x;
  }
  function union(a: number, b: number): void {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  // Compute all pairwise similarities and merge greedily (highest first)
  const pairs: Array<{ i: number; j: number; sim: number }> = [];
  for (let i = 0; i < indexed.length; i++) {
    for (let j = i + 1; j < indexed.length; j++) {
      // Cannot-link: same frame
      if (indexed[i]!.face.frameIndex === indexed[j]!.face.frameIndex) continue;
      const sim = cosineSimilarity(indexed[i]!.emb, indexed[j]!.emb);
      if (sim > threshold) pairs.push({ i, j, sim });
    }
  }
  pairs.sort((a, b) => b.sim - a.sim);

  for (const { i, j } of pairs) {
    const ri = find(i), rj = find(j);
    if (ri === rj) continue;

    // Check cannot-link: would merging create a cluster with two faces from the same frame?
    const clusterFrames = new Set<number>();
    let conflict = false;
    for (let k = 0; k < indexed.length; k++) {
      if (find(k) === ri || find(k) === rj) {
        if (clusterFrames.has(indexed[k]!.face.frameIndex)) { conflict = true; break; }
        clusterFrames.add(indexed[k]!.face.frameIndex);
      }
    }
    if (!conflict) union(ri, rj);
  }

  // Group by cluster root
  const groups = new Map<number, Array<typeof indexed[number]>>();
  for (let i = 0; i < indexed.length; i++) {
    const root = find(i);
    const group = groups.get(root) ?? [];
    group.push(indexed[i]!);
    groups.set(root, group);
  }

  // Build FaceCluster results
  const clusters: FaceCluster[] = [];
  let clusterIdx = 0;
  for (const members of groups.values()) {
    // Best = highest composite quality: sharpness (if measured) + area + confidence.
    // Sharpness is the primary signal when available; area * confidence is tiebreaker.
    members.sort((a, b) => {
      const aSharp = a.face.sharpness?.laplacianVariance ?? 0;
      const bSharp = b.face.sharpness?.laplacianVariance ?? 0;
      const aBase = a.face.faceAreaRatio * a.face.faceConfidence;
      const bBase = b.face.faceAreaRatio * b.face.faceConfidence;
      // Normalize sharpness contribution: log scale to avoid dominating
      const aScore = Math.log1p(aSharp) * 0.1 + aBase;
      const bScore = Math.log1p(bSharp) * 0.1 + bBase;
      return bScore - aScore;
    });
    const best = members[0]!;
    clusters.push({
      cluster_id: `cluster_${clusterIdx++}`,
      best: best.face,
      embedding: best.emb,
      members: members.map((m) => m.face),
    });
  }

  return clusters;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}
