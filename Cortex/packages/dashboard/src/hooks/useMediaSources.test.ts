import { describe, expect, it } from "vitest";
import type { MonitorEvent } from "../types";
import { deriveMediaSources } from "./useMediaSources";

function sourceState(
  id: string,
  data: Record<string, unknown>,
  timestamp = 1_000,
): MonitorEvent {
  return {
    type: "dashboard:source_state",
    timestamp,
    camera_id: id,
    data: {
      source_id: id,
      label: id,
      status: "active",
      ...data,
    },
  };
}

function syntheticLegacy(
  id: string,
  type: MonitorEvent["type"],
  data: Record<string, unknown> = {},
  timestamp = 1_000,
): MonitorEvent {
  return {
    type,
    timestamp,
    camera_id: id,
    data: {
      _synthetic: true,
      source_id: id,
      source_name: id,
      ...data,
    },
  };
}

describe("deriveMediaSources", () => {
  it("uses backend display_status for live source status", () => {
    const sources = deriveMediaSources([
      sourceState("cam-a", {
        kind: "stream_url",
        input: "rtsp://example/cam-a",
        display_status: "unavailable",
        input_kind: "url",
        status: "unavailable",
        summary: "Person entered the room.",
      }),
    ], []);

    expect(sources).toHaveLength(1);
    expect(sources[0]?.status).toBe("unavailable");
    expect(sources[0]?.liveInputKind).toBe("url");
    expect(sources[0]?.summary).toBe("Person entered the room.");
  });

  it("keeps a completed upload visible until explicit removal", () => {
    const sources = deriveMediaSources([
      sourceState("video-1", {
        kind: "upload",
        label: "clip.mp4",
        protocol: "file",
        video_id: "upload/clip.mp4",
        watch_status: "stopped",
        media_status: "preview_ready",
        analysis_status: "completed",
        display_status: "completed",
        status: "stopped",
      }),
    ], []);

    expect(sources).toHaveLength(1);
    expect(sources[0]?.kind).toBe("upload");
    expect(sources[0]?.status).toBe("completed");
    expect(sources[0]?.videoId).toBe("upload/clip.mp4");
  });

  it("uses backend can_start and can_stop flags for stopped live sources", () => {
    const sources = deriveMediaSources([
      sourceState("cam-b", {
        kind: "stream_url",
        watch_status: "stopped",
        media_status: "stopped",
        analysis_status: "none",
        display_status: "stopped",
        status: "stopped",
        can_start: true,
        can_stop: false,
      }),
    ], []);

    expect(sources[0]?.status).toBe("stopped");
    expect(sources[0]?.canStart).toBe(true);
    expect(sources[0]?.canStop).toBe(false);
  });

  it("ignores synthetic legacy source events once canonical source state exists", () => {
    const canonical = sourceState("cam-c", {
      kind: "stream_url",
      display_status: "stopped",
      status: "stopped",
    });
    const legacy = syntheticLegacy("cam-c", "cam:watch_started", { status: "active" });

    expect(deriveMediaSources([canonical, legacy], [])[0]?.status).toBe("stopped");
    expect(deriveMediaSources([legacy, canonical], [])[0]?.status).toBe("stopped");
  });

  it("removes a source from canonical dashboard state without raw cam events", () => {
    const sources = deriveMediaSources([
      sourceState("cam-d", {
        op: "remove",
      }, 2_000),
      sourceState("cam-d", {
        kind: "stream_url",
        watch_status: "running",
        media_status: "live_ready",
        analysis_status: "active",
        display_status: "active",
        status: "active",
      }, 1_000),
    ], []);

    expect(sources).toHaveLength(0);
  });

  it("does not recreate a removed upload from stale analysis status", () => {
    const sources = deriveMediaSources([
      sourceState("video-1", {
        op: "remove",
      }, 2_000),
    ], [{
      camera_id: "video-1",
      video_id: "upload/clip.mp4",
      started_at: 1_000,
      completed_at: 1_500,
      segments_count: 3,
      status: "completed",
    }]);

    expect(sources).toHaveLength(0);
  });
});
