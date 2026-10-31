// packages/percept/src/__tests__/working-memory.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { WorkingMemoryManager } from "../working-memory.js";

const CAM = "cam_front_door";
const T0 = 1_000_000; // arbitrary base timestamp in ms

describe("WorkingMemoryManager", () => {
  let wm: WorkingMemoryManager;

  beforeEach(() => {
    wm = new WorkingMemoryManager({ event_timeout_sec: 10 });
  });

  it("defaults event timeout to 30 seconds", () => {
    const defaultMemory = new WorkingMemoryManager();
    expect(defaultMemory.getEventTimeoutMs()).toBe(30_000);
  });

  it("opens a new event on first segment arrival", () => {
    const eventId = wm.onSegmentArrived(CAM, "stream", T0);
    expect(eventId).toMatch(/^evt_cam_front_door_/);
    expect(wm.hasActiveEvent(CAM)).toBe(true);
  });

  it("extends the same event when segments arrive within timeout", () => {
    const eventId1 = wm.onSegmentArrived(CAM, "stream", T0);
    const eventId2 = wm.onSegmentArrived(CAM, "stream", T0 + 5_000); // 5 s later
    expect(eventId1).toBe(eventId2);

    const state = wm.getState(CAM);
    expect(state.segment_count).toBe(2);
  });

  it("closes the old event and opens a new one after timeout", () => {
    const eventId1 = wm.onSegmentArrived(CAM, "stream", T0);
    const eventId2 = wm.onSegmentArrived(CAM, "stream", T0 + 15_000); // 15 s > 10 s timeout
    expect(eventId1).not.toBe(eventId2);
    expect(wm.hasActiveEvent(CAM)).toBe(true);
  });

  it("resets segment_count after opening a new event post-timeout", () => {
    wm.onSegmentArrived(CAM, "stream", T0);
    wm.onSegmentArrived(CAM, "stream", T0 + 3_000);
    wm.onSegmentArrived(CAM, "stream", T0 + 6_000);
    // Now timeout
    wm.onSegmentArrived(CAM, "stream", T0 + 20_000);
    expect(wm.getState(CAM).segment_count).toBe(1);
  });

  it("opens a new event when the segment count reaches the configured max", () => {
    const limited = new WorkingMemoryManager({ event_timeout_sec: 10, max_event_segments: 2 });
    const eventId1 = limited.onSegmentArrived(CAM, "stream", T0);
    const eventId2 = limited.onSegmentArrived(CAM, "stream", T0 + 1_000);
    const eventId3 = limited.onSegmentArrived(CAM, "stream", T0 + 2_000);

    expect(eventId2).toBe(eventId1);
    expect(eventId3).not.toBe(eventId1);
    expect(limited.getState(CAM).segment_count).toBe(1);
  });

  it("carries subject targets across max-segment event rotation", () => {
    const limited = new WorkingMemoryManager({ event_timeout_sec: 10, max_event_segments: 2 });
    limited.onSegmentArrived(CAM, "stream", T0);
    limited.upsertTarget(CAM, {
      target_id: "wm_t1",
      entity_id: "person_1",
      class_name: "person",
      appearance: "person in a pink top",
      behavior: "doing yoga",
      crop_path: "/tmp/wm_t1.jpg",
      last_seen_segment_id: "seg_001",
      last_seen_timestamp: T0,
      segments_seen: 2,
      segments_missed: 1,
    });
    limited.appendSceneContext(CAM, "old event context");
    limited.updateEventSummary(CAM, "old event summary");
    limited.onSegmentArrived(CAM, "stream", T0 + 1_000);

    const eventId3 = limited.onSegmentArrived(CAM, "stream", T0 + 2_000);
    const state = limited.getState(CAM);

    expect(eventId3).toBe(state.current_event_id);
    expect(state.segment_count).toBe(1);
    expect(limited.getSceneContext(CAM)).toBe("");
    expect(limited.getCurrentEventSummary(CAM)).toBe("");
    expect(limited.getTargets(CAM)).toMatchObject([
      {
        target_id: "wm_t1",
        entity_id: "person_1",
        class_name: "person",
        appearance: "person in a pink top",
      },
    ]);
    expect(limited.allocateTargetId(CAM)).toBe("wm_t2");
  });

  it("evicts carried subject targets after the rollover rematch window", () => {
    const limited = new WorkingMemoryManager({ event_timeout_sec: 10, max_event_segments: 2 });
    limited.onSegmentArrived(CAM, "stream", T0);
    limited.upsertTarget(CAM, {
      target_id: "wm_t1",
      class_name: "person",
      appearance: "person in a pink top",
      crop_path: "/tmp/wm_t1.jpg",
      last_seen_segment_id: "seg_001",
      last_seen_timestamp: T0,
      segments_seen: 1,
      segments_missed: 0,
    });
    limited.onSegmentArrived(CAM, "stream", T0 + 1_000);

    // New event starts
    limited.onSegmentArrived(CAM, "stream", T0 + 2_000);
    expect(limited.getTargets(CAM)).toMatchObject([
      {
        target_id: "wm_t1",
        carry_rematch_remaining: 5,
        segments_missed: 0,
      },
    ]);

    for (let i = 0; i < 5; i++) {
      limited.tickTargetMiss(CAM, new Set());
      expect(limited.getTargets(CAM)).toHaveLength(1);
    }

    limited.tickTargetMiss(CAM, new Set());
    expect(limited.getTargets(CAM)).toEqual([]);
  });

  it("promotes a carried subject target back to active state when rematched", () => {
    const limited = new WorkingMemoryManager({ event_timeout_sec: 10, max_event_segments: 2 });
    limited.onSegmentArrived(CAM, "stream", T0);
    limited.upsertTarget(CAM, {
      target_id: "wm_t1",
      class_name: "person",
      appearance: "person in a pink top",
      crop_path: "/tmp/wm_t1.jpg",
      last_seen_segment_id: "seg_001",
      last_seen_timestamp: T0,
      segments_seen: 1,
      segments_missed: 0,
    });
    limited.onSegmentArrived(CAM, "stream", T0 + 1_000);
    limited.onSegmentArrived(CAM, "stream", T0 + 2_000);

    limited.tickTargetMiss(CAM, new Set(["wm_t1"]));
    expect(limited.getTargets(CAM)).toMatchObject([
      {
        target_id: "wm_t1",
        segments_missed: 0,
      },
    ]);
    expect(limited.getTargets(CAM)[0]?.carry_rematch_remaining).toBeUndefined();

    for (let i = 0; i < 10; i++) {
      limited.tickTargetMiss(CAM, new Set());
    }
    expect(limited.getTargets(CAM)).toHaveLength(1);
  });

  it("does not evict unmatched subject targets within an active event", () => {
    wm.onSegmentArrived(CAM, "stream", T0);
    wm.upsertTarget(CAM, {
      target_id: "wm_t1",
      class_name: "person",
      appearance: "person in a pink top",
      crop_path: "/tmp/wm_t1.jpg",
      last_seen_segment_id: "seg_001",
      last_seen_timestamp: T0,
      segments_seen: 1,
      segments_missed: 0,
    });

    for (let i = 0; i < 10; i++) {
      wm.tickTargetMiss(CAM, new Set());
    }

    expect(wm.getTargets(CAM)).toMatchObject([
      {
        target_id: "wm_t1",
        segments_missed: 10,
      },
    ]);
  });

  it("does not carry subject targets across timeout event switch", () => {
    wm.onSegmentArrived(CAM, "stream", T0);
    wm.upsertTarget(CAM, {
      target_id: "wm_t1",
      class_name: "person",
      appearance: "person in a pink top",
      crop_path: "/tmp/wm_t1.jpg",
      last_seen_segment_id: "seg_001",
      last_seen_timestamp: T0,
      segments_seen: 1,
      segments_missed: 0,
    });

    wm.onSegmentArrived(CAM, "stream", T0 + 20_000);

    expect(wm.getTargets(CAM)).toEqual([]);
  });

  it("returns subject target snapshots instead of mutable internal state", () => {
    wm.onSegmentArrived(CAM, "stream", T0);
    wm.upsertTarget(CAM, {
      target_id: "wm_t1",
      class_name: "person",
      appearance: "person in a blue jacket",
      behavior: "standing",
      crop_path: "/tmp/wm_t1.jpg",
      last_seen_segment_id: "seg_001",
      last_seen_timestamp: T0,
      segments_seen: 1,
      segments_missed: 0,
    });

    const targets = wm.getTargets(CAM);
    targets.push({
      target_id: "wm_fake",
      class_name: "person",
      appearance: "fake",
      crop_path: "",
      last_seen_segment_id: "seg_fake",
      last_seen_timestamp: T0,
      segments_seen: 1,
      segments_missed: 0,
    });
    targets[0]!.appearance = "mutated by caller";

    expect(wm.getTargets(CAM)).toHaveLength(1);
    expect(wm.getTargets(CAM)[0]?.appearance).toBe("person in a blue jacket");
  });

  it("returns stable subject target crops as immutable snapshots", () => {
    wm.onSegmentArrived(CAM, "stream", T0);
    const stableCrops = [
      {
        crop_path: "/tmp/best.jpg",
        segment_id: "seg_001",
        did: "D2",
        score: 0.91,
        source: "face" as const,
        timestamp: T0,
        face_quality: 0.86,
      },
    ];
    wm.upsertTarget(CAM, {
      target_id: "wm_t1",
      class_name: "person",
      appearance: "person in a dark jacket",
      crop_path: "/tmp/latest.jpg",
      stable_crops: stableCrops,
      last_seen_segment_id: "seg_001",
      last_seen_timestamp: T0,
      segments_seen: 1,
      segments_missed: 0,
    });

    stableCrops[0]!.score = 0.1;
    const firstRead = wm.getTargets(CAM)[0]!;
    expect(firstRead.stable_crops?.[0]).toMatchObject({
      crop_path: "/tmp/best.jpg",
      score: 0.91,
    });

    firstRead.stable_crops![0]!.score = 0.2;
    expect(wm.getTargets(CAM)[0]!.stable_crops?.[0]?.score).toBe(0.91);
  });

  it("updates entity context", () => {
    wm.onSegmentArrived(CAM, "stream", T0);
    wm.updateEntityContext(CAM, "person_0", { appearance: "blue jacket" }, T0);
    expect(wm.getState(CAM).entity_context.get("person_0")?.appearance).toBe("blue jacket");
  });

  it("merges entity context on subsequent updates", () => {
    wm.onSegmentArrived(CAM, "stream", T0);
    wm.updateEntityContext(CAM, "person_0", { appearance: "blue jacket" }, T0);
    wm.updateEntityContext(CAM, "person_0", { behavior: "walking" }, T0 + 2000);
    const ctx = wm.getState(CAM).entity_context.get("person_0");
    expect(ctx?.appearance).toBe("blue jacket");
    expect(ctx?.behavior).toBe("walking");
  });

  it("ignores late older entity context updates", () => {
    wm.onSegmentArrived(CAM, "stream", T0);
    wm.updateEntityContext(CAM, "person_0", { appearance: "older" }, T0, T0);
    wm.updateEntityContext(CAM, "person_0", { appearance: "newer", behavior: "walking" }, T0 + 2000, T0 + 2000);
    wm.updateEntityContext(CAM, "person_0", { appearance: "late old", behavior: "standing" }, T0 + 100, T0 + 100);
    const ctx = wm.getState(CAM).entity_context.get("person_0");
    expect(ctx?.appearance).toBe("newer");
    expect(ctx?.behavior).toBe("walking");
  });

  it("accumulates scene context across segments", () => {
    wm.onSegmentArrived(CAM, "stream", T0);
    wm.appendSceneContext(CAM, "Hallway, daylight");
    wm.appendSceneContext(CAM, "One person visible");
    expect(wm.getSceneContext(CAM)).toBe("Hallway, daylight\nOne person visible");
  });

  it("deduplicates recent segment summaries by segment id", () => {
    wm.onSegmentArrived(CAM, "stream", T0);
    wm.appendSceneContext(CAM, "first", "seg_1", "Old");
    wm.appendSceneContext(CAM, "updated", "seg_1", "New");
    expect(wm.getRecentSegmentSummaries(CAM)).toEqual(["[seg_1] title=New; summary=updated"]);
  });

  it("upgrades an early segment summary to final detailed summary by segment id", () => {
    wm.onSegmentArrived(CAM, "stream", T0);
    wm.appendSceneContext(CAM, "short", "seg_1", "Talk");
    wm.appendSceneContext(CAM, "full detail", "seg_1", "Talk", {
      summary: "short",
      detailedSummary: "full detail",
    });
    expect(wm.getRecentSegmentSummaries(CAM)).toEqual(["[seg_1] title=Talk; detailed_summary=full detail"]);
  });

  it("attaches dialogue to the matching recent segment context", () => {
    wm.onSegmentArrived(CAM, "stream", T0);
    wm.appendSceneContext(CAM, "short", "seg_1", "Talk");
    wm.appendSceneContext(CAM, "full detail", "seg_1", "Talk", {
      summary: "short",
      detailedSummary: "full detail",
      dialogue: [
        {
          text_start: 1,
          speaker: "Ed Ludlow",
          identity_level: "entity_id",
          confidence: "high",
          text: "What happened next?",
        },
        {
          text_start: 2,
          speaker: "Michael Dell",
          identity_level: "entity_id",
          confidence: "high",
          text: "We scaled the workflow.",
        },
      ],
    });
    expect(wm.getRecentSegmentSummaries(CAM)).toEqual([
      "[seg_1] title=Talk; detailed_summary=full detail\nDialogue:\n- Ed Ludlow: What happened next?\n- Michael Dell: We scaled the workflow.",
    ]);
  });

  it("deduplicates segment summaries without replacing legacy no-id summaries", () => {
    wm.onSegmentArrived(CAM, "stream", T0);
    wm.appendSceneContext(CAM, "legacy summary");
    wm.appendSceneContext(CAM, "first", "seg_1", "Old");
    wm.appendSceneContext(CAM, "updated", "seg_1", "New");
    expect(wm.getRecentSegmentSummaries(CAM)).toEqual([
      "legacy summary",
      "[seg_1] title=New; summary=updated",
    ]);
  });

  it("clears entity context and scene when event closes on timeout", () => {
    wm.onSegmentArrived(CAM, "stream", T0);
    wm.updateEntityContext(CAM, "person_0", { appearance: "red hat" }, T0);
    wm.appendSceneContext(CAM, "some context");
    // Trigger timeout
    wm.onSegmentArrived(CAM, "stream", T0 + 20_000);
    expect(wm.getState(CAM).entity_context.size).toBe(0);
    expect(wm.getSceneContext(CAM)).toBe("");
  });

  it("merges lightweight event context and resets it on event switch", () => {
    wm.onSegmentArrived(CAM, "stream", T0);
    wm.updateEventContext(CAM, {
      setting: "Bloomberg interview in Las Vegas",
      participant_updates: [
        { role: "right-side host", visual_hints: "dark suit and glasses" },
        { role: "left guest", visual_hints: "gray-haired guest in a black leather jacket" },
      ],
    });
    wm.updateEventContext(CAM, {
      participant_updates: [
        { role: "left guest", visual_hints: "gray-haired guest in a black leather jacket" },
        { role: "center guest", visual_hints: "dark blazer and light shirt" },
      ],
    });

    expect(wm.getEventContextPrompt(CAM)).toBe([
      "Setting: Bloomberg interview in Las Vegas",
      "Participants:",
      "- role=right-side host; visual_hints=dark suit and glasses",
      "- role=left guest; visual_hints=gray-haired guest in a black leather jacket",
      "- role=center guest; visual_hints=dark blazer and light shirt",
    ].join("\n"));

    wm.onSegmentArrived(CAM, "stream", T0 + 20_000);
    expect(wm.getEventContextPrompt(CAM)).toBeUndefined();
  });

  it("closeCurrentEvent resets state", () => {
    wm.onSegmentArrived(CAM, "stream", T0);
    wm.closeCurrentEvent(CAM);
    expect(wm.hasActiveEvent(CAM)).toBe(false);
  });

  it("addEscalationHint deduplicates hints", () => {
    wm.onSegmentArrived(CAM, "stream", T0);
    wm.addEscalationHint(CAM, "unknown person");
    wm.addEscalationHint(CAM, "unknown person");
    expect(wm.getState(CAM).escalation_hints).toHaveLength(1);
  });

  it("snapshot mode always opens a new event, even within timeout", () => {
    const eventId1 = wm.onSegmentArrived(CAM, "snapshot", T0);
    const eventId2 = wm.onSegmentArrived(CAM, "snapshot", T0 + 1_000); // 1 s later, well within timeout
    expect(eventId1).not.toBe(eventId2);
  });

  it("manages state for multiple cameras independently", () => {
    const evtA = wm.onSegmentArrived("cam_A", "stream", T0);
    const evtB = wm.onSegmentArrived("cam_B", "stream", T0);
    expect(evtA).not.toBe(evtB);
    expect(wm.hasActiveEvent("cam_A")).toBe(true);
    expect(wm.hasActiveEvent("cam_B")).toBe(true);
    wm.closeCurrentEvent("cam_A");
    expect(wm.hasActiveEvent("cam_A")).toBe(false);
    expect(wm.hasActiveEvent("cam_B")).toBe(true);
  });

  describe("segment evidence tracking", () => {
    it("recordSegment adds to segment_ids and tracks evidence time", () => {
      const wm = new WorkingMemoryManager({ event_timeout_sec: 10 });
      wm.onSegmentArrived("cam1", "stream", 1000);
      wm.recordSegment("cam1", "seg_001", 1000);
      wm.recordSegment("cam1", "seg_002", 2000);
      const state = wm.getState("cam1");
      expect(state.segment_ids).toEqual(["seg_001", "seg_002"]);
      expect(state.evidence_start_ms).toBe(1000);
      expect(state.evidence_end_ms).toBe(2000);
    });

    it("recordSegment deduplicates with no side effects", () => {
      const wm = new WorkingMemoryManager({ event_timeout_sec: 10 });
      wm.onSegmentArrived("cam1", "stream", 1000);
      wm.recordSegment("cam1", "seg_001", 1000);
      wm.recordSegment("cam1", "seg_001", 1500);
      expect(wm.getState("cam1").segment_ids).toEqual(["seg_001"]);
      expect(wm.getState("cam1").evidence_end_ms).toBe(1000);
    });

    it("recordSegment warns and returns when no active event", () => {
      const wm = new WorkingMemoryManager({ event_timeout_sec: 10 });
      wm.onSegmentArrived("cam1", "stream", 1000);
      wm.closeCurrentEvent("cam1");
      expect(wm.getState("cam1").current_event_id).toBeNull();
      wm.recordSegment("cam1", "seg_001", 2000);
      expect(wm.getState("cam1").segment_ids).toEqual([]);
    });

    it("recordSegment ignores calls for unknown cameras (no implicit state creation)", () => {
      const wm = new WorkingMemoryManager({ event_timeout_sec: 10 });
      wm.recordSegment("unknown_cam", "seg_001", 1000);
      expect((wm as any).states.has("unknown_cam")).toBe(false);
    });

    it("openEvent resets segment_ids and evidence times", () => {
      const wm = new WorkingMemoryManager({ event_timeout_sec: 10 });
      wm.onSegmentArrived("cam1", "stream", 1000);
      wm.recordSegment("cam1", "seg_001", 1000);
      wm.onSegmentArrived("cam1", "stream", 1000 + 11_000);
      const state = wm.getState("cam1");
      expect(state.segment_ids).toEqual([]);
      expect(state.evidence_start_ms).toBeUndefined();
      expect(state.evidence_end_ms).toBeUndefined();
    });
  });

  describe("VLM-maintained event summary", () => {
    it("stores current event summary and exposes recent three segment summaries", () => {
      const wm = new WorkingMemoryManager({ event_timeout_sec: 120 });
      wm.onSegmentArrived("cam1", "stream", 1000);
      wm.updateEventSummary("cam1", "A presenter (entity_id=person_1) starts a lesson.");
      wm.appendSceneContext("cam1", "line1", "seg_001", "First Title");
      wm.appendSceneContext("cam1", "line2", "seg_002", "Second Title");
      wm.appendSceneContext("cam1", "line3", "seg_003", "Third Title");
      wm.appendSceneContext("cam1", "line4", "seg_004", "Fourth Title");

      expect(wm.getCurrentEventSummary("cam1")).toContain("entity_id=person_1");
      expect(wm.getRecentSegmentSummaries("cam1")).toEqual([
        "[seg_002] title=Second Title; summary=line2",
        "[seg_003] title=Third Title; summary=line3",
        "[seg_004] title=Fourth Title; summary=line4",
      ]);
    });

    it("ignores late older event summary updates", () => {
      const wm = new WorkingMemoryManager({ event_timeout_sec: 120 });
      wm.onSegmentArrived("cam1", "stream", 1000);
      wm.updateEventSummary("cam1", "Older summary", 1000);
      wm.updateEventSummary("cam1", "Newer summary", 2000);
      wm.updateEventSummary("cam1", "Late old summary", 1500);
      expect(wm.getCurrentEventSummary("cam1")).toBe("Newer summary");
    });

    it("EventCloseSummary uses event_summary and evidence", () => {
      let closedSummary: any = null;
      const wm = new WorkingMemoryManager({ event_timeout_sec: 120 });
      wm.setNarrativeCallbacks({
        onEventClosed: (_cameraId, summary) => { closedSummary = summary; },
      });
      wm.onSegmentArrived("cam1", "stream", 1000);
      wm.recordSegment("cam1", "seg_001", 1000);
      wm.recordSegment("cam1", "seg_002", 1500);
      wm.updateEventSummary("cam1", "The speaker (entity_id=person_1) explains the first topic.");
      wm.closeCurrentEvent("cam1", "stream");

      expect(closedSummary).not.toBeNull();
      expect(closedSummary.event_summary).toContain("entity_id=person_1");
      expect(closedSummary.compressed_context).toBe(closedSummary.event_summary);
      expect(closedSummary.segment_ids).toEqual(["seg_001", "seg_002"]);
      expect(closedSummary.time_range).toEqual({ start_ms: 1000, end_ms: 1500 });
    });
  });

  describe("switchEvent fires onEventClosed", () => {
    it("fires callback with event summary on timeout", () => {
      let closedSummary: any = null;
      const wm = new WorkingMemoryManager({ event_timeout_sec: 1 });
      wm.setNarrativeCallbacks({
        onEventClosed: (_cameraId, summary) => { closedSummary = summary; },
      });
      const evtId = wm.onSegmentArrived("cam1", "stream", 1000);
      wm.recordSegment("cam1", "seg_001", 1000);
      // Timeout
      wm.onSegmentArrived("cam1", "stream", 1000 + 2000);
      expect(closedSummary).not.toBeNull();
      expect(closedSummary.event_id).toBe(evtId);
      expect(closedSummary.segment_ids).toEqual(["seg_001"]);
    });
  });

  describe("appendSceneContext with segmentId", () => {
    it("prefixes summary with [seg_xxx] when segmentId provided", () => {
      const wm = new WorkingMemoryManager({ event_timeout_sec: 10 });
      wm.onSegmentArrived("cam1", "stream", 1000);
      wm.appendSceneContext("cam1", "A person entered.", "seg_042");
      expect(wm.getSceneContext("cam1")).toContain("[seg_042]");
      expect(wm.getSceneContext("cam1")).toContain("A person entered.");
    });

    it("works without segmentId (backward compat)", () => {
      const wm = new WorkingMemoryManager({ event_timeout_sec: 10 });
      wm.onSegmentArrived("cam1", "stream", 1000);
      wm.appendSceneContext("cam1", "A person entered.");
      expect(wm.getSceneContext("cam1")).toBe("A person entered.");
    });
  });
});
