import { useMemo } from "react";
import type {
  DashboardMemoryEventGroup,
  DashboardMemoryKind,
  DashboardMemoryRecord,
  MonitorEvent,
} from "../types";

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function readMetadata(event: MonitorEvent): Record<string, unknown> {
  const metadata = event.data.metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
}

function memoryKind(value: unknown): DashboardMemoryKind | null {
  if (
    value === "semantic_context" ||
    value === "episodic_schema" ||
    value === "episodic_trace" ||
    value === "episodic"
  ) {
    return value;
  }
  return null;
}

function sourceTimeLabel(metadata: Record<string, unknown>, data: Record<string, unknown>): string | undefined {
  return readString(data.source_time_label)
    ?? readString(metadata.source_time_label)
    ?? readString(metadata.time_label);
}

function parseMemoryRecord(event: MonitorEvent): DashboardMemoryRecord | null {
  if (event.type !== "memory:memory_added" && event.type !== "memory:memory_updated") return null;
  const kind = memoryKind(event.data.memory_type);
  if (!kind) return null;
  const memoryId = readString(event.data.memory_id) ?? readString(event.data.id);
  if (!memoryId) return null;

  const metadata = readMetadata(event);
  const cameraId = readString(event.data.camera_id)
    ?? readString(metadata.camera_id)
    ?? event.camera_id
    ?? "global";
  const summary = readString(event.data.summary)
    ?? readString(event.data.summary_preview)
    ?? readString(event.data.memory)
    ?? "";
  const startMs = readNumber(event.data.segment_start)
    ?? readNumber(event.data.start_ms)
    ?? readNumber(metadata.media_start_ms)
    ?? readNumber(metadata.start_ms)
    ?? readNumber(metadata.time_range_start_ms)
    ?? readNumber((metadata.time_range as Record<string, unknown> | undefined)?.start_ms);
  const durationMs = readNumber(metadata.media_duration_ms)
    ?? (readNumber(event.data.duration_sec) !== undefined ? readNumber(event.data.duration_sec)! * 1000 : undefined);
  const endMs = readNumber(event.data.end_ms)
    ?? readNumber(metadata.end_ms)
    ?? readNumber(metadata.time_range_end_ms)
    ?? readNumber((metadata.time_range as Record<string, unknown> | undefined)?.end_ms)
    ?? (startMs !== undefined && durationMs !== undefined ? startMs + durationMs : undefined);

  return {
    memory_id: memoryId,
    memory_type: kind,
    camera_id: cameraId,
    metadata,
    event_id: readString(event.data.event_id) ?? readString(metadata.event_id),
    event_ids: readStringArray(event.data.event_ids).length > 0
      ? readStringArray(event.data.event_ids)
      : readStringArray(metadata.event_ids),
    segment_id: readString(event.data.segment_id) ?? readString(metadata.segment_id),
    summary,
    timestamp: event.timestamp,
    start_ms: startMs,
    end_ms: endMs,
    source_time_label: sourceTimeLabel(metadata, event.data),
    title: readString(event.data.title) ?? readString(metadata.title),
  };
}

function groupKey(record: DashboardMemoryRecord): string {
  return record.event_id
    ?? record.event_ids?.[0]
    ?? record.segment_id
    ?? `${record.camera_id}:${record.start_ms ?? record.timestamp}`;
}

function groupTitle(group: DashboardMemoryEventGroup): string {
  const schemaTitle = group.schemas.find((item) => item.title)?.title;
  if (schemaTitle) return schemaTitle;
  return "Event Memory";
}

export function deriveMemoryPanelData(events: MonitorEvent[]): {
  sceneMemories: DashboardMemoryRecord[];
  eventGroups: DashboardMemoryEventGroup[];
} {
  const sceneMemories: DashboardMemoryRecord[] = [];
  const eventRecords: DashboardMemoryRecord[] = [];

  for (const event of events) {
    const record = parseMemoryRecord(event);
    if (!record) continue;
    if (record.memory_type === "semantic_context") {
      sceneMemories.push(record);
    } else if (record.memory_type === "episodic_schema" || record.memory_type === "episodic_trace" || record.memory_type === "episodic") {
      eventRecords.push(record);
    }
  }

  sceneMemories.sort((a, b) => b.timestamp - a.timestamp);

  const schemaRecords = eventRecords.filter((record) => record.memory_type === "episodic_schema");
  const traceRecords = eventRecords.filter((record) => record.memory_type !== "episodic_schema");
  const groups = new Map<string, DashboardMemoryEventGroup>();
  const schemaGroupByEventId = new Map<string, string>();

  for (const record of schemaRecords) {
    const key = groupKey(record);
    const group = groups.get(key) ?? {
      event_id: key,
      camera_id: record.camera_id,
      title: "Event Memory",
      start_ms: record.start_ms,
      end_ms: record.end_ms,
      schemas: [],
      traces: [],
    };
    group.start_ms = group.start_ms !== undefined && record.start_ms !== undefined ? Math.min(group.start_ms, record.start_ms) : group.start_ms ?? record.start_ms;
    group.end_ms = group.end_ms !== undefined && record.end_ms !== undefined ? Math.max(group.end_ms, record.end_ms) : group.end_ms ?? record.end_ms;
    group.schemas.push(record);
    group.title = groupTitle(group);
    groups.set(key, group);
    for (const eventId of record.event_ids ?? []) {
      if (!schemaGroupByEventId.has(eventId)) schemaGroupByEventId.set(eventId, key);
    }
  }

  for (const record of traceRecords) {
    const key = record.event_id ? schemaGroupByEventId.get(record.event_id) ?? groupKey(record) : groupKey(record);
    const group = groups.get(key) ?? {
      event_id: key,
      camera_id: record.camera_id,
      title: "Event Memory",
      start_ms: record.start_ms,
      end_ms: record.end_ms,
      schemas: [],
      traces: [],
    };
    group.start_ms = group.start_ms !== undefined && record.start_ms !== undefined ? Math.min(group.start_ms, record.start_ms) : group.start_ms ?? record.start_ms;
    group.end_ms = group.end_ms !== undefined && record.end_ms !== undefined ? Math.max(group.end_ms, record.end_ms) : group.end_ms ?? record.end_ms;
    group.traces.push(record);
    group.title = groupTitle(group);
    groups.set(key, group);
  }

  const eventGroups = [...groups.values()].map((group) => {
    group.schemas.sort((a, b) => b.timestamp - a.timestamp);
    group.traces.sort((a, b) => (a.start_ms ?? a.timestamp) - (b.start_ms ?? b.timestamp));
    group.title = groupTitle(group);
    return group;
  }).sort((a, b) => (b.start_ms ?? b.schemas[0]?.timestamp ?? b.traces[0]?.timestamp ?? 0) - (a.start_ms ?? a.schemas[0]?.timestamp ?? a.traces[0]?.timestamp ?? 0));

  return { sceneMemories, eventGroups };
}

export function useMemoryPanelData(events: MonitorEvent[]) {
  return useMemo(() => deriveMemoryPanelData(events), [events]);
}
