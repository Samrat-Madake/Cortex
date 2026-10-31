import { describe, it, expect } from "vitest";
import { extractSignals } from "../vc-types/signal-extractor.js";
import type { PerceptionResult, Segment, MotionHint } from "@reflectworld/shared";
import type { SegmentSignals } from "../vc-types/types.js";

function makeSegment(overrides?: { _motion_hint?: MotionHint }): Segment {
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

function makeResult(overrides?: Partial<PerceptionResult>): PerceptionResult {
  return {
    segment_id: "seg-1",
    camera_id: "cam1",
    mode: "stream",
    event_id: "evt-1",
    perception_memory: {
      summary: "test",
      detailed_summary: "test detail",
      security_risk: false,
      timestamp: Date.now(),
      perception_level: 0,
      entities: [],
    },
    media_urls: { raw: "/tmp/raw.mp4", keyframes: [], crops: [] },
    ...overrides,
  };
}

describe("extractSignals", () => {
  it("extracts detected_classes and class_counts from entities", () => {
    const result = makeResult({
      perception_memory: {
        ...makeResult().perception_memory,
        entities: [
          { type: "person" },
          { type: "person" },
          { type: "car" },
        ],
      },
    });
    const signals = extractSignals(result, makeSegment(), null);
    expect(signals.detected_classes).toEqual(new Set(["person", "car"]));
    expect(signals.class_counts.get("person")).toBe(2);
    expect(signals.class_counts.get("car")).toBe(1);
  });

  it("detects face_detected from entities with face_bbox", () => {
    const result = makeResult({
      perception_memory: {
        ...makeResult().perception_memory,
        entities: [
          { type: "person", face_bbox: { x: 0, y: 0, width: 50, height: 50 } },
        ],
      },
    });
    const signals = extractSignals(result, makeSegment(), null);
    expect(signals.face_detected).toBe(true);
  });

  it("reads has_motion from segment._motion_hint", () => {
    const segment = makeSegment({
      _motion_hint: { has_motion: true, ratio: 0.5, last_motion_at: Date.now(), last_still_at: Date.now() - 1000 },
    });
    const signals = extractSignals(makeResult(), segment, null);
    expect(signals.has_motion).toBe(true);
  });

  it("computes no_motion_ms from timestamps", () => {
    const segment = makeSegment({
      _motion_hint: { has_motion: false, ratio: 0, last_motion_at: 0, last_still_at: 12_000 },
    });
    const signals = extractSignals(makeResult(), segment, null);
    expect(signals.no_motion_ms).toBe(3000);
  });

  it("computes motion_sustained_ms when motion is active", () => {
    const segment = makeSegment({
      _motion_hint: { has_motion: true, ratio: 0.3, last_motion_at: 14_000, last_still_at: 8_000 },
    });
    const signals = extractSignals(makeResult(), segment, null);
    expect(signals.motion_sustained_ms).toBe(7000);
  });

  it("detects voice_detected from transcript presence", () => {
    const result = makeResult({ transcript: "hello world" });
    const signals = extractSignals(result, makeSegment(), null);
    expect(signals.voice_detected).toBe(true);
  });

  it("detects has_unknown_entity from is_new_entity", () => {
    const result = makeResult({
      perception_memory: {
        ...makeResult().perception_memory,
        entities: [{ type: "person", is_new_entity: true }],
      },
    });
    const signals = extractSignals(result, makeSegment(), null);
    expect(signals.has_unknown_entity).toBe(true);
  });

  it("collects known_entity_ids from entities with entity_id", () => {
    const result = makeResult({
      perception_memory: {
        ...makeResult().perception_memory,
        entities: [
          { type: "person", entity_id: "alice" },
          { type: "person" },
        ],
      },
    });
    const signals = extractSignals(result, makeSegment(), null);
    expect(signals.known_entity_ids).toEqual(new Set(["alice"]));
  });

  it("reads security_risk from perception_memory", () => {
    const result = makeResult({
      perception_memory: {
        ...makeResult().perception_memory,
        security_risk: true,
      },
    });
    const signals = extractSignals(result, makeSegment(), null);
    expect(signals.security_risk).toBe(true);
  });

  it("increments static_scene_count across consecutive calls", () => {
    const result = makeResult({
      perception_memory: {
        ...makeResult().perception_memory,
        is_static_scene: true,
      },
    });

    const signals1 = extractSignals(result, makeSegment(), null);
    expect(signals1.static_scene_count).toBe(1);

    const signals2 = extractSignals(result, makeSegment(), signals1);
    expect(signals2.static_scene_count).toBe(2);

    const signals3 = extractSignals(result, makeSegment(), signals2);
    expect(signals3.static_scene_count).toBe(3);
  });

  it("resets static_scene_count when scene is not static", () => {
    const staticResult = makeResult({
      perception_memory: { ...makeResult().perception_memory, is_static_scene: true },
    });
    const dynamicResult = makeResult({
      perception_memory: { ...makeResult().perception_memory, is_static_scene: false },
    });

    const signals1 = extractSignals(staticResult, makeSegment(), null);
    expect(signals1.static_scene_count).toBe(1);

    const signals2 = extractSignals(dynamicResult, makeSegment(), signals1);
    expect(signals2.static_scene_count).toBe(0);
  });

  it("computes disappeared_classes by diffing with previous signals", () => {
    const prev: SegmentSignals = {
      detected_classes: new Set(["person", "car"]),
      class_counts: new Map([["person", 1], ["car", 1]]),
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
    };

    // Now only car is detected, person disappeared
    const result = makeResult({
      perception_memory: {
        ...makeResult().perception_memory,
        entities: [{ type: "car" }],
      },
    });

    const signals = extractSignals(result, makeSegment(), prev);
    expect(signals.disappeared_classes).toEqual(new Set(["person"]));
  });

  it("passes through custom_fields from perception_memory", () => {
    const result = makeResult({
      perception_memory: {
        ...makeResult().perception_memory,
        custom_fields: { scene_ended: true, score: 42 },
      },
    });
    const signals = extractSignals(result, makeSegment(), null);
    expect(signals.custom_fields).toEqual({ scene_ended: true, score: 42 });
  });

  it("defaults to empty signals when no data", () => {
    const signals = extractSignals(makeResult(), makeSegment(), null);
    expect(signals.detected_classes.size).toBe(0);
    expect(signals.face_detected).toBe(false);
    expect(signals.has_motion).toBe(false);
    expect(signals.voice_detected).toBe(false);
    expect(signals.has_unknown_entity).toBe(false);
    expect(signals.security_risk).toBe(false);
    expect(signals.static_scene_count).toBe(0);
  });
});
