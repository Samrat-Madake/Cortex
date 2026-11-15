// packages/percept/src/analyzers/reid-entry.ts
import type { Frame } from "@cortex/shared";
import type { ModelRouter } from "../providers/model-router.js";
import type { MemoryReIdPort } from "./unified-reid-matcher.js";
import type { QualifiedFace } from "./subject-proposal-analyzer.js";
import { estimateFacePose, poseFactor, type FacePose } from "./face-pose.js";
import { FACE_REID_MATCH_THRESHOLD } from "../thresholds.js";

/** Per-face ReID query result. */
export interface FaceReIdResult {
  face: QualifiedFace;
  embedding?: number[];
  pose?: FacePose;
  quality?: number;
  /** Entity ID from ReID search (query-only, no upsert). undefined = no match. */
  entity_id?: string;
  /** ReID match confidence. */
  confidence?: number;
  /** Historical behavior from matched entity. */
  history_behavior?: string;
  subject_index?: number | null;
  name?: string | null;
  first_seen?: string | number | null;
  /** Top ReID search result, recorded even when below threshold for debugging. */
  top_entity_id?: string;
  top_score?: number;
  miss_reason?: string;
}

/**
 * Per-face ReID: extract embedding, estimate pose, compute quality,
 * and QUERY (not upsert) memory for each QualifiedFace independently.
 *
 * QUERY-ONLY: does NOT create new entities or update gallery.
 * Entity creation is deferred to pipeline post-VLM (upsert_candidate path).
 * Gallery updates are handled by pipeline after VLM aggregation.
 *
 * Errors are handled per-face — a single failure does not abort the batch.
 */
export async function runPerFaceReId(
  faces: QualifiedFace[],
  frames: Frame[],
  router: ModelRouter,
  memory?: MemoryReIdPort,
): Promise<FaceReIdResult[]> {
  const faceReid = router.getReidProvider("face-reid");
  const results: FaceReIdResult[] = [];

  for (const face of faces) {
    try {
      // Step 1: Extract ArcFace embedding.
      let embedding: number[] | undefined;
      if (faceReid) {
        const frame = frames[face.frameIndex];
        if (frame) {
          const imageBuffer = Buffer.from(frame.data, "base64");
          const result = await faceReid.extractEmbedding({
            imageBuffer,
            options: { bbox: face.faceBbox, landmarks: face.faceLandmarks },
          });
          if (result.embedding.length > 0) {
            embedding = Array.from(new Float32Array(result.embedding));
          }
        }
      }

      // Step 2: Estimate pose from landmarks.
      const pose = estimateFacePose(face.faceLandmarks);

      // Step 3: Compute quality.
      const faceArea = face.faceBbox.width * face.faceBbox.height;
      const pf = pose ? poseFactor(pose.yaw, pose.pitch) : 1;
      const quality = pf * (face.faceConfidence + faceArea * 1e-7);

      // Step 4: Query-only ReID search (NO upsert, NO gallery update).
      let entity_id: string | undefined;
      let confidence: number | undefined;
      let history_behavior: string | undefined;
      let subject_index: number | null | undefined;
      let name: string | null | undefined;
      let first_seen: string | number | null | undefined;
      let top_entity_id: string | undefined;
      let top_score: number | undefined;
      let miss_reason: string | undefined;
      if (memory?.reidSearch && embedding) {
        try {
          const searchResults = await memory.reidSearch(embedding, "face");
          const best = searchResults[0];
          top_entity_id = best?.entity_id;
          top_score = best?.score;
          if (best && best.score >= FACE_REID_MATCH_THRESHOLD) {
            entity_id = best.entity_id;
            confidence = best.score;
            const parts: string[] = [];
            if (best.semantic_memories?.length) parts.push("Patterns: " + best.semantic_memories.join("; "));
            if (best.episodic_memories?.length) parts.push("Recent: " + best.episodic_memories.join("; "));
            history_behavior = parts.length > 0 ? parts.join("\n") : undefined;
            subject_index = best.subject_index;
            name = best.name;
            first_seen = best.first_seen;
          } else {
            miss_reason = best
              ? `top_score_lt_${FACE_REID_MATCH_THRESHOLD}`
              : "no_search_result";
          }
        } catch {
          miss_reason = "search_failed";
        }
      } else if (!embedding) {
        miss_reason = "missing_embedding";
      } else if (!memory?.reidSearch) {
        miss_reason = "missing_reid_search";
      }

      results.push({
        face,
        embedding,
        pose,
        quality,
        entity_id,
        confidence,
        history_behavior,
        subject_index,
        name,
        first_seen,
        top_entity_id,
        top_score,
        miss_reason,
      });
    } catch {
      results.push({ face });
    }
  }

  return results;
}
