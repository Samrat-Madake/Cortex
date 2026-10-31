import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PipelineStore } from "../store.js";
import type { LlmCallRecord, PipelineTrace } from "@reflectworld/shared";

function makeTrace(segmentId: string, opts?: Partial<{
  cameraId: string;
  mode: "snapshot" | "event" | "stream";
  level: number;
  e2e_ms: number;
  perception_ms: number;
  vlm_ms: number;
  vlm_prep_ms: number;
  vlm_analyze_ms: number;
  vlm_finalize_ms: number;
  detection_ms: number;
  memory_blocking_ms: number;
  memory_ms: number;
  created_at: number;
}>): PipelineTrace {
  const now = opts?.created_at ?? Date.now();
  return {
    segment_id: segmentId,
    camera_id: opts?.cameraId ?? "cam_test",
    timestamps: {
      first_frame_at: now - (opts?.e2e_ms ?? 1000),
      segment_built_at: now - (opts?.e2e_ms ?? 1000) + 100,
      analysis_started_at: now - (opts?.perception_ms ?? 500),
      analysis_completed_at: now,
    },
    latencies: {
      accumulation_ms: 100,
      dispatch_ms: 50,
      vlm_ms: opts?.vlm_ms ?? 300,
      vlm_prep_ms: opts?.vlm_prep_ms ?? 50,
      vlm_analyze_ms: opts?.vlm_analyze_ms ?? 240,
      vlm_finalize_ms: opts?.vlm_finalize_ms ?? 10,
      detection_ms: opts?.detection_ms,
      perception_ms: opts?.perception_ms ?? 500,
      memory_blocking_ms: opts?.memory_blocking_ms,
      memory_ms: opts?.memory_ms,
      e2e_ms: opts?.e2e_ms ?? 1000,
    },
    context: {
      mode: opts?.mode ?? "snapshot",
      level: opts?.level ?? 0,
      frame_count: 1,
      vlm_model: "gemini-2.5-flash",
      analyzers_run: ["vlm"],
    },
  };
}

describe("PipelineStore — traces", () => {
  let store: PipelineStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "store-traces-"));
    store = new PipelineStore(tmpDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saveTrace and getRecentTraces round-trips correctly", () => {
    const trace = makeTrace("seg_001");
    store.saveTrace(trace);

    const traces = store.getRecentTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0]!.segment_id).toBe("seg_001");
    expect(traces[0]!.latencies.vlm_ms).toBe(300);
    expect(traces[0]!.latencies.vlm_prep_ms).toBe(50);
    expect(traces[0]!.latencies.vlm_analyze_ms).toBe(240);
    expect(traces[0]!.latencies.vlm_finalize_ms).toBe(10);
  });

  it("saveTrace round-trips memory timing fields", () => {
    const trace = makeTrace("seg_memory", { memory_blocking_ms: 0, memory_ms: 1250 });
    trace.timestamps.memory_stored_at = Date.now() + 1250;
    store.saveTrace(trace);

    const traces = store.getRecentTraces();
    expect(traces[0]!.latencies.memory_blocking_ms).toBe(0);
    expect(traces[0]!.latencies.memory_ms).toBe(1250);
    expect(traces[0]!.timestamps.memory_stored_at).toBe(trace.timestamps.memory_stored_at);
  });

  it("getRecentTraces filters by cameraId", () => {
    store.saveTrace(makeTrace("seg_001", { cameraId: "cam_a" }));
    store.saveTrace(makeTrace("seg_002", { cameraId: "cam_b" }));

    const tracesA = store.getRecentTraces("cam_a");
    expect(tracesA).toHaveLength(1);
    expect(tracesA[0]!.camera_id).toBe("cam_a");
  });

  it("getRecentTraces respects limit", () => {
    for (let i = 0; i < 10; i++) {
      store.saveTrace(makeTrace(`seg_${i}`, { created_at: Date.now() + i }));
    }

    const traces = store.getRecentTraces(undefined, 3);
    expect(traces).toHaveLength(3);
  });

  it("getTraceStats computes correct percentiles", () => {
    // Insert 10 traces with known e2e_ms values: 100, 200, ..., 1000
    for (let i = 1; i <= 10; i++) {
      store.saveTrace(makeTrace(`seg_${i}`, {
        e2e_ms: i * 100,
        perception_ms: i * 50,
        vlm_ms: i * 30,
        vlm_prep_ms: i * 5,
        vlm_analyze_ms: i * 20,
        vlm_finalize_ms: i,
        memory_blocking_ms: i,
        memory_ms: i * 10,
        created_at: Date.now() + i,
      }));
    }

    const stats = store.getTraceStats();
    expect(stats.count).toBe(10);
    expect(stats.e2e_ms.avg).toBe(550); // (100+200+...+1000)/10 = 550
    expect(stats.e2e_ms.p50).toBe(600); // index 5 of sorted [100..1000]
    expect(stats.e2e_ms.p95).toBe(1000); // index 9 of sorted [100..1000]
    expect(stats.memory_blocking_ms.avg).toBe(6);
    expect(stats.memory_ms.avg).toBe(55);
    expect(stats.vlm_prep_ms.avg).toBe(28);
    expect(stats.vlm_analyze_ms.avg).toBe(110);
    expect(stats.vlm_finalize_ms.avg).toBe(6);
  });

  it("getTraceStats returns zeros when no traces", () => {
    const stats = store.getTraceStats();
    expect(stats.count).toBe(0);
    expect(stats.e2e_ms.avg).toBe(0);
  });

  it("getTraceStats filters by cameraId", () => {
    store.saveTrace(makeTrace("seg_001", { cameraId: "cam_a", e2e_ms: 100, created_at: Date.now() }));
    store.saveTrace(makeTrace("seg_002", { cameraId: "cam_b", e2e_ms: 200, created_at: Date.now() + 1 }));

    const stats = store.getTraceStats("cam_a");
    expect(stats.count).toBe(1);
    expect(stats.e2e_ms.avg).toBe(100);
  });

  it("saveTrace upserts (INSERT OR REPLACE) on same segment_id", () => {
    store.saveTrace(makeTrace("seg_001", { e2e_ms: 100 }));
    store.saveTrace(makeTrace("seg_001", { e2e_ms: 200 }));

    const traces = store.getRecentTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0]!.latencies.e2e_ms).toBe(200);
  });

  it("handles traces with null optional latencies", () => {
    const trace = makeTrace("seg_null");
    trace.latencies.detection_ms = undefined;
    trace.latencies.vlm_ms = undefined;
    store.saveTrace(trace);

    const stats = store.getTraceStats();
    expect(stats.vlm_ms.avg).toBe(0); // no vlm values
    expect(stats.detection_ms.avg).toBe(0);
  });

  it("saveLlmCall stores normalized call metadata and token usage", () => {
    const call: LlmCallRecord = {
      schema_version: 1,
      call_id: "llm_test",
      run_id: "run_test",
      snapshot_version: "snapshot_test",
      video_id: "video_test",
      camera_id: "cam_test",
      segment_id: "seg_test",
      stage: "percept.analyze_segment",
      provider: "openai",
      model: "openai/gpt-5-mini",
      prompt_version: "commit_test",
      request: {
        response_format: "json",
        max_completion_tokens: 2048,
        image_count: 3,
        prompt_hash: "fnv1a32:test",
      },
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        reasoning_tokens: 20,
        total_tokens: 170,
      },
      latency_ms: 1234.4,
      status: "ok",
      retry_count: 1,
      error: null,
      created_at: "2026-04-29T00:00:00.000Z",
    };

    store.saveLlmCall(call);

    const row = (store as unknown as {
      db: { prepare(sql: string): { get(callId: string): Record<string, unknown> | undefined } };
    }).db.prepare("SELECT * FROM llm_calls WHERE call_id = ?").get("llm_test");
    expect(row?.stage).toBe("percept.analyze_segment");
    expect(row?.prompt_tokens).toBe(100);
    expect(row?.completion_tokens).toBe(50);
    expect(row?.reasoning_tokens).toBe(20);
    expect(row?.total_tokens).toBe(170);
    expect(row?.latency_ms).toBe(1234);
    expect(JSON.parse(String(row?.call_json)).request.prompt_hash).toBe("fnv1a32:test");
  });
});
