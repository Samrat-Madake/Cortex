import { describe, expect, it, vi } from "vitest";
import type { PerceptionResult, Segment } from "@reflectworld/shared";
import { buildPerceptionAddRequest, buildSourceTimeMetadata, createMemoryReidAdapter } from "../memory-adapter.js";

function makeSegment(): Segment {
  return {
    segment_id: "seg_speaker",
    camera_id: "cam_speaker",
    mode: "stream",
    frames: [],
    raw_url: "/raw/seg_speaker.mp4",
    timestamp: 1_000,
    duration_sec: 4,
  };
}

function makeResult(): PerceptionResult {
  return {
    segment_id: "seg_speaker",
    camera_id: "cam_speaker",
    mode: "stream",
    event_id: "event_speaker",
    media_urls: {
      raw: "/raw/seg_speaker.mp4",
      keyframes: [],
      crops: [],
    },
    perception_memory: {
      summary: "Two people are speaking.",
      detailed_summary: "One known person and one event-local target speak in the room.",
      retrieval_compact: ["Alex self-introduction", "gray hoodie seated right"],
      security_risk: false,
      timestamp: 1_000,
      entities: [{
        type: "person",
        entity_id: "entity_known",
        track_id: "D0",
        subject_index: 1,
        appearance: "known speaker",
        name: "Alex",
        identity_evidence: "introduced as Alex",
      }, {
        type: "person",
        track_id: "D1",
        subject_index: 2,
        appearance: "a gray hoodie seated on the right side",
        name: "Taylor",
      }],
      perception_level: 1,
      strategy_context: "stream/level1",
      is_static_scene: false,
    },
    dialogue: [
      {
        text_start: 0.5,
        track_id: "D0",
        entity_id: "entity_known",
        identity_level: "entity_id",
        confidence: "high",
        text: "I am Alex.",
      },
      {
        text_start: 1.5,
        track_id: "D1",
        entity_id: "entity_should_not_be_used",
        identity_level: "event_local",
        confidence: "high",
        text: "I am only visible in this event.",
      },
      {
        text_start: 2.5,
        identity_level: "unknown",
        confidence: "low",
        text: "This speaker was not visually grounded.",
      },
    ],
    transcript: "I am Alex. I am only visible in this event. This speaker was not visually grounded.",
  };
}

describe("buildPerceptionAddRequest speaker identity", () => {
  it("only writes stable entity-level speaker identity into entity observations", () => {
    const { request, context } = buildPerceptionAddRequest({
      result: makeResult(),
      segment: makeSegment(),
      userId: "user_test",
    });

    expect(context.entityObservations).toEqual([
      expect.objectContaining({ entity_id: "entity_known", class_name: "person" }),
      expect.objectContaining({ entity_id: "entity_known", message: expect.stringContaining("Alex") }),
    ]);
    expect(context.entityObservations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entity_id: "entity_should_not_be_used" }),
      ]),
    );
    expect(request.video_data.speech_events_text).toContain('00:00.50: Alex said: "I am Alex."');
    expect(request.video_data.speech_events_text).toContain(
      '00:01.50: Taylor said: "I am only visible in this event."',
    );
    expect(request.video_data.speech_events_text).toContain(
      '00:02.50: Speaker 3 said: "This speaker was not visually grounded."',
    );
    expect(request.metadata).toMatchObject({
      dialogue: expect.any(Array),
      identity_observations: [
        expect.objectContaining({ entity_id: "entity_known", name: "Alex" }),
      ],
    });
    expect(request.video_data.speech_events_text).not.toContain("entity_known said");
    expect(request.video_data.speech_events_text).not.toContain("D1 said");
    expect(request.video_data.speech_events_text).not.toContain("speaker_1 is D1");
    expect(request.video_data.speech_events_text).not.toContain("entity_should_not_be_used");
    expect(request.video_data.retrieval_compact).toEqual(["Alex self-introduction", "gray hoodie seated right"]);
    expect(request.metadata.retrieval_compact).toEqual(["Alex self-introduction", "gray hoodie seated right"]);
    expect(request.metadata.speech_text).toBe(
      "I am Alex. I am only visible in this event. This speaker was not visually grounded.",
    );
    expect(request.video_data.speaker_notes).toBeUndefined();
  });

  it("writes source time metadata with backward-compatible media offsets", () => {
    const { request } = buildPerceptionAddRequest({
      result: makeResult(),
      segment: makeSegment(),
      userId: "user_test",
    });

    expect(request.metadata.media_start_ms).toBe(1_000);
    expect(request.metadata.media_duration_ms).toBe(4_000);
    expect(request.metadata.source_time_label).toBe("00:00:01-00:00:05");
    expect(request.metadata.time_basis).toBe("video_relative");
  });

  it("supports dataset day-time source labels for multi-day datasets", () => {
    const segment = {
      ...makeSegment(),
      timestamp: 86_400_000 + 3_723_450,
      duration_sec: 30,
    };
    const { request } = buildPerceptionAddRequest({
      result: makeResult(),
      segment,
      userId: "user_test",
      sourceTimeMetadata: buildSourceTimeMetadata(segment.timestamp, 30_000, "dataset_day_time"),
    });

    expect(request.metadata.source_time_label).toBe("DAY2 01:02:03.45-DAY2 01:02:33.45");
    expect(request.metadata.time_basis).toBe("dataset_day_time");
  });
});

describe("createMemoryReidAdapter batch-init compatibility", () => {
  const baseMemClient = {
    reidSearch: vi.fn(),
    reidUpsert: vi.fn(),
    reidGalleryUpdate: vi.fn(),
  };

  it("does not expose batch-init operations for legacy clients", () => {
    const adapter = createMemoryReidAdapter({
      memClient: baseMemClient,
      userId: "user_test",
    });

    expect(adapter.reserveEntityId).toBeUndefined();
    expect(adapter.reidBatchInit).toBeUndefined();
  });

  it("scopes all ReID operations by user_id", async () => {
    const reidSearch = vi.fn().mockResolvedValue({ results: [] });
    const reidUpsert = vi.fn().mockResolvedValue({
      entity_id: "entity_1",
      id: "row_1",
      collection: "reid_face",
      event: "INSERT",
    });
    const reidGalleryUpdate = vi.fn().mockResolvedValue({
      entity_id: "entity_1",
      collection: "reid_face",
      action: "ADD",
      slot_idx: 0,
    });
    const adapter = createMemoryReidAdapter({
      memClient: { reidSearch, reidUpsert, reidGalleryUpdate },
      userId: "user_reid",
      cameraId: () => "cam_reid",
    });

    await adapter.reidSearch?.([0.1, 0.2], "face");
    await adapter.reidUpsert?.({ face: { vector: [0.3], quality: 0.9 } });
    await adapter.reidGalleryUpdate?.("entity_1", { body: { vector: [0.4], quality: 0.8 } });

    expect(reidSearch).toHaveBeenCalledWith(expect.objectContaining({ user_id: "user_reid" }));
    expect(reidSearch).not.toHaveBeenCalledWith(expect.objectContaining({ camera_id: "cam_reid" }));
    expect(reidUpsert).toHaveBeenCalledWith(expect.objectContaining({
      entity_id: expect.stringMatching(/^entity_[a-f0-9]{12}$/),
      user_id: "user_reid",
      camera_id: "cam_reid",
    }));
    expect(reidGalleryUpdate).toHaveBeenCalledWith(expect.objectContaining({ user_id: "user_reid", camera_id: "cam_reid" }));
  });

  it("exposes batch-init operations when the client supports them", async () => {
    const reidBatchInit = vi.fn().mockResolvedValue({
      entity_id: "entity_1",
      face_slots_written: 2,
      body_slots_written: 0,
      event: "BATCH_INIT",
    });
    const adapter = createMemoryReidAdapter({
      memClient: { ...baseMemClient, reidBatchInit },
      userId: "user_test",
      cameraId: () => "cam_test",
    });

    const entityId = adapter.reserveEntityId?.();
    expect(entityId).toMatch(/^entity_[a-f0-9]{12}$/);
    const result = await adapter.reidBatchInit?.({
      entity_id: entityId!,
      face_vectors: [{ vector: [0.1, 0.2], quality: 0.9 }],
    });

    expect(result).toMatchObject({ entity_id: "entity_1", event: "BATCH_INIT" });
    expect(reidBatchInit).toHaveBeenCalledWith({
      entity_id: entityId,
      face_vectors: [{ vector: [0.1, 0.2], quality: 0.9 }],
      user_id: "user_test",
      camera_id: "cam_test",
    });
  });

  it("passes host-allocated subject_index when updating identity names", async () => {
    const reidUpdateIdentity = vi.fn().mockResolvedValue({
      entity_id: "entity_1",
      name: "Alex",
      subject_index: 7,
      updated: 1,
    });
    const adapter = createMemoryReidAdapter({
      memClient: { ...baseMemClient, reidUpdateIdentity },
      userId: "user_test",
    });

    await adapter.reidUpdateIdentity?.("entity_1", "Alex", { subject_index: 7 });

    expect(reidUpdateIdentity).toHaveBeenCalledWith({
      entity_id: "entity_1",
      name: "Alex",
      user_id: "user_test",
      subject_index: 7,
    });
  });
});
