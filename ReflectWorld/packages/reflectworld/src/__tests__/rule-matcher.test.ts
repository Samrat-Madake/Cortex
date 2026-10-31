import { describe, it, expect } from "vitest";
import { matchCondition } from "../vc-types/rule-matcher.js";
import { matchFrameCondition, isFrameLevelRule } from "../vision-controller/rule-matcher.js";
import type { SegmentSignals, TriggerCondition } from "../vc-types/types.js";
import type { FrameLevelSignals } from "../vision-controller/types.js";

function makeSignals(overrides?: Partial<SegmentSignals>): SegmentSignals {
  return {
    detected_classes: new Set(),
    class_counts: new Map(),
    face_detected: false,
    has_motion: false,
    motion_sustained_ms: 0,
    no_motion_ms: 0,
    voice_detected: false,
    has_unknown_entity: false,
    known_entity_ids: new Set(),
    security_risk: false,
    static_scene_count: 0,
    disappeared_classes: new Set(),
    custom_fields: {},
    ...overrides,
  };
}

describe("matchCondition", () => {
  it("matches class_detected", () => {
    const signals = makeSignals({ detected_classes: new Set(["person"]) });
    expect(matchCondition({ type: "class_detected", class: "person" }, signals)).toBe(true);
    expect(matchCondition({ type: "class_detected", class: "car" }, signals)).toBe(false);
  });

  it("matches class_absent (persistent state)", () => {
    const signals = makeSignals({ detected_classes: new Set(["car"]) });
    expect(matchCondition({ type: "class_absent", class: "person" }, signals)).toBe(true);
    expect(matchCondition({ type: "class_absent", class: "car" }, signals)).toBe(false);
  });

  it("matches class_disappeared (edge trigger)", () => {
    const signals = makeSignals({ disappeared_classes: new Set(["person"]) });
    expect(matchCondition({ type: "class_disappeared", class: "person" }, signals)).toBe(true);
    expect(matchCondition({ type: "class_disappeared", class: "car" }, signals)).toBe(false);
  });

  it("matches class_count_gte", () => {
    const signals = makeSignals({ class_counts: new Map([["person", 3]]), detected_classes: new Set(["person"]) });
    expect(matchCondition({ type: "class_count_gte", class: "person", count: 3 }, signals)).toBe(true);
    expect(matchCondition({ type: "class_count_gte", class: "person", count: 5 }, signals)).toBe(false);
  });

  it("matches face_detected", () => {
    expect(matchCondition({ type: "face_detected" }, makeSignals({ face_detected: true }))).toBe(true);
    expect(matchCondition({ type: "face_detected" }, makeSignals({ face_detected: false }))).toBe(false);
  });

  it("matches motion_sustained_ms", () => {
    const signals = makeSignals({ motion_sustained_ms: 5000 });
    expect(matchCondition({ type: "motion_sustained_ms", duration: 3000 }, signals)).toBe(true);
    expect(matchCondition({ type: "motion_sustained_ms", duration: 10000 }, signals)).toBe(false);
  });

  it("matches no_motion_ms", () => {
    const signals = makeSignals({ no_motion_ms: 60000 });
    expect(matchCondition({ type: "no_motion_ms", duration: 30000 }, signals)).toBe(true);
    expect(matchCondition({ type: "no_motion_ms", duration: 120000 }, signals)).toBe(false);
  });

  it("matches voice_detected", () => {
    expect(matchCondition({ type: "voice_detected" }, makeSignals({ voice_detected: true }))).toBe(true);
    expect(matchCondition({ type: "voice_detected" }, makeSignals({ voice_detected: false }))).toBe(false);
  });

  it("matches unknown_entity", () => {
    expect(matchCondition({ type: "unknown_entity" }, makeSignals({ has_unknown_entity: true }))).toBe(true);
    expect(matchCondition({ type: "unknown_entity" }, makeSignals({ has_unknown_entity: false }))).toBe(false);
  });

  it("matches known_entity", () => {
    const signals = makeSignals({ known_entity_ids: new Set(["alice"]) });
    expect(matchCondition({ type: "known_entity", entity_id: "alice" }, signals)).toBe(true);
    expect(matchCondition({ type: "known_entity", entity_id: "bob" }, signals)).toBe(false);
  });

  it("matches security_risk", () => {
    expect(matchCondition({ type: "security_risk" }, makeSignals({ security_risk: true }))).toBe(true);
    expect(matchCondition({ type: "security_risk" }, makeSignals({ security_risk: false }))).toBe(false);
  });

  it("matches static_scene_count", () => {
    expect(matchCondition({ type: "static_scene_count", count: 3 }, makeSignals({ static_scene_count: 3 }))).toBe(true);
    expect(matchCondition({ type: "static_scene_count", count: 3 }, makeSignals({ static_scene_count: 2 }))).toBe(false);
  });

  it("matches custom_field", () => {
    const signals = makeSignals({ custom_fields: { scene_ended: true } });
    expect(matchCondition({ type: "custom_field", key: "scene_ended", value: true }, signals)).toBe(true);
    expect(matchCondition({ type: "custom_field", key: "scene_ended", value: false }, signals)).toBe(false);
  });

  it("matches all_of (AND)", () => {
    const signals = makeSignals({ detected_classes: new Set(["person"]), security_risk: true });
    const condition: TriggerCondition = {
      type: "all_of",
      conditions: [
        { type: "class_detected", class: "person" },
        { type: "security_risk" },
      ],
    };
    expect(matchCondition(condition, signals)).toBe(true);

    // Fails when one condition is false
    const signals2 = makeSignals({ detected_classes: new Set(["person"]), security_risk: false });
    expect(matchCondition(condition, signals2)).toBe(false);
  });

  it("matches any_of (OR)", () => {
    const condition: TriggerCondition = {
      type: "any_of",
      conditions: [
        { type: "class_detected", class: "person" },
        { type: "voice_detected" },
      ],
    };
    // Only voice
    expect(matchCondition(condition, makeSignals({ voice_detected: true }))).toBe(true);
    // Only person
    expect(matchCondition(condition, makeSignals({ detected_classes: new Set(["person"]) }))).toBe(true);
    // Neither
    expect(matchCondition(condition, makeSignals())).toBe(false);
  });
});

// ── VisionController frame-level rule matcher ──

describe("matchFrameCondition", () => {
  const signals: FrameLevelSignals = {
    detected_classes: new Set(["truck", "car"]),
    class_counts: new Map([["truck", 1], ["car", 2]]),
    has_motion: true,
    motion_sustained_ms: 5000,
    no_motion_ms: 0,
  };

  it("matches class_detected", () => {
    expect(matchFrameCondition({ type: "class_detected", class: "truck" }, signals)).toBe(true);
    expect(matchFrameCondition({ type: "class_detected", class: "person" }, signals)).toBe(false);
  });

  it("matches class_absent", () => {
    expect(matchFrameCondition({ type: "class_absent", class: "person" }, signals)).toBe(true);
    expect(matchFrameCondition({ type: "class_absent", class: "truck" }, signals)).toBe(false);
  });

  it("matches class_count_gte", () => {
    expect(matchFrameCondition({ type: "class_count_gte", class: "car", count: 2 }, signals)).toBe(true);
    expect(matchFrameCondition({ type: "class_count_gte", class: "car", count: 3 }, signals)).toBe(false);
  });

  it("matches motion_sustained_ms", () => {
    expect(matchFrameCondition({ type: "motion_sustained_ms", duration: 3000 }, signals)).toBe(true);
    expect(matchFrameCondition({ type: "motion_sustained_ms", duration: 8000 }, signals)).toBe(false);
  });

  it("matches no_motion_ms", () => {
    const stillSignals: FrameLevelSignals = { ...signals, has_motion: false, motion_sustained_ms: 0, no_motion_ms: 10000 };
    expect(matchFrameCondition({ type: "no_motion_ms", duration: 5000 }, stillSignals)).toBe(true);
    expect(matchFrameCondition({ type: "no_motion_ms", duration: 20000 }, stillSignals)).toBe(false);
  });

  it("returns false for segment-policy-only conditions", () => {
    expect(matchFrameCondition({ type: "security_risk" }, signals)).toBe(false);
    expect(matchFrameCondition({ type: "voice_detected" }, signals)).toBe(false);
    expect(matchFrameCondition({ type: "face_detected" }, signals)).toBe(false);
    expect(matchFrameCondition({ type: "unknown_entity" }, signals)).toBe(false);
  });

  it("handles composite any_of/all_of", () => {
    expect(matchFrameCondition({
      type: "all_of",
      conditions: [
        { type: "class_detected", class: "truck" },
        { type: "motion_sustained_ms", duration: 1000 },
      ],
    }, signals)).toBe(true);
  });

  it("composite with segment-policy-only sub-condition returns false gracefully", () => {
    expect(matchFrameCondition({
      type: "all_of",
      conditions: [
        { type: "class_detected", class: "truck" },
        { type: "security_risk" },
      ],
    }, signals)).toBe(false);
  });
});

describe("isFrameLevelRule", () => {
  it("returns true for pure frame-level conditions", () => {
    expect(isFrameLevelRule({ type: "class_detected", class: "person" })).toBe(true);
    expect(isFrameLevelRule({ type: "class_absent", class: "person" })).toBe(true);
    expect(isFrameLevelRule({ type: "class_count_gte", class: "person", count: 2 })).toBe(true);
    expect(isFrameLevelRule({ type: "motion_sustained_ms", duration: 1000 })).toBe(true);
    expect(isFrameLevelRule({ type: "no_motion_ms", duration: 1000 })).toBe(true);
  });

  it("returns false for segment-policy-only conditions", () => {
    expect(isFrameLevelRule({ type: "security_risk" })).toBe(false);
    expect(isFrameLevelRule({ type: "voice_detected" })).toBe(false);
    expect(isFrameLevelRule({ type: "face_detected" })).toBe(false);
    expect(isFrameLevelRule({ type: "unknown_entity" })).toBe(false);
    expect(isFrameLevelRule({ type: "known_entity", entity_id: "alice" })).toBe(false);
    expect(isFrameLevelRule({ type: "class_disappeared", class: "person" })).toBe(false);
    expect(isFrameLevelRule({ type: "static_scene_count", count: 3 })).toBe(false);
    expect(isFrameLevelRule({ type: "custom_field", key: "foo", value: true })).toBe(false);
  });

  it("returns true for composite of frame-level conditions", () => {
    expect(isFrameLevelRule({
      type: "any_of",
      conditions: [
        { type: "class_detected", class: "truck" },
        { type: "motion_sustained_ms", duration: 1000 },
      ],
    })).toBe(true);
    expect(isFrameLevelRule({
      type: "all_of",
      conditions: [
        { type: "class_absent", class: "person" },
        { type: "no_motion_ms", duration: 5000 },
      ],
    })).toBe(true);
  });

  it("returns false for composite containing segment-policy-only condition", () => {
    expect(isFrameLevelRule({
      type: "any_of",
      conditions: [
        { type: "class_detected", class: "truck" },
        { type: "security_risk" },
      ],
    })).toBe(false);
    expect(isFrameLevelRule({
      type: "all_of",
      conditions: [
        { type: "motion_sustained_ms", duration: 1000 },
        { type: "voice_detected" },
      ],
    })).toBe(false);
  });
});
