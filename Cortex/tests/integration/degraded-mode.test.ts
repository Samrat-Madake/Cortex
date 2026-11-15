// E2E: Degraded mode — pipeline behavior when components fail or are absent
import { describe, it, expect, vi } from "vitest";
import { analyze } from "../../packages/percept/src/pipeline.js";
import { createE2eDeps, makeSegment, MOCK_VLM_OUTPUT } from "./helpers.js";
import type { Segment, Frame } from "@cortex/shared";

describe("E2E: degraded mode", () => {
  it("pipeline completes when VLM rejects", async () => {
    const { deps, mediaSaver, mockVlm } = createE2eDeps();

    // Override VLM to reject
    mockVlm.analyze.mockRejectedValue(new Error("VLM service unavailable"));

    const segment = makeSegment("stream", "degraded-cam1", 3);

    try {
      const result = await analyze(segment, deps);
      // Pipeline should still return a result even if VLM fails
      expect(result).toBeDefined();
      expect(result.segment_id).toBe(segment.segment_id);
      expect(result.camera_id).toBe("degraded-cam1");
    } finally {
      mediaSaver.cleanup();
    }
  });

  it("level 0 strategy selected when no local models installed", async () => {
    const { deps, mediaSaver } = createE2eDeps();

    // StrategyManager with stubsOnly:true → maxLevel=0 → level 0
    const segment = makeSegment("snapshot", "degraded-cam2", 1);

    try {
      const result = await analyze(segment, deps);
      expect(result).toBeDefined();
      expect(result.perception_memory.perception_level).toBe(0);
      // VLM should still produce a summary at level 0
      expect(result.perception_memory.summary).toBeTruthy();
    } finally {
      mediaSaver.cleanup();
    }
  });

  it("single-frame snapshot produces valid result", async () => {
    const { deps, mediaSaver } = createE2eDeps();

    // Single real JPEG frame — verifies minimum input works
    const segment = makeSegment("snapshot", "degraded-cam3", 1);
    expect(segment.frames.length).toBe(1);

    try {
      const result = await analyze(segment, deps);
      expect(result).toBeDefined();
      expect(result.segment_id).toBe(segment.segment_id);
      expect(result.perception_memory.perception_level).toBe(0);
    } finally {
      mediaSaver.cleanup();
    }
  });

  it("memory write failure does not crash pipeline", async () => {
    const { deps, mediaSaver } = createE2eDeps();

    // Attach a failing memory adapter.
    const storePerception = vi.fn().mockRejectedValue(new Error("Memory service down"));
    deps.memory = {
      ...deps.memory,
      storePerception,
    };
    deps.postProcessor = {
      sendNotifications: vi.fn().mockResolvedValue(undefined),
    };

    const segment = makeSegment("stream", "degraded-cam4", 2);

    try {
      const result = await analyze(segment, deps);
      // Pipeline should return perception result regardless of memory failure
      expect(result).toBeDefined();
      expect(result.perception_memory).toBeDefined();
      // storePerception was called even though it failed.
      expect(storePerception).toHaveBeenCalled();
    } finally {
      mediaSaver.cleanup();
    }
  });

  it("pipeline handles zero frames — VLM receives empty array", async () => {
    const { deps, mediaSaver, mockVlm } = createE2eDeps();

    // Build a segment with zero frames — simulates a degenerate cut
    const segment: Segment = {
      segment_id: `seg_zero_${Date.now()}`,
      camera_id: "degraded-cam-zero",
      mode: "stream",
      frames: [],
      raw_url: "/tmp/raw/zero.mp4",
      timestamp: Date.now(),
      duration_sec: 0,
    };

    try {
      const result = await analyze(segment, deps);
      // Pipeline should still complete — VLM mock returns a valid result
      expect(result).toBeDefined();
      expect(result.segment_id).toBe(segment.segment_id);
      // VLM was called (even with zero frames)
      expect(mockVlm.analyze).toHaveBeenCalled();
      // No keyframes saved since there were no frames
      expect(result.media_urls.keyframes).toHaveLength(0);
    } finally {
      mediaSaver.cleanup();
    }
  });

  it("pipeline handles corrupt base64 frame data — VLM still called", async () => {
    const { deps, mediaSaver, mockVlm } = createE2eDeps();

    // Frames with invalid base64 that won't decode to valid JPEG
    const corruptFrame: Frame = {
      data: "not-valid-base64-jpeg-data!!!",
      timestamp: Date.now(),
      index: 0,
    };
    const segment: Segment = {
      segment_id: `seg_corrupt_${Date.now()}`,
      camera_id: "degraded-cam-corrupt",
      mode: "snapshot",
      frames: [corruptFrame],
      raw_url: "/tmp/raw/corrupt.mp4",
      timestamp: Date.now(),
      duration_sec: 0,
    };

    try {
      const result = await analyze(segment, deps);
      // Pipeline should complete — mock VLM doesn't validate frame data
      expect(result).toBeDefined();
      expect(result.segment_id).toBe(segment.segment_id);
      expect(mockVlm.analyze).toHaveBeenCalled();
      // The corrupt data is passed through — real VLM would reject it
      const callArgs = mockVlm.analyze.mock.calls[0]!;
      expect(callArgs[0]).toHaveLength(1);
      expect(callArgs[0][0].data).toBe("not-valid-base64-jpeg-data!!!");
    } finally {
      mediaSaver.cleanup();
    }
  });

  it("notification failure does not crash pipeline — isolated via fire-and-forget", async () => {
    const { deps, mediaSaver } = createE2eDeps({
      vlmOutput: {
        ...MOCK_VLM_OUTPUT,
        notify_user: true,
        security_risk: true,
      },
    });

    const errorSpy = vi.fn();
    deps.memory = {
      ...deps.memory,
      storePerception: vi.fn().mockResolvedValue(undefined),
    };
    deps.postProcessor = {
      sendNotifications: vi.fn().mockRejectedValue(new Error("Push service down")),
      onPipelineError: errorSpy,
    };

    const segment = makeSegment("stream", "degraded-cam5", 2);

    try {
      // Pipeline should complete successfully despite notification failure
      const result = await analyze(segment, deps);
      expect(result).toBeDefined();
      expect(result.segment_id).toBe(segment.segment_id);
      // Wait for the fire-and-forget notification to settle
      await new Promise((r) => setTimeout(r, 50));
      expect(errorSpy).toHaveBeenCalledWith(
        segment.segment_id, "degraded-cam5", "notification", expect.stringContaining("Push service down"),
      );
    } finally {
      mediaSaver.cleanup();
    }
  });
});
