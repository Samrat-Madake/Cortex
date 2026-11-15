import { describe, expect, it } from "vitest";
import type { MonitorEvent } from "../types";
import { deriveSemanticMemories } from "./useSemanticMemories";

describe("deriveSemanticMemories", () => {
  it("groups semantic memories by stable entity_id", () => {
    const events: MonitorEvent[] = [
      {
        type: "dashboard:segment_state",
        timestamp: 1_000,
        camera_id: "cam-a",
        data: {
          segment_id: "seg-1",
          targets: [{
            type: "person",
            entity_id: "entity-1",
            ref: "person:7",
            subject_index: 7,
          }],
        },
      },
      {
        type: "memory:memory_added",
        timestamp: 2_000,
        camera_id: "cam-a",
        data: {
          memory_type: "semantic",
          memory_id: "mem-1",
          entity_id: "entity-1",
          summary: "Lily often appears near the door.",
          importance: 0.8,
        },
      },
    ];

    const memories = deriveSemanticMemories(events);

    expect(memories.get("entity-1")).toEqual([{
      memory_id: "mem-1",
      entity_id: "entity-1",
      summary: "Lily often appears near the door.",
      importance: 0.8,
      timestamp: 2_000,
      update_count: 1,
    }]);
    expect(memories.get("person:7")).toBeUndefined();
  });
});
