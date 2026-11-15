/**
 * Integration test: Full pipeline with REAL services.
 *
 * Requires running:
 *   - Qdrant on localhost:6335
 *   - Cortex on localhost:8219
 *
 * Tests verify actual data flows through Cortex memory.
 * VLM (Gemini) is still mocked since it requires a paid API key.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import type { Segment, PerceptionResult } from "@cortex/shared";

// ── Cam ──
import { CamPipeline } from "../../packages/cam/src/pipeline.js";
import type { FrameResult } from "../../packages/cam/src/types.js";

// ── Perception ──
import { analyze as perceptionAnalyze } from "../../packages/percept/src/pipeline.js";
import type { PipelineDeps as PerceptionDeps } from "../../packages/percept/src/pipeline.js";
import { WorkingMemoryManager } from "../../packages/percept/src/working-memory.js";
import { StrategyManager } from "../../packages/percept/src/strategy-manager.js";
import type { VlmOutput } from "../../packages/percept/src/types.js";
import type { VlmSegmentAnalysis } from "../../packages/percept/src/analyzers/vlm-analyzer.js";

// ── Memory ──
import { CortexClient } from "../../packages/mem/src/client.js";

// ── Config ──
const CORTEX_URL = "http://localhost:8219";
const QDRANT_URL = "http://localhost:6335";

/** Tiny 1x1 white JPEG in base64. */
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

const NORMAL_VLM_OUTPUT: VlmOutput = {
  summary: "A delivery person is placing a package at the front door",
  detailed_summary: "A delivery person wearing a brown uniform is bending down to place a package at the front door. The package appears to be a medium-sized cardboard box.",
  security_risk: false,
  is_static_scene: false,
  notify_user: true,
  main_targets: [
    { type: "person", appearance: "brown uniform, cap", behavior: "placing package at door" },
  ],
  raw_response: "{}",
};

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
  };
}

// ── Service health checks ──

async function isServiceUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite
// ═══════════════════════════════════════════════════════════════════════════

describe("Real Services Integration: Cam → Perception → Cortex", () => {
  let memoryClient: CortexClient;
  let perceptionDeps: PerceptionDeps;
  let servicesAvailable = false;

  beforeAll(async () => {
    const [qdrantUp, cortexUp] = await Promise.all([
      isServiceUp(`${QDRANT_URL}/healthz`),
      isServiceUp(`${CORTEX_URL}/health`),
    ]);

    servicesAvailable = qdrantUp && cortexUp;
    if (!servicesAvailable) {
      console.warn(
        `[SKIP] Real services not available: Qdrant=${qdrantUp}, Cortex=${cortexUp}`,
      );
      return;
    }

    memoryClient = new CortexClient({ baseUrl: CORTEX_URL, timeoutMs: 30_000 });

    perceptionDeps = {
      workingMemory: new WorkingMemoryManager({ event_timeout_sec: 300 }),
      strategyManager: new StrategyManager({ stubsOnly: true }),
      vlmAnalyzer: makeMockVlmAnalyzer(NORMAL_VLM_OUTPUT) as any,
      mediaUploader: { saveKeyframe: vi.fn().mockReturnValue("/media/test/kf.jpg") } as any,
    };
  });

  // ── Scenario 1: Perception → Cortex storage + search ──
  it("end-to-end: Perception analyzes → Cortex stores → search finds it", async () => {
    if (!servicesAvailable) return;

    const testCameraId = `cam_e2e_${Date.now().toString(36)}`;
    let capturedResult: PerceptionResult | null = null;

    const eyePipeline = new CamPipeline(
      {
        cameraId: testCameraId,
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
    const result = capturedResult!;
    expect(result.perception_memory.summary).toContain("delivery person");
    expect(result.camera_id).toBe(testCameraId);

    // Store to Cortex (real HTTP call)
    const addResponse = await memoryClient.add({
      video_data: {
        summary: result.perception_memory.summary,
        security_risk: false,
      },
      camera_id: result.camera_id,
      user_id: "default",
    });
    expect(addResponse.results).toBeDefined();
    expect(addResponse.results.length).toBeGreaterThan(0);

    // Search Cortex (real HTTP call)
    const searchResponse = await memoryClient.search({
      query: "delivery package front door",
      camera_id: testCameraId,
      limit: 5,
    });

    const allResults = Object.values(searchResponse).flat();
    expect(allResults.length).toBeGreaterThan(0);
  }, 60_000);

  // ── Scenario 2: Cortex health check ──
  it("Cortex: health check returns expected structure", async () => {
    if (!servicesAvailable) return;

    const health = await memoryClient.health();
    expect(health.status).toBe("healthy");
    expect(health.vector_store).toBe("qdrant");
  });
});
