import { describe, expect, it } from "vitest";
import type { Segment } from "@cortex/shared";
import { buildSegmentArchive } from "../pipeline/observability.js";

describe("buildSegmentArchive", () => {
  it("keeps prior event context and VLM event summary metrics separate", () => {
    const segment: Segment = {
      segment_id: "seg_archive",
      camera_id: "cam_archive",
      mode: "stream",
      frames: [
        {
          index: 0,
          timestamp: 1_700_000_000_000,
          data: "ZmFrZQ==",
        },
      ],
      raw_url: "/tmp/raw.mp4",
      timestamp: 1_700_000_000_000,
      duration_sec: 5,
    };

    const archive = buildSegmentArchive({
      segment,
      vadSpeechObserved: false,
      transcript: "hello",
      semanticContextPresent: true,
      sceneContext: "scene context",
      recentSegmentSummaries: ["old one", "old two"],
      currentEventSummary: "prior event summary",
      recentNotificationCount: 2,
      analyzerResults: [],
      segmentKeyframePaths: ["/tmp/keyframe.jpg"],
      selectedSegmentKeyframeIndex: 0,
      segmentAnalysis: {
        summary: "short summary",
        detailed_summary: "detailed summary",
      },
      subjects: [],
      shouldStoreMemory: true,
      finalEventId: "event_after",
      eventId: "event_before",
      currentEventSegmentCount: 3,
      vlmEventSummary: "fresh VLM event summary",
      narrativeMemoryAttached: true,
    });

    expect(archive.input?.working_memory_context).toMatchObject({
      current_event_summary_chars: "prior event summary".length,
    });
    expect(archive.event_narrative).toMatchObject({
      event_summary_chars: "fresh VLM event summary".length,
    });
  });
});
