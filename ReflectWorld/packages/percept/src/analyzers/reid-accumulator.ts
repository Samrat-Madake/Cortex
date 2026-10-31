// packages/percept/src/analyzers/reid-accumulator.ts
//
// Multi-frame ReID accumulator: decides whether to create a new ReID entity,
// return gallery_update for existing entities, or accumulate pending embeddings
// for cross-segment consistency verification via max-clique.

import type { PendingEmbedding, DIdEntry, WorkingMemoryTarget } from "../types.js";
import { canAppendFaceGallery } from "../face-reid-policy.js";
import { cosineSimilarity, findMaxClique, type CliqueCandidate } from "./clique.js";
import {
  ACCUMULATOR_FACE_MIN_FRAMES,
  ACCUMULATOR_BODY_MIN_FRAMES,
  ACCUMULATOR_FACE_CONSISTENCY,
  ACCUMULATOR_BODY_CONSISTENCY,
  ACCUMULATOR_SINGLE_FACE_INIT_MAX_PITCH,
  ACCUMULATOR_SINGLE_FACE_INIT_MAX_YAW,
  ACCUMULATOR_SINGLE_FACE_INIT_QUALITY,
  BODY_REID_MATCH_THRESHOLD,
  FACE_REID_MATCH_THRESHOLD,
  PENDING_FACE_MAX,
  PENDING_BODY_MAX,
} from "../thresholds.js";

// ── Port interface for memory operations ──

export interface BatchInitMemoryPort {
  reserveEntityId(): string;
  reidSearch?(embedding: number[], type: "face" | "body"): Promise<Array<{
    entity_id: string;
    score: number;
    type?: "face" | "body";
    subject_index?: number | null;
    name?: string | null;
    first_seen?: string | number | null;
  }>>;
  reidBatchInit(request: {
    entity_id: string;
    face_vectors?: Array<{ vector: number[]; quality: number; yaw?: number; pitch?: number }>;
    body_vectors?: Array<{ vector: number[]; quality: number; body_yaw_ratio?: number; visibility?: string }>;
    category?: string;
    subject_index?: number;
    name?: string;
    first_seen?: string | number;
  }): Promise<{
    entity_id: string;
    face_slots_written: number;
    body_slots_written: number;
    subject_index?: number | null;
    name?: string | null;
    first_seen?: string | number | null;
  }>;
}

// ── Result discriminated union ──

export type AccumulatorResult =
  | {
      action: "match";
      entity_id: string;
      score: number;
      match_type: "face" | "body";
      subject_index?: number | null;
      name?: string | null;
      first_seen?: string | number | null;
    }
  | {
      action: "create";
      entity_id: string;
      face_slots: number;
      body_slots: number;
      subject_index?: number | null;
      name?: string | null;
      first_seen?: string | number | null;
      init_reason?: "face_clique" | "single_high_quality_face" | "body_clique";
    }
  | { action: "gallery_update" }
  | {
      action: "pending";
      pending_reason: "insufficient_evidence" | "batch_init_failed";
      pending_face: PendingEmbedding[];
      pending_body: PendingEmbedding[];
      pending_entity_id?: string;
      batch_init_error?: string;
      wm_entity_inconsistent?: {
        modality: "face";
        max_similarity: number;
        threshold: number;
        current_face_count: number;
        historical_face_count: number;
      };
    };

// ── Evaluation context ──

export interface AccumulatorContext {
  segmentId: string;
  cameraId: string;
  identity?: {
    category?: string;
    subject_index?: number;
    name?: string;
    first_seen?: string | number;
  };
}

// ── Registry-like read interface (only need get) ──

export interface RegistryReader {
  get(did: string): DIdEntry | undefined;
}

// ── Parsed target with bbox_ids and optional entity_id ──

export interface AccumulatorTarget {
  bbox_ids: string[];
  entity_id?: string;
  entity_id_source?: "current_reid" | "wm_inherited" | null;
}

export interface AccumulatorOptions {
  /**
   * false means the accumulator may still match an existing ReID entity and
   * update pending pools, but must not initialize a brand-new stable entity.
   * Used for parser-inferred anonymous WM continuity where creating a second
   * entity would be more harmful than waiting for stronger evidence.
   */
  allowCreate?: boolean;
}

// ── ReIdAccumulator ──

export class ReIdAccumulator {
  /**
   * Evaluate a single target and decide: create entity, gallery_update, or pending.
   *
   * @param ctx - Segment context (segmentId for dedup keys)
   * @param target - Parsed target with bbox_ids and optional entity_id
   * @param wmTarget - Working memory target (may have pending embeddings from prior segments)
   * @param registry - Detection registry reader for DIdEntry lookup
   * @param memory - Batch-init memory port for entity reservation and creation
   */
  async evaluate(
    ctx: AccumulatorContext,
    target: AccumulatorTarget,
    wmTarget: WorkingMemoryTarget | undefined,
    registry: RegistryReader,
    memory: BatchInitMemoryPort,
    options: AccumulatorOptions = {},
  ): Promise<AccumulatorResult> {
    // 1. Current-segment ReID already confirmed this entity → gallery_update.
    // A WM-inherited entity is only event-local continuity; do not treat it as
    // safe ReID evidence for writing until current features verify it.
    if (target.entity_id && target.entity_id_source !== "wm_inherited") {
      return { action: "gallery_update" };
    }

    // 2. Collect embedding pools from current segment + historical pending
    const { facePool, bodyPool } = this.collectPools(ctx, target, wmTarget, registry);

    if (target.entity_id && target.entity_id_source === "wm_inherited") {
      const wmEntityInconsistent = detectWmInheritedFaceInconsistency(ctx, target, wmTarget, registry);
      return {
        action: "pending",
        pending_reason: "insufficient_evidence",
        pending_face: facePool,
        pending_body: bodyPool,
        pending_entity_id: wmTarget?.pending_entity_id,
        ...(wmEntityInconsistent ? { wm_entity_inconsistent: wmEntityInconsistent } : {}),
      };
    }

    const allowCreate = options.allowCreate !== false;

    // 3. Try face clique first
    if (facePool.length >= ACCUMULATOR_FACE_MIN_FRAMES) {
      const faceCandidates: CliqueCandidate[] = facePool.map((pe, idx) => ({
        embedding: pe.embedding,
        quality: pe.quality,
        index: idx,
      }));

      const faceClique = findMaxClique(faceCandidates, ACCUMULATOR_FACE_CONSISTENCY, ACCUMULATOR_FACE_MIN_FRAMES);
      if (faceClique) {
        // Also attempt body clique (best-effort, not required for face-based create)
        let bodyClique: CliqueCandidate[] | null = null;
        if (bodyPool.length >= ACCUMULATOR_BODY_MIN_FRAMES) {
          const bodyCandidates: CliqueCandidate[] = bodyPool.map((pe, idx) => ({
            embedding: pe.embedding,
            quality: pe.quality,
            index: idx,
          }));
          bodyClique = findMaxClique(bodyCandidates, ACCUMULATOR_BODY_CONSISTENCY, ACCUMULATOR_BODY_MIN_FRAMES);
        }

        const faceVectors = faceClique.map((c) => {
          const pe = facePool[c.index]!;
          return { vector: pe.embedding, quality: pe.quality, yaw: pe.yaw, pitch: pe.pitch };
        });

        const bodyVectors = bodyClique
          ? bodyClique.map((c) => {
              const pe = bodyPool[c.index]!;
              return { vector: pe.embedding, quality: pe.quality, body_yaw_ratio: pe.body_yaw_ratio, visibility: pe.visibility };
            })
          : undefined;
        let entityId = wmTarget?.pending_entity_id;

        try {
          const existing = await findExistingEntity(memory, faceVectors, bodyVectors);
          if (existing) return existing;
          if (!allowCreate) {
            return {
              action: "pending",
              pending_reason: "insufficient_evidence",
              pending_face: facePool,
              pending_body: bodyPool,
              pending_entity_id: wmTarget?.pending_entity_id,
            };
          }

          entityId ??= memory.reserveEntityId();
          const result = await memory.reidBatchInit({
            entity_id: entityId,
            face_vectors: faceVectors,
            body_vectors: bodyVectors,
            ...ctx.identity,
          });
          return {
            action: "create",
            entity_id: result.entity_id,
            face_slots: result.face_slots_written,
            body_slots: result.body_slots_written,
            subject_index: result.subject_index,
            name: result.name,
            first_seen: result.first_seen,
            init_reason: "face_clique",
          };
        } catch (err) {
          return {
            action: "pending",
            pending_reason: "batch_init_failed",
            pending_face: facePool,
            pending_body: bodyPool,
            pending_entity_id: entityId,
            batch_init_error: err instanceof Error ? err.message : String(err),
          };
        }
      }
    }

    // 4. Fast-path a single clearly high-quality, near-frontal face.
    // This preserves the old one-face initialization behavior for strong evidence,
    // while keeping low-quality/side-face cases in the multi-frame pending path.
    if (facePool.length === 1 && isHighQualitySingleFaceInit(facePool[0]!)) {
      const face = facePool[0]!;
      const faceVectors = [{ vector: face.embedding, quality: face.quality, yaw: face.yaw, pitch: face.pitch }];
      let entityId = wmTarget?.pending_entity_id;

      try {
        const existing = await findExistingEntity(memory, faceVectors);
        if (existing) return existing;
        if (!allowCreate) {
          return {
            action: "pending",
            pending_reason: "insufficient_evidence",
            pending_face: facePool,
            pending_body: bodyPool,
            pending_entity_id: wmTarget?.pending_entity_id,
          };
        }

        entityId ??= memory.reserveEntityId();
        const result = await memory.reidBatchInit({
          entity_id: entityId,
          face_vectors: faceVectors,
          ...ctx.identity,
        });
        return {
          action: "create",
          entity_id: result.entity_id,
          face_slots: result.face_slots_written,
          body_slots: result.body_slots_written,
          subject_index: result.subject_index,
          name: result.name,
          first_seen: result.first_seen,
          init_reason: "single_high_quality_face",
        };
      } catch (err) {
        return {
          action: "pending",
          pending_reason: "batch_init_failed",
          pending_face: facePool,
          pending_body: bodyPool,
          pending_entity_id: entityId,
          batch_init_error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // 5. Try body-only clique (no qualifying faces or face clique failed)
    if (bodyPool.length >= ACCUMULATOR_BODY_MIN_FRAMES) {
      const bodyCandidates: CliqueCandidate[] = bodyPool.map((pe, idx) => ({
        embedding: pe.embedding,
        quality: pe.quality,
        index: idx,
      }));

      const bodyClique = findMaxClique(bodyCandidates, ACCUMULATOR_BODY_CONSISTENCY, ACCUMULATOR_BODY_MIN_FRAMES);
      if (bodyClique) {
        const bodyVectors = bodyClique.map((c) => {
          const pe = bodyPool[c.index]!;
          return { vector: pe.embedding, quality: pe.quality, body_yaw_ratio: pe.body_yaw_ratio, visibility: pe.visibility };
        });
        let entityId = wmTarget?.pending_entity_id;

        try {
          const existing = await findExistingEntity(memory, undefined, bodyVectors);
          if (existing) return existing;
          if (!allowCreate) {
            return {
              action: "pending",
              pending_reason: "insufficient_evidence",
              pending_face: facePool,
              pending_body: bodyPool,
              pending_entity_id: wmTarget?.pending_entity_id,
            };
          }

          entityId ??= memory.reserveEntityId();
          const result = await memory.reidBatchInit({
            entity_id: entityId,
            body_vectors: bodyVectors,
            ...ctx.identity,
          });
          return {
            action: "create",
            entity_id: result.entity_id,
            face_slots: result.face_slots_written,
            body_slots: result.body_slots_written,
            subject_index: result.subject_index,
            name: result.name,
            first_seen: result.first_seen,
            init_reason: "body_clique",
          };
        } catch (err) {
          return {
            action: "pending",
            pending_reason: "batch_init_failed",
            pending_face: facePool,
            pending_body: bodyPool,
            pending_entity_id: entityId,
            batch_init_error: err instanceof Error ? err.message : String(err),
          };
        }
      }
    }

    // 6. Neither threshold reached
    return {
      action: "pending",
      pending_reason: "insufficient_evidence",
      pending_face: facePool,
      pending_body: bodyPool,
    };
  }

  /**
   * Collect face and body embedding pools from:
   *   (a) current segment DIdEntries (via target.bbox_ids)
   *   (b) historical pending embeddings from wmTarget
   *
   * Dedup by (segment_id, did). Cap to PENDING_*_MAX, evict lowest quality.
   */
  private collectPools(
    ctx: AccumulatorContext,
    target: AccumulatorTarget,
    wmTarget: WorkingMemoryTarget | undefined,
    registry: RegistryReader,
  ): { facePool: PendingEmbedding[]; bodyPool: PendingEmbedding[] } {
    // Dedup set: "segment_id:did"
    const faceSeenKeys = new Set<string>();
    const bodySeenKeys = new Set<string>();
    let facePool: PendingEmbedding[] = [];
    let bodyPool: PendingEmbedding[] = [];

    // (a) Current segment entries from registry
    for (const did of target.bbox_ids) {
      const entry = registry.get(did);
      if (!entry) continue;

      // Face: gallery-append-eligible faces qualify for pending pools.
      // Single-face entity creation remains stricter in isHighQualitySingleFaceInit().
      if (canAppendFaceGallery(entry.face) && entry.face?.embedding) {
        const key = `${ctx.segmentId}:${did}`;
        if (!faceSeenKeys.has(key)) {
          faceSeenKeys.add(key);
          facePool.push({
            embedding: entry.face.embedding,
            quality: entry.face.quality ?? 0,
            segment_id: ctx.segmentId,
            did,
            yaw: entry.face.pose?.yaw,
            pitch: entry.face.pose?.pitch,
          });
        }
      }

      // Body: any entry with body embedding
      if (entry.body?.embedding) {
        const key = `${ctx.segmentId}:${did}`;
        if (!bodySeenKeys.has(key)) {
          bodySeenKeys.add(key);
          bodyPool.push({
            embedding: entry.body.embedding,
            quality: entry.body.quality ?? 0,
            segment_id: ctx.segmentId,
            did,
            body_yaw_ratio: entry.body.body_yaw_ratio,
            visibility: entry.body.visibility,
          });
        }
      }
    }

    // (b) Historical pending embeddings from working memory target
    if (wmTarget?.pending_face_embeddings) {
      for (const pe of wmTarget.pending_face_embeddings) {
        const key = `${pe.segment_id}:${pe.did}`;
        if (!faceSeenKeys.has(key)) {
          faceSeenKeys.add(key);
          facePool.push(pe);
        }
      }
    }
    if (wmTarget?.pending_body_embeddings) {
      for (const pe of wmTarget.pending_body_embeddings) {
        const key = `${pe.segment_id}:${pe.did}`;
        if (!bodySeenKeys.has(key)) {
          bodySeenKeys.add(key);
          bodyPool.push(pe);
        }
      }
    }

    // Cap pools: keep highest quality, evict lowest
    facePool = capPool(facePool, PENDING_FACE_MAX);
    bodyPool = capPool(bodyPool, PENDING_BODY_MAX);

    return { facePool, bodyPool };
  }
}

function detectWmInheritedFaceInconsistency(
  ctx: AccumulatorContext,
  target: AccumulatorTarget,
  wmTarget: WorkingMemoryTarget | undefined,
  registry: RegistryReader,
): Extract<AccumulatorResult, { action: "pending" }>["wm_entity_inconsistent"] | undefined {
  if (!target.entity_id || target.entity_id_source !== "wm_inherited") return undefined;
  const historicalFaces = wmTarget?.pending_face_embeddings ?? [];
  if (historicalFaces.length === 0) return undefined;

  const currentFaces: PendingEmbedding[] = [];
  for (const did of target.bbox_ids) {
    const entry = registry.get(did);
    if (!entry?.face?.embedding) continue;
    if (entry.face.entity_id === target.entity_id) return undefined;
    if (!canAppendFaceGallery(entry.face)) continue;
    currentFaces.push({
      embedding: entry.face.embedding,
      quality: entry.face.quality ?? 0,
      segment_id: ctx.segmentId,
      did,
      yaw: entry.face.pose?.yaw,
      pitch: entry.face.pose?.pitch,
    });
  }
  if (currentFaces.length === 0) return undefined;

  let maxSimilarity = -Infinity;
  for (const current of currentFaces) {
    for (const historical of historicalFaces) {
      maxSimilarity = Math.max(maxSimilarity, cosineSimilarity(current.embedding, historical.embedding));
    }
  }
  if (!Number.isFinite(maxSimilarity)) return undefined;
  if (maxSimilarity >= ACCUMULATOR_FACE_CONSISTENCY) return undefined;

  return {
    modality: "face",
    max_similarity: Number(maxSimilarity.toFixed(4)),
    threshold: ACCUMULATOR_FACE_CONSISTENCY,
    current_face_count: currentFaces.length,
    historical_face_count: historicalFaces.length,
  };
}

function isHighQualitySingleFaceInit(face: PendingEmbedding): boolean {
  if (face.quality < ACCUMULATOR_SINGLE_FACE_INIT_QUALITY) return false;
  if (face.yaw == null || Math.abs(face.yaw) > ACCUMULATOR_SINGLE_FACE_INIT_MAX_YAW) return false;
  if (face.pitch == null || Math.abs(face.pitch) > ACCUMULATOR_SINGLE_FACE_INIT_MAX_PITCH) return false;
  return true;
}

async function findExistingEntity(
  memory: BatchInitMemoryPort,
  faceVectors?: Array<{ vector: number[] }>,
  bodyVectors?: Array<{ vector: number[] }>,
): Promise<Extract<AccumulatorResult, { action: "match" }> | undefined> {
  if (!memory.reidSearch) return undefined;

  let best: Extract<AccumulatorResult, { action: "match" }> | undefined;
  const consider = (
    result: {
      entity_id: string;
      score: number;
      subject_index?: number | null;
      name?: string | null;
      first_seen?: string | number | null;
    } | undefined,
    matchType: "face" | "body",
    threshold: number,
  ) => {
    if (!result || result.score < threshold) return;
    if (best?.match_type === "face" && matchType === "body") return;
    if (best?.match_type === matchType && best.score >= result.score) return;
    best = {
      action: "match",
      entity_id: result.entity_id,
      score: result.score,
      match_type: matchType,
      subject_index: result.subject_index,
      name: result.name,
      first_seen: result.first_seen,
    };
  };

  for (const face of faceVectors ?? []) {
    consider((await memory.reidSearch(face.vector, "face"))[0], "face", FACE_REID_MATCH_THRESHOLD);
  }
  if (best?.match_type === "face") return best;

  for (const body of bodyVectors ?? []) {
    consider((await memory.reidSearch(body.vector, "body"))[0], "body", BODY_REID_MATCH_THRESHOLD);
  }

  return best;
}

/**
 * Cap a pool to maxSize entries, keeping highest quality.
 * Sort descending by quality, take first maxSize.
 */
function capPool(pool: PendingEmbedding[], maxSize: number): PendingEmbedding[] {
  if (pool.length <= maxSize) return pool;
  return pool
    .slice()
    .sort((a, b) => b.quality - a.quality)
    .slice(0, maxSize);
}
