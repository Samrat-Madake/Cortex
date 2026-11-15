import { describe, expect, it } from "vitest";
import type { MonitorEvent } from "../types";
import { dashboardMemoryItemToMonitorEvent, semanticMemoryItemToMonitorEvent, upsertMonitorEvents } from "./useMonitorSocket";

function sourceState(sourceId: string, version: number, status: string): MonitorEvent {
  return {
    type: "dashboard:source_state",
    timestamp: version,
    camera_id: sourceId,
    data: {
      source_id: sourceId,
      status,
      version,
    },
  };
}

function sourceRemove(sourceId: string, version: number): MonitorEvent {
  return {
    type: "dashboard:source_state",
    timestamp: version,
    camera_id: sourceId,
    data: {
      source_id: sourceId,
      op: "remove",
      version,
    },
  };
}

function segmentState(segmentId: string, version: number, summary: string, cameraId = "cam-a"): MonitorEvent {
  return {
    type: "dashboard:segment_state",
    timestamp: version,
    camera_id: cameraId,
    data: {
      segment_id: segmentId,
      camera_id: cameraId,
      start_time: 1_000,
      end_time: 2_000,
      summary,
      version,
    },
  };
}

describe("upsertMonitorEvents", () => {
  it("keeps newer canonical source state over stale updates", () => {
    const events = new Map<string, MonitorEvent>();
    const removed = new Set<string>();

    expect(upsertMonitorEvents(events, removed, [sourceState("cam-a", 10, "active")])).not.toBeNull();
    const staleResult = upsertMonitorEvents(events, removed, [sourceState("cam-a", 9, "waiting")]);

    expect(staleResult).toBeNull();
    expect(events.get("dashboard:source_state:cam-a")?.data.status).toBe("active");
    expect(events.get("dashboard:source_state:cam-a")?.data.version).toBe(10);
  });

  it("ignores stale removes but accepts newer removes", () => {
    const events = new Map<string, MonitorEvent>();
    const removed = new Set<string>();

    upsertMonitorEvents(events, removed, [sourceState("cam-a", 10, "active")]);

    expect(upsertMonitorEvents(events, removed, [sourceRemove("cam-a", 9)])).toBeNull();
    expect(removed.has("cam-a")).toBe(false);
    expect(events.get("dashboard:source_state:cam-a")?.data.status).toBe("active");

    const removedResult = upsertMonitorEvents(events, removed, [sourceRemove("cam-a", 11)]);

    expect(removedResult).not.toBeNull();
    expect(removed.has("cam-a")).toBe(true);
    expect(events.get("dashboard:source_state:cam-a")?.data.op).toBe("remove");
    expect(events.get("dashboard:source_state:cam-a")?.data.version).toBe(11);
  });

  it("keeps a removed source tombstoned when stale upserts arrive later", () => {
    const events = new Map<string, MonitorEvent>();
    const removed = new Set<string>();

    upsertMonitorEvents(events, removed, [sourceState("cam-a", 10, "active")]);
    upsertMonitorEvents(events, removed, [sourceRemove("cam-a", 11)]);

    expect(upsertMonitorEvents(events, removed, [sourceState("cam-a", 10, "active")])).toBeNull();
    expect(upsertMonitorEvents(events, removed, [sourceState("cam-a", 11, "active")])).toBeNull();
    expect(removed.has("cam-a")).toBe(true);
    expect(upsertMonitorEvents(events, removed, [segmentState("seg-a", 12, "stale segment", "cam-a")])).toBeNull();
    expect(events.has("dashboard:segment_state:seg-a")).toBe(false);
  });

  it("keeps newer canonical segment state over stale updates", () => {
    const events = new Map<string, MonitorEvent>();
    const removed = new Set<string>();

    upsertMonitorEvents(events, removed, [segmentState("seg-a", 20, "new summary")]);
    const staleResult = upsertMonitorEvents(events, removed, [segmentState("seg-a", 19, "old summary")]);

    expect(staleResult).toBeNull();
    expect(events.get("dashboard:segment_state:seg-a")?.data.summary).toBe("new summary");
    expect(events.get("dashboard:segment_state:seg-a")?.data.version).toBe(20);

    upsertMonitorEvents(events, removed, [segmentState("seg-a", 21, "newer summary")]);
    expect(events.get("dashboard:segment_state:seg-a")?.data.summary).toBe("newer summary");
  });

  it("replaces provisional segment state with newer final state", () => {
    const events = new Map<string, MonitorEvent>();
    const removed = new Set<string>();
    const partial = segmentState("seg-a", 20, "early summary");
    partial.data.analysis_status = "partial";
    partial.data.is_partial = true;
    const final = segmentState("seg-a", 21, "final summary");
    final.data.analysis_status = "final";
    final.data.is_partial = false;

    upsertMonitorEvents(events, removed, [partial]);
    upsertMonitorEvents(events, removed, [final]);

    expect(events.get("dashboard:segment_state:seg-a")?.data.summary).toBe("final summary");
    expect(events.get("dashboard:segment_state:seg-a")?.data.analysis_status).toBe("final");
    expect(events.get("dashboard:segment_state:seg-a")?.data.is_partial).toBe(false);
  });

  it("keeps canonical source state when many newer segment events fill the activity window", () => {
    const events = new Map<string, MonitorEvent>();
    const removed = new Set<string>();
    upsertMonitorEvents(events, removed, [sourceState("cam-a", 1, "active")]);

    const incoming = Array.from({ length: 600 }, (_, i) => segmentState(`seg-${i}`, 1_000 + i, `summary ${i}`));
    const rendered = upsertMonitorEvents(events, removed, incoming);

    expect(rendered).not.toBeNull();
    expect(rendered?.some((event) => event.type === "dashboard:source_state" && event.camera_id === "cam-a")).toBe(true);
    expect(rendered?.filter((event) => event.type === "dashboard:segment_state")).toHaveLength(500);
  });
});

describe("semanticMemoryItemToMonitorEvent", () => {
  it("preserves raw ReID entity_id instead of display refs", () => {
    const event = semanticMemoryItemToMonitorEvent({
      id: "mem-1",
      entity_id: "entity-raw-1",
      camera_id: "cam-a",
      memory: "Lily often appears near the door.",
      updated_at: "2026-06-04T10:00:00.000Z",
    }, "fallback-cam");

    expect(event).toMatchObject({
      type: "memory:memory_added",
      camera_id: "cam-a",
      data: {
        memory_id: "mem-1",
        memory_type: "semantic",
        entity_id: "entity-raw-1",
        summary: "Lily often appears near the door.",
      },
    });
    expect(event?.data.entity_id).not.toBe("person:1");
  });
});

describe("dashboardMemoryItemToMonitorEvent", () => {
  it("preserves memory metadata for the Memory panel", () => {
    const event = dashboardMemoryItemToMonitorEvent({
      id: "trace-1",
      camera_id: "cam-a",
      memory: "A person picks up a black cup.",
      created_at: "2026-06-04T10:00:00.000Z",
      metadata: {
        event_id: "evt-1",
        segment_id: "seg-1",
        media_start_ms: 42_000,
        media_duration_ms: 10_000,
        source_time_label: "00:00:42-00:00:52",
      },
    }, "episodic_trace", "fallback-cam");

    expect(event).toMatchObject({
      type: "memory:memory_added",
      camera_id: "cam-a",
      data: {
        memory_id: "trace-1",
        memory_type: "episodic_trace",
        event_id: "evt-1",
        segment_id: "seg-1",
        source_time_label: "00:00:42-00:00:52",
        summary: "A person picks up a black cup.",
      },
    });
  });
});
