import { describe, it, expect, vi } from "vitest";
import { CamPipeline } from "../pipeline.js";
import { FixedWindowSegmenter } from "../segmenter/fixed-window.js";
import type { FrameResult } from "../types.js";
import type { Segment } from "@cortex/shared";

function makeFrame(ts = Date.now()): FrameResult {
  return { data: "base64", timestamp: ts, source_name: "test" };
}

describe("CamPipeline _trace", () => {
  it("snapshot mode: attaches _trace with wall-clock first_frame_at and segment_built_at", async () => {
    const onSegment = vi.fn().mockResolvedValue(null);

    const pipeline = new CamPipeline(
      { cameraId: "cam", mode: "snapshot", onSegment },
      { storageManager: null, segmenters: [] },
    );

    const before = Date.now();
    await pipeline.feedFrame(makeFrame(1700000000000));
    const after = Date.now();

    expect(onSegment).toHaveBeenCalledTimes(1);
    const seg: Segment = onSegment.mock.calls[0][0];
    expect(seg._trace).toBeDefined();
    // first_frame_at uses wall-clock time (Date.now()), not frame.timestamp
    expect(seg._trace!.first_frame_at).toBeGreaterThanOrEqual(before);
    expect(seg._trace!.first_frame_at).toBeLessThanOrEqual(after);
    expect(seg._trace!.segment_built_at).toBeGreaterThanOrEqual(before);
  });

  it("stream mode: attaches _trace with wall-clock first_frame_at", async () => {
    const onSegment = vi.fn().mockResolvedValue(null);

    const pipeline = new CamPipeline(
      { cameraId: "cam", mode: "stream", onSegment },
      { storageManager: null, segmenters: [new FixedWindowSegmenter(3)] },
    );

    const before = Date.now();
    await pipeline.feedFrame(makeFrame(1000));
    await pipeline.feedFrame(makeFrame(2000));
    await pipeline.feedFrame(makeFrame(3000)); // triggers cut

    expect(onSegment).toHaveBeenCalledTimes(1);
    const seg: Segment = onSegment.mock.calls[0][0];
    expect(seg._trace).toBeDefined();
    expect(seg._trace!.first_frame_at).toBeGreaterThanOrEqual(before);
    expect(seg._trace!.first_frame_at).toBeLessThanOrEqual(Date.now());
  });

  it("forceFlush attaches _trace", async () => {
    const onSegment = vi.fn().mockResolvedValue(null);

    const pipeline = new CamPipeline(
      { cameraId: "cam", mode: "event", onSegment },
      { storageManager: null, segmenters: [new FixedWindowSegmenter(100)] },
    );

    const before = Date.now();
    await pipeline.feedFrame(makeFrame(5000));
    await pipeline.feedFrame(makeFrame(6000));
    await pipeline.forceFlush();

    const seg: Segment = onSegment.mock.calls[0][0];
    expect(seg._trace).toBeDefined();
    expect(seg._trace!.first_frame_at).toBeGreaterThanOrEqual(before);
    expect(seg._trace!.first_frame_at).toBeLessThanOrEqual(Date.now());
    expect(seg._trace!.segment_built_at).toBeGreaterThan(0);
  });

  it("resets firstFrameTime between segments", async () => {
    const onSegment = vi.fn().mockResolvedValue(null);

    const pipeline = new CamPipeline(
      { cameraId: "cam", mode: "snapshot", onSegment },
      { storageManager: null, segmenters: [] },
    );

    const before = Date.now();
    await pipeline.feedFrame(makeFrame(1000));
    await pipeline.feedFrame(makeFrame(2000));

    const seg1: Segment = onSegment.mock.calls[0][0];
    const seg2: Segment = onSegment.mock.calls[1][0];
    // Both should be wall-clock times, second >= first
    expect(seg1._trace!.first_frame_at).toBeGreaterThanOrEqual(before);
    expect(seg2._trace!.first_frame_at).toBeGreaterThanOrEqual(seg1._trace!.first_frame_at);
  });
});
