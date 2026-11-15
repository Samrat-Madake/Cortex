import { describe, expect, it } from "vitest";
import {
  buildCompactSubjectEvidenceContext,
  currentSegmentStableCropPath,
  mergeStableWmCrops,
  prepareWmTargetsForSubjectProposal,
  resolveTargetContinuityStrength,
  selectReliableTargetCropEntry,
  shouldAttachWmTargetCropImages,
} from "../pipeline/subjects.js";
import type { DIdEntry, WorkingMemoryTarget } from "../types.js";
import { DetectionRegistry } from "../did-registry.js";
import type { ParsedSubjectProposalTarget } from "../identity-resolver.js";

function wmTarget(input: Partial<WorkingMemoryTarget> & Pick<WorkingMemoryTarget, "target_id">): WorkingMemoryTarget {
  return {
    class_name: "person",
    appearance: "person",
    behavior: "standing",
    crop_path: "/tmp/crop.jpg",
    last_seen_segment_id: "seg_prev",
    last_seen_timestamp: 1,
    segments_seen: 1,
    segments_missed: 0,
    ...input,
  };
}

function did(input: Partial<DIdEntry> & Pick<DIdEntry, "did">): DIdEntry {
  return {
    frame_idx: 0,
    bbox: { x: 0, y: 0, width: 100, height: 200 },
    class_name: "person",
    confidence: 0.9,
    ...input,
  };
}

describe("subject proposal context", () => {
  it("selects only same-segment stable crops for current sightings", () => {
    expect(currentSegmentStableCropPath([
      {
        crop_path: "/media/old.jpg",
        segment_id: "seg_old",
        did: "D0",
        score: 0.99,
        source: "face",
        timestamp: 1,
      },
      {
        crop_path: "/media/current-low.jpg",
        segment_id: "seg_current",
        did: "D1",
        score: 0.5,
        source: "face",
        timestamp: 2,
      },
      {
        crop_path: "/media/current-best.jpg",
        segment_id: "seg_current",
        did: "D2",
        score: 0.8,
        source: "face",
        timestamp: 3,
      },
    ], "seg_current")).toBe("/media/current-best.jpg");

    expect(currentSegmentStableCropPath([
      {
        crop_path: "/media/old.jpg",
        segment_id: "seg_old",
        did: "D0",
        score: 0.99,
        source: "face",
        timestamp: 1,
      },
    ], "seg_current")).toBeUndefined();
  });

  it("keeps both face and body stable crops for VLM continuity", () => {
    const merged = mergeStableWmCrops([
      {
        crop_path: "/media/body-old.jpg",
        segment_id: "seg_1",
        did: "D1",
        score: 0.7,
        source: "body",
        timestamp: 1,
      },
    ], {
      crop_path: "/media/face-new.jpg",
      segment_id: "seg_2",
      did: "D2",
      score: 0.9,
      source: "face",
      timestamp: 2,
    });

    expect(merged?.map((crop) => crop.crop_path)).toEqual([
      "/media/face-new.jpg",
      "/media/body-old.jpg",
    ]);
  });

  it("uses one canonical WM target per entity, preferring the most frequently matched target", () => {
    const targets = prepareWmTargetsForSubjectProposal([
      wmTarget({
        target_id: "wm_old_recent",
        entity_id: "entity_a",
        last_seen_timestamp: 5_000,
        segments_seen: 2,
      }),
      wmTarget({
        target_id: "wm_frequent",
        entity_id: "entity_a",
        last_seen_timestamp: 1_000,
        segments_seen: 8,
      }),
      wmTarget({
        target_id: "wm_other",
        entity_id: "entity_b",
        last_seen_timestamp: 4_000,
        segments_seen: 1,
      }),
      wmTarget({
        target_id: "wm_anon",
        last_seen_timestamp: 6_000,
        segments_seen: 1,
      }),
    ]);

    expect(targets.map((target) => target.target_id)).toEqual([
      "wm_frequent",
      "wm_other",
      "wm_anon",
    ]);
  });

  it("uses ReID prompt hints in known entity context and orders them by quality", () => {
    const context = buildCompactSubjectEvidenceContext({
      registry: {
        all: () => [
          did({
            did: "D0",
            frame_idx: 0,
            face: {
              bbox: { x: 0, y: 0, width: 20, height: 24 },
              embedding: [0.1, 0.2],
              entity_id: "entity_a",
              match_score: 0.99,
              quality: 0.3,
              sharpness: 60,
              landmarks: Array.from({ length: 5 }, () => ({ x: 1, y: 1 })),
              pose: { yaw: 80, pitch: 0, roll: 0 },
            },
          }),
          did({
            did: "D1",
            frame_idx: 1,
            body: {
              entity_id: "entity_a",
              match_score: 0.95,
              quality: 0.8,
            },
          }),
          did({
            did: "D2",
            frame_idx: 2,
            face: {
              bbox: { x: 0, y: 0, width: 40, height: 48 },
              embedding: [0.2, 0.3],
              entity_id: "entity_a",
              match_score: 0.9,
              quality: 0.95,
              sharpness: 100,
              landmarks: Array.from({ length: 5 }, () => ({ x: 1, y: 1 })),
              pose: { yaw: 5, pitch: 0, roll: 0 },
            },
          }),
        ],
      },
      wmTargets: [
        wmTarget({
          target_id: "wm_a",
          entity_id: "entity_a",
          appearance: "known person",
        }),
      ],
      faceEntityHistory: new Map(),
      faceResults: [],
    });

    expect(context).toContain("possible D{id}s=[D2,D0,D1]");
    expect(context).toContain("appearance=known person");
    expect(context).toContain("recent_behavior=standing");
  });

  it("keeps small body-only background targets as weak visual continuity without crop images", () => {
    const registry = new DetectionRegistry();
    const entry = registry.addFrame(0, [
      { class_name: "person", confidence: 0.76, bbox: { x: 625, y: 170, width: 85, height: 304 } },
    ])[0]!;
    const target: ParsedSubjectProposalTarget = {
      type: "person",
      bbox_ids: [entry.did],
      matched_wm_target: null,
      appearance: "",
      behavior: "background attendee",
      gallery_candidates: [],
    };

    expect(resolveTargetContinuityStrength({
      target,
      registry,
    })).toBe("weak_visual");

    expect(shouldAttachWmTargetCropImages(wmTarget({
      target_id: "wm_bg",
      continuity_strength: "weak_visual",
    }))).toBe(false);
  });

  it("keeps body-only targets weak without identity, speaker, or stable face evidence", () => {
    const registry = new DetectionRegistry();
    const entry = registry.addFrame(0, [
      { class_name: "person", confidence: 0.94, bbox: { x: 90, y: 102, width: 300, height: 610 } },
    ])[0]!;
    const target: ParsedSubjectProposalTarget = {
      type: "person",
      bbox_ids: [entry.did],
      matched_wm_target: null,
      appearance: "seated guest",
      gallery_candidates: [],
    };

    expect(resolveTargetContinuityStrength({
      target,
      registry,
    })).toBe("weak_visual");

    expect(resolveTargetContinuityStrength({
      target,
      registry,
      existingTarget: wmTarget({ target_id: "wm_weak", continuity_strength: "weak_visual" }),
      currentSegmentId: "seg_prev",
    })).toBe("weak_visual");
  });

  it("promotes body-only targets to stable visual after a prior appearance", () => {
    const registry = new DetectionRegistry();
    const entry = registry.addFrame(0, [
      { class_name: "person", confidence: 0.9, bbox: { x: 90, y: 102, width: 300, height: 610 } },
    ])[0]!;
    const target: ParsedSubjectProposalTarget = {
      type: "person",
      bbox_ids: [entry.did],
      matched_wm_target: "wm_body",
      appearance: "standing person",
      gallery_candidates: [],
    };

    expect(resolveTargetContinuityStrength({
      target,
      registry,
      existingTarget: wmTarget({
        target_id: "wm_body",
        continuity_strength: "weak_visual",
        last_seen_segment_id: "seg_prev",
        segments_seen: 1,
      }),
      currentSegmentId: "seg_current",
    })).toBe("stable_visual");
  });

  it("does not count same-segment critical and final writes as two body-only appearances", () => {
    const registry = new DetectionRegistry();
    const entry = registry.addFrame(0, [
      { class_name: "person", confidence: 0.9, bbox: { x: 90, y: 102, width: 300, height: 610 } },
    ])[0]!;
    const target: ParsedSubjectProposalTarget = {
      type: "person",
      bbox_ids: [entry.did],
      matched_wm_target: "wm_body",
      appearance: "standing person",
      gallery_candidates: [],
    };

    expect(resolveTargetContinuityStrength({
      target,
      registry,
      existingTarget: wmTarget({
        target_id: "wm_body",
        continuity_strength: "weak_visual",
        last_seen_segment_id: "seg_current",
        segments_seen: 1,
      }),
      currentSegmentId: "seg_current",
    })).toBe("weak_visual");
  });
});

describe("stable target crop selection", () => {
  it("does not select a crop for unsafe anonymous WM targets", () => {
    const registry = new DetectionRegistry();
    registry.addFrame(0, [
      { class_name: "person", confidence: 0.95, bbox: { x: 0, y: 0, width: 80, height: 200 } },
    ]);
    registry.associateFace("D0", {
      bbox: { x: 10, y: 10, width: 50, height: 60 },
      landmarks: Array.from({ length: 5 }, () => ({ x: 1, y: 1 })),
      embedding: [0.9],
      entity_id: "entity_other",
      match_score: 0.95,
      quality: 0.99,
      pose: { yaw: 0, pitch: 0, roll: 0 },
      sharpness: 200,
    });

    const target: ParsedSubjectProposalTarget = {
      type: "person",
      bbox_ids: ["D0"],
      matched_wm_target: "wm_t1",
      appearance: "anonymous target",
      entity_id_source: null,
      gallery_candidates: [],
      reid_unsafe_reason: "duplicate_entity_across_wm_targets:entity_other",
    };

    const selected = selectReliableTargetCropEntry({ target, registry });

    expect(selected).toBeUndefined();
  });

  it("does not select a D{id} whose ReID entity conflicts with the target entity", () => {
    const registry = new DetectionRegistry();
    registry.addFrame(0, [
      { class_name: "person", confidence: 0.95, bbox: { x: 0, y: 0, width: 80, height: 200 } },
    ]);
    registry.addFrame(1, [
      { class_name: "person", confidence: 0.9, bbox: { x: 100, y: 0, width: 80, height: 200 } },
    ]);
    registry.associateFace("D0", {
      bbox: { x: 10, y: 10, width: 50, height: 60 },
      landmarks: Array.from({ length: 5 }, () => ({ x: 1, y: 1 })),
      embedding: [0.9],
      entity_id: "entity_other",
      match_score: 0.95,
      quality: 0.99,
      pose: { yaw: 0, pitch: 0, roll: 0 },
      sharpness: 200,
    });
    registry.associateFace("D1", {
      bbox: { x: 110, y: 10, width: 40, height: 48 },
      landmarks: Array.from({ length: 5 }, () => ({ x: 1, y: 1 })),
      embedding: [0.1],
      entity_id: "entity_target",
      match_score: 0.8,
      quality: 0.7,
      pose: { yaw: 10, pitch: 0, roll: 0 },
      sharpness: 120,
    });

    const target: ParsedSubjectProposalTarget = {
      type: "person",
      bbox_ids: ["D0", "D1"],
      matched_wm_target: "wm_t1",
      appearance: "known target",
      entity_id: "entity_target",
      entity_id_source: "wm_inherited",
      gallery_candidates: [],
      reid_unsafe_reason: "current_reid_conflicts_with_wm:preferred_wm_entity:entity_target",
    };

    const selected = selectReliableTargetCropEntry({ target, registry });

    expect(selected?.did).toBe("D1");
  });

  it("requires positive current entity evidence before updating a known WM target crop", () => {
    const registry = new DetectionRegistry();
    registry.addFrame(0, [
      { class_name: "person", confidence: 0.95, bbox: { x: 0, y: 0, width: 80, height: 200 } },
      { class_name: "person", confidence: 0.94, bbox: { x: 100, y: 0, width: 80, height: 200 } },
    ]);
    registry.associateFace("D0", {
      bbox: { x: 10, y: 10, width: 50, height: 60 },
      landmarks: Array.from({ length: 5 }, () => ({ x: 1, y: 1 })),
      embedding: [0.9],
      quality: 0.99,
      pose: { yaw: 0, pitch: 0, roll: 0 },
      sharpness: 200,
    });
    registry.associateFace("D1", {
      bbox: { x: 110, y: 10, width: 50, height: 60 },
      landmarks: Array.from({ length: 5 }, () => ({ x: 1, y: 1 })),
      embedding: [0.8],
      entity_id: "entity_other",
      match_score: 0.9,
      quality: 0.98,
      pose: { yaw: 0, pitch: 0, roll: 0 },
      sharpness: 180,
    });

    const target: ParsedSubjectProposalTarget = {
      type: "person",
      bbox_ids: ["D0", "D1"],
      matched_wm_target: "wm_t2",
      appearance: "known target",
      entity_id: "entity_target",
      entity_id_source: "wm_inherited",
      gallery_candidates: [],
    };

    const selected = selectReliableTargetCropEntry({
      target,
      registry,
      requiredEntityEvidenceId: "entity_target",
    });

    expect(selected).toBeUndefined();
  });

  it("allows the current entity creation D{id} to seed the first display crop", () => {
    const registry = new DetectionRegistry();
    registry.addFrame(0, [
      { class_name: "person", confidence: 0.95, bbox: { x: 0, y: 0, width: 80, height: 200 } },
    ]);
    registry.associateFace("D0", {
      bbox: { x: 10, y: 10, width: 50, height: 60 },
      landmarks: Array.from({ length: 5 }, () => ({ x: 1, y: 1 })),
      embedding: [0.9],
      quality: 0.99,
      pose: { yaw: 0, pitch: 0, roll: 0 },
      sharpness: 200,
    });

    const target: ParsedSubjectProposalTarget = {
      type: "person",
      bbox_ids: ["D0"],
      matched_wm_target: "wm_t2",
      appearance: "new known target",
      entity_id: "entity_target",
      entity_id_source: "current_reid",
      gallery_candidates: [],
    };

    const selected = selectReliableTargetCropEntry({
      target,
      registry,
      requiredEntityEvidenceId: "entity_target",
      preferredDid: "D0",
    });

    expect(selected?.did).toBe("D0");
  });

  it("allows preferred entity evidence to seed the crop even when VLM did selection omitted it", () => {
    const registry = new DetectionRegistry();
    registry.addFrame(0, [
      { class_name: "person", confidence: 0.95, bbox: { x: 0, y: 0, width: 80, height: 200 } },
      { class_name: "person", confidence: 0.9, bbox: { x: 100, y: 0, width: 80, height: 200 } },
    ]);
    registry.associateFace("D0", {
      bbox: { x: 10, y: 10, width: 50, height: 60 },
      landmarks: Array.from({ length: 5 }, () => ({ x: 1, y: 1 })),
      embedding: [0.9],
      quality: 0.99,
      pose: { yaw: 0, pitch: 0, roll: 0 },
      sharpness: 200,
    });

    const target: ParsedSubjectProposalTarget = {
      type: "person",
      bbox_ids: ["D0", "D1"],
      matched_wm_target: "wm_t2",
      appearance: "new known target",
      entity_id: "entity_target",
      entity_id_source: "current_reid",
      gallery_candidates: [],
    };

    const selected = selectReliableTargetCropEntry({
      target,
      registry,
      selectableDidIds: new Set(["D1"]),
      requiredEntityEvidenceId: "entity_target",
      preferredDid: "D0",
    });

    expect(selected?.did).toBe("D0");
  });

  it("selects a crop for a known WM target when a D{id} confirms the same entity", () => {
    const registry = new DetectionRegistry();
    registry.addFrame(0, [
      { class_name: "person", confidence: 0.95, bbox: { x: 0, y: 0, width: 80, height: 200 } },
      { class_name: "person", confidence: 0.94, bbox: { x: 100, y: 0, width: 80, height: 200 } },
    ]);
    registry.associateFace("D0", {
      bbox: { x: 10, y: 10, width: 50, height: 60 },
      landmarks: Array.from({ length: 5 }, () => ({ x: 1, y: 1 })),
      embedding: [0.9],
      quality: 0.99,
      pose: { yaw: 0, pitch: 0, roll: 0 },
      sharpness: 200,
    });
    registry.associateFace("D1", {
      bbox: { x: 110, y: 10, width: 50, height: 60 },
      landmarks: Array.from({ length: 5 }, () => ({ x: 1, y: 1 })),
      embedding: [0.8],
      entity_id: "entity_target",
      match_score: 0.9,
      quality: 0.7,
      pose: { yaw: 0, pitch: 0, roll: 0 },
      sharpness: 180,
    });

    const target: ParsedSubjectProposalTarget = {
      type: "person",
      bbox_ids: ["D0", "D1"],
      matched_wm_target: "wm_t2",
      appearance: "known target",
      entity_id: "entity_target",
      entity_id_source: "wm_inherited",
      gallery_candidates: [],
    };

    const selected = selectReliableTargetCropEntry({
      target,
      registry,
      requiredEntityEvidenceId: "entity_target",
    });

    expect(selected?.did).toBe("D1");
  });
});
