import type { IncomingMessage, ServerResponse } from "node:http";
import { monitorBus, writeStderr } from "@reflectworld/shared";
import type { ActiveSourceStatus, MonitorEvent } from "@reflectworld/shared";
import type { PipelineStore } from "../store.js";
import type {
  AnalysisStatusItem,
  AnalysisStatusSnapshot,
  DashboardAddSourceOptions,
  DashboardSessionScope,
} from "./dashboard-common.js";
import { isRecord } from "./dashboard-common.js";
import type { DashboardSessionManager } from "./dashboard-sessions.js";
import type { DashboardSourceStatusService } from "./dashboard-source-status.js";
import type { DashboardVideoLibrary } from "./dashboard-videos.js";

export interface AnalyzeRequest {
  videoId: string;
  filePath: string;
  fps: number;
  localFilePacing: "fast" | "realtime";
  semanticContextInit?: string;
  userId?: string;
  sessionId?: string;
}

export interface AnalyzeResponse {
  ok?: boolean;
  camera_id?: string;
  video_id?: string;
  warnings?: string[];
  completed?: boolean;
  error?: string;
  statusCode?: number;
}

export interface StreamAnalyzeRequest {
  source?: string;
  name: string;
  mode: "stream" | "event";
  fps: number;
  width?: number;
  height?: number;
  duration?: number;
  deferWatch?: boolean;
  semanticContextInit?: string;
  userId?: string;
  sessionId?: string;
}

export interface StreamAnalyzeResponse {
  ok?: boolean;
  camera_id?: string;
  source_id?: string;
  status?: "starting" | "waiting";
  warnings?: string[];
  phone_setup?: {
    node_url?: string;
    qr_data_url?: string;
    message?: string;
  };
  error?: string;
  statusCode?: number;
}

export interface SourceRemoveResponse {
  ok?: boolean;
  source_id?: string;
  video_id?: string;
  upload_removed?: boolean;
  error?: string;
  statusCode?: number;
}

export interface SourceRemoveRequest {
  name: string;
  videoId?: string;
  removeUpload?: boolean;
  userId?: string;
  sessionId?: string;
}

export interface SourceStopResponse {
  ok?: boolean;
  source_id?: string;
  error?: string;
  statusCode?: number;
}

export interface SourceStopRequest {
  name: string;
  userId?: string;
  sessionId?: string;
}

export interface SourcePurgeResponse {
  ok?: boolean;
  error?: string;
  statusCode?: number;
}

export interface SourcePurgeRequest {
  sourceId: string;
  videoId?: string;
  userId?: string;
  sessionId?: string;
}

export interface DashboardSourceActionControllerOptions {
  sessionEnabled: () => boolean;
  getAddSource: () => ((source: string, name?: string, opts?: DashboardAddSourceOptions) => Promise<string>) | null;
  getAnalyze: () => ((req: AnalyzeRequest) => Promise<AnalyzeResponse>) | null;
  getStreamAnalyze: () => ((req: StreamAnalyzeRequest) => Promise<StreamAnalyzeResponse>) | null;
  getRemoveSource: () => ((req: SourceRemoveRequest) => Promise<SourceRemoveResponse>) | null;
  getStopSource: () => ((req: SourceStopRequest) => Promise<SourceStopResponse>) | null;
  getPurgeSource: () => ((req: SourcePurgeRequest) => Promise<SourcePurgeResponse>) | null;
  getActiveSources: () => ActiveSourceStatus[];
  getAnalysisStatus: () => AnalysisStatusSnapshot;
  getClearDashboardData: () => ((scope?: DashboardSessionScope | null) => Promise<void>) | null;
  store: PipelineStore | null;
  videos: DashboardVideoLibrary;
  sessions: DashboardSessionManager;
  sourceStatuses: DashboardSourceStatusService;
  clearActiveStaticGap: (sourceId: string) => void;
  publishSourceState: (sourceId: string) => Promise<void>;
  publishSourceRemoval: (sourceId: string, event: MonitorEvent) => void;
  purgeSessionHealth: (sessionId: string) => void;
  requireDashboardSession: (
    req: IncomingMessage,
    res: ServerResponse,
    body?: Record<string, unknown>,
    url?: URL,
  ) => DashboardSessionScope | null;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readRequestBuffer: (req: IncomingMessage, maxBytes?: number) => Promise<Buffer>;
}

export class DashboardSourceActionController {
  constructor(private readonly options: DashboardSourceActionControllerOptions) {}

  recordSourceOwner(sourceId: string | undefined, scope: DashboardSessionScope | null): void {
    this.options.sessions.recordSourceOwner(sourceId, scope);
  }

  async handleSourceAdd(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const addSource = this.options.getAddSource();
    if (!addSource) {
      this.options.sendJson(res, 503, { error: "Cam service not ready" });
      return;
    }
    try {
      const raw = await this.options.readRequestBuffer(req, 1024 * 1024);
      const payload = JSON.parse(raw.toString("utf8") || "{}") as { source?: string; name?: string } & Record<string, unknown>;
      const scope = this.options.requireDashboardSession(req, res, payload, url);
      if (this.options.sessionEnabled() && !scope) return;
      const limit = this.options.sessions.enforceSourceLimit(scope);
      if (!limit.ok) {
        this.options.sendJson(res, limit.status, limit.body);
        return;
      }
      if (!payload.source || typeof payload.source !== "string") {
        this.options.sendJson(res, 400, { error: "source (URL) is required" });
        return;
      }
      const name = typeof payload.name === "string" ? payload.name : undefined;
      const result = await addSource(payload.source, name, scope ? { userId: scope.userId, sessionId: scope.sessionId } : undefined);
      const parsed = JSON.parse(result);
      if (isRecord(parsed) && parsed.success) {
        const sourceRecord = isRecord(parsed.source) ? parsed.source : undefined;
        const sourceId = typeof parsed.source_id === "string"
          ? parsed.source_id
          : typeof sourceRecord?.id === "string"
            ? sourceRecord.id
            : undefined;
        this.recordSourceOwner(sourceId, scope);
        this.options.sendJson(res, 200, parsed);
      } else {
        this.options.sendJson(res, 400, parsed);
      }
    } catch (err) {
      this.options.sendJson(res, 500, { error: err instanceof Error ? err.message : "add_source failed" });
    }
  }

  async handleAnalyze(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const analyze = this.options.getAnalyze();
    if (!analyze) {
      this.options.sendJson(res, 503, { error: "Analyze service not ready" });
      return;
    }
    try {
      const raw = await this.options.readRequestBuffer(req, 1024 * 1024);
      const payload = JSON.parse(raw.toString("utf8")) as {
        video_id?: unknown;
        fps?: unknown;
        local_file_pacing?: unknown;
        source_context?: unknown;
      };
      const scope = this.options.requireDashboardSession(req, res, payload as Record<string, unknown>);
      if (this.options.sessionEnabled() && !scope) return;
      const limit = this.options.sessions.enforceSourceLimit(scope);
      if (!limit.ok) {
        this.options.sendJson(res, limit.status, limit.body);
        return;
      }
      const videoId = typeof payload.video_id === "string" ? payload.video_id : "";
      if (videoId.startsWith("upload/") && !this.options.videos.uploadVisibleToScope(videoId.slice("upload/".length), scope)) {
        this.options.sendJson(res, 400, { error: "Invalid or unavailable video_id" });
        return;
      }
      const filePath = this.options.videos.resolveVideoId(videoId);
      if (!filePath) {
        this.options.sendJson(res, 400, { error: "Invalid or unavailable video_id" });
        return;
      }
      const fps = typeof payload.fps === "number" && Number.isFinite(payload.fps) && payload.fps > 0
        ? Math.min(payload.fps, 30)
        : 1;
      const localFilePacing = payload.local_file_pacing === "realtime" ? "realtime" : "fast";
      const semanticContextInit = typeof payload.source_context === "string"
        ? payload.source_context.trim().slice(0, 4000)
        : "";
      const result = await analyze({
        videoId,
        filePath,
        fps,
        localFilePacing,
        ...(semanticContextInit ? { semanticContextInit } : {}),
        ...(scope ? { userId: scope.userId, sessionId: scope.sessionId } : {}),
      });
      this.recordSourceOwner(result.camera_id, scope);
      this.options.sendJson(res, result.statusCode ?? (result.error ? 400 : 200), result);
    } catch (err) {
      this.options.sendJson(res, 400, { error: err instanceof Error ? err.message : "Invalid analyze request" });
    }
  }

  async handleStreamAnalyze(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const streamAnalyze = this.options.getStreamAnalyze();
    if (!streamAnalyze) {
      this.options.sendJson(res, 503, { error: "Stream watch service not ready" });
      return;
    }
    try {
      const raw = await this.options.readRequestBuffer(req, 1024 * 1024);
      const payload = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      const scope = this.options.requireDashboardSession(req, res, payload);
      if (this.options.sessionEnabled() && !scope) return;
      const limit = this.options.sessions.enforceSourceLimit(scope);
      if (!limit.ok && payload.defer_watch !== true) {
        this.options.sendJson(res, limit.status, limit.body);
        return;
      }
      const source = typeof payload.source === "string" && payload.source.trim()
        ? payload.source.trim()
        : undefined;
      const name = typeof payload.name === "string" ? payload.name.trim() : "";
      if (!name) {
        this.options.sendJson(res, 400, { error: "name is required" });
        return;
      }

      const mode = payload.mode === "event" ? "event" : "stream";
      const fps = typeof payload.fps === "number" && Number.isFinite(payload.fps) && payload.fps > 0
        ? Math.min(payload.fps, 30)
        : 1;
      const width = typeof payload.width === "number" && Number.isFinite(payload.width) && payload.width > 0
        ? Math.round(payload.width)
        : undefined;
      const height = typeof payload.height === "number" && Number.isFinite(payload.height) && payload.height > 0
        ? Math.round(payload.height)
        : undefined;
      const duration = typeof payload.duration === "number" && Number.isFinite(payload.duration) && payload.duration > 0
        ? payload.duration
        : undefined;
      const deferWatch = payload.defer_watch === true;
      const semanticContextInit = typeof payload.source_context === "string"
        ? payload.source_context.trim().slice(0, 4000)
        : "";

      const result = await streamAnalyze({
        ...(source ? { source } : {}),
        name,
        mode,
        fps,
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
        ...(duration ? { duration } : {}),
        ...(deferWatch ? { deferWatch } : {}),
        ...(semanticContextInit ? { semanticContextInit } : {}),
        ...(scope ? { userId: scope.userId, sessionId: scope.sessionId } : {}),
      });
      const sourceId = result.source_id ?? result.camera_id ?? name;
      this.recordSourceOwner(sourceId, scope);
      if (sourceId && !result.error) await this.options.publishSourceState(sourceId);
      this.options.sendJson(res, result.statusCode ?? (result.error ? 400 : 200), result);
    } catch (err) {
      this.options.sendJson(res, 400, { error: err instanceof Error ? err.message : "Invalid stream watch request" });
    }
  }

  async handleDashboardClear(res: ServerResponse, scope?: DashboardSessionScope | null): Promise<void> {
    try {
      if (this.options.sessionEnabled() && scope && !scope.isAdmin) {
        const sourceIds = this.dashboardSourceIdsForClear(scope);
        await this.options.getClearDashboardData()?.(scope);
        const removeSource = this.options.getRemoveSource();
        for (const sourceId of sourceIds) {
          await removeSource?.({ name: sourceId, userId: scope.userId, sessionId: scope.sessionId }).catch(() => undefined);
          await this.purgeDashboardSourceState(sourceId, { scope, publishRemoval: true }).catch((err) => {
            writeStderr("[dashboard] failed to purge source during clear", sourceId, err);
          });
        }
        this.options.sessions.clearSessionSources(scope.sessionId);
        this.clearUploadsAndCaches(scope);
      } else {
        const sourceIds = this.knownDashboardSourceIds();
        await this.options.getClearDashboardData()?.(scope);
        this.options.store?.clearAll();
        this.clearUploadsAndCaches();
        for (const sourceId of sourceIds) {
          await this.purgeDashboardSourceState(sourceId, { publishRemoval: true }).catch((err) => {
            writeStderr("[dashboard] failed to purge source during clear", sourceId, err);
          });
        }
      }
      this.options.sendJson(res, 200, { ok: true });
    } catch (err) {
      this.options.sendJson(res, 500, { error: err instanceof Error ? err.message : "Dashboard clear failed" });
    }
  }

  async handleSourceRemove(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const raw = await this.options.readRequestBuffer(req, 1024 * 1024);
      const payload = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      const scope = this.options.requireDashboardSession(req, res, payload);
      if (this.options.sessionEnabled() && !scope) return;
      const name = typeof payload.name === "string" && payload.name.trim()
        ? payload.name.trim()
        : typeof payload.source_id === "string" && payload.source_id.trim()
          ? payload.source_id.trim()
          : "";
      const videoId = typeof payload.video_id === "string" && payload.video_id.trim()
        ? payload.video_id.trim()
        : undefined;
      // Source deletion only removes the analysis instance and source-scoped state.
      // Uploaded files are managed separately through /api/videos/delete so users can re-analyze them.
      const removeUpload = false;
      if (!name) {
        this.options.sendJson(res, 400, { error: "name or source_id is required" });
        return;
      }

      const canRemoveMissingUploadSource = Boolean(videoId?.startsWith("upload/"))
        && this.options.videos.uploadVisibleToScope(videoId!.slice("upload/".length), scope);
      if (!this.options.sessions.sourceVisibleToSession(name, scope) && !canRemoveMissingUploadSource) {
        this.options.sendJson(res, 404, { error: "Source not found" });
        return;
      }

      const shouldCallRemoveSource = this.options.sessions.sourceVisibleToSession(name, scope);
      const removeSource = this.options.getRemoveSource();
      if (shouldCallRemoveSource && !removeSource) {
        this.options.sendJson(res, 503, { error: "Source management service not ready" });
        return;
      }
      const result = shouldCallRemoveSource
        ? await removeSource!({
          name,
          ...(videoId ? { videoId } : {}),
          removeUpload,
          ...(scope ? { userId: scope.userId, sessionId: scope.sessionId } : {}),
        })
        : {
          ok: true,
          source_id: name,
          ...(videoId ? { video_id: videoId } : {}),
        };
      if (!result.error) {
        let purged: { upload_removed?: boolean };
        try {
          purged = await this.purgeDashboardSourceState(result.source_id ?? name, {
            scope,
            ...(videoId ? { videoId } : {}),
            removeUpload,
            purgeExternal: !shouldCallRemoveSource,
            publishRemoval: true,
          });
        } catch (err) {
          this.options.sendJson(res, 500, { error: err instanceof Error ? err.message : "Source purge failed" });
          return;
        }
        if (typeof purged.upload_removed === "boolean") {
          result.upload_removed = purged.upload_removed;
        }
      }
      this.options.sendJson(res, result.statusCode ?? (result.error ? 400 : 200), result);
    } catch (err) {
      this.options.sendJson(res, 400, { error: err instanceof Error ? err.message : "Invalid source remove request" });
    }
  }

  async handleSourceStop(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const stopSource = this.options.getStopSource();
    if (!stopSource) {
      this.options.sendJson(res, 503, { error: "Source management service not ready" });
      return;
    }
    try {
      const raw = await this.options.readRequestBuffer(req, 1024 * 1024);
      const payload = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      const scope = this.options.requireDashboardSession(req, res, payload);
      if (this.options.sessionEnabled() && !scope) return;
      const name = typeof payload.name === "string" && payload.name.trim()
        ? payload.name.trim()
        : typeof payload.source_id === "string" && payload.source_id.trim()
          ? payload.source_id.trim()
          : "";
      if (!name) {
        this.options.sendJson(res, 400, { error: "name or source_id is required" });
        return;
      }
      if (!this.options.sessions.sourceVisibleToSession(name, scope)) {
        this.options.sendJson(res, 404, { error: "Source not found" });
        return;
      }

      const result = await stopSource({
        name,
        ...(scope ? { userId: scope.userId, sessionId: scope.sessionId } : {}),
      });
      this.options.sendJson(res, result.statusCode ?? (result.error ? 400 : 200), result);
    } catch (err) {
      this.options.sendJson(res, 400, { error: err instanceof Error ? err.message : "Invalid source stop request" });
    }
  }

  clearUploadsAndCaches(scope?: DashboardSessionScope | null): void {
    this.options.videos.clearUploadsAndCaches(scope);
  }

  deleteUploadVideo(videoId: string): boolean {
    return this.options.videos.deleteUploadVideo(videoId);
  }

  private forgetSourceOwnership(sourceId: string, scope?: DashboardSessionScope | null): void {
    this.options.sessions.forgetSourceOwnership(sourceId, scope);
  }

  private knownDashboardSourceIds(): string[] {
    const ids = new Set<string>();
    for (const source of this.options.getActiveSources()) ids.add(source.source_id);
    const snapshot = this.options.getAnalysisStatus();
    for (const sourceId of this.options.sessions.sourceOwnerIds()) ids.add(sourceId);
    for (const item of snapshot.active) ids.add(item.camera_id);
    for (const item of snapshot.recent) ids.add(item.camera_id);
    return Array.from(ids);
  }

  private dashboardSourceIdsForClear(scope: DashboardSessionScope): string[] {
    if (!this.options.sessionEnabled() || scope.isAdmin) return this.knownDashboardSourceIds();
    const ids = new Set<string>();
    for (const sourceId of this.options.sessions.sourceIdsForSession(scope.sessionId)) ids.add(sourceId);
    for (const source of this.options.getActiveSources()) {
      if (this.options.sessions.sourceVisibleToSession(source.source_id, scope)) ids.add(source.source_id);
    }
    for (const sourceId of this.options.sessions.sourceOwnerIds()) {
      if (this.options.sessions.sourceVisibleToSession(sourceId, scope)) ids.add(sourceId);
    }
    const snapshot = this.options.getAnalysisStatus();
    for (const item of [...snapshot.active, ...snapshot.recent]) {
      if (this.analysisVisibleToClearScope(item, scope)) ids.add(item.camera_id);
    }
    for (const row of this.options.store?.getRecent(undefined, 1000) ?? []) {
      if (this.options.sessions.sourceVisibleToSession(row.camera_id, scope)) ids.add(row.camera_id);
    }
    return Array.from(ids);
  }

  private analysisVisibleToClearScope(item: AnalysisStatusItem, scope: DashboardSessionScope): boolean {
    if (this.options.sessions.sourceVisibleToSession(item.camera_id, scope)) return true;
    if (item.session_id && item.user_id) return item.session_id === scope.sessionId && item.user_id === scope.userId;
    if (item.session_id) return item.session_id === scope.sessionId;
    if (item.user_id) return item.user_id === scope.userId;
    if (item.video_id.startsWith("upload/")) {
      return this.options.videos.uploadVisibleToScope(item.video_id.slice("upload/".length), scope);
    }
    return false;
  }

  private async purgeDashboardSourceState(
    sourceId: string,
    opts?: {
      scope?: DashboardSessionScope | null;
      videoId?: string;
      removeUpload?: boolean;
      purgeExternal?: boolean;
      publishRemoval?: boolean;
    },
  ): Promise<{ upload_removed?: boolean }> {
    const ownerBeforePurge = this.options.sessions.sourceOwner(sourceId);
    this.options.clearActiveStaticGap(sourceId);
    this.options.sourceStatuses.deleteOverride(sourceId);
    this.options.store?.clearCamera(sourceId);
    this.forgetSourceOwnership(sourceId, opts?.scope);
    const purgeSource = this.options.getPurgeSource();
    if (opts?.purgeExternal && purgeSource) {
      const purgeResult = await purgeSource({
        sourceId,
        ...(opts.videoId ? { videoId: opts.videoId } : {}),
        ...(opts.scope ? { sessionId: opts.scope.sessionId, userId: opts.scope.userId } : {}),
      });
      if (purgeResult.error) {
        throw new Error(purgeResult.error);
      }
    }
    const uploadRemoved = opts?.removeUpload && opts.videoId
      ? this.deleteUploadVideo(opts.videoId)
      : undefined;
    if (opts?.publishRemoval) {
      const removalEvent: MonitorEvent = {
        type: "cam:source_removed",
        timestamp: Date.now(),
        camera_id: sourceId,
        data: {
          source_id: sourceId,
          ...(opts.videoId ? { video_id: opts.videoId } : {}),
          remove_dashboard: true,
          ...(typeof uploadRemoved === "boolean" ? { upload_removed: uploadRemoved } : {}),
          ...(opts.scope
            ? { session_id: opts.scope.sessionId, user_id: opts.scope.userId }
            : ownerBeforePurge
              ? { session_id: ownerBeforePurge.sessionId, user_id: ownerBeforePurge.userId }
              : {}),
        },
      };
      this.options.publishSourceRemoval(sourceId, removalEvent);
      monitorBus.publish("cam:source_removed", {
        source_id: sourceId,
        ...(opts.videoId ? { video_id: opts.videoId } : {}),
        remove_dashboard: true,
        ...(typeof uploadRemoved === "boolean" ? { upload_removed: uploadRemoved } : {}),
        ...(opts.scope
          ? { session_id: opts.scope.sessionId, user_id: opts.scope.userId }
          : ownerBeforePurge
            ? { session_id: ownerBeforePurge.sessionId, user_id: ownerBeforePurge.userId }
            : {}),
      }, sourceId);
    }
    return typeof uploadRemoved === "boolean" ? { upload_removed: uploadRemoved } : {};
  }

  async cleanupDashboardSessions(cleanupChatRateBuckets: (now: number) => void): Promise<void> {
    await this.options.sessions.cleanupStaleSessions({
      cleanupChatRateBuckets,
      removeSource: this.options.getRemoveSource(),
      purgeSourceState: (sourceId, opts) => this.purgeDashboardSourceState(sourceId, opts),
      clearUploadsAndCaches: (scope) => this.clearUploadsAndCaches(scope),
      purgeSessionHealth: (sessionId) => this.options.purgeSessionHealth(sessionId),
    });
  }
}
