import { describe, expect, it, vi } from "vitest";

const runVideoPipelineMock = vi.hoisted(() => vi.fn());

vi.mock("../../eval/benchmark/pipeline/video-pipeline.js", () => ({
  runVideoPipeline: runVideoPipelineMock,
}));

import { runSessionPipeline } from "../../eval/benchmark/pipeline/session-pipeline.js";

describe("runSessionPipeline", () => {
  it("applies clip duration to the video pipeline and checkpoint window", async () => {
    runVideoPipelineMock.mockResolvedValue({
      segmentCount: 1,
      segmentResults: [],
      capturedCheckpointIds: [],
      memoryBarrier: Promise.resolve(),
    });

    await runSessionPipeline({
      clips: [
        { path: "/tmp/clip-a.mp4", mediaStartMs: 10_000, mediaDurationMs: 5_000 },
        { path: "/tmp/clip-b.mp4", mediaStartMs: 20_000 },
      ],
      checkpoints: [
        { id: "during_clip_a", mediaTimeMs: 12_000 },
        { id: "after_clip_a", mediaTimeMs: 18_000 },
      ],
      cameraId: "cam_test",
      userId: "user_test",
      fps: 1,
      framesPerSegment: 15,
      maxDurationSec: 10,
      outputDir: "/tmp/out",
      pipelineDeps: {},
      memClient: {},
    } as any);

    expect(runVideoPipelineMock).toHaveBeenCalledTimes(2);
    expect(runVideoPipelineMock.mock.calls[0][0]).toMatchObject({
      videoPath: "/tmp/clip-a.mp4",
      mediaTimeOffsetMs: 10_000,
      maxDurationSec: 5,
      captureRemainingCheckpointsUntilMs: 20_000,
      finalizeNarrative: false,
    });
    expect(runVideoPipelineMock.mock.calls[1][0]).toMatchObject({
      videoPath: "/tmp/clip-b.mp4",
      mediaTimeOffsetMs: 20_000,
      maxDurationSec: 10,
      finalizeNarrative: true,
    });
  });
});
