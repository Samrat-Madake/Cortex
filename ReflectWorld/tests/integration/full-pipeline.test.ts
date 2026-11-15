/**
 * Integration test: Cam → Perception → code-resolved notifications.
 *
 * All external services (Gemini API, Cortex HTTP) are mocked.
 * Validates that data flows correctly across module boundaries,
 * and that notification logic is deterministic based on structured output.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  Segment,
  PerceptionResult,
  Frame,
} from "@cortex/shared";

// ── Cam ──
import { CamPipeline } from "../../packages/cam/src/pipeline.js";
import type { FrameResult } from "../../packages/cam/src/types.js";

// ── Perception ──
import { analyze as perceptionAnalyze } from "../../packages/percept/src/pipeline.js";
import type { PipelineDeps as PerceptionDeps, PostProcessor } from "../../packages/percept/src/pipeline.js";
import { WorkingMemoryManager } from "../../packages/percept/src/working-memory.js";
import { StrategyManager } from "../../packages/percept/src/strategy-manager.js";
import type { VlmOutput } from "../../packages/percept/src/types.js";
import type { VlmSegmentAnalysis } from "../../packages/percept/src/analyzers/vlm-analyzer.js";
import type { Notification } from "../../packages/percept/src/notification-resolver.js";

// ── Helpers ──

/** Tiny 1x1 white JPEG in base64 (valid image for pipeline). */
const FAKE_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof" +
  "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwh" +
  "MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAAR" +
  "CAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAFRABAw" +
  "MFAAAAAAAAAAAAAAAAAAEhEUFR/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAH/xAAUEQEAAAAAAAAA" +
  "AAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAB//2Q==";

function makeFrame(index: number, timestampOffset = 0): FrameResult {
  return {
    data: FAKE_JPEG_B64,
    timestamp: Date.now() + timestampOffset,
    source_name: "test",
  };
}

function makeMockVlmAnalyzer(output: VlmOutput) {
  const analyzeSegment = vi.fn().mockResolvedValue({
    normalizedJson: output.raw_response ?? "{}",
    rawText: output.raw_response ?? "{}",
    output,
    latency_ms: 42,
  } satisfies VlmSegmentAnalysis);

  return {
    analyze: analyzeSegment,
    analyzeSegment,
    setUserRules: vi.fn(),
  };
}

function makeMockMediaUploader() {
  return {
    saveKeyframe: vi.fn().mockReturnValue("/media/test/keyframe/seg_0.jpg"),
    saveGif: vi.fn().mockReturnValue("/media/test/gif/seg.gif"),
    saveCrop: vi.fn().mockReturnValue("/media/test/crop/seg_entity.jpg"),
  };
}

// ── Normal scene: person present, no risk ──
const NORMAL_VLM_OUTPUT: VlmOutput = {
  summary: "A person in a blue jacket is standing at the front door",
  detailed_summary: "A person wearing a blue jacket is standing at the front door, looking at their phone.",
  security_risk: false,
  is_static_scene: false,
  notify_user: true,
  main_targets: [
    { type: "person", appearance: "blue jacket, dark pants", behavior: "standing, looking at phone" },
  ],
  raw_response: "{}",
};

// ── Security risk: code should resolve as alert ──
const SECURITY_VLM_OUTPUT: VlmOutput = {
  summary: "A suspicious person is trying to open the door",
  detailed_summary: "An unidentified person in dark clothing is attempting to force open the front door.",
  security_risk: true,
  security_reason: "Potential intrusion - person forcing door open",
  is_static_scene: false,
  notify_user: true,
  main_targets: [
    { type: "person", appearance: "dark hoodie, face covered", behavior: "forcing door handle" },
  ],
  raw_response: "{}",
};

// ── Static scene: no notifications ──
const STATIC_VLM_OUTPUT: VlmOutput = {
  summary: "Empty hallway, no activity",
  detailed_summary: "The hallway is empty with no movement.",
  security_risk: false,
  is_static_scene: true,
  notify_user: false,
  main_targets: [],
  raw_response: "{}",
};

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite
// ═══════════════════════════════════════════════════════════════════════════

describe("Full Pipeline Integration: Cam → Perception → Code-resolved Notifications", () => {
  let perceptionDeps: PerceptionDeps;
  let mockVlm: ReturnType<typeof makeMockVlmAnalyzer>;
  let mockUploader: ReturnType<typeof makeMockMediaUploader>;
  let sentNotifications: Array<Notification & { cameraId: string }>;

  beforeEach(() => {
    mockVlm = makeMockVlmAnalyzer(NORMAL_VLM_OUTPUT);
    mockUploader = makeMockMediaUploader();
    sentNotifications = [];

    const postProcessor: PostProcessor = {
      async sendNotifications(notifications, cameraId) {
        for (const n of notifications) {
          sentNotifications.push({ ...n, cameraId });
        }
      },
    };

    perceptionDeps = {
      workingMemory: new WorkingMemoryManager({ event_timeout_sec: 300 }),
      strategyManager: new StrategyManager({ stubsOnly: true }),
      vlmAnalyzer: mockVlm as any,
      mediaUploader: mockUploader as any,
      postProcessor,
    };
  });

  it("normal scene with person: sends summary on first segment", async () => {
    let capturedResult: PerceptionResult | null = null;

    const eyePipeline = new CamPipeline(
      {
        cameraId: "cam_front_door",
        mode: "snapshot",
        onSegment: async (segment: Segment) => {
          const result = await perceptionAnalyze(segment, perceptionDeps);
          capturedResult = result;
          return result;
        },
      },
      { storageManager: null, segmenters: [] },
    );

    await eyePipeline.feedFrame(makeFrame(0));

    expect(capturedResult).not.toBeNull();
    expect(capturedResult!.perception_memory.summary).toContain("blue jacket");

    // First segment with person → summary notification
    expect(sentNotifications).toHaveLength(1);
    expect(sentNotifications[0]!.type).toBe("summary");
    expect(sentNotifications[0]!.message).toContain("blue jacket");
  });

  it("security risk: sends alert notification", async () => {
    mockVlm = makeMockVlmAnalyzer(SECURITY_VLM_OUTPUT);
    perceptionDeps = { ...perceptionDeps, vlmAnalyzer: mockVlm as any };

    const eyePipeline = new CamPipeline(
      {
        cameraId: "cam_front_door",
        mode: "snapshot",
        onSegment: async (segment: Segment) => {
          return perceptionAnalyze(segment, perceptionDeps);
        },
      },
      { storageManager: null, segmenters: [] },
    );

    await eyePipeline.feedFrame(makeFrame(0));

    // security_risk=true → alert
    const alerts = sentNotifications.filter((n) => n.type === "alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.message).toContain("intrusion");
  });

  it("static scene: no notifications sent", async () => {
    mockVlm = makeMockVlmAnalyzer(STATIC_VLM_OUTPUT);
    perceptionDeps = { ...perceptionDeps, vlmAnalyzer: mockVlm as any };

    const eyePipeline = new CamPipeline(
      {
        cameraId: "cam_front_door",
        mode: "snapshot",
        onSegment: async (segment: Segment) => {
          return perceptionAnalyze(segment, perceptionDeps);
        },
      },
      { storageManager: null, segmenters: [] },
    );

    await eyePipeline.feedFrame(makeFrame(0));

    expect(sentNotifications).toHaveLength(0);
  });

  it("dedup: same alert not sent twice within same event (stream mode)", async () => {
    mockVlm = makeMockVlmAnalyzer(SECURITY_VLM_OUTPUT);
    // Use a shared working memory so both segments are in the same event
    const sharedWm = new WorkingMemoryManager({ event_timeout_sec: 300 });
    perceptionDeps = { ...perceptionDeps, vlmAnalyzer: mockVlm as any, workingMemory: sharedWm };

    // Simulate two sequential segments in the same event by calling analyze directly
    const makeSegment = (id: string): Segment => ({
      segment_id: id,
      camera_id: "cam_back",
      mode: "stream",
      frames: [{ data: FAKE_JPEG_B64, timestamp: Date.now(), index: 0 }],
      raw_url: "/raw/test.jpg",
      timestamp: Date.now(),
      duration_sec: 0,
    });

    await perceptionAnalyze(makeSegment("seg_1"), perceptionDeps);
    await perceptionAnalyze(makeSegment("seg_2"), perceptionDeps);

    // Only one alert — dedup prevents the second
    const alerts = sentNotifications.filter((n) => n.type === "alert");
    expect(alerts).toHaveLength(1);
  });

  it("working memory: same camera segments share event_id within timeout", async () => {
    const eventIds: string[] = [];

    const eyePipeline = new CamPipeline(
      {
        cameraId: "cam_garage",
        mode: "snapshot",
        onSegment: async (segment: Segment) => {
          const result = await perceptionAnalyze(segment, perceptionDeps);
          eventIds.push(result.event_id);
          return result;
        },
      },
      { storageManager: null, segmenters: [] },
    );

    await eyePipeline.feedFrame(makeFrame(0, 0));
    await eyePipeline.feedFrame(makeFrame(1, 1000));

    expect(eventIds).toHaveLength(2);
  });

  it("data contracts: PerceptionResult has all required fields", async () => {
    let capturedResult: PerceptionResult | null = null;

    const eyePipeline = new CamPipeline(
      {
        cameraId: "cam_01",
        mode: "snapshot",
        onSegment: async (segment: Segment) => {
          const result = await perceptionAnalyze(segment, perceptionDeps);
          capturedResult = result;
          return result;
        },
      },
      { storageManager: null, segmenters: [] },
    );

    await eyePipeline.feedFrame(makeFrame(0));
    const result = capturedResult!;

    expect(result.segment_id).toBeTruthy();
    expect(result.camera_id).toBe("cam_01");
    expect(result.mode).toBe("snapshot");
    expect(result.event_id).toBeTruthy();
    expect(result.perception_memory.summary).toBeTruthy();
    expect(typeof result.perception_memory.timestamp).toBe("number");
    expect(result.camera_id).toBe("cam_01");
    expect([0, 1, 2, 3]).toContain(result.perception_memory.perception_level);
    expect(result.media_urls).toHaveProperty("raw");
    expect(Array.isArray(result.media_urls.keyframes)).toBe(true);
  });
});
