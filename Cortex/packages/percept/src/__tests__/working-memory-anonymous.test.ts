import { describe, it, expect } from "vitest";
import { WorkingMemoryManager } from "../working-memory.js";
import type { AnonymousSubjectContext, WorkingMemoryTarget } from "../types.js";

function makeAnon(id: string, ts = 1000): AnonymousSubjectContext {
  return {
    anonymous_subject_id: id,
    class_name: "person",
    appearance: "test",
    crop_path: `/tmp/${id}.jpg`,
    last_seen_segment_id: "seg_0",
    last_seen_timestamp: ts,
    segments_seen: 1,
    segments_missed: 0,
  };
}

describe("WorkingMemoryManager anonymous subjects", () => {
  it("upsert and get anonymous subjects", () => {
    const wm = new WorkingMemoryManager({ event_timeout_sec: 30 });
    wm.upsertAnonymousSubject("cam1", makeAnon("anon_1"));
    wm.upsertAnonymousSubject("cam1", makeAnon("anon_2"));
    expect(wm.getAnonymousSubjects("cam1")).toHaveLength(2);
  });

  it("tickAnonymousMiss increments segments_missed for unmatched and evicts stale", () => {
    const wm = new WorkingMemoryManager({ event_timeout_sec: 30 });
    wm.upsertAnonymousSubject("cam1", makeAnon("anon_1"));
    wm.upsertAnonymousSubject("cam1", makeAnon("anon_2"));

    // Miss all
    wm.tickAnonymousMiss("cam1", new Set());
    expect(wm.getAnonymousSubjects("cam1")[0]!.segments_missed).toBe(1);

    wm.tickAnonymousMiss("cam1", new Set());
    expect(wm.getAnonymousSubjects("cam1")[0]!.segments_missed).toBe(2);

    wm.tickAnonymousMiss("cam1", new Set());
    expect(wm.getAnonymousSubjects("cam1")[0]!.segments_missed).toBe(3);

    // 4th miss → evicted (max_missed = 3)
    wm.tickAnonymousMiss("cam1", new Set());
    expect(wm.getAnonymousSubjects("cam1")).toHaveLength(0);
  });

  it("newly created anonymous subject stays at segments_missed 0 when in matchedIds", () => {
    const wm = new WorkingMemoryManager({ event_timeout_sec: 30 });
    const anon = makeAnon("anon_new");
    wm.upsertAnonymousSubject("cam1", anon);

    // Tick with anon_new in matchedIds — should NOT increment missed
    wm.tickAnonymousMiss("cam1", new Set(["anon_new"]));
    expect(wm.getAnonymousSubjects("cam1")[0]!.segments_missed).toBe(0);
  });

  it("enforces LRU cap of 8 anonymous subjects", () => {
    const wm = new WorkingMemoryManager({ event_timeout_sec: 30 });
    for (let i = 0; i < 10; i++) {
      wm.upsertAnonymousSubject("cam1", makeAnon(`anon_${i}`, 1000 + i));
    }
    const subjects = wm.getAnonymousSubjects("cam1");
    expect(subjects).toHaveLength(8);
    // Most recent should survive (LRU by last_seen_timestamp DESC)
    expect(subjects.some((s) => s.anonymous_subject_id === "anon_9")).toBe(true);
    expect(subjects.some((s) => s.anonymous_subject_id === "anon_0")).toBe(false);
  });
});

// ── Subject Target Continuity ──

function makeTarget(id: string, ts = 1000): WorkingMemoryTarget {
  return {
    target_id: id,
    class_name: "person",
    appearance: "test appearance",
    crop_path: `/tmp/${id}.jpg`,
    last_seen_segment_id: "seg_0",
    last_seen_timestamp: ts,
    segments_seen: 1,
    segments_missed: 0,
  };
}

describe("WorkingMemoryManager subject target continuity", () => {
  it("getTargets returns empty array for fresh camera", () => {
    const wm = new WorkingMemoryManager({ event_timeout_sec: 30 });
    expect(wm.getTargets("cam1")).toEqual([]);
  });

  it("upsertTarget and getTargets round-trip", () => {
    const wm = new WorkingMemoryManager({ event_timeout_sec: 30 });
    wm.upsertTarget("cam1", makeTarget("wm_t1"));
    wm.upsertTarget("cam1", makeTarget("wm_t2"));
    expect(wm.getTargets("cam1")).toHaveLength(2);
  });

  it("upsertTarget updates existing target by target_id", () => {
    const wm = new WorkingMemoryManager({ event_timeout_sec: 30 });
    wm.upsertTarget("cam1", makeTarget("wm_t1", 1000));
    wm.upsertTarget("cam1", { ...makeTarget("wm_t1", 2000), appearance: "updated" });
    const targets = wm.getTargets("cam1");
    expect(targets).toHaveLength(1);
    expect(targets[0]!.appearance).toBe("updated");
    expect(targets[0]!.last_seen_timestamp).toBe(2000);
  });

  it("ignores stale target updates from older segments", () => {
    const wm = new WorkingMemoryManager({ event_timeout_sec: 30 });
    wm.upsertTarget("cam1", {
      ...makeTarget("wm_t1", 2000),
      appearance: "newer appearance",
      behavior: "newer behavior",
    });
    wm.upsertTarget("cam1", {
      ...makeTarget("wm_t1", 1000),
      appearance: "stale appearance",
      behavior: "stale behavior",
    });

    const target = wm.getTargets("cam1")[0]!;
    expect(target.appearance).toBe("newer appearance");
    expect(target.behavior).toBe("newer behavior");
    expect(target.last_seen_timestamp).toBe(2000);
  });

  it("preserves existing appearance and behavior when an update omits them as empty strings", () => {
    const wm = new WorkingMemoryManager({ event_timeout_sec: 30 });
    wm.upsertTarget("cam1", {
      ...makeTarget("wm_t1", 1000),
      appearance: "person in a red hat",
      behavior: "walking",
    });
    wm.upsertTarget("cam1", { ...makeTarget("wm_t1", 2000), appearance: "", behavior: "" });
    const targets = wm.getTargets("cam1");
    expect(targets).toHaveLength(1);
    expect(targets[0]!.appearance).toBe("person in a red hat");
    expect(targets[0]!.behavior).toBe("walking");
  });

  it("coerces non-string target appearance updates without throwing", () => {
    const wm = new WorkingMemoryManager({ event_timeout_sec: 30 });
    wm.upsertTarget("cam1", { ...makeTarget("wm_t1", 1000), appearance: ["blue jacket", { hat: "red" }] as any });
    const targets = wm.getTargets("cam1");
    expect(targets).toHaveLength(1);
    expect(targets[0]!.appearance).toBe('blue jacket, {"hat":"red"}');
  });

  it("keeps event-local target identity across target updates and promotion", () => {
    const wm = new WorkingMemoryManager({ event_timeout_sec: 30 });
    wm.upsertTarget("cam1", makeTarget("wm_t1", 1000));

    expect(wm.setTargetIdentity("cam1", "wm_t1", {
      name: "Lily",
      evidence: "addressed as Lily",
      source_segment_id: "seg_0",
    })).toBe(true);

    wm.upsertTarget("cam1", { ...makeTarget("wm_t1", 2000), entity_id: "entity_lily", appearance: "updated" });
    expect(wm.getTargetIdentity("cam1", "wm_t1")).toMatchObject({
      name: "Lily",
      evidence: "addressed as Lily",
      source_segment_id: "seg_0",
    });

    wm.markTargetIdentityPromoted("cam1", "wm_t1", "entity_lily");
    expect(wm.getTargetIdentity("cam1", "wm_t1")?.promoted_entity_id).toBe("entity_lily");
  });

  it("stores weak identity hints separately from confirmed target identity", () => {
    const wm = new WorkingMemoryManager({ event_timeout_sec: 30 });
    wm.upsertTarget("cam1", makeTarget("wm_t1", 1000));

    expect(wm.addTargetIdentityHint("cam1", "wm_t1", {
      name: "Lily",
      evidence: "addressed as Lily",
      source_segment_id: "seg_0",
      source: "direct_address",
    })).toBe(true);
    expect(wm.addTargetIdentityHint("cam1", "wm_t1", {
      name: "Lily",
      evidence: "addressed as Lily",
      source_segment_id: "seg_0",
      source: "direct_address",
    })).toBe(true);

    const target = wm.getTargets("cam1")[0]!;
    expect(target.identity).toBeUndefined();
    expect(target.identity_hints).toEqual([
      expect.objectContaining({
        name: "Lily",
        evidence: "addressed as Lily",
        source: "direct_address",
      }),
    ]);

    expect(wm.setTargetIdentity("cam1", "wm_t1", {
      name: "Lily",
      evidence: "Lily introduces themself",
      source_segment_id: "seg_1",
    })).toBe(true);
    expect(wm.getTargets("cam1")[0]?.identity_hints).toBeUndefined();
  });

  it("upgrades an anonymous target in place when it receives an entity", () => {
    const wm = new WorkingMemoryManager({ event_timeout_sec: 30 });
    wm.upsertTarget("cam1", {
      ...makeTarget("wm_t1", 1000),
      appearance: "anonymous host",
      stable_crops: [
        {
          crop_path: "/tmp/host-face.jpg",
          segment_id: "seg_0",
          did: "D0",
          score: 0.9,
          timestamp: 1000,
          source: "face",
        },
      ],
    });

    const canonicalId = wm.upsertTarget("cam1", {
      ...makeTarget("wm_t1", 2000),
      entity_id: "entity_host",
      appearance: "named host",
      behavior: "speaking",
    });

    const targets = wm.getTargets("cam1");
    expect(canonicalId).toBe("wm_t1");
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      target_id: "wm_t1",
      entity_id: "entity_host",
      appearance: "named host",
      behavior: "speaking",
    });
    expect(targets[0]!.stable_crops?.[0]?.crop_path).toBe("/tmp/host-face.jpg");
  });

  it("canonicalizes duplicate targets for the same entity and inherits target state", () => {
    const wm = new WorkingMemoryManager({ event_timeout_sec: 30 });
    wm.upsertTarget("cam1", {
      ...makeTarget("wm_t1", 1000),
      appearance: "early host",
      entity_id: "entity_host",
      stable_crops: [
        {
          crop_path: "/tmp/low.jpg",
          segment_id: "seg_0",
          did: "D0",
          score: 0.4,
          timestamp: 1000,
          source: "fallback",
        },
      ],
    });
    wm.upsertTarget("cam1", {
      ...makeTarget("wm_t2", 2000),
      appearance: "later host",
      behavior: "answering",
      entity_id: "entity_host",
      stable_crops: [
        {
          crop_path: "/tmp/high.jpg",
          segment_id: "seg_1",
          did: "D5",
          score: 0.95,
          timestamp: 2000,
          source: "face",
        },
      ],
      pending_face_embeddings: [
        { embedding: [0.1, 0.2], quality: 0.8, segment_id: "seg_1", did: "D5" },
      ],
    });
    expect(wm.setTargetIdentity("cam1", "wm_t1", {
      name: "Host",
      evidence: "lower-third label",
      source_segment_id: "seg_0",
    })).toBe(true);

    const canonicalId = wm.upsertTarget("cam1", {
      ...makeTarget("wm_t3", 3000),
      appearance: "current host",
      entity_id: "entity_host",
    });

    const targets = wm.getTargets("cam1");
    expect(canonicalId).toBe("wm_t1");
    expect(targets.filter((target) => target.entity_id === "entity_host")).toHaveLength(1);
    const target = targets.find((item) => item.target_id === "wm_t1")!;
    expect(target.appearance).toBe("current host");
    expect(target.behavior).toBe("answering");
    expect(target.segments_seen).toBeGreaterThanOrEqual(3);
    expect(target.stable_crops?.[0]?.crop_path).toBe("/tmp/high.jpg");
    expect(target.pending_face_embeddings?.[0]?.did).toBe("D5");
    expect(target.identity?.name).toBe("Host");
  });

  it("keeps the older canonical target when a later anonymous split receives the same entity", () => {
    const wm = new WorkingMemoryManager({ event_timeout_sec: 30 });
    wm.upsertTarget("cam1", {
      ...makeTarget("wm_t1", 1000),
      appearance: "stable host",
      behavior: "moderating",
      entity_id: "entity_host",
      segments_seen: 5,
      stable_crops: [
        {
          crop_path: "/tmp/host-face.jpg",
          segment_id: "seg_0",
          did: "D0",
          score: 0.9,
          timestamp: 1000,
          source: "face",
        },
      ],
    });
    wm.upsertTarget("cam1", {
      ...makeTarget("wm_t4", 2000),
      appearance: "split host",
      behavior: "asking a question",
      segments_seen: 2,
      stable_crops: [
        {
          crop_path: "/tmp/host-body.jpg",
          segment_id: "seg_1",
          did: "D8",
          score: 0.8,
          timestamp: 2000,
          source: "body",
        },
      ],
    });

    const canonicalId = wm.upsertTarget("cam1", {
      ...makeTarget("wm_t4", 3000),
      appearance: "split host upgraded",
      entity_id: "entity_host",
      segments_seen: 3,
    });

    const targets = wm.getTargets("cam1");
    expect(canonicalId).toBe("wm_t1");
    expect(targets.filter((target) => target.entity_id === "entity_host")).toHaveLength(1);
    const canonical = targets.find((target) => target.target_id === "wm_t1")!;
    expect(canonical.appearance).toBe("split host upgraded");
    expect(canonical.behavior).toBe("asking a question");
    expect(canonical.stable_crops?.map((crop) => crop.crop_path).slice(0, 2)).toEqual([
      "/tmp/host-face.jpg",
      "/tmp/host-body.jpg",
    ]);
  });

  it("marks conflicting names on the same target instead of overwriting", () => {
    const wm = new WorkingMemoryManager({ event_timeout_sec: 30 });
    wm.upsertTarget("cam1", makeTarget("wm_t1", 1000));
    expect(wm.setTargetIdentity("cam1", "wm_t1", {
      name: "Lily",
      evidence: "first clue",
      source_segment_id: "seg_0",
    })).toBe(true);
    expect(wm.setTargetIdentity("cam1", "wm_t1", {
      name: "Sophie",
      evidence: "second clue",
      source_segment_id: "seg_1",
    })).toBe(false);
    expect(wm.getTargetIdentity("cam1", "wm_t1")).toMatchObject({
      name: "Lily",
      conflict: true,
    });

    wm.markTargetIdentityPromoted("cam1", "wm_t1", "entity_lily");
    expect(wm.getTargetIdentity("cam1", "wm_t1")?.promoted_entity_id).toBeUndefined();
  });

  it("allocateTargetId returns monotonically increasing IDs", () => {
    const wm = new WorkingMemoryManager({ event_timeout_sec: 30 });
    expect(wm.allocateTargetId("cam1")).toBe("wm_t1");
    expect(wm.allocateTargetId("cam1")).toBe("wm_t2");
    expect(wm.allocateTargetId("cam1")).toBe("wm_t3");
  });

  it("allocateTargetId is independent per camera", () => {
    const wm = new WorkingMemoryManager({ event_timeout_sec: 30 });
    expect(wm.allocateTargetId("cam1")).toBe("wm_t1");
    expect(wm.allocateTargetId("cam2")).toBe("wm_t1");
  });

  it("tickTargetMiss increments segments_missed for unmatched active-event targets without evicting them", () => {
    const wm = new WorkingMemoryManager({ event_timeout_sec: 30 });
    wm.upsertTarget("cam1", makeTarget("wm_t1"));
    wm.upsertTarget("cam1", makeTarget("wm_t2"));

    // Miss all
    wm.tickTargetMiss("cam1", new Set());
    expect(wm.getTargets("cam1")[0]!.segments_missed).toBe(1);

    wm.tickTargetMiss("cam1", new Set());
    expect(wm.getTargets("cam1")[0]!.segments_missed).toBe(2);

    wm.tickTargetMiss("cam1", new Set());
    expect(wm.getTargets("cam1")[0]!.segments_missed).toBe(3);

    wm.tickTargetMiss("cam1", new Set());
    expect(wm.getTargets("cam1")).toHaveLength(2);
    expect(wm.getTargets("cam1")[0]!.segments_missed).toBe(4);
  });

  it("tickTargetMiss evicts rollover bootstrap targets after a five-segment rematch window", () => {
    const wm = new WorkingMemoryManager({ event_timeout_sec: 30 });
    wm.upsertTarget("cam1", makeTarget("wm_t1"));
    wm.upsertTarget("cam1", makeTarget("wm_t2", 2_000));

    wm.switchEvent("cam1", "max_segments", 3_000, { carryTargets: true });
    expect(wm.getTargets("cam1")).toHaveLength(2);

    for (let i = 0; i < 5; i++) {
      wm.tickTargetMiss("cam1", new Set());
      expect(wm.getTargets("cam1")).toHaveLength(2);
    }

    wm.tickTargetMiss("cam1", new Set());
    expect(wm.getTargets("cam1")).toHaveLength(0);
  });

  it("tickTargetMiss promotes rematched rollover bootstrap targets back to normal active targets", () => {
    const wm = new WorkingMemoryManager({ event_timeout_sec: 30 });
    wm.upsertTarget("cam1", makeTarget("wm_t1"));

    wm.switchEvent("cam1", "max_segments", 3_000, { carryTargets: true });
    wm.tickTargetMiss("cam1", new Set(["wm_t1"]));
    expect(wm.getTargets("cam1")[0]?.segments_missed).toBe(0);

    for (let i = 0; i < 6; i++) {
      wm.tickTargetMiss("cam1", new Set());
    }
    expect(wm.getTargets("cam1")).toHaveLength(1);
  });

  it("tickTargetMiss preserves matched targets", () => {
    const wm = new WorkingMemoryManager({ event_timeout_sec: 30 });
    wm.upsertTarget("cam1", makeTarget("wm_t1"));
    wm.upsertTarget("cam1", makeTarget("wm_t2"));

    wm.tickTargetMiss("cam1", new Set(["wm_t1"]));
    const targets = wm.getTargets("cam1");
    expect(targets).toHaveLength(2);
    expect(targets.find(t => t.target_id === "wm_t1")!.segments_missed).toBe(0);
    expect(targets.find(t => t.target_id === "wm_t2")!.segments_missed).toBe(1);
  });

  it("enforces LRU cap of 8 targets", () => {
    const wm = new WorkingMemoryManager({ event_timeout_sec: 30 });
    for (let i = 0; i < 10; i++) {
      wm.upsertTarget("cam1", makeTarget(`wm_t${i}`, 1000 + i));
    }
    const targets = wm.getTargets("cam1");
    expect(targets).toHaveLength(8);
    // Most recent should survive (LRU by last_seen_timestamp DESC)
    expect(targets.some(t => t.target_id === "wm_t9")).toBe(true);
    expect(targets.some(t => t.target_id === "wm_t0")).toBe(false);
  });

  it("openEvent resets targets and target_counter", () => {
    const wm = new WorkingMemoryManager({ event_timeout_sec: 30 });
    const cam = "cam1";
    // Open first event
    wm.onSegmentArrived(cam, "stream", 1000);
    wm.upsertTarget(cam, makeTarget("wm_t1"));
    wm.allocateTargetId(cam);
    expect(wm.getTargets(cam)).toHaveLength(1);

    // Force a new event via timeout
    wm.onSegmentArrived(cam, "stream", 1000 + 200_000);
    expect(wm.getTargets(cam)).toHaveLength(0);
    // Counter should be reset — next allocation starts from wm_t1
    expect(wm.allocateTargetId(cam)).toBe("wm_t1");
  });
});
