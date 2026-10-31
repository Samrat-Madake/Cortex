import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FrameDetection, Segment } from "@reflectworld/shared";
import { WorkingMemoryManager } from "../working-memory.js";
import type { DetectionOutput, VlmOutput } from "../types.js";
import type { PipelineDeps } from "../pipeline.js";
import type { QualifiedFace } from "../analyzers/subject-proposal-analyzer.js";

const analyzerMocks = vi.hoisted(() => ({
  runDetection: vi.fn(),
  runPerFrameFaceDetection: vi.fn(),
  runPerFaceReId: vi.fn(),
  collectFaceQualificationDebug: vi.fn(),
  collectQualifiedFaces: vi.fn(),
  measureFaceSharpness: vi.fn(),
}));

const WRITABLE_FACE_LANDMARKS = Array.from({ length: 5 }, (_, index) => ({
  x: 124 + index * 4,
  y: 106 + index * 3,
}));

vi.mock("../analyzers/detection-entry.js", () => ({
  runDetection: analyzerMocks.runDetection,
}));

vi.mock("../analyzers/detection-analyzer.js", () => ({
  runPerFrameFaceDetection: analyzerMocks.runPerFrameFaceDetection,
}));

vi.mock("../analyzers/reid-entry.js", () => ({
  runPerFaceReId: analyzerMocks.runPerFaceReId,
}));

vi.mock("../analyzers/subject-proposal-analyzer.js", () => ({
  collectFaceQualificationDebug: analyzerMocks.collectFaceQualificationDebug,
  collectQualifiedFaces: analyzerMocks.collectQualifiedFaces,
  measureFaceSharpness: analyzerMocks.measureFaceSharpness,
}));

function makeSegment(extraDetections: FrameDetection[] = []): Segment {
  return {
    segment_id: "seg_test",
    camera_id: "cam_test",
    mode: "stream",
    frames: Array.from({ length: 5 }, (_, index) => ({
      data: Buffer.from(`frame-${index}`).toString("base64"),
      timestamp: 1_000 + index,
      index,
      width: 640,
      height: 480,
      detections: [
        {
          label: "person",
          confidence: 0.9,
          bbox: { x1: 10, y1: 20, x2: 40, y2: 60 },
        },
        ...extraDetections,
      ],
    })),
    raw_url: "/raw/seg_test.mp4",
    timestamp: 1_000,
    duration_sec: 5,
  };
}

function makeCluster(opts: {
  frameIndex: number;
  personBbox: { x: number; y: number; width: number; height: number };
  faceBbox: { x: number; y: number; width: number; height: number };
  faceConfidence?: number;
}): QualifiedFace {
  return {
    frameIndex: opts.frameIndex,
    personBbox: opts.personBbox,
    faceBbox: opts.faceBbox,
    faceLandmarks: WRITABLE_FACE_LANDMARKS,
    faceConfidence: opts.faceConfidence ?? 0.95,
    faceAreaRatio: 0.01,
    sharpness: { laplacianVariance: 200, usableForReid: true },
  };
}

function makeDeps(overrides: Partial<{
  vlmData: VlmOutput;
  saveKeyframe: ReturnType<typeof vi.fn>;
  workingMemory: WorkingMemoryManager;
}> = {}): PipelineDeps {
  const vlm: VlmOutput = overrides.vlmData ?? {
    summary: "A person is visible.",
    detailed_summary: "A person faces the camera.",
    security_risk: false,
    is_static_scene: false,
    notify_user: false,
    main_targets: [],
    raw_response: "{}",
  };
  return {
    workingMemory: overrides.workingMemory ?? new WorkingMemoryManager({ event_timeout_sec: 30 }),
    strategyManager: {
      selectStrategy: () => ({
        level: 1,
        run_detection: true,
        run_reid: true,
        run_stt: false,
        run_vlm: true,
        vlm_model: "test-vlm",
      }),
    },
    router: {},
    vlmAnalyzer: {
      analyzeSegment: vi.fn().mockResolvedValue({
        normalizedJson: vlm.raw_response ?? "{}",
        output: vlm,
        latency_ms: 1,
      }),
    },
    mediaUploader: {
      saveKeyframe: overrides.saveKeyframe ?? vi.fn((cameraId: string, segmentId: string, frameIndex: number) =>
        `/media/${cameraId}/${segmentId}_${frameIndex}.jpg`
      ),
    },
  } as unknown as PipelineDeps;
}

describe("pipeline subject-proposal keyframes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no faces, no clusters
    analyzerMocks.runPerFrameFaceDetection.mockImplementation(async (_frames: unknown, detections: DetectionOutput[]) => ({
      detections,
      latency_ms: 1,
      debug: [],
    }));
    analyzerMocks.collectFaceQualificationDebug.mockReturnValue([]);
    analyzerMocks.collectQualifiedFaces.mockReturnValue([]);
    analyzerMocks.measureFaceSharpness.mockImplementation(async (faces: unknown[]) => ({ usable: faces, blurRejected: [] }));
    analyzerMocks.runPerFaceReId.mockResolvedValue([]);
  });

  it("produces empty entities when no face clusters exist", async () => {
    const { analyze } = await import("../pipeline.js");

    const vlmData: VlmOutput = {
      summary: "A person is visible.",
      detailed_summary: "A person walks through the frame.",
      security_risk: false,
      is_static_scene: false,
      notify_user: false,
      main_targets: [
        { type: "person", appearance: "dark clothing", behavior: "walking", track_id: "some_id" },
      ],
      raw_response: "{}",
    };

    const result = await analyze(makeSegment(), makeDeps({ vlmData }));
    expect(result.perception_memory.entities).toEqual([]);
  });

  it("uses VLM-only fallback without direct track input when L1 has detections but no router", async () => {
    const { analyze } = await import("../pipeline.js");

    const vlm: VlmOutput = {
      summary: "A laptop is visible.",
      detailed_summary: "A person is near a laptop.",
      security_risk: false,
      is_static_scene: false,
      notify_user: false,
      main_targets: [],
      raw_response: "{}",
    };
    const vlmAnalyze = vi.fn().mockResolvedValue({ normalizedJson: "{}", output: vlm, latency_ms: 1 });

    const deps = {
      workingMemory: new WorkingMemoryManager({ event_timeout_sec: 30 }),
      strategyManager: {
        selectStrategy: () => ({
          level: 1,
          run_detection: true,
          run_reid: true,
          run_stt: false,
          run_vlm: true,
          vlm_model: "test-vlm",
        }),
      },
      vlmAnalyzer: { analyzeSegment: vlmAnalyze },
      mediaUploader: { saveKeyframe: vi.fn().mockReturnValue("/media/keyframe.jpg") },
    } as unknown as PipelineDeps;

    await analyze(makeSegment([
      {
        label: "person",
        confidence: 0.92,
        bbox: { x1: 100, y1: 80, x2: 260, y2: 360 },
      },
      {
        label: "laptop",
        confidence: 0.8,
        bbox: { x1: 100, y1: 120, x2: 220, y2: 180 },
      },
    ]), deps);

    expect(analyzerMocks.runDetection).not.toHaveBeenCalled();
    const vlmOpts = vlmAnalyze.mock.calls[0]?.[2] as {
      localModelResults?: { detectionOutput?: DetectionOutput };
      subjectProposal?: unknown;
    };
    expect(vlmOpts.localModelResults?.detectionOutput).toBeUndefined();
    expect(vlmOpts.subjectProposal).toBeUndefined();
  });

  it("uses subject proposal when router and detections are available", async () => {
    const { analyze } = await import("../pipeline.js");

    const faceLow = makeCluster({
      frameIndex: 0,
      personBbox: { x: 100, y: 80, width: 160, height: 280 },
      faceBbox: { x: 120, y: 100, width: 32, height: 36 },
    });
    const faceHigh = makeCluster({
      frameIndex: 1,
      personBbox: { x: 100, y: 80, width: 160, height: 280 },
      faceBbox: { x: 125, y: 104, width: 34, height: 38 },
    });
    analyzerMocks.collectQualifiedFaces.mockReturnValue([faceLow, faceHigh]);
    analyzerMocks.runPerFaceReId.mockResolvedValue([{
      face: faceLow,
      embedding: [0.1, 0.2, 0.3],
      pose: { yaw: 8, pitch: 4, roll: 0 },
      quality: 0.9,
      entity_id: "entity_alex",
      confidence: 0.81,
      history_behavior: "Patterns: often presents slides from the left side. Recent: discussed the agenda.",
    }, {
      face: faceHigh,
      embedding: [0.4, 0.5, 0.6],
      pose: { yaw: 4, pitch: 2, roll: 0 },
      quality: 0.95,
      entity_id: "entity_taylor",
      confidence: 0.96,
      history_behavior: "Patterns: often gestures while talking. Recent: answered questions.",
    }]);

    const subjectProposalRaw = JSON.stringify({
      summary: "A person is near a laptop.",
      detailed_summary: "A person stands beside a laptop.",
      security_risk: false,
      is_static_scene: false,
      notify_user: false,
      targets: [{
        type: "person",
        bbox_ids: ["D0"],
        matched_wm_target: null,
        identity: { name: "Alex", evidence: "speaker says their name is Alex", source: "self_introduction" },
        speaker_ids: ["speaker_0"],
        appearance: "person in the room",
        behavior: "standing near a laptop",
      }, {
        type: "person",
        bbox_ids: ["D1"],
        matched_wm_target: null,
        identity: { name: "Taylor", evidence: "Taylor is addressed and immediately responds", source: "direct_address_response" },
        speaker_ids: ["speaker_1"],
        appearance: "same person in the next frame",
        behavior: "standing",
      }],
    });
    const vlmAnalyze = vi.fn().mockResolvedValue({ normalizedJson: subjectProposalRaw, output: {
        summary: "A laptop is visible.",
        detailed_summary: "A person is near a laptop.",
        security_risk: false,
        is_static_scene: false,
        notify_user: false,
        main_targets: [],
        raw_response: "{}",
      } satisfies VlmOutput, latency_ms: 1 });

    const reidUpdateIdentity = vi.fn().mockResolvedValue(undefined);
    const deps = {
      ...makeDeps(),
      vlmAnalyzer: { analyzeSegment: vlmAnalyze },
      memory: { reidUpdateIdentity },
      subjectRegistry: {
        createSession: () => ({
          resolve: (input: { category: string; entity_id?: string; name?: string }) => ({
            category: input.category,
            subject_index: input.entity_id === "entity_taylor" ? 2 : 1,
            name: input.name,
            first_seen: 1_000,
          }),
          commit: vi.fn(),
        }),
      },
    } as unknown as PipelineDeps;

    const result = await analyze(makeSegment([
      {
        label: "person",
        confidence: 0.92,
        bbox: { x1: 100, y1: 80, x2: 260, y2: 360 },
      },
      {
        label: "laptop",
        confidence: 0.8,
        bbox: { x1: 100, y1: 120, x2: 220, y2: 180 },
      },
    ]), deps);

    const vlmOpts = vlmAnalyze.mock.calls[0]?.[2] as {
      localModelResults?: { detectionOutput?: DetectionOutput };
      subjectProposal?: { didContext?: string };
    };
    expect(vlmOpts.localModelResults?.detectionOutput).toBeUndefined();
    expect(vlmOpts.subjectProposal?.didContext).toContain("Current segment visual evidence");
    expect(vlmOpts.subjectProposal?.didContext).toContain("possible D{id}s=[D0]");
    expect(vlmOpts.subjectProposal?.didContext).toContain("Machine candidate links from ReID without a working-memory participant:");
    expect(vlmOpts.subjectProposal?.didContext).toContain("entity_alex");
    expect(vlmOpts.subjectProposal?.didContext).toContain("entity_taylor");
    expect(vlmOpts.subjectProposal?.didContext).toContain("Patterns: often presents slides");
    expect(vlmOpts.subjectProposal?.didContext).not.toContain("laptop");

    expect(result.perception_memory.entities).toEqual([
      expect.objectContaining({
        type: "person",
        appearance: "person in the room",
        behavior: "standing near a laptop",
        track_id: "D0",
        entity_id: "entity_alex",
        bbox: { x: 100, y: 80, width: 160, height: 280 },
        face_bbox: { x: 120, y: 100, width: 32, height: 36 },
        keyframe_path: "/media/cam_test/seg_test_0.jpg",
      }),
      expect.objectContaining({
        type: "person",
        appearance: "same person in the next frame",
        behavior: "standing",
        track_id: "D1",
        entity_id: "entity_taylor",
        bbox: { x: 100, y: 80, width: 160, height: 280 },
        face_bbox: { x: 125, y: 104, width: 34, height: 38 },
        keyframe_path: "/media/cam_test/seg_test_1.jpg",
      }),
    ]);
    expect(result.dialogue).toBeUndefined();
    expect(result.perception_memory.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        track_id: "D0",
        entity_id: "entity_alex",
        name: "Alex",
      }),
      expect.objectContaining({
        track_id: "D1",
        entity_id: "entity_taylor",
        name: "Taylor",
      }),
    ]));
    expect(reidUpdateIdentity).toHaveBeenCalledWith("entity_alex", "Alex", { subject_index: 1 });
    expect(reidUpdateIdentity).toHaveBeenCalledWith("entity_taylor", "Taylor", { subject_index: 2 });
  });

  it("does not expose conflicting display-only D ids as entity sightings", async () => {
    const { analyze } = await import("../pipeline.js");

    const face = makeCluster({
      frameIndex: 0,
      personBbox: { x: 100, y: 80, width: 160, height: 280 },
      faceBbox: { x: 120, y: 100, width: 32, height: 36 },
    });
    analyzerMocks.collectQualifiedFaces.mockReturnValue([face]);
    analyzerMocks.runPerFaceReId.mockResolvedValue([{
      face,
      embedding: [0.1, 0.2, 0.3],
      pose: { yaw: 4, pitch: 2, roll: 0 },
      quality: 0.95,
      entity_id: "entity_other",
      confidence: 0.96,
    }]);

    const workingMemory = new WorkingMemoryManager({ event_timeout_sec: 30 });
    workingMemory.onSegmentArrived("cam_test", "stream", 900);
    workingMemory.upsertTarget("cam_test", {
      target_id: "wm_t1",
      entity_id: "entity_host",
      class_name: "person",
      appearance: "host from previous segment",
      crop_path: "/media/host_previous.jpg",
      last_seen_segment_id: "seg_prev",
      last_seen_timestamp: 900,
      segments_seen: 1,
      segments_missed: 0,
    });

    const subjectProposalRaw = JSON.stringify({
      summary: "The host continues speaking.",
      detailed_summary: "The host continues speaking in the interview.",
      security_risk: false,
      is_static_scene: false,
      notify_user: false,
      targets: [{
        type: "person",
        bbox_ids: ["D0"],
        matched_wm_target: "wm_t1",
        appearance: "host semantic target",
        behavior: "speaking",
      }],
    });
    const vlmAnalyze = vi.fn().mockResolvedValue({
      normalizedJson: subjectProposalRaw,
      output: {
        summary: "The host continues speaking.",
        detailed_summary: "The host continues speaking in the interview.",
        security_risk: false,
        is_static_scene: false,
        notify_user: false,
        main_targets: [],
        raw_response: subjectProposalRaw,
      } satisfies VlmOutput,
      latency_ms: 1,
    });

    const deps = {
      ...makeDeps({
        workingMemory,
        vlmData: {
          summary: "The host continues speaking.",
          detailed_summary: "The host continues speaking in the interview.",
          security_risk: false,
          is_static_scene: false,
          notify_user: false,
          main_targets: [],
          raw_response: subjectProposalRaw,
        },
      }),
      vlmAnalyzer: { analyzeSegment: vlmAnalyze },
    } as unknown as PipelineDeps;

    const result = await analyze(makeSegment(), deps);

    expect(result.perception_memory.entities).toEqual([]);
    expect(workingMemory.getTargets("cam_test")[0]).toMatchObject({
      target_id: "wm_t1",
      entity_id: "entity_host",
    });
  });

  it("does not attach previous WM crop_path images without stable crop history", async () => {
    const { analyze } = await import("../pipeline.js");

    const workingMemory = new WorkingMemoryManager({ event_timeout_sec: 30 });
    workingMemory.onSegmentArrived("cam_test", "stream", 500);
    for (const [target_id, appearance] of [
      ["wm_t1", "person in a red jacket"],
      ["wm_t2", "person in a blue jacket"],
    ] as const) {
      workingMemory.upsertTarget("cam_test", {
        target_id,
        class_name: "person",
        appearance,
        crop_path: `/media/${target_id}_previous.jpg`,
        last_seen_segment_id: "seg_prev",
        last_seen_timestamp: 500,
        segments_seen: 1,
        segments_missed: 0,
      });
    }

    const vlmAnalyze = vi.fn().mockResolvedValue({
      normalizedJson: JSON.stringify({
        summary: "Two people are visible.",
        detailed_summary: "Two people are visible.",
        security_risk: false,
        is_static_scene: false,
        notify_user: false,
        targets: [],
      }),
      output: {
        summary: "Two people are visible.",
        detailed_summary: "Two people are visible.",
        security_risk: false,
        is_static_scene: false,
        notify_user: false,
        main_targets: [],
        raw_response: "{}",
      } satisfies VlmOutput,
      latency_ms: 1,
    });

    await analyze(makeSegment([
      {
        label: "person",
        confidence: 0.92,
        bbox: { x1: 100, y1: 80, x2: 260, y2: 360 },
      },
    ]), {
      ...makeDeps({ workingMemory }),
      vlmAnalyzer: { analyzeSegment: vlmAnalyze },
    } as unknown as PipelineDeps);

    const vlmOpts = vlmAnalyze.mock.calls[0]?.[2] as {
      subjectProposal?: {
        wmTargets?: Array<{ crop_base64?: string; crop_base64s?: string[] }>;
      };
    };
    expect(vlmOpts.subjectProposal?.wmTargets).toHaveLength(2);
    expect(vlmOpts.subjectProposal?.wmTargets?.some((target) => target.crop_base64 || target.crop_base64s?.length)).toBe(false);
  });

  it("attaches stable WM crop images during early single-target continuity", async () => {
    const { analyze } = await import("../pipeline.js");
    const tempDir = mkdtempSync(join(tmpdir(), "wm-early-crop-"));
    try {
      const stableCropPath = join(tempDir, "stable-person.jpg");
      writeFileSync(stableCropPath, Buffer.from("stable-person-crop"));

      const workingMemory = new WorkingMemoryManager({ event_timeout_sec: 30 });
      workingMemory.onSegmentArrived("cam_test", "stream", 500);
      workingMemory.upsertTarget("cam_test", {
        target_id: "wm_t1",
        class_name: "person",
        appearance: "person entering the office",
        crop_path: stableCropPath,
        stable_crops: [{
          crop_path: stableCropPath,
          segment_id: "seg_prev",
          did: "D0",
          score: 0.9,
          source: "body",
          timestamp: 500,
        }],
        last_seen_segment_id: "seg_prev",
        last_seen_timestamp: 500,
        segments_seen: 1,
        segments_missed: 0,
      });

      const vlmAnalyze = vi.fn().mockResolvedValue({
        normalizedJson: JSON.stringify({
          summary: "A person remains visible.",
          detailed_summary: "A person remains visible.",
          security_risk: false,
          is_static_scene: false,
          notify_user: false,
          targets: [],
        }),
        output: {
          summary: "A person remains visible.",
          detailed_summary: "A person remains visible.",
          security_risk: false,
          is_static_scene: false,
          notify_user: false,
          main_targets: [],
          raw_response: "{}",
        } satisfies VlmOutput,
        latency_ms: 1,
      });

      await analyze(makeSegment([
        {
          label: "person",
          confidence: 0.92,
          bbox: { x1: 100, y1: 80, x2: 260, y2: 360 },
        },
      ]), {
        ...makeDeps({ workingMemory }),
        vlmAnalyzer: { analyzeSegment: vlmAnalyze },
      } as unknown as PipelineDeps);

      const vlmOpts = vlmAnalyze.mock.calls[0]?.[2] as {
        subjectProposal?: {
          wmTargets?: Array<{ target_id: string; crop_base64?: string; crop_base64s?: string[] }>;
        };
      };
      const wmTarget = vlmOpts.subjectProposal?.wmTargets?.find((target) => target.target_id === "wm_t1");
      const expectedCrop = Buffer.from("stable-person-crop").toString("base64");
      expect(wmTarget?.crop_base64).toBe(expectedCrop);
      expect(wmTarget?.crop_base64s).toEqual([expectedCrop]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves stable WM crop order when attaching target images", async () => {
    const { analyze } = await import("../pipeline.js");
    const tempDir = mkdtempSync(join(tmpdir(), "wm-crops-"));
    try {
      const recentBodyCrop = join(tempDir, "recent-body.jpg");
      const olderBodyCrop = join(tempDir, "older-body.jpg");
      writeFileSync(recentBodyCrop, Buffer.from("recent-body-crop"));
      writeFileSync(olderBodyCrop, Buffer.from("older-body-crop"));

      const workingMemory = new WorkingMemoryManager({ event_timeout_sec: 30 });
      workingMemory.onSegmentArrived("cam_test", "stream", 500);
      workingMemory.upsertTarget("cam_test", {
        target_id: "wm_t1",
        class_name: "person",
        appearance: "host at a desk",
        crop_path: olderBodyCrop,
        stable_crops: [
          {
            crop_path: recentBodyCrop,
            segment_id: "seg_recent",
            did: "D4",
            score: 0.2,
            source: "body",
            timestamp: 2_000,
          },
          {
            crop_path: olderBodyCrop,
            segment_id: "seg_older",
            did: "D2",
            score: 0.9,
            source: "body",
            timestamp: 1_000,
          },
        ],
        last_seen_segment_id: "seg_older",
        last_seen_timestamp: 1_000,
        segments_seen: 2,
        segments_missed: 0,
      });
      workingMemory.upsertTarget("cam_test", {
        target_id: "wm_t2",
        class_name: "person",
        appearance: "guest at a desk",
        crop_path: olderBodyCrop,
        last_seen_segment_id: "seg_older",
        last_seen_timestamp: 1_000,
        segments_seen: 2,
        segments_missed: 0,
      });

      const vlmAnalyze = vi.fn().mockResolvedValue({
        normalizedJson: JSON.stringify({
          summary: "The host is visible.",
          detailed_summary: "The host is visible.",
          security_risk: false,
          is_static_scene: false,
          notify_user: false,
          targets: [],
        }),
        output: {
          summary: "The host is visible.",
          detailed_summary: "The host is visible.",
          security_risk: false,
          is_static_scene: false,
          notify_user: false,
          main_targets: [],
          raw_response: "{}",
        } satisfies VlmOutput,
        latency_ms: 1,
      });

      await analyze(makeSegment([
        {
          label: "person",
          confidence: 0.92,
          bbox: { x1: 100, y1: 80, x2: 260, y2: 360 },
        },
        {
          label: "person",
          confidence: 0.91,
          bbox: { x1: 320, y1: 90, x2: 470, y2: 360 },
        },
      ]), {
        ...makeDeps({ workingMemory }),
        vlmAnalyzer: { analyzeSegment: vlmAnalyze },
      } as unknown as PipelineDeps);

      const vlmOpts = vlmAnalyze.mock.calls[0]?.[2] as {
        subjectProposal?: {
          wmTargets?: Array<{ target_id: string; crop_base64s?: string[] }>;
        };
      };
      const wmTarget = vlmOpts.subjectProposal?.wmTargets?.find((target) => target.target_id === "wm_t1");
      expect(wmTarget?.crop_base64s).toEqual([
        Buffer.from("recent-body-crop").toString("base64"),
        Buffer.from("older-body-crop").toString("base64"),
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps distinct diarization speakers from sharing one canonical target", async () => {
    const { analyze } = await import("../pipeline.js");

    const subjectProposalRaw = JSON.stringify({
      summary: "Two speakers discuss a panel topic.",
      detailed_summary: "Two diarized speakers are heard while one visible target group is proposed.",
      security_risk: false,
      is_static_scene: false,
      notify_user: false,
      targets: [{
        type: "person",
        bbox_ids: ["D0", "D1"],
        matched_wm_target: null,
        speaker_ids: ["speaker_0", "speaker_1"],
        appearance: "panel speakers",
        behavior: "talking",
      }],
    });
    const vlmAnalyze = vi.fn().mockResolvedValue({
      normalizedJson: subjectProposalRaw,
      output: {
        summary: "Two speakers discuss a panel topic.",
        detailed_summary: "Two diarized speakers are heard while one visible target group is proposed.",
        security_risk: false,
        is_static_scene: false,
        notify_user: false,
        main_targets: [],
        raw_response: "{}",
      } satisfies VlmOutput,
      latency_ms: 1,
    });
    const sttAnalyzer = {
      isAvailable: true,
      transcribe: vi.fn().mockReturnValue({
        transcript: "first speaker line second speaker line",
        segments: [
          { start: 0, text: "first speaker line", latency_ms: 10, speaker: "speaker_0" },
          { start: 16000, text: "second speaker line", latency_ms: 10, speaker: "speaker_1" },
        ],
        latency_ms: 10,
      }),
    };
    const deps = {
      ...makeDeps(),
      strategyManager: {
        selectStrategy: () => ({
          level: 1,
          run_detection: true,
          run_reid: true,
          run_stt: true,
          run_vlm: true,
          vlm_model: "test-vlm",
        }),
      },
      sttAnalyzer,
      vlmAnalyzer: { analyzeSegment: vlmAnalyze },
    } as unknown as PipelineDeps;

    const segment = {
      ...makeSegment([
        {
          label: "person",
          confidence: 0.91,
          bbox: { x1: 100, y1: 80, x2: 260, y2: 360 },
        },
      ]),
      audio_segments: [{ start: 0, samples: new Float32Array(32000) }],
    };
    const result = await analyze(segment, deps);

    expect(result.dialogue).toEqual([
      expect.objectContaining({
        text_start: 0,
        track_id: "D0",
        identity_level: "event_local",
        confidence: "high",
        text: "first speaker line",
      }),
      expect.objectContaining({
        text_start: 1,
        identity_level: "unknown",
        confidence: "low",
        text: "second speaker line",
      }),
    ]);
    expect(result.dialogue?.[1]).not.toHaveProperty("track_id");
  });

  it("merges VLM targets that resolve to the same ReID entity before output", async () => {
    const { analyze } = await import("../pipeline.js");

    const faceA = makeCluster({
      frameIndex: 0,
      personBbox: { x: 100, y: 80, width: 160, height: 280 },
      faceBbox: { x: 120, y: 100, width: 32, height: 36 },
    });
    const faceB = makeCluster({
      frameIndex: 1,
      personBbox: { x: 102, y: 82, width: 158, height: 278 },
      faceBbox: { x: 125, y: 104, width: 34, height: 38 },
    });
    analyzerMocks.collectQualifiedFaces.mockReturnValue([faceA, faceB]);
    analyzerMocks.runPerFaceReId.mockResolvedValue([{
      face: faceA,
      embedding: [0.1, 0.2, 0.3],
      pose: { yaw: 8, pitch: 4, roll: 0 },
      quality: 0.8,
      entity_id: "entity_shared_person",
      confidence: 0.91,
    }, {
      face: faceB,
      embedding: [0.4, 0.5, 0.6],
      pose: { yaw: 4, pitch: 2, roll: 0 },
      quality: 0.96,
      entity_id: "entity_shared_person",
      confidence: 0.95,
    }]);

    const subjectProposalRaw = JSON.stringify({
      summary: "The same person appears across two frames.",
      detailed_summary: "The same person is mistakenly split into two VLM targets.",
      security_risk: false,
      is_static_scene: false,
      notify_user: false,
      targets: [{
        type: "person",
        bbox_ids: ["D0"],
        matched_wm_target: null,
        appearance: "person in first frame",
        behavior: "standing",
      }, {
        type: "person",
        bbox_ids: ["D1"],
        matched_wm_target: null,
        appearance: "same person in second frame",
        behavior: "standing in a later frame",
      }],
    });
    const vlmAnalyze = vi.fn().mockResolvedValue({
      normalizedJson: subjectProposalRaw,
      output: {
        summary: "The same person appears across two frames.",
        detailed_summary: "The same person is mistakenly split into two VLM targets.",
        security_risk: false,
        is_static_scene: false,
        notify_user: false,
        main_targets: [],
        raw_response: "{}",
      } satisfies VlmOutput,
      latency_ms: 1,
    });
    const deps = {
      ...makeDeps(),
      vlmAnalyzer: { analyzeSegment: vlmAnalyze },
    } as unknown as PipelineDeps;

    const segment = makeSegment();
    segment.frames = segment.frames.map((frame, index) => ({
      ...frame,
      detections: index === 0
        ? [{
            label: "person",
            confidence: 0.92,
            bbox: { x1: 100, y1: 80, x2: 260, y2: 360 },
          }]
        : index === 1
          ? [{
              label: "person",
              confidence: 0.91,
              bbox: { x1: 102, y1: 82, x2: 260, y2: 360 },
            }]
          : [],
    }));
    const result = await analyze(segment, deps);

    expect(result.perception_memory.entities).toHaveLength(1);
    expect(result.perception_memory.entities[0]).toEqual(expect.objectContaining({
      entity_id: "entity_shared_person",
      track_id: "D1",
      appearance: "same person in second frame",
    }));
  });

  it("blocks identity writes when one VLM target carries conflicting names", async () => {
    const { analyze } = await import("../pipeline.js");

    const faceA = makeCluster({
      frameIndex: 0,
      personBbox: { x: 100, y: 80, width: 160, height: 280 },
      faceBbox: { x: 120, y: 100, width: 32, height: 36 },
    });
    const faceB = makeCluster({
      frameIndex: 1,
      personBbox: { x: 100, y: 80, width: 160, height: 280 },
      faceBbox: { x: 125, y: 104, width: 34, height: 38 },
    });
    analyzerMocks.collectQualifiedFaces.mockReturnValue([faceA, faceB]);
    analyzerMocks.runPerFaceReId.mockResolvedValue([{
      face: faceA,
      embedding: [0.1, 0.2, 0.3],
      pose: { yaw: 8, pitch: 4, roll: 0 },
      quality: 0.9,
      entity_id: "entity_guest",
      confidence: 0.91,
    }, {
      face: faceB,
      embedding: [0.4, 0.5, 0.6],
      pose: { yaw: 8, pitch: 4, roll: 0 },
      quality: 0.91,
      entity_id: "entity_guest",
      confidence: 0.92,
    }]);

    const subjectProposalRaw = JSON.stringify({
      summary: "Two lower-third names appear while one target group is visible.",
      detailed_summary: "The segment shows a panel discussion with two names on screen.",
      security_risk: false,
      is_static_scene: false,
      notify_user: false,
      targets: [{
        type: "person",
        bbox_ids: ["D0", "D1"],
        matched_wm_target: null,
        appearance: "panel guest",
        behavior: "speaking during the panel",
      }],
    });
    const vlmAnalyze = vi.fn().mockResolvedValue({
      normalizedJson: subjectProposalRaw,
      output: {
        summary: "A panel guest speaks.",
        detailed_summary: "A panel guest speaks while lower-third text shows multiple names.",
        security_risk: false,
        is_static_scene: false,
        notify_user: false,
        main_targets: [],
        raw_response: "{}",
      } satisfies VlmOutput,
      latency_ms: 1,
    });
    const reidUpdateIdentity = vi.fn().mockResolvedValue(undefined);

    const deps = {
      ...makeDeps(),
      vlmAnalyzer: { analyzeSegment: vlmAnalyze },
      memory: { reidUpdateIdentity },
    } as unknown as PipelineDeps;

    const result = await analyze(makeSegment([
      {
        label: "person",
        confidence: 0.92,
        bbox: { x1: 100, y1: 80, x2: 260, y2: 360 },
      },
    ]), deps);

    expect(result.perception_memory.entities[0]?.name).toBeUndefined();
    expect(reidUpdateIdentity).not.toHaveBeenCalled();
  });

  it("does not promote a non-canonical D id name to the canonical target entity", async () => {
    const { analyze } = await import("../pipeline.js");

    const faceA = makeCluster({
      frameIndex: 0,
      personBbox: { x: 100, y: 80, width: 160, height: 280 },
      faceBbox: { x: 120, y: 100, width: 32, height: 36 },
    });
    const faceB = makeCluster({
      frameIndex: 1,
      personBbox: { x: 280, y: 80, width: 160, height: 280 },
      faceBbox: { x: 310, y: 100, width: 32, height: 36 },
    });
    analyzerMocks.collectQualifiedFaces.mockReturnValue([faceA, faceB]);
    analyzerMocks.runPerFaceReId.mockResolvedValue([{
      face: faceA,
      embedding: [0.1, 0.2, 0.3],
      pose: { yaw: 8, pitch: 4, roll: 0 },
      quality: 0.9,
      entity_id: "entity_canonical_person",
      confidence: 0.91,
    }, {
      face: faceB,
      embedding: [0.4, 0.5, 0.6],
      pose: { yaw: 10, pitch: 2, roll: 0 },
      quality: 0.92,
      confidence: 0.93,
    }]);

    const subjectProposalRaw = JSON.stringify({
      summary: "A panel guest is visible while a lower-third name is ambiguous.",
      detailed_summary: "A target group contains a known ReID face and a different named D id.",
      security_risk: false,
      is_static_scene: false,
      notify_user: false,
      targets: [{
        type: "person",
        bbox_ids: ["D0", "D1"],
        matched_wm_target: null,
        appearance: "panel participant",
        behavior: "speaking",
      }],
    });
    const vlmAnalyze = vi.fn().mockResolvedValue({
      normalizedJson: subjectProposalRaw,
      output: {
        summary: "A panel guest is visible.",
        detailed_summary: "A target group contains mixed identity evidence.",
        security_risk: false,
        is_static_scene: false,
        notify_user: false,
        main_targets: [],
        raw_response: "{}",
      } satisfies VlmOutput,
      latency_ms: 1,
    });
    const reidUpdateIdentity = vi.fn().mockResolvedValue(undefined);

    const deps = {
      ...makeDeps(),
      vlmAnalyzer: { analyzeSegment: vlmAnalyze },
      memory: { reidUpdateIdentity },
    } as unknown as PipelineDeps;

    const segment = makeSegment();
    segment.frames = segment.frames.map((frame, index) => ({
      ...frame,
      detections: index === 0
        ? [{
            label: "person",
            confidence: 0.92,
            bbox: { x1: 100, y1: 80, x2: 260, y2: 360 },
          }]
        : index === 1
          ? [{
              label: "person",
              confidence: 0.91,
              bbox: { x1: 280, y1: 80, x2: 440, y2: 360 },
            }]
          : [],
    }));

    const result = await analyze(segment, deps);

    expect(result.perception_memory.entities[0]).toEqual(expect.objectContaining({
      entity_id: "entity_canonical_person",
      track_id: "D0",
    }));
    expect(result.perception_memory.entities[0]).not.toHaveProperty("name");
    expect(reidUpdateIdentity).not.toHaveBeenCalled();

    const nextResult = await analyze(segment, deps);
    expect(nextResult.perception_memory.entities[0]).not.toHaveProperty("name");
  });

  it("blocks one name from being written to multiple VLM targets in the same segment", async () => {
    const { analyze } = await import("../pipeline.js");

    const faceA = makeCluster({
      frameIndex: 0,
      personBbox: { x: 100, y: 80, width: 160, height: 280 },
      faceBbox: { x: 120, y: 100, width: 32, height: 36 },
    });
    const faceB = makeCluster({
      frameIndex: 1,
      personBbox: { x: 420, y: 80, width: 160, height: 280 },
      faceBbox: { x: 450, y: 100, width: 32, height: 36 },
    });
    analyzerMocks.collectQualifiedFaces.mockReturnValue([faceA, faceB]);
    analyzerMocks.runPerFaceReId.mockResolvedValue([{
      face: faceA,
      embedding: [0.1, 0.2, 0.3],
      pose: { yaw: 8, pitch: 4, roll: 0 },
      quality: 0.9,
      entity_id: "entity_left",
      confidence: 0.91,
    }, {
      face: faceB,
      embedding: [0.4, 0.5, 0.6],
      pose: { yaw: 5, pitch: 2, roll: 0 },
      quality: 0.92,
      entity_id: "entity_center",
      confidence: 0.93,
    }]);

    const subjectProposalRaw = JSON.stringify({
      summary: "Two panel guests are visible while one lower-third name is on screen.",
      detailed_summary: "Two panel guests are visible while the same lower-third name is ambiguously attributed.",
      security_risk: false,
      is_static_scene: false,
      notify_user: false,
      targets: [{
        type: "person",
        bbox_ids: ["D0"],
        matched_wm_target: null,
        identity: { name: "Jensen Huang", evidence: "spoken name is ambiguously assigned to one guest", source: "spoken" },
        speaker_ids: ["speaker_0"],
        appearance: "left panel guest",
        behavior: "listening",
      }, {
        type: "person",
        bbox_ids: ["D1"],
        matched_wm_target: null,
        identity: { name: "Jensen Huang", evidence: "same spoken name is also attributed to another guest", source: "spoken" },
        appearance: "center panel guest",
        behavior: "speaking",
      }, {
        type: "person",
        bbox_ids: ["D2"],
        matched_wm_target: null,
        identity: { name: "Jensen Huang", evidence: "same spoken name is also attributed to a third visible person", source: "spoken" },
        appearance: "right panel guest",
        behavior: "watching",
      }],
    });
    const vlmAnalyze = vi.fn().mockResolvedValue({
      normalizedJson: subjectProposalRaw,
      output: {
        summary: "Two panel guests are visible.",
        detailed_summary: "Two panel guests are visible with an ambiguous nameplate.",
        security_risk: false,
        is_static_scene: false,
        notify_user: false,
        main_targets: [],
        raw_response: "{}",
      } satisfies VlmOutput,
      latency_ms: 1,
    });
    const reidUpdateIdentity = vi.fn().mockResolvedValue(undefined);

    const deps = {
      ...makeDeps(),
      vlmAnalyzer: { analyzeSegment: vlmAnalyze },
      memory: { reidUpdateIdentity },
    } as unknown as PipelineDeps;

    const result = await analyze(makeSegment([
      {
        label: "person",
        confidence: 0.92,
        bbox: { x1: 100, y1: 80, x2: 260, y2: 360 },
      },
      {
        label: "person",
        confidence: 0.91,
        bbox: { x1: 420, y1: 80, x2: 580, y2: 360 },
      },
    ]), deps);

    expect(result.perception_memory.entities.map((entity) => entity.name)).toEqual([undefined, undefined, undefined]);
    expect(reidUpdateIdentity).not.toHaveBeenCalled();
  });

  it("filters referenced company/topic names before writing stable identity", async () => {
    const { analyze } = await import("../pipeline.js");

    const face = makeCluster({
      frameIndex: 0,
      personBbox: { x: 100, y: 80, width: 160, height: 280 },
      faceBbox: { x: 120, y: 100, width: 32, height: 36 },
    });
    analyzerMocks.collectQualifiedFaces.mockReturnValue([face]);
    analyzerMocks.runPerFaceReId.mockResolvedValue([{
      face,
      embedding: [0.1, 0.2, 0.3],
      pose: { yaw: 8, pitch: 4, roll: 0 },
      quality: 0.9,
      entity_id: "entity_person",
      confidence: 0.91,
    }]);

    const subjectProposalRaw = JSON.stringify({
      summary: "A person discusses a customer example.",
      detailed_summary: "A person discusses Eli Lilly as a customer example.",
      security_risk: false,
      is_static_scene: false,
      notify_user: false,
      targets: [{
        type: "person",
        bbox_ids: ["D0"],
        matched_wm_target: null,
        identity: { name: "NVIDIA", evidence: "NVIDIA is mentioned as a customer example.", source: "spoken" },
        appearance: "person in the room",
        behavior: "speaking",
      }],
    });
    const vlmAnalyze = vi.fn().mockResolvedValue({
      normalizedJson: subjectProposalRaw,
      output: {
        summary: "A person discusses a customer example.",
        detailed_summary: "A person discusses Eli Lilly as a customer example.",
        security_risk: false,
        is_static_scene: false,
        notify_user: false,
        main_targets: [],
        raw_response: "{}",
      } satisfies VlmOutput,
      latency_ms: 1,
    });
    const reidUpdateIdentity = vi.fn().mockResolvedValue(undefined);

    const deps = {
      ...makeDeps(),
      vlmAnalyzer: { analyzeSegment: vlmAnalyze },
      memory: { reidUpdateIdentity },
    } as unknown as PipelineDeps;

    const result = await analyze(makeSegment([
      {
        label: "person",
        confidence: 0.92,
        bbox: { x1: 100, y1: 80, x2: 260, y2: 360 },
      },
    ]), deps);

    expect(result.perception_memory.entities[0]?.name).toBeUndefined();
    expect(reidUpdateIdentity).not.toHaveBeenCalled();
  });

  it("does not write dialogue names to ReID when VLM groups conflicting face entities", async () => {
    const { analyze } = await import("../pipeline.js");

    const faceA = makeCluster({
      frameIndex: 0,
      personBbox: { x: 100, y: 80, width: 160, height: 280 },
      faceBbox: { x: 120, y: 100, width: 32, height: 36 },
    });
    const faceB = makeCluster({
      frameIndex: 1,
      personBbox: { x: 100, y: 80, width: 160, height: 280 },
      faceBbox: { x: 125, y: 104, width: 34, height: 38 },
    });
    analyzerMocks.collectQualifiedFaces.mockReturnValue([faceA, faceB]);
    analyzerMocks.runPerFaceReId.mockResolvedValue([{
      face: faceA,
      embedding: [0.1, 0.2, 0.3],
      pose: { yaw: 5, pitch: 3, roll: 0 },
      quality: 0.95,
      entity_id: "entity_alex_candidate",
      confidence: 0.93,
    }, {
      face: faceB,
      embedding: [0.4, 0.5, 0.6],
      pose: { yaw: 8, pitch: 4, roll: 0 },
      quality: 0.9,
      entity_id: "entity_other_person",
      confidence: 0.91,
    }]);

    const subjectProposalRaw = JSON.stringify({
      summary: "Two visible detections are incorrectly grouped as one speaker.",
      detailed_summary: "The segment contains two people, but the model grouped their detections together.",
      security_risk: false,
      is_static_scene: false,
      notify_user: false,
      targets: [{
        type: "person",
        bbox_ids: ["D0", "D1"],
        matched_wm_target: null,
        identity: { name: "Alex", evidence: "the visible speaker is addressed as Alex", source: "spoken" },
        appearance: "person near the camera",
        behavior: "speaking",
      }],
    });
    const vlmAnalyze = vi.fn().mockResolvedValue({
      normalizedJson: subjectProposalRaw,
      output: {
        summary: "Two people are visible.",
        detailed_summary: "Two people are visible in the room.",
        security_risk: false,
        is_static_scene: false,
        notify_user: false,
        main_targets: [],
        raw_response: "{}",
      } satisfies VlmOutput,
      latency_ms: 1,
    });
    const reidUpdateIdentity = vi.fn().mockResolvedValue(undefined);

    const deps = {
      ...makeDeps(),
      vlmAnalyzer: { analyzeSegment: vlmAnalyze },
      memory: { reidUpdateIdentity },
    } as unknown as PipelineDeps;

    const result = await analyze(makeSegment([
      {
        label: "person",
        confidence: 0.92,
        bbox: { x1: 100, y1: 80, x2: 260, y2: 360 },
      },
    ]), deps);

    expect(result.perception_memory.entities[0]).toEqual(expect.objectContaining({
      track_id: "D0",
      entity_id: "entity_alex_candidate",
    }));
    expect(result.perception_memory.entities[0]).not.toHaveProperty("name");
    expect(reidUpdateIdentity).not.toHaveBeenCalled();
  });

  it("does not write dialogue names to ReID when entity is only inherited from working memory", async () => {
    const { analyze } = await import("../pipeline.js");

    const workingMemory = new WorkingMemoryManager({ event_timeout_sec: 30 });
    workingMemory.onSegmentArrived("cam_test", "stream", 500);
    workingMemory.upsertTarget("cam_test", {
      target_id: "wm_t1",
      entity_id: "entity_previous",
      class_name: "person",
      appearance: "person in a dark jacket",
      behavior: "standing",
      crop_path: "/media/previous.jpg",
      last_seen_segment_id: "seg_prev",
      last_seen_timestamp: 500,
      segments_seen: 1,
      segments_missed: 0,
    });

    const face = makeCluster({
      frameIndex: 0,
      personBbox: { x: 100, y: 80, width: 160, height: 280 },
      faceBbox: { x: 120, y: 100, width: 32, height: 36 },
    });
    analyzerMocks.collectQualifiedFaces.mockReturnValue([face]);
    analyzerMocks.runPerFaceReId.mockResolvedValue([]);

    const subjectProposalRaw = JSON.stringify({
      summary: "A person speaks near the camera.",
      detailed_summary: "A person in a dark jacket speaks near the camera.",
      security_risk: false,
      is_static_scene: false,
      notify_user: false,
      targets: [{
        type: "person",
        bbox_ids: ["D0"],
        matched_wm_target: "wm_t1",
        identity: { name: "Alex", evidence: "the person is addressed as Alex", source: "spoken" },
        appearance: "person in a dark jacket",
        behavior: "speaking",
      }],
    });
    const vlmAnalyze = vi.fn().mockResolvedValue({
      normalizedJson: subjectProposalRaw,
      output: {
        summary: "A person speaks near the camera.",
        detailed_summary: "A person in a dark jacket speaks near the camera.",
        security_risk: false,
        is_static_scene: false,
        notify_user: false,
        main_targets: [],
        raw_response: "{}",
      } satisfies VlmOutput,
      latency_ms: 1,
    });
    const reidUpdateIdentity = vi.fn().mockResolvedValue(undefined);

    const deps = {
      ...makeDeps({ workingMemory }),
      vlmAnalyzer: { analyzeSegment: vlmAnalyze },
      memory: { reidUpdateIdentity },
    } as unknown as PipelineDeps;

    const result = await analyze(makeSegment([
      {
        label: "person",
        confidence: 0.92,
        bbox: { x1: 100, y1: 80, x2: 260, y2: 360 },
      },
    ]), deps);

    expect(result.perception_memory.entities[0]).toEqual(expect.objectContaining({
      track_id: "D0",
      entity_id: "entity_previous",
    }));
    expect(result.perception_memory.entities[0]).not.toHaveProperty("name");
    expect(result.perception_memory.entities[0]?.crop_path).toBeUndefined();
    expect(reidUpdateIdentity).not.toHaveBeenCalled();
  });

  it("drops lower-third names bound to no-face edge targets while preserving WM continuity", async () => {
    const { analyze } = await import("../pipeline.js");

    const workingMemory = new WorkingMemoryManager({ event_timeout_sec: 30 });
    workingMemory.onSegmentArrived("cam_test", "stream", 500);
    workingMemory.upsertTarget("cam_test", {
      target_id: "wm_t1",
      entity_id: "entity_host",
      class_name: "person",
      appearance: "right-edge person in a dark suit",
      behavior: "partially visible",
      last_seen_segment_id: "seg_prev",
      last_seen_timestamp: 500,
      segments_seen: 1,
      segments_missed: 0,
    });

    const subjectProposalRaw = JSON.stringify({
      summary: "A foreground guest speaks while a lower-third name is visible.",
      detailed_summary: "A foreground guest speaks while a lower-third name appears near a partial edge figure.",
      security_risk: false,
      is_static_scene: false,
      notify_user: false,
      targets: [{
        type: "person",
        bbox_ids: ["D0"],
        matched_wm_target: "wm_t1",
        identity: { name: "Jensen Huang", evidence: "visible lower-third nameplate near the right-edge subject", source: "visible_text" },
        appearance: "right-edge person in a dark suit",
        behavior: "partially visible beside the lower-third",
      }],
    });
    const vlmAnalyze = vi.fn().mockResolvedValue({
      normalizedJson: subjectProposalRaw,
      output: {
        summary: "A foreground guest speaks.",
        detailed_summary: "A foreground guest speaks while a lower-third is visible.",
        security_risk: false,
        is_static_scene: false,
        notify_user: false,
        main_targets: [],
        raw_response: "{}",
      } satisfies VlmOutput,
      latency_ms: 1,
    });
    const reidUpdateIdentity = vi.fn().mockResolvedValue(undefined);

    const deps = {
      ...makeDeps({ workingMemory }),
      vlmAnalyzer: { analyzeSegment: vlmAnalyze },
      memory: { reidUpdateIdentity },
    } as unknown as PipelineDeps;

    const result = await analyze(makeSegment(), deps);

    expect(result.perception_memory.entities).toEqual([]);
    expect(workingMemory.getTargets("cam_test").find((target) => target.target_id === "wm_t1")).toEqual(expect.objectContaining({
      entity_id: "entity_host",
      class_name: "person",
    }));
    expect(workingMemory.getTargetIdentity("cam_test", "wm_t1")?.name).toBeUndefined();
    expect(reidUpdateIdentity).not.toHaveBeenCalled();
  });

  it("does not expose an existing stable crop as the current segment sighting", async () => {
    const { analyze } = await import("../pipeline.js");

    const workingMemory = new WorkingMemoryManager({ event_timeout_sec: 30 });
    workingMemory.onSegmentArrived("cam_test", "stream", 500);
    workingMemory.upsertTarget("cam_test", {
      target_id: "wm_t1",
      entity_id: "entity_previous",
      class_name: "person",
      appearance: "person in a dark jacket",
      behavior: "standing",
      crop_path: "/media/stable.jpg",
      stable_crops: [{
        crop_path: "/media/stable.jpg",
        segment_id: "seg_prev",
        did: "D4",
        score: 0.91,
        source: "face",
        timestamp: 500,
      }],
      last_seen_segment_id: "seg_prev",
      last_seen_timestamp: 500,
      segments_seen: 1,
      segments_missed: 0,
    });

    const face = makeCluster({
      frameIndex: 0,
      personBbox: { x: 100, y: 80, width: 160, height: 280 },
      faceBbox: { x: 120, y: 100, width: 32, height: 36 },
    });
    analyzerMocks.collectQualifiedFaces.mockReturnValue([face]);
    analyzerMocks.runPerFaceReId.mockResolvedValue([]);

    const subjectProposalRaw = JSON.stringify({
      summary: "A person speaks near the camera.",
      detailed_summary: "A person in a dark jacket speaks near the camera.",
      security_risk: false,
      is_static_scene: false,
      notify_user: false,
      targets: [{
        type: "person",
        bbox_ids: ["D0"],
        matched_wm_target: "wm_t1",
        appearance: "person in a dark jacket",
        behavior: "speaking",
      }],
    });
    const vlmAnalyze = vi.fn().mockResolvedValue({
      normalizedJson: subjectProposalRaw,
      output: {
        summary: "A person speaks near the camera.",
        detailed_summary: "A person in a dark jacket speaks near the camera.",
        security_risk: false,
        is_static_scene: false,
        notify_user: false,
        main_targets: [],
        raw_response: "{}",
      } satisfies VlmOutput,
      latency_ms: 1,
    });

    const deps = {
      ...makeDeps({ workingMemory }),
      vlmAnalyzer: { analyzeSegment: vlmAnalyze },
    } as unknown as PipelineDeps;

    const result = await analyze(makeSegment([
      {
        label: "person",
        confidence: 0.92,
        bbox: { x1: 100, y1: 80, x2: 260, y2: 360 },
      },
    ]), deps);

    expect(result.perception_memory.entities[0]).toEqual(expect.objectContaining({
      track_id: "D0",
      entity_id: "entity_previous",
    }));
    expect(result.perception_memory.entities[0]?.crop_path).toBeUndefined();
    expect(workingMemory.getTargets("cam_test")[0]?.crop_path).toBe("/media/stable.jpg");
  });
});
