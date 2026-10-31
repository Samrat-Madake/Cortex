import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorBus, type MonitorEvent, type Segment } from "@reflectworld/shared";
import { DashboardServer } from "../services/dashboard-server.js";

describe("DashboardServer partial segment projection", () => {
  it("keeps at most one active watching preview per camera", () => {
    const server = new DashboardServer({
      distDir: "/nonexistent",
      port: 0,
      getActiveSources: () => [{
        source_id: "cam-live",
        source_name: "Live camera",
        status: "active",
        protocol: "rtsp",
      }],
    });
    const access = server as unknown as {
      publishSegmentWatchingPreview: DashboardServer["publishSegmentWatchingPreview"];
      broadcastDashboardEnvelope: ReturnType<typeof vi.fn>;
    };
    access.broadcastDashboardEnvelope = vi.fn();

    access.publishSegmentWatchingPreview({
      segmentId: "seg-a",
      cameraId: "cam-live",
      timestamp: 1_000,
      currentTimestamp: 1_000,
      detections: [],
      inputMode: "live_stream",
    });
    access.publishSegmentWatchingPreview({
      segmentId: "seg-b",
      cameraId: "cam-live",
      timestamp: 2_000,
      currentTimestamp: 2_000,
      detections: [],
      inputMode: "live_stream",
    });

    expect(access.broadcastDashboardEnvelope).toHaveBeenCalledTimes(3);
    expect(access.broadcastDashboardEnvelope.mock.calls[1]![0]).toMatchObject({
      domain: "segment",
      id: "seg-a",
      data: {
        segment_id: "seg-a",
        vlm_model: "queued-preview",
        title: "Waiting for analysis",
        summary: "Segment cut. Waiting for analysis.",
      },
    });
    expect(access.broadcastDashboardEnvelope.mock.calls[2]![0]).toMatchObject({
      domain: "segment",
      id: "seg-b",
      data: {
        segment_id: "seg-b",
        vlm_model: "watching-preview",
        title: "Watching",
      },
    });
  });

  it("turns a watching preview into processing once VLM partial output arrives", async () => {
    const server = new DashboardServer({
      distDir: "/nonexistent",
      port: 0,
      getActiveSources: () => [{
        source_id: "video-test",
        source_name: "sample.mp4",
        status: "active",
        protocol: "file",
        video_id: "sample.mp4",
      }],
    });
    const access = server as unknown as {
      projectRawMonitorEvent(event: MonitorEvent): Promise<void>;
      publishSegmentWatchingPreview: DashboardServer["publishSegmentWatchingPreview"];
      broadcastDashboardEnvelope: ReturnType<typeof vi.fn>;
    };
    access.broadcastDashboardEnvelope = vi.fn();

    access.publishSegmentWatchingPreview({
      segmentId: "seg-1",
      cameraId: "video-test",
      timestamp: 12_000,
      currentTimestamp: 13_000,
      detections: [],
      inputMode: "live_stream",
    });
    await access.projectRawMonitorEvent({
      type: "perception:segment_partial",
      timestamp: 1_700_000_000_000,
      camera_id: "video-test",
      data: {
        camera_id: "video-test",
        segment_id: "seg-1",
        event_id: "evt-1",
        segment_start: 12_000,
        duration_sec: 6,
        field: "summary",
        value: "A person enters the hallway.",
      },
    });

    expect(access.broadcastDashboardEnvelope.mock.calls.at(-1)![0]).toMatchObject({
      domain: "segment",
      id: "seg-1",
      data: {
        segment_id: "seg-1",
        vlm_model: "processing-preview",
        analysis_status: "partial",
        is_partial: true,
        summary: "A person enters the hallway.",
      },
    });
  });

  it("projects stream-upload watching duration from media timestamps", () => {
    const server = new DashboardServer({
      distDir: "/nonexistent",
      port: 0,
      getActiveSources: () => [{
        source_id: "video-upload",
        source_name: "clip.mp4",
        status: "active",
        protocol: "file",
        video_id: "upload/clip.mp4",
      }],
    });
    const access = server as unknown as {
      publishSegmentWatchingPreview: DashboardServer["publishSegmentWatchingPreview"];
      broadcastDashboardEnvelope: ReturnType<typeof vi.fn>;
    };
    access.broadcastDashboardEnvelope = vi.fn();

    access.publishSegmentWatchingPreview({
      segmentId: "seg-upload",
      cameraId: "video-upload",
      timestamp: 10_000,
      currentTimestamp: 17_500,
      detections: [],
      inputMode: "live_stream",
    });

    expect(access.broadcastDashboardEnvelope).toHaveBeenCalledTimes(1);
    expect(access.broadcastDashboardEnvelope.mock.calls[0]![0]).toMatchObject({
      domain: "segment",
      id: "seg-upload",
      data: {
        segment_id: "seg-upload",
        vlm_model: "watching-preview",
        display_start_time: 10_000,
        display_end_time: 17_500,
        display_time_mode: "media",
        duration_sec: 7.5,
      },
    });
  });

  it("updates an active processing preview with an animated preview path", () => {
    const server = new DashboardServer({
      distDir: "/nonexistent",
      port: 0,
      getActiveSources: () => [{
        source_id: "video-upload",
        source_name: "clip.mp4",
        status: "active",
        protocol: "file",
        video_id: "upload/clip.mp4",
      }],
    });
    const access = server as unknown as {
      publishSegmentProcessingPreview: DashboardServer["publishSegmentProcessingPreview"];
      partialSegmentStates: Map<string, { gif_url?: string | null }>;
      broadcastDashboardEnvelope: ReturnType<typeof vi.fn>;
    };
    access.broadcastDashboardEnvelope = vi.fn();
    const segment: Segment = {
      segment_id: "seg-processing",
      camera_id: "video-upload",
      mode: "stream",
      timestamp: 10_000,
      duration_sec: 8,
      frames: [],
      raw_url: "/recordings/video-upload",
      _input_mode: "live_stream",
    };

    access.publishSegmentProcessingPreview(segment);
    access.publishSegmentProcessingPreview(segment, "/tmp/media/video-upload/gif/seg-processing_preview.webp");

    expect(access.partialSegmentStates.get("seg-processing")?.gif_url).toBe("/media/video-upload/gif/seg-processing_preview.webp");
    expect(access.broadcastDashboardEnvelope.mock.calls.at(-1)![0]).toMatchObject({
      domain: "segment",
      id: "seg-processing",
      data: {
        segment_id: "seg-processing",
        vlm_model: "processing-preview",
        gif_url: "/media/video-upload/gif/seg-processing_preview.webp",
      },
    });
  });

  it("does not recreate a processing preview for a late animated preview path", () => {
    const server = new DashboardServer({
      distDir: "/nonexistent",
      port: 0,
      getActiveSources: () => [],
    });
    const access = server as unknown as {
      publishSegmentProcessingPreview: DashboardServer["publishSegmentProcessingPreview"];
      partialSegmentStates: Map<string, unknown>;
      broadcastDashboardEnvelope: ReturnType<typeof vi.fn>;
    };
    access.broadcastDashboardEnvelope = vi.fn();
    const segment: Segment = {
      segment_id: "seg-late",
      camera_id: "video-upload",
      mode: "stream",
      timestamp: 10_000,
      duration_sec: 8,
      frames: [],
      raw_url: "/recordings/video-upload",
      _input_mode: "live_stream",
    };

    access.publishSegmentProcessingPreview(segment, "/tmp/media/video-upload/gif/seg-late_preview.webp");

    expect(access.partialSegmentStates.has("seg-late")).toBe(false);
    expect(access.broadcastDashboardEnvelope).not.toHaveBeenCalled();
  });

  it("marks queued previews as skipped when perception backlog drops the segment", () => {
    const server = new DashboardServer({
      distDir: "/nonexistent",
      port: 0,
      getActiveSources: () => [{
        source_id: "cam-live",
        source_name: "Live camera",
        status: "active",
        protocol: "rtsp",
      }],
    });
    const access = server as unknown as {
      publishSegmentQueuedPreview: DashboardServer["publishSegmentQueuedPreview"];
      publishSegmentSkippedPreview: DashboardServer["publishSegmentSkippedPreview"];
      broadcastDashboardEnvelope: ReturnType<typeof vi.fn>;
      partialSegmentStates: Map<string, unknown>;
    };
    access.broadcastDashboardEnvelope = vi.fn();
    const segment: Segment = {
      segment_id: "seg-skip",
      camera_id: "cam-live",
      mode: "stream",
      timestamp: 1_000,
      duration_sec: 10,
      frames: [],
      raw_url: "/recordings/cam-live",
      _input_mode: "live_stream",
    };

    access.publishSegmentQueuedPreview(segment);
    expect(access.partialSegmentStates.has("seg-skip")).toBe(true);
    access.publishSegmentSkippedPreview(segment, {
      reason: "backlog_lag_exceeded",
      lagMs: 190_000,
      thresholdMs: 180_000,
      skippedTotal: 1,
    });
    expect(access.partialSegmentStates.has("seg-skip")).toBe(false);

    expect(access.broadcastDashboardEnvelope.mock.calls.at(-1)![0]).toMatchObject({
      domain: "segment",
      id: "seg-skip",
      data: {
        segment_id: "seg-skip",
        vlm_model: "backlog-skip",
        title: "Skipped",
        analysis_status: "skipped",
        is_partial: false,
        summary: "Perception skipped this segment because analysis fell behind live video.",
      },
    });
  });

  it("hydrates in-flight preview segments from the canonical snapshot", () => {
    const server = new DashboardServer({
      distDir: "/nonexistent",
      port: 0,
      getActiveSources: () => [{
        source_id: "video-upload",
        source_name: "clip.mp4",
        status: "active",
        protocol: "file",
        video_id: "upload/clip.mp4",
      }],
    });
    const access = server as unknown as {
      publishSegmentWatchingPreview: DashboardServer["publishSegmentWatchingPreview"];
      buildDashboardSegments(limit: number): ReturnType<DashboardServer["buildDashboardSegments"]>;
      broadcastDashboardEnvelope: ReturnType<typeof vi.fn>;
    };
    access.broadcastDashboardEnvelope = vi.fn();

    access.publishSegmentWatchingPreview({
      segmentId: "seg-in-flight",
      cameraId: "video-upload",
      timestamp: 10_000,
      currentTimestamp: 12_000,
      detections: [],
      inputMode: "live_stream",
    });

    expect(access.buildDashboardSegments(100)).toEqual([
      expect.objectContaining({
        segment_id: "seg-in-flight",
        vlm_model: "watching-preview",
        analysis_status: "partial",
        is_partial: true,
      }),
    ]);
  });

  it("removes tail watching preview when a source stops", async () => {
    const server = new DashboardServer({
      distDir: "/nonexistent",
      port: 0,
      getActiveSources: () => [{
        source_id: "video-upload",
        source_name: "clip.mp4",
        status: "stopped",
        protocol: "file",
        video_id: "upload/clip.mp4",
      }],
    });
    const access = server as unknown as {
      projectRawMonitorEvent(event: MonitorEvent): Promise<void>;
      publishSegmentWatchingPreview: DashboardServer["publishSegmentWatchingPreview"];
      partialSegmentStates: Map<string, unknown>;
      broadcastDashboardEnvelope: ReturnType<typeof vi.fn>;
    };
    access.broadcastDashboardEnvelope = vi.fn();

    access.publishSegmentWatchingPreview({
      segmentId: "seg-tail",
      cameraId: "video-upload",
      timestamp: 50_000,
      currentTimestamp: 58_000,
      detections: [],
      inputMode: "live_stream",
    });
    expect(access.partialSegmentStates.has("seg-tail")).toBe(true);

    await access.projectRawMonitorEvent({
      type: "cam:watch_stopped",
      timestamp: 1_700_000_000_000,
      camera_id: "video-upload",
      data: { source_id: "video-upload" },
    });

    expect(access.partialSegmentStates.has("seg-tail")).toBe(false);
    expect(access.broadcastDashboardEnvelope.mock.calls.some(([envelope]) => (
      envelope.domain === "segment" &&
      envelope.id === "seg-tail" &&
      envelope.op === "remove"
    ))).toBe(true);
  });

  it("removes all partial previews when a source is removed", async () => {
    const server = new DashboardServer({
      distDir: "/nonexistent",
      port: 0,
      getActiveSources: () => [],
    });
    const access = server as unknown as {
      projectRawMonitorEvent(event: MonitorEvent): Promise<void>;
      publishSegmentWatchingPreview: DashboardServer["publishSegmentWatchingPreview"];
      publishSegmentQueuedPreview: DashboardServer["publishSegmentQueuedPreview"];
      partialSegmentStates: Map<string, unknown>;
      broadcastDashboardEnvelope: ReturnType<typeof vi.fn>;
    };
    access.broadcastDashboardEnvelope = vi.fn();

    access.publishSegmentWatchingPreview({
      segmentId: "seg-watch",
      cameraId: "video-upload",
      timestamp: 50_000,
      currentTimestamp: 58_000,
      detections: [],
      inputMode: "live_stream",
    });
    access.publishSegmentQueuedPreview({
      segment_id: "seg-queued",
      camera_id: "video-upload",
      mode: "stream",
      timestamp: 58_000,
      duration_sec: 8,
      frames: [],
      raw_url: "/recordings/video-upload",
      _input_mode: "live_stream",
    });
    expect(access.partialSegmentStates.has("seg-watch")).toBe(true);
    expect(access.partialSegmentStates.has("seg-queued")).toBe(true);

    await access.projectRawMonitorEvent({
      type: "cam:source_removed",
      timestamp: 1_700_000_000_000,
      camera_id: "video-upload",
      data: { source_id: "video-upload" },
    });

    expect(access.partialSegmentStates.has("seg-watch")).toBe(false);
    expect(access.partialSegmentStates.has("seg-queued")).toBe(false);
  });

  it("does not hydrate a preview when a final segment already covers the same range", () => {
    const store = {
      getRecent: vi.fn(() => [{
        segment_id: "seg-final",
        camera_id: "video-upload",
        event_id: "evt-final",
        mode: "stream",
        summary: "Completed segment.",
        detailed_summary: "Completed segment.",
        is_static_scene: 0,
        security_risk: 0,
        notify_user: 0,
        vlm_model: "gpt-5-mini",
        entities_json: "[]",
        media_urls_json: "{}",
        dialogue_json: "{}",
        segment_start: 10_000,
        duration_sec: 10,
        frame_count: 10,
        raw_url: null,
        created_at: "2026-01-01 00:00:00",
      }]),
      getNotificationMessages: vi.fn(() => []),
    };
    const server = new DashboardServer({
      distDir: "/nonexistent",
      port: 0,
      store: store as any,
      getActiveSources: () => [{
        source_id: "video-upload",
        source_name: "clip.mp4",
        status: "active",
        protocol: "file",
        video_id: "upload/clip.mp4",
      }],
    });
    const access = server as unknown as {
      publishSegmentWatchingPreview: DashboardServer["publishSegmentWatchingPreview"];
      buildDashboardSegments(limit: number): ReturnType<DashboardServer["buildDashboardSegments"]>;
      broadcastDashboardEnvelope: ReturnType<typeof vi.fn>;
    };
    access.broadcastDashboardEnvelope = vi.fn();

    access.publishSegmentWatchingPreview({
      segmentId: "seg-preview",
      cameraId: "video-upload",
      timestamp: 10_000,
      currentTimestamp: 15_000,
      detections: [],
      inputMode: "live_stream",
    });

    const hydrated = access.buildDashboardSegments(100);
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0]).toMatchObject({
      segment_id: "seg-final",
      summary: "Completed segment.",
      analysis_status: "final",
      is_partial: false,
    });
  });

  it("broadcasts provisional segment state without requiring a pipeline row", async () => {
    const store = {
      getBySegmentId: vi.fn(() => undefined),
    };
    const server = new DashboardServer({
      distDir: "/nonexistent",
      port: 0,
      store: store as any,
      getActiveSources: () => [{
        source_id: "video-test",
        status: "active",
        protocol: "file",
        video_id: "sample.mp4",
      }],
    });
    const access = server as unknown as {
      projectRawMonitorEvent(event: MonitorEvent): Promise<void>;
      publishDashboardSegmentState: ReturnType<typeof vi.fn>;
      broadcastDashboardEnvelope: ReturnType<typeof vi.fn>;
    };
    access.publishDashboardSegmentState = vi.fn();
    access.broadcastDashboardEnvelope = vi.fn();

    await access.projectRawMonitorEvent({
      type: "perception:segment_partial",
      timestamp: 1_700_000_000_000,
      camera_id: "video-test",
      data: {
        camera_id: "video-test",
        segment_id: "seg-1",
        event_id: "evt-1",
        segment_start: 12_000,
        duration_sec: 6,
        analysis_started_at: 1_700_000_000_100,
        field: "summary",
        value: "A person enters the hallway.",
        partial_received_at: 1_700_000_005_600,
        partial_refresh_ms: 5_500,
        summary_refresh_ms: 5_500,
        vlm_ttft_ms: 4_900,
        vlm_first_content_ms: 5_200,
      },
    });

    expect(store.getBySegmentId).not.toHaveBeenCalled();
    expect(access.publishDashboardSegmentState).not.toHaveBeenCalled();
    expect(access.broadcastDashboardEnvelope).toHaveBeenCalledTimes(1);

    const envelope = access.broadcastDashboardEnvelope.mock.calls[0]![0];
    expect(envelope).toMatchObject({
      domain: "segment",
      id: "seg-1",
      op: "upsert",
      timestamp: 12_000,
      data: {
        timeline_type: "segment",
        segment_id: "seg-1",
        event_id: "evt-1",
        camera_id: "video-test",
        source_label: "sample.mp4",
        is_media_source: true,
        start_time: 12_000,
        end_time: 18_000,
        duration_sec: 6,
        summary: "A person enters the hallway.",
        detailed_summary: "A person enters the hallway.",
        targets: [],
        clip_url: null,
        analysis_status: "partial",
        is_partial: true,
        partial_received_at: 1_700_000_005_600,
        analysis_started_at: 1_700_000_000_100,
        partial_refresh_ms: 5_500,
        summary_refresh_ms: 5_500,
        vlm_ttft_ms: 4_900,
        vlm_first_content_ms: 5_200,
      },
    });

    for (const [field, value] of [
      ["title", "Hallway Entry"],
      ["security_risk", true],
      ["security_reason", "Unknown person entered after hours."],
      ["notify_user", true],
      ["matched_rule_ids", ["rule-after-hours"]],
    ] as const) {
      await access.projectRawMonitorEvent({
        type: "perception:segment_partial",
        timestamp: 1_700_000_000_001,
        camera_id: "video-test",
        data: {
          camera_id: "video-test",
          segment_id: "seg-1",
          event_id: "evt-1",
          segment_start: 12_000,
          duration_sec: 6,
          field,
          value,
        },
      });
    }

    await access.projectRawMonitorEvent({
      type: "perception:segment_partial",
      timestamp: 1_700_000_000_002,
      camera_id: "video-test",
      data: {
        camera_id: "video-test",
        segment_id: "seg-1",
        event_id: "evt-1",
        segment_start: 12_000,
        duration_sec: 6,
        field: "dialogue",
        transcript: "welcome everyone",
        value: [{
          text_start: 0.06,
          identity_level: "unknown",
          confidence: "low",
          text: "welcome everyone",
        }],
      },
    });

    const lastEnvelope = access.broadcastDashboardEnvelope.mock.calls.at(-1)![0];
    expect(lastEnvelope).toMatchObject({
      domain: "segment",
      id: "seg-1",
      op: "upsert",
      data: {
        summary: "A person enters the hallway.",
        title: "Hallway Entry",
        detailed_summary: "A person enters the hallway.",
        security_risk: true,
        notification_fired: true,
        notification_reasons: ["Unknown person entered after hours."],
        triggered_rules: ["rule-after-hours"],
        analysis_status: "partial",
        is_partial: true,
        transcript: "welcome everyone",
        dialogue: [{
          text_start: 0.06,
          speaker: "Speaker 1",
          confidence: "low",
          text: "welcome everyone",
        }],
      },
    });
  });
});

describe("DashboardServer source projection", () => {
  it("restores uploaded video preview metadata from persisted ffmpeg source input path", () => {
    const root = mkdtempSync(join(tmpdir(), "dashboard-source-"));
    const uploadsDir = join(root, "uploads");
    const server = new DashboardServer({
      distDir: "/nonexistent",
      port: 0,
      uploadsDir,
    });
    const access = server as unknown as {
      enrichSourceStatus(source: Record<string, unknown>, streams: Record<string, unknown> | null): Record<string, unknown>;
    };

    const enriched = access.enrichSourceStatus({
      source_id: "video-restored",
      source_name: "video-restored",
      input: join(uploadsDir, "talk_1.mp4"),
      protocol: "ffmpeg",
      status: "stopped",
      created_at: 1,
    }, null);

    expect(enriched.kind).toBe("upload");
    expect(enriched.video_id).toBe("upload/talk_1.mp4");
    expect(enriched.preview_url).toBe("/api/videos/preview?video_id=upload%2Ftalk_1.mp4");
    expect(enriched.media_status).toBe("preview_ready");
    expect(enriched.display_status).toBe("completed");
  });
});

describe("DashboardServer memory webhook", () => {
  it("accepts only loopback memory event types", async () => {
    const server = new DashboardServer({
      distDir: "/nonexistent",
      port: 0,
    });
    const publish = vi.spyOn(monitorBus, "publish").mockImplementation(() => undefined);

    await server.start();
    const httpServer = (server as unknown as { server: { address(): unknown } }).server;
    const address = httpServer.address() as { port: number };

    try {
      const rejected = await fetch(`http://127.0.0.1:${address.port}/api/memory-event`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "system:pipeline_trace",
          data: { camera_id: "camera-a" },
        }),
      });
      expect(rejected.status).toBe(400);
      expect(publish).not.toHaveBeenCalled();

      const accepted = await fetch(`http://127.0.0.1:${address.port}/api/memory-event`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "memory:memory_added",
          data: { camera_id: "camera-a", memory_id: "memory-1" },
        }),
      });
      expect(accepted.status).toBe(200);
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledWith(
        "memory:memory_added",
        { camera_id: "camera-a", memory_id: "memory-1" },
        "camera-a",
      );
    } finally {
      publish.mockRestore();
      server.stop();
    }
  });

  it("requires the shared token for configured internal webhooks", async () => {
    const server = new DashboardServer({
      distDir: "/nonexistent",
      port: 0,
      internalWebhookToken: "test-secret",
      dashboardSecurity: { publicMode: true },
    });

    await server.start();
    const httpServer = (server as unknown as { server: { address(): unknown } }).server;
    const address = httpServer.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const missingToken = await fetch(`${baseUrl}/api/memory-event`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "memory:memory_added", data: {} }),
      });
      expect(missingToken.status).toBe(403);

      const wrongToken = await fetch(`${baseUrl}/api/runtime-health/observe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ReflectWorld-Internal-Token": "wrong-secret",
        },
        body: JSON.stringify({}),
      });
      expect(wrongToken.status).toBe(403);

      const acceptedMemoryEvent = await fetch(`${baseUrl}/api/memory-event`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ReflectWorld-Internal-Token": "test-secret",
        },
        body: JSON.stringify({ type: "memory:memory_added", data: {} }),
      });
      expect(acceptedMemoryEvent.status).toBe(200);

      const acceptedHealthEvent = await fetch(`${baseUrl}/api/runtime-health/observe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ReflectWorld-Internal-Token": "test-secret",
        },
        body: JSON.stringify({
          producer: "memory-service",
          producer_epoch: "test-epoch",
          sequence: 1,
          component: "embedder",
          operation: "search",
          status: "ok",
          observed_at: Date.now(),
        }),
      });
      expect(acceptedHealthEvent.status).toBe(200);
    } finally {
      server.stop();
    }
  });

  it("fails closed without a token in public mode", async () => {
    const server = new DashboardServer({
      distDir: "/nonexistent",
      port: 0,
      dashboardSecurity: { publicMode: true },
    });

    await server.start();
    const httpServer = (server as unknown as { server: { address(): unknown } }).server;
    const address = httpServer.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const memoryEvent = await fetch(`${baseUrl}/api/memory-event`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "memory:memory_added", data: {} }),
      });
      expect(memoryEvent.status).toBe(403);

      const healthEvent = await fetch(`${baseUrl}/api/runtime-health/observe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(healthEvent.status).toBe(403);
    } finally {
      server.stop();
    }
  });
});
