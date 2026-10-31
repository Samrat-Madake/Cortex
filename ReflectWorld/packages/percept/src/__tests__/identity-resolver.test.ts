import { describe, expect, it } from "vitest";
import {
  canPersistTargetIdentityName,
  classifyTargetIdentityNamePersistence,
  identityBindingKeys,
  mergeParsedTargetsByEntity,
  type ParsedSubjectProposalTarget,
  resolveIdentityClaimHints,
  resolveNameIdentityScope,
  resolveTargetIdentities,
  resolveNameIdentityBindings,
} from "../identity-resolver.js";
import { DetectionRegistry } from "../did-registry.js";
import type { WorkingMemoryTarget } from "../types.js";

function makeWmTarget(target_id: string, entity_id?: string): WorkingMemoryTarget {
  return {
    target_id,
    entity_id,
    class_name: "person",
    appearance: "person",
    crop_path: "",
    last_seen_segment_id: "seg_prev",
    last_seen_timestamp: 0,
    segments_seen: 1,
    segments_missed: 0,
  };
}

function makeParsedTarget(input: {
  bbox_ids: string[];
  matched_wm_target: string | null;
  entity_id?: string;
}): ParsedSubjectProposalTarget {
  return {
    type: "person",
    bbox_ids: input.bbox_ids,
    matched_wm_target: input.matched_wm_target,
    appearance: "person",
    entity_id: input.entity_id,
    entity_id_source: input.entity_id ? "current_reid" : null,
    gallery_candidates: [],
  };
}

function makeRegistryWithPersons(count: number): DetectionRegistry {
  const registry = new DetectionRegistry();
  for (let i = 0; i < count; i++) {
    const entry = registry.addFrame(i, [{
      class_name: "person",
      confidence: 0.95,
      bbox: { x: 20 + i * 100, y: 20, width: 80, height: 200 },
    }])[0]!;
    registry.associateFace(entry.did, {
      bbox: { x: 30 + i * 100, y: 30, width: 32, height: 36 },
      landmarks: [
        { x: 32, y: 34 },
        { x: 50, y: 34 },
        { x: 42, y: 45 },
        { x: 36, y: 58 },
        { x: 52, y: 58 },
      ],
      embedding: [0.1 + i, 0.2 + i, 0.3 + i],
      entity_id: "entity_shared",
      match_score: 0.91,
      quality: 0.9,
      pose: { yaw: 5, pitch: 2, roll: 0 },
      sharpness: 120,
    });
  }
  return registry;
}

function makeRegistryWithFace(opts: {
  entityId?: string;
  matchScore?: number;
  quality?: number;
} = {}): DetectionRegistry {
  const registry = new DetectionRegistry();
  const entry = registry.addFrame(0, [{
    class_name: "person",
    confidence: 0.95,
    bbox: { x: 20, y: 20, width: 120, height: 240 },
  }])[0]!;
  registry.associateFace(entry.did, {
    bbox: { x: 40, y: 40, width: 40, height: 48 },
    landmarks: [
      { x: 42, y: 44 },
      { x: 62, y: 44 },
      { x: 52, y: 58 },
      { x: 46, y: 76 },
      { x: 66, y: 76 },
    ],
    embedding: [0.1, 0.2, 0.3, 0.4],
    ...(opts.entityId ? { entity_id: opts.entityId } : {}),
    ...(opts.matchScore != null ? { match_score: opts.matchScore } : {}),
    quality: opts.quality ?? 0.9,
    pose: { yaw: 5, pitch: 2, roll: 0 },
    sharpness: 120,
  });
  return registry;
}

function makeRegistryWithFaceEntities(entityIds: string[]): DetectionRegistry {
  const registry = new DetectionRegistry();
  for (let i = 0; i < entityIds.length; i++) {
    const entry = registry.addFrame(i, [{
      class_name: "person",
      confidence: 0.95,
      bbox: { x: 20 + i * 140, y: 20, width: 120, height: 240 },
    }])[0]!;
    registry.associateFace(entry.did, {
      bbox: { x: 40 + i * 140, y: 40, width: 40, height: 48 },
      landmarks: [
        { x: 42, y: 44 },
        { x: 62, y: 44 },
        { x: 52, y: 58 },
        { x: 46, y: 76 },
        { x: 66, y: 76 },
      ],
      embedding: [0.1 + i, 0.2 + i, 0.3 + i, 0.4 + i],
      entity_id: entityIds[i],
      match_score: 0.91,
      quality: 0.9 - i * 0.01,
      pose: { yaw: 5, pitch: 2, roll: 0 },
      sharpness: 120,
    });
  }
  return registry;
}

function makeRegistryWithFaceEmbedding(embedding: number[], quality = 0.3): DetectionRegistry {
  const registry = new DetectionRegistry();
  const entry = registry.addFrame(0, [{
    class_name: "person",
    confidence: 0.95,
    bbox: { x: 20, y: 20, width: 120, height: 240 },
  }])[0]!;
  registry.associateFace(entry.did, {
    bbox: { x: 40, y: 40, width: 40, height: 48 },
    landmarks: [
      { x: 42, y: 44 },
      { x: 62, y: 44 },
      { x: 52, y: 58 },
      { x: 46, y: 76 },
      { x: 66, y: 76 },
    ],
    embedding,
    quality,
    pose: { yaw: 5, pitch: 4, roll: 0 },
    sharpness: 120,
  });
  return registry;
}

describe("resolveNameIdentityBindings", () => {
  it("classifies dialogue-only names as hint-only identity evidence", () => {
    expect(classifyTargetIdentityNamePersistence({
      source: "spoken",
      evidence: "The name Jensen is mentioned in the dialogue.",
      hasVisibleNameAnchor: false,
      bindsStableEntity: true,
      hasCurrentEntityAnchor: true,
    })).toBe("hint");

    expect(classifyTargetIdentityNamePersistence({
      source: "direct_address",
      evidence: "Someone says 'Jensen?' while several people are visible.",
      hasVisibleNameAnchor: false,
      bindsStableEntity: true,
      hasCurrentEntityAnchor: true,
    })).toBe("hint");

    expect(canPersistTargetIdentityName({
      source: "direct_address",
      evidence: "Someone says 'Jensen?' while several people are visible.",
      hasVisibleNameAnchor: false,
      bindsStableEntity: true,
      hasCurrentEntityAnchor: true,
    })).toBe(false);
  });

  it("allows confirmed identity sources to update stable identity names", () => {
    expect(classifyTargetIdentityNamePersistence({
      source: "self_introduction",
      evidence: "This visible speaker says 'I'm Alex'.",
      hasVisibleNameAnchor: false,
      bindsStableEntity: true,
      hasCurrentEntityAnchor: true,
    })).toBe("confirmed");

    expect(classifyTargetIdentityNamePersistence({
      source: "direct_address_response",
      evidence: "The addressed visible person immediately responds after the name.",
      hasVisibleNameAnchor: false,
      bindsStableEntity: true,
      hasCurrentEntityAnchor: true,
    })).toBe("confirmed");
  });

  it("requires current identity evidence before binding a name to an inherited stable entity", () => {
    expect(canPersistTargetIdentityName({
      source: "visible_text",
      evidence: "Visible lower-third names him Michael Dell.",
      hasVisibleNameAnchor: true,
      bindsStableEntity: false,
      hasCurrentEntityAnchor: false,
    })).toBe(true);

    expect(canPersistTargetIdentityName({
      source: "visible_text",
      evidence: "Visible lower-third names him Jensen Huang.",
      hasVisibleNameAnchor: true,
      bindsStableEntity: true,
      hasCurrentEntityAnchor: false,
    })).toBe(false);

    expect(canPersistTargetIdentityName({
      source: "visible_text",
      evidence: "Visible lower-third names him Michael Dell.",
      hasVisibleNameAnchor: true,
      bindsStableEntity: true,
      hasCurrentEntityAnchor: true,
    })).toBe(true);
  });

  it("rejects visible-text identity without a current visual name anchor", () => {
    expect(canPersistTargetIdentityName({
      source: "visible_text",
      evidence: "Visible lower-third names him Michael Dell.",
      hasVisibleNameAnchor: false,
      bindsStableEntity: false,
      hasCurrentEntityAnchor: false,
    })).toBe(false);
  });

  it("allows explicit nameplate evidence without the generic visible-text anchor gate", () => {
    expect(canPersistTargetIdentityName({
      source: "visible_nameplate",
      evidence: "A lower-third nameplate is attached to the focused speaker.",
      hasVisibleNameAnchor: false,
      bindsStableEntity: false,
      hasCurrentEntityAnchor: false,
    })).toBe(true);

    expect(canPersistTargetIdentityName({
      source: "visible_nameplate",
      evidence: "A lower-third nameplate is attached to the focused speaker.",
      hasVisibleNameAnchor: false,
      bindsStableEntity: true,
      hasCurrentEntityAnchor: true,
    })).toBe(true);
  });

  it("does not bind a non-canonical D id to an event-local WM target without a stable entity", () => {
    const scope = resolveNameIdentityScope({
      rawTrackId: "D7",
      normalizedTrackId: "D0",
      canonicalTrackId: "D7",
      targetIdForTrack: (trackId) => trackId === "D7" ? "wm_t1" : undefined,
    });

    expect(scope?.targetId).toBeUndefined();
    expect(scope?.bindingKeys).toEqual(["track:D7"]);
  });

  it("allows non-canonical D id name binding when a stable entity anchors the claim", () => {
    const scope = resolveNameIdentityScope({
      rawTrackId: "D7",
      normalizedTrackId: "D0",
      canonicalTrackId: "D7",
      entityId: "entity_guest",
      targetIdForTrack: (trackId) => trackId === "D7" ? "wm_t1" : undefined,
      existingNameForTarget: () => "Guest",
    });

    expect(scope?.targetId).toBe("wm_t1");
    expect(scope?.existingTargetName).toBe("Guest");
    expect(scope?.bindingKeys).toEqual(["target:wm_t1", "entity:entity_guest", "track:D7"]);
  });

  it("allows repeated aliases for the same identity scope", () => {
    const decisions = resolveNameIdentityBindings([
      {
        candidate_id: "dialogue:0:D1",
        name: "Jensen Huang",
        binding_keys: identityBindingKeys({ targetId: "wm_t1", entityId: "entity_1", trackId: "D1" }),
      },
      {
        candidate_id: "speaker:0:D2",
        name: "Jensen Huang",
        binding_keys: identityBindingKeys({ targetId: "wm_t1", entityId: "entity_1", trackId: "D2" }),
      },
    ]);

    expect(decisions.get("dialogue:0:D1")?.allowed).toBe(true);
    expect(decisions.get("speaker:0:D2")?.allowed).toBe(true);
  });

  it("blocks one identity scope from receiving multiple different names", () => {
    const decisions = resolveNameIdentityBindings([
      {
        candidate_id: "dialogue:0:D1",
        name: "Jensen Huang",
        binding_keys: identityBindingKeys({ targetId: "wm_t1", entityId: "entity_1", trackId: "D1" }),
      },
      {
        candidate_id: "dialogue:1:D1",
        name: "Michael Dell",
        binding_keys: identityBindingKeys({ targetId: "wm_t1", entityId: "entity_1", trackId: "D1" }),
      },
    ]);

    expect(decisions.get("dialogue:0:D1")?.allowed).toBe(false);
    expect(decisions.get("dialogue:0:D1")?.reason).toBe("same_binding_multiple_names");
    expect(decisions.get("dialogue:1:D1")?.allowed).toBe(false);
  });

  it("blocks one name from being assigned to disjoint identity scopes", () => {
    const decisions = resolveNameIdentityBindings([
      {
        candidate_id: "dialogue:0:D1",
        name: "Jensen Huang",
        binding_keys: identityBindingKeys({ targetId: "wm_t1", entityId: "entity_1", trackId: "D1" }),
      },
      {
        candidate_id: "dialogue:1:D7",
        name: "Jensen Huang",
        binding_keys: identityBindingKeys({ targetId: "wm_t7", entityId: "entity_7", trackId: "D7" }),
      },
    ]);

    expect(decisions.get("dialogue:0:D1")?.allowed).toBe(false);
    expect(decisions.get("dialogue:0:D1")?.reason).toBe("same_name_multiple_bindings");
    expect(decisions.get("dialogue:1:D7")?.allowed).toBe(false);
  });

  it("treats existing stable names as binding constraints", () => {
    const decisions = resolveNameIdentityBindings([
      {
        candidate_id: "dialogue:0:D1",
        name: "Jensen Huang",
        binding_keys: identityBindingKeys({ targetId: "wm_t1", trackId: "D1" }),
        existing_name: "Michael Dell",
      },
    ]);

    expect(decisions.get("dialogue:0:D1")?.allowed).toBe(false);
    expect(decisions.get("dialogue:0:D1")?.reason).toBe("same_binding_multiple_names");
  });

  it("blocks candidates without any identity scope", () => {
    const decisions = resolveNameIdentityBindings([
      {
        candidate_id: "dialogue:0:missing",
        name: "Jensen Huang",
        binding_keys: [],
      },
    ]);

    expect(decisions.get("dialogue:0:missing")?.allowed).toBe(false);
    expect(decisions.get("dialogue:0:missing")?.reason).toBe("missing_binding");
  });
});

describe("mergeParsedTargetsByEntity", () => {
  it("does not merge one ReID entity across distinct WM identity claims", () => {
    const registry = makeRegistryWithPersons(3);
    const wmTargets = [
      makeWmTarget("wm_t1", "entity_other_1"),
      makeWmTarget("wm_t2", "entity_shared"),
      makeWmTarget("wm_t3", "entity_other_3"),
    ];
    const targets = [
      makeParsedTarget({ bbox_ids: ["D0"], matched_wm_target: "wm_t2", entity_id: "entity_shared" }),
      makeParsedTarget({ bbox_ids: ["D1"], matched_wm_target: "wm_t1", entity_id: "entity_shared" }),
      makeParsedTarget({ bbox_ids: ["D2"], matched_wm_target: "wm_t3", entity_id: "entity_shared" }),
    ];
    const errors: string[] = [];

    mergeParsedTargetsByEntity(targets, registry, wmTargets, errors);

    expect(targets).toHaveLength(3);
    expect(targets[0]?.entity_id).toBe("entity_shared");
    expect(targets[1]?.entity_id).toBeUndefined();
    expect(targets[1]?.entity_id_source).toBeNull();
    expect(targets[1]?.reid_unsafe_reason).toBe("duplicate_entity_across_wm_targets:entity_shared");
    expect(targets[2]?.entity_id).toBeUndefined();
    expect(targets[2]?.entity_id_source).toBeNull();
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("conflicting identity context"),
    ]));
  });

  it("still merges split targets when they share the same WM identity", () => {
    const registry = makeRegistryWithPersons(2);
    const wmTargets = [
      makeWmTarget("wm_t2", "entity_shared"),
    ];
    const targets = [
      makeParsedTarget({ bbox_ids: ["D0"], matched_wm_target: "wm_t2", entity_id: "entity_shared" }),
      makeParsedTarget({ bbox_ids: ["D1"], matched_wm_target: "wm_t2", entity_id: "entity_shared" }),
    ];
    const errors: string[] = [];

    mergeParsedTargetsByEntity(targets, registry, wmTargets, errors);

    expect(targets).toHaveLength(1);
    expect(targets[0]?.entity_id).toBe("entity_shared");
    expect(targets[0]?.bbox_ids).toHaveLength(2);
    expect(targets[0]?.bbox_ids).toEqual(expect.arrayContaining(["D0", "D1"]));
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("targets merged"),
    ]));
  });

  it("merges a same-entity split into the explicit VLM WM claim without inferring a WM claim", () => {
    const registry = makeRegistryWithPersons(3);
    const wmTargets = [
      makeWmTarget("wm_t2", "entity_shared"),
      makeWmTarget("wm_t1"),
    ];

    const hints = resolveIdentityClaimHints({
      registry,
      wmTargets,
      targets: [
        { targetIdx: 0, type: "person", bbox_ids: ["D0"], matched_wm_target: "wm_t2" },
        { targetIdx: 1, type: "person", bbox_ids: ["D1"], matched_wm_target: null },
        { targetIdx: 2, type: "person", bbox_ids: ["D2"], matched_wm_target: "wm_t1" },
      ],
    });

    expect(hints.targets[0]?.matched_wm_target).toBe("wm_t2");
    expect(hints.targets[0]?.matched_wm_target_source).toBe("vlm");
    expect(hints.targets[1]?.matched_wm_target).toBeNull();
    expect(hints.targets[1]?.matched_wm_target_source).toBeUndefined();
    expect(hints.targets[1]?.reid_unsafe_reason).toBeUndefined();

    const resolved = resolveTargetIdentities({
      registry,
      wmTargets,
      targets: hints.targets.map((target) => ({
        ...target,
        type: "person",
        appearance: `target ${target.targetIdx}`,
      })),
    });

    expect(resolved.targets).toHaveLength(2);
    expect(resolved.targets[0]?.matched_wm_target).toBe("wm_t2");
    expect(resolved.targets[0]?.entity_id).toBe("entity_shared");
    expect(resolved.targets[0]?.bbox_ids).toEqual(["D0", "D1"]);
    expect(resolved.targets[1]?.matched_wm_target).toBe("wm_t1");
    expect(resolved.targets[1]?.entity_id).toBeUndefined();
    expect(resolved.targets[1]?.reid_unsafe_reason).toBe("current_reid_belongs_to_existing_wm:entity_shared:wm_t2");
    expect(resolved.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("targets merged"),
      expect.stringContaining("not upgraded because current ReID entity"),
    ]));
  });
});

describe("resolveIdentityClaimHints", () => {
  it("infers missing anonymous WM matches from pending face continuity", () => {
    const registry = makeRegistryWithFaceEmbedding([1, 0, 0], 0.3);
    const wmTargets: WorkingMemoryTarget[] = [
      {
        ...makeWmTarget("wm_t1"),
        pending_face_embeddings: [{ embedding: [1, 0, 0], quality: 0.3, segment_id: "seg_prev", did: "D_prev_left" }],
      },
      {
        ...makeWmTarget("wm_t3"),
        pending_face_embeddings: [{ embedding: [0, 1, 0], quality: 0.3, segment_id: "seg_prev", did: "D_prev_right" }],
      },
    ];

    const output = resolveIdentityClaimHints({
      registry,
      wmTargets,
      targets: [{
        targetIdx: 0,
        type: "person",
        bbox_ids: ["D0"],
        matched_wm_target: null,
      }],
    });

    expect(output.targets[0]?.matched_wm_target).toBe("wm_t1");
    expect(output.targets[0]?.matched_wm_target_source).toBe("pending_face");
    expect(output.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('matched_wm_target inferred as "wm_t1" from pending face continuity'),
    ]));
  });

  it("vetoes VLM anonymous WM matches when pending face continuity points to another target", () => {
    const registry = makeRegistryWithFaceEmbedding([1, 0, 0], 0.3);
    const wmTargets: WorkingMemoryTarget[] = [
      {
        ...makeWmTarget("wm_t1"),
        pending_face_embeddings: [{ embedding: [1, 0, 0], quality: 0.3, segment_id: "seg_prev", did: "D_prev_left" }],
      },
      {
        ...makeWmTarget("wm_t3"),
        pending_face_embeddings: [{ embedding: [0, 1, 0], quality: 0.3, segment_id: "seg_prev", did: "D_prev_right" }],
      },
    ];

    const output = resolveIdentityClaimHints({
      registry,
      wmTargets,
      targets: [{
        targetIdx: 0,
        type: "person",
        bbox_ids: ["D0"],
        matched_wm_target: "wm_t3",
      }],
    });

    expect(output.targets[0]?.matched_wm_target).toBeNull();
    expect(output.targets[0]?.matched_wm_target_source).toBeUndefined();
    expect(output.targets[0]?.reid_unsafe_reason).toBeUndefined();
    expect(output.targets[0]?.matched_wm_target_rejected_reason).toContain("pending_face_continuity_vetoes_vlm_wm");
    expect(output.targets[0]?.visual_identity_only).toBe(true);
    expect(output.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('pending face continuity preferred "wm_t1"'),
    ]));
  });

  it("vetoes but does not reassign VLM WM matches when pending face continuity is ambiguous", () => {
    const registry = makeRegistryWithFaceEmbedding([0.71, 0.69, 0], 0.3);
    const wmTargets: WorkingMemoryTarget[] = [
      {
        ...makeWmTarget("wm_t1"),
        pending_face_embeddings: [{ embedding: [1, 0, 0], quality: 0.3, segment_id: "seg_prev", did: "D_prev_left" }],
      },
      {
        ...makeWmTarget("wm_t3"),
        pending_face_embeddings: [{ embedding: [0, 1, 0], quality: 0.3, segment_id: "seg_prev", did: "D_prev_right" }],
      },
    ];

    const output = resolveIdentityClaimHints({
      registry,
      wmTargets,
      targets: [{
        targetIdx: 0,
        type: "person",
        bbox_ids: ["D0"],
        matched_wm_target: "wm_t3",
      }],
    });

    expect(output.targets[0]?.matched_wm_target).toBeNull();
    expect(output.targets[0]?.matched_wm_target_source).toBeUndefined();
    expect(output.targets[0]?.reid_unsafe_reason).toBeUndefined();
    expect(output.targets[0]?.matched_wm_target_rejected_reason).toContain("pending_face_continuity_ambiguous");
    expect(output.targets[0]?.visual_identity_only).toBe(true);
    expect(output.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("pending face continuity ambiguous"),
    ]));
  });
});

describe("resolveTargetIdentities", () => {
  it("keeps visual-only ReID seed candidate without gallery or display writes", () => {
    const registry = makeRegistryWithFace();
    const output = resolveTargetIdentities({
      registry,
      wmTargets: [],
      targets: [{
        targetIdx: 0,
        type: "person",
        bbox_ids: ["D0"],
        matched_wm_target: null,
        matched_wm_target_rejected_reason: "pending_face_continuity_vetoes_vlm_wm:wm_t3:best:wm_t1:score:0.99",
        visual_identity_only: true,
        appearance: "person",
      }],
    });

    expect(output.targets[0]?.visual_identity_only).toBe(true);
    expect(output.targets[0]?.matched_wm_target_rejected_reason).toContain("pending_face_continuity_vetoes_vlm_wm");
    expect(output.targets[0]?.upsert_candidate?.did).toBe("D0");
    expect(output.targets[0]?.gallery_candidates).toEqual([]);
    expect(output.targets[0]?.gallery_write_dids).toEqual([]);
    expect(output.targets[0]?.display_crop_dids).toEqual([]);
    expect(output.targets[0]?.identity_write_safe).toBe(false);
    expect(output.targets[0]?.resolution_outcome).toBe("display_only");
  });

  it("does not append unmatched face gallery for wm-inherited identity", () => {
    const registry = makeRegistryWithFace();
    const output = resolveTargetIdentities({
      registry,
      wmTargets: [makeWmTarget("wm_t1", "entity_host")],
      targets: [{
        targetIdx: 0,
        type: "person",
        bbox_ids: ["D0"],
        matched_wm_target: "wm_t1",
        appearance: "host",
      }],
    });

    expect(output.targets[0]?.entity_id).toBe("entity_host");
    expect(output.targets[0]?.entity_id_source).toBe("wm_inherited");
    expect(output.targets[0]?.gallery_candidates).toEqual([]);
    expect(output.targets[0]?.gallery_write_dids).toEqual([]);
    expect(output.targets[0]?.resolution_outcome).toBe("display_only");
    expect(output.targets[0]?.identity_write_safe).toBe(false);
    expect(output.targets[0]?.upsert_candidate).toBeUndefined();
  });

  it("rejects matched WM inheritance when current face does not match stable entity anchors", () => {
    const registry = makeRegistryWithFaceEmbedding([0, 1, 0, 0], 0.9);
    const output = resolveTargetIdentities({
      registry,
      wmTargets: [{
        ...makeWmTarget("wm_t1", "entity_host"),
        stable_face_embeddings: [{ embedding: [1, 0, 0, 0], quality: 0.9, segment_id: "seg_prev", did: "D_prev" }],
      }],
      targets: [{
        targetIdx: 0,
        type: "person",
        bbox_ids: ["D0"],
        matched_wm_target: "wm_t1",
        appearance: "different visible person",
      }],
    });

    expect(output.targets[0]?.matched_wm_target).toBeNull();
    expect(output.targets[0]?.entity_id).toBeUndefined();
    expect(output.targets[0]?.entity_id_source).toBeNull();
    expect(output.targets[0]?.matched_wm_target_rejected_reason).toContain("wm_entity_visual_unconfirmed:entity_host");
    expect(output.targets[0]?.upsert_candidate?.did).toBe("D0");
    expect(output.targets[0]?.identity_write_safe).toBe(true);
    expect(output.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('matched wm_target "wm_t1" entity "entity_host" rejected'),
    ]));
  });

  it("confirms matched WM inheritance when current face matches stable entity anchors", () => {
    const registry = makeRegistryWithFaceEmbedding([1, 0, 0, 0], 0.9);
    const output = resolveTargetIdentities({
      registry,
      wmTargets: [{
        ...makeWmTarget("wm_t1", "entity_host"),
        stable_face_embeddings: [{ embedding: [1, 0, 0, 0], quality: 0.9, segment_id: "seg_prev", did: "D_prev" }],
      }],
      targets: [{
        targetIdx: 0,
        type: "person",
        bbox_ids: ["D0"],
        matched_wm_target: "wm_t1",
        appearance: "same visible person",
      }],
    });

    expect(output.targets[0]?.matched_wm_target).toBe("wm_t1");
    expect(output.targets[0]?.entity_id).toBe("entity_host");
    expect(output.targets[0]?.entity_id_source).toBe("current_reid");
    expect(output.targets[0]?.gallery_candidates).toEqual([
      expect.objectContaining({ did: "D0", entity_id: "entity_host", trust: "unmatched" }),
    ]);
    expect(output.targets[0]?.identity_write_safe).toBe(true);
  });

  it("keeps matched WM semantics but drops conflicting visual evidence when current face ReID conflicts with the WM entity", () => {
    const registry = makeRegistryWithFace({ entityId: "entity_other", matchScore: 0.91 });
    const output = resolveTargetIdentities({
      registry,
      wmTargets: [makeWmTarget("wm_t1", "entity_host")],
      targets: [{
        targetIdx: 0,
        type: "person",
        bbox_ids: ["D0"],
        matched_wm_target: "wm_t1",
        appearance: "host",
      }],
    });

    expect(output.targets[0]?.entity_id).toBe("entity_host");
    expect(output.targets[0]?.entity_id_source).toBe("wm_inherited");
    expect(output.targets[0]?.matched_wm_target).toBe("wm_t1");
    expect(output.targets[0]?.bbox_ids).toEqual(["D0"]);
    expect(output.targets[0]?.dropped_dids).toEqual([
      { did: "D0", reason: "conflicts_with_wm_entity:entity_host" },
    ]);
    expect(output.targets[0]?.gallery_candidates).toEqual([]);
    expect(output.targets[0]?.display_crop_dids).toEqual([]);
    expect(output.targets[0]?.identity_write_safe).toBe(false);
    expect(output.targets[0]?.resolution_outcome).toBe("display_only");
    expect(output.targets[0]?.reid_unsafe_reason).toBe("current_reid_conflicts_with_wm:entity_host");
  });

  it("fills a missing matched WM from clean current ReID when a canonical WM target already exists", () => {
    const registry = makeRegistryWithFace({ entityId: "entity_known", matchScore: 0.91 });
    const output = resolveTargetIdentities({
      registry,
      wmTargets: [makeWmTarget("wm_t4", "entity_known"), makeWmTarget("wm_t2", "entity_known")],
      targets: [{
        targetIdx: 0,
        type: "person",
        bbox_ids: ["D0"],
        matched_wm_target: null,
        appearance: "known person",
      }],
    });

    expect(output.targets[0]?.matched_wm_target).toBe("wm_t2");
    expect(output.targets[0]?.entity_id).toBe("entity_known");
    expect(output.targets[0]?.entity_id_source).toBe("current_reid");
    expect(output.targets[0]?.bbox_ids).toEqual(["D0"]);
    expect(output.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('matched_wm_target inferred as "wm_t2"'),
    ]));
  });

  it("supplements matched WM visual evidence from unclaimed D ids after dropping conflicting D ids", () => {
    const registry = makeRegistryWithFaceEntities(["entity_other", "entity_host"]);
    const output = resolveTargetIdentities({
      registry,
      wmTargets: [makeWmTarget("wm_t1", "entity_host")],
      targets: [{
        targetIdx: 0,
        type: "person",
        bbox_ids: ["D0"],
        matched_wm_target: "wm_t1",
        appearance: "host",
      }],
    });

    expect(output.targets[0]?.matched_wm_target).toBe("wm_t1");
    expect(output.targets[0]?.entity_id).toBe("entity_host");
    expect(output.targets[0]?.entity_id_source).toBe("current_reid");
    expect(output.targets[0]?.bbox_ids).toEqual(["D1"]);
    expect(output.targets[0]?.dropped_dids).toEqual([
      { did: "D0", reason: "replaced_by_unclaimed_wm_entity_evidence:entity_host" },
    ]);
    expect(output.targets[0]?.gallery_write_dids).toEqual(["D1"]);
  });

  it("does not upgrade an anonymous matched WM with a current entity that already has a canonical WM target", () => {
    const registry = makeRegistryWithFace({ entityId: "entity_known", matchScore: 0.91 });
    const output = resolveTargetIdentities({
      registry,
      wmTargets: [makeWmTarget("wm_t1"), makeWmTarget("wm_t3", "entity_known")],
      targets: [{
        targetIdx: 0,
        type: "person",
        bbox_ids: ["D0"],
        matched_wm_target: "wm_t1",
        appearance: "anonymous semantic target",
      }],
    });

    expect(output.targets[0]?.matched_wm_target).toBe("wm_t1");
    expect(output.targets[0]?.entity_id).toBeUndefined();
    expect(output.targets[0]?.entity_id_source).toBeNull();
    expect(output.targets[0]?.gallery_candidates).toEqual([]);
    expect(output.targets[0]?.upsert_candidate).toBeUndefined();
    expect(output.targets[0]?.reid_unsafe_reason).toBe("current_reid_belongs_to_existing_wm:entity_known:wm_t3");
    expect(output.targets[0]?.resolution_outcome).toBe("display_only");
  });
});
