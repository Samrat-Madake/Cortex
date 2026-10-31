import { describe, it, expect, beforeEach } from "vitest";
import { buildSegment, _resetSegmentCounter } from "../segment-builder.js";
import type { FrameResult } from "../types.js";

beforeEach(() => _resetSegmentCounter());

function makeFrame(ts: number): FrameResult {
  return { data: "base64jpg", timestamp: ts, source_name: "cam_front" };
}

describe("buildSegment", () => {
  it("builds single-frame segment (periodic)", () => {
    const seg = buildSegment([makeFrame(1000)], {
      cameraId: "cam_front",
      mode: "snapshot",
      rawUrl: "s3://raw-video/cam_front/seg_001.jpg",
    });

    expect(seg.segment_id).toMatch(/^seg_/);
    expect(seg.camera_id).toBe("cam_front");
    expect(seg.mode).toBe("snapshot");
    expect(seg.frames).toHaveLength(1);
    expect(seg.frames[0].index).toBe(0);
    expect(seg.duration_sec).toBe(0);
    expect(seg.raw_url).toContain("s3://");
  });

  it("builds multi-frame segment (stream)", () => {
    const frames = [makeFrame(1000), makeFrame(2000), makeFrame(3000)];
    const seg = buildSegment(frames, {
      cameraId: "cam_back",
      mode: "stream",
    });

    expect(seg.frames).toHaveLength(3);
    expect(seg.duration_sec).toBe(2); // 3000-1000 = 2000ms = 2s
    expect(seg.frames[2].index).toBe(2);
  });

  it("throws on empty frames", () => {
    expect(() =>
      buildSegment([], { cameraId: "cam", mode: "snapshot" }),
    ).toThrow("empty frames");
  });

  it("generates unique segment IDs", () => {
    const s1 = buildSegment([makeFrame(1)], { cameraId: "c", mode: "snapshot" });
    const s2 = buildSegment([makeFrame(2)], { cameraId: "c", mode: "snapshot" });
    expect(s1.segment_id).not.toBe(s2.segment_id);
  });

  it("includes event_hint for event mode", () => {
    const seg = buildSegment([makeFrame(1000)], {
      cameraId: "cam",
      mode: "event",
      eventHint: "motion_detected",
    });
    expect(seg.event_hint).toBe("motion_detected");
  });
});
