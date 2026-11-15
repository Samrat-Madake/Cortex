import { useState, useEffect, useRef, useCallback } from "react";
import type { ActiveSourceStatus, DashboardStateEnvelope } from "@cortex/shared";
import type { MonitorEvent } from "../types";
import type { DashboardSession } from "../session";
import { dashboardAuthHeaders, withDashboardQuery } from "../session";

const MAX_MONITOR_EVENTS = 500;

function eventKey(e: MonitorEvent): string {
  const memoryId = typeof e.data.memory_id === "string" ? e.data.memory_id : "";
  if (memoryId) return `${e.type}:memory:${memoryId}`;
  const segId = typeof e.data.segment_id === "string" ? e.data.segment_id : "";
  if (segId) return `${e.type}:${segId}`;
  const eventId = typeof e.data.event_id === "string" ? e.data.event_id : "";
  if (eventId) return `${e.type}:event:${eventId}`;
  if (e.type === "system:service_health" || e.type === "system:active_models" || e.type === "system:queue_overflow") {
    return e.type;
  }
  if (e.type === "system:pipeline_metrics") {
    return `${e.type}:${typeof e.data.metric_type === "string" ? e.data.metric_type : "default"}`;
  }
  if (e.type === "system:component_status") {
    const statusKey = typeof e.data.status_key === "string" ? e.data.status_key : "unknown";
    return `${e.type}:${statusKey}`;
  }
  if (e.type === "system:operation_error") {
    const errorId = typeof e.data.error_id === "string" ? e.data.error_id : `${e.camera_id ?? "global"}:${e.timestamp}`;
    return `${e.type}:${errorId}`;
  }
  if (e.type === "system:pipeline_trace") {
    const traceSegmentId = typeof e.data.segment_id === "string" ? e.data.segment_id : "";
    if (traceSegmentId) return `${e.type}:${traceSegmentId}`;
  }
  if (e.type.startsWith("cam:source_") || e.type.startsWith("cam:watch_")) {
    const sourceId = typeof e.data.source_id === "string" ? e.data.source_id : e.camera_id;
    if (sourceId) return `${e.type}:${sourceId}`;
  }
  if (e.type === "dashboard:source_state") {
    const sourceId = typeof e.data.source_id === "string" ? e.data.source_id : e.camera_id;
    if (sourceId) return `${e.type}:${sourceId}`;
  }
  if (e.type === "dashboard:segment_state") {
    const segmentId = typeof e.data.segment_id === "string" ? e.data.segment_id : "";
    if (segmentId) return `${e.type}:${segmentId}`;
  }
  return `${e.type}:${e.camera_id ?? "global"}:${e.timestamp}`;
}

function eventSourceId(e: MonitorEvent): string {
  if (typeof e.camera_id === "string" && e.camera_id) return e.camera_id;
  const sourceId = e.data.source_id;
  if (typeof sourceId === "string" && sourceId) return sourceId;
  const id = e.data.id;
  return typeof id === "string" ? id : "";
}

function isPinnedMonitorEvent(e: MonitorEvent): boolean {
  // Source state is durable UI state, not activity history. It can be older
  // than recent segment events but must stay visible until a canonical remove.
  return e.type === "dashboard:source_state" || e.type === "system:component_status";
}

function monitorEventsForRender(eventMap: Map<string, MonitorEvent>): MonitorEvent[] {
  const sorted = Array.from(eventMap.values()).sort((a, b) => b.timestamp - a.timestamp);
  if (sorted.length <= MAX_MONITOR_EVENTS) return sorted;

  const pinned = sorted.filter(isPinnedMonitorEvent);
  const recent = sorted
    .filter((event) => !isPinnedMonitorEvent(event))
    .slice(0, MAX_MONITOR_EVENTS);
  return [...pinned, ...recent].sort((a, b) => b.timestamp - a.timestamp);
}

export function upsertMonitorEvents(
  eventMap: Map<string, MonitorEvent>,
  removedSourceIds: Set<string>,
  incoming: MonitorEvent[],
): MonitorEvent[] | null {
  if (incoming.length === 0) return null;
  let changed = false;
  for (const event of incoming) {
    const sourceId = eventSourceId(event);
    if (event.type === "dashboard:source_state" && sourceId && event.data.op === "remove") {
      const existing = eventMap.get(eventKey(event));
      const incomingVersion = typeof event.data.version === "number" ? event.data.version : undefined;
      const existingVersion = typeof existing?.data.version === "number" ? existing.data.version : undefined;
      if (incomingVersion !== undefined && existingVersion !== undefined && incomingVersion < existingVersion) {
        continue;
      }
      removedSourceIds.add(sourceId);
      for (const [key, existing] of eventMap) {
        if (eventSourceId(existing) === sourceId) {
          eventMap.delete(key);
          changed = true;
        }
      }
      const key = eventKey(event);
      eventMap.set(key, event);
      changed = true;
      continue;
    }

    if (event.type !== "dashboard:source_state" && sourceId && removedSourceIds.has(sourceId)) {
      continue;
    }

    const key = eventKey(event);
    const existing = eventMap.get(key);
    const incomingSynthetic = event.data._synthetic === true;
    const existingSynthetic = existing?.data._synthetic === true;
    const incomingVersion = typeof event.data.version === "number" ? event.data.version : undefined;
    const existingVersion = typeof existing?.data.version === "number" ? existing.data.version : undefined;
    const canonicalVersionedState = event.type === "dashboard:source_state" || event.type === "dashboard:segment_state";
    const existingSourceRemove = existing?.type === "dashboard:source_state" && existing.data.op === "remove";
    const shouldAccept =
      !existing ||
      (
        canonicalVersionedState &&
        incomingVersion !== undefined &&
        (
          existingVersion === undefined ||
          incomingVersion > existingVersion ||
          (!existingSourceRemove && incomingVersion >= existingVersion)
        )
      ) ||
      (existingSynthetic && !incomingSynthetic) ||
      (
        !canonicalVersionedState &&
        existingSynthetic === incomingSynthetic &&
        event.timestamp >= existing.timestamp
      );
    if (shouldAccept) {
      if (event.type === "dashboard:source_state" && sourceId) {
        removedSourceIds.delete(sourceId);
      }
      eventMap.set(key, event);
      changed = true;
    }
  }
  if (!changed) return null;
  return monitorEventsForRender(eventMap);
}

/** Load existing procedural memories from Cortex via Monitor /api proxy. */
async function loadProceduralMemories(session: DashboardSession): Promise<MonitorEvent[]> {
  try {
    // Query with camera_id=global to satisfy Cortex's identifier requirement.
    // Global rules cover all cameras; camera-specific rules will also be returned
    // via real-time WebSocket events when they're created.
    const resp = await fetch(
      withDashboardQuery(`/api/cortex/memories?memory_type=procedural&camera_id=global&user_id=${encodeURIComponent(session.userId)}&limit=50`, session),
      { headers: dashboardAuthHeaders(session) },
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    // Cortex returns { collection_name: [...items] }
    const items: Array<{ id: string; memory: string; camera_id?: string; created_at?: string }> = [];
    for (const [, v] of Object.entries(data)) {
      if (Array.isArray(v)) items.push(...v);
    }
    return items.map((item) => ({
      type: "memory:memory_added" as const,
      timestamp: item.created_at ? new Date(item.created_at).getTime() : Date.now(),
      camera_id: item.camera_id ?? "global",
      data: {
        memory_id: item.id,
        memory_type: "procedural",
        event: "ADD",
        summary_preview: item.memory,
        camera_id: item.camera_id ?? "global",
        user_id: session.userId,
      },
    }));
  } catch {
    return [];
  }
}

export interface ActiveAnalysis {
  camera_id: string;
  video_id: string;
  started_at: number;
  completed_at?: number;
  segments_count: number;
  status: "starting" | "active" | "completed";
}

interface AnalysisStatusResponse {
  active?: ActiveAnalysis[];
  recent?: ActiveAnalysis[];
}

type DashboardSource = ActiveSourceStatus;

interface DashboardStateResponse {
  cursor?: number;
  sources?: DashboardSource[];
  segments?: Record<string, unknown>[];
  component_statuses?: Record<string, unknown>[];
  recent_operation_errors?: Record<string, unknown>[];
}

function runtimeHealthEvent(type: "system:component_status" | "system:operation_error", item: Record<string, unknown>): MonitorEvent | null {
  const timestamp = typeof item.observed_at === "number" ? item.observed_at : Date.now();
  if (type === "system:component_status" && typeof item.status_key !== "string") return null;
  if (type === "system:operation_error" && typeof item.error_id !== "string") return null;
  const scope = typeof item.scope === "object" && item.scope !== null && !Array.isArray(item.scope)
    ? item.scope as Record<string, unknown>
    : {};
  const sourceId = typeof item.source_id === "string"
    ? item.source_id
    : typeof scope.source_id === "string" ? scope.source_id : undefined;
  return {
    type,
    timestamp,
    camera_id: sourceId,
    data: {
      ...item,
      ...(typeof scope.user_id === "string" ? { user_id: scope.user_id } : {}),
      ...(typeof scope.session_id === "string" ? { session_id: scope.session_id } : {}),
      ...(sourceId ? { source_id: sourceId } : {}),
    },
  };
}

function sourceStateEventFromSource(item: DashboardSource, version: number): MonitorEvent {
  const now = item.updated_at ?? item.created_at ?? Date.now();
  const sourceName = item.label ?? item.source_name ?? item.video_id ?? item.source_id;
  const input = item.input ?? sourceName;
  const protocol = item.protocol ?? "live";
  return {
    type: "dashboard:source_state" as const,
    timestamp: now,
    camera_id: item.source_id,
    data: {
      source_id: item.source_id,
      version,
      source_name: sourceName,
      label: item.label ?? sourceName,
      input,
      protocol,
      kind: item.kind,
      video_id: item.video_id,
      preview_url: item.preview_url,
      mode: item.mode ?? "stream",
      fps: item.fps,
      width: item.width,
      height: item.height,
      status: item.status,
      display_status: item.display_status,
      input_kind: item.input_kind,
      watch_status: item.watch_status,
      media_status: item.media_status,
      analysis_status: item.analysis_status,
      segments_count: item.segments_count,
      last_error: item.last_error,
      can_start: item.can_start,
      can_stop: item.can_stop,
      can_delete: item.can_delete,
      summary: item.summary,
      created_at: item.created_at,
      updated_at: item.updated_at,
    },
  };
}

function sourceStateEventFromEnvelope(envelope: DashboardStateEnvelope): MonitorEvent | null {
  if (envelope.id === "__connected__") return null;
  const timestamp = typeof envelope.timestamp === "number" ? envelope.timestamp : Date.now();
  if (envelope.domain === "memory" || envelope.domain === "service" || envelope.domain === "trace") {
    const data = envelope.data ?? {};
    const eventType = typeof data.event_type === "string" ? data.event_type : "";
    if (!eventType) return null;
    return {
      type: eventType as MonitorEvent["type"],
      timestamp,
      camera_id: typeof data.camera_id === "string" ? data.camera_id : undefined,
      data: {
        ...data,
        version: envelope.version,
      },
    };
  }
  if (envelope.domain === "segment" && typeof envelope.id === "string" && envelope.id) {
    const data = envelope.data ?? {};
    const cameraId = typeof data.camera_id === "string" ? data.camera_id : undefined;
    return {
      type: "dashboard:segment_state" as const,
      timestamp,
      camera_id: cameraId,
      data: {
        ...data,
        segment_id: typeof data.segment_id === "string" ? data.segment_id : envelope.id,
        version: envelope.version,
      },
    };
  }
  if (envelope.domain !== "source" || typeof envelope.id !== "string" || !envelope.id) return null;
  if (envelope.op === "remove") {
    return {
      type: "dashboard:source_state" as const,
      timestamp,
      camera_id: envelope.id,
      data: {
        source_id: envelope.id,
        op: "remove",
        version: envelope.version,
      },
    };
  }
  const data = envelope.data ?? {};
  return {
    type: "dashboard:source_state" as const,
    timestamp,
    camera_id: envelope.id,
    data: {
      ...data,
      source_id: typeof data.source_id === "string" ? data.source_id : envelope.id,
      version: envelope.version,
    },
  };
}

function segmentStateEventFromSource(item: Record<string, unknown>, version: number): MonitorEvent | null {
  const segmentId = typeof item.segment_id === "string" ? item.segment_id : "";
  if (!segmentId) return null;
  const timestamp = typeof item.start_time === "number" ? item.start_time : Date.now();
  return {
    type: "dashboard:segment_state" as const,
    timestamp,
    camera_id: typeof item.camera_id === "string" ? item.camera_id : undefined,
    data: {
      ...item,
      version,
    },
  };
}

async function loadDashboardState(session: DashboardSession): Promise<{ events: MonitorEvent[]; cursor: number; sourceIds: Set<string>; loaded: boolean; hasSegments: boolean }> {
  try {
    const resp = await fetch(withDashboardQuery("/api/dashboard/state", session), { headers: dashboardAuthHeaders(session) });
    if (!resp.ok) return { events: [], cursor: 0, sourceIds: new Set(), loaded: false, hasSegments: false };
    const data = await resp.json() as DashboardStateResponse;
    const sources = data.sources ?? [];
    const version = typeof data.cursor === "number" ? data.cursor : 0;
    const segmentEvents = (data.segments ?? [])
      .map((item) => segmentStateEventFromSource(item, version))
      .filter((event): event is MonitorEvent => Boolean(event));
    const healthEvents = [
      ...(data.component_statuses ?? []).map((item) => runtimeHealthEvent("system:component_status", item)),
      ...(data.recent_operation_errors ?? []).map((item) => runtimeHealthEvent("system:operation_error", item)),
    ].filter((event): event is MonitorEvent => Boolean(event));
    return {
      cursor: version,
      sourceIds: new Set(sources.map((item) => item.source_id)),
      loaded: true,
      hasSegments: Array.isArray(data.segments),
      events: [
        ...sources.map((item) => sourceStateEventFromSource(item, version)),
        ...segmentEvents,
        ...healthEvents,
      ],
    };
  } catch {
    return { events: [], cursor: 0, sourceIds: new Set(), loaded: false, hasSegments: false };
  }
}

async function loadAnalysisStatus(session: DashboardSession): Promise<{ events: MonitorEvent[]; analyses: ActiveAnalysis[] }> {
  try {
    const resp = await fetch(withDashboardQuery("/api/analysis/status", session), { headers: dashboardAuthHeaders(session) });
    if (!resp.ok) return { events: [], analyses: [] };
    const data = await resp.json() as AnalysisStatusResponse;
    const byCamera = new Map<string, ActiveAnalysis>();
    for (const item of [...(data.recent ?? []), ...(data.active ?? [])]) {
      byCamera.set(item.camera_id, item);
    }
    const analyses = Array.from(byCamera.values());
    return { events: [], analyses };
  } catch {
    return { events: [], analyses: [] };
  }
}

async function loadRecentSegments(cameraIds: string[], session: DashboardSession): Promise<MonitorEvent[]> {
  if (cameraIds.length === 0) return [];
  try {
    const batches = await Promise.all(cameraIds.map(async (cameraId) => {
      const resp = await fetch(
        withDashboardQuery(`/api/segments/recent?limit=300&camera_id=${encodeURIComponent(cameraId)}`, session),
        { headers: dashboardAuthHeaders(session) },
      );
      if (!resp.ok) return [];
      const data = await resp.json() as { events?: MonitorEvent[] };
      return Array.isArray(data.events) ? data.events : [];
    }));
    return batches.flat();
  } catch {
    return [];
  }
}

export interface CortexMemoryItem {
  id?: string;
  memory?: string;
  created_at?: string;
  updated_at?: string;
  memory_type?: string;
  entity_id?: string;
  camera_id?: string;
  importance?: number;
  category?: string;
  entity_class?: string;
  metadata?: Record<string, unknown> | null;
}

export function semanticMemoryItemToMonitorEvent(
  item: CortexMemoryItem,
  fallbackCameraId: string,
  fallbackTimestamp = Date.now(),
): MonitorEvent | null {
  if (typeof item.id !== "string" || typeof item.entity_id !== "string") return null;
  const timestamp = item.updated_at
    ? new Date(item.updated_at).getTime()
    : item.created_at
      ? new Date(item.created_at).getTime()
      : fallbackTimestamp;
  return {
    type: "memory:memory_added",
    timestamp: Number.isFinite(timestamp) ? timestamp : fallbackTimestamp,
    camera_id: item.camera_id ?? fallbackCameraId,
    data: {
      _synthetic: true,
      memory_id: item.id,
      memory_type: "semantic",
      event: "ADD",
      camera_id: item.camera_id ?? fallbackCameraId,
      entity_id: item.entity_id,
      importance: typeof item.importance === "number" ? item.importance : undefined,
      category: item.category,
      entity_class: item.entity_class,
      summary_preview: typeof item.memory === "string" ? item.memory.slice(0, 240) : "",
      summary: typeof item.memory === "string" ? item.memory : "",
    },
  };
}

type DashboardHydratedMemoryType = "semantic_context" | "episodic_schema" | "episodic_trace";

function memoryItemTimestamp(item: CortexMemoryItem, fallbackTimestamp = Date.now()): number {
  const timestamp = item.updated_at
    ? new Date(item.updated_at).getTime()
    : item.created_at
      ? new Date(item.created_at).getTime()
      : fallbackTimestamp;
  return Number.isFinite(timestamp) ? timestamp : fallbackTimestamp;
}

export function dashboardMemoryItemToMonitorEvent(
  item: CortexMemoryItem,
  memoryType: DashboardHydratedMemoryType,
  fallbackCameraId: string,
  fallbackTimestamp = Date.now(),
): MonitorEvent | null {
  if (typeof item.id !== "string") return null;
  const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
  const cameraId = item.camera_id ?? (typeof metadata.camera_id === "string" ? metadata.camera_id : fallbackCameraId);
  return {
    type: "memory:memory_added",
    timestamp: memoryItemTimestamp(item, fallbackTimestamp),
    camera_id: cameraId,
    data: {
      _synthetic: true,
      memory_id: item.id,
      memory_type: memoryType,
      event: "ADD",
      camera_id: cameraId,
      summary_preview: typeof item.memory === "string" ? item.memory.slice(0, 240) : "",
      summary: typeof item.memory === "string" ? item.memory : "",
      metadata,
      ...(typeof metadata.event_id === "string" ? { event_id: metadata.event_id } : {}),
      ...(Array.isArray(metadata.event_ids) ? { event_ids: metadata.event_ids.filter((id): id is string => typeof id === "string" && id.length > 0) } : {}),
      ...(typeof metadata.segment_id === "string" ? { segment_id: metadata.segment_id } : {}),
      ...(typeof metadata.source_time_label === "string" ? { source_time_label: metadata.source_time_label } : {}),
    },
  };
}

function collectStableEntityIds(events: MonitorEvent[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type !== "dashboard:segment_state" && event.type !== "perception:vlm_result") continue;
    const rawTargets = event.type === "dashboard:segment_state" ? event.data.targets : event.data.main_targets;
    if (Array.isArray(rawTargets)) {
      for (const raw of rawTargets) {
        if (!raw || typeof raw !== "object") continue;
        const entityId = (raw as Record<string, unknown>).entity_id;
        if (typeof entityId === "string" && entityId) ids.add(entityId);
      }
    }
    const rawEntityIds = event.data.entity_ids;
    if (Array.isArray(rawEntityIds)) {
      for (const entityId of rawEntityIds) {
        if (typeof entityId === "string" && entityId) ids.add(entityId);
      }
    }
  }
  return [...ids];
}

async function loadSemanticMemories(entityIds: string[], session: DashboardSession): Promise<MonitorEvent[]> {
  if (entityIds.length === 0) return [];
  const parseItems = (data: Record<string, unknown>): CortexMemoryItem[] => {
    if (Array.isArray(data)) {
      return data.filter((item): item is CortexMemoryItem => Boolean(item) && typeof item === "object");
    }
    const items: CortexMemoryItem[] = [];
    for (const [, value] of Object.entries(data)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (item && typeof item === "object") items.push(item as CortexMemoryItem);
      }
    }
    return items;
  };
  const fetchMemories = async (path: string): Promise<CortexMemoryItem[]> => {
    const resp = await fetch(path, { headers: dashboardAuthHeaders(session) });
    if (!resp.ok) return [];
    return parseItems(await resp.json() as Record<string, unknown>);
  };
  try {
    const batches = await Promise.all(entityIds.map(async (entityId) => {
      const scopedPath = withDashboardQuery(`/api/cortex/memories?memory_type=semantic&entity_id=${encodeURIComponent(entityId)}&limit=100`, session);
      const items = await fetchMemories(scopedPath);
      return items
        .map((item) => semanticMemoryItemToMonitorEvent(item, ""))
        .filter((event): event is MonitorEvent => event != null);
    }));
    return batches.flat();
  } catch {
    return [];
  }
}

async function loadDashboardMemories(cameraIds: string[], session: DashboardSession): Promise<MonitorEvent[]> {
  if (cameraIds.length === 0) return [];
  const parseItems = (data: Record<string, unknown> | CortexMemoryItem[]): CortexMemoryItem[] => {
    if (Array.isArray(data)) {
      return data.filter((item): item is CortexMemoryItem => Boolean(item) && typeof item === "object");
    }
    const items: CortexMemoryItem[] = [];
    for (const [, value] of Object.entries(data)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (item && typeof item === "object") items.push(item as CortexMemoryItem);
      }
    }
    return items;
  };
  const fetchTyped = async (cameraId: string, memoryType: DashboardHydratedMemoryType, limit: number): Promise<MonitorEvent[]> => {
    const sortOrder = memoryType === "episodic_schema" ? "asc" : "desc";
    const resp = await fetch(
      withDashboardQuery(
        `/api/cortex/memories?memory_type=${encodeURIComponent(memoryType)}&camera_id=${encodeURIComponent(cameraId)}&limit=${limit}&sort_order=${sortOrder}`,
        session,
      ),
      { headers: dashboardAuthHeaders(session) },
    );
    if (!resp.ok) return [];
    const items = parseItems(await resp.json() as Record<string, unknown>);
    return items
      .map((item) => dashboardMemoryItemToMonitorEvent(item, memoryType, cameraId))
      .filter((event): event is MonitorEvent => event != null);
  };
  try {
    const batches = await Promise.all(cameraIds.flatMap((cameraId) => [
      fetchTyped(cameraId, "semantic_context", 5),
      fetchTyped(cameraId, "episodic_schema", 50),
      fetchTyped(cameraId, "episodic_trace", 120),
    ]));
    return batches.flat();
  } catch {
    return [];
  }
}

export function useMonitorSocket(session: DashboardSession, enabled = true) {
  const [events, setEvents] = useState<MonitorEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [analyses, setAnalyses] = useState<ActiveAnalysis[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const dashboardWsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dashboardReconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hydrationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const initialLoadDone = useRef(false);
  const eventMapRef = useRef(new Map<string, MonitorEvent>());
  const removedSourceIdsRef = useRef(new Set<string>());
  const dashboardCursorRef = useRef(0);

  const upsertEvents = useCallback((incoming: MonitorEvent[]) => {
    const sorted = upsertMonitorEvents(eventMapRef.current, removedSourceIdsRef.current, incoming);
    if (sorted) setEvents(sorted);
  }, []);

  const hydrateAnalysisHistory = useCallback(async () => {
    const { events: statusEvents, analyses } = await loadAnalysisStatus(session);
    const { events: dashboardEvents, cursor, sourceIds, loaded: sourcesLoaded, hasSegments } = await loadDashboardState(session);
    dashboardCursorRef.current = Math.max(dashboardCursorRef.current, cursor);
    setAnalyses(analyses);
    const missingSourceEvents: MonitorEvent[] = [];
    if (sourcesLoaded) {
      const now = Date.now();
      const missingSourceIds = new Set<string>();
      for (const existing of eventMapRef.current.values()) {
        if (existing.type !== "dashboard:source_state" || existing.data.op === "remove") continue;
        const id = eventSourceId(existing);
        if (!id || sourceIds.has(id) || missingSourceIds.has(id)) continue;
        missingSourceIds.add(id);
        missingSourceEvents.push({
          type: "dashboard:source_state",
          timestamp: now,
          camera_id: id,
          data: {
            source_id: id,
            op: "remove",
            version: cursor,
          },
        });
      }
    }
    const cameraIds = Array.from(new Set([
      ...analyses.map((item) => item.camera_id),
      ...dashboardEvents
        .map((event) => event.camera_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ]));
    const segmentEvents = hasSegments ? [] : await loadRecentSegments(cameraIds, session);
    const entityIds = collectStableEntityIds([...dashboardEvents, ...segmentEvents]);
    const semanticEvents = await loadSemanticMemories(entityIds, session);
    const memoryEvents = await loadDashboardMemories(cameraIds, session);
    upsertEvents([...statusEvents, ...missingSourceEvents, ...dashboardEvents, ...segmentEvents, ...semanticEvents, ...memoryEvents]);
  }, [session, upsertEvents]);

  const applyAnalysisEvent = useCallback((event: MonitorEvent) => {
    const cameraId = (typeof event.camera_id === "string" && event.camera_id)
      ? event.camera_id
      : typeof event.data.source_id === "string"
        ? event.data.source_id
        : "";
    if (!cameraId.startsWith("video-")) return;

    setAnalyses((prev) => {
      const next = new Map(prev.map((item) => [item.camera_id, item]));
      const existing = next.get(cameraId);

      if (event.type === "cam:source_added") {
        const videoId = typeof event.data.video_id === "string"
          ? event.data.video_id
          : typeof event.data.source_name === "string"
            ? event.data.source_name
            : existing?.video_id ?? cameraId;
        next.set(cameraId, {
          camera_id: cameraId,
          video_id: videoId,
          started_at: existing?.started_at ?? event.timestamp,
          completed_at: existing?.completed_at,
          segments_count: existing?.segments_count ?? 0,
          status: existing?.status ?? "starting",
        });
      } else if (event.type === "cam:watch_started") {
        const videoId = typeof event.data.video_id === "string"
          ? event.data.video_id
          : typeof event.data.source_name === "string"
            ? event.data.source_name
            : existing?.video_id ?? cameraId;
        next.set(cameraId, {
          camera_id: cameraId,
          video_id: videoId,
          started_at: existing?.started_at ?? event.timestamp,
          completed_at: undefined,
          segments_count: typeof event.data.segments_count === "number"
            ? event.data.segments_count
            : existing?.segments_count ?? 0,
          status: event.data.status === "completed" ? "completed" : event.data.status === "starting" ? "starting" : "active",
        });
      } else if (event.type === "cam:segment_built" && existing) {
        next.set(cameraId, {
          ...existing,
          status: existing.status === "completed" ? "completed" : "active",
          segments_count: existing.segments_count + 1,
        });
      } else if (event.type === "cam:watch_stopped" && existing) {
        next.set(cameraId, {
          ...existing,
          completed_at: event.timestamp,
          status: "completed",
        });
      } else {
        return prev;
      }

      return Array.from(next.values()).sort((a, b) => (b.completed_at ?? b.started_at) - (a.completed_at ?? a.started_at));
    });
  }, []);

  const connectDashboard = useCallback(() => {
    if (!enabled) return;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    if (dashboardWsRef.current) {
      dashboardWsRef.current.onclose = null;
      dashboardWsRef.current.close();
    }
    const ws = new WebSocket(
      `${protocol}//${window.location.host}/ws/dashboard?session_id=${encodeURIComponent(session.sessionId)}&user_id=${encodeURIComponent(session.userId)}&cursor=${dashboardCursorRef.current}`,
    );

    ws.onmessage = (msg) => {
      const envelope = JSON.parse(msg.data) as DashboardStateEnvelope;
      if (typeof envelope.version === "number") {
        dashboardCursorRef.current = Math.max(dashboardCursorRef.current, envelope.version);
      }
      const event = sourceStateEventFromEnvelope(envelope);
      if (event) upsertEvents([event]);
    };
    ws.onclose = () => {
      dashboardReconnectRef.current = setTimeout(connectDashboard, 3000);
    };
    dashboardWsRef.current = ws;
  }, [enabled, session, upsertEvents]);

  const connect = useCallback(() => {
    if (!enabled) return;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${protocol}//${window.location.host}/ws/monitor?session_id=${encodeURIComponent(session.sessionId)}&user_id=${encodeURIComponent(session.userId)}`,
    );

    ws.onopen = () => {
      setConnected(true);
      void hydrateAnalysisHistory();
      if (hydrationIntervalRef.current) clearInterval(hydrationIntervalRef.current);
      hydrationIntervalRef.current = setInterval(() => {
        void hydrateAnalysisHistory();
      }, 3000);
      connectDashboard();
      // Load existing procedural memories on first connect.
      if (!initialLoadDone.current) {
        initialLoadDone.current = true;
        loadProceduralMemories(session).then((mems) => {
          upsertEvents(mems);
        });
      }
    };
    ws.onclose = () => {
      setConnected(false);
      if (hydrationIntervalRef.current) {
        clearInterval(hydrationIntervalRef.current);
        hydrationIntervalRef.current = null;
      }
      if (dashboardReconnectRef.current) {
        clearTimeout(dashboardReconnectRef.current);
        dashboardReconnectRef.current = null;
      }
      if (dashboardWsRef.current) {
        dashboardWsRef.current.onclose = null;
        dashboardWsRef.current.close();
      }
      dashboardWsRef.current = null;
      reconnectRef.current = setTimeout(connect, 3000);
    };
    ws.onmessage = (msg) => {
      const event: MonitorEvent = JSON.parse(msg.data);
      upsertEvents([event]);
      applyAnalysisEvent(event);
    };

    wsRef.current = ws;
  }, [applyAnalysisEvent, connectDashboard, enabled, hydrateAnalysisHistory, session, upsertEvents]);

  useEffect(() => {
    if (!enabled) return;
    connect();
    return () => {
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      if (dashboardReconnectRef.current) clearTimeout(dashboardReconnectRef.current);
      if (hydrationIntervalRef.current) clearInterval(hydrationIntervalRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
      if (dashboardWsRef.current) {
        dashboardWsRef.current.onclose = null;
        dashboardWsRef.current.close();
      }
    };
  }, [connect]);

  return { events, connected, analyses };
}
