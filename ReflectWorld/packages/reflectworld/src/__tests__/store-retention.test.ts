import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { PipelineStore } from "../store.js";
import type { LlmCallRecord, PipelineTrace } from "@cortex/shared";

const DAY_MS = 86_400_000;

function dbOf(store: PipelineStore): DatabaseSync {
  return (store as unknown as { db: DatabaseSync }).db;
}

function sqliteDate(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

function logSegment(
  store: PipelineStore,
  segmentId: string,
  cameraId = "cam_retention",
  rawUrl = "/tmp/raw.mp4",
  mediaUrls: Record<string, unknown> = { raw: rawUrl, keyframes: [], crops: [] },
): void {
  store.logResult(
    {
      segment_id: segmentId,
      camera_id: cameraId,
      mode: "stream",
      frames: [{ data: "base64", timestamp: Date.now(), index: 0 }],
      raw_url: rawUrl,
      timestamp: Date.now(),
      duration_sec: 10,
    },
    {
      segment_id: segmentId,
      camera_id: cameraId,
      mode: "stream",
      event_id: `evt_${segmentId}`,
      perception_memory: {
        summary: `summary ${segmentId}`,
        detailed_summary: `detail ${segmentId}`,
        security_risk: false,
        timestamp: Date.now(),
        perception_level: 1,
        entities: [],
      },
      media_urls: mediaUrls as any,
    },
  );
}

function setPipelineCreatedAt(store: PipelineStore, segmentId: string, ms: number): void {
  dbOf(store).prepare("UPDATE pipeline_log SET created_at = ? WHERE segment_id = ?")
    .run(sqliteDate(ms), segmentId);
}

function makeTrace(segmentId: string, cameraId: string, createdAt: number): PipelineTrace {
  return {
    segment_id: segmentId,
    camera_id: cameraId,
    timestamps: {
      first_frame_at: createdAt - 1000,
      segment_built_at: createdAt - 900,
      analysis_started_at: createdAt - 500,
      analysis_completed_at: createdAt,
    },
    latencies: {
      accumulation_ms: 100,
      dispatch_ms: 50,
      perception_ms: 500,
      e2e_ms: 1000,
    },
    context: {
      mode: "stream",
      level: 1,
      frame_count: 1,
      analyzers_run: ["vlm"],
    },
  };
}

function makeLlmCall(segmentId: string, cameraId: string, createdAt: number): LlmCallRecord {
  return {
    schema_version: 1,
    call_id: `call_${segmentId}`,
    camera_id: cameraId,
    segment_id: segmentId,
    stage: "percept.analyze_segment",
    provider: "openai",
    model: "gpt-5-mini",
    request: { prompt_hash: `hash_${segmentId}` },
    latency_ms: 10,
    status: "ok",
    created_at: sqliteDate(createdAt),
  };
}

describe("PipelineStore — retention", () => {
  let store: PipelineStore;
  let tmpDir: string;
  const now = Date.UTC(2026, 5, 12, 0, 0, 0);

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "store-retention-"));
    store = new PipelineStore(tmpDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("expires generated media after 30 days while keeping text rows until 90 days", () => {
    const oldMediaPath = store.saveMedia("cam_retention", "seg_old_media", "keyframe", Buffer.from("old"), "0");
    logSegment(store, "seg_old_media", "cam_retention", oldMediaPath, {
      raw: oldMediaPath,
      keyframes: [oldMediaPath],
      crops: [],
    });
    setPipelineCreatedAt(store, "seg_old_media", now - 31 * DAY_MS);
    dbOf(store).prepare("UPDATE media_files SET created_at = ? WHERE segment_id = ?")
      .run(sqliteDate(now - 31 * DAY_MS), "seg_old_media");

    const recentMediaPath = store.saveMedia("cam_retention", "seg_recent", "keyframe", Buffer.from("new"), "0");
    logSegment(store, "seg_recent", "cam_retention", recentMediaPath, {
      raw: recentMediaPath,
      keyframes: [recentMediaPath],
      crops: [],
    });
    setPipelineCreatedAt(store, "seg_recent", now - 10 * DAY_MS);
    logSegment(store, "seg_old_empty_media", "cam_retention", "", {
      raw: "",
      keyframes: [],
      crops: [],
    });
    setPipelineCreatedAt(store, "seg_old_empty_media", now - 31 * DAY_MS);

    const result = store.runRetention({
      mediaRetentionDays: 30,
      textRetentionDays: 90,
      nowMs: now,
    });

    const oldRow = store.getBySegmentId("seg_old_media");
    const recentRow = store.getBySegmentId("seg_recent");
    expect(result.mediaFilesDeleted).toBe(1);
    expect(result.mediaReferencesExpired).toBe(1);
    expect(result.pipelineRowsDeleted).toBe(0);
    expect(result.mediaSegmentsExpired).toContainEqual({
      segment_id: "seg_old_media",
      camera_id: "cam_retention",
    });
    expect(result.mediaSegmentsExpired).not.toContainEqual({
      segment_id: "seg_old_empty_media",
      camera_id: "cam_retention",
    });
    expect(oldRow).not.toBeNull();
    expect(oldRow!.media_urls_json).toBeNull();
    expect(oldRow!.raw_url).toBeNull();
    expect(store.getBySegmentId("seg_old_empty_media")!.media_urls_json).not.toBeNull();
    expect(existsSync(oldMediaPath)).toBe(false);
    expect(recentRow!.media_urls_json).not.toBeNull();
    expect(existsSync(recentMediaPath)).toBe(true);
  });

  it("deletes 90-day text rows together with dependent diagnostics", () => {
    logSegment(store, "seg_old_text", "cam_text");
    logSegment(store, "seg_recent_text", "cam_text");
    setPipelineCreatedAt(store, "seg_old_text", now - 100 * DAY_MS);
    setPipelineCreatedAt(store, "seg_recent_text", now - 10 * DAY_MS);

    store.logNotification({
      segment_id: "seg_old_text",
      camera_id: "cam_text",
      type: "alert",
      message: "old notification",
      policy: "smart",
      path: "direct",
    });
    store.logError("seg_old_text", "cam_text", "stage", "old error");
    store.saveTrace(makeTrace("seg_old_text", "cam_text", now - 100 * DAY_MS));
    store.saveLlmCall(makeLlmCall("seg_old_text", "cam_text", now - 100 * DAY_MS));
    store.logMemoryWriteFailure({
      segment_id: "seg_old_text",
      camera_id: "cam_text",
      user_id: "admin",
      attempts: 2,
      error: "old failure",
      request: { video_id: "seg_old_text" },
    });
    dbOf(store).prepare("UPDATE notification_log SET created_at = ? WHERE segment_id = ?")
      .run(sqliteDate(now - 100 * DAY_MS), "seg_old_text");
    dbOf(store).prepare("UPDATE pipeline_errors SET created_at = ? WHERE segment_id = ?")
      .run(sqliteDate(now - 100 * DAY_MS), "seg_old_text");
    dbOf(store).prepare("UPDATE memory_write_failures SET created_at = ? WHERE segment_id = ?")
      .run(sqliteDate(now - 100 * DAY_MS), "seg_old_text");

    const result = store.runRetention({
      mediaRetentionDays: 0,
      textRetentionDays: 90,
      nowMs: now,
    });

    expect(result.pipelineRowsDeleted).toBe(1);
    expect(result.notificationRowsDeleted).toBe(1);
    expect(result.errorRowsDeleted).toBe(1);
    expect(result.traceRowsDeleted).toBe(1);
    expect(result.llmCallRowsDeleted).toBe(1);
    expect(result.memoryWriteFailureRowsDeleted).toBe(1);
    expect(store.getBySegmentId("seg_old_text")).toBeNull();
    expect(store.getBySegmentId("seg_recent_text")).not.toBeNull();
    expect(dbOf(store).prepare("SELECT COUNT(*) as count FROM llm_calls").get()).toMatchObject({ count: 0 });
    expect(store.getRecentMemoryWriteFailures("cam_text")).toHaveLength(0);
  });

  it("clearCamera and clearAll remove LLM calls and memory write dead letters", () => {
    logSegment(store, "seg_cam_a", "cam_a");
    logSegment(store, "seg_cam_b", "cam_b");
    store.saveLlmCall(makeLlmCall("seg_cam_a", "cam_a", now));
    store.saveLlmCall({
      ...makeLlmCall("seg_cam_a", "cam_a", now),
      call_id: "call_seg_cam_a_no_camera",
      camera_id: undefined,
    });
    store.saveLlmCall(makeLlmCall("seg_cam_b", "cam_b", now));
    store.logMemoryWriteFailure({
      segment_id: "seg_cam_a",
      camera_id: "cam_a",
      user_id: "admin",
      attempts: 2,
      error: "failed",
      request: { video_id: "seg_cam_a" },
    });
    store.logMemoryWriteFailure({
      segment_id: "seg_cam_b",
      camera_id: "cam_b",
      user_id: "admin",
      attempts: 2,
      error: "failed",
      request: { video_id: "seg_cam_b" },
    });

    store.clearCamera("cam_a");

    expect(dbOf(store).prepare("SELECT COUNT(*) as count FROM llm_calls WHERE camera_id = 'cam_a'").get()).toMatchObject({ count: 0 });
    expect(dbOf(store).prepare("SELECT COUNT(*) as count FROM llm_calls WHERE call_id = 'call_seg_cam_a_no_camera'").get()).toMatchObject({ count: 0 });
    expect(dbOf(store).prepare("SELECT COUNT(*) as count FROM llm_calls WHERE camera_id = 'cam_b'").get()).toMatchObject({ count: 1 });
    expect(store.getRecentMemoryWriteFailures("cam_a")).toHaveLength(0);
    expect(store.getRecentMemoryWriteFailures("cam_b")).toHaveLength(1);

    store.clearAll();

    expect(dbOf(store).prepare("SELECT COUNT(*) as count FROM llm_calls").get()).toMatchObject({ count: 0 });
    expect(store.getRecentMemoryWriteFailures()).toHaveLength(0);
  });
});
