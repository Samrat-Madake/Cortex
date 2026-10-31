// tests/integration/perception-pipeline-l0.test.ts
// E2E: Level 0 pipeline with real WorkingMemory, real StrategyManager,
// real MediaUploader (filesystem-backed), only VLM mocked.
import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import { analyze } from "../../packages/percept/src/pipeline.js";
import { createE2eDeps, makeSegment, MOCK_VLM_OUTPUT } from "./helpers.js";

describe("E2E: Perception Pipeline Level 0", () => {
  const { deps, mediaSaver, mockVlm } = createE2eDeps();

  afterAll(() => {
    mediaSaver.cleanup();
  });

  it("produces a valid PerceptionResult from a real JPEG segment", async () => {
    const segment = makeSegment("snapshot", "cam_e2e_1", 1);
    const result = await analyze(segment, deps);

    // Core identity fields
    expect(result.segment_id).toBe(segment.segment_id);
    expect(result.camera_id).toBe("cam_e2e_1");
    expect(result.mode).toBe("snapshot");
    expect(result.event_id).toMatch(/^evt_cam_e2e_1_\d+$/);

    // PerceptionMemory shape
    expect(result.perception_memory.summary).toBe(MOCK_VLM_OUTPUT.summary);
    expect(result.perception_memory.detailed_summary).toBe(MOCK_VLM_OUTPUT.detailed_summary);
    expect(result.perception_memory.security_risk).toBe(false);
    expect(result.perception_memory.perception_level).toBe(0);
    expect(result.perception_memory.strategy_context).toContain("level0");
    expect(result.perception_memory.timestamp).toBe(segment.timestamp);
    expect(result.camera_id).toBe("cam_e2e_1");

    // Entities mapped from VLM main_targets
    expect(result.perception_memory.entities).toHaveLength(1);
    expect(result.perception_memory.entities![0]).toMatchObject({
      type: "person",
      appearance: "blue jacket",
    });
  });

  it("saves keyframe to disk and populates media_urls", async () => {
    const segment = makeSegment("event", "cam_e2e_1", 3);
    const result = await analyze(segment, deps);

    // media_urls structure
    expect(result.media_urls.raw).toBe(segment.raw_url);
    expect(result.media_urls.keyframes).toHaveLength(1);
    expect(result.media_urls.crops).toEqual([]);

    // Keyframe actually exists on disk and is a valid JPEG
    const keyframePath = result.media_urls.keyframes[0]!;
    expect(fs.existsSync(keyframePath)).toBe(true);
    const keyframeData = fs.readFileSync(keyframePath);
    // JPEG magic bytes: 0xFF 0xD8
    expect(keyframeData[0]).toBe(0xff);
    expect(keyframeData[1]).toBe(0xd8);
    expect(keyframeData.length).toBeGreaterThan(100);
  });

  it("VLM receives real base64 JPEG data (not fake strings)", async () => {
    const segment = makeSegment("snapshot", "cam_e2e_vlm", 1);
    await analyze(segment, deps);

    // VLM analyzer was called with the frames containing real base64
    const [frames] = mockVlm.analyze.mock.calls.at(-1)!;
    expect(frames).toHaveLength(1);
    const frameData = Buffer.from(frames[0].data, "base64");
    // Valid JPEG starts with 0xFF 0xD8
    expect(frameData[0]).toBe(0xff);
    expect(frameData[1]).toBe(0xd8);
  });

  it("assigns same event_id to segments within same event window", async () => {
    const seg1 = makeSegment("event", "cam_e2e_multi", 2);
    const seg2 = makeSegment("event", "cam_e2e_multi", 2);

    const r1 = await analyze(seg1, deps);
    const r2 = await analyze(seg2, deps);

    expect(r1.event_id).toBe(r2.event_id);
    expect(r1.event_id).toMatch(/^evt_cam_e2e_multi_/);
  });

  it("accumulates scene context — second segment receives prior summary", async () => {
    const seg1 = makeSegment("stream", "cam_e2e_ctx", 2);
    const seg2 = makeSegment("stream", "cam_e2e_ctx", 2);

    await analyze(seg1, deps);
    mockVlm.analyze.mockClear();
    await analyze(seg2, deps);

    // VLM was called with scene context containing the prior summary
    const [, , options] = mockVlm.analyze.mock.calls[0]!;
    const recentSummaries = options?.recentSegmentSummaries?.join("\n");
    expect(recentSummaries).toContain(MOCK_VLM_OUTPUT.detailed_summary);
  });

  it("emits a PipelineTrace with valid timestamps", async () => {
    const segment = makeSegment("snapshot", "cam_e2e_trace", 1);
    const result = await analyze(segment, deps);

    expect(result._trace).toBeDefined();
    const trace = result._trace!;

    // Core fields
    expect(trace.segment_id).toBe(segment.segment_id);
    expect(trace.camera_id).toBe("cam_e2e_trace");

    // Timestamps are valid numbers and ordered
    expect(trace.timestamps.analysis_started_at).toBeGreaterThan(0);
    expect(trace.timestamps.analysis_completed_at).toBeGreaterThanOrEqual(
      trace.timestamps.analysis_started_at,
    );

    // Context matches Level 0
    expect(trace.context.level).toBe(0);
    expect(trace.context.mode).toBe("snapshot");
    expect(trace.context.frame_count).toBe(1);
    expect(trace.context.analyzers_run).toContain("vlm");

    // Latencies are non-negative
    expect(trace.latencies.perception_ms).toBeGreaterThanOrEqual(0);
    expect(trace.latencies.e2e_ms).toBeGreaterThanOrEqual(0);
  });
});
