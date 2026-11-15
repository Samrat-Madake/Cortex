// tests/integration/segment-to-memory-contract.test.ts
// E2E: Verify the full data contract from Segment → PerceptionResult → Cortex payload.
// Ensures all required fields for Cortex add() are present and correctly typed.
import { describe, it, expect, afterAll } from "vitest";
import { analyze } from "../../packages/percept/src/pipeline.js";
import { createE2eDeps, makeSegment, MOCK_VLM_OUTPUT } from "./helpers.js";
import type { VlmOutput } from "../../packages/percept/src/types.js";

describe("E2E: Segment → PerceptionResult → Cortex contract", () => {
  // VLM mock with richer output to test all contract fields
  const richVlmOutput: VlmOutput = {
    summary: "Delivery driver dropped a package at the front porch.",
    detailed_summary:
      "A delivery driver in a brown uniform arrived at the front porch, placed a small cardboard box near the door, took a photo, and walked back to their van.",
    security_risk: false,
    security_reason: undefined,
    is_static_scene: false,
    notify_user: true,
    best_frame_index: 0,
    main_targets: [
      {
        type: "person",
        appearance: "brown uniform, cap, carrying clipboard",
        behavior: "delivered package and departed",
        interaction: "placed box near front door",
      },
      {
        type: "object",
        appearance: "small cardboard box, ~30cm",
        behavior: "static",
      },
    ],
    raw_response: '{"summary":"..."}',
  };

  const { deps, mediaSaver } = createE2eDeps({ vlmOutput: richVlmOutput });

  afterAll(() => {
    mediaSaver.cleanup();
  });

  it("snapshot segment produces all required Cortex fields", async () => {
    const segment = makeSegment("snapshot", "cam_contract_1", 1);
    const result = await analyze(segment, deps);

    // ── Top-level fields ──
    expect(typeof result.segment_id).toBe("string");
    expect(result.segment_id).toBe(segment.segment_id);
    expect(typeof result.camera_id).toBe("string");
    expect(result.camera_id).toBe(segment.camera_id);
    expect(result.mode).toBe("snapshot");

    // event_id follows naming convention
    expect(result.event_id).toMatch(/^evt_/);
    expect(typeof result.event_id).toBe("string");

    // ── perception_memory ──
    const pm = result.perception_memory;
    expect(typeof pm.summary).toBe("string");
    expect(pm.summary.length).toBeGreaterThan(0);

    expect(typeof pm.detailed_summary).toBe("string");
    expect(pm.detailed_summary.length).toBeGreaterThan(0);

    expect(typeof pm.perception_level).toBe("number");
    expect([0, 1, 2]).toContain(pm.perception_level);

    expect(typeof pm.security_risk).toBe("boolean");
    expect(pm.security_risk).toBe(false);

    expect(typeof pm.timestamp).toBe("number");
    expect(pm.timestamp).toBeGreaterThan(0);

    expect(result.camera_id).toBe(segment.camera_id);

    // ── entities ──
    expect(Array.isArray(pm.entities)).toBe(true);
    expect(pm.entities!.length).toBe(2);

    const person = pm.entities![0]!;
    expect(person.type).toBe("person");
    expect(typeof person.appearance).toBe("string");
    expect(person.appearance!.length).toBeGreaterThan(0);
    expect(typeof person.behavior).toBe("string");

    const obj = pm.entities![1]!;
    expect(obj.type).toBe("object");

    // ── media_urls ──
    expect(typeof result.media_urls.raw).toBe("string");
    expect(result.media_urls.raw).toBe(segment.raw_url);
    expect(Array.isArray(result.media_urls.keyframes)).toBe(true);
    expect(result.media_urls.keyframes.length).toBeGreaterThanOrEqual(1);
  });

  it("event segment with multiple frames populates all fields", async () => {
    const segment = makeSegment("event", "cam_contract_2", 5);
    const result = await analyze(segment, deps);

    // event_id present
    expect(result.event_id).toMatch(/^evt_cam_contract_2_/);

    // perception_memory complete
    const pm = result.perception_memory;
    expect(pm.summary).toBe(richVlmOutput.summary);
    expect(pm.detailed_summary).toBe(richVlmOutput.detailed_summary);
    expect(pm.perception_level).toBe(0); // Level 0 since stubs_only
    expect(pm.strategy_context).toContain("level0");
    expect(pm.entities!.length).toBe(2);

    // media_urls complete
    expect(result.media_urls.keyframes.length).toBe(1);
    expect(result.media_urls.crops).toEqual([]);
  });

  it("PipelineTrace is attached with valid structure", async () => {
    const segment = makeSegment("event", "cam_contract_trace", 3);
    const result = await analyze(segment, deps);

    const trace = result._trace;
    expect(trace).toBeDefined();

    // Required timestamp fields
    expect(typeof trace!.timestamps.first_frame_at).toBe("number");
    expect(typeof trace!.timestamps.segment_built_at).toBe("number");
    expect(typeof trace!.timestamps.analysis_started_at).toBe("number");
    expect(typeof trace!.timestamps.analysis_completed_at).toBe("number");

    // analysis_completed_at >= analysis_started_at
    expect(trace!.timestamps.analysis_completed_at).toBeGreaterThanOrEqual(
      trace!.timestamps.analysis_started_at,
    );

    // Required latency fields
    expect(typeof trace!.latencies.perception_ms).toBe("number");
    expect(typeof trace!.latencies.e2e_ms).toBe("number");
    expect(trace!.latencies.perception_ms).toBeGreaterThanOrEqual(0);

    // Context fields
    expect(trace!.context.mode).toBe("event");
    expect(trace!.context.level).toBe(0);
    expect(trace!.context.frame_count).toBe(3);
    expect(Array.isArray(trace!.context.analyzers_run)).toBe(true);
  });

  it("security risk fields propagate correctly", async () => {
    const securityVlm: VlmOutput = {
      ...MOCK_VLM_OUTPUT,
      security_risk: true,
      security_reason: "Forced entry attempt on back door",
    };

    const { deps: secDeps, mediaSaver: secSaver } = createE2eDeps({
      vlmOutput: securityVlm,
    });

    try {
      const segment = makeSegment("event", "cam_sec", 2);
      const result = await analyze(segment, secDeps);

      expect(result.perception_memory.security_risk).toBe(true);
      expect(result.perception_memory.security_reason).toBe(
        "Forced entry attempt on back door",
      );
    } finally {
      secSaver.cleanup();
    }
  });

  it("VLM failure produces graceful fallback with all required fields still present", async () => {
    const { deps: failDeps, mediaSaver: failSaver, mockVlm } = createE2eDeps();
    mockVlm.analyze.mockRejectedValueOnce(new Error("Network timeout"));

    try {
      const segment = makeSegment("snapshot", "cam_fail", 1);
      const result = await analyze(segment, failDeps);

      // All required fields still present
      expect(result.segment_id).toBe(segment.segment_id);
      expect(result.camera_id).toBe("cam_fail");
      expect(result.event_id).toMatch(/^evt_/);
      expect(result.mode).toBe("snapshot");

      // Fallback summary
      expect(result.perception_memory.summary).toBe("VLM call failed.");
      expect(result.perception_memory.detailed_summary).toBe("");
      expect(result.perception_memory.security_risk).toBe(false);
      expect(result.perception_memory.entities).toEqual([]);
      expect(typeof result.perception_memory.perception_level).toBe("number");

      // media_urls still populated
      expect(result.media_urls.raw).toBe(segment.raw_url);
    } finally {
      failSaver.cleanup();
    }
  });
});
