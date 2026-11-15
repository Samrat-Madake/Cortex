import { describe, expect, it } from "vitest";
import type { MonitorEvent } from "../types";
import { deriveEntitySightings } from "./useEntitySightings";

function canonicalSegment(segmentId: string): MonitorEvent {
  return {
    type: "dashboard:segment_state",
    timestamp: 2_000,
    camera_id: "cam-a",
    data: {
      segment_id: segmentId,
      camera_id: "cam-a",
      start_time: 2_000,
      targets: [{
        entity_id: "entity-7",
        ref: "person:7",
        label: "Person 7",
        keyframe_path: "/tmp/media/canonical.jpg",
        crop_path: "/tmp/media/canonical-crop.jpg",
        is_new: true,
      }],
    },
  };
}

function rawVlm(segmentId: string): MonitorEvent {
  return {
    type: "perception:vlm_result",
    timestamp: 1_000,
    camera_id: "cam-a",
    data: {
      segment_id: segmentId,
      segment_start: 1_000,
      main_targets: [{
        entity_id: "entity-1",
        keyframe_path: "/tmp/media/raw.jpg",
        crop_path: "/tmp/media/raw-crop.jpg",
        is_new: false,
      }],
    },
  };
}

function sourceState(cameraId: string, extra: Record<string, unknown> = {}): MonitorEvent {
  return {
    type: "dashboard:source_state",
    timestamp: 500,
    camera_id: cameraId,
    data: {
      source_id: cameraId,
      status: "active",
      ...extra,
    },
  };
}

describe("deriveEntitySightings", () => {
  it("prefers canonical segment targets over raw VLM targets for the same segment", () => {
    const sightings = deriveEntitySightings([
      rawVlm("seg-1"),
      canonicalSegment("seg-1"),
    ]);

    expect(sightings.get("entity-7")).toEqual([{
      timestamp: 2_000,
      display_time_mode: "wall_clock",
      camera_id: "cam-a",
      is_media_source: false,
      keyframe_url: "/media/canonical-crop.jpg",
      image_is_crop: true,
      bbox: null,
      face_bbox: null,
      is_new: true,
    }]);
    expect(sightings.get("person:7")).toBeUndefined();
  });

  it("keeps raw VLM sightings when no canonical segment is available", () => {
    const sightings = deriveEntitySightings([rawVlm("seg-legacy")]);

    expect(sightings.get("entity-1")).toHaveLength(1);
    expect(sightings.get("entity-1")?.[0]?.keyframe_url).toBe("/media/raw-crop.jpg");
  });

  it("does not include entity sightings without a target crop", () => {
    const event = canonicalSegment("seg-no-crop");
    const target = (event.data.targets as Array<Record<string, unknown>>)[0]!;
    delete target.crop_path;

    const sightings = deriveEntitySightings([event]);

    expect(sightings.size).toBe(0);
  });

  it("prefers target crop over full-frame keyframe for entity sightings", () => {
    const event = canonicalSegment("seg-crop");
    const target = (event.data.targets as Array<Record<string, unknown>>)[0]!;
    target.keyframe_path = "/tmp/media/full-frame.jpg";
    target.crop_path = "/tmp/media/target-crop.jpg";

    const sightings = deriveEntitySightings([event]);

    expect(sightings.get("entity-7")?.[0]?.keyframe_url).toBe("/media/target-crop.jpg");
    expect(sightings.get("entity-7")?.[0]?.image_is_crop).toBe(true);
  });

  it("preserves backend avatar quality fields for canonical entity sightings", () => {
    const event = canonicalSegment("seg-quality");
    const target = (event.data.targets as Array<Record<string, unknown>>)[0]!;
    target.face_quality = 0.92;
    target.face_yaw = -4;
    target.face_pitch = 8;
    target.avatar_score = 0.97;

    const sightings = deriveEntitySightings([event]);

    expect(sightings.get("entity-7")?.[0]).toMatchObject({
      face_quality: 0.92,
      face_yaw: -4,
      face_pitch: 8,
      avatar_score: 0.97,
    });
  });

  it("marks upload video sightings as media-time based", () => {
    const event = canonicalSegment("seg-upload");
    event.data.is_media_source = true;
    event.data.start_time = 1_719_120_060_000;
    event.data.display_start_time = 73_024;
    event.data.display_time_mode = "media";

    const sightings = deriveEntitySightings([event]);

    expect(sightings.get("entity-7")?.[0]).toMatchObject({
      timestamp: 73_024,
      display_time_mode: "media",
      is_media_source: true,
    });
  });

  it("infers media-time from canonical video source labels", () => {
    const event = canonicalSegment("seg-video-label");
    event.data.is_media_source = false;
    event.data.source_label = "talk_1.mp4";
    event.data.start_time = 1_719_120_060_000;
    event.data.display_start_time = 282_000;

    const sightings = deriveEntitySightings([event]);

    expect(sightings.get("entity-7")?.[0]).toMatchObject({
      timestamp: 282_000,
      display_time_mode: "media",
      is_media_source: true,
    });
  });

  it("uses source metadata to keep canonical upload sightings in media time", () => {
    const event = canonicalSegment("seg-source-upload");
    event.camera_id = "cam-upload";
    event.data.camera_id = "cam-upload";
    event.data.start_time = 0;
    event.data.display_start_time = 0;

    const sightings = deriveEntitySightings([
      sourceState("cam-upload", {
        protocol: "file",
        video_id: "upload/talk_1.mp4",
        source_name: "talk_1.mp4",
      }),
      event,
    ]);

    expect(sightings.get("entity-7")?.[0]).toMatchObject({
      timestamp: 0,
      display_time_mode: "media",
      is_media_source: true,
    });
  });

  it("keeps wall-clock timing for true live canonical sightings", () => {
    const event = canonicalSegment("seg-live");
    event.data.is_media_source = false;
    event.data.start_time = 1_719_120_060_000;
    event.data.display_start_time = 1_719_120_060_000;
    event.data.display_time_mode = "wall_clock";

    const sightings = deriveEntitySightings([event]);

    expect(sightings.get("entity-7")?.[0]).toMatchObject({
      timestamp: 1_719_120_060_000,
      display_time_mode: "wall_clock",
      is_media_source: false,
    });
  });

  it("infers media-time for legacy upload sightings without canonical state", () => {
    const event = rawVlm("seg-legacy-upload");
    event.camera_id = "video-upload";
    event.data.video_id = "upload/talk_1.mp4";
    event.data.segment_start = 42_000;

    const sightings = deriveEntitySightings([event]);

    expect(sightings.get("entity-1")?.[0]).toMatchObject({
      timestamp: 42_000,
      display_time_mode: "media",
      is_media_source: true,
    });
  });

  it("does not promote canonical event-local refs into entity sightings", () => {
    const event = canonicalSegment("seg-local");
    const target = (event.data.targets as Array<Record<string, unknown>>)[0]!;
    delete target.entity_id;

    const sightings = deriveEntitySightings([event]);

    expect(sightings.size).toBe(0);
  });
});
