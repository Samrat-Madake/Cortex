import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CamPipeline } from "../pipeline.js";
import { FixedWindowSegmenter } from "../segmenter/fixed-window.js";
import type { FrameResult } from "../types.js";

function makeFrame(ts = Date.now()): FrameResult {
  return { data: "dGVzdA==", timestamp: ts, source_name: "cam_test" };
}

describe("Watch integration (pipeline + segmenter)", () => {
  it("snapshot mode: each frame -> one segment -> onSegment", async () => {
    const segments: any[] = [];
    const pipeline = new CamPipeline(
      {
        cameraId: "cam_test",
        mode: "snapshot",
        onSegment: async (seg) => { segments.push(seg); return null; },
      },
      { storageManager: null, segmenters: [] },
    );

    for (let i = 0; i < 5; i++) {
      await pipeline.feedFrame(makeFrame(i * 1000));
    }

    expect(segments).toHaveLength(5);
    segments.forEach((s) => {
      expect(s.mode).toBe("snapshot");
      expect(s.frames).toHaveLength(1);
    });
  });

  it("stream watch: accumulates frames, cuts at window boundary", async () => {
    const segments: any[] = [];
    const pipeline = new CamPipeline(
      {
        cameraId: "cam_test",
        mode: "stream",
        onSegment: async (seg) => { segments.push(seg); return null; },
      },
      { storageManager: null, segmenters: [new FixedWindowSegmenter(3)] },
    );

    // Feed 7 frames -> expect 2 segments (3+3), 1 frame buffered
    for (let i = 0; i < 7; i++) {
      await pipeline.feedFrame(makeFrame(i * 1000));
    }

    expect(segments).toHaveLength(2);
    expect(segments[0].frames).toHaveLength(3);
    expect(segments[1].frames).toHaveLength(3);
    expect(pipeline.bufferedFrameCount).toBe(1);

    // Force flush remaining
    await pipeline.forceFlush();
    expect(segments).toHaveLength(3);
    expect(segments[2].frames).toHaveLength(1);
  });

  it("event watch: manual flush on stop", async () => {
    const segments: any[] = [];
    const pipeline = new CamPipeline(
      {
        cameraId: "cam_test",
        mode: "event",
        onSegment: async (seg) => { segments.push(seg); return null; },
      },
      { storageManager: null, segmenters: [] },
    );

    // Simulate event: 4 frames, then stop
    for (let i = 0; i < 4; i++) {
      await pipeline.feedFrame(makeFrame(i * 500));
    }
    expect(segments).toHaveLength(0); // no auto-cut for event mode without segmenter

    await pipeline.forceFlush();
    expect(segments).toHaveLength(1);
    expect(segments[0].frames).toHaveLength(4);
    expect(segments[0].mode).toBe("event");
    expect(segments[0].duration_sec).toBeCloseTo(1.5, 1);
  });
});
