import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { analyze, type PipelineDeps } from "../pipeline.js";
import { WorkingMemoryManager } from "../working-memory.js";
import { StrategyManager } from "../strategy-manager.js";
import type { Segment } from "@reflectworld/shared";
import type { VlmOutput } from "../types.js";

function makeSegment(overrides?: Partial<Segment>): Segment {
  return {
    segment_id: "seg_test_001",
    camera_id: "cam_test",
    mode: "stream",
    frames: Array.from({ length: 3 }, (_, i) => ({
      data: `base64_${i}`,
      timestamp: 1_000_000 + i * 1000,
      index: i,
    })),
    raw_url: "",
    timestamp: 1_000_000,
    duration_sec: 3,
    ...overrides,
  };
}

function makeVlmResult(overrides?: Partial<VlmOutput>) {
  const output = {
    summary: "Test summary", detailed_summary: "", security_risk: false,
    is_static_scene: false, notify_user: false, main_targets: [],
    raw_response: "{}", ...overrides,
  } satisfies VlmOutput;
  return {
    normalizedJson: output.raw_response ?? JSON.stringify(output),
    output,
    latency_ms: 100,
  };
}

describe("Pipeline adaptive perception", () => {
  let deps: PipelineDeps;
  let mockVlmAnalyzer: { analyzeSegment: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockVlmAnalyzer = { analyzeSegment: vi.fn() };
    deps = {
      workingMemory: new WorkingMemoryManager({ event_timeout_sec: 30 }),
      strategyManager: new StrategyManager({ stubsOnly: true }),
      vlmAnalyzer: mockVlmAnalyzer as any,
      mediaUploader: { saveKeyframe: vi.fn().mockReturnValue("/keyframe.jpg") } as any,
    };
  });

  it("propagates content_type and key_modality to custom_fields", async () => {
    mockVlmAnalyzer.analyzeSegment.mockResolvedValue(
      makeVlmResult({ content_type: "lecture", key_modality: "audio" }),
    );
    const result = await analyze(makeSegment(), deps);
    expect(result.perception_memory.custom_fields?.content_type).toBe("lecture");
    expect(result.perception_memory.custom_fields?.key_modality).toBe("audio");
  });

  it("event_boundary=true switches event_id for current segment", async () => {
    // Segments carry their own timestamp — switchEvent derives the new event_id from it.
    // Use distinct segment timestamps so the boundary switch produces a different id.
    mockVlmAnalyzer.analyzeSegment.mockResolvedValue(makeVlmResult({ event_boundary: false }));
    const r1 = await analyze(makeSegment({ segment_id: "seg_001", timestamp: 1_000_000 }), deps);
    const r2 = await analyze(makeSegment({ segment_id: "seg_002", timestamp: 1_001_000 }), deps);
    expect(r2.event_id).toBe(r1.event_id);

    mockVlmAnalyzer.analyzeSegment.mockResolvedValue(makeVlmResult({ event_boundary: true }));
    const r3 = await analyze(makeSegment({ segment_id: "seg_003", timestamp: 1_002_000 }), deps);
    expect(r3.event_id).not.toBe(r1.event_id);
  });

  it("force-rotates events when the max segment count is reached", async () => {
    deps.workingMemory = new WorkingMemoryManager({ event_timeout_sec: 30, max_event_segments: 2 });
    mockVlmAnalyzer.analyzeSegment.mockResolvedValue(makeVlmResult({ event_boundary: false }));

    const r1 = await analyze(makeSegment({ segment_id: "seg_001", timestamp: 1_000_000 }), deps);
    const r2 = await analyze(makeSegment({ segment_id: "seg_002", timestamp: 1_001_000 }), deps);
    const r3 = await analyze(makeSegment({ segment_id: "seg_003", timestamp: 1_002_000 }), deps);

    expect(r2.event_id).toBe(r1.event_id);
    expect(r3.event_id).not.toBe(r1.event_id);
    expect(r3._trace?.context.decision_context?.event_boundary).toMatchObject({
      requested: true,
      applied: true,
      old_event_id: r1.event_id,
      new_event_id: r3.event_id,
      reason: "max_event_segments",
    });
  });

  it("does not label timeout rotation as max segment rotation", async () => {
    deps.workingMemory = new WorkingMemoryManager({ event_timeout_sec: 1, max_event_segments: 2 });
    mockVlmAnalyzer.analyzeSegment.mockResolvedValue(makeVlmResult({ event_boundary: false }));

    const r1 = await analyze(makeSegment({ segment_id: "seg_001", timestamp: 1_000_000 }), deps);
    const r2 = await analyze(makeSegment({ segment_id: "seg_002", timestamp: 1_000_500 }), deps);
    const r3 = await analyze(makeSegment({ segment_id: "seg_003", timestamp: 1_002_000 }), deps);

    expect(r2.event_id).toBe(r1.event_id);
    expect(r3.event_id).not.toBe(r1.event_id);
    expect(r3._trace?.context.decision_context?.event_boundary?.reason).not.toBe("max_event_segments");
  });

  it("filters idle VAD hits through STT before running VLM", async () => {
    const l1Deps: PipelineDeps = {
      ...deps,
      strategyManager: new StrategyManager({ stubsOnly: false }),
      visionControllerEnabled: false,
      sttAnalyzer: {
        isAvailable: true,
        transcribe: vi.fn().mockReturnValue({ transcript: "", segments: [], latency_ms: 1 }),
      } as any,
    };
    mockVlmAnalyzer.analyzeSegment.mockResolvedValue(makeVlmResult({ summary: "Narration" }));
    const segment = makeSegment({
      event_hint: "idle_window",
      audio_segments: [{ start: 0, samples: new Float32Array(100) }],
    });
    const result = await analyze(segment, l1Deps);
    expect(l1Deps.sttAnalyzer?.transcribe).toHaveBeenCalled();
    expect(mockVlmAnalyzer.analyzeSegment).not.toHaveBeenCalled();
    expect(result.perception_memory.summary).toBe("Static scene — no activity detected.");
    expect(result._trace?.context.decision_context?.vlm_gate?.reason).toBe("idle_audio_without_stt_content");

    mockVlmAnalyzer.analyzeSegment.mockClear();
    (l1Deps.sttAnalyzer as any).transcribe.mockReturnValue({
      transcript: "someone is speaking",
      segments: [{ start: 0, end: 100, text: "someone is speaking", latency_ms: 1 }],
      latency_ms: 1,
    });
    const speechResult = await analyze({
      ...segment,
      segment_id: "seg_idle_speech",
      timestamp: segment.timestamp + 1000,
    }, l1Deps);
    expect(mockVlmAnalyzer.analyzeSegment).toHaveBeenCalled();
    expect(speechResult.perception_memory.summary).toBe("Narration");
    expect(speechResult._trace?.context.decision_context?.vlm_gate?.reason).toBe("audio_content");

    mockVlmAnalyzer.analyzeSegment.mockClear();
    const silentSegment = makeSegment({ event_hint: "idle_window" });
    const silentResult = await analyze(silentSegment, l1Deps);
    expect(silentResult.perception_memory.summary).toBe("Static scene — no activity detected.");
    expect(silentResult.perception_memory.is_static_scene).toBe(true);
    expect(mockVlmAnalyzer.analyzeSegment).not.toHaveBeenCalled();
  });

  it("STT failure does not skip VLM — audio content is unverified", async () => {
    // ElevenLabs STT rejects → sttFailed=true → idle gate must NOT skip VLM
    const failingStt = {
      isAvailable: true,
      transcribe: vi.fn().mockImplementation(() => { throw new Error("ElevenLabs 429"); }),
      transcribeAudioData: vi.fn().mockRejectedValue(new Error("ElevenLabs 429")),
    };
    const failDeps: PipelineDeps = {
      ...deps,
      strategyManager: new StrategyManager({ stubsOnly: false }),
      visionControllerEnabled: false,
      elevenLabsStt: failingStt as any,
    };
    mockVlmAnalyzer.analyzeSegment.mockResolvedValue(makeVlmResult({ summary: "Person talking" }));
    const segment = makeSegment({
      event_hint: "idle_window",
      audio_data: {
        pcm: Buffer.alloc(3200),  // 100ms of 16kHz s16le
        voice_ranges: [{ start_ms: 0, end_ms: 100 }],
      },
    });
    const result = await analyze(segment, failDeps);
    // VLM should still run because STT failure means audio is unverified
    expect(mockVlmAnalyzer.analyzeSegment).toHaveBeenCalled();
    expect(result._trace?.context.decision_context?.vlm_gate?.reason).toBe("stt_failed_audio_unverified");
  });

  it("does not run STT for snapshot segments even if audio is attached", async () => {
    const sttAnalyzer = {
      isAvailable: true,
      transcribe: vi.fn(),
      transcribeAudioData: vi.fn(),
    };
    const snapshotDeps: PipelineDeps = {
      ...deps,
      sttAnalyzer: sttAnalyzer as any,
    };
    mockVlmAnalyzer.analyzeSegment.mockResolvedValue(makeVlmResult({ summary: "Snapshot" }));

    const result = await analyze(makeSegment({
      mode: "snapshot",
      frames: [{ data: "base64_0", timestamp: 1_000_000, index: 0 }],
      duration_sec: 0,
      audio_segments: [{ start: 0, samples: new Float32Array(100) }],
    }), snapshotDeps);

    expect(sttAnalyzer.transcribe).not.toHaveBeenCalled();
    expect(sttAnalyzer.transcribeAudioData).not.toHaveBeenCalled();
    expect(result._trace?.context.analyzers_skipped).toContain("stt:snapshot");
  });

  it("skips VLM for composite idle_window segments even when VisionController is enabled", async () => {
    const l1Deps: PipelineDeps = {
      ...deps,
      strategyManager: new StrategyManager({ stubsOnly: false }),
      visionControllerEnabled: true,
    };
    mockVlmAnalyzer.analyzeSegment.mockResolvedValue(makeVlmResult({ summary: "Bootstrap" }));
    await analyze(makeSegment({ segment_id: "seg_bootstrap" }), l1Deps);
    mockVlmAnalyzer.analyzeSegment.mockClear();

    const result = await analyze(makeSegment({ segment_id: "seg_idle", event_hint: "idle_window" }), l1Deps);

    expect(mockVlmAnalyzer.analyzeSegment).not.toHaveBeenCalled();
    expect(result.perception_memory.summary).toBe("Static scene — no activity detected.");
    expect(result.perception_memory.is_static_scene).toBe(true);
  });

  it("skips VLM for idle vehicle-only segments", async () => {
    const l1Deps: PipelineDeps = {
      ...deps,
      strategyManager: new StrategyManager({ stubsOnly: false }),
      visionControllerEnabled: true,
    };
    mockVlmAnalyzer.analyzeSegment.mockResolvedValue(makeVlmResult({ summary: "Bootstrap" }));
    await analyze(makeSegment({ segment_id: "seg_bootstrap" }), l1Deps);
    mockVlmAnalyzer.analyzeSegment.mockClear();

    const result = await analyze(makeSegment({
      segment_id: "seg_idle_vehicle",
      event_hint: "idle_window",
      frames: Array.from({ length: 3 }, (_, i) => ({
        data: `base64_${i}`,
        timestamp: 1_000_000 + i * 1000,
        index: i,
        detections: [{
          label: "car",
          confidence: 0.9,
          bbox: { x1: 10, y1: 20, x2: 40, y2: 60 },
        }],
      })),
    }), l1Deps);

    expect(mockVlmAnalyzer.analyzeSegment).not.toHaveBeenCalled();
    expect(result.perception_memory.summary).toBe("Static scene — no activity detected.");
    expect(result.perception_memory.is_static_scene).toBe(true);
  });

  it("runs VLM for idle segments with relevant person detections", async () => {
    const l1Deps: PipelineDeps = {
      ...deps,
      strategyManager: new StrategyManager({ stubsOnly: false }),
      visionControllerEnabled: true,
    };
    mockVlmAnalyzer.analyzeSegment.mockResolvedValue(makeVlmResult({ summary: "Bootstrap" }));
    await analyze(makeSegment({ segment_id: "seg_bootstrap" }), l1Deps);
    mockVlmAnalyzer.analyzeSegment.mockClear();
    mockVlmAnalyzer.analyzeSegment.mockResolvedValue(makeVlmResult({
      summary: "Person remains in the scene.",
      main_targets: [{ type: "person", appearance: "dark jacket", behavior: "standing" }],
    }));

    const result = await analyze(makeSegment({
      segment_id: "seg_idle_person",
      event_hint: "idle_window",
      frames: Array.from({ length: 3 }, (_, i) => ({
        data: `base64_${i}`,
        timestamp: 1_000_000 + i * 1000,
        index: i,
        width: 1000,
        height: 1000,
        detections: [{
          label: "person",
          confidence: 0.95,
          bbox: { x1: 100, y1: 100, x2: 300, y2: 500 },
        }],
      })),
    }), l1Deps);

    expect(mockVlmAnalyzer.analyzeSegment).toHaveBeenCalledTimes(1);
    expect(result.perception_memory.summary).toBe("Person remains in the scene.");
    expect(result.perception_memory.is_static_scene).toBe(false);
    expect(result._trace?.context.decision_context?.vlm_gate?.relevant_detection_count).toBe(3);
    expect(result._trace?.context.decision_context?.vlm_gate?.skipped).toBe(false);
    expect(result._trace?.context.decision_context?.vlm_gate?.reason).toBe("relevant_detection");
  });

  it("filters tiny person detections by frame area before idle VLM gate", async () => {
    const l1Deps: PipelineDeps = {
      ...deps,
      strategyManager: new StrategyManager({ stubsOnly: false }),
      visionControllerEnabled: true,
    };
    mockVlmAnalyzer.analyzeSegment.mockResolvedValue(makeVlmResult({ summary: "Bootstrap" }));
    await analyze(makeSegment({ segment_id: "seg_bootstrap" }), l1Deps);
    mockVlmAnalyzer.analyzeSegment.mockClear();

    const result = await analyze(makeSegment({
      segment_id: "seg_idle_tiny_person",
      event_hint: "idle_window",
      frames: Array.from({ length: 3 }, (_, i) => ({
        data: `base64_${i}`,
        timestamp: 1_000_000 + i * 1000,
        index: i,
        width: 1000,
        height: 1000,
        detections: [{
          label: "person",
          confidence: 0.95,
          bbox: { x1: 10, y1: 10, x2: 40, y2: 40 },
        }],
      })),
    }), l1Deps);

    expect(mockVlmAnalyzer.analyzeSegment).not.toHaveBeenCalled();
    expect(result.perception_memory.is_static_scene).toBe(true);
    expect(result._trace?.context.decision_context?.detection_filter?.person_area_filtered_count).toBe(3);
    expect(result._trace?.context.decision_context?.vlm_gate?.relevant_detection_count).toBe(0);
    expect(result._trace?.context.decision_context?.vlm_gate?.skipped).toBe(true);
  });

  it("does not store memory for VLM-skipped idle segments", async () => {
    const storePerception = vi.fn().mockResolvedValue(undefined);
    const l1Deps: PipelineDeps = {
      ...deps,
      strategyManager: new StrategyManager({ stubsOnly: false }),
      visionControllerEnabled: true,
      memory: {
        storePerception,
      },
      postProcessor: {
        sendNotifications: vi.fn(),
      } as any,
    };

    mockVlmAnalyzer.analyzeSegment.mockResolvedValue(makeVlmResult({ summary: "Bootstrap" }));
    await analyze(makeSegment({ segment_id: "seg_bootstrap" }), l1Deps);
    storePerception.mockClear();
    mockVlmAnalyzer.analyzeSegment.mockClear();

    await analyze(makeSegment({ segment_id: "seg_idle", event_hint: "idle_window" }), l1Deps);

    expect(mockVlmAnalyzer.analyzeSegment).not.toHaveBeenCalled();
    expect(storePerception).not.toHaveBeenCalled();
  });

  it("keeps memory history writes as observer by default", async () => {
    let resolveStore!: () => void;
    const storePerception = vi.fn(() => new Promise<void>((resolve) => {
      resolveStore = resolve;
    }));
    const l1Deps: PipelineDeps = {
      ...deps,
      memory: { storePerception },
    };
    mockVlmAnalyzer.analyzeSegment.mockResolvedValue(makeVlmResult({ summary: "Observer memory" }));

    const result = await analyze(makeSegment({ segment_id: "seg_observer" }), l1Deps);

    expect(result.perception_memory.summary).toBe("Observer memory");
    expect(storePerception).toHaveBeenCalledTimes(1);
    resolveStore();
  });

  it("awaits memory history writes in strict mode", async () => {
    let resolveStore!: () => void;
    const storePerception = vi.fn(() => new Promise<void>((resolve) => {
      resolveStore = resolve;
    }));
    const l1Deps: PipelineDeps = {
      ...deps,
      memoryHistoryMode: "strict",
      memory: { storePerception },
    };
    mockVlmAnalyzer.analyzeSegment.mockResolvedValue(makeVlmResult({ summary: "Strict memory" }));

    let settled = false;
    const resultPromise = analyze(makeSegment({ segment_id: "seg_strict" }), l1Deps)
      .then((result) => {
        settled = true;
        return result;
      });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(storePerception).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    resolveStore();
    const result = await resultPromise;
    expect(settled).toBe(true);
    expect(result.perception_memory.summary).toBe("Strict memory");
  });
});
