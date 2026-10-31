import { describe, it, expect } from "vitest";
import { resolveNotifications } from "../notification-resolver.js";
import type { VlmOutput, AnalyzerResult, WorkingMemoryState } from "../types.js";

function makeWmState(overrides: Partial<WorkingMemoryState> = {}): WorkingMemoryState {
  return ({
    camera_id: "cam_test",
    current_event_id: "evt_001",
    event_start_time: Date.now(),
    segment_count: 1,
    last_activity_time: Date.now(),
    entity_context: new Map(),
    scene_context: "",
    event_summary: "",
    recent_segment_summaries: [],
    escalation_hints: [],
    recent_notifications: [],
    anonymous_subjects: [],
    segment_ids: [],
    evidence_start_ms: undefined,
    evidence_end_ms: undefined,
    targets: [],
    target_counter: 0,
    ...overrides,
  }) as WorkingMemoryState;
}

const NORMAL_VLM: VlmOutput = {
  summary: "A person in blue jacket at the front door",
  detailed_summary: "A person in a blue jacket is standing at the front door.",
  security_risk: false,
  is_static_scene: false,
  notify_user: true,
  main_targets: [{ type: "person", appearance: "blue jacket", behavior: "standing" }],
  raw_response: "{}",
};

const SECURITY_VLM: VlmOutput = {
  ...NORMAL_VLM,
  security_risk: true,
  security_reason: "Potential break-in via window",
};

const STATIC_VLM: VlmOutput = {
  summary: "Empty room",
  detailed_summary: "No activity.",
  security_risk: false,
  is_static_scene: true,
  notify_user: false,
  main_targets: [],
  raw_response: "{}",
};

const NO_PERSON_VLM: VlmOutput = {
  summary: "A cat walked across the yard",
  detailed_summary: "A cat crossed the yard.",
  security_risk: false,
  is_static_scene: false,
  notify_user: true,
  main_targets: [{ type: "animal", appearance: "orange cat", behavior: "walking" }],
  raw_response: "{}",
};

const NOT_NOTEWORTHY_VLM: VlmOutput = {
  summary: "A person in blue jacket adjusts their hair while seated",
  detailed_summary: "Minor movement, not noteworthy.",
  security_risk: false,
  is_static_scene: false,
  notify_user: false,
  main_targets: [{ type: "person", appearance: "blue jacket", behavior: "adjusting hair" }],
  raw_response: "{}",
};

describe("resolveNotifications", () => {
  // ── Basic cases ──

  it("returns empty for null VLM data", () => {
    const result = resolveNotifications(null, [], makeWmState());
    expect(result).toEqual([]);
  });

  it("returns empty for static scene", () => {
    const result = resolveNotifications(STATIC_VLM, [], makeWmState());
    expect(result).toEqual([]);
  });

  // ── Security alerts (all policies) ──

  it("sends alert when security_risk=true", () => {
    const result = resolveNotifications(SECURITY_VLM, [], makeWmState());
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("alert");
    expect(result[0]!.message).toContain("break-in");
  });

  it("sends alert even under security_only policy", () => {
    const result = resolveNotifications(SECURITY_VLM, [], makeWmState(), { policy: "security_only" });
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("alert");
  });

  // ── First segment rule ──

  it("first segment always sends summary (regardless of notify_user)", () => {
    const result = resolveNotifications(NOT_NOTEWORTHY_VLM, [], makeWmState(), { isFirstWatchSegment: true });
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("summary");
  });

  it("first segment does NOT send summary under security_only", () => {
    const result = resolveNotifications(NOT_NOTEWORTHY_VLM, [], makeWmState(), {
      policy: "security_only",
      isFirstWatchSegment: true,
    });
    expect(result).toHaveLength(0);
  });

  it("first segment sends summary even without persons (e.g. animals)", () => {
    const result = resolveNotifications(NO_PERSON_VLM, [], makeWmState(), { isFirstWatchSegment: true });
    expect(result).toHaveLength(1);
  });

  // ── Smart policy (default) ──

  it("smart: sends summary when notify_user=true + person", () => {
    const result = resolveNotifications(NORMAL_VLM, [], makeWmState({ segment_count: 5 }));
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("summary");
  });

  it("smart: does NOT send summary when notify_user=false", () => {
    const result = resolveNotifications(NOT_NOTEWORTHY_VLM, [], makeWmState({ segment_count: 5 }));
    expect(result).toHaveLength(0);
  });

  it("smart: sends summary when notify_user=true even without person", () => {
    const result = resolveNotifications(NO_PERSON_VLM, [], makeWmState({ segment_count: 5 }));
    expect(result).toHaveLength(1);
  });

  // ── Always policy ──

  it("always: sends summary for any segment with person (even notify_user=false)", () => {
    const result = resolveNotifications(NOT_NOTEWORTHY_VLM, [], makeWmState({ segment_count: 5 }), { policy: "always" });
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("summary");
  });

  it("always: sends summary without person", () => {
    const result = resolveNotifications(NO_PERSON_VLM, [], makeWmState({ segment_count: 5 }), { policy: "always" });
    expect(result).toHaveLength(1);
  });

  // ── Security-only policy ──

  it("security_only: no summary even with notify_user=true", () => {
    const result = resolveNotifications(NORMAL_VLM, [], makeWmState(), { policy: "security_only" });
    expect(result).toHaveLength(0);
  });

  // ── Dedup ──

  it("dedup: does not repeat alert if same message already sent", () => {
    const wm = makeWmState({ recent_notifications: ["[alert] Potential break-in via window"] });
    const result = resolveNotifications(SECURITY_VLM, [], wm);
    expect(result).toHaveLength(0);
  });

  it("dedup: sends new alert if message differs from previous", () => {
    const wm = makeWmState({ recent_notifications: ["[alert] Package stolen from porch"] });
    const result = resolveNotifications(SECURITY_VLM, [], wm);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("alert");
  });

  it("dedup: does not repeat summary if fingerprint unchanged", () => {
    const fp = "risk=false;targets=person:blue jacket";
    const wm = makeWmState({ segment_count: 3, recent_notifications: [`[summary:fp]${fp}`] });
    const result = resolveNotifications(NORMAL_VLM, [], wm);
    expect(result).toHaveLength(0);
  });

  it("dedup: sends summary again when fingerprint changes", () => {
    const wm = makeWmState({ segment_count: 3, recent_notifications: ["[summary:fp]risk=false;targets=person:red hat"] });
    const result = resolveNotifications(NORMAL_VLM, [], wm);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("summary");
  });

  // ── ReID ──

  it("sends identify when ReID detects unknown person", () => {
    const reidResult: AnalyzerResult = {
      available: true,
      analyzer: "reid",
      data: { matches: [{ entity_id: "unknown_042", confidence: 0.3 }] },
      latency_ms: 10,
    };
    const result = resolveNotifications(NORMAL_VLM, [reidResult], makeWmState());
    const identifies = result.filter((n) => n.type === "identify");
    expect(identifies).toHaveLength(1);
    expect(identifies[0]!.message).toContain("Unknown person");
  });

  it("does NOT send identify when ReID matches known person", () => {
    const reidResult: AnalyzerResult = {
      available: true,
      analyzer: "reid",
      data: { matches: [{ entity_id: "zhang_san", confidence: 0.95 }] },
      latency_ms: 10,
    };
    const result = resolveNotifications(NORMAL_VLM, [reidResult], makeWmState());
    const identifies = result.filter((n) => n.type === "identify");
    expect(identifies).toHaveLength(0);
  });

  // ── Priority ──

  it("security alert takes priority over summary", () => {
    const result = resolveNotifications(SECURITY_VLM, [], makeWmState({ segment_count: 1 }));
    expect(result.some((n) => n.type === "alert")).toBe(true);
    expect(result.filter((n) => n.type === "summary")).toHaveLength(0);
  });
});
