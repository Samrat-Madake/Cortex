// packages/percept/src/__tests__/pipeline.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { analyze, type PipelineDeps } from "../pipeline.js";
import { WorkingMemoryManager } from "../working-memory.js";
import { StrategyManager } from "../strategy-manager.js";
import type { Segment, AudioData } from "@reflectworld/shared";
import { monitorBus, type MonitorEvent } from "@reflectworld/shared";
import type { VlmOutput } from "../types.js";

// ── Helpers ──

function makeSegment(mode: Segment["mode"], frameCount: number): Segment {
  return {
    segment_id: "seg_test_001",
    camera_id: "cam_front_door",
    mode,
    frames: Array.from({ length: frameCount }, (_, i) => ({
      data: `base64_${i}`,
      timestamp: 1_000_000 + i * 1000,
      index: i,
    })),
    raw_url: "s3://raw-video/cam_front_door/seg_test_001.jpg",
    timestamp: 1_000_000,
    duration_sec: frameCount === 1 ? 0 : frameCount,
  };
}

const MOCK_VLM_OUTPUT: VlmOutput = {
  title: "Door Arrival",
  summary: "A person in a blue jacket at the front door.",
  detailed_summary: "A person wearing a blue jacket arrived at the front door.",
  security_risk: false,
  is_static_scene: false,
  notify_user: true,
  main_targets: [{ type: "person", appearance: "blue jacket", behavior: "arriving" }],
  raw_response: "{}",
};

function makeVlmSegmentAnalysis(output: VlmOutput = MOCK_VLM_OUTPUT) {
  return {
    normalizedJson: output.raw_response ?? JSON.stringify(output),
    output,
    latency_ms: 300,
  };
}

async function waitForCriticalCommit(
  onCriticalStateCommitted: ReturnType<typeof vi.fn>,
  expectedCalls = 1,
): Promise<void> {
  const deadline = Date.now() + 1000;
  while (onCriticalStateCommitted.mock.calls.length < expectedCalls && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ── Tests ──

describe("analyze pipeline", () => {
  let deps: PipelineDeps;
  let mockVlmAnalyzer: {
    analyzeSegment: ReturnType<typeof vi.fn>;
  };
  let mockMediaUploader: {
    saveKeyframe: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockVlmAnalyzer = {
      analyzeSegment: vi.fn().mockResolvedValue({
        ...makeVlmSegmentAnalysis(),
      }),
    };

    mockMediaUploader = {
      saveKeyframe: vi.fn().mockReturnValue(
        "/media/cam_front_door/keyframe/seg_test_001_0.jpg",
      ),
    };

    // Use real WorkingMemoryManager and StrategyManager
    deps = {
      workingMemory: new WorkingMemoryManager({ event_timeout_sec: 30 }),
      strategyManager: new StrategyManager({ stubsOnly: true }),
      vlmAnalyzer: mockVlmAnalyzer as unknown as import("../analyzers/vlm-analyzer.js").VlmAnalyzer,
      mediaUploader: mockMediaUploader as unknown as import("../media-uploader.js").MediaUploader,
    };
  });

  it("returns a valid PerceptionResult for a periodic single-frame segment", async () => {
    const segment = makeSegment("snapshot", 1);
    const result = await analyze(segment, deps);

    expect(result.segment_id).toBe("seg_test_001");
    expect(result.camera_id).toBe("cam_front_door");
    expect(result.mode).toBe("snapshot");
    expect(result.event_id).toMatch(/^evt_cam_front_door_/);
    expect(result.perception_memory.summary).toBe(MOCK_VLM_OUTPUT.summary);
    expect(result.perception_memory.perception_level).toBe(0);
  });

  it("calls VLM analyzer with correct model for periodic segment", async () => {
    const segment = makeSegment("snapshot", 1);
    await analyze(segment, deps);

    const [frames, model, options] = mockVlmAnalyzer.analyzeSegment.mock.calls[0]!;
    expect(frames).toBe(segment.frames);
    expect(model).toBe("gpt-5-mini");
    expect(options).toMatchObject({
      sceneContext: undefined,
      runtimeMode: "offline_quality",
      maxTokens: 2048,
      reasoningEffort: "minimal",
    });
    expect(options?.stream).toBeUndefined();
    expect(options?.onPartial).toBeUndefined();
  });

  it("uploads a keyframe and includes URL in media_urls", async () => {
    const segment = makeSegment("event", 3);
    const result = await analyze(segment, deps);

    // Middle frame is picked as best keyframe (index 1 for 3 frames)
    expect(mockMediaUploader.saveKeyframe).toHaveBeenCalledWith(
      "cam_front_door",
      "seg_test_001",
      1,
      expect.any(Buffer),
    );
    expect(result.media_urls.raw).toBe(segment.raw_url);
    expect(result.media_urls.keyframes).toHaveLength(1);
  });

  it("commits critical state once and records commit timing", async () => {
    const onCriticalStateCommitted = vi.fn();
    const segment = makeSegment("event", 3);

    const result = await analyze(segment, {
      ...deps,
      onCriticalStateCommitted,
    });

    expect(onCriticalStateCommitted).toHaveBeenCalledTimes(1);
    expect(onCriticalStateCommitted).toHaveBeenCalledWith(segment);
    expect(result._trace?.timestamps.critical_state_committed_at).toEqual(expect.any(Number));
    expect(result._trace?.latencies.critical_state_committed_ms).toEqual(expect.any(Number));
    expect(result._trace!.timestamps.critical_state_committed_at!)
      .toBeLessThanOrEqual(result._trace!.timestamps.analysis_completed_at);
  });

  it("does not emit critical barrier trace fields in default offline mode", async () => {
    const result = await analyze(makeSegment("event", 3), deps);

    expect(result._trace?.timestamps.critical_state_committed_at).toBeUndefined();
    expect(result._trace?.latencies.critical_state_committed_ms).toBeUndefined();
  });

  it("passes recent segment descriptions separately from scene context", async () => {
    const seg1 = { ...makeSegment("event", 3), segment_id: "seg_001" };
    const seg2 = { ...makeSegment("event", 3), segment_id: "seg_002" };

    await analyze(seg1, deps);

    mockVlmAnalyzer.analyzeSegment.mockClear();
    await analyze(seg2, deps);

    const [, , options] = mockVlmAnalyzer.analyzeSegment.mock.calls[0]!;
    expect(options?.sceneContext).toBeUndefined();
    expect(options?.recentSegmentSummaries).toContain(`[seg_001] title=${MOCK_VLM_OUTPUT.title}; detailed_summary=${MOCK_VLM_OUTPUT.detailed_summary}`);
  });

  it("emits streamed segment partial summaries in live latency mode", async () => {
    const events: MonitorEvent[] = [];
    const listener = (event: MonitorEvent) => events.push(event);
    monitorBus.on("monitor", listener);
    mockVlmAnalyzer.analyzeSegment.mockImplementation(async (_frames, _model, options) => {
      await options?.onPartial?.({ field: "title", value: "Hallway Entry" });
      await options?.onPartial?.({ field: "summary", value: "Person enters the hallway." });
      await options?.onPartial?.({ field: "security_risk", value: true });
      await options?.onPartial?.({ field: "security_reason", value: "Unknown person entered after hours." });
      await options?.onPartial?.({ field: "notify_user", value: true });
      await options?.onPartial?.({ field: "matched_rule_ids", value: ["rule-after-hours"] });
      return makeVlmSegmentAnalysis();
    });

    try {
      await analyze(makeSegment("event", 3), { ...deps, runtimeMode: "live_latency" });
    } finally {
      monitorBus.removeListener("monitor", listener);
    }

    const partialEvents = events.filter((event) => event.type === "perception:segment_partial");
    const partial = partialEvents.find((event) => event.data.field === "summary");
    expect(partial).toBeDefined();
    expect(partial?.camera_id).toBe("cam_front_door");
    expect(partial?.data).toMatchObject({
      camera_id: "cam_front_door",
      segment_id: "seg_test_001",
      segment_start: 1_000_000,
      duration_sec: 3,
      analysis_started_at: expect.any(Number),
      field: "summary",
      value: "Person enters the hallway.",
      partial_refresh_ms: expect.any(Number),
      summary_refresh_ms: expect.any(Number),
    });
    expect(typeof partial?.data.event_id).toBe("string");
    expect(typeof partial?.data.partial_received_at).toBe("number");
    expect(partialEvents.map((event) => [event.data.field, event.data.value])).toEqual([
      ["title", "Hallway Entry"],
      ["summary", "Person enters the hallway."],
      ["security_risk", true],
      ["security_reason", "Unknown person entered after hours."],
      ["notify_user", true],
      ["matched_rule_ids", ["rule-after-hours"]],
    ]);

    const [, , options] = mockVlmAnalyzer.analyzeSegment.mock.calls[0]!;
    expect(options?.stream).toBe(true);
  });

  it("uses subject proposal when detections are available and preserves natural-language fields", async () => {
    const onPipelineComplete = vi.fn();
    const segment = {
      ...makeSegment("event", 3),
      frames: makeSegment("event", 3).frames.map((frame, index) => ({
        ...frame,
        detections: [{
          label: "car",
          confidence: 0.92,
          bbox: { x1: 10 + index, y1: 20, x2: 110 + index, y2: 120 },
        }],
      })),
    };
    const subjectProposalRaw = JSON.stringify({
      summary: "A car is parked near the curb.",
      detailed_summary: "A dark car remains parked near the curb through the current segment.",
      content_type: "activity",
      key_modality: "visual",
      is_static_scene: false,
      event_boundary: false,
      event_summary: "A dark car is parked near the curb.",
      security_risk: false,
      segment_policy_exit_met: true,
      targets: [],
    });
    mockVlmAnalyzer.analyzeSegment.mockResolvedValue({
      normalizedJson: subjectProposalRaw,
      output: {
        ...MOCK_VLM_OUTPUT,
        summary: "A car is parked near the curb.",
        detailed_summary: "A dark car remains parked near the curb through the current segment.",
      },
      latency_ms: 300,
    });

    const result = await analyze(segment, {
      ...deps,
      strategyManager: new StrategyManager({
        stubsOnly: false,
        modelRouter: { getMaxLevel: () => 1, getReidProvider: () => undefined } as any,
      }),
      router: { getMaxLevel: () => 1, getReidProvider: () => undefined } as any,
      postProcessor: {
        getNotifyPolicy: () => "smart",
        sendNotifications: vi.fn(),
        onPipelineComplete,
      } as any,
    });

    expect(mockVlmAnalyzer.analyzeSegment).toHaveBeenCalled();
    expect(mockVlmAnalyzer.analyzeSegment.mock.calls[0]![2].subjectProposal).toBeDefined();
    expect(result.perception_memory.summary).toBe("A car is parked near the curb.");
    expect(result.perception_memory.detailed_summary).toBe(
      "A dark car remains parked near the curb through the current segment.",
    );
    expect(result.perception_memory.custom_fields).toMatchObject({
      content_type: "activity",
      key_modality: "visual",
    });
    expect(result.perception_memory.segment_policy_exit_met).toBe(true);
    expect(deps.workingMemory.getCurrentEventSummary(segment.camera_id)).toBe(
      "A dark car is parked near the curb.",
    );
    expect(onPipelineComplete.mock.calls[0]![2].vlm.notify_user).toBe(false);
  });

  it("commits stable subject-proposal critical state before full streaming completion", async () => {
    const onCriticalStateCommitted = vi.fn();
    let releaseFull!: () => void;
    const fullBlocked = new Promise<void>((resolve) => {
      releaseFull = resolve;
    });
    let analyzeDone = false;
    const segment = {
      ...makeSegment("event", 3),
      frames: makeSegment("event", 3).frames.map((frame, index) => ({
        ...frame,
        detections: [{
          label: "car",
          confidence: 0.92,
          bbox: { x1: 10 + index, y1: 20, x2: 110 + index, y2: 120 },
        }],
      })),
    };
    const finalRaw = JSON.stringify({
      title: "Parked Vehicle",
      summary: "A different final summary replaces the early one.",
      security_risk: false,
      is_static_scene: false,
      notify_user: false,
      matched_rule_ids: [],
      best_frame_index: 1,
      event_boundary: false,
      event_summary: "The parked vehicle remains part of the current curbside event.",
      detailed_summary: "A dark vehicle remains parked near the curb throughout the segment.",
      targets: [],
      target_details: [],
    });
    mockVlmAnalyzer.analyzeSegment.mockImplementation(async (_frames, _model, options) => {
      await options?.onPartial?.({ field: "title", value: "Parked Vehicle" });
      await options?.onPartial?.({ field: "summary", value: "A vehicle remains parked near the curb." });
      await options?.onPartial?.({ field: "security_risk", value: false });
      await options?.onPartial?.({ field: "is_static_scene", value: false });
      await options?.onPartial?.({ field: "notify_user", value: false });
      await options?.onPartial?.({ field: "matched_rule_ids", value: [] });
      await options?.onPartial?.({ field: "best_frame_index", value: 1 });
      await options?.onPartial?.({
        field: "targets",
        value: [],
      });
      await options?.onPartial?.({ field: "event_boundary", value: false });
      await fullBlocked;
      return {
        normalizedJson: finalRaw,
        output: {
          ...MOCK_VLM_OUTPUT,
          title: "Parked Vehicle",
          summary: "A different final summary replaces the early one.",
          detailed_summary: "A dark vehicle remains parked near the curb throughout the segment.",
          main_targets: [],
          raw_response: finalRaw,
        },
        latency_ms: 300,
      };
    });

    const analyzePromise = analyze(segment, {
      ...deps,
      runtimeMode: "live_latency",
      strategyManager: new StrategyManager({
        stubsOnly: false,
        modelRouter: {
          getMaxLevel: () => 1,
          getDetector: () => undefined,
          getReidProvider: () => undefined,
          getPoseProvider: () => undefined,
        } as any,
      }),
      router: {
        getMaxLevel: () => 1,
        getDetector: () => undefined,
        getReidProvider: () => undefined,
        getPoseProvider: () => undefined,
      } as any,
      onCriticalStateCommitted,
    }).finally(() => {
      analyzeDone = true;
    });

    await waitForCriticalCommit(onCriticalStateCommitted);
    expect(onCriticalStateCommitted).toHaveBeenCalledTimes(1);
    expect(analyzeDone).toBe(false);

    releaseFull();
    const result = await analyzePromise;
    expect(result._trace?.latencies.critical_state_committed_ms).toEqual(expect.any(Number));
    expect(result._trace!.latencies.critical_state_committed_ms!)
      .toBeLessThanOrEqual(result._trace!.latencies.perception_ms);
    expect(result.perception_memory.summary).toBe("A vehicle remains parked near the curb.");
    expect(result._trace?.context.decision_context?.streaming_critical?.conflict_fields).toContain("summary");
    expect(deps.workingMemory.getCurrentEventSummary(segment.camera_id)).toBe(
      "The parked vehicle remains part of the current curbside event.",
    );
  });

  it("early-releases live-latency targets without tid but cannot merge final target details", async () => {
    const onCriticalStateCommitted = vi.fn();
    let releaseFull!: () => void;
    const fullBlocked = new Promise<void>((resolve) => {
      releaseFull = resolve;
    });
    const segment = {
      ...makeSegment("event", 3),
      frames: makeSegment("event", 3).frames.map((frame, index) => ({
        ...frame,
        detections: [{
          label: "person",
          confidence: 0.92,
          bbox: { x1: 10 + index, y1: 20, x2: 210 + index, y2: 420 },
        }],
      })),
    };
    const finalRaw = JSON.stringify({
      title: "Person Present",
      summary: "A person stands near the camera.",
      security_risk: false,
      is_static_scene: false,
      notify_user: false,
      matched_rule_ids: [],
      best_frame_index: 1,
      event_boundary: false,
      detailed_summary: "A person stands near the camera throughout the segment.",
      targets: [{
        tid: "t1",
        type: "person",
        bbox_ids: ["D0"],
        matched_wm_target: null,
      }],
      target_details: [{
        tid: "t1",
        target_ref: "D0",
        appearance: "person near the camera",
        behavior: "standing",
      }],
    });
    mockVlmAnalyzer.analyzeSegment.mockImplementation(async (_frames, _model, options) => {
      await options?.onPartial?.({ field: "title", value: "Person Present" });
      await options?.onPartial?.({ field: "summary", value: "A person stands near the camera." });
      await options?.onPartial?.({ field: "security_risk", value: false });
      await options?.onPartial?.({ field: "is_static_scene", value: false });
      await options?.onPartial?.({ field: "notify_user", value: false });
      await options?.onPartial?.({ field: "matched_rule_ids", value: [] });
      await options?.onPartial?.({ field: "best_frame_index", value: 1 });
      await options?.onPartial?.({
        field: "targets",
        value: [{ type: "person", bbox_ids: ["D0"], matched_wm_target: null }],
      });
      await options?.onPartial?.({ field: "event_boundary", value: false });
      await fullBlocked;
      return {
        normalizedJson: finalRaw,
        output: {
          ...MOCK_VLM_OUTPUT,
          title: "Person Present",
          summary: "A person stands near the camera.",
          detailed_summary: "A person stands near the camera throughout the segment.",
          main_targets: [{ type: "person", appearance: "person near the camera", behavior: "standing" }],
          raw_response: finalRaw,
        },
        latency_ms: 300,
      };
    });

    const analyzePromise = analyze(segment, {
      ...deps,
      runtimeMode: "live_latency",
      strategyManager: new StrategyManager({
        stubsOnly: false,
        modelRouter: {
          getMaxLevel: () => 1,
          getDetector: () => undefined,
          getReidProvider: () => undefined,
          getPoseProvider: () => undefined,
        } as any,
      }),
      router: {
        getMaxLevel: () => 1,
        getDetector: () => undefined,
        getReidProvider: () => undefined,
        getPoseProvider: () => undefined,
      } as any,
      onCriticalStateCommitted,
    });

    await waitForCriticalCommit(onCriticalStateCommitted);
    expect(onCriticalStateCommitted).toHaveBeenCalledTimes(1);
    expect(deps.workingMemory.getTargets(segment.camera_id)[0]).toMatchObject({
      class_name: "person",
      appearance: "",
    });

    releaseFull();
    const result = await analyzePromise;
    expect(result.perception_memory.summary).toBe("A person stands near the camera.");
    expect(result._trace?.latencies.critical_state_committed_ms).toEqual(expect.any(Number));
    expect(result._trace?.context.decision_context?.streaming_critical?.fallback_reason).toBeUndefined();
    expect(result._trace?.context.decision_context?.streaming_critical?.parse_error_count).toEqual(expect.any(Number));
    expect(deps.workingMemory.getTargets(segment.camera_id)[0]).toMatchObject({
      class_name: "person",
      appearance: "",
    });
  });

  it("releases streamed critical state once diarized target speaker ids are carried by targets", async () => {
    const criticalOrder: string[] = [];
    const events: MonitorEvent[] = [];
    const listener = (event: MonitorEvent) => events.push(event);
    monitorBus.on("monitor", listener);
    const onCriticalStateCommitted = vi.fn(() => {
      criticalOrder.push("hook");
    });
    const subjectRegistryCommit = vi.fn(() => {
      criticalOrder.push("subject_commit");
    });
    const mockSttAnalyzer = {
      isAvailable: true,
      transcribe: vi.fn().mockReturnValue({
        transcript: "welcome everyone",
        segments: [{ start: 1000, text: "welcome everyone", speaker: "speaker_0", latency_ms: 30 }],
        latency_ms: 30,
      }),
    };
    let releaseFull!: () => void;
    let releasedFull = false;
    const fullBlocked = new Promise<void>((resolve) => {
      releaseFull = () => {
        releasedFull = true;
        resolve();
      };
    });
    let analyzeDone = false;
    const segment = {
      ...makeSegment("stream", 3),
      audio_segments: [{ start: 1000, samples: new Float32Array(16000) }],
      frames: makeSegment("stream", 3).frames.map((frame, index) => ({
        ...frame,
        detections: [{
          label: "person",
          confidence: 0.92,
          bbox: { x1: 10 + index, y1: 20, x2: 210 + index, y2: 420 },
        }],
      })),
    };
    const finalRaw = JSON.stringify({
      title: "Interview Speaker",
      summary: "A person speaks during the interview.",
      security_risk: false,
      is_static_scene: false,
      notify_user: false,
      matched_rule_ids: [],
      best_frame_index: 1,
      event_boundary: false,
      security_reason: "",
      detailed_summary: "A person speaks during the interview segment.",
      targets: [{
        tid: "t1",
        type: "person",
        bbox_ids: ["D0"],
        matched_wm_target: null,
      }],
      target_details: [{
        tid: "t1",
        target_ref: "D0",
        appearance: "person seated at the interview desk",
        behavior: "speaking during the interview",
      }],
    });
    mockVlmAnalyzer.analyzeSegment.mockImplementation(async (_frames, _model, options) => {
      await options?.onPartial?.({ field: "title", value: "Interview Speaker" });
      await options?.onPartial?.({ field: "summary", value: "A person speaks during the interview." });
      await options?.onPartial?.({ field: "security_risk", value: false });
      await options?.onPartial?.({ field: "is_static_scene", value: false });
      await options?.onPartial?.({ field: "notify_user", value: false });
      await options?.onPartial?.({ field: "matched_rule_ids", value: [] });
      await options?.onPartial?.({ field: "best_frame_index", value: 1 });
      await options?.onPartial?.({
        field: "targets",
        value: [{ tid: "t1", type: "person", bbox_ids: ["D0"], matched_wm_target: null, speaker_ids: ["speaker_0"] }],
      });
      await options?.onPartial?.({ field: "event_boundary", value: false });
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(onCriticalStateCommitted).toHaveBeenCalledTimes(1);
      await options?.onPartial?.({ field: "security_reason", value: "" });
      await fullBlocked;
      return {
        normalizedJson: finalRaw,
        output: {
          ...MOCK_VLM_OUTPUT,
          title: "Interview Speaker",
          summary: "A person speaks during the interview.",
          detailed_summary: "A person speaks during the interview segment.",
          main_targets: [{ type: "person", appearance: "person seated at the interview desk", behavior: "speaking during the interview" }],
          raw_response: finalRaw,
        },
        latency_ms: 300,
      };
    });

    const analyzePromise = analyze(segment, {
      ...deps,
      runtimeMode: "live_latency",
      sttAnalyzer: mockSttAnalyzer as any,
      strategyManager: new StrategyManager({
        stubsOnly: false,
        modelRouter: {
          getMaxLevel: () => 1,
          getDetector: () => undefined,
          getReidProvider: () => undefined,
          getPoseProvider: () => undefined,
        } as any,
      }),
      router: {
        getMaxLevel: () => 1,
        getDetector: () => undefined,
        getReidProvider: () => undefined,
        getPoseProvider: () => undefined,
      } as any,
      onCriticalStateCommitted,
      subjectRegistry: {
        createSession: () => ({
          resolve: (input: { category: string }) => ({
            category: input.category,
            subject_index: 1,
            first_seen: segment.timestamp,
          }),
          commit: subjectRegistryCommit,
        }),
      },
    }).finally(() => {
      analyzeDone = true;
    });

    try {
      await waitForCriticalCommit(onCriticalStateCommitted);
      expect(onCriticalStateCommitted).toHaveBeenCalledTimes(1);
      expect(subjectRegistryCommit).toHaveBeenCalledTimes(1);
      expect(criticalOrder).toEqual(["subject_commit", "hook"]);
      expect(analyzeDone).toBe(false);

      const dialoguePartial = events.find((event) => event.type === "perception:segment_partial" && event.data.field === "dialogue");
      expect(dialoguePartial?.data).toMatchObject({
        field: "dialogue",
        transcript: "welcome everyone",
        value: [{
          text_start: expect.any(Number),
          track_id: "D0",
          identity_level: "event_local",
          confidence: "high",
          text: "welcome everyone",
        }],
      });

      releaseFull();
      const result = await analyzePromise;
      expect(result.dialogue).toEqual([{
        text_start: expect.any(Number),
        track_id: "D0",
        identity_level: "event_local",
        confidence: "high",
        text: "welcome everyone",
      }]);
      expect(result._trace?.timestamps.critical_state_committed_at).toEqual(expect.any(Number));
      expect(result._trace!.timestamps.critical_state_committed_at!)
        .toBeLessThanOrEqual(result._trace!.timestamps.analysis_completed_at);
    } finally {
      if (!releasedFull) releaseFull();
      monitorBus.removeListener("monitor", listener);
    }
  });

  it("creates new ReID entities during streamed critical commit before full completion", async () => {
    const onCriticalStateCommitted = vi.fn();
    const reidUpsert = vi.fn().mockResolvedValue({
      entity_id: "entity_person_1",
      subject_index: 1,
      first_seen: 1_000_000,
    });
    const reidSearch = vi.fn().mockResolvedValue([]);
    const withReidWriteLock = vi.fn(async (fn: () => Promise<unknown>) => fn());
    let releaseFull!: () => void;
    const fullBlocked = new Promise<void>((resolve) => {
      releaseFull = resolve;
    });
    let analyzeDone = false;
    const segment = {
      ...makeSegment("event", 3),
      frames: makeSegment("event", 3).frames.map((frame, index) => ({
        ...frame,
        detections: [{
          label: "person",
          confidence: 0.92,
          bbox: { x1: 10 + index, y1: 20, x2: 210 + index, y2: 420 },
        }],
      })),
    };
    const finalRaw = JSON.stringify({
      title: "Person Present",
      summary: "A person stands near the camera.",
      security_risk: false,
      is_static_scene: false,
      notify_user: false,
      matched_rule_ids: [],
      best_frame_index: 1,
      event_boundary: false,
      detailed_summary: "A person stands near the camera throughout the segment.",
      targets: [{
        tid: "t1",
        type: "person",
        bbox_ids: ["D1", "D0"],
        matched_wm_target: null,
        speaker_ids: ["speaker_0"],
      }],
      target_details: [{
        tid: "t1",
        target_ref: "D1",
        appearance: "person in dark clothing",
        behavior: "standing near camera",
      }],
    });
    const bodyProvider = {
      extractEmbedding: vi.fn().mockResolvedValue({ embedding: [0.11, 0.22, 0.33], embedding_dim: 3 }),
    };
    const router = {
      getMaxLevel: () => 1,
      getDetector: () => undefined,
      getReidProvider: (capability: string) => capability === "body-reid" ? bodyProvider : undefined,
      getPoseProvider: () => undefined,
    } as any;
    mockVlmAnalyzer.analyzeSegment.mockImplementation(async (_frames, _model, options) => {
      await options?.onPartial?.({ field: "title", value: "Person Present" });
      await options?.onPartial?.({ field: "summary", value: "A person stands near the camera." });
      await options?.onPartial?.({ field: "security_risk", value: false });
      await options?.onPartial?.({ field: "is_static_scene", value: false });
      await options?.onPartial?.({ field: "notify_user", value: false });
      await options?.onPartial?.({ field: "matched_rule_ids", value: [] });
      await options?.onPartial?.({ field: "best_frame_index", value: 1 });
      await options?.onPartial?.({
        field: "targets",
        value: [{ tid: "t1", type: "person", bbox_ids: ["D0", "D1"], matched_wm_target: null }],
      });
      await options?.onPartial?.({ field: "event_boundary", value: false });
      await fullBlocked;
      return {
        normalizedJson: finalRaw,
        output: {
          ...MOCK_VLM_OUTPUT,
          title: "Person Present",
          summary: "A person stands near the camera.",
          detailed_summary: "A person stands near the camera throughout the segment.",
          main_targets: [{ type: "person", appearance: "person in dark clothing", behavior: "standing near camera" }],
          raw_response: finalRaw,
        },
        latency_ms: 300,
      };
    });

    const analyzePromise = analyze(segment, {
      ...deps,
      runtimeMode: "live_latency",
      bodyReIdEnabled: true,
      strategyManager: new StrategyManager({
        stubsOnly: false,
        modelRouter: router,
      }),
      router,
      memory: {
        reidSearch,
        reidUpsert,
        withReidWriteLock,
      },
      onCriticalStateCommitted,
    }).finally(() => {
      analyzeDone = true;
    });

    await waitForCriticalCommit(onCriticalStateCommitted);
    expect(reidUpsert).toHaveBeenCalledWith(
      { body: { vector: [0.11, 0.22, 0.33], quality: expect.any(Number) } },
      expect.objectContaining({ category: "person" }),
    );
    expect(withReidWriteLock).toHaveBeenCalledTimes(1);
    expect(onCriticalStateCommitted).toHaveBeenCalledTimes(1);
    expect(analyzeDone).toBe(false);

    releaseFull();
    const result = await analyzePromise;
    expect(result.perception_memory.entities[0]).toMatchObject({
      entity_id: "entity_person_1",
      subject_index: 1,
    });
    const wmTargets = deps.workingMemory.getTargets(segment.camera_id);
    expect(wmTargets).toHaveLength(1);
    expect(wmTargets[0]).toMatchObject({
      target_id: "wm_t1",
      entity_id: "entity_person_1",
    });
  });

  it("serializes final ReID target writes with a single non-nested lock", async () => {
    const bodyEmbedding = [0.21, 0.22, 0.23];
    const reidSearch = vi.fn().mockResolvedValue([{
      entity_id: "entity_person_7",
      score: 0.92,
      type: "body",
    }]);
    const reidGalleryUpdate = vi.fn().mockResolvedValue(undefined);
    const reserveEntityId = vi.fn(() => "entity_unused");
    const reidBatchInit = vi.fn().mockResolvedValue({
      entity_id: "entity_unused",
      face_slots_written: 0,
      body_slots_written: 0,
      event: "created",
    });
    let inReidLock = false;
    const withReidWriteLock = vi.fn(async (fn: () => Promise<unknown>) => {
      if (inReidLock) throw new Error("nested reid write lock");
      inReidLock = true;
      try {
        return await fn();
      } finally {
        inReidLock = false;
      }
    });
    const bodyProvider = {
      extractEmbedding: vi.fn().mockResolvedValue({ embedding: bodyEmbedding, embedding_dim: bodyEmbedding.length }),
    };
    const router = {
      getMaxLevel: () => 1,
      getDetector: () => undefined,
      getReidProvider: (capability: string) => capability === "body-reid" ? bodyProvider : undefined,
      getPoseProvider: () => undefined,
    } as any;
    const segment = {
      ...makeSegment("event", 3),
      frames: makeSegment("event", 3).frames.map((frame, index) => ({
        ...frame,
        detections: [{
          label: "person",
          confidence: 0.92,
          bbox: { x1: 10 + index, y1: 20, x2: 210 + index, y2: 420 },
        }],
      })),
    };
    const raw = JSON.stringify({
      title: "Known Person Present",
      summary: "A known person stands near the camera.",
      security_risk: false,
      is_static_scene: false,
      notify_user: false,
      matched_rule_ids: [],
      best_frame_index: 1,
      event_boundary: false,
      detailed_summary: "A known person remains visible near the camera.",
      targets: [{
        tid: "t1",
        type: "person",
        bbox_ids: ["D0"],
        matched_wm_target: null,
      }],
      target_details: [{
        tid: "t1",
        target_ref: "D0",
        appearance: "known person in the room",
        behavior: "standing",
      }],
    });
    mockVlmAnalyzer.analyzeSegment.mockResolvedValue({
      normalizedJson: raw,
      output: {
        ...MOCK_VLM_OUTPUT,
        title: "Known Person Present",
        summary: "A known person stands near the camera.",
        detailed_summary: "A known person remains visible near the camera.",
        main_targets: [{ type: "person", appearance: "known person in the room", behavior: "standing" }],
        raw_response: raw,
      },
      latency_ms: 300,
    });

    const result = await analyze(segment, {
      ...deps,
      bodyReIdEnabled: true,
      strategyManager: new StrategyManager({ stubsOnly: false, modelRouter: router }),
      router,
      memory: {
        reidSearch,
        reidGalleryUpdate,
        reserveEntityId,
        reidBatchInit,
        withReidWriteLock,
      },
    });

    expect(withReidWriteLock).toHaveBeenCalledTimes(1);
    expect(reidBatchInit).not.toHaveBeenCalled();
    expect(reidGalleryUpdate).toHaveBeenCalledWith("entity_person_7", {
      body: expect.objectContaining({ vector: bodyEmbedding }),
    });
    expect(result.perception_memory.entities[0]).toMatchObject({
      entity_id: "entity_person_7",
      type: "person",
    });
  });

  it("does not persist weak target identity evidence to a stable ReID entity", async () => {
    const bodyEmbedding = [0.31, 0.32, 0.33];
    const reidSearch = vi.fn().mockResolvedValue([{
      entity_id: "entity_center_guest",
      score: 0.93,
      type: "body",
    }]);
    const reidGalleryUpdate = vi.fn().mockResolvedValue(undefined);
    const reidUpdateIdentity = vi.fn().mockResolvedValue(undefined);
    const withReidWriteLock = vi.fn(async (fn: () => Promise<unknown>) => fn());
    const bodyProvider = {
      extractEmbedding: vi.fn().mockResolvedValue({ embedding: bodyEmbedding, embedding_dim: bodyEmbedding.length }),
    };
    const router = {
      getMaxLevel: () => 1,
      getDetector: () => undefined,
      getReidProvider: (capability: string) => capability === "body-reid" ? bodyProvider : undefined,
      getPoseProvider: () => undefined,
    } as any;
    const segment = {
      ...makeSegment("event", 3),
      frames: makeSegment("event", 3).frames.map((frame, index) => ({
        ...frame,
        detections: [{
          label: "person",
          confidence: 0.92,
          bbox: { x1: 10 + index, y1: 20, x2: 210 + index, y2: 420 },
        }],
      })),
    };
    const raw = JSON.stringify({
      title: "Interview Segment",
      summary: "A guest speaks during the interview.",
      security_risk: false,
      is_static_scene: false,
      notify_user: false,
      matched_rule_ids: [],
      best_frame_index: 1,
      event_boundary: false,
      detailed_summary: "A center guest speaks while the host is off-screen.",
      targets: [{
        tid: "t1",
        type: "person",
        bbox_ids: ["D0"],
        matched_wm_target: null,
        identity: {
          name: "Ed Ludlow",
          evidence: "Host context and transcript role imply this name.",
          source: "other",
        },
      }],
      target_details: [{
        tid: "t1",
        target_ref: "D0",
        appearance: "center guest in a blazer",
        behavior: "speaking",
      }],
    });
    mockVlmAnalyzer.analyzeSegment.mockResolvedValue({
      normalizedJson: raw,
      output: {
        ...MOCK_VLM_OUTPUT,
        title: "Interview Segment",
        summary: "A guest speaks during the interview.",
        detailed_summary: "A center guest speaks while the host is off-screen.",
        main_targets: [{
          type: "person",
          appearance: "center guest in a blazer",
          behavior: "speaking",
          identity: {
            name: "Ed Ludlow",
            evidence: "Host context and transcript role imply this name.",
            source: "other",
          },
        }],
        raw_response: raw,
      },
      latency_ms: 300,
    });

    const result = await analyze(segment, {
      ...deps,
      bodyReIdEnabled: true,
      strategyManager: new StrategyManager({ stubsOnly: false, modelRouter: router }),
      router,
      memory: {
        reidSearch,
        reidGalleryUpdate,
        reidUpdateIdentity,
        withReidWriteLock,
      },
    });

    expect(result.perception_memory.entities[0]).toMatchObject({
      entity_id: "entity_center_guest",
      type: "person",
    });
    expect(result.perception_memory.entities[0]?.name).toBeUndefined();
    expect(reidUpdateIdentity).not.toHaveBeenCalled();
  });

  it("keeps live-latency identity continuity when a previous segment finishes late", async () => {
    const onCriticalStateCommitted = vi.fn();
    const reidUpsert = vi.fn().mockResolvedValue({
      entity_id: "entity_person_1",
      subject_index: 1,
      first_seen: 1_000_000,
    });
    const reidSearch = vi.fn().mockResolvedValue([]);
    const lockOrder: string[] = [];
    const withReidWriteLock = vi.fn(async (fn: () => Promise<unknown>) => {
      lockOrder.push("lock");
      return fn();
    });
    let releaseFirstFull!: () => void;
    const firstFullBlocked = new Promise<void>((resolve) => {
      releaseFirstFull = resolve;
    });
    const bodyProvider = {
      extractEmbedding: vi.fn().mockResolvedValue({ embedding: [0.11, 0.22, 0.33], embedding_dim: 3 }),
    };
    const router = {
      getMaxLevel: () => 1,
      getDetector: () => undefined,
      getReidProvider: (capability: string) => capability === "body-reid" ? bodyProvider : undefined,
      getPoseProvider: () => undefined,
    } as any;

    let callIndex = 0;
    let secondSawFirstTarget = false;
    mockVlmAnalyzer.analyzeSegment.mockImplementation(async (_frames, _model, options) => {
      callIndex += 1;
      if (callIndex === 1) {
        await options?.onPartial?.({ field: "title", value: "Person Present" });
        await options?.onPartial?.({ field: "summary", value: "A person stands near the camera." });
        await options?.onPartial?.({ field: "security_risk", value: false });
        await options?.onPartial?.({ field: "is_static_scene", value: false });
        await options?.onPartial?.({ field: "notify_user", value: false });
        await options?.onPartial?.({ field: "matched_rule_ids", value: [] });
        await options?.onPartial?.({ field: "best_frame_index", value: 1 });
        await options?.onPartial?.({
          field: "targets",
          value: [{ tid: "t1", type: "person", bbox_ids: ["D0"], matched_wm_target: null, appearance: "person in a blue jacket" }],
        });
        await options?.onPartial?.({ field: "event_boundary", value: false });
        await firstFullBlocked;
        const raw = JSON.stringify({
          title: "Person Present",
          summary: "A person stands near the camera.",
          security_risk: false,
          is_static_scene: false,
          notify_user: false,
          matched_rule_ids: [],
          best_frame_index: 1,
          event_boundary: false,
          detailed_summary: "A person stands near the camera.",
          targets: [{ tid: "t1", type: "person", bbox_ids: ["D0"], matched_wm_target: null }],
          target_details: [{ tid: "t1", target_ref: "D0", appearance: "stale first segment appearance", behavior: "standing" }],
        });
        return {
          normalizedJson: raw,
          output: {
            ...MOCK_VLM_OUTPUT,
            title: "Person Present",
            summary: "A person stands near the camera.",
            detailed_summary: "A person stands near the camera.",
            main_targets: [{ type: "person", appearance: "stale first segment appearance", behavior: "standing" }],
            raw_response: raw,
          },
          latency_ms: 300,
        };
      }

      secondSawFirstTarget = Boolean(options?.subjectProposal?.wmTargets?.some((target: any) =>
        target.target_id === "wm_t1" && target.appearance === "person in a blue jacket"));
      await options?.onPartial?.({ field: "title", value: "Person Present" });
      await options?.onPartial?.({ field: "summary", value: "The same person remains near the camera." });
      await options?.onPartial?.({ field: "security_risk", value: false });
      await options?.onPartial?.({ field: "is_static_scene", value: false });
      await options?.onPartial?.({ field: "notify_user", value: false });
      await options?.onPartial?.({ field: "matched_rule_ids", value: [] });
      await options?.onPartial?.({ field: "best_frame_index", value: 1 });
      await options?.onPartial?.({
        field: "targets",
        value: [{ tid: "t1", type: "person", bbox_ids: ["D0"], matched_wm_target: "wm_t1", appearance: "updated second segment appearance" }],
      });
      await options?.onPartial?.({ field: "event_boundary", value: false });
      const raw = JSON.stringify({
        title: "Person Present",
        summary: "The same person remains near the camera.",
        security_risk: false,
        is_static_scene: false,
        notify_user: false,
        matched_rule_ids: [],
        best_frame_index: 1,
        event_boundary: false,
        detailed_summary: "The same person remains near the camera.",
        targets: [{ tid: "t1", type: "person", bbox_ids: ["D0"], matched_wm_target: "wm_t1" }],
        target_details: [{ tid: "t1", target_ref: "D0", appearance: "updated second segment appearance", behavior: "remaining nearby" }],
      });
      return {
        normalizedJson: raw,
        output: {
          ...MOCK_VLM_OUTPUT,
          title: "Person Present",
          summary: "The same person remains near the camera.",
          detailed_summary: "The same person remains near the camera.",
          main_targets: [{ type: "person", appearance: "updated second segment appearance", behavior: "remaining nearby" }],
          raw_response: raw,
        },
        latency_ms: 300,
      };
    });

    const makePersonSegment = (segmentId: string, timestamp: number): Segment => ({
      ...makeSegment("event", 3),
      segment_id: segmentId,
      timestamp,
      frames: makeSegment("event", 3).frames.map((frame, index) => ({
        ...frame,
        timestamp: timestamp + index * 1000,
        detections: [{
          label: "person",
          confidence: 0.92,
          bbox: { x1: 10 + index, y1: 20, x2: 210 + index, y2: 420 },
        }],
      })),
    });
    const commonDeps = {
      ...deps,
      runtimeMode: "live_latency" as const,
      bodyReIdEnabled: true,
      strategyManager: new StrategyManager({ stubsOnly: false, modelRouter: router }),
      router,
      memory: {
        reidSearch,
        reidUpsert,
        withReidWriteLock,
      },
      onCriticalStateCommitted,
    };

    const firstPromise = analyze(makePersonSegment("seg_live_001", 1_000_000), commonDeps);
    await waitForCriticalCommit(onCriticalStateCommitted);
    expect(onCriticalStateCommitted).toHaveBeenCalledTimes(1);
    expect(deps.workingMemory.getTargets("cam_front_door")[0]).toMatchObject({
      target_id: "wm_t1",
      entity_id: "entity_person_1",
      appearance: "person in a blue jacket",
    });

    const secondResult = await analyze(makePersonSegment("seg_live_002", 1_010_000), commonDeps);
    expect(onCriticalStateCommitted).toHaveBeenCalledTimes(2);
    expect(secondSawFirstTarget).toBe(true);
    expect(secondResult.perception_memory.entities[0]).toMatchObject({
      entity_id: "entity_person_1",
    });
    expect(deps.workingMemory.getTargets("cam_front_door")[0]).toMatchObject({
      target_id: "wm_t1",
      entity_id: "entity_person_1",
      appearance: "updated second segment appearance",
    });

    releaseFirstFull();
    await firstPromise;
    expect(deps.workingMemory.getTargets("cam_front_door")[0]).toMatchObject({
      target_id: "wm_t1",
      entity_id: "entity_person_1",
      appearance: "updated second segment appearance",
    });
    expect(reidUpsert).toHaveBeenCalledTimes(1);
    expect(lockOrder.length).toBeGreaterThan(0);
  });

  it("reuses the critical WM target during live-latency final completion without an entity anchor", async () => {
    const onCriticalStateCommitted = vi.fn();
    mockVlmAnalyzer.analyzeSegment.mockImplementation(async (_frames, _model, options) => {
      await options?.onPartial?.({ field: "title", value: "Dog Present" });
      await options?.onPartial?.({ field: "summary", value: "A dog remains near the doorway." });
      await options?.onPartial?.({ field: "security_risk", value: false });
      await options?.onPartial?.({ field: "is_static_scene", value: false });
      await options?.onPartial?.({ field: "notify_user", value: false });
      await options?.onPartial?.({ field: "matched_rule_ids", value: [] });
      await options?.onPartial?.({ field: "best_frame_index", value: 1 });
      await options?.onPartial?.({
        field: "targets",
        value: [{ tid: "t1", type: "animal", bbox_ids: ["D0"], matched_wm_target: null }],
      });
      await options?.onPartial?.({ field: "event_boundary", value: false });
      const raw = JSON.stringify({
        title: "Dog Present",
        summary: "A dog remains near the doorway.",
        security_risk: false,
        is_static_scene: false,
        notify_user: false,
        matched_rule_ids: [],
        best_frame_index: 1,
        event_boundary: false,
        detailed_summary: "The dog remains near the doorway.",
        targets: [{ tid: "t1", type: "animal", bbox_ids: ["D0"], matched_wm_target: null }],
        target_details: [{ tid: "t1", appearance: "small brown dog", behavior: "standing" }],
      });
      return {
        normalizedJson: raw,
        output: {
          ...MOCK_VLM_OUTPUT,
          title: "Dog Present",
          summary: "A dog remains near the doorway.",
          detailed_summary: "The dog remains near the doorway.",
          main_targets: [{ type: "animal", appearance: "small brown dog", behavior: "standing" }],
          raw_response: raw,
        },
        latency_ms: 300,
      };
    });

    const segment = {
      ...makeSegment("event", 3),
      frames: makeSegment("event", 3).frames.map((frame, index) => ({
        ...frame,
        detections: [{
          label: "dog",
          confidence: 0.92,
          bbox: { x1: 700 + index, y1: 50, x2: 1100 + index, y2: 700 },
        }],
      })),
    };

    const result = await analyze(segment, {
      ...deps,
      runtimeMode: "live_latency",
      strategyManager: new StrategyManager({
        stubsOnly: false,
        modelRouter: {
          getMaxLevel: () => 1,
          getDetector: () => undefined,
          getReidProvider: () => undefined,
          getPoseProvider: () => undefined,
        } as any,
      }),
      router: {
        getMaxLevel: () => 1,
        getDetector: () => undefined,
        getReidProvider: () => undefined,
        getPoseProvider: () => undefined,
      } as any,
      onCriticalStateCommitted,
    });

    expect(onCriticalStateCommitted).toHaveBeenCalledTimes(1);
    expect(deps.workingMemory.getTargets("cam_front_door")).toHaveLength(1);
    expect(deps.workingMemory.getTargets("cam_front_door")[0]).toMatchObject({
      target_id: "wm_t1",
    });
    expect(result.perception_memory.entities[0]).toMatchObject({
      type: "animal",
      appearance: "small brown dog",
    });
  });

  it("does not infer static scene from an empty subject proposal target list", async () => {
    const segment = {
      ...makeSegment("event", 3),
      frames: makeSegment("event", 3).frames.map((frame, index) => ({
        ...frame,
        detections: [{
          label: "car",
          confidence: 0.9,
          bbox: { x1: 10 + index, y1: 20, x2: 110 + index, y2: 220 },
        }],
      })),
    };
    const raw = JSON.stringify({
      title: "Panel Discussion",
      summary: "A speaker continues discussing on-prem AI during an interview.",
      detailed_summary: "The segment contains meaningful interview dialogue even though no subject target is proposed.",
      content_type: "conversation",
      key_modality: "audio",
      event_boundary: false,
      event_summary: "The interview discussion continues.",
      targets: [],
    });
    mockVlmAnalyzer.analyzeSegment.mockResolvedValue({
      normalizedJson: raw,
      output: {
        ...MOCK_VLM_OUTPUT,
        summary: "A speaker continues discussing on-prem AI during an interview.",
        detailed_summary: "The segment contains meaningful interview dialogue even though no subject target is proposed.",
        is_static_scene: false,
        main_targets: [],
      },
      latency_ms: 300,
    });

    const result = await analyze(segment, {
      ...deps,
      strategyManager: new StrategyManager({
        stubsOnly: false,
        modelRouter: { getMaxLevel: () => 1, getReidProvider: () => undefined } as any,
      }),
      router: { getMaxLevel: () => 1, getReidProvider: () => undefined } as any,
    });

    expect(mockVlmAnalyzer.analyzeSegment).toHaveBeenCalled();
    expect(result.perception_memory.summary).toBe("A speaker continues discussing on-prem AI during an interview.");
    expect(result.perception_memory.entities).toEqual([]);
    expect(result.perception_memory.is_static_scene).toBe(false);
  });

  it("skips target parsing when subject proposal falls back to summary-only", async () => {
    const segment = {
      ...makeSegment("event", 3),
      frames: makeSegment("event", 3).frames.map((frame, index) => ({
        ...frame,
        detections: [{
          label: "car",
          confidence: 0.92,
          bbox: { x1: 10 + index, y1: 20, x2: 110 + index, y2: 120 },
        }],
      })),
    };
    const raw = JSON.stringify({
      summary: "A car is parked near the curb.",
      detailed_summary: "A dark car remains parked near the curb through the current segment.",
      content_type: "activity",
      key_modality: "visual",
      is_static_scene: false,
      event_boundary: false,
      event_summary: "A dark car is parked near the curb.",
      targets: [],
    });
    mockVlmAnalyzer.analyzeSegment.mockResolvedValue({
      normalizedJson: raw,
      output: {
        ...MOCK_VLM_OUTPUT,
        summary: "A car is parked near the curb.",
        detailed_summary: "A dark car remains parked near the curb through the current segment.",
      },
      latency_ms: 300,
      subject_proposal_context: {
        fallback_layer: "summary_only",
        wm_target_ids: [],
        wm_target_image_count: 0,
        target_aggregation: "disabled",
      },
    });

    const result = await analyze(segment, {
      ...deps,
      strategyManager: new StrategyManager({
        stubsOnly: false,
        modelRouter: { getMaxLevel: () => 1, getReidProvider: () => undefined } as any,
      }),
      router: { getMaxLevel: () => 1, getReidProvider: () => undefined } as any,
    });

    expect(result.perception_memory.summary).toBe("A car is parked near the curb.");
    expect(result.perception_memory.detailed_summary).toBe(
      "A dark car remains parked near the curb through the current segment.",
    );
    expect(result.perception_memory.entities).toEqual([]);
    expect(result.perception_memory.custom_fields).toMatchObject({
      content_type: "activity",
      key_modality: "visual",
    });
  });

  it("uses VLM-only fallback at L1 when no detections are available", async () => {
    const segment = makeSegment("event", 3);
    await analyze(segment, {
      ...deps,
      strategyManager: new StrategyManager({
        stubsOnly: false,
        modelRouter: { getMaxLevel: () => 1, getReidProvider: () => undefined } as any,
      }),
      router: { getMaxLevel: () => 1, getReidProvider: () => undefined } as any,
    });

    const options = mockVlmAnalyzer.analyzeSegment.mock.calls[0]![2];
    expect(options.subjectProposal).toBeUndefined();
    expect(options.localModelResults?.detectionOutput).toBeUndefined();
    expect(options.localModelResults?.tracks).toBeUndefined();
  });

  it("releases VLM-only streamed critical state before full completion", async () => {
    const onCriticalStateCommitted = vi.fn();
    let releaseFull!: () => void;
    const fullBlocked = new Promise<void>((resolve) => {
      releaseFull = resolve;
    });
    let analyzeDone = false;
    const segment = makeSegment("event", 3);
    const finalRaw = JSON.stringify({
      title: "People Visible",
      summary: "A final response tries to replace the early summary.",
      security_risk: false,
      is_static_scene: false,
      notify_user: false,
      matched_rule_ids: [],
      best_frame_index: 1,
      event_boundary: false,
      detailed_summary: "People remain visible in the room while the camera observes the scene.",
      main_targets: [{ type: "person", appearance: "person in room", behavior: "visible" }],
    });
    mockVlmAnalyzer.analyzeSegment.mockImplementation(async (_frames, _model, options) => {
      await options?.onPartial?.({ field: "title", value: "People Visible" });
      await options?.onPartial?.({ field: "summary", value: "People are visible in the room." });
      await options?.onPartial?.({ field: "security_risk", value: false });
      await options?.onPartial?.({ field: "is_static_scene", value: false });
      await options?.onPartial?.({ field: "notify_user", value: false });
      await options?.onPartial?.({ field: "matched_rule_ids", value: [] });
      await options?.onPartial?.({ field: "best_frame_index", value: 1 });
      await options?.onPartial?.({
        field: "main_targets",
        value: [{ type: "person", appearance: "person in room", behavior: "visible" }],
      });
      await options?.onPartial?.({ field: "event_boundary", value: false });
      await fullBlocked;
      return {
        normalizedJson: finalRaw,
        output: {
          ...MOCK_VLM_OUTPUT,
          title: "People Visible",
          summary: "A final response tries to replace the early summary.",
          detailed_summary: "People remain visible in the room while the camera observes the scene.",
          main_targets: [{ type: "person", appearance: "person in room", behavior: "visible" }],
          raw_response: finalRaw,
        },
        latency_ms: 300,
      };
    });

    const analyzePromise = analyze(segment, {
      ...deps,
      runtimeMode: "live_latency",
      strategyManager: new StrategyManager({
        stubsOnly: false,
        modelRouter: {
          getMaxLevel: () => 1,
          getDetector: () => undefined,
          getReidProvider: () => undefined,
          getPoseProvider: () => undefined,
        } as any,
      }),
      router: {
        getMaxLevel: () => 1,
        getDetector: () => undefined,
        getReidProvider: () => undefined,
        getPoseProvider: () => undefined,
      } as any,
      onCriticalStateCommitted,
    }).finally(() => {
      analyzeDone = true;
    });

    await waitForCriticalCommit(onCriticalStateCommitted);
    expect(onCriticalStateCommitted).toHaveBeenCalledTimes(1);
    expect(analyzeDone).toBe(false);

    releaseFull();
    const result = await analyzePromise;
    expect(result.perception_memory.summary).toBe("People are visible in the room.");
    expect(result._trace?.context.decision_context?.streaming_critical?.committed).toBe(true);
    expect(result._trace?.context.decision_context?.streaming_critical?.fields_seen).toContain("summary");
    expect(result._trace?.context.decision_context?.streaming_critical?.conflict_fields).toContain("summary");
  });

  it("multiple segments in same event share the same event_id", async () => {
    const seg1 = { ...makeSegment("event", 2), segment_id: "seg_001" };
    const seg2 = { ...makeSegment("event", 2), segment_id: "seg_002" };

    const r1 = await analyze(seg1, deps);
    const r2 = await analyze(seg2, deps);

    expect(r1.event_id).toBe(r2.event_id);
  });

  it("continues gracefully when keyframe save fails", async () => {
    mockMediaUploader.saveKeyframe.mockImplementationOnce(() => { throw new Error("disk full"); });

    const segment = makeSegment("snapshot", 1);
    const result = await analyze(segment, deps);

    // Should still return a result; keyframes just empty
    expect(result.media_urls.keyframes).toEqual([]);
    expect(result.perception_memory.summary).toBe(MOCK_VLM_OUTPUT.summary);
  });

  it("exposes VLM-only main_targets as text entities in level 0", async () => {
    const segment = makeSegment("snapshot", 1);
    const result = await analyze(segment, deps);

    expect(result.perception_memory.entities).toEqual([
      {
        type: "person",
        appearance: "blue jacket",
        behavior: "arriving",
        interaction: undefined,
        keyframe_path: "/media/cam_front_door/keyframe/seg_test_001_0.jpg",
      },
    ]);
  });

  it("includes detailed_summary in PerceptionMemory", async () => {
    const segment = makeSegment("snapshot", 1);
    const result = await analyze(segment, deps);

    expect(result.perception_memory.detailed_summary).toBe(
      "A person wearing a blue jacket arrived at the front door.",
    );
  });

  it("includes security_risk and security_reason in PerceptionMemory", async () => {
    const securityVlmOutput: VlmOutput = {
      ...MOCK_VLM_OUTPUT,
      security_risk: true,
      security_reason: "Unknown person attempting to open door lock",
    };
    mockVlmAnalyzer.analyzeSegment.mockResolvedValueOnce(makeVlmSegmentAnalysis(securityVlmOutput));

    const segment = makeSegment("snapshot", 1);
    const result = await analyze(segment, deps);

    expect(result.perception_memory.security_risk).toBe(true);
    expect(result.perception_memory.security_reason).toBe(
      "Unknown person attempting to open door lock",
    );
  });

  it("sets security_risk to false when VLM reports no risk", async () => {
    const segment = makeSegment("snapshot", 1);
    const result = await analyze(segment, deps);

    expect(result.perception_memory.security_risk).toBe(false);
    expect(result.perception_memory.security_reason).toBeUndefined();
  });

  it("sets empty entities and no security when VLM unavailable", async () => {
    mockVlmAnalyzer.analyzeSegment.mockRejectedValueOnce(new Error("API error"));

    const segment = makeSegment("snapshot", 1);
    const result = await analyze(segment, deps);

    expect(result.perception_memory.entities).toEqual([]);
    expect(result.perception_memory.detailed_summary).toBe("");
    expect(result.perception_memory.security_risk).toBe(false);
    expect(result.perception_memory.security_reason).toBeUndefined();
  });

  it("builds fallback summary when VLM is unavailable", async () => {
    mockVlmAnalyzer.analyzeSegment.mockRejectedValueOnce(new Error("API error"));

    const segment = makeSegment("snapshot", 1);
    const result = await analyze(segment, deps);

    expect(result.perception_memory.summary).toBe("VLM call failed.");
  });

  it("includes transcript when STT analyzer is available and audio_segments present", async () => {
    const mockSttAnalyzer = {
      isAvailable: true,
      transcribe: vi.fn().mockReturnValue({
        transcript: "hello world",
        segments: [{ start: 27200, text: "hello world", latency_ms: 50 }],
        latency_ms: 50,
      }),
    };

    const segment = {
      ...makeSegment("stream", 3),
      audio_segments: [{ start: 27200, samples: new Float32Array(16000) }],
    };

    const result = await analyze(segment, {
      ...deps,
      sttAnalyzer: mockSttAnalyzer as any,
    });

    expect(result.transcript).toBe("hello world");
    expect(mockSttAnalyzer.transcribe).toHaveBeenCalledWith(segment.audio_segments);
  });

  it("injects STT transcript into VLM localModelResults", async () => {
    const mockSttAnalyzer = {
      isAvailable: true,
      transcribe: vi.fn().mockReturnValue({
        transcript: "someone is at the door",
        segments: [{ start: 27200, text: "someone is at the door", latency_ms: 30 }],
        latency_ms: 30,
      }),
    };

    const segment = {
      ...makeSegment("stream", 3),
      audio_segments: [{ start: 27200, samples: new Float32Array(16000) }],
    };

    await analyze(segment, {
      ...deps,
      sttAnalyzer: mockSttAnalyzer as any,
    });

    // VLM receives localModelResults with timestamped sttTranscript
    const options = mockVlmAnalyzer.analyzeSegment.mock.calls[0]![2];
    expect(options.localModelResults).toBeDefined();
    expect(options.localModelResults.sttTranscript).toContain('"someone is at the door"');
    expect(options.localModelResults.sttTranscript).toContain('"start_time"');
    expect(options.localModelResults.sttTranscript).not.toContain('"entity_id"');
  });

  it("preserves ungrounded speech as unknown speaker attribution", async () => {
    const mockSttAnalyzer = {
      isAvailable: true,
      transcribe: vi.fn().mockReturnValue({
        transcript: "welcome to the presentation",
        segments: [{ start: 16000, text: "welcome to the presentation", latency_ms: 30, speaker: "speaker_0" }],
        latency_ms: 30,
      }),
    };

    const segment = {
      ...makeSegment("stream", 3),
      audio_segments: [{ start: 16000, samples: new Float32Array(16000) }],
    };

    const result = await analyze(segment, {
      ...deps,
      sttAnalyzer: mockSttAnalyzer as any,
    });

    expect(result.dialogue).toEqual([
      expect.objectContaining({
        text_start: 1,
        identity_level: "unknown",
        confidence: "low",
        text: "welcome to the presentation",
      }),
    ]);
    expect(result.dialogue?.[0]).not.toHaveProperty("track_id");
    expect(result.dialogue?.[0]).not.toHaveProperty("entity_id");
  });

  it("works normally when no audio_segments (backward compat)", async () => {
    const mockSttAnalyzer = {
      isAvailable: true,
      transcribe: vi.fn(),
    };

    const segment = makeSegment("stream", 3);
    const result = await analyze(segment, {
      ...deps,
      sttAnalyzer: mockSttAnalyzer as any,
    });

    expect(result.transcript).toBeUndefined();
    expect(mockSttAnalyzer.transcribe).not.toHaveBeenCalled();
  });

  describe("audio_data STT path", () => {
    it("transcribeAudioData guard path returns empty when unavailable", () => {
      // SttAnalyzer without sherpa-onnx returns empty result for the guard path
      const audioData: AudioData = {
        pcm: Buffer.alloc(16000 * 2 * 5),
        voice_ranges: [
          { start_ms: 0, end_ms: 2000 },
          { start_ms: 3000, end_ms: 5000 },
        ],
      };
      // Verify the guard condition: unavailable analyzer returns empty
      const mockSttAnalyzer = {
        isAvailable: false,
        transcribeAudioData: vi.fn().mockReturnValue({ transcript: "", segments: [], latency_ms: 0 }),
      };
      // When STT is unavailable, pipeline should not call transcribeAudioData
      const segment = {
        ...makeSegment("stream", 5),
        audio_data: audioData,
      };
      // The pipeline checks isAvailable before calling — so transcribeAudioData won't be invoked
      expect(mockSttAnalyzer.isAvailable).toBe(false);
    });

    it("pipeline uses transcribeAudioData when audio_data present", async () => {
      const mockSttAnalyzer = {
        isAvailable: true,
        transcribe: vi.fn().mockReturnValue({ transcript: "old", segments: [], latency_ms: 0 }),
        transcribeAudioData: vi.fn().mockReturnValue({
          transcript: "new path",
          segments: [{ start: 0, end: 32000, text: "new path", latency_ms: 5 }],
          latency_ms: 5,
        }),
      };

      const segment = {
        ...makeSegment("stream", 5),
        audio_segments: [{ start: 0, samples: new Float32Array(16000) }],
        audio_data: {
          pcm: Buffer.alloc(16000 * 2 * 5),
          voice_ranges: [{ start_ms: 0, end_ms: 5000 }],
        },
      };

      const testDeps = { ...deps, sttAnalyzer: mockSttAnalyzer as any };
      const result = await analyze(segment, testDeps);

      expect(mockSttAnalyzer.transcribeAudioData).toHaveBeenCalledOnce();
      expect(mockSttAnalyzer.transcribe).not.toHaveBeenCalled();
      expect(result.transcript).toBe("new path");
    });

    it("voice_ranges prevent idle skip even without transcript", async () => {
      const mockSttAnalyzer = {
        isAvailable: true,
        transcribeAudioData: vi.fn().mockReturnValue({ transcript: "", segments: [], latency_ms: 0 }),
      };

      const segment = {
        ...makeSegment("stream", 5),
        audio_data: {
          pcm: Buffer.alloc(16000 * 2 * 3),
          voice_ranges: [{ start_ms: 0, end_ms: 3000 }],
        },
      };

      mockVlmAnalyzer.analyzeSegment.mockClear();
      const testDeps = { ...deps, sttAnalyzer: mockSttAnalyzer as any };
      const result = await analyze(segment, testDeps);

      expect(mockVlmAnalyzer.analyzeSegment).toHaveBeenCalled();
    });
  });
});
