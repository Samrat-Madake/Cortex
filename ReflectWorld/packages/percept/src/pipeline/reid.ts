import type { BodyReIdMemoryPort } from "../analyzers/body-reid-entry.js";
import type { MemoryReIdPort } from "../analyzers/unified-reid-matcher.js";
import { BODY_REID_MATCH_THRESHOLD } from "../thresholds.js";
import type { DIdEntry } from "../types.js";
import type { ParsedSubjectProposalTarget } from "../vlm-output-parser.js";
import type { PipelineMemory } from "./types.js";

export interface BodyGalleryVector {
  vector: number[];
  quality: number;
  body_yaw_ratio?: number;
  visibility?: "full" | "upper" | "partial";
}

export function bodyGalleryVectorFromEntry(entry: DIdEntry): BodyGalleryVector | undefined {
  if (!entry.body?.embedding) return undefined;
  return {
    vector: entry.body.embedding,
    quality: entry.body.quality ?? 0,
    body_yaw_ratio: entry.body.body_yaw_ratio,
    visibility: entry.body.visibility,
  };
}

/**
 * Select a body vector that is safe to append to an existing entity gallery.
 * Unmatched body vectors for pre-existing entities must be verified by body
 * search before write; otherwise VLM grouping mistakes can pollute galleries.
 */
export async function selectVerifiedBodyGalleryVector(
  target: ParsedSubjectProposalTarget,
  registry: Pick<Map<string, DIdEntry>, "get">,
  memory?: Pick<PipelineMemory, "reidSearch">,
): Promise<BodyGalleryVector | undefined> {
  if (!target.entity_id) return undefined;

  let confirmedBody: BodyGalleryVector | undefined;
  let upsertDidBody: BodyGalleryVector | undefined;
  let bestUnmatchedBody: BodyGalleryVector | undefined;
  const upsertDid = target.upsert_candidate?.did;

  for (const did of target.bbox_ids) {
    const entry = registry.get(did);
    if (!entry) continue;
    const body = bodyGalleryVectorFromEntry(entry);
    if (!body) continue;

    if (entry.body?.entity_id && entry.body.entity_id === target.entity_id) {
      if (!confirmedBody || body.quality > confirmedBody.quality) confirmedBody = body;
    } else if (!entry.body?.entity_id) {
      if (did === upsertDid && (!upsertDidBody || body.quality > upsertDidBody.quality)) {
        upsertDidBody = body;
      }
      if (!bestUnmatchedBody || body.quality > bestUnmatchedBody.quality) {
        bestUnmatchedBody = body;
      }
    }
  }

  if (confirmedBody) return confirmedBody;
  if (target.upsert_candidate && upsertDidBody) return upsertDidBody;
  if (!bestUnmatchedBody || !memory?.reidSearch) return undefined;

  try {
    const verifyResults = await memory.reidSearch(bestUnmatchedBody.vector, "body");
    const topMatch = verifyResults[0];
    if (topMatch && topMatch.entity_id === target.entity_id && topMatch.score >= BODY_REID_MATCH_THRESHOLD) {
      return bestUnmatchedBody;
    }
  } catch {
    // Verification failed; skip body gallery update.
  }
  return undefined;
}

export async function reidMatchOrCreate(
  memory: PipelineMemory | undefined,
  primary: { type: "face" | "body"; vector: number[]; threshold: number },
  embeddings: Parameters<NonNullable<PipelineMemory["reidUpsert"]>>[0],
  identity: Parameters<NonNullable<PipelineMemory["reidUpsert"]>>[1],
): Promise<{
  entity_id: string;
  is_new: boolean;
  subject_index?: number | null;
  name?: string | null;
  first_seen?: string | number | null;
} | undefined> {
  if (memory?.reidSearch) {
    try {
      const topMatch = (await memory.reidSearch(primary.vector, primary.type))[0];
      if (topMatch && topMatch.score >= primary.threshold) {
        return {
          entity_id: topMatch.entity_id,
          is_new: false,
          subject_index: topMatch.subject_index,
          name: topMatch.name,
          first_seen: topMatch.first_seen,
        };
      }
    } catch {
      // Search failures are non-fatal; fall through to the existing create path.
    }
  }

  const created = await memory?.reidUpsert?.(embeddings, identity);
  return created ? { ...created, is_new: true } : undefined;
}

export function getMemoryReIdPort(memory?: PipelineMemory): MemoryReIdPort | undefined {
  if (!memory?.reidSearch || !memory.reidUpsert) return undefined;
  return {
    reidSearch: (embedding, type) => memory.reidSearch!(embedding, type),
    reidUpsert: (embeddings) => memory.reidUpsert!(embeddings),
    reidGalleryUpdate: memory.reidGalleryUpdate
      ? (entityId, embeddings) => memory.reidGalleryUpdate!(entityId, embeddings)
      : undefined,
  };
}

/** Search-only memory port for pre-VLM body ReID queries. Only requires reidSearch. */
export function getMemorySearchPort(memory?: PipelineMemory): BodyReIdMemoryPort | undefined {
  if (!memory?.reidSearch) return undefined;
  return {
    reidSearch: (embedding, type) => memory.reidSearch!(embedding, type),
  };
}
