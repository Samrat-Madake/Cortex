import type { ActiveSourceStatus, PipelineTrace } from "@reflectworld/shared";
import type { PipelineStore } from "../store.js";
import {
  dashboardRawReadLimit,
  parseDashboardJson,
  type AnalysisStatusSnapshot,
  type DashboardSessionScope,
} from "./dashboard-common.js";

export interface DashboardContextBuilderOptions {
  store: PipelineStore | null;
  sessionEnabled: () => boolean;
  getActiveSources: () => ActiveSourceStatus[];
  getAnalysisStatus: () => AnalysisStatusSnapshot;
  sourceVisibleToSession: (sourceId: string, scope?: DashboardSessionScope | null) => boolean;
}

export class DashboardContextBuilder {
  constructor(private readonly options: DashboardContextBuilderOptions) {}

  buildRuntimeContext(cameraId?: string, scope?: DashboardSessionScope | null): string {
    const lines: string[] = [];
    const activeSources = this.options.getActiveSources()
      .filter(source => this.options.sourceVisibleToSession(source.source_id, scope))
      .filter(source => source.status === "active")
      .filter(source => !cameraId || source.source_id === cameraId);
    lines.push(`sources=${activeSources.length}`);
    for (const source of activeSources.slice(0, 8)) {
      lines.push([
        `source=${source.source_id}`,
        source.source_name ? `name=${source.source_name}` : "",
        source.protocol ? `protocol=${source.protocol}` : "",
        source.mode ? `mode=${source.mode}` : "",
        typeof source.fps === "number" ? `fps=${source.fps}` : "",
        source.input ? `input=${source.input}` : "",
      ].filter(Boolean).join(" "));
    }

    const snapshot = this.options.getAnalysisStatus();
    const activeAnalyses = snapshot.active
      .filter(item => this.options.sourceVisibleToSession(item.camera_id, scope))
      .filter(item => !cameraId || item.camera_id === cameraId);
    const recentAnalyses = snapshot.recent
      .filter(item => this.options.sourceVisibleToSession(item.camera_id, scope))
      .filter(item => !cameraId || item.camera_id === cameraId);
    lines.push(`active_analysis=${activeAnalyses.length}`);
    for (const item of activeAnalyses.slice(0, 6)) {
      lines.push(`analysis=${item.camera_id} status=${item.status} segments=${item.segments_count} video=${item.video_id} age_sec=${Math.max(0, Math.round((Date.now() - item.started_at) / 1000))}`);
    }
    lines.push(`recent_analysis=${recentAnalyses.length}`);
    for (const item of recentAnalyses.slice(0, 4)) {
      lines.push(`recent=${item.camera_id} status=${item.status} segments=${item.segments_count} video=${item.video_id}`);
    }
    return lines.join("\n").slice(0, 6_000);
  }

  visibleTraces(cameraId: string | undefined, scope: DashboardSessionScope | null | undefined, limit: number): PipelineTrace[] {
    const store = this.options.store;
    if (!store) return [];
    if (cameraId) {
      return this.options.sourceVisibleToSession(cameraId, scope) ? store.getRecentTraces(cameraId, limit) : [];
    }
    const rawLimit = this.options.sessionEnabled() && scope && !scope.isAdmin
      ? dashboardRawReadLimit(limit)
      : limit;
    return store.getRecentTraces(undefined, rawLimit)
      .filter((trace) => this.options.sourceVisibleToSession(trace.camera_id, scope))
      .slice(0, limit);
  }

  emptyTraceStats(): ReturnType<PipelineStore["getTraceStats"]> {
    const zero = { avg: 0, p50: 0, p95: 0 };
    return {
      count: 0,
      e2e_ms: zero,
      perception_ms: zero,
      vlm_ms: zero,
      vlm_prep_ms: zero,
      vlm_analyze_ms: zero,
      vlm_finalize_ms: zero,
      detection_ms: zero,
      memory_blocking_ms: zero,
      memory_ms: zero,
    };
  }

  traceStats(traces: PipelineTrace[]): ReturnType<PipelineStore["getTraceStats"]> {
    if (traces.length === 0) return this.emptyTraceStats();
    const percentiles = (values: number[]) => {
      if (values.length === 0) return { avg: 0, p50: 0, p95: 0 };
      const sorted = [...values].sort((a, b) => a - b);
      const avg = Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length);
      return {
        avg,
        p50: sorted[Math.floor(sorted.length * 0.5)]!,
        p95: sorted[Math.floor(sorted.length * 0.95)]!,
      };
    };
    return {
      count: traces.length,
      e2e_ms: percentiles(traces.map((trace) => trace.latencies.e2e_ms)),
      perception_ms: percentiles(traces.map((trace) => trace.latencies.perception_ms)),
      vlm_ms: percentiles(traces.flatMap((trace) => trace.latencies.vlm_ms === undefined ? [] : [trace.latencies.vlm_ms])),
      vlm_prep_ms: percentiles(traces.flatMap((trace) => trace.latencies.vlm_prep_ms === undefined ? [] : [trace.latencies.vlm_prep_ms])),
      vlm_analyze_ms: percentiles(traces.flatMap((trace) => trace.latencies.vlm_analyze_ms === undefined ? [] : [trace.latencies.vlm_analyze_ms])),
      vlm_finalize_ms: percentiles(traces.flatMap((trace) => trace.latencies.vlm_finalize_ms === undefined ? [] : [trace.latencies.vlm_finalize_ms])),
      detection_ms: percentiles(traces.flatMap((trace) => trace.latencies.detection_ms === undefined ? [] : [trace.latencies.detection_ms])),
      memory_blocking_ms: percentiles(traces.flatMap((trace) => trace.latencies.memory_blocking_ms === undefined ? [] : [trace.latencies.memory_blocking_ms])),
      memory_ms: percentiles(traces.flatMap((trace) => trace.latencies.memory_ms === undefined ? [] : [trace.latencies.memory_ms])),
    };
  }

  buildChatContext(cameraId?: string, limit = 12, scope?: DashboardSessionScope | null): string {
    const store = this.options.store;
    if (!store) return "No pipeline store is available.";
    const rawLimit = this.options.sessionEnabled() && scope && !scope.isAdmin && !cameraId
      ? dashboardRawReadLimit(limit)
      : limit;
    const rows = store.getRecent(cameraId, rawLimit)
      .filter((row) => this.options.sourceVisibleToSession(row.camera_id, scope))
      .slice(0, limit);
    if (rows.length === 0) {
      return cameraId
        ? `No moments are available for source ${cameraId}.`
        : "No moments are available yet.";
    }

    const formatSeconds = (ms: number): string => {
      const total = Math.max(0, Math.round(ms / 1000));
      const minutes = Math.floor(total / 60);
      const seconds = total % 60;
      return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, "0")}` : `${seconds}s`;
    };

    return rows.map((row, idx) => {
      const entities = parseDashboardJson<unknown[]>(row.entities_json, []);
      const targets = entities.slice(0, 6).flatMap((entity) => {
        if (!entity || typeof entity !== "object") return [];
        const item = entity as Record<string, unknown>;
        const type = typeof item.type === "string" ? item.type : "entity";
        const appearance = typeof item.appearance === "string" && item.appearance.trim()
          ? ` appearance=${item.appearance.trim()}`
          : "";
        const behavior = typeof item.behavior === "string" && item.behavior.trim()
          ? ` behavior=${item.behavior.trim()}`
          : "";
        return [`${type}${appearance}${behavior}`.slice(0, 360)];
      });
      const notifications = store.getNotificationMessages(row.segment_id).slice(0, 3);
      const timeRange = typeof row.segment_start === "number" && Number.isFinite(row.segment_start)
        ? `${formatSeconds(row.segment_start)}-${formatSeconds(row.segment_start + Math.max(0, row.duration_sec) * 1000)}`
        : row.created_at;
      return [
        `Moment ${idx + 1}:`,
        `source=${row.camera_id}`,
        `time_range=${timeRange}`,
        `duration=${Math.round(row.duration_sec)}s`,
        `summary=${row.summary}`,
        row.detailed_summary ? `detail=${row.detailed_summary}` : "",
        targets.length ? `targets=${targets.join(" | ")}` : "",
        notifications.length ? `rules_or_notifications=${notifications.join(" | ")}` : "",
      ].filter(Boolean).join("\n");
    }).join("\n\n").slice(0, 12_000);
  }
}
