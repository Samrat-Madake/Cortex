import { describe, it, expect } from "vitest";
import type { PerceptionMemory, Frame, Segment, MediaUrls, PerceptionResult, PerceptionEvent } from "../types.js";

describe("PerceptionMemory", () => {
  it("accepts minimal Level 0 memory", () => {
    const mem: PerceptionMemory = {
      summary: "A person is at the door",
      detailed_summary: "",
      security_risk: false,
      timestamp: Date.now(),
      perception_level: 0,
    };
    expect(mem.summary).toBe("A person is at the door");
    expect(mem.entities).toBeUndefined();
  });

  it("accepts full local-model memory", () => {
    const mem: PerceptionMemory = {
      summary: "Neighbor Alex visited",
      detailed_summary: "Neighbor Alex arrived wearing a blue jacket and stayed at the door for about three minutes.",
      security_risk: false,
      timestamp: Date.now(),
      entities: [{
        type: "person",
        appearance: "blue jacket",
        track_id: "track_1",
        entity_id: "alex",
        is_new_entity: false,
      }],
      perception_level: 1,
      strategy_context: "home_security",
    };
    expect(mem.perception_level).toBe(1);
    expect(mem.entities?.[0]?.entity_id).toBe("alex");
  });
});

describe("Frame", () => {
  it("accepts a valid frame", () => {
    const frame: Frame = { data: "base64jpeg==", timestamp: Date.now(), index: 0 };
    expect(frame.index).toBe(0);
  });
});

describe("Segment", () => {
  it("accepts a periodic single-frame segment", () => {
    const seg: Segment = {
      segment_id: "seg_001",
      camera_id: "cam_front_door",
      mode: "snapshot",
      frames: [{ data: "base64jpeg==", timestamp: Date.now(), index: 0 }],
      raw_url: "s3://raw-video/cam_front_door/seg_001.jpg",
      timestamp: Date.now(),
      duration_sec: 0,
    };
    expect(seg.mode).toBe("snapshot");
    expect(seg.frames).toHaveLength(1);
  });

  it("accepts an event multi-frame segment with hint", () => {
    const seg: Segment = {
      segment_id: "seg_002",
      camera_id: "cam_front_door",
      mode: "event",
      frames: [
        { data: "f1==", timestamp: 1000, index: 0 },
        { data: "f2==", timestamp: 2000, index: 1 },
      ],
      raw_url: "s3://raw-video/cam_front_door/seg_002.mp4",
      timestamp: 1000,
      duration_sec: 5,
      event_hint: "motion detected at front door",
    };
    expect(seg.frames).toHaveLength(2);
    expect(seg.event_hint).toContain("motion");
  });
});

describe("PerceptionResult", () => {
  it("accepts a minimal PerceptionResult", () => {
    const result: PerceptionResult = {
      segment_id: "seg_001",
      camera_id: "cam_front_door",
      mode: "snapshot",
      event_id: "evt_001",
      perception_memory: {
        summary: "Empty hallway",
        detailed_summary: "",
        security_risk: false,
        timestamp: Date.now(),
        perception_level: 0,
      },
      media_urls: {
        raw: "s3://raw-video/cam_front_door/seg_001.jpg",
        keyframes: [],
        crops: [],
      },
    };
    expect(result.event_id).toBe("evt_001");
    expect(result.media_urls.gif).toBeUndefined();
  });
});

describe("PerceptionEvent", () => {
  it("accepts a valid PerceptionEvent", () => {
    const evt: PerceptionEvent = {
      segment_id: "seg_002",
      camera_id: "cam_front_door",
      mode: "event",
      event_id: "evt_002",
      memory: {
        summary: "Person at front door",
        detailed_summary: "A person is standing at the front door.",
        security_risk: false,
        timestamp: Date.now(),
        perception_level: 1,
      },
      media_urls: {
        raw: "s3://raw-video/cam_front_door/seg_002.mp4",
        gif: "s3://media-gif/seg_002.gif",
        keyframes: ["s3://media-keyframe/seg_002/0.jpg"],
        crops: [],
      },
    };
    expect(evt.media_urls.gif).toBeDefined();
  });
});
