// tests/integration/working-memory-lifecycle.test.ts
// E2E: Working Memory event lifecycle across multiple segments.
// Verifies event grouping, timeout, cross-camera isolation, and scene context accumulation.
import { describe, it, expect, afterAll } from "vitest";
import { analyze } from "../../packages/percept/src/pipeline.js";
import { createE2eDeps, makeSegment } from "./helpers.js";
import type { VlmOutput } from "../../packages/percept/src/types.js";

describe("E2E: Working Memory event lifecycle", () => {
  // Use a very short timeout (0.1s) so we can test timeout behavior quickly
  const { deps, mediaSaver, mockVlm } = createE2eDeps({ eventTimeoutSec: 1 });

  afterAll(() => {
    mediaSaver.cleanup();
  });

  it("5 segments from same camera in event mode share the same event_id", async () => {
    const results = [];
    for (let i = 0; i < 5; i++) {
      const seg = makeSegment("event", "cam_lifecycle_a", 2);
      results.push(await analyze(seg, deps));
    }

    const eventIds = results.map((r) => r.event_id);
    const unique = new Set(eventIds);
    expect(unique.size).toBe(1);
    expect(eventIds[0]).toMatch(/^evt_cam_lifecycle_a_/);
  });

  it("segment from different camera gets a different event_id", async () => {
    // cam_lifecycle_a already has an event open from previous test
    const segA = makeSegment("event", "cam_lifecycle_a", 2);
    const segB = makeSegment("event", "cam_lifecycle_b", 2);

    const resultA = await analyze(segA, deps);
    const resultB = await analyze(segB, deps);

    expect(resultA.event_id).not.toBe(resultB.event_id);
    expect(resultA.event_id).toMatch(/^evt_cam_lifecycle_a_/);
    expect(resultB.event_id).toMatch(/^evt_cam_lifecycle_b_/);
  });

  it("new event_id after timeout — old event auto-closes", async () => {
    // Create deps with 1-second timeout for this specific test
    const { deps: shortDeps, mediaSaver: shortSaver } = createE2eDeps({
      eventTimeoutSec: 1,
    });

    try {
      const seg1 = makeSegment("event", "cam_timeout", 2);
      const r1 = await analyze(seg1, shortDeps);

      // Wait for event timeout (1s + buffer)
      await new Promise((resolve) => setTimeout(resolve, 1200));

      const seg2 = makeSegment("event", "cam_timeout", 2);
      const r2 = await analyze(seg2, shortDeps);

      // After timeout, a new event should be opened
      expect(r1.event_id).not.toBe(r2.event_id);
      expect(r1.event_id).toMatch(/^evt_cam_timeout_/);
      expect(r2.event_id).toMatch(/^evt_cam_timeout_/);
    } finally {
      shortSaver.cleanup();
    }
  });

  it("scene context accumulates within an event — later segments see prior summaries", async () => {
    // Fresh deps so we control the full lifecycle
    const summaries = [
      "Person arrived at the front door.",
      "Person rang the doorbell.",
      "Person picked up a package.",
    ];

    let callIdx = 0;
    const { deps: ctxDeps, mediaSaver: ctxSaver, mockVlm: ctxVlm } = createE2eDeps();

    // Each VLM call returns a different summary
    ctxVlm.analyze.mockImplementation(async () => {
      const summary = summaries[callIdx] ?? "Idle scene.";
      callIdx++;
      return {
        normalizedJson: "{}",
        rawText: "{}",
        output: {
          summary,
          detailed_summary: summary,
          security_risk: false,
          is_static_scene: false,
          notify_user: false,
          main_targets: [],
          raw_response: "{}",
        } satisfies VlmOutput,
        latency_ms: 10,
      };
    });

    try {
      // Send 3 segments to the same camera
      const results = [];
      for (let i = 0; i < 3; i++) {
        const seg = makeSegment("stream", "cam_ctx_accum", 2);
        results.push(await analyze(seg, ctxDeps));
      }

      // All in the same event
      const eventIds = new Set(results.map((r) => r.event_id));
      expect(eventIds.size).toBe(1);

      // Check VLM calls: 2nd and 3rd should have received scene context
      const calls = ctxVlm.analyze.mock.calls;

      // 1st call: no scene context (fresh event)
      const recent1 = calls[0]![2]?.recentSegmentSummaries;
      expect(recent1).toBeFalsy(); // undefined or empty array omitted

      // 2nd call: has summary from 1st segment
      const recent2 = calls[1]![2]?.recentSegmentSummaries?.join("\n");
      expect(recent2).toContain(summaries[0]);

      // 3rd call: has summaries from 1st and 2nd segments
      const recent3 = calls[2]![2]?.recentSegmentSummaries?.join("\n");
      expect(recent3).toContain(summaries[0]);
      expect(recent3).toContain(summaries[1]);
    } finally {
      ctxSaver.cleanup();
    }
  });

  it("snapshot mode: each segment gets its own event_id", async () => {
    const { deps: snapDeps, mediaSaver: snapSaver } = createE2eDeps();

    try {
      const seg1 = makeSegment("snapshot", "cam_snap", 1);
      const seg2 = makeSegment("snapshot", "cam_snap", 1);
      const seg3 = makeSegment("snapshot", "cam_snap", 1);

      const r1 = await analyze(seg1, snapDeps);
      // Small delay to ensure distinct event_id timestamps (event_id = evt_{cam}_{Date.now()})
      await new Promise((resolve) => setTimeout(resolve, 5));
      const r2 = await analyze(seg2, snapDeps);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const r3 = await analyze(seg3, snapDeps);

      // Each snapshot is an independent event
      const ids = new Set([r1.event_id, r2.event_id, r3.event_id]);
      expect(ids.size).toBe(3);
    } finally {
      snapSaver.cleanup();
    }
  });

  it("event close resets scene context — new event starts fresh", async () => {
    const { deps: resetDeps, mediaSaver: resetSaver, mockVlm: resetVlm } = createE2eDeps({
      eventTimeoutSec: 1,
    });

    try {
      // Segment 1: establishes scene context
      const seg1 = makeSegment("event", "cam_reset", 2);
      await analyze(seg1, resetDeps);

      // Wait for timeout
      await new Promise((resolve) => setTimeout(resolve, 1200));

      // Segment 2: after timeout — should NOT have old scene context
      resetVlm.analyze.mockClear();
      const seg2 = makeSegment("event", "cam_reset", 2);
      await analyze(seg2, resetDeps);

      const [, , options] = resetVlm.analyze.mock.calls[0]!;
      const sceneCtx = options?.sceneContext || options?.recentSegmentSummaries?.join("\n");
      // After event close + timeout, scene context should be cleared
      // (empty string is falsy, undefined is falsy — both acceptable)
      expect(sceneCtx).toBeFalsy();
    } finally {
      resetSaver.cleanup();
    }
  });
});
