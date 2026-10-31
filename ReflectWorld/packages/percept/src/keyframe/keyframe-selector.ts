// Keyframe selection using face-first gating strategy.
// Ported from the reference keyframe selector.
//
// Selection pipeline:
//   1. For each frame in a track, evaluate face quality (if face present)
//      and entity quality.
//   2. Collect candidates that pass quality gates.
//   3. Face-first TopK: sort face candidates by
//      (landmark_score, face_area, laplacian_variance, face_confidence),
//      then fill remaining slots from entity candidates sorted by
//      (entity_area, entity_detection_confidence).

import type { BoundingBox } from "@reflectworld/shared";
import {
  QualityAssessor,
  laplacianVariance,
  type QualityConfig,
} from "./quality-assessor.js";
import { writeStderr } from "@reflectworld/shared";

// ── Input / output interfaces ──

/**
 * Per-frame data for a single track occurrence.
 * Used by legacy track-shaped callers and future multi-frame proposal paths.
 */
export interface TrackFrameData {
  /** Zero-based frame index within the segment. */
  frameIndex: number;
  /** Entity bounding box (x, y, width, height). */
  bbox: BoundingBox;
  /** Entity detection confidence. */
  confidence: number;
  /** Associated face bounding box from FaceBodyAssociator (optional). */
  faceBbox?: BoundingBox;
  /** Face detection confidence (optional). */
  faceConfidence?: number;
  /**
   * Flat 5-point face landmarks [x1,y1, x2,y2, ..., x5,y5].
   * Order: left eye, right eye, nose, left mouth, right mouth.
   */
  faceLandmarks?: number[];
  /** SAM2 mask as base64-encoded string (future use). */
  maskBase64?: string;
  /** SAM2 mask area in pixels (future use). */
  maskArea?: number;
}

/**
 * Image data for a frame, needed for blur computation.
 * Caller decodes the JPEG and provides grayscale pixel buffer.
 */
export interface FrameImageData {
  /** Grayscale pixel buffer (row-major, one byte per pixel). */
  gray: Uint8Array;
  /** Image width in pixels. */
  width: number;
  /** Image height in pixels. */
  height: number;
}

/** Result for a single selected keyframe. */
export interface KeyframeResult {
  /** Zero-based frame index within the segment. */
  frameIndex: number;
  /** Overall quality score [0, 1]. */
  qualityScore: number;
  /** Whether selected via face or entity quality path. */
  keyframeType: "face" | "entity";
  /** Whether this frame has an associated face detection. */
  hasFace: boolean;
}

// ── Internal candidate types ──

interface FaceCandidateMetrics {
  landmarkScore: number;
  faceArea: number;
  laplacianVariance: number;
  faceConfidence: number;
}

interface EntityCandidateMetrics {
  entityArea: number;
  entityDetectionConfidence: number;
}

// ── KeyframeSelector ──

export class KeyframeSelector {
  private readonly assessor: QualityAssessor;
  private readonly topK: number;

  constructor(topK = 3, qualityConfig?: QualityConfig) {
    this.assessor = new QualityAssessor(qualityConfig);
    this.topK = topK;
  }

  /**
   * Select keyframes from a track's per-frame data.
   *
   * @param frames     Per-frame detections for one track.
   * @param images     Optional per-frame grayscale images (keyed by frameIndex)
   *                   for Laplacian blur computation. When absent, blur gate
   *                   defaults to 0 (will fail face gate unless threshold is 0).
   * @param frameWidth Full frame width in pixels (for area ratio).
   * @param frameHeight Full frame height in pixels.
   * @param topK       Override instance-level topK.
   * @returns Sorted list of selected keyframes (best first).
   */
  selectKeyframes(
    frames: ReadonlyArray<TrackFrameData>,
    images?: ReadonlyMap<number, FrameImageData>,
    frameWidth?: number,
    frameHeight?: number,
    topK?: number,
  ): KeyframeResult[] {
    const k = topK ?? this.topK;
    if (frames.length === 0) return [];

    const fW = frameWidth ?? 0;
    const fH = frameHeight ?? 0;

    const { faceCandidates, entityCandidates } = this.selectCandidates(
      frames,
      images,
      fW,
      fH,
    );

    if (k === -1) {
      return this.performBestSelection(faceCandidates, entityCandidates);
    }

    return this.performTopKSelection(faceCandidates, entityCandidates, k);
  }

  // ── Candidate selection ──

  private selectCandidates(
    frames: ReadonlyArray<TrackFrameData>,
    images: ReadonlyMap<number, FrameImageData> | undefined,
    frameWidth: number,
    frameHeight: number,
  ): {
    faceCandidates: Array<[number, FaceCandidateMetrics]>;
    entityCandidates: Array<[number, EntityCandidateMetrics]>;
  } {
    const faceCandidates: Array<[number, FaceCandidateMetrics]> = [];
    const entityCandidates: Array<[number, EntityCandidateMetrics]> = [];

    for (const frame of frames) {
      const { frameIndex, bbox, confidence, faceBbox, faceConfidence, faceLandmarks } = frame;

      // ── Face gating ──
      if (faceBbox && faceConfidence !== undefined) {
        const faceW = faceBbox.width;
        const faceH = faceBbox.height;
        const faceArea = faceW * faceH;

        // Stage-1: coarse gating (skip expensive ops early)
        const areaOk = faceArea >= this.assessor.faceCfg.minFacePixelArea;
        const faceRatio = Math.min(faceW, faceH) / Math.max(Math.max(faceW, faceH), 1.0);
        const [lo, hi] = this.assessor.faceCfg.allowedFaceAspectRatioRange;
        const ratioOk = faceRatio >= lo && faceRatio <= hi;
        const confOk = faceConfidence >= this.assessor.faceCfg.minDetectionConfidence;

        if (areaOk && ratioOk && confOk) {
          // Stage-2: fine gating with landmark + blur
          const landmarks5 = parseLandmarks5(faceLandmarks);

          // Compute blur from face region if image data available
          let blurVar = 0.0;
          const imgData = images?.get(frameIndex);
          if (imgData) {
            blurVar = computeFaceBlur(imgData, faceBbox);
          }

          const eva = this.assessor.evaluateFace(
            faceW,
            faceH,
            faceConfidence,
            blurVar,
            landmarks5,
            frameWidth,
            frameHeight,
          );

          if (eva.gatePass) {
            faceCandidates.push([
              frameIndex,
              {
                landmarkScore: eva.landmarkScore,
                faceArea: eva.area,
                laplacianVariance: eva.blurVar,
                faceConfidence: eva.detConf,
              },
            ]);
          }
        }
      }

      // ── Entity gating ──
      const entityW = bbox.width;
      const entityH = bbox.height;
      if (entityW > 0 && entityH > 0) {
        const evaB = this.assessor.evaluateEntity(
          entityW,
          entityH,
          frameWidth,
          frameHeight,
          confidence,
        );

        if (evaB.gatePass) {
          entityCandidates.push([
            frameIndex,
            {
              entityArea: evaB.area,
              entityDetectionConfidence: evaB.detConf,
            },
          ]);
        }
      }
    }

    return { faceCandidates, entityCandidates };
  }

  // ── Best selection (k=-1): one face + one entity ──

  private performBestSelection(
    faceCandidates: Array<[number, FaceCandidateMetrics]>,
    entityCandidates: Array<[number, EntityCandidateMetrics]>,
  ): KeyframeResult[] {
    const results: KeyframeResult[] = [];

    const faceSorted = sortFaceCandidates(faceCandidates);
    if (faceSorted.length > 0) {
      const [fi, metrics] = faceSorted[0];
      results.push({
        frameIndex: fi,
        qualityScore: metrics.landmarkScore,
        keyframeType: "face",
        hasFace: true,
      });
    }

    const entitySorted = sortEntityCandidates(entityCandidates);
    if (entitySorted.length > 0) {
      const [fi, metrics] = entitySorted[0];
      results.push({
        frameIndex: fi,
        qualityScore: metrics.entityDetectionConfidence,
        keyframeType: "entity",
        hasFace: false,
      });
    }

    return results;
  }

  // ── TopK selection: face-first, entity supplement ──

  private performTopKSelection(
    faceCandidates: Array<[number, FaceCandidateMetrics]>,
    entityCandidates: Array<[number, EntityCandidateMetrics]>,
    k: number,
  ): KeyframeResult[] {
    const results: KeyframeResult[] = [];
    const selectedIndices = new Set<number>();

    // Face first
    const faceSorted = sortFaceCandidates(faceCandidates);
    for (const [fi, metrics] of faceSorted) {
      if (results.length >= k) break;
      selectedIndices.add(fi);
      results.push({
        frameIndex: fi,
        qualityScore: metrics.landmarkScore,
        keyframeType: "face",
        hasFace: true,
      });
    }

    // Entity supplement
    if (results.length < k) {
      const entityFiltered = entityCandidates.filter(
        ([fi]) => !selectedIndices.has(fi),
      );
      const entitySorted = sortEntityCandidates(entityFiltered);
      for (const [fi, metrics] of entitySorted) {
        if (results.length >= k) break;
        results.push({
          frameIndex: fi,
          qualityScore: metrics.entityDetectionConfidence,
          keyframeType: "entity",
          hasFace: false,
        });
      }
    }

    writeStderr(
      `[keyframe] Selected ${results.length} keyframes ` +
        `(${faceCandidates.length} face candidates, ` +
        `${entityCandidates.length} entity candidates)`,
    );

    return results;
  }
}

// ── Sorting helpers ──

/**
 * Sort face candidates by (landmark_score DESC, face_area DESC,
 * laplacian_variance DESC, face_confidence DESC, frameIndex ASC).
 */
function sortFaceCandidates(
  candidates: Array<[number, FaceCandidateMetrics]>,
): Array<[number, FaceCandidateMetrics]> {
  return [...candidates].sort((a, b) => {
    const [fiA, mA] = a;
    const [fiB, mB] = b;

    const dLmk = mB.landmarkScore - mA.landmarkScore;
    if (dLmk !== 0) return dLmk;
    const dArea = mB.faceArea - mA.faceArea;
    if (dArea !== 0) return dArea;
    const dBlur = mB.laplacianVariance - mA.laplacianVariance;
    if (dBlur !== 0) return dBlur;
    const dConf = mB.faceConfidence - mA.faceConfidence;
    if (dConf !== 0) return dConf;
    return fiA - fiB; // frame index tiebreaker
  });
}

/**
 * Sort entity candidates by (entity_area DESC,
 * entity_detection_confidence DESC, frameIndex ASC).
 */
function sortEntityCandidates(
  candidates: Array<[number, EntityCandidateMetrics]>,
): Array<[number, EntityCandidateMetrics]> {
  return [...candidates].sort((a, b) => {
    const [fiA, mA] = a;
    const [fiB, mB] = b;

    const dArea = mB.entityArea - mA.entityArea;
    if (dArea !== 0) return dArea;
    const dConf = mB.entityDetectionConfidence - mA.entityDetectionConfidence;
    if (dConf !== 0) return dConf;
    return fiA - fiB;
  });
}

// ── Utility helpers ──

/**
 * Parse flat landmark array [x1,y1,...,x5,y5] into [[x,y], ...] pairs.
 * Returns undefined if input is missing or wrong length.
 */
function parseLandmarks5(
  flat?: number[],
): Array<[number, number]> | undefined {
  if (!flat || flat.length < 10) return undefined;
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < 10; i += 2) {
    pts.push([flat[i], flat[i + 1]]);
  }
  return pts;
}

/**
 * Extract the face region from a full-frame grayscale buffer and compute
 * Laplacian variance for blur assessment.
 */
function computeFaceBlur(
  img: FrameImageData,
  faceBbox: BoundingBox,
): number {
  const x1 = Math.max(0, Math.round(faceBbox.x));
  const y1 = Math.max(0, Math.round(faceBbox.y));
  const x2 = Math.min(img.width, Math.round(faceBbox.x + faceBbox.width));
  const y2 = Math.min(img.height, Math.round(faceBbox.y + faceBbox.height));

  const cropW = x2 - x1;
  const cropH = y2 - y1;
  if (cropW < 3 || cropH < 3) return 0.0;

  // Extract face sub-region into contiguous buffer
  const faceBuf = new Uint8Array(cropW * cropH);
  for (let r = 0; r < cropH; r++) {
    const srcOff = (y1 + r) * img.width + x1;
    const dstOff = r * cropW;
    faceBuf.set(img.gray.subarray(srcOff, srcOff + cropW), dstOff);
  }

  return laplacianVariance(faceBuf, cropW, cropH);
}
