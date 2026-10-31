import { describe, expect, it } from "vitest";
import type { MonitorEvent } from "../types";
import { deriveSegments } from "./useSegments";

function sourceEvent(cameraId: string, data: Record<string, unknown>): MonitorEvent {
  return {
    type: "dashboard:source_state",
    timestamp: 0,
    camera_id: cameraId,
    data: {
      source_id: cameraId,
      status: "active",
      ...data,
    },
  };
}

function idleSegment(cameraId: string, segmentId: string, start: number): MonitorEvent {
  return {
    type: "memory:memory_added",
    timestamp: start,
    camera_id: cameraId,
    data: {
      memory_type: "episodic",
      segment_id: segmentId,
      event_id: `evt-${segmentId}`,
      segment_start: start,
      duration_sec: 5,
      is_static: true,
      vlm_model: "local-idle-skip",
      summary: "Static scene",
    },
  };
}

describe("deriveSegments", () => {
  it("preserves canonical preview vlm_model markers", () => {
    const segments = deriveSegments([
      {
        type: "dashboard:segment_state",
        timestamp: 1_000,
        camera_id: "cam-live",
        data: {
          timeline_type: "segment",
          segment_id: "seg-preview",
          event_id: "seg-preview",
          camera_id: "cam-live",
          source_label: "Live camera",
          start_time: 1_000,
          end_time: 2_000,
          duration_sec: 1,
          vlm_model: "watching-preview",
          summary: "Seeing people.",
          keyframe_url: "/media/cam-live/keyframe/seg-preview_1.jpg",
          targets: [{ type: "person", entity_id: "entity-1", ref: "person:7" }],
          entity_ids: ["entity-1"],
          entity_refs: ["person:7"],
        },
      },
    ]);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      segment_id: "seg-preview",
      vlm_model: "watching-preview",
      summary: "Seeing people.",
      entity_ids: ["entity-1"],
      entity_refs: ["person:7"],
    });
  });

  it("preserves queued preview state as a non-final segment", () => {
    const segments = deriveSegments([
      {
        type: "dashboard:segment_state",
        timestamp: 2_000,
        camera_id: "video-upload",
        data: {
          timeline_type: "segment",
          segment_id: "seg-queued",
          event_id: "seg-queued",
          camera_id: "video-upload",
          source_label: "clip.mp4",
          is_media_source: true,
          start_time: 10_000,
          end_time: 20_000,
          duration_sec: 10,
          vlm_model: "queued-preview",
          title: "Waiting for analysis",
          summary: "Seeing people.",
          targets: [],
          analysis_status: "partial",
          is_partial: true,
        },
      },
    ]);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      segment_id: "seg-queued",
      vlm_model: "queued-preview",
      title: "Waiting for analysis",
      analysis_status: "partial",
      is_partial: true,
    });
  });

  it("uses media display and sort timestamps for live-like upload previews", () => {
    const segments = deriveSegments([
      {
        type: "dashboard:segment_state",
        timestamp: 500_000,
        camera_id: "video-stream-upload",
        data: {
          timeline_type: "segment",
          segment_id: "seg-live-like-upload",
          event_id: "seg-live-like-upload",
          camera_id: "video-stream-upload",
          source_label: "clip.mp4",
          is_media_source: false,
          start_time: 500_000,
          end_time: 501_000,
          sort_time: 17_000,
          display_start_time: 10_000,
          display_end_time: 17_000,
          display_time_mode: "media",
          duration_sec: 1,
          vlm_model: "watching-preview",
          title: "Watching",
          summary: "Seeing people.",
          targets: [],
          analysis_status: "partial",
          is_partial: true,
        },
      },
    ]);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      segment_id: "seg-live-like-upload",
      is_media_source: false,
      sort_time: 17_000,
      display_start_time: 10_000,
      display_end_time: 17_000,
      display_time_mode: "media",
    });
  });

  it("orders canonical segments by sort_time before start_time", () => {
    const segments = deriveSegments([
      {
        type: "dashboard:segment_state",
        timestamp: 1,
        camera_id: "video-stream-upload",
        data: {
          timeline_type: "segment",
          segment_id: "seg-later-wall-clock",
          event_id: "seg-later-wall-clock",
          camera_id: "video-stream-upload",
          source_label: "clip.mp4",
          start_time: 900_000,
          end_time: 901_000,
          sort_time: 5_000,
          duration_sec: 1,
          summary: "First media segment.",
          targets: [],
        },
      },
      {
        type: "dashboard:segment_state",
        timestamp: 2,
        camera_id: "video-stream-upload",
        data: {
          timeline_type: "segment",
          segment_id: "seg-later-media",
          event_id: "seg-later-media",
          camera_id: "video-stream-upload",
          source_label: "clip.mp4",
          start_time: 800_000,
          end_time: 801_000,
          sort_time: 15_000,
          duration_sec: 1,
          summary: "Second media segment.",
          targets: [],
        },
      },
    ]);

    expect(segments.map((segment) => segment.segment_id)).toEqual([
      "seg-later-media",
      "seg-later-wall-clock",
    ]);
  });

  it("keeps keyframe and clip media for canonical VLM static segments", () => {
    const segments = deriveSegments([
      {
        type: "dashboard:segment_state",
        timestamp: 2_000,
        camera_id: "cam-live",
        data: {
          timeline_type: "segment",
          segment_id: "seg-static",
          event_id: "seg-static",
          camera_id: "cam-live",
          source_label: "Live camera",
          start_time: 10_000,
          end_time: 20_000,
          duration_sec: 10,
          vlm_model: "gpt-5-mini",
          title: "Static Scene",
          summary: "No meaningful activity changed.",
          is_static: true,
          keyframe_url: "/media/cam-live/keyframe/seg-static.jpg",
          gif_url: "/media/cam-live/gif/seg-static.gif",
          clip_url: "/api/segment/seg-static/clip",
          targets: [{ target_id: "D1", type: "person" }],
        },
      },
    ]);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      timeline_type: "segment",
      is_static: true,
      keyframe_url: "/media/cam-live/keyframe/seg-static.jpg",
      gif_url: "/media/cam-live/gif/seg-static.gif",
      clip_url: "/api/segment/seg-static/clip",
    });
    expect(segments[0]?.targets).toHaveLength(1);
  });

  it("clears media for canonical static gap rows", () => {
    const segments = deriveSegments([
      {
        type: "dashboard:segment_state",
        timestamp: 2_000,
        camera_id: "cam-live",
        data: {
          timeline_type: "static_gap",
          segment_id: "static_gap:cam-live:10000",
          event_id: "static_gap:cam-live:10000",
          camera_id: "cam-live",
          source_label: "Live camera",
          start_time: 10_000,
          end_time: 20_000,
          duration_sec: 10,
          vlm_model: "local-idle-skip",
          summary: "Static Scene",
          is_static: true,
          keyframe_url: "/media/cam-live/keyframe/seg-static.jpg",
          clip_url: "/api/segment/seg-static/clip",
          targets: [{ target_id: "D1", type: "person" }],
        },
      },
    ]);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      timeline_type: "static_gap",
      keyframe_url: null,
      clip_url: null,
      targets: [],
    });
  });

  it("merges live idle-skip static segments into one legacy static range", () => {
    const segments = deriveSegments([
      sourceEvent("cam-live", { protocol: "rtsp", source_name: "Live camera" }),
      idleSegment("cam-live", "seg-live-b", 6_000),
      idleSegment("cam-live", "seg-live-a", 1_000),
    ]);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      camera_id: "cam-live",
      is_static: true,
      is_media_source: false,
      merged_count: 2,
      duration_sec: 10,
    });
  });

  it("does not merge uploaded/local-file idle-skip segments in the legacy fallback", () => {
    const segments = deriveSegments([
      sourceEvent("video-upload", {
        protocol: "file",
        video_id: "upload/clip.mp4",
        source_name: "clip.mp4",
      }),
      idleSegment("video-upload", "seg-upload-b", 6_000),
      idleSegment("video-upload", "seg-upload-a", 1_000),
    ]);

    expect(segments).toHaveLength(2);
    expect(segments.map((segment) => segment.segment_id)).toEqual(["seg-upload-b", "seg-upload-a"]);
    expect(segments.every((segment) => segment.is_media_source)).toBe(true);
    expect(segments.every((segment) => segment.merged_count === 1)).toBe(true);
  });
});
