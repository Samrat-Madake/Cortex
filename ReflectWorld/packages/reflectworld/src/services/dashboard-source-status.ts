import { relative, resolve } from "node:path";
import type { ActiveSourceStatus } from "@reflectworld/shared";
import type { PipelineStore } from "../store.js";
import type { AnalysisStatusItem, AnalysisStatusSnapshot, DashboardSessionScope } from "./dashboard-common.js";
import type { Go2rtcStreamHealth } from "./dashboard-live-proxy.js";

export interface DashboardSourceStatusServiceOptions {
  sessionEnabled: () => boolean;
  getActiveSources: () => ActiveSourceStatus[];
  getAnalysisStatus: () => AnalysisStatusSnapshot;
  sourceVisibleToSession: (sourceId: string, scope?: DashboardSessionScope | null) => boolean;
  getGo2rtcStreams: () => Promise<Record<string, unknown> | null>;
  readGo2rtcStreamHealth: (streams: Record<string, unknown> | null, sourceId: string) => Go2rtcStreamHealth | null;
  store: PipelineStore | null;
  uploadsDir: string;
  fixtureVideosDir: string | null;
}

export class DashboardSourceStatusService {
  private readonly overrides = new Map<string, ActiveSourceStatus>();

  constructor(private readonly options: DashboardSourceStatusServiceOptions) {}

  setOverride(sourceId: string, source: ActiveSourceStatus): void {
    this.overrides.set(sourceId, source);
  }

  deleteOverride(sourceId: string): void {
    this.overrides.delete(sourceId);
  }

  visibleSourceStatusesSync(scope?: DashboardSessionScope | null): ActiveSourceStatus[] {
    return this.options.getActiveSources().filter((source) => {
      if (source.session_id || source.user_id) {
        if (!this.options.sessionEnabled()) return true;
        if (!scope) return false;
        if (scope.isAdmin) return true;
        if (source.session_id && source.user_id) {
          return source.session_id === scope.sessionId && source.user_id === scope.userId;
        }
        if (source.session_id) return source.session_id === scope.sessionId;
        return source.user_id === scope.userId;
      }
      return this.options.sourceVisibleToSession(source.source_id, scope);
    });
  }

  async visibleSourceStatuses(scope?: DashboardSessionScope | null): Promise<ActiveSourceStatus[]> {
    const rawSources = this.visibleSourceStatusesSync(scope);
    const streams = await this.options.getGo2rtcStreams();
    const snapshot = this.options.getAnalysisStatus();
    const analysisByCamera = new Map<string, AnalysisStatusItem>();
    for (const item of [...snapshot.recent, ...snapshot.active]) {
      if (!this.options.sourceVisibleToSession(item.camera_id, scope)) continue;
      analysisByCamera.set(item.camera_id, item);
    }
    const sources = new Map<string, ActiveSourceStatus>();
    for (const source of rawSources) {
      const enriched = this.enrichSourceStatus(source, streams, analysisByCamera.get(source.source_id));
      sources.set(source.source_id, this.applySourceStatusOverride(enriched, streams));
    }
    for (const analysis of analysisByCamera.values()) {
      if (sources.has(analysis.camera_id)) continue;
      const enriched = this.enrichSourceStatus({
        source_id: analysis.camera_id,
        source_name: analysis.video_id,
        ...(analysis.user_id ? { user_id: analysis.user_id } : {}),
        ...(analysis.session_id ? { session_id: analysis.session_id } : {}),
        input: analysis.video_id,
        protocol: "file",
        created_at: analysis.started_at,
        status: analysis.status === "completed"
          ? "stopped"
          : analysis.status === "failed"
            ? "unavailable"
            : analysis.status === "starting" ? "waiting" : "active",
      }, streams, analysis);
      sources.set(analysis.camera_id, this.applySourceStatusOverride(enriched, streams));
    }
    return Array.from(sources.values()).sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
  }

  async sourceStatusById(sourceId: string): Promise<ActiveSourceStatus | undefined> {
    const streams = await this.options.getGo2rtcStreams();
    const snapshot = this.options.getAnalysisStatus();
    const analysis = [...snapshot.active, ...snapshot.recent].find((item) => item.camera_id === sourceId);
    const source = this.options.getActiveSources().find((item) => item.source_id === sourceId);
    if (source) return this.applySourceStatusOverride(this.enrichSourceStatus(source, streams, analysis), streams);
    if (!analysis) return undefined;
    return this.applySourceStatusOverride(this.enrichSourceStatus({
      source_id: analysis.camera_id,
      source_name: analysis.video_id,
      ...(analysis.user_id ? { user_id: analysis.user_id } : {}),
      ...(analysis.session_id ? { session_id: analysis.session_id } : {}),
      input: analysis.video_id,
      protocol: "file",
      created_at: analysis.started_at,
      status: analysis.status === "completed"
        ? "stopped"
        : analysis.status === "failed"
          ? "unavailable"
          : analysis.status === "starting" ? "waiting" : "active",
    }, streams, analysis), streams);
  }

  applySourceStatusOverride(source: ActiveSourceStatus, streams: Record<string, unknown> | null): ActiveSourceStatus {
    const override = this.overrides.get(source.source_id);
    if (!override) return source;
    return this.enrichSourceStatus({
      ...source,
      status: override.status,
      last_error: override.last_error ?? source.last_error,
      updated_at: override.updated_at ?? source.updated_at,
    }, streams);
  }

  sourceLabel(source: ActiveSourceStatus): string {
    const raw = source.label ?? source.video_id ?? source.source_name ?? source.source_id;
    const trimmed = raw.trim();
    if (!trimmed) return source.source_id;
    const parts = trimmed.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? trimmed;
  }

  enrichSourceStatus(
    source: ActiveSourceStatus,
    streams: Record<string, unknown> | null,
    analysis?: AnalysisStatusItem,
  ): ActiveSourceStatus {
    const kind = this.sourceKind(source);
    const videoId = this.sourceVideoId(source, analysis);
    const isUpload = kind === "upload";
    const health = isUpload ? null : this.options.readGo2rtcStreamHealth(streams, source.source_id);
    const analysisStatus: NonNullable<ActiveSourceStatus["analysis_status"]> = analysis?.status ?? (source.status === "active" ? "active" : "none");
    const watchStatus: NonNullable<ActiveSourceStatus["watch_status"]> =
      source.status === "active"
        ? "running"
        : source.status === "reconnecting"
          ? "starting"
        : source.status === "waiting"
          ? "starting"
          : source.status === "unavailable"
            ? "failed"
            : "stopped";
    const mediaStatus: NonNullable<ActiveSourceStatus["media_status"]> = isUpload
      ? "preview_ready"
      : watchStatus === "stopped"
        ? "stopped"
        : health?.active
          ? "live_ready"
          : watchStatus === "starting"
            ? "waiting"
            : "unavailable";
    const recoveredFromReconnect = mediaStatus === "live_ready"
      && (source.status === "reconnecting" || source.last_error === "Reconnecting stream");
    const lastError = recoveredFromReconnect ? undefined : source.last_error;
    const segmentsCount = analysis?.segments_count ?? this.options.store?.getSegmentCount(source.source_id);
    const updatedAt = source.updated_at ?? analysis?.completed_at ?? analysis?.started_at ?? source.created_at;
    const summary = source.summary ?? this.sourceLatestSummary(source.source_id);
    const next: ActiveSourceStatus = {
      ...source,
      last_error: lastError,
      kind,
      label: this.sourceLabel({ ...source, ...(videoId ? { video_id: videoId } : {}) }),
      input_kind: source.input_kind ?? this.sourceInputKind(source),
      display_status: this.sourceDisplayStatus(source, kind, analysisStatus, watchStatus, mediaStatus),
      ...(summary ? { summary } : {}),
      ...(videoId ? { video_id: videoId } : {}),
      ...(videoId ? { preview_url: `/api/videos/preview?video_id=${encodeURIComponent(videoId)}` } : {}),
      watch_status: watchStatus,
      media_status: mediaStatus,
      analysis_status: analysisStatus,
      ...(typeof segmentsCount === "number" ? { segments_count: segmentsCount } : {}),
      ...(typeof updatedAt === "number" ? { updated_at: updatedAt } : {}),
      can_start: !isUpload && (watchStatus === "stopped" || watchStatus === "failed"),
      can_stop: watchStatus === "running" || watchStatus === "starting",
      can_delete: true,
      config: {
        ...(source.mode ? { mode: source.mode } : {}),
        ...(typeof source.fps === "number" ? { fps: source.fps } : {}),
      },
    };
    return { ...next, status: this.legacySourceStatus(next) };
  }

  private sourceKind(source: ActiveSourceStatus): NonNullable<ActiveSourceStatus["kind"]> {
    if (source.protocol === "file" || source.video_id || source.source_id.startsWith("video-")) return "upload";
    if (source.protocol === "phone") return "phone";
    if (source.protocol === "local") return "local_device";
    return "stream_url";
  }

  private sourceVideoId(source: ActiveSourceStatus, analysis?: AnalysisStatusItem): string | undefined {
    if (source.video_id) return source.video_id;
    if (analysis?.video_id) return analysis.video_id;
    if (!source.input) return undefined;
    if (source.protocol !== "file" && !source.source_id.startsWith("video-")) return undefined;
    if (source.input.startsWith("upload/") || source.input.startsWith("fixture/")) return source.input;
    const normalizedUploadDir = resolve(this.options.uploadsDir);
    const normalizedFixtureDir = this.options.fixtureVideosDir ? resolve(this.options.fixtureVideosDir) : null;
    const abs = resolve(source.input);
    const uploadRel = relative(normalizedUploadDir, abs);
    if (uploadRel && !uploadRel.startsWith("..") && uploadRel !== "." && !uploadRel.startsWith("/")) {
      return `upload/${uploadRel}`;
    }
    if (normalizedFixtureDir) {
      const fixtureRel = relative(normalizedFixtureDir, abs);
      if (fixtureRel && !fixtureRel.startsWith("..") && fixtureRel !== "." && !fixtureRel.startsWith("/")) {
        return `fixture/${fixtureRel}`;
      }
    }
    return undefined;
  }

  private legacySourceStatus(source: ActiveSourceStatus): ActiveSourceStatus["status"] {
    if (source.status === "reconnecting" && source.display_status !== "active") return "reconnecting";
    if (source.watch_status === "failed" || source.media_status === "unavailable") return "unavailable";
    if (source.media_status === "live_ready") return "active";
    if (source.watch_status === "running") return "active";
    if (source.watch_status === "starting" || source.media_status === "waiting") return "waiting";
    if (source.watch_status === "stopped" || source.analysis_status === "completed") return "stopped";
    return source.status;
  }

  private sourceInputKind(source: ActiveSourceStatus): NonNullable<ActiveSourceStatus["input_kind"]> {
    const input = source.input ?? "";
    if (source.protocol === "phone" || input === "phone" || input === "webcam") return "web";
    if (input.startsWith("rtsp://") || input.startsWith("http://") || input.startsWith("https://")) return "url";
    return "unknown";
  }

  private sourceDisplayStatus(
    source: ActiveSourceStatus,
    kind: NonNullable<ActiveSourceStatus["kind"]>,
    analysisStatus: NonNullable<ActiveSourceStatus["analysis_status"]>,
    watchStatus: NonNullable<ActiveSourceStatus["watch_status"]>,
    mediaStatus: NonNullable<ActiveSourceStatus["media_status"]>,
  ): NonNullable<ActiveSourceStatus["display_status"]> {
    if (kind === "upload") {
      if (analysisStatus === "completed") return "completed";
      if (analysisStatus === "starting") return "preparing";
      if (analysisStatus === "active") return "active";
      if (analysisStatus === "failed") return "unavailable";
      if (watchStatus === "stopped") return "completed";
    }
    const reconnecting = source.status === "reconnecting" || (source.status === "waiting" && source.last_error === "Reconnecting stream");
    if (reconnecting && mediaStatus === "live_ready") return "active";
    if (reconnecting) return "reconnecting";
    if (watchStatus === "failed" || mediaStatus === "unavailable" || analysisStatus === "failed") return "unavailable";
    if (watchStatus === "running") return "active";
    if (watchStatus === "starting" || mediaStatus === "waiting") return "waiting";
    if (watchStatus === "stopped" || mediaStatus === "stopped") return "stopped";
    return source.status === "unavailable" ? "unavailable" : source.status === "waiting" ? "waiting" : source.status;
  }

  private sourceLatestSummary(sourceId: string): string | undefined {
    const row = this.options.store?.getRecent(sourceId, 1)[0];
    const summary = row?.summary?.trim();
    return summary || undefined;
  }
}
