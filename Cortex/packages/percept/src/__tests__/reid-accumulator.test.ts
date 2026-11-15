// packages/percept/src/__tests__/reid-accumulator.test.ts
import { describe, it, expect, vi } from "vitest";
import {
  ReIdAccumulator,
  type BatchInitMemoryPort,
  type AccumulatorContext,
  type AccumulatorTarget,
  type RegistryReader,
} from "../analyzers/reid-accumulator.js";
import type { DIdEntry, WorkingMemoryTarget, PendingEmbedding } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers: build mock registry and memory port
// ---------------------------------------------------------------------------

/** Create a DIdEntry with writable face (5 landmarks, quality >= 0.5, pose within +-45). */
function writableFaceEntry(
  did: string,
  frameIdx: number,
  embedding: number[],
  quality: number,
  opts?: { yaw?: number; pitch?: number },
): DIdEntry {
  return {
    did,
    frame_idx: frameIdx,
    bbox: { x: 0, y: 0, width: 100, height: 200 },
    class_name: "person",
    confidence: 0.9,
    face: {
      bbox: { x: 10, y: 10, width: 50, height: 50 },
      landmarks: [
        { x: 20, y: 20 }, { x: 40, y: 20 },
        { x: 30, y: 35 }, { x: 22, y: 45 }, { x: 38, y: 45 },
      ],
      pose: { yaw: opts?.yaw ?? 0, pitch: opts?.pitch ?? 0, roll: 0 },
      sharpness: 80,
      embedding,
      quality,
    },
  };
}

/** Create a DIdEntry with bad face (no landmarks). */
function badFaceEntry(did: string, frameIdx: number, embedding: number[]): DIdEntry {
  return {
    did,
    frame_idx: frameIdx,
    bbox: { x: 0, y: 0, width: 100, height: 200 },
    class_name: "person",
    confidence: 0.9,
    face: {
      bbox: { x: 10, y: 10, width: 50, height: 50 },
      embedding,
      quality: 0.8,
      // No landmarks → isReidWritableFace returns false
    },
  };
}

/** Create a DIdEntry with body embedding only (no face). */
function bodyOnlyEntry(
  did: string,
  frameIdx: number,
  embedding: number[],
  quality: number,
  opts?: { body_yaw_ratio?: number; visibility?: "full" | "upper" | "partial" },
): DIdEntry {
  return {
    did,
    frame_idx: frameIdx,
    bbox: { x: 0, y: 0, width: 100, height: 200 },
    class_name: "person",
    confidence: 0.9,
    body: {
      embedding,
      quality,
      body_yaw_ratio: opts?.body_yaw_ratio,
      visibility: opts?.visibility,
    },
  };
}

/** Create a mock registry from a map of did → DIdEntry. */
function mockRegistry(entries: Map<string, DIdEntry>): RegistryReader {
  return { get: (did: string) => entries.get(did) };
}

/** Create a mock BatchInitMemoryPort with configurable behavior. */
function mockMemory(opts?: {
  batchInitResult?: { entity_id: string; face_slots_written: number; body_slots_written: number };
  batchInitError?: Error;
  searchResults?: Array<{ entity_id: string; score: number; subject_index?: number | null; name?: string | null; first_seen?: string | number | null }>;
}): BatchInitMemoryPort {
  let entityCounter = 0;
  return {
    reserveEntityId: vi.fn(() => `entity_${++entityCounter}`),
    ...(opts?.searchResults
      ? { reidSearch: vi.fn().mockResolvedValue(opts.searchResults) }
      : {}),
    reidBatchInit: opts?.batchInitError
      ? vi.fn().mockRejectedValue(opts.batchInitError)
      : vi.fn().mockResolvedValue(
          opts?.batchInitResult ?? { entity_id: "entity_1", face_slots_written: 2, body_slots_written: 0 },
        ),
  };
}

/** Default accumulator context. */
function ctx(segmentId = "seg1"): AccumulatorContext {
  return { segmentId, cameraId: "cam1" };
}

/** Build a consistent embedding close to the base (high cosine sim). */
function similarEmbedding(base: number[], noise = 0.05): number[] {
  return base.map((v) => v + (Math.random() - 0.5) * noise * 2);
}

// Two very similar face embeddings (cosine sim ≈ 0.99)
const FACE_A = [1, 0.1, 0, 0, 0];
const FACE_B = [1, 0.12, 0.01, 0, 0];
// A third similar face
const FACE_C = [1, 0.09, 0.02, 0, 0];

// Consistent body embeddings
const BODY_A = [1, 0.05, 0, 0, 0, 0, 0, 0];
const BODY_B = [1, 0.06, 0.01, 0, 0, 0, 0, 0];
const BODY_C = [1, 0.04, 0.02, 0, 0, 0, 0, 0];
const BODY_D = [1, 0.07, 0.01, 0, 0, 0, 0, 0];

// Inconsistent face (orthogonal)
const FACE_OUTLIER = [0, 0, 0, 0, 1];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ReIdAccumulator", () => {
  const accumulator = new ReIdAccumulator();

  // Test 1: gallery_update when target has entity_id
  it("returns gallery_update when target already has entity_id", async () => {
    const entries = new Map<string, DIdEntry>();
    const target: AccumulatorTarget = { bbox_ids: ["D0"], entity_id: "existing_entity" };
    const result = await accumulator.evaluate(ctx(), target, undefined, mockRegistry(entries), mockMemory());
    expect(result.action).toBe("gallery_update");
  });

  it("does not treat wm_inherited entity_id as current ReID gallery evidence", async () => {
    const entries = new Map<string, DIdEntry>([
      ["D0", writableFaceEntry("D0", 0, FACE_A, 0.9)],
      ["D1", writableFaceEntry("D1", 1, FACE_B, 0.85)],
    ]);
    const target: AccumulatorTarget = {
      bbox_ids: ["D0", "D1"],
      entity_id: "existing_entity",
      entity_id_source: "wm_inherited",
    };
    const result = await accumulator.evaluate(ctx(), target, undefined, mockRegistry(entries), mockMemory());
    expect(result.action).toBe("pending");
    if (result.action === "pending") {
      expect(result.pending_face).toHaveLength(2);
    }
  });

  it("marks wm-inherited identity inconsistent when current face disagrees with WM pending faces", async () => {
    const entries = new Map<string, DIdEntry>([
      ["D0", writableFaceEntry("D0", 0, FACE_A, 0.9)],
    ]);
    const target: AccumulatorTarget = {
      bbox_ids: ["D0"],
      entity_id: "existing_entity",
      entity_id_source: "wm_inherited",
    };
    const wmTarget: WorkingMemoryTarget = {
      target_id: "wm_t1",
      entity_id: "existing_entity",
      class_name: "person",
      appearance: "known person",
      crop_path: "/tmp/crop.jpg",
      last_seen_segment_id: "seg0",
      last_seen_timestamp: 0,
      segments_seen: 1,
      segments_missed: 0,
      pending_face_embeddings: [{
        embedding: FACE_OUTLIER,
        quality: 0.9,
        segment_id: "seg0",
        did: "D_prev",
      }],
    };

    const result = await accumulator.evaluate(ctx(), target, wmTarget, mockRegistry(entries), mockMemory());

    expect(result.action).toBe("pending");
    if (result.action === "pending") {
      expect(result.wm_entity_inconsistent).toMatchObject({
        modality: "face",
        current_face_count: 1,
        historical_face_count: 1,
      });
      expect(result.wm_entity_inconsistent?.max_similarity).toBeLessThan(result.wm_entity_inconsistent!.threshold);
    }
  });

  it("keeps wm-inherited identity when current face agrees with WM pending faces", async () => {
    const entries = new Map<string, DIdEntry>([
      ["D0", writableFaceEntry("D0", 0, FACE_A, 0.9)],
    ]);
    const target: AccumulatorTarget = {
      bbox_ids: ["D0"],
      entity_id: "existing_entity",
      entity_id_source: "wm_inherited",
    };
    const wmTarget: WorkingMemoryTarget = {
      target_id: "wm_t1",
      entity_id: "existing_entity",
      class_name: "person",
      appearance: "known person",
      crop_path: "/tmp/crop.jpg",
      last_seen_segment_id: "seg0",
      last_seen_timestamp: 0,
      segments_seen: 1,
      segments_missed: 0,
      pending_face_embeddings: [{
        embedding: FACE_B,
        quality: 0.9,
        segment_id: "seg0",
        did: "D_prev",
      }],
    };

    const result = await accumulator.evaluate(ctx(), target, wmTarget, mockRegistry(entries), mockMemory());

    expect(result.action).toBe("pending");
    if (result.action === "pending") {
      expect(result.wm_entity_inconsistent).toBeUndefined();
    }
  });

  // Test 2: create with 2 consistent face embeddings (single segment, 2 DIDs)
  it("creates entity with 2 consistent face embeddings in single segment", async () => {
    const entries = new Map<string, DIdEntry>([
      ["D0", writableFaceEntry("D0", 0, FACE_A, 0.9)],
      ["D1", writableFaceEntry("D1", 1, FACE_B, 0.85)],
    ]);
    const target: AccumulatorTarget = { bbox_ids: ["D0", "D1"] };
    const memory = mockMemory({
      batchInitResult: { entity_id: "entity_1", face_slots_written: 2, body_slots_written: 0 },
    });

    const result = await accumulator.evaluate(ctx(), target, undefined, mockRegistry(entries), memory);

    expect(result.action).toBe("create");
    if (result.action === "create") {
      expect(result.entity_id).toBe("entity_1");
      expect(result.face_slots).toBe(2);
      expect(result.body_slots).toBe(0);
    }
    expect(memory.reidBatchInit).toHaveBeenCalledOnce();
    const call = (memory.reidBatchInit as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.face_vectors).toHaveLength(2);
    expect(call.body_vectors).toBeUndefined();
  });

  it("matches an existing entity before batch-init when locked search sees one", async () => {
    const entries = new Map<string, DIdEntry>([
      ["D0", writableFaceEntry("D0", 0, FACE_A, 0.9)],
      ["D1", writableFaceEntry("D1", 1, FACE_B, 0.85)],
    ]);
    const target: AccumulatorTarget = { bbox_ids: ["D0", "D1"] };
    const memory = mockMemory({
      searchResults: [{ entity_id: "entity_existing", score: 0.91, subject_index: 7, name: "Alex" }],
    });

    const result = await accumulator.evaluate(ctx(), target, undefined, mockRegistry(entries), memory);

    expect(result.action).toBe("match");
    if (result.action === "match") {
      expect(result.entity_id).toBe("entity_existing");
      expect(result.subject_index).toBe(7);
      expect(result.name).toBe("Alex");
      expect(result.match_type).toBe("face");
    }
    expect(memory.reidSearch).toHaveBeenCalled();
    expect(memory.reidBatchInit).not.toHaveBeenCalled();
  });

  it("keeps a consistent anonymous target pending when stable creation is disabled", async () => {
    const entries = new Map<string, DIdEntry>([
      ["D0", writableFaceEntry("D0", 0, FACE_A, 0.9)],
      ["D1", writableFaceEntry("D1", 1, FACE_B, 0.85)],
    ]);
    const target: AccumulatorTarget = { bbox_ids: ["D0", "D1"] };
    const memory = mockMemory();

    const result = await accumulator.evaluate(
      ctx(),
      target,
      undefined,
      mockRegistry(entries),
      memory,
      { allowCreate: false },
    );

    expect(result.action).toBe("pending");
    if (result.action === "pending") {
      expect(result.pending_reason).toBe("insufficient_evidence");
      expect(result.pending_face).toHaveLength(2);
      expect(result.pending_entity_id).toBeUndefined();
    }
    expect(memory.reserveEntityId).not.toHaveBeenCalled();
    expect(memory.reidBatchInit).not.toHaveBeenCalled();
  });

  // Test 3: create with face + body (2 face + 3 body, all consistent)
  it("creates entity with face clique + body clique", async () => {
    const entries = new Map<string, DIdEntry>([
      ["D0", { ...writableFaceEntry("D0", 0, FACE_A, 0.9), body: { embedding: BODY_A, quality: 0.8, visibility: "full" } }],
      ["D1", { ...writableFaceEntry("D1", 1, FACE_B, 0.85), body: { embedding: BODY_B, quality: 0.75, visibility: "full" } }],
      ["D2", { ...bodyOnlyEntry("D2", 2, BODY_C, 0.7) }],
    ]);
    const target: AccumulatorTarget = { bbox_ids: ["D0", "D1", "D2"] };
    const memory = mockMemory({
      batchInitResult: { entity_id: "entity_1", face_slots_written: 2, body_slots_written: 3 },
    });

    const result = await accumulator.evaluate(ctx(), target, undefined, mockRegistry(entries), memory);

    expect(result.action).toBe("create");
    if (result.action === "create") {
      expect(result.face_slots).toBe(2);
      expect(result.body_slots).toBe(3);
    }
    const call = (memory.reidBatchInit as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.face_vectors).toHaveLength(2);
    expect(call.body_vectors).toHaveLength(3);
  });

  // Test 4: create with one clearly high-quality near-frontal face
  it("creates entity with one high-quality near-frontal face", async () => {
    const entries = new Map<string, DIdEntry>([
      ["D0", writableFaceEntry("D0", 0, FACE_A, 0.9)],
    ]);
    const target: AccumulatorTarget = { bbox_ids: ["D0"] };
    const memory = mockMemory({
      batchInitResult: { entity_id: "entity_1", face_slots_written: 1, body_slots_written: 0 },
    });

    const result = await accumulator.evaluate(ctx(), target, undefined, mockRegistry(entries), memory);

    expect(result.action).toBe("create");
    if (result.action === "create") {
      expect(result.entity_id).toBe("entity_1");
      expect(result.face_slots).toBe(1);
      expect(result.body_slots).toBe(0);
      expect(result.init_reason).toBe("single_high_quality_face");
    }
    expect(memory.reidBatchInit).toHaveBeenCalledOnce();
    const call = (memory.reidBatchInit as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.face_vectors).toHaveLength(1);
  });

  it("returns pending insufficient_evidence with one non-fast-path face embedding", async () => {
    const entries = new Map<string, DIdEntry>([
      ["D0", writableFaceEntry("D0", 0, FACE_A, 0.7)],
    ]);
    const target: AccumulatorTarget = { bbox_ids: ["D0"] };
    const memory = mockMemory();

    const result = await accumulator.evaluate(ctx(), target, undefined, mockRegistry(entries), memory);

    expect(result.action).toBe("pending");
    if (result.action === "pending") {
      expect(result.pending_reason).toBe("insufficient_evidence");
      expect(result.pending_face).toHaveLength(1);
      expect(result.pending_entity_id).toBeUndefined();
    }
    expect(memory.reserveEntityId).not.toHaveBeenCalled();
  });

  // Test 5: pending batch_init_failed when HTTP fails — verify pending_entity_id is set
  it("returns pending batch_init_failed with reserved entity_id when init fails", async () => {
    const entries = new Map<string, DIdEntry>([
      ["D0", writableFaceEntry("D0", 0, FACE_A, 0.9)],
      ["D1", writableFaceEntry("D1", 1, FACE_B, 0.85)],
    ]);
    const target: AccumulatorTarget = { bbox_ids: ["D0", "D1"] };
    const memory = mockMemory({ batchInitError: new Error("HTTP 500") });

    const result = await accumulator.evaluate(ctx(), target, undefined, mockRegistry(entries), memory);

    expect(result.action).toBe("pending");
    if (result.action === "pending") {
      expect(result.pending_reason).toBe("batch_init_failed");
      expect(result.pending_entity_id).toBe("entity_1");
      expect(result.pending_face).toHaveLength(2);
    }
  });

  // Test 6: Cross-segment accumulation: seg1 → 1 face → pending; seg2 adds 1 more → create
  it("accumulates across segments and creates on second segment", async () => {
    const accumulator2 = new ReIdAccumulator();

    // Segment 1: only 1 face → pending
    const seg1Entries = new Map<string, DIdEntry>([
      ["D0", writableFaceEntry("D0", 0, FACE_A, 0.7)],
    ]);
    const target1: AccumulatorTarget = { bbox_ids: ["D0"] };
    const memory1 = mockMemory();

    const result1 = await accumulator2.evaluate(
      ctx("seg1"), target1, undefined, mockRegistry(seg1Entries), memory1,
    );
    expect(result1.action).toBe("pending");

    // Build wmTarget with pending from seg1
    const wmTarget: WorkingMemoryTarget = {
      target_id: "t1",
      class_name: "person",
      appearance: "blue shirt",
      crop_path: "/tmp/crop.jpg",
      last_seen_segment_id: "seg1",
      last_seen_timestamp: 1000,
      segments_seen: 1,
      segments_missed: 0,
      pending_face_embeddings:
        result1.action === "pending" ? result1.pending_face : [],
      pending_body_embeddings:
        result1.action === "pending" ? result1.pending_body : [],
    };

    // Segment 2: 1 more face → now 2 total → create
    const seg2Entries = new Map<string, DIdEntry>([
      ["D1", writableFaceEntry("D1", 0, FACE_B, 0.85)],
    ]);
    const target2: AccumulatorTarget = { bbox_ids: ["D1"] };
    const memory2 = mockMemory({
      batchInitResult: { entity_id: "entity_1", face_slots_written: 2, body_slots_written: 0 },
    });

    const result2 = await accumulator2.evaluate(
      ctx("seg2"), target2, wmTarget, mockRegistry(seg2Entries), memory2,
    );

    expect(result2.action).toBe("create");
    if (result2.action === "create") {
      expect(result2.face_slots).toBe(2);
    }
  });

  // Test 7: Dedup — same (segment_id, did) appears twice → pool only has 1 entry
  it("deduplicates embeddings by (segment_id, did)", async () => {
    const entry = writableFaceEntry("D0", 0, FACE_A, 0.7);
    const entries = new Map<string, DIdEntry>([["D0", entry]]);
    const target: AccumulatorTarget = { bbox_ids: ["D0"] };

    // wmTarget already has the same (seg1, D0) embedding
    const wmTarget: WorkingMemoryTarget = {
      target_id: "t1",
      class_name: "person",
      appearance: "blue shirt",
      crop_path: "/tmp/crop.jpg",
      last_seen_segment_id: "seg1",
      last_seen_timestamp: 1000,
      segments_seen: 1,
      segments_missed: 0,
      pending_face_embeddings: [{
        embedding: FACE_A,
        quality: 0.7,
        segment_id: "seg1",
        did: "D0",
        yaw: 0,
        pitch: 0,
      }],
    };

    const memory = mockMemory();
    // Same segment_id as the pending entry → should dedup
    const result = await accumulator.evaluate(ctx("seg1"), target, wmTarget, mockRegistry(entries), memory);

    expect(result.action).toBe("pending");
    if (result.action === "pending") {
      // Only 1 face entry despite "D0" appearing both in registry and pending
      expect(result.pending_face).toHaveLength(1);
      expect(result.pending_reason).toBe("insufficient_evidence");
    }
  });

  // Test 8: Face quality gate — entry with bad face (no landmarks) excluded from pool
  it("excludes faces without landmarks from the pool", async () => {
    const entries = new Map<string, DIdEntry>([
      ["D0", badFaceEntry("D0", 0, FACE_A)],
      ["D1", writableFaceEntry("D1", 1, FACE_B, 0.7)],
    ]);
    const target: AccumulatorTarget = { bbox_ids: ["D0", "D1"] };
    const memory = mockMemory();

    const result = await accumulator.evaluate(ctx(), target, undefined, mockRegistry(entries), memory);

    expect(result.action).toBe("pending");
    if (result.action === "pending") {
      // Only D1 qualifies (D0 has bad face)
      expect(result.pending_face).toHaveLength(1);
      expect(result.pending_face[0]!.did).toBe("D1");
      expect(result.pending_reason).toBe("insufficient_evidence");
    }
  });

  // Test 9: Body-only create — 3 consistent body embeddings, no face
  it("creates entity with body-only clique (3 consistent bodies)", async () => {
    const entries = new Map<string, DIdEntry>([
      ["D0", bodyOnlyEntry("D0", 0, BODY_A, 0.8, { visibility: "full" })],
      ["D1", bodyOnlyEntry("D1", 1, BODY_B, 0.75, { visibility: "full" })],
      ["D2", bodyOnlyEntry("D2", 2, BODY_C, 0.7, { visibility: "upper" })],
    ]);
    const target: AccumulatorTarget = { bbox_ids: ["D0", "D1", "D2"] };
    const memory = mockMemory({
      batchInitResult: { entity_id: "entity_1", face_slots_written: 0, body_slots_written: 3 },
    });

    const result = await accumulator.evaluate(ctx(), target, undefined, mockRegistry(entries), memory);

    expect(result.action).toBe("create");
    if (result.action === "create") {
      expect(result.face_slots).toBe(0);
      expect(result.body_slots).toBe(3);
    }
    const call = (memory.reidBatchInit as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.face_vectors).toBeUndefined();
    expect(call.body_vectors).toHaveLength(3);
  });

  // Test 10: Body-only pending — 1 body embedding (< 2 threshold)
  it("returns pending insufficient_evidence with 1 body embedding (below threshold)", async () => {
    const entries = new Map<string, DIdEntry>([
      ["D0", bodyOnlyEntry("D0", 0, BODY_A, 0.8)],
    ]);
    const target: AccumulatorTarget = { bbox_ids: ["D0"] };
    const memory = mockMemory();

    const result = await accumulator.evaluate(ctx(), target, undefined, mockRegistry(entries), memory);

    expect(result.action).toBe("pending");
    if (result.action === "pending") {
      expect(result.pending_reason).toBe("insufficient_evidence");
      expect(result.pending_body).toHaveLength(1);
      expect(result.pending_face).toHaveLength(0);
    }
    expect(memory.reserveEntityId).not.toHaveBeenCalled();
  });
});
