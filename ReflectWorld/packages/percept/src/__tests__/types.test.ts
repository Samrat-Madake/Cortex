// packages/percept/src/__tests__/types.test.ts
import { describe, it, expect } from "vitest";
import type {
  WorkingMemoryState,
  StrategyConfig,
  AnalyzerResult,
  VlmOutput,
} from "../types.js";

describe("WorkingMemoryState", () => {
  it("accepts a fresh state with no active event", () => {
    const state: WorkingMemoryState = {
      camera_id: "cam_front_door",
      current_event_id: null,
      event_start_time: 0,
      segment_count: 0,
      last_activity_time: 0,
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
    };
    expect(state.current_event_id).toBeNull();
    expect(state.entity_context.size).toBe(0);
  });

  it("accepts state with active event and entity context", () => {
    const state: WorkingMemoryState = {
      camera_id: "cam_front_door",
      current_event_id: "evt_001",
      event_start_time: Date.now() - 5000,
      segment_count: 3,
      last_activity_time: Date.now(),
      entity_context: new Map([
        ["person_0", { appearance: "blue jacket", behavior: "walking", last_seen: Date.now() }],
      ]),
      scene_context: "Front door hallway, daytime",
      event_summary: "A person is near the front door.",
      recent_segment_summaries: ["Person arrived"],
      escalation_hints: ["unknown person detected"],
      recent_notifications: [],
      anonymous_subjects: [],
      segment_ids: [],
      evidence_start_ms: undefined,
      evidence_end_ms: undefined,
      targets: [],
      target_counter: 0,
    };
    expect(state.current_event_id).toBe("evt_001");
    expect(state.entity_context.get("person_0")?.appearance).toBe("blue jacket");
    expect(state.escalation_hints).toHaveLength(1);
  });
});

describe("StrategyConfig", () => {
  it("level 0 strategy: VLM only", () => {
    const strategy: StrategyConfig = {
      level: 0,
      run_vlm: true,
      run_detection: false,
      run_reid: false,
      run_stt: true,
      vlm_model: "gemini-2.5-flash-lite",
    };
    expect(strategy.run_vlm).toBe(true);
    expect(strategy.run_detection).toBe(false);
  });

  it("level 1 strategy: VLM + local models", () => {
    const strategy: StrategyConfig = {
      level: 1,
      run_vlm: true,
      run_detection: true,
      run_reid: false,
      run_stt: true,
      vlm_model: "gemini-2.5-flash",
    };
    expect(strategy.level).toBe(1);
    expect(strategy.run_detection).toBe(true);
    expect(strategy.run_stt).toBe(true);
  });
});

describe("AnalyzerResult", () => {
  it("accepts a successful VLM result", () => {
    const vlmData: VlmOutput = {
      summary: "Person at front door",
      detailed_summary: "A person wearing a blue jacket arrived at the front door.",
      security_risk: false,
      is_static_scene: false,
      notify_user: true,
      main_targets: [{ type: "person", appearance: "blue jacket", behavior: "arriving" }],
      raw_response: '{"summary":"..."}',
    };
    const result: AnalyzerResult = {
      available: true,
      analyzer: "vlm",
      data: vlmData,
      latency_ms: 450,
    };
    expect(result.available).toBe(true);
    expect(result.latency_ms).toBeGreaterThan(0);
  });

  it("accepts a stub result (unavailable)", () => {
    const result: AnalyzerResult = {
      available: false,
      analyzer: "detection",
      error: "Local detection module not installed",
      latency_ms: 0,
    };
    expect(result.available).toBe(false);
    expect(result.data).toBeUndefined();
  });
});
