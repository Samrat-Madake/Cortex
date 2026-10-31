// packages/percept/src/analyzers/detection-analyzer.ts
import type { Frame } from "@reflectworld/shared";
import type { DetectionOutput } from "../types.js";
import type { ModelRouter } from "../providers/model-router.js";
import type { InferInput } from "../providers/types.js";
import { FaceBodyAssociator } from "./face-body-associator.js";

export interface PerFrameFaceDetectionDebug {
  frame_idx: number;
  person_count: number;
  raw_face_count: number;
  associated_face_count: number;
  skipped_reason?: "no_person_detection" | "no_face_detector";
  raw_faces?: Array<{
    face_index: number;
    bbox: { x: number; y: number; width: number; height: number };
    confidence: number;
    short_edge: number;
    landmarks_count: number;
  }>;
  detector_debug?: Record<string, unknown>;
  associations?: Array<{
    body_detection_index: number;
    face_index: number;
    score: number;
    person_bbox: { x: number; y: number; width: number; height: number };
    face_bbox: { x: number; y: number; width: number; height: number };
  }>;
}

/**
 * Per-frame face detection + association with pre-existing general detections.
 * Used when frame-level object detections are supplied on the segment; only
 * RetinaFace runs at segment level, and only for frames with person detections.
 *
 * @param frames - Segment frames (base64 JPEG)
 * @param generalDetections - Per-frame general detections already converted to DetectionOutput format
 * @param router - ModelRouter for face detector resolution
 * @returns A copied DetectionOutput array with face detections attached to person detections.
 */
export async function runPerFrameFaceDetection(
  frames: Frame[],
  generalDetections: DetectionOutput[],
  router: ModelRouter,
): Promise<{ detections: DetectionOutput[]; latency_ms: number; debug: PerFrameFaceDetectionDebug[] }> {
  const enrichedDetections = generalDetections.map((frameDetections) => ({
    detections: frameDetections.detections.map((d) => ({ ...d })),
  }));
  const faceDetector = router.getDetector("face-detection");
  if (!faceDetector) {
    return {
      detections: enrichedDetections,
      latency_ms: 0,
      debug: enrichedDetections.map((det, i) => ({
        frame_idx: i,
        person_count: det.detections.filter((d) => d.label === "person").length,
        raw_face_count: 0,
        associated_face_count: 0,
        skipped_reason: "no_face_detector",
      })),
    };
  }

  const start = performance.now();
  const associator = new FaceBodyAssociator();
  const debug: PerFrameFaceDetectionDebug[] = [];

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!;
    const det = enrichedDetections[i];
    if (!det) continue;
    const personCount = det.detections.filter((d) => d.label === "person").length;

    // Skip frames without person detection — no person means no face to find.
    if (personCount === 0) {
      debug.push({
        frame_idx: i,
        person_count: 0,
        raw_face_count: 0,
        associated_face_count: 0,
        skipped_reason: "no_person_detection",
      });
      continue;
    }

    const input: InferInput = { imageBuffer: Buffer.from(frame.data, "base64") };
    const faceResult = await faceDetector.detect(input);

    const faceDetections = faceResult?.boxes.map((b) => ({
      bbox: { x: b.x1, y: b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1 },
      confidence: b.confidence,
      landmarks: b.landmarks,
    })) ?? [];

    const associations = faceDetections.length > 0
      ? associator.associate(det.detections, faceDetections)
      : [];
    if (associations.length > 0) {
      for (const assoc of associations) {
        const body = det.detections[assoc.body_index];
        const face = faceDetections[assoc.face_index];
        if (body && face) {
          body.face = face;
        }
      }
    }
    debug.push({
      frame_idx: i,
      person_count: personCount,
      raw_face_count: faceDetections.length,
      associated_face_count: associations.length,
      raw_faces: faceDetections.map((face, faceIndex) => ({
        face_index: faceIndex,
        bbox: face.bbox,
        confidence: face.confidence,
        short_edge: Math.min(face.bbox.width, face.bbox.height),
        landmarks_count: face.landmarks?.length ?? 0,
      })),
      detector_debug: faceResult?.debug,
      associations: associations.map((assoc) => {
        const body = det.detections[assoc.body_index]!;
        const face = faceDetections[assoc.face_index]!;
        return {
          body_detection_index: assoc.body_index,
          face_index: assoc.face_index,
          score: assoc.score,
          person_bbox: body.bbox,
          face_bbox: face.bbox,
        };
      }),
    });
  }

  return { detections: enrichedDetections, latency_ms: performance.now() - start, debug };
}
