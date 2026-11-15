import { describe, it, expect } from "vitest";
import { VisionController } from "../vision-controller/vision-controller.js";
import {
  createBenchmarkVisionControllerConfig,
  mergeWithBenchmarkVisionControllerDefaults,
} from "../vision-controller/default-config.js";
import type { VisionControllerConfig } from "../vision-controller/types.js";
import type { FrameDetectionInput, MotionHint } from "../vision-controller/frame-signal-extractor.js";
import type { PerceptionResult, Segment, PerceptionMemory } from "@cortex/shared";
import type { Rule } from "../vc-types/types.js";

// ── Helpers ──

function makeConfig(overrides?: Partial<VisionControllerConfig>): VisionControllerConfig {
  return {
    enabled: true,
    baseline: { fps: 1 },
    rules: [],
    ...overrides,
  };
}

function makeDetections(...labels: string[]): FrameDetectionInput[] {
  return labels.map((label, i) => ({
    label,
    confidence: 0.9,
    bbox: { x1: i * 100, y1: 0, x2: i * 100 + 80, y2: 80 },
  }));
}

function makeMotionHint(overrides?: Partial<MotionHint>): MotionHint {
  return {
    has_motion: false,
    last_motion_at: 0,
    last_still_at: 0,
    ...overrides,
  };
}

function makeSegment(overrides?: Partial<Segment>): Segment {
  return {
    segment_id: "seg-1",
    camera_id: "cam1",
    mode: "stream",
    frames: [],
    raw_url: "/tmp/raw.mp4",
    timestamp: 10_000,
    duration_sec: 5,
    ...overrides,
  };
}

function makeResult(overrides?: {
  camera_id?: string;
  entities?: PerceptionMemory["entities"];
  security_risk?: boolean;
  is_static_scene?: boolean;
  custom_fields?: Record<string, string | number | boolean>;
  transcript?: string;
  segment_policy_exit_met?: boolean;
}): PerceptionResult {
  const cameraId = overrides?.camera_id ?? "cam1";
  const pm: Record<string, unknown> = {
    summary: "Test scene",
    detailed_summary: "Test scene details",
    security_risk: overrides?.security_risk ?? false,
    timestamp: Date.now(),
    entities: overrides?.entities ?? [],
    perception_level: 0,
    is_static_scene: overrides?.is_static_scene ?? false,
    custom_fields: overrides?.custom_fields,
  };
  if (overrides?.segment_policy_exit_met) {
    pm.segment_policy_exit_met = true;
  }
  return {
    segment_id: "seg-1",
    camera_id: cameraId,
    mode: "stream",
    event_id: "evt-1",
    perception_memory: pm as PerceptionMemory,
    media_urls: { raw: "/tmp/raw.mp4", keyframes: [], crops: [] },
    transcript: overrides?.transcript,
  };
}

// ── Default config tests ──

describe("benchmark-aligned default config", () => {
  it("uses the benchmark segment policy by default", () => {
    const config = createBenchmarkVisionControllerConfig();

    expect(config.baseline).toEqual({ fps: 1 });
    expect(config.rules.map((rule) => rule.name)).toEqual([
      "person_present",
      "moving_object_observe",
    ]);
    expect(config.rules.find((rule) => rule.name === "person_present")?.action.fps).toBe(1);
    expect(config.segment_policy).toMatchObject({
      consultation_triggers: [{ type: "security_risk" }],
      consultation_cooldown_seconds: 60,
      consultation_event_budget: 5,
    });
  });

  it("preserves an explicit disabled flag while filling benchmark defaults", () => {
    const config = mergeWithBenchmarkVisionControllerDefaults({ enabled: false });

    expect(config.enabled).toBe(false);
    expect(config.auto_rules.map((rule) => rule.name)).toEqual([
      "person_present",
      "moving_object_observe",
    ]);
    expect(config.segment_policy?.consultation_event_budget).toBe(5);
  });
});

// ── Frame policy tests ──

describe("VisionController — frame policy evaluateFrame", () => {
  it("returns baseline when no rules match", () => {
    const vc = new VisionController(makeConfig({
      rules: [
        { name: "person_boost", trigger: { type: "class_detected", class: "person" }, action: { fps: 5 } },
      ],
    }));
    const out = vc.evaluateFrame("cam1", [], undefined, 1000);
    expect(out.firedRules).toEqual([]);
    expect(out.action).toEqual({ fps: 1 });
  });

  it("fires rule on detection + motion", () => {
    const rule: Rule = {
      name: "person_motion",
      trigger: {
        type: "all_of",
        conditions: [
          { type: "class_detected", class: "person" },
          { type: "motion_sustained_ms", duration: 500 },
        ],
      },
      action: { fps: 10, skip_vlm: false },
    };
    const vc = new VisionController(makeConfig({ rules: [rule] }));

    const detections = makeDetections("person");
    const motion = makeMotionHint({
      has_motion: true,
      last_motion_at: 2000,
      last_still_at: 1000,
    });

    const out = vc.evaluateFrame("cam1", detections, motion, 2000);
    expect(out.firedRules).toEqual(["person_motion"]);
    expect(out.action.fps).toBe(10);
    expect(out.action.skip_vlm).toBe(false);
  });

  it("hold persists after rule stops matching, then expires", () => {
    const vc = new VisionController(makeConfig({
      rules: [
        {
          name: "person_boost",
          trigger: { type: "class_detected", class: "person" },
          action: { fps: 5 },
          hold_ms: 3000,
        },
      ],
    }));

    // Frame 1 (t=1000): person detected — rule fires
    const out1 = vc.evaluateFrame("cam1", makeDetections("person"), undefined, 1000);
    expect(out1.firedRules).toEqual(["person_boost"]);
    expect(out1.action.fps).toBe(5);

    // Frame 2 (t=2000): no person — hold active (1000 < holdUntil=4000)
    const out2 = vc.evaluateFrame("cam1", [], undefined, 2000);
    expect(out2.firedRules).toEqual([]);
    expect(out2.action.fps).toBe(5); // held

    // Frame 3 (t=5000): no person — hold expired (5000 >= holdUntil=4000)
    const out3 = vc.evaluateFrame("cam1", [], undefined, 5000);
    expect(out3.firedRules).toEqual([]);
    expect(out3.action).toEqual({ fps: 1 }); // baseline
  });

  it("hold refreshes on continued triggering", () => {
    const vc = new VisionController(makeConfig({
      rules: [
        {
          name: "person_boost",
          trigger: { type: "class_detected", class: "person" },
          action: { fps: 5 },
          hold_ms: 2000,
        },
      ],
    }));

    // Frame 1 (t=1000): fires, holdUntil = 3000
    vc.evaluateFrame("cam1", makeDetections("person"), undefined, 1000);

    // Frame 2 (t=2500): fires again, holdUntil refreshes to 4500
    const out2 = vc.evaluateFrame("cam1", makeDetections("person"), undefined, 2500);
    expect(out2.firedRules).toEqual(["person_boost"]);

    // Frame 3 (t=4000): no person, within refreshed hold (4000 < 4500)
    const out3 = vc.evaluateFrame("cam1", [], undefined, 4000);
    expect(out3.firedRules).toEqual([]);
    expect(out3.action.fps).toBe(5); // held

    // Frame 4 (t=5000): hold expired (5000 >= 4500)
    const out4 = vc.evaluateFrame("cam1", [], undefined, 5000);
    expect(out4.action).toEqual({ fps: 1 }); // baseline
  });

  it("cooldown uses media time, not wall clock", () => {
    const vc = new VisionController(makeConfig({
      rules: [
        {
          name: "person_boost",
          trigger: { type: "class_detected", class: "person" },
          action: { fps: 5 },
          cooldown_ms: 5000,
          hold_ms: 0,
        },
      ],
    }));

    // Frame 1 (t=1000): fires
    const out1 = vc.evaluateFrame("cam1", makeDetections("person"), undefined, 1000);
    expect(out1.firedRules).toEqual(["person_boost"]);

    // Frame 2 (t=3000): still within cooldown (3000 - 1000 = 2000 < 5000)
    const out2 = vc.evaluateFrame("cam1", makeDetections("person"), undefined, 3000);
    expect(out2.firedRules).toEqual([]);

    // Frame 3 (t=7000): cooldown expired (7000 - 1000 = 6000 >= 5000)
    const out3 = vc.evaluateFrame("cam1", makeDetections("person"), undefined, 7000);
    expect(out3.firedRules).toEqual(["person_boost"]);
  });

  it("returns baseline when disabled", () => {
    const vc = new VisionController(makeConfig({
      enabled: false,
      rules: [
        { name: "person_boost", trigger: { type: "class_detected", class: "person" }, action: { fps: 5 } },
      ],
    }));
    const out = vc.evaluateFrame("cam1", makeDetections("person"), undefined, 1000);
    expect(out.firedRules).toEqual([]);
    expect(out.action).toEqual({ fps: 1 });
  });

  it("per-camera state isolation", () => {
    const vc = new VisionController(makeConfig({
      rules: [
        {
          name: "person_boost",
          trigger: { type: "class_detected", class: "person" },
          action: { fps: 5 },
          cooldown_ms: 60_000,
          hold_ms: 0,
        },
      ],
    }));

    // cam1: fires
    const out1 = vc.evaluateFrame("cam1", makeDetections("person"), undefined, 1000);
    expect(out1.firedRules).toEqual(["person_boost"]);

    // cam2: separate state, also fires
    const out2 = vc.evaluateFrame("cam2", makeDetections("person"), undefined, 1000);
    expect(out2.firedRules).toEqual(["person_boost"]);

    // cam1: cooldown still active
    const out3 = vc.evaluateFrame("cam1", makeDetections("person"), undefined, 2000);
    expect(out3.firedRules).toEqual([]);
  });
});

// ── Segment policy tests ──

describe("VisionController — segment policy evaluateSegment", () => {
  it("segment-only rule (security_risk) fires and outputs action", () => {
    const vc = new VisionController(makeConfig({
      rules: [
        {
          name: "security_alert",
          trigger: { type: "security_risk" },
          action: { fps: 10, skip_vlm: false, max_level: 1 },
        },
      ],
    }));
    const result = makeResult({ security_risk: true });
    const segment = makeSegment();

    const out = vc.evaluateSegment(result, segment);
    expect(out.firedRules).toEqual(["security_alert"]);
    expect(out.action.fps).toBe(10);
    expect(out.action.skip_vlm).toBe(false);
    expect(out.action.max_level).toBe(1);
  });

  it("segment policy override persists when exit condition not met", () => {
    const vc = new VisionController(makeConfig({
      rules: [
        {
          name: "security_alert",
          trigger: { type: "security_risk" },
          action: { fps: 10 },
        },
      ],
    }));

    // First segment: security_risk fires, sets segment policy override
    const seg1 = makeSegment({ timestamp: 10_000 });
    const out1 = vc.evaluateSegment(makeResult({ security_risk: true }), seg1);
    expect(out1.firedRules).toEqual(["security_alert"]);
    expect(out1.action.fps).toBe(10);

    // Set an exit condition that is NOT met
    vc.setSegmentPolicyExitCondition("cam1", { type: "no_motion_ms", duration: 30_000 });

    // Second segment: no security_risk, but override persists
    const seg2 = makeSegment({ timestamp: 20_000 });
    const out2 = vc.evaluateSegment(makeResult({ security_risk: false }), seg2);
    expect(out2.firedRules).toEqual([]);
    expect(out2.action.fps).toBe(10); // override held
    expect(out2.segmentPolicyCleared).toBe(false);
  });

  it("segment policy clears when exit condition met via segment_policy_exit_met", () => {
    const vc = new VisionController(makeConfig({
      rules: [
        {
          name: "security_alert",
          trigger: { type: "security_risk" },
          action: { fps: 10 },
        },
      ],
    }));

    // Fire the rule to establish segment policy override
    const seg1 = makeSegment({ timestamp: 10_000 });
    vc.evaluateSegment(makeResult({ security_risk: true }), seg1);

    // Next segment: VLM signals exit
    const seg2 = makeSegment({ timestamp: 20_000 });
    const out = vc.evaluateSegment(makeResult({ segment_policy_exit_met: true }), seg2);
    expect(out.segmentPolicyCleared).toBe(true);
    expect(out.action).toEqual({}); // cleared, no new rules
  });

  it("segment policy clears when structured exit condition matches", () => {
    const vc = new VisionController(makeConfig({
      rules: [
        {
          name: "security_alert",
          trigger: { type: "security_risk" },
          action: { fps: 10 },
        },
      ],
    }));

    // Fire the rule
    const seg1 = makeSegment({ timestamp: 10_000 });
    vc.evaluateSegment(makeResult({ security_risk: true }), seg1);

    // Set exit condition: class_detected "all_clear" (using custom_field for test convenience)
    vc.setSegmentPolicyExitCondition("cam1", { type: "custom_field", key: "all_clear", value: true });

    // Segment with custom_field that matches exit condition
    const seg2 = makeSegment({ timestamp: 20_000 });
    const out = vc.evaluateSegment(
      makeResult({ custom_fields: { all_clear: true } }),
      seg2,
    );
    expect(out.segmentPolicyCleared).toBe(true);
    expect(out.action).toEqual({});
  });

  it("segment policy clears on absolute timeout (5 min)", () => {
    const vc = new VisionController(makeConfig({
      rules: [
        {
          name: "security_alert",
          trigger: { type: "security_risk" },
          action: { fps: 10 },
        },
      ],
    }));

    // Fire the rule at t=10_000
    const seg1 = makeSegment({ timestamp: 10_000, duration_sec: 5 });
    vc.evaluateSegment(makeResult({ security_risk: true }), seg1);

    // 5 minutes later: absolute timeout triggers
    const fiveMinLater = 10_000 + 5 * 60 * 1000;
    const seg2 = makeSegment({ timestamp: fiveMinLater, duration_sec: 5 });
    const out = vc.evaluateSegment(makeResult(), seg2);
    expect(out.segmentPolicyCleared).toBe(true);
    expect(out.action).toEqual({});
  });

  it("consultation triggered by segment_policy", () => {
    const vc = new VisionController(makeConfig({
      rules: [],
      segment_policy: {
        consultation_triggers: [{ type: "security_risk" }],
        consultation_cooldown_seconds: 60,
      },
    }));

    const seg = makeSegment({ timestamp: 10_000 });
    const out = vc.evaluateSegment(makeResult({ security_risk: true }), seg);
    expect(out.shouldConsultAgent).toBe(true);
    expect(out.consultationContext).toBeDefined();
    expect(out.consultationContext!.camera_id).toBe("cam1");
    expect(out.consultationContext!.trigger_reason).toEqual({ type: "security_risk" });
  });

  it("consultation cooldown prevents re-trigger", () => {
    const vc = new VisionController(makeConfig({
      segment_policy: {
        consultation_triggers: [{ type: "security_risk" }],
        consultation_cooldown_seconds: 60,
      },
    }));

    const seg1 = makeSegment({ timestamp: 10_000 });
    const out1 = vc.evaluateSegment(makeResult({ security_risk: true }), seg1);
    expect(out1.shouldConsultAgent).toBe(true);

    // 10s later: within cooldown
    const seg2 = makeSegment({ timestamp: 20_000 });
    const out2 = vc.evaluateSegment(makeResult({ security_risk: true }), seg2);
    expect(out2.shouldConsultAgent).toBe(false);
  });

  it("event budget triggers periodic consultation after N events", () => {
    const vc = new VisionController(makeConfig({
      rules: [],
      segment_policy: {
        consultation_triggers: [{ type: "security_risk" }],
        consultation_cooldown_seconds: 0, // no cooldown for clarity
        consultation_event_budget: 3,
      },
    }));

    // Events 1-2: no trigger (below budget, no security_risk)
    const out1 = vc.evaluateSegment(
      { ...makeResult(), event_id: "evt-1" }, makeSegment({ timestamp: 10_000 }),
    );
    expect(out1.shouldConsultAgent).toBe(false);
    const out2 = vc.evaluateSegment(
      { ...makeResult(), event_id: "evt-2" }, makeSegment({ timestamp: 20_000 }),
    );
    expect(out2.shouldConsultAgent).toBe(false);

    // Event 3: budget met → periodic_budget trigger
    const out3 = vc.evaluateSegment(
      { ...makeResult(), event_id: "evt-3" }, makeSegment({ timestamp: 30_000 }),
    );
    expect(out3.shouldConsultAgent).toBe(true);
    expect(out3.consultationContext!.trigger_reason).toEqual({
      type: "periodic_budget", event_budget: 3,
    });
  });

  it("event budget respects cooldown", () => {
    const vc = new VisionController(makeConfig({
      rules: [],
      segment_policy: {
        consultation_triggers: [{ type: "security_risk" }],
        consultation_cooldown_seconds: 60,
        consultation_event_budget: 2,
      },
    }));

    // Event 1-2 at t=10s, t=20s: budget met but first consult fires at event 2
    vc.evaluateSegment(
      { ...makeResult(), event_id: "evt-1" }, makeSegment({ timestamp: 10_000 }),
    );
    const out2 = vc.evaluateSegment(
      { ...makeResult(), event_id: "evt-2" }, makeSegment({ timestamp: 20_000 }),
    );
    expect(out2.shouldConsultAgent).toBe(true);

    // Event 3-4 at t=30s, t=40s: budget met again but cooldown not expired (last consult at 20s)
    vc.evaluateSegment(
      { ...makeResult(), event_id: "evt-3" }, makeSegment({ timestamp: 30_000 }),
    );
    const out4 = vc.evaluateSegment(
      { ...makeResult(), event_id: "evt-4" }, makeSegment({ timestamp: 40_000 }),
    );
    expect(out4.shouldConsultAgent).toBe(false);

    // Event 5 at t=90s: cooldown expired, budget met → fires
    const out5 = vc.evaluateSegment(
      { ...makeResult(), event_id: "evt-5" }, makeSegment({ timestamp: 90_000 }),
    );
    expect(out5.shouldConsultAgent).toBe(true);
  });

  it("multiple segments within same event do not increment budget counter", () => {
    const vc = new VisionController(makeConfig({
      rules: [],
      segment_policy: {
        consultation_triggers: [{ type: "security_risk" }],
        consultation_cooldown_seconds: 0,
        consultation_event_budget: 2,
      },
    }));

    // 3 segments all with same event_id → only 1 event counted
    for (let i = 0; i < 3; i++) {
      const out = vc.evaluateSegment(
        { ...makeResult(), event_id: "evt-same" },
        makeSegment({ segment_id: `seg-${i}`, timestamp: 10_000 + i * 5000 }),
      );
      expect(out.shouldConsultAgent).toBe(false);
    }

    // New event_id → 2nd event → budget met → fires
    const out = vc.evaluateSegment(
      { ...makeResult(), event_id: "evt-different" },
      makeSegment({ timestamp: 30_000 }),
    );
    expect(out.shouldConsultAgent).toBe(true);
  });

  it("event budget counter resets after consultation", () => {
    const vc = new VisionController(makeConfig({
      rules: [],
      segment_policy: {
        consultation_triggers: [{ type: "security_risk" }],
        consultation_cooldown_seconds: 0,
        consultation_event_budget: 2,
      },
    }));

    // 2 events → fires
    vc.evaluateSegment({ ...makeResult(), event_id: "evt-1" }, makeSegment({ timestamp: 10_000 }));
    const out2 = vc.evaluateSegment({ ...makeResult(), event_id: "evt-2" }, makeSegment({ timestamp: 20_000 }));
    expect(out2.shouldConsultAgent).toBe(true);

    // Next single event should NOT fire (counter reset)
    const out3 = vc.evaluateSegment({ ...makeResult(), event_id: "evt-3" }, makeSegment({ timestamp: 30_000 }));
    expect(out3.shouldConsultAgent).toBe(false);

    // 2nd event after reset → fires again
    const out4 = vc.evaluateSegment({ ...makeResult(), event_id: "evt-4" }, makeSegment({ timestamp: 40_000 }));
    expect(out4.shouldConsultAgent).toBe(true);
  });

  it("returns empty action when disabled", () => {
    const vc = new VisionController(makeConfig({
      enabled: false,
      rules: [
        { name: "security_alert", trigger: { type: "security_risk" }, action: { fps: 10 } },
      ],
    }));
    const out = vc.evaluateSegment(makeResult({ security_risk: true }), makeSegment());
    expect(out.firedRules).toEqual([]);
    expect(out.action).toEqual({});
    expect(out.segmentPolicyCleared).toBe(false);
    expect(out.shouldConsultAgent).toBe(false);
  });
});

// ── Accessors & Reconfigure ──

describe("VisionController — accessors", () => {
  it("getFramePolicyState returns hold state", () => {
    const vc = new VisionController(makeConfig({
      rules: [
        { name: "person_boost", trigger: { type: "class_detected", class: "person" }, action: { fps: 5 }, hold_ms: 3000 },
      ],
    }));

    // Before any evaluation
    expect(vc.getFramePolicyState("cam1").holdActive).toBe(false);

    // After rule fires
    vc.evaluateFrame("cam1", makeDetections("person"), undefined, 1000);
    const s = vc.getFramePolicyState("cam1");
    expect(s.holdActive).toBe(true);
    expect(s.holdUntil).toBe(4000);
    expect(s.lastAction).toEqual({ fps: 5 });
  });

  it("getSegmentPolicyState returns override info", () => {
    const vc = new VisionController(makeConfig({
      rules: [
        { name: "security_alert", trigger: { type: "security_risk" }, action: { fps: 10 } },
      ],
    }));

    // Before any evaluation
    expect(vc.getSegmentPolicyState("cam1").override).toBeNull();

    // After rule fires
    vc.evaluateSegment(makeResult({ security_risk: true }), makeSegment({ timestamp: 5000 }));
    const s = vc.getSegmentPolicyState("cam1");
    expect(s.override).toEqual({ fps: 10 });
    expect(s.activatedAt).toBe(10_000); // 5000 + 5*1000
  });

  it("reconfigure updates rules and re-classifies", () => {
    const vc = new VisionController(makeConfig());

    // No rules — baseline
    const out1 = vc.evaluateFrame("cam1", makeDetections("person"), undefined, 1000);
    expect(out1.action).toEqual({ fps: 1 });

    // Add a rule via reconfigure
    vc.reconfigure({
      rules: [
        { name: "person_boost", trigger: { type: "class_detected", class: "person" }, action: { fps: 5 } },
      ],
    });

    const out2 = vc.evaluateFrame("cam1", makeDetections("person"), undefined, 2000);
    expect(out2.firedRules).toEqual(["person_boost"]);
    expect(out2.action.fps).toBe(5);
  });
});

// ── Frame policy voice hard logic ──

describe("VisionController frame policy voice hard logic", () => {
  it("has_voice forces skip_vlm=false even when baseline says skip_vlm=true", () => {
    const vc = new VisionController({
      enabled: true,
      baseline: { fps: 1, skip_vlm: true },
      rules: [],
    });

    const framePolicyNoVoice = vc.evaluateFrame("cam1", [], undefined, 1000);
    expect(framePolicyNoVoice.action.skip_vlm).toBe(true);

    const framePolicyWithVoice = vc.evaluateFrame("cam1", [], undefined, 2000, { has_voice: true });
    expect(framePolicyWithVoice.action.skip_vlm).toBe(false);
    expect(framePolicyWithVoice.signals.has_voice).toBe(true);
  });
});
