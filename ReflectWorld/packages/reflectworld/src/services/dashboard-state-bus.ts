import { WebSocket, type WebSocketServer } from "ws";
import { writeStderr } from "@reflectworld/shared";
import type {
  ActiveSourceStatus,
  DashboardStateDomain,
  DashboardStateEnvelope,
  DashboardStateOperation,
  MonitorEvent,
} from "@reflectworld/shared";
import type { DashboardSessionScope } from "./dashboard-common.js";
import type { DashboardSegmentProjector } from "./dashboard-segments.js";
import type { DashboardSessionManager } from "./dashboard-sessions.js";
import type { DashboardSourceStatusService } from "./dashboard-source-status.js";

export interface DashboardStateBusOptions {
  sessions: DashboardSessionManager;
  segments: DashboardSegmentProjector;
  sourceStatuses: DashboardSourceStatusService;
  getDashboardWss: () => WebSocketServer | null;
  getGo2rtcStreams: () => Promise<Record<string, unknown> | null>;
}

export class DashboardStateBus {
  private currentVersion = 0;
  private readonly eventLog = new Map<DashboardStateDomain, DashboardStateEnvelope[]>();
  private readonly sourceRemovedAt = new Map<string, number>();

  constructor(private readonly options: DashboardStateBusOptions) {}

  get version(): number {
    return this.currentVersion;
  }

  nextVersion(): number {
    this.currentVersion += 1;
    return this.currentVersion;
  }

  replayEnvelopes(cursor: number): DashboardStateEnvelope[] {
    if (cursor <= 0) return [];
    return Array.from(this.eventLog.values())
      .flat()
      .filter((envelope) => envelope.version > cursor)
      .sort((a, b) => a.version - b.version);
  }

  envelopeVisibleToSession(envelope: DashboardStateEnvelope, scope?: DashboardSessionScope | null): boolean {
    return this.options.sessions.envelopeVisibleToSession(envelope, scope);
  }

  sourceStatusEnvelope(source: ActiveSourceStatus, version: number): DashboardStateEnvelope {
    return {
      domain: "source",
      id: source.source_id,
      version,
      op: "upsert",
      timestamp: source.updated_at ?? source.created_at ?? Date.now(),
      scope: {
        ...(source.user_id ? { user_id: source.user_id } : {}),
        ...(source.session_id ? { session_id: source.session_id } : {}),
      },
      data: { ...source },
    };
  }

  broadcastEnvelope(envelope: DashboardStateEnvelope): void {
    this.rememberEnvelope(envelope);
    const wss = this.options.getDashboardWss();
    if (!wss) return;
    const msg = JSON.stringify(envelope);
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      const scope = (client as WebSocket & { dashboardSession?: DashboardSessionScope }).dashboardSession;
      if (this.envelopeVisibleToSession(envelope, scope)) client.send(msg);
    }
  }

  publishSourceRemoval(sourceId: string, event: MonitorEvent): void {
    this.sourceRemovedAt.set(sourceId, event.timestamp);
    this.pruneRemovedSources(event.timestamp);
    this.broadcastEnvelope(this.sourceRemoveEnvelope(sourceId, event, this.nextVersion()));
  }

  async publishSourceState(sourceId: string, event?: MonitorEvent): Promise<void> {
    try {
      const removedAt = this.sourceRemovedAt.get(sourceId);
      if (removedAt !== undefined && (!event || event.timestamp <= removedAt)) return;
      if (event && removedAt !== undefined && event.timestamp > removedAt) {
        this.sourceRemovedAt.delete(sourceId);
      }
      const streams = await this.options.getGo2rtcStreams();
      const rawSource = event ? this.sourceStatusFromRawEvent(event, sourceId) : undefined;
      if (rawSource) this.options.sourceStatuses.setOverride(sourceId, rawSource);
      const resolved = await this.options.sourceStatuses.sourceStatusById(sourceId)
        ?? (rawSource ? this.options.sourceStatuses.enrichSourceStatus(rawSource, streams) : undefined);
      const latestRemovedAt = this.sourceRemovedAt.get(sourceId);
      if (latestRemovedAt !== undefined && (!event || event.timestamp <= latestRemovedAt)) return;
      if (event && latestRemovedAt !== undefined && event.timestamp > latestRemovedAt) {
        this.sourceRemovedAt.delete(sourceId);
      }
      const source = resolved && rawSource
        ? this.options.sourceStatuses.applySourceStatusOverride(this.options.sourceStatuses.enrichSourceStatus({
          ...resolved,
          status: rawSource.status,
          last_error: rawSource.last_error ?? resolved.last_error,
          updated_at: rawSource.updated_at,
        }, streams), streams)
        : resolved;
      if (!source) return;
      this.broadcastEnvelope(this.sourceStatusEnvelope(source, this.nextVersion()));
    } catch (err) {
      writeStderr("[dashboard-state] source projection failed", err);
    }
  }

  async projectRawMonitorEvent(event: MonitorEvent): Promise<void> {
    if (event.type === "cam:source_removed") {
      const sourceId = typeof event.data.source_id === "string"
        ? event.data.source_id
        : typeof event.data.id === "string"
          ? event.data.id
          : event.camera_id;
      if (sourceId) {
        this.options.sourceStatuses.deleteOverride(sourceId);
        this.options.segments.clearPartialSegmentsForCamera(sourceId);
        this.publishSourceRemoval(sourceId, event);
      }
      return;
    }

    if (
      event.type === "cam:source_added" ||
      event.type === "cam:watch_started" ||
      event.type === "cam:watch_stopped" ||
      event.type === "cam:source_waiting" ||
      event.type === "cam:source_reconnecting" ||
      event.type === "cam:source_unavailable"
    ) {
      const sourceId = typeof event.data.source_id === "string" ? event.data.source_id : event.camera_id;
      if (sourceId) {
        await this.publishSourceState(sourceId, event);
        if (event.type === "cam:watch_stopped") {
          this.options.segments.clearWatchingPreviews(sourceId);
        }
      }
    }

    if (event.type === "perception:segment_partial") {
      this.options.segments.publishPartialSegmentState(event);
      return;
    }

    if (
      event.type === "memory:memory_added" ||
      event.type === "perception:vlm_result" ||
      event.type === "cam:segment_built"
    ) {
      const segmentId = typeof event.data.segment_id === "string" ? event.data.segment_id : "";
      if (segmentId) this.options.segments.publishSegmentState(segmentId);
    }

    if (
      event.type === "memory:memory_added" ||
      event.type === "memory:memory_updated" ||
      event.type === "memory:memory_deleted"
    ) {
      const memoryId = typeof event.data.memory_id === "string"
        ? event.data.memory_id
        : `${event.camera_id ?? "global"}:${event.timestamp}`;
      this.broadcastEnvelope(this.rawEnvelope(
        "memory",
        memoryId,
        event,
        this.nextVersion(),
        event.type === "memory:memory_deleted" ? "remove" : "upsert",
      ));
    }

    if (
      event.type === "system:service_health" ||
      event.type === "system:active_models" ||
      event.type === "system:pipeline_metrics" ||
      event.type === "system:queue_overflow" ||
      event.type === "system:component_status" ||
      event.type === "system:operation_error"
    ) {
      const id = event.type === "system:component_status"
        ? typeof event.data.status_key === "string" ? event.data.status_key : `${event.type}:${event.timestamp}`
        : event.type === "system:operation_error"
          ? typeof event.data.error_id === "string" ? event.data.error_id : `${event.type}:${event.timestamp}`
        : event.type === "system:pipeline_metrics"
        ? typeof event.data.metric_type === "string" ? event.data.metric_type : "pipeline_metrics"
        : event.type.replace("system:", "");
      this.broadcastEnvelope(this.rawEnvelope("service", id, event, this.nextVersion()));
    }

    if (event.type === "system:pipeline_trace") {
      const traceId = typeof event.data.segment_id === "string"
        ? event.data.segment_id
        : `${event.camera_id ?? "global"}:${event.timestamp}`;
      this.broadcastEnvelope(this.rawEnvelope("trace", traceId, event, this.nextVersion()));
    }
  }

  private rememberEnvelope(envelope: DashboardStateEnvelope): void {
    const log = this.eventLog.get(envelope.domain) ?? [];
    log.push(envelope);
    const maxPerDomain = envelope.domain === "segment" ? 300 : 100;
    if (log.length > maxPerDomain) {
      log.splice(0, log.length - maxPerDomain);
    }
    this.eventLog.set(envelope.domain, log);
  }

  private sourceRemoveEnvelope(sourceId: string, event: MonitorEvent | undefined, version: number): DashboardStateEnvelope {
    const eventUser = typeof event?.data.user_id === "string" ? event.data.user_id : undefined;
    const eventSession = typeof event?.data.session_id === "string" ? event.data.session_id : undefined;
    const owner = this.options.sessions.sourceOwner(sourceId);
    const userId = eventUser ?? owner?.userId;
    const sessionId = eventSession ?? owner?.sessionId;
    return {
      domain: "source",
      id: sourceId,
      version,
      op: "remove",
      timestamp: event?.timestamp ?? Date.now(),
      scope: {
        ...(userId ? { user_id: userId } : {}),
        ...(sessionId ? { session_id: sessionId } : {}),
      },
    };
  }

  private rawEnvelope(domain: DashboardStateDomain, id: string, event: MonitorEvent, version: number, op: DashboardStateOperation = "upsert"): DashboardStateEnvelope {
    return {
      domain,
      id,
      version,
      op,
      timestamp: event.timestamp,
      scope: {
        ...(typeof event.data.user_id === "string" ? { user_id: event.data.user_id } : {}),
        ...(typeof event.data.session_id === "string" ? { session_id: event.data.session_id } : {}),
      },
      data: {
        ...event.data,
        event_type: event.type,
        ...(event.camera_id ? { camera_id: event.camera_id } : {}),
      },
    };
  }

  private sourceStatusFromRawEvent(event: MonitorEvent, sourceId: string): ActiveSourceStatus {
    const sourceName = typeof event.data.source_name === "string"
      ? event.data.source_name
      : typeof event.data.name === "string"
        ? event.data.name
        : sourceId;
    const status: ActiveSourceStatus["status"] =
      event.type === "cam:source_unavailable"
        ? "unavailable"
        : event.type === "cam:source_reconnecting"
          ? "reconnecting"
          : event.type === "cam:source_waiting"
          ? "waiting"
          : event.type === "cam:watch_stopped"
            ? "stopped"
            : "active";
    return {
      source_id: sourceId,
      source_name: sourceName,
      ...(typeof event.data.user_id === "string" ? { user_id: event.data.user_id } : {}),
      ...(typeof event.data.session_id === "string" ? { session_id: event.data.session_id } : {}),
      ...(typeof event.data.input === "string" ? { input: event.data.input } : {}),
      ...(typeof event.data.protocol === "string" ? { protocol: event.data.protocol } : {}),
      ...(typeof event.data.video_id === "string" ? { video_id: event.data.video_id } : {}),
      created_at: event.timestamp,
      updated_at: event.timestamp,
      status,
      ...(event.type === "cam:source_reconnecting"
        ? { last_error: "Reconnecting stream" }
        : typeof event.data.error === "string"
          ? { last_error: event.data.error }
          : {}),
    };
  }

  private pruneRemovedSources(now = Date.now()): void {
    const ttlMs = 24 * 60 * 60 * 1000;
    for (const [sourceId, removedAt] of this.sourceRemovedAt) {
      if (now - removedAt > ttlMs) this.sourceRemovedAt.delete(sourceId);
    }
    const maxEntries = 1000;
    while (this.sourceRemovedAt.size > maxEntries) {
      const oldest = this.sourceRemovedAt.keys().next().value as string | undefined;
      if (!oldest) break;
      this.sourceRemovedAt.delete(oldest);
    }
  }
}
