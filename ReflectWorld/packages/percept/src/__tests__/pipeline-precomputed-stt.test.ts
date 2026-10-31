// packages/percept/src/__tests__/pipeline-precomputed-stt.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { analyze, type PipelineDeps } from "../pipeline.js";
import { WorkingMemoryManager } from "../working-memory.js";
import { StrategyManager } from "../strategy-manager.js";
import type { Segment } from "@reflectworld/shared";
import type { SttOutput, VlmOutput } from "../types.js";

// Follows existing pipeline.test.ts pattern: hand-built minimal PipelineDeps,
// no createPipelineDeps/resolvePerceptionConfig to avoid model/router init.

function makeSegment(): Segment {
  return {
    segment_id: "seg_srt_test",
    camera_id: "cam_test",
    mode: "stream",
    frames: [{ data: "base64_0", timestamp: 1_000_000, index: 0 }],
    raw_url: "",
    timestamp: 1_000_000,
    duration_sec: 15,
  };
}

const MOCK_VLM_OUTPUT: VlmOutput = {
  summary: "A person talking.",
  detailed_summary: "A person talking on screen.",
  security_risk: false,
  is_static_scene: false,
  notify_user: false,
  main_targets: [],
  raw_response: "{}",
};

describe("precomputedStt integration", () => {
  let deps: PipelineDeps;
  let capturedSttTranscript: string | undefined;

  beforeEach(() => {
    capturedSttTranscript = undefined;

    const mockVlmAnalyzer = {
      analyzeSegment: vi.fn(async (_frames: unknown, _model: unknown, options: any) => {
        capturedSttTranscript = options?.localModelResults?.sttTranscript;
        return {
          normalizedJson: "{}",
          output: MOCK_VLM_OUTPUT,
          latency_ms: 100,
        };
      }),
    };

    const mockMediaUploader = {
      saveKeyframe: vi.fn().mockReturnValue("/keyframe.jpg"),
    };

    deps = {
      workingMemory: new WorkingMemoryManager({ event_timeout_sec: 30 }),
      strategyManager: new StrategyManager({ stubsOnly: true }),
      vlmAnalyzer: mockVlmAnalyzer as unknown as import("../analyzers/vlm-analyzer.js").VlmAnalyzer,
      mediaUploader: mockMediaUploader as unknown as import("../media-uploader.js").MediaUploader,
    };
  });

  it("passes precomputed transcript to VLM and populates result fields", async () => {
    const sttOutput: SttOutput = {
      transcript: "hello from subtitles",
      segments: [{ start: 16000, end: 48000, text: "hello from subtitles", latency_ms: 0 }],
    };
    deps.precomputedStt = () => sttOutput;

    const result = await analyze(makeSegment(), deps);

    // STT transcript reached VLM prompt
    expect(capturedSttTranscript).toBeDefined();
    expect(capturedSttTranscript).toContain("hello from subtitles");

    // result.transcript populated
    expect(result.transcript).toBe("hello from subtitles");

    // dialogue fallback: unknown speaker (same as Moonshine no-diarization path)
    expect(result.dialogue).toBeDefined();
    expect(result.dialogue!.length).toBeGreaterThan(0);
    expect(result.dialogue![0]!.identity_level).toBe("unknown");
    expect(result.dialogue![0]!.text).toBe("hello from subtitles");
  });

  it("empty precomputed transcript does not set sttFailed", async () => {
    deps.precomputedStt = () => ({ transcript: "", segments: [] });

    const result = await analyze(makeSegment(), deps);

    // VLM should still run (not blocked by sttFailed)
    expect(result.perception_memory.summary).toBeTruthy();
    // transcript stays empty — no phantom text
    expect(result.transcript).toBeUndefined();
  });
});
