import { describe, expect, it } from "vitest";
import type { MonitorEvent } from "../types";
import { deriveMemoryPanelData } from "./useMemoryPanelData";

describe("deriveMemoryPanelData", () => {
  it("separates scene understanding from event schema and traces", () => {
    const events: MonitorEvent[] = [
      {
        type: "memory:memory_added",
        timestamp: 1_000,
        camera_id: "cam-a",
        data: {
          memory_id: "ctx-1",
          memory_type: "semantic_context",
          camera_id: "cam-a",
          summary: "Office scene with a front desk and meeting table.",
        },
      },
      {
        type: "memory:memory_added",
        timestamp: 2_000,
        camera_id: "cam-a",
        data: {
          memory_id: "schema-1",
          memory_type: "episodic_schema",
          camera_id: "cam-a",
          summary: "A visitor enters and speaks with the host.",
          metadata: {
            event_ids: ["evt-1"],
            title: "Visitor arrival",
            time_range_start_ms: 10_000,
            time_range_end_ms: 20_000,
          },
        },
      },
      {
        type: "memory:memory_added",
        timestamp: 3_000,
        camera_id: "cam-a",
        data: {
          memory_id: "trace-1",
          memory_type: "episodic_trace",
          camera_id: "cam-a",
          summary: "The visitor walks through the door.",
          metadata: {
            event_id: "evt-1",
            segment_id: "seg-1",
            media_start_ms: 10_000,
            media_duration_ms: 15_000,
          },
        },
      },
    ];

    const data = deriveMemoryPanelData(events);

    expect(data.sceneMemories).toHaveLength(1);
    expect(data.sceneMemories[0]?.summary).toContain("Office scene");
    expect(data.eventGroups).toHaveLength(1);
    expect(data.eventGroups[0]).toMatchObject({
      event_id: "evt-1",
      title: "Visitor arrival",
      start_ms: 10_000,
      end_ms: 25_000,
    });
    expect(data.eventGroups[0]?.schemas).toHaveLength(1);
    expect(data.eventGroups[0]?.traces).toHaveLength(1);
  });
});
