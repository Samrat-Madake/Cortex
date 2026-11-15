// E2E: VisionController lifecycle — real VisionController + SignalExtractor + rule-matcher
import { describe, it, expect } from "vitest";
import { VisionController } from "../../packages/cortex/src/vision-controller/index.js";
import type { VisionControllerConfig } from "../../packages/cortex/src/vision-controller/index.js";
import type { PerceptionResult, Segment, PerceptionMemory } from "@cortex/shared";

function makeSegment(cameraId = "cam1"): Segment {
  return {
    segment_id: `seg_${Date.now()}`,
    camera_id: cameraId,
    mode: "stream",
    frames: [{ data: "base64", timestamp: Date.now(), index: 0 }],
    raw_url: "/tmp/raw.jpg",
    timestamp: Date.now(),
    duration_sec: 10,
    _motion_hint: {
      has_motion: false,
      ratio: 0,
      last_motion_at: 0,
      last_still_at: Date.now(),
    },
  };
}

function makeResult(overrides?: {
  camera_id?: string;
  entities?: PerceptionMemory["entities"];
  security_risk?: boolean;
  is_static_scene?: boolean;
  custom_fields?: Record<string, string | number | boolean>;
  transcript?: string;
}): PerceptionResult {
  const cameraId = overrides?.camera_id ?? "cam1";
  return {
    segment_id: `seg_${Date.now()}`,
    camera_id: cameraId,
    mode: "stream",
    event_id: "evt_1",
    perception_memory: {
      summary: "Test scene",
      detailed_summary: "Test scene details",
      security_risk: overrides?.security_risk ?? false,
      timestamp: Date.now(),
      entities: overrides?.entities ?? [],
      perception_level: 0,
      is_static_scene: overrides?.is_static_scene ?? false,
      custom_fields: overrides?.custom_fields,
    },
    media_urls: { raw: "/tmp/raw.jpg", keyframes: [], crops: [] },
    transcript: overrides?.transcript,
  };
}

function makeConfig(overrides?: Partial<VisionControllerConfig>): VisionControllerConfig {
  return {
    enabled: true,
    baseline: { fps: 1 },
    rules: [],
    ...overrides,
  };
}

describe("E2E: VisionController lifecycle", () => {
  // Frame policy rules use evaluateFrame (class_detected is frame-level)
  it("baseline recovery — person detected then absent", () => {
    const vc = new VisionController(makeConfig({
      rules: [
        { name: "person_boost", trigger: { type: "class_detected", class: "person" }, action: { fps: 5 }, hold_ms: 0 },
      ],
    }));

    // Person detected → fps=5 (frame policy)
    const detections = [{ label: "person", confidence: 0.9, bbox: { x1: 0, y1: 0, x2: 100, y2: 200 } }];
    const out1 = vc.evaluateFrame("cam1", detections, { has_motion: true, last_motion_at: 1000, last_still_at: 0 }, 1000);
    expect(out1.action.fps).toBe(5);
    expect(out1.firedRules).toContain("person_boost");

    // Person absent → baseline fps=1 (hold_ms=0 so immediate revert)
    const out2 = vc.evaluateFrame("cam1", [], undefined, 2000);
    expect(out2.action).toEqual({ fps: 1 });
    expect(out2.firedRules).toEqual([]);
  });

  it("field-level first-write-wins across frame + segment policy rules", () => {
    const vc = new VisionController(makeConfig({
      rules: [
        // class_detected → frame policy
        { name: "person_boost", trigger: { type: "class_detected", class: "person" }, action: { fps: 5, skip_vlm: false } },
        // voice_detected → segment policy
        { name: "voice_model", trigger: { type: "voice_detected" }, action: { fps: 3, vlm_model: "flash-lite" } },
      ],
    }));

    // Frame policy: person_boost fires → fps=5
    const detections = [{ label: "person", confidence: 0.9, bbox: { x1: 0, y1: 0, x2: 100, y2: 200 } }];
    const framePolicy = vc.evaluateFrame("cam1", detections, { has_motion: true, last_motion_at: 1000, last_still_at: 0 }, 1000);
    expect(framePolicy.action.fps).toBe(5);
    expect(framePolicy.action.skip_vlm).toBe(false);

    // Segment policy: voice_model fires → fps=3, vlm_model=flash-lite (separate slot)
    const segmentPolicy = vc.evaluateSegment(
      makeResult({ entities: [{ type: "person" }], transcript: "hello" }),
      makeSegment(),
    );
    expect(segmentPolicy.firedRules).toEqual(["voice_model"]);
    expect(segmentPolicy.action.fps).toBe(3);
    expect(segmentPolicy.action.vlm_model).toBe("flash-lite");
  });

  it("per-camera isolation — cam1 triggers, cam2 unaffected", () => {
    const vc = new VisionController(makeConfig({
      rules: [
        { name: "person_boost", trigger: { type: "class_detected", class: "person" }, action: { fps: 5 }, cooldown_ms: 60_000 },
      ],
    }));

    const detections = [{ label: "person", confidence: 0.9, bbox: { x1: 0, y1: 0, x2: 100, y2: 200 } }];
    const motionHint = { has_motion: true, last_motion_at: 1000, last_still_at: 0 };

    // cam1: person → fires
    const out1 = vc.evaluateFrame("cam1", detections, motionHint, 1000);
    expect(out1.firedRules).toContain("person_boost");

    // cam1 again: cooldown → no new fire (but hold maintains action)
    const out1b = vc.evaluateFrame("cam1", detections, motionHint, 2000);
    expect(out1b.firedRules).toEqual([]);

    // cam2: person → fires (independent cooldown)
    const out2 = vc.evaluateFrame("cam2", detections, motionHint, 1000);
    expect(out2.firedRules).toContain("person_boost");
  });

  // Segment policy tests (consultation, static_scene_count, custom_field)
  it("agent consultation fires and respects cooldown", () => {
    const vc = new VisionController(makeConfig({
      rules: [],
      segment_policy: {
        consultation_triggers: [{ type: "security_risk" }],
        consultation_cooldown_seconds: 60,
      },
    }));

    const result = makeResult({ security_risk: true });
    const seg = makeSegment();

    const out1 = vc.evaluateSegment(result, seg);
    expect(out1.shouldConsultAgent).toBe(true);
    expect(out1.consultationContext?.camera_id).toBe("cam1");

    const out2 = vc.evaluateSegment(result, seg);
    expect(out2.shouldConsultAgent).toBe(false);
  });

  it("static_scene_count accumulates and triggers segment policy rule", () => {
    const vc = new VisionController(makeConfig({
      rules: [
        { name: "idle_down", trigger: { type: "static_scene_count", count: 3 }, action: { fps: 0.5, skip_vlm: true } },
      ],
    }));

    const staticResult = makeResult({ is_static_scene: true });
    const seg = makeSegment();

    // Segments 1, 2: count < 3
    expect(vc.evaluateSegment(staticResult, seg).firedRules).toEqual([]);
    expect(vc.evaluateSegment(staticResult, seg).firedRules).toEqual([]);

    // Segment 3: count reaches 3, rule fires
    const out3 = vc.evaluateSegment(staticResult, seg);
    expect(out3.firedRules).toContain("idle_down");
    expect(out3.action.fps).toBe(0.5);
    expect(out3.action.skip_vlm).toBe(true);
  });

  it("custom_field trigger via VLM output", () => {
    const vc = new VisionController(makeConfig({
      rules: [],
      segment_policy: {
        consultation_triggers: [{ type: "custom_field", key: "scene_ended", value: true }],
        consultation_cooldown_seconds: 300,
      },
    }));

    const result = makeResult({ custom_fields: { scene_ended: true } });
    const out = vc.evaluateSegment(result, makeSegment());
    expect(out.shouldConsultAgent).toBe(true);
    expect(out.consultationContext).toBeDefined();
  });
});
