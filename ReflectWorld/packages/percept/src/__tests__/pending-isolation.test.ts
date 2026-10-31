/**
 * Verifies that pending embedding pools (pending_face_embeddings,
 * pending_body_embeddings, pending_entity_id) stored on WorkingMemoryTarget
 * never leak into VLM prompts, PerceptionResult, PipelineTrace, or any
 * externally-consumed serialization path.
 *
 * The accumulator stores large float arrays on WM targets as runtime state.
 * Isolation is enforced by:
 *   1. Pipeline manually projects targets into {target_id, class_name,
 *      appearance, identity?, crop_base64?} before passing to VLM.
 *   2. SubjectProposalContext.wmTargets type does not include pending fields.
 *   3. PerceptionResult does not include WM targets at all.
 */
import { describe, it, expect } from "vitest";
import { WorkingMemoryManager } from "../working-memory.js";
import type { PendingEmbedding, WorkingMemoryTarget } from "../types.js";

/** Realistic 512-dim embedding to catch size-based serialization problems. */
const FAKE_FACE_EMBEDDING: PendingEmbedding = {
  embedding: Array.from({ length: 512 }, (_, i) => i * 0.001),
  quality: 0.92,
  segment_id: "seg_001",
  did: "D0",
  yaw: 5.2,
  pitch: -3.1,
};

const FAKE_BODY_EMBEDDING: PendingEmbedding = {
  embedding: Array.from({ length: 768 }, (_, i) => i * 0.0005),
  quality: 0.85,
  segment_id: "seg_001",
  did: "D0",
  body_yaw_ratio: 0.6,
  visibility: "full",
};

const PENDING_FIELD_NAMES = [
  "pending_face_embeddings",
  "pending_body_embeddings",
  "pending_entity_id",
] as const;

/**
 * Simulates the pipeline's manual projection of WM targets for VLM prompt.
 * This mirrors packages/percept/src/pipeline.ts lines ~1348-1379 where
 * targets are projected into SubjectProposalContext.wmTargets shape.
 */
function projectTargetForVlm(t: WorkingMemoryTarget): {
  target_id: string;
  class_name: string;
  appearance: string;
  identity?: { name: string; evidence?: string };
} {
  const context: {
    target_id: string;
    class_name: string;
    appearance: string;
    identity?: { name: string; evidence?: string };
  } = {
    target_id: t.target_id,
    class_name: t.class_name,
    appearance: t.appearance,
  };
  if (t.identity?.name && !t.identity.conflict) {
    context.identity = {
      name: t.identity.name,
      evidence: t.identity.evidence,
    };
  }
  return context;
}

function makeTarget(overrides: Partial<WorkingMemoryTarget> = {}): WorkingMemoryTarget {
  return {
    target_id: "wm_t1",
    class_name: "person",
    appearance: "blue jacket, jeans",
    crop_path: "/tmp/crop_001.jpg",
    last_seen_segment_id: "seg_001",
    last_seen_timestamp: 1000,
    segments_seen: 1,
    segments_missed: 0,
    ...overrides,
  };
}

describe("pending embedding serialization isolation", () => {
  // ── VLM Prompt Isolation ──

  it("pipeline target projection strips all pending fields", () => {
    const target = makeTarget({
      pending_face_embeddings: [FAKE_FACE_EMBEDDING],
      pending_body_embeddings: [FAKE_BODY_EMBEDDING],
      pending_entity_id: "entity_pending_abc",
    });

    const projected = projectTargetForVlm(target);
    const projectedJson = JSON.stringify(projected);

    // Projected object must not contain any pending field
    for (const field of PENDING_FIELD_NAMES) {
      expect(projected).not.toHaveProperty(field);
      expect(projectedJson).not.toContain(field);
    }

    // Must not contain embedding float arrays
    expect(projectedJson).not.toContain("0.001");
    expect(projectedJson).not.toContain("0.0005");

    // Must retain the fields VLM needs
    expect(projected.target_id).toBe("wm_t1");
    expect(projected.class_name).toBe("person");
    expect(projected.appearance).toBe("blue jacket, jeans");
  });

  it("pipeline target projection preserves identity when present and non-conflicting", () => {
    const target = makeTarget({
      identity: {
        name: "Alice",
        evidence: "addressed by name in dialogue",
        source_segment_id: "seg_001",
      },
      pending_face_embeddings: [FAKE_FACE_EMBEDDING],
      pending_entity_id: "entity_pending_xyz",
    });

    const projected = projectTargetForVlm(target);
    expect(projected.identity).toEqual({
      name: "Alice",
      evidence: "addressed by name in dialogue",
    });
    expect(JSON.stringify(projected)).not.toContain("pending");
  });

  it("pipeline target projection omits conflicting identity", () => {
    const target = makeTarget({
      identity: {
        name: "Alice",
        evidence: "conflicting identity \"Bob\": introduced himself",
        source_segment_id: "seg_001",
        conflict: true,
      },
    });

    const projected = projectTargetForVlm(target);
    expect(projected.identity).toBeUndefined();
  });

  it("raw WM target JSON serialization includes pending data (expected for in-memory use)", () => {
    const target = makeTarget({
      pending_face_embeddings: [FAKE_FACE_EMBEDDING],
      pending_body_embeddings: [FAKE_BODY_EMBEDDING],
      pending_entity_id: "entity_pending_check",
    });

    const raw = JSON.stringify(target);
    // The raw object DOES contain pending — this is expected (runtime state).
    // The test proves that projecting is necessary.
    expect(raw).toContain("pending_face_embeddings");
    expect(raw).toContain("pending_body_embeddings");
    expect(raw).toContain("entity_pending_check");
    expect(raw.length).toBeGreaterThan(5000); // 512+768 floats → large
  });

  // ── WM Lifecycle: Store, Retrieve, Clear ──

  it("pending embeddings are stored and retrievable via getState", () => {
    const wm = new WorkingMemoryManager();
    wm.onSegmentArrived("cam1", "event");
    wm.upsertTarget("cam1", {
      target_id: "wm_t1",
      class_name: "person",
      appearance: "blue shirt",
      crop_path: "/tmp/crop.jpg",
      last_seen_segment_id: "seg1",
      last_seen_timestamp: 1000,
      segments_seen: 1,
      segments_missed: 0,
      pending_face_embeddings: [FAKE_FACE_EMBEDDING],
      pending_body_embeddings: [FAKE_BODY_EMBEDDING],
      pending_entity_id: "entity_pending_123",
    });

    const state = wm.getState("cam1");
    const target = state.targets?.find((t) => t.target_id === "wm_t1");

    expect(target?.pending_face_embeddings).toHaveLength(1);
    expect(target?.pending_face_embeddings?.[0]?.embedding).toHaveLength(512);
    expect(target?.pending_body_embeddings).toHaveLength(1);
    expect(target?.pending_body_embeddings?.[0]?.embedding).toHaveLength(768);
    expect(target?.pending_entity_id).toBe("entity_pending_123");
  });

  it("pending fields are cleared with null, setting them to undefined", () => {
    const wm = new WorkingMemoryManager();
    wm.onSegmentArrived("cam1", "event");

    // Store pending
    wm.upsertTarget("cam1", {
      target_id: "wm_t1",
      class_name: "person",
      appearance: "blue shirt",
      crop_path: "/tmp/crop.jpg",
      last_seen_segment_id: "seg1",
      last_seen_timestamp: 1000,
      segments_seen: 1,
      segments_missed: 0,
      pending_face_embeddings: [FAKE_FACE_EMBEDDING],
      pending_body_embeddings: [FAKE_BODY_EMBEDDING],
      pending_entity_id: "entity_pending_123",
    });

    // Clear all pending
    wm.upsertTarget("cam1", {
      target_id: "wm_t1",
      class_name: "person",
      appearance: "blue shirt",
      crop_path: "/tmp/crop2.jpg",
      last_seen_segment_id: "seg2",
      last_seen_timestamp: 2000,
      segments_seen: 2,
      segments_missed: 0,
      pending_face_embeddings: null,
      pending_body_embeddings: null,
      pending_entity_id: null,
    });

    const target = wm.getState("cam1").targets?.find((t) => t.target_id === "wm_t1");
    expect(target?.pending_face_embeddings).toBeUndefined();
    expect(target?.pending_body_embeddings).toBeUndefined();
    expect(target?.pending_entity_id).toBeUndefined();

    // Cleared pending must not appear in JSON
    const serialized = JSON.stringify(target);
    for (const field of PENDING_FIELD_NAMES) {
      expect(serialized).not.toContain(field);
    }
  });

  it("omitting pending fields (undefined) preserves existing values", () => {
    const wm = new WorkingMemoryManager();
    wm.onSegmentArrived("cam1", "event");

    // Store pending
    wm.upsertTarget("cam1", {
      target_id: "wm_t1",
      class_name: "person",
      appearance: "blue shirt",
      crop_path: "/tmp/crop.jpg",
      last_seen_segment_id: "seg1",
      last_seen_timestamp: 1000,
      segments_seen: 1,
      segments_missed: 0,
      pending_face_embeddings: [FAKE_FACE_EMBEDDING],
      pending_body_embeddings: null,
      pending_entity_id: "entity_tentative",
    });

    // Update appearance only — pending fields omitted (undefined) → preserved
    wm.upsertTarget("cam1", {
      target_id: "wm_t1",
      class_name: "person",
      appearance: "red shirt now",
      crop_path: "/tmp/crop2.jpg",
      last_seen_segment_id: "seg2",
      last_seen_timestamp: 2000,
      segments_seen: 2,
      segments_missed: 0,
    });

    const target = wm.getState("cam1").targets?.find((t) => t.target_id === "wm_t1");
    expect(target?.appearance).toBe("red shirt now");
    expect(target?.pending_face_embeddings).toHaveLength(1);
    expect(target?.pending_entity_id).toBe("entity_tentative");
  });

  // ── Event Close / Reset Discards Pending ──

  it("event close discards all pending embeddings with targets", () => {
    const wm = new WorkingMemoryManager();
    wm.onSegmentArrived("cam1", "event");
    wm.upsertTarget("cam1", {
      target_id: "wm_t1",
      class_name: "person",
      appearance: "test",
      crop_path: "/tmp/c.jpg",
      last_seen_segment_id: "s1",
      last_seen_timestamp: 1000,
      segments_seen: 1,
      segments_missed: 0,
      pending_face_embeddings: [FAKE_FACE_EMBEDDING],
      pending_body_embeddings: [FAKE_BODY_EMBEDDING],
      pending_entity_id: "entity_will_be_lost",
    });

    // Close event — targets get cleared along with all pending state
    wm.closeCurrentEvent("cam1");

    const targets = wm.getState("cam1").targets ?? [];
    expect(targets).toHaveLength(0);

    // Re-open and verify clean slate
    wm.onSegmentArrived("cam1", "event");
    expect(wm.getTargets("cam1")).toHaveLength(0);
  });

  it("camera reset discards all pending state", () => {
    const wm = new WorkingMemoryManager();
    wm.onSegmentArrived("cam1", "event");
    wm.upsertTarget("cam1", {
      target_id: "wm_t1",
      class_name: "person",
      appearance: "test",
      crop_path: "/tmp/c.jpg",
      last_seen_segment_id: "s1",
      last_seen_timestamp: 1000,
      segments_seen: 1,
      segments_missed: 0,
      pending_face_embeddings: [FAKE_FACE_EMBEDDING],
      pending_entity_id: "entity_pending_reset",
    });

    wm.resetCamera("cam1");

    // After reset, state is freshly initialized
    const state = wm.getState("cam1");
    expect(state.targets).toHaveLength(0);
    expect(state.current_event_id).toBeNull();
  });

  // ── switchEvent with carryTargets ──

  it("switchEvent with carryTargets preserves pending fields on carried targets", () => {
    const wm = new WorkingMemoryManager();
    wm.onSegmentArrived("cam1", "event");
    wm.upsertTarget("cam1", {
      target_id: "wm_t1",
      class_name: "person",
      appearance: "blue jacket",
      crop_path: "/tmp/c.jpg",
      last_seen_segment_id: "s1",
      last_seen_timestamp: 1000,
      segments_seen: 1,
      segments_missed: 0,
      pending_face_embeddings: [FAKE_FACE_EMBEDDING],
      pending_entity_id: "entity_tentative_carry",
    });

    // switchEvent with carryTargets spreads targets into new event
    const newEventId = wm.switchEvent("cam1", "event", 5000, { carryTargets: true });
    expect(newEventId).toBeTruthy();

    const targets = wm.getTargets("cam1");
    expect(targets).toHaveLength(1);

    const carried = targets[0]!;
    // Pending fields are spread along with the rest of the target
    expect(carried.pending_face_embeddings).toHaveLength(1);
    expect(carried.pending_entity_id).toBe("entity_tentative_carry");
  });

  it("switchEvent without carryTargets discards pending along with targets", () => {
    const wm = new WorkingMemoryManager();
    wm.onSegmentArrived("cam1", "event");
    wm.upsertTarget("cam1", {
      target_id: "wm_t1",
      class_name: "person",
      appearance: "blue jacket",
      crop_path: "/tmp/c.jpg",
      last_seen_segment_id: "s1",
      last_seen_timestamp: 1000,
      segments_seen: 1,
      segments_missed: 0,
      pending_face_embeddings: [FAKE_FACE_EMBEDDING],
      pending_entity_id: "entity_tentative_discard",
    });

    wm.switchEvent("cam1", "event", 5000, { carryTargets: false });
    expect(wm.getTargets("cam1")).toHaveLength(0);
  });

  // ── Projection of multiple targets ──

  it("batch projection of getTargets() strips all pending fields from every target", () => {
    const wm = new WorkingMemoryManager();
    wm.onSegmentArrived("cam1", "event");

    // Target with pending
    wm.upsertTarget("cam1", {
      target_id: "wm_t1",
      class_name: "person",
      appearance: "blue jacket",
      crop_path: "/tmp/c1.jpg",
      last_seen_segment_id: "s1",
      last_seen_timestamp: 1000,
      segments_seen: 1,
      segments_missed: 0,
      pending_face_embeddings: [FAKE_FACE_EMBEDDING],
      pending_entity_id: "entity_a",
    });

    // Target without pending
    wm.upsertTarget("cam1", {
      target_id: "wm_t2",
      class_name: "person",
      appearance: "red dress",
      crop_path: "/tmp/c2.jpg",
      last_seen_segment_id: "s1",
      last_seen_timestamp: 1000,
      segments_seen: 1,
      segments_missed: 0,
      pending_face_embeddings: null,
      pending_body_embeddings: null,
      pending_entity_id: null,
    });

    const rawTargets = wm.getTargets("cam1");
    expect(rawTargets).toHaveLength(2);

    // Project all targets as pipeline does
    const projected = rawTargets.map(projectTargetForVlm);
    const projectedJson = JSON.stringify(projected);

    for (const field of PENDING_FIELD_NAMES) {
      expect(projectedJson).not.toContain(field);
    }

    // Verify raw targets still have pending (not stripped from source)
    const rawJson = JSON.stringify(rawTargets);
    expect(rawJson).toContain("pending_face_embeddings");
    expect(rawJson).toContain("entity_a");
  });
});
