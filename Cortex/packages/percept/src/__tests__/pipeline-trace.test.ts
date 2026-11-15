import { describe, it, expect, vi, beforeEach } from "vitest";
import { analyze, type PipelineDeps } from "../pipeline.js";
import { WorkingMemoryManager } from "../working-memory.js";
import { StrategyManager } from "../strategy-manager.js";
import { monitorBus } from "@cortex/shared";
import type { Segment, PipelineTrace } from "@cortex/shared";
import type { VlmOutput } from "../types.js";

function makeSegment(mode: Segment["mode"], frameCount: number): Segment {
  return {
    segment_id: "seg_trace_001",
    camera_id: "cam_front",
    mode,
    frames: Array.from({ length: frameCount }, (_, i) => ({
      data: `base64_${i}`,
      timestamp: 1_000_000 + i * 1000,
      index: i,
    })),
    raw_url: "/raw/seg_trace_001.jpg",
    timestamp: 1_000_000,
    duration_sec: frameCount === 1 ? 0 : frameCount,
  };
}

const MOCK_VLM_OUTPUT: VlmOutput = {
  summary: "A person at the door.",
  detailed_summary: "A person at the door wearing a jacket.",
  security_risk: false,
  is_static_scene: false,
  notify_user: false,
  main_targets: [{ type: "person", appearance: "jacket", behavior: "standing" }],
  raw_response: "{}",
};

const MOCK_VLM_RESULT = {
  normalizedJson: MOCK_VLM_OUTPUT.raw_response,
  output: MOCK_VLM_OUTPUT,
  latency_ms: 300,
};

describe("analyze pipeline — profiling trace", () => {
  let deps: PipelineDeps;
  let mockVlmAnalyzer: { analyzeSegment: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockVlmAnalyzer = {
      analyzeSegment: vi.fn().mockResolvedValue(MOCK_VLM_RESULT),
    };

    deps = {
      workingMemory: new WorkingMemoryManager({ event_timeout_sec: 30 }),
      strategyManager: new StrategyManager({ stubsOnly: true }),
      vlmAnalyzer: mockVlmAnalyzer as any,
      mediaUploader: {
        saveKeyframe: vi.fn().mockReturnValue("/media/keyframe.jpg"),
      } as any,
    };
  });

  it("attaches _trace to PerceptionResult", async () => {
    const segment = makeSegment("snapshot", 1);
    const result = await analyze(segment, deps);

    expect(result._trace).toBeDefined();
    expect(result._trace!.segment_id).toBe("seg_trace_001");
    expect(result._trace!.camera_id).toBe("cam_front");
  });

  it("trace contains valid timestamps", async () => {
    const segment = makeSegment("snapshot", 1);
    const result = await analyze(segment, deps);
    const trace = result._trace!;

    expect(trace.timestamps.analysis_started_at).toBeGreaterThan(0);
    expect(trace.timestamps.analysis_completed_at).toBeGreaterThanOrEqual(trace.timestamps.analysis_started_at);
  });

  it("trace contains valid latencies", async () => {
    const segment = makeSegment("snapshot", 1);
    const result = await analyze(segment, deps);
    const trace = result._trace!;

    expect(trace.latencies.perception_ms).toBeGreaterThanOrEqual(0);
    expect(trace.latencies.e2e_ms).toBeGreaterThanOrEqual(0);
  });

  it("trace context reflects segment metadata", async () => {
    const segment = makeSegment("event", 3);
    const result = await analyze(segment, deps);
    const trace = result._trace!;

    expect(trace.context.mode).toBe("event");
    expect(trace.context.level).toBe(0);
    expect(trace.context.frame_count).toBe(3);
    expect(trace.context.analyzers_run).toContain("vlm");
  });

  it("emits system:pipeline_trace event via monitorBus", async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const listener = (evt: { type: string; data: Record<string, unknown> }) => {
      if (evt.type === "system:pipeline_trace") events.push(evt);
    };
    monitorBus.on("monitor", listener);

    const segment = makeSegment("snapshot", 1);
    await analyze(segment, deps);

    monitorBus.removeListener("monitor", listener);
    expect(events).toHaveLength(1);
    expect((events[0]!.data as unknown as PipelineTrace).segment_id).toBe("seg_trace_001");
  });

  it("uses segment._trace timestamps when available", async () => {
    const segment = makeSegment("snapshot", 1);
    segment._trace = {
      first_frame_at: 900_000,
      segment_built_at: 950_000,
    };

    const result = await analyze(segment, deps);
    const trace = result._trace!;

    expect(trace.timestamps.first_frame_at).toBe(900_000);
    expect(trace.timestamps.segment_built_at).toBe(950_000);
    expect(trace.latencies.accumulation_ms).toBe(50_000);
  });

  it("vlm_analyze_ms is populated from analyzer results", async () => {
    const segment = makeSegment("snapshot", 1);
    const result = await analyze(segment, deps);
    const trace = result._trace!;

    expect(trace.latencies.vlm_analyze_ms).toBe(300);
    expect(trace.timestamps.vlm_stage_started_at).toBeGreaterThanOrEqual(trace.timestamps.analysis_started_at);
    expect(trace.timestamps.vlm_analyze_started_at).toBeGreaterThanOrEqual(trace.timestamps.vlm_stage_started_at!);
    expect(trace.timestamps.vlm_analyze_completed_at).toBeGreaterThanOrEqual(trace.timestamps.vlm_analyze_started_at!);
  });
});
