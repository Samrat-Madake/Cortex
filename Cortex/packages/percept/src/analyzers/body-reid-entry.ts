// packages/percept/src/analyzers/body-reid-entry.ts
//
// Pre-VLM body ReID: extract embedding + search only. No writes.
// Gallery updates and new entity creation are handled in SP-6 (post-VLM),
// consistent with the face ReID write boundary.

import type { Frame, BoundingBox } from "@cortex/shared";
import type { PoseProvider, ReidProvider } from "../providers/types.js";
import { scoreBodyCompleteness } from "./body-completeness.js";
import { computeBodyDiversity } from "./body-pose-diversity.js";
import { BODY_REID_MATCH_THRESHOLD } from "../thresholds.js";
import { writeStderr } from "@cortex/shared";

/** Maximum person entries to run body ReID on per segment. */
const MAX_BODY_REID_PER_SEGMENT = 8;

/** Input for a single person body ReID query. */
export interface BodyReIdInput {
  frameIndex: number;
  personBbox: BoundingBox;
  personConfidence: number;
}

/** Result for a single person body ReID query. */
export interface BodyReIdResult {
  frameIndex: number;
  personBbox: BoundingBox;
  skipped: boolean;
  skipReason?: "incomplete_body" | "extraction_failed" | "no_body_provider";
  /** Body embedding (768d). Populated even when no match found — used by SP-6 for writes. */
  bodyEmbedding?: number[];
  /** Body quality = area * confidence * completeness. Used by gallery update in SP-6. */
  bodyQuality?: number;
  /** Entity_id from body search (query-only). undefined = no match. */
  bodyEntityId?: string;
  /** Body match confidence from search. */
  bodyMatchScore?: number;
  /** Body completeness category. */
  poseCategory?: string;
  /** Body yaw ratio (0-1, shoulder width ratio) from keypoints. */
  bodyYawRatio?: number;
  /** Body visibility category from keypoints. */
  bodyVisibility?: "full" | "upper" | "partial";
}

/** Memory operations needed for body ReID (search only, no writes). */
export interface BodyReIdMemoryPort {
  reidSearch(embedding: number[], type: "face" | "body"): Promise<Array<{
    entity_id: string;
    score: number;
    type: "face" | "body";
  }>>;
}

/**
 * Pre-VLM body ReID for the Subject Proposal pipeline.
 *
 * For each person detection:
 * 1. RTMPose estimates pose -> body completeness check
 * 2. If body complete -> CLIP-ReID extracts body embedding
 * 3. Search reid_entity for match (query-only, NO upsert, NO gallery-update)
 * 4. Return embedding + match candidate for SP-6 to decide on writes
 *
 * Fail-open: if pose provider is unavailable, completeness check is skipped.
 * Errors per-person are isolated.
 */
export async function runPerBodyReId(
  inputs: BodyReIdInput[],
  frames: Frame[],
  poseProvider: PoseProvider | undefined,
  bodyReidProvider: ReidProvider | undefined,
  memory: BodyReIdMemoryPort | undefined,
): Promise<BodyReIdResult[]> {
  if (!bodyReidProvider) {
    return inputs.map((inp) => ({
      frameIndex: inp.frameIndex,
      personBbox: inp.personBbox,
      skipped: true,
      skipReason: "no_body_provider" as const,
    }));
  }

  const capped = inputs.slice(0, MAX_BODY_REID_PER_SEGMENT);
  const results: BodyReIdResult[] = [];

  for (const inp of capped) {
    try {
      const frame = frames[inp.frameIndex];
      if (!frame) {
        results.push({ frameIndex: inp.frameIndex, personBbox: inp.personBbox, skipped: true, skipReason: "extraction_failed" });
        continue;
      }
      const imageBuffer = Buffer.from(frame.data, "base64");

      // Step 1: Pose completeness check (fail-open — skip check if no provider).
      let completenessScore = 1.0;
      let poseCategory = "no_pose_check";
      let poseKeypoints: Array<{ x: number; y: number; confidence: number }> | undefined;
      if (poseProvider) {
        try {
          const poseResult = await poseProvider.estimatePose({
            imageBuffer,
            options: { bbox: inp.personBbox },
          });
          poseKeypoints = poseResult.keypoints;
          const completeness = scoreBodyCompleteness(poseResult.keypoints);
          completenessScore = completeness.score;
          poseCategory = completeness.category;
          if (!completeness.shouldExtractBody) {
            results.push({
              frameIndex: inp.frameIndex,
              personBbox: inp.personBbox,
              skipped: true,
              skipReason: "incomplete_body",
              poseCategory,
            });
            continue;
          }
        } catch {
          poseCategory = "pose_error";
        }
      }

      // Step 2: Extract body embedding via CLIP-ReID.
      let bodyEmbedding: number[];
      try {
        const result = await bodyReidProvider.extractEmbedding({
          imageBuffer,
          options: { bbox: inp.personBbox },
        });
        bodyEmbedding = result.embedding;
      } catch {
        results.push({
          frameIndex: inp.frameIndex,
          personBbox: inp.personBbox,
          skipped: true,
          skipReason: "extraction_failed",
          poseCategory,
        });
        continue;
      }

      const bodyQuality =
        inp.personBbox.width * inp.personBbox.height * inp.personConfidence * completenessScore;

      // Step 2.5: Compute body diversity metadata from pose keypoints.
      let bodyYawRatio: number | undefined;
      let bodyVisibility: "full" | "upper" | "partial" | undefined;
      if (poseKeypoints) {
        const diversity = computeBodyDiversity(poseKeypoints);
        bodyYawRatio = diversity.shoulder_ratio;
        bodyVisibility = diversity.visibility;
      }

      // Step 3: Query-only search (no upsert, no gallery-update).
      let bodyEntityId: string | undefined;
      let bodyMatchScore: number | undefined;
      if (memory) {
        try {
          const searchResults = await memory.reidSearch(bodyEmbedding, "body");
          const best = searchResults.find((r) => r.score >= BODY_REID_MATCH_THRESHOLD);
          if (best) {
            bodyEntityId = best.entity_id;
            bodyMatchScore = best.score;
          }
          // Diagnostic: log top score when gallery has entries but match fails
          if (!best && searchResults.length > 0) {
            const top = searchResults[0]!;
            writeStderr(`[body-reid-score] miss top=${top.score.toFixed(3)} entity=${top.entity_id} threshold=${BODY_REID_MATCH_THRESHOLD}`);
          }
        } catch { /* search failed — proceed without match */ }
      }

      results.push({
        frameIndex: inp.frameIndex,
        personBbox: inp.personBbox,
        skipped: false,
        bodyEmbedding,
        bodyQuality,
        bodyEntityId,
        bodyMatchScore,
        poseCategory,
        bodyYawRatio,
        bodyVisibility,
      });
    } catch {
      results.push({
        frameIndex: inp.frameIndex,
        personBbox: inp.personBbox,
        skipped: true,
        skipReason: "extraction_failed",
      });
    }
  }

  // Append skip results for entries that exceeded the per-segment cap.
  for (let i = capped.length; i < inputs.length; i++) {
    results.push({
      frameIndex: inputs[i]!.frameIndex,
      personBbox: inputs[i]!.personBbox,
      skipped: true,
      skipReason: "extraction_failed",
    });
  }

  return results;
}
