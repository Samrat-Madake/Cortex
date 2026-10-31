import { describe, it, expect } from "vitest";
import { WorkingMemoryManager } from "../working-memory.js";

describe("WorkingMemory pending pool", () => {
  it("stores pending embeddings via upsert", () => {
    const wm = new WorkingMemoryManager();
    wm.onSegmentArrived("cam1", "event");
    wm.upsertTarget("cam1", {
      target_id: "t1", class_name: "person", appearance: "blue shirt",
      crop_path: "/tmp/crop.jpg", last_seen_segment_id: "seg1",
      last_seen_timestamp: 1000, segments_seen: 1, segments_missed: 0,
      pending_face_embeddings: [{ embedding: [1, 0], quality: 0.9, segment_id: "seg1", did: "D0" }],
      pending_body_embeddings: null,
      pending_entity_id: null,
    });
    const target = wm.getState("cam1").targets?.find(t => t.target_id === "t1");
    expect(target?.pending_face_embeddings).toHaveLength(1);
    expect(target?.pending_body_embeddings).toBeUndefined();
    expect(target?.pending_entity_id).toBeUndefined();
  });

  it("replaces pending on subsequent upsert", () => {
    const wm = new WorkingMemoryManager();
    wm.onSegmentArrived("cam1", "event");
    wm.upsertTarget("cam1", {
      target_id: "t1", class_name: "person", appearance: "blue shirt",
      crop_path: "/tmp/crop.jpg", last_seen_segment_id: "seg1",
      last_seen_timestamp: 1000, segments_seen: 1, segments_missed: 0,
      pending_face_embeddings: [{ embedding: [1, 0], quality: 0.9, segment_id: "seg1", did: "D0" }],
      pending_body_embeddings: null, pending_entity_id: null,
    });
    wm.upsertTarget("cam1", {
      target_id: "t1", class_name: "person", appearance: "blue shirt",
      crop_path: "/tmp/crop2.jpg", last_seen_segment_id: "seg2",
      last_seen_timestamp: 2000, segments_seen: 2, segments_missed: 0,
      pending_face_embeddings: [
        { embedding: [1, 0], quality: 0.9, segment_id: "seg1", did: "D0" },
        { embedding: [0.9, 0.4], quality: 0.85, segment_id: "seg2", did: "D1" },
      ],
      pending_body_embeddings: null, pending_entity_id: null,
    });
    const target = wm.getState("cam1").targets?.find(t => t.target_id === "t1");
    expect(target?.pending_face_embeddings).toHaveLength(2);
  });

  it("clears pending with null on create success", () => {
    const wm = new WorkingMemoryManager();
    wm.onSegmentArrived("cam1", "event");
    wm.upsertTarget("cam1", {
      target_id: "t1", class_name: "person", appearance: "blue shirt",
      crop_path: "/tmp/crop.jpg", last_seen_segment_id: "seg1",
      last_seen_timestamp: 1000, segments_seen: 1, segments_missed: 0,
      pending_face_embeddings: [{ embedding: [1, 0], quality: 0.9, segment_id: "seg1", did: "D0" }],
      pending_body_embeddings: null, pending_entity_id: "entity_123",
    });
    wm.upsertTarget("cam1", {
      target_id: "t1", class_name: "person", appearance: "blue shirt",
      crop_path: "/tmp/crop2.jpg", last_seen_segment_id: "seg2",
      last_seen_timestamp: 2000, segments_seen: 2, segments_missed: 0,
      entity_id: "entity_123",
      pending_face_embeddings: null,
      pending_body_embeddings: null,
      pending_entity_id: null,
    });
    const target = wm.getState("cam1").targets?.find(t => t.target_id === "t1");
    expect(target?.pending_face_embeddings).toBeUndefined();
    expect(target?.pending_entity_id).toBeUndefined();
    expect(target?.entity_id).toBe("entity_123");
  });

  it("preserves existing pending when field is undefined (not passed)", () => {
    const wm = new WorkingMemoryManager();
    wm.onSegmentArrived("cam1", "event");
    wm.upsertTarget("cam1", {
      target_id: "t1", class_name: "person", appearance: "blue shirt",
      crop_path: "/tmp/crop.jpg", last_seen_segment_id: "seg1",
      last_seen_timestamp: 1000, segments_seen: 1, segments_missed: 0,
      pending_face_embeddings: [{ embedding: [1, 0], quality: 0.9, segment_id: "seg1", did: "D0" }],
      pending_body_embeddings: null, pending_entity_id: null,
    });
    // Update appearance only — pending fields omitted → preserve
    wm.upsertTarget("cam1", {
      target_id: "t1", class_name: "person", appearance: "red shirt",
      crop_path: "/tmp/crop2.jpg", last_seen_segment_id: "seg2",
      last_seen_timestamp: 2000, segments_seen: 2, segments_missed: 0,
    });
    const target = wm.getState("cam1").targets?.find(t => t.target_id === "t1");
    expect(target?.pending_face_embeddings).toHaveLength(1);
    expect(target?.appearance).toBe("red shirt");
  });
});
