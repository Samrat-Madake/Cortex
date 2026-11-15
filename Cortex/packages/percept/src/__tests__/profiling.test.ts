import { describe, expect, it } from "vitest";
import { PipelineProfiler } from "../profiling.js";

describe("PipelineProfiler", () => {
  it("records stage start/end timestamps and latencies from explicit module boundaries", () => {
    const profiler = new PipelineProfiler();

    profiler.start("stt", 1_000);
    profiler.end("stt", { now: 1_250, latencyMs: 240 });

    profiler.start("vlm_stage", 2_000);
    profiler.start("vlm_analyze", 2_120);
    profiler.end("vlm_analyze", { now: 2_920, latencyMs: 780 });
    profiler.end("vlm_stage", { now: 3_000 });

    expect(profiler.traceTimestamps()).toMatchObject({
      stt_started_at: 1_000,
      stt_completed_at: 1_250,
      vlm_stage_started_at: 2_000,
      vlm_analyze_started_at: 2_120,
      vlm_analyze_completed_at: 2_920,
      vlm_completed_at: 3_000,
    });
    expect(profiler.traceLatencies()).toMatchObject({
      stt_ms: 240,
      vlm_ms: 1_000,
      vlm_prep_ms: 120,
      vlm_analyze_ms: 780,
      vlm_finalize_ms: 80,
    });
  });
});
