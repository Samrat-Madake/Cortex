// Lightweight HTTP + WebSocket server for the Dashboard Web UI.
// Serves static files from dashboard/dist and broadcasts monitorBus events via WS.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { monitorBus, resolveReflectWorldStateDir, subscribeRuntimeHealth } from "@reflectworld/shared";
import type { RuntimeHealthObservation, RuntimeHealthScope } from "@reflectworld/shared";
import type { FrameDetection, Segment } from "@reflectworld/shared";
import type {
  ActiveSourceStatus,
  DashboardSegmentState,
  DashboardStateEnvelope,
  MonitorEvent,
} from "@reflectworld/shared";
import type { PipelineStore } from "../store.js";
import { writeStderr } from "@reflectworld/shared";
import {
  DEFAULT_CHAT_RATE_LIMIT_PER_MIN,
  DEFAULT_MAX_FFMPEG_JOBS,
  DEFAULT_MAX_FFMPEG_QUEUE,
  DEFAULT_MAX_WS_CONNECTIONS,
  DEFAULT_PORT,
  MAX_UPLOAD_BYTES,
  envFlag,
  envInt,
  envList,
  envNonNegativeInt,
} from "./dashboard-common.js";
import { isAuthorizedInternalWebhookRequest } from "./internal-webhook-auth.js";
import type {
  DashboardAddSourceOptions,
  DashboardSecurityConfig,
  DashboardSessionConfig,
  DashboardSessionScope,
  AnalysisStatusItem,
  AnalysisStatusSnapshot,
  RuntimeConfig,
  RuntimeConfigKey,
} from "./dashboard-common.js";
import { DashboardContextBuilder } from "./dashboard-context.js";
import { FfmpegJobRunner } from "./dashboard-ffmpeg.js";
import { DashboardChatController } from "./dashboard-chat.js";
import type {
  DashboardChatCallback,
  DashboardChatRequest,
  DashboardChatResponse,
  SemanticContextCallback,
  SemanticContextRequest,
  SemanticContextResponse,
} from "./dashboard-chat.js";
import { DashboardLiveAgentController } from "./dashboard-live-agent.js";
import { DashboardLiveProxy } from "./dashboard-live-proxy.js";
import type { Go2rtcStreamHealth } from "./dashboard-live-proxy.js";
import { DashboardMemoryProxy } from "./dashboard-memory-proxy.js";
import { DashboardProxyRoutes } from "./dashboard-proxy-routes.js";
import { DashboardRuntimeConfigController } from "./dashboard-runtime-config.js";
import { DashboardRuntimeHealthRegistry, parseRuntimeHealthObservation } from "./dashboard-runtime-health.js";
import { DashboardSegmentClipService } from "./dashboard-segment-clips.js";
import { DashboardSegmentProjector } from "./dashboard-segments.js";
import { DashboardStateBus } from "./dashboard-state-bus.js";
import { DashboardSessionRoutes } from "./dashboard-session-routes.js";
import { DashboardSessionManager } from "./dashboard-sessions.js";
import { DashboardSourceActionController } from "./dashboard-source-actions.js";
import type {
  AnalyzeRequest,
  AnalyzeResponse,
  SourcePurgeRequest,
  SourcePurgeResponse,
  SourceRemoveRequest,
  SourceRemoveResponse,
  SourceStopRequest,
  SourceStopResponse,
  StreamAnalyzeRequest,
  StreamAnalyzeResponse,
} from "./dashboard-source-actions.js";
import { DashboardSourceStatusService } from "./dashboard-source-status.js";
import { DashboardVideoLibrary } from "./dashboard-videos.js";
import { DashboardVideoRoutes } from "./dashboard-video-routes.js";
import { DashboardStaticFiles } from "./dashboard-static-files.js";

export type { ActiveSourceStatus } from "@reflectworld/shared";
export type {
  AnalysisStatusItem,
  AnalysisStatusSnapshot,
  DashboardAddSourceOptions,
  DashboardSecurityConfig,
  RuntimeConfig,
  RuntimeConfigKey,
} from "./dashboard-common.js";
export type {
  DashboardChatMessage,
  DashboardChatRequest,
  DashboardChatResponse,
  DashboardChatStreamEvent,
  SemanticContextRequest,
  SemanticContextResponse,
} from "./dashboard-chat.js";
export type {
  AnalyzeRequest,
  AnalyzeResponse,
  SourcePurgeRequest,
  SourcePurgeResponse,
  SourceRemoveRequest,
  SourceRemoveResponse,
  SourceStopRequest,
  SourceStopResponse,
  StreamAnalyzeRequest,
  StreamAnalyzeResponse,
} from "./dashboard-source-actions.js";

export interface DashboardServerOptions {
  distDir: string;
  port?: number;
  /** Per-instance mutable state dir. Media files are served from stateDir/media/. */
  stateDir?: string;
  reflectworldEndpoint?: string;
  /** Shared secret for local service-to-Dashboard webhooks. */
  internalWebhookToken?: string;
  store?: PipelineStore;
  /** Recordings directory (e.g. ~/.reflectworld/recordings). Required for segment clip serving. */
  recordingsDir?: string;
  /** Directories containing generated media thumbnails/gifs. */
  mediaDirs?: string[];
  /** Path to ffmpeg binary. Defaults to "ffmpeg". */
  ffmpegBin?: string;
  /** Path to ffprobe binary for video metadata. Defaults to "ffprobe". */
  ffprobeBin?: string;
  /** Optional callback to register a camera source. Returns the cam add_source result JSON. */
  addSource?: (source: string, name?: string, opts?: DashboardAddSourceOptions) => Promise<string>;
  /** Optional Dashboard-only callback to stop and remove a source. */
  removeSource?: (req: SourceRemoveRequest) => Promise<SourceRemoveResponse>;
  /** Optional Dashboard-only callback to stop a source watch while preserving data. */
  stopSource?: (req: SourceStopRequest) => Promise<SourceStopResponse>;
  /** Optional callback to purge source-scoped long-term memory/ReID state. */
  purgeSource?: (req: SourcePurgeRequest) => Promise<SourcePurgeResponse>;
  /** Optional Dashboard-only callback to hydrate currently active live watches. */
  getActiveSources?: () => ActiveSourceStatus[];
  /** Directory for uploaded videos. Defaults to ~/.reflectworld/uploads. */
  uploadsDir?: string;
  /** Read-only legacy upload directories to include when listing/resolving uploads. */
  legacyUploadsDirs?: string[];
  /** Directory containing bundled demo/fixture videos. */
  fixtureVideosDir?: string;
  /** Shared preview cache for bundled/public fixture videos. Defaults to env when set. */
  fixturePreviewCacheDir?: string;
  /** Optional callback that performs add_source + watch analysis orchestration. */
  analyze?: (req: AnalyzeRequest) => Promise<AnalyzeResponse>;
  /** Optional Dashboard-only callback to register/start a live stream watch. */
  streamAnalyze?: (req: StreamAnalyzeRequest) => Promise<StreamAnalyzeResponse>;
  /** Optional callback that returns analysis lifecycle state for dashboard hydration. */
  getAnalysisStatus?: () => AnalysisStatusSnapshot;
  /** Optional callback to stop active analyses / clear runtime state before data wipe. */
  clearDashboardData?: (scope?: DashboardSessionScope | null) => Promise<void>;
  /** Optional lightweight Dashboard chat responder. */
  dashboardChat?: (req: DashboardChatRequest) => Promise<DashboardChatResponse>;
  /** Optional Dashboard-only semantic context reader. */
  getSemanticContext?: (req: SemanticContextRequest) => Promise<SemanticContextResponse>;
  /** go2rtc HTTP API port for the dashboard iframe player. Accepts string for plugin config compat. */
  go2rtcApiPort?: number | string;
  /** Optional shared-dashboard multi-user admission/capacity config. Defaults to env/off. */
  dashboardSessions?: Partial<DashboardSessionConfig>;
  /** Public/multi-user hardening knobs. Defaults to env and only applies when multi-user or public mode is enabled. */
  dashboardSecurity?: Partial<DashboardSecurityConfig>;
  /** Reserved for attached CLI mode; standalone Dashboard mode creates its own server. */
  existingServer?: Server;
  /** Reserved for attached CLI mode; standalone Dashboard mode creates its own server. */
  registerHandler?: (
    handler: (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>,
  ) => void;
}

export class DashboardServer {
  private server: Server | null = null;
  private ownsServer = false;
  private upgradeHandler: ((req: IncomingMessage, socket: Duplex, head: Buffer) => void) | null = null;
  private wss: WebSocketServer | null = null;
  private dashboardWss: WebSocketServer | null = null;
  private liveAgentWss: WebSocketServer | null = null;
  private readonly monitorListener: (event: MonitorEvent) => void;
  private readonly dashboardState: DashboardStateBus;
  private readonly runtimeHealth: DashboardRuntimeHealthRegistry;
  private unsubscribeRuntimeHealth: (() => void) | null = null;
  private readonly runtimeHealthEpoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  private runtimeHealthSequence = 0;
  readonly port: number;
  private readonly opts: DashboardServerOptions;
  private readonly stateDir: string;
  private readonly distDir: string;
  private readonly reflectworldEndpoint: string;
  private readonly internalWebhookToken: string | undefined;
  private readonly store: PipelineStore | null;
  private readonly recordingsDir: string | null;
  private readonly mediaDirs: string[];
  private readonly staticFiles: DashboardStaticFiles;
  private readonly ffmpegJobs: FfmpegJobRunner;
  private readonly runtimeConfig: DashboardRuntimeConfigController;
  private readonly contexts: DashboardContextBuilder;
  private readonly addSource: ((source: string, name?: string, opts?: DashboardAddSourceOptions) => Promise<string>) | null;
  private removeSource: ((req: SourceRemoveRequest) => Promise<SourceRemoveResponse>) | null;
  private stopSource: ((req: SourceStopRequest) => Promise<SourceStopResponse>) | null;
  private purgeSource: ((req: SourcePurgeRequest) => Promise<SourcePurgeResponse>) | null;
  private getActiveSources: (() => ActiveSourceStatus[]) | null;
  private readonly uploadsDir: string;
  private readonly uploadSearchDirs: string[];
  private readonly fixtureVideosDir: string | null;
  private readonly videos: DashboardVideoLibrary;
  private readonly videoRoutes: DashboardVideoRoutes;
  private analyze: ((req: AnalyzeRequest) => Promise<AnalyzeResponse>) | null;
  private streamAnalyze: ((req: StreamAnalyzeRequest) => Promise<StreamAnalyzeResponse>) | null;
  private getAnalysisStatus: (() => AnalysisStatusSnapshot) | null;
  private clearDashboardData: ((scope?: DashboardSessionScope | null) => Promise<void>) | null;
  private dashboardChat: DashboardChatCallback | null;
  private getSemanticContext: SemanticContextCallback | null;
  private readonly go2rtcApiPort: number;
  private readonly chatController: DashboardChatController;
  private readonly liveAgentController: DashboardLiveAgentController;
  private readonly liveProxy: DashboardLiveProxy;
  private readonly memoryProxy: DashboardMemoryProxy;
  private readonly proxyRoutes: DashboardProxyRoutes;
  private readonly segmentClips: DashboardSegmentClipService;
  private readonly segments: DashboardSegmentProjector;
  private readonly sourceStatuses: DashboardSourceStatusService;
  private readonly sourceActions: DashboardSourceActionController;
  private readonly sessionRoutes: DashboardSessionRoutes;
  private readonly sessionConfig: DashboardSessionConfig;
  private readonly publicMode: boolean;
  private readonly dashboardSecurityStrict: boolean;
  private readonly wsAllowedOrigins: Set<string>;
  private readonly maxWsConnections: number;
  private readonly chatRateLimitPerMinute: number;
  private readonly chatRateBuckets = new Map<string, { windowStart: number; count: number }>();
  private readonly sessions: DashboardSessionManager;
  private sessionCleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: DashboardServerOptions) {
    this.opts = opts;
    this.stateDir = opts.stateDir ?? resolveReflectWorldStateDir();
    this.distDir = opts.distDir;
    this.port = opts.port ?? DEFAULT_PORT;
    this.addSource = opts.addSource ?? null;
    this.removeSource = opts.removeSource ?? null;
    this.stopSource = opts.stopSource ?? null;
    this.purgeSource = opts.purgeSource ?? null;
    this.getActiveSources = opts.getActiveSources ?? null;
    this.reflectworldEndpoint = opts.reflectworldEndpoint ?? "http://127.0.0.1:8219";
    this.internalWebhookToken = opts.internalWebhookToken?.trim() || undefined;
    this.recordingsDir = opts.recordingsDir ?? null;
    this.mediaDirs = opts.mediaDirs ?? [join(this.stateDir, "media")];
    const ffmpegBin = opts.ffmpegBin ?? "ffmpeg";
    this.ffmpegJobs = new FfmpegJobRunner({
      ffmpegBin,
      maxJobs: envInt("DASHBOARD_MAX_FFMPEG_JOBS", DEFAULT_MAX_FFMPEG_JOBS),
      maxQueue: envNonNegativeInt("DASHBOARD_MAX_FFMPEG_QUEUE", DEFAULT_MAX_FFMPEG_QUEUE),
    });
    this.store = opts.store ?? null;
    this.uploadsDir = opts.uploadsDir ?? join(this.stateDir, "uploads");
    this.uploadSearchDirs = [
      this.uploadsDir,
      ...(opts.legacyUploadsDirs ?? []),
    ].map((dir) => resolve(dir)).filter((dir, index, dirs) => dirs.indexOf(dir) === index);
    this.fixtureVideosDir = opts.fixtureVideosDir ?? null;
    this.videos = new DashboardVideoLibrary({
      uploadsDir: this.uploadsDir,
      uploadSearchDirs: this.uploadSearchDirs,
      fixtureVideosDir: this.fixtureVideosDir,
      sessionEnabled: () => this.sessionConfig.enabled,
      ffprobeBin: opts.ffprobeBin ?? "ffprobe",
    });
    this.videoRoutes = new DashboardVideoRoutes({
      uploadsDir: this.uploadsDir,
      fixturePreviewCacheDir: opts.fixturePreviewCacheDir ?? process.env.REFLECTWORLD_DASHBOARD_FIXTURE_PREVIEW_CACHE_DIR ?? null,
      videos: this.videos,
      sessionEnabled: () => this.sessionConfig.enabled,
      scopeFromRequest: (req, body, url) => this.scopeFromRequest(req, body, url),
      requireDashboardSession: (req, res, body, url) => this.requireDashboardSession(req, res, body, url),
      enforceSourceLimit: (scope) => this.enforceSourceLimit(scope),
      sendJson: (res, status, body) => this.sendJson(res, status, body),
      readRequestBuffer: (req, maxBytes) => this.readRequestBuffer(req, maxBytes),
      runFfmpegToFile: (args, outputPath, label, res) => this.runFfmpegToFile(args, outputPath, label, res),
    });
    this.analyze = opts.analyze ?? null;
    this.streamAnalyze = opts.streamAnalyze ?? null;
    this.getAnalysisStatus = opts.getAnalysisStatus ?? null;
    this.clearDashboardData = opts.clearDashboardData ?? null;
    this.dashboardChat = opts.dashboardChat ?? null;
    this.getSemanticContext = opts.getSemanticContext ?? null;
    this.go2rtcApiPort = typeof opts.go2rtcApiPort === 'number'
      ? opts.go2rtcApiPort
      : typeof opts.go2rtcApiPort === 'string'
        ? parseInt(opts.go2rtcApiPort, 10) || 1984
        : parseInt(process.env.GO2RTC_API_PORT ?? process.env.REFLECTWORLD_DEMO_GO2RTC_API_PORT ?? "1984", 10);
    this.publicMode = opts.dashboardSecurity?.publicMode ?? envFlag("REFLECTWORLD_PUBLIC_MODE", false);
    this.sessionConfig = {
      enabled: opts.dashboardSessions?.enabled ?? (envFlag("DASHBOARD_MULTI_USER", false) || this.publicMode),
      maxActiveSessions: opts.dashboardSessions?.maxActiveSessions ?? envInt("DASHBOARD_MAX_ACTIVE_SESSIONS", 5),
      staleTtlMs: opts.dashboardSessions?.staleTtlMs ?? envInt("DASHBOARD_SESSION_TTL_MIN", 15) * 60_000,
      stopGraceMs: opts.dashboardSessions?.stopGraceMs ?? envInt("DASHBOARD_SESSION_STOP_GRACE_MIN", 5) * 60_000,
      hardCleanupMs: opts.dashboardSessions?.hardCleanupMs ?? envInt("DASHBOARD_SESSION_HARD_CLEANUP_MIN", 60) * 60_000,
      maxSourcesPerSession: opts.dashboardSessions?.maxSourcesPerSession ?? envInt("DASHBOARD_MAX_SOURCES_PER_SESSION", 2),
      adminToken: opts.dashboardSessions?.adminToken ?? process.env.DASHBOARD_ADMIN_TOKEN,
    };
    this.dashboardSecurityStrict = this.sessionConfig.enabled || this.publicMode;
    this.wsAllowedOrigins = new Set(
      (opts.dashboardSecurity?.wsAllowedOrigins ?? envList("DASHBOARD_WS_ALLOWED_ORIGINS"))
        .map((origin) => this.normalizeAllowedOrigin(origin))
        .filter((origin): origin is string => !!origin),
    );
    this.maxWsConnections = opts.dashboardSecurity?.maxWsConnections ?? envNonNegativeInt("DASHBOARD_MAX_WS_CONNECTIONS", DEFAULT_MAX_WS_CONNECTIONS);
    this.chatRateLimitPerMinute = opts.dashboardSecurity?.chatRateLimitPerMinute ?? envNonNegativeInt("DASHBOARD_CHAT_RATE_LIMIT_PER_MIN", DEFAULT_CHAT_RATE_LIMIT_PER_MIN);
    this.runtimeHealth = new DashboardRuntimeHealthRegistry({
      publish: (event) => { this.forwardDashboardMonitorEvent(event); },
    });
    this.sessions = new DashboardSessionManager({
      config: this.sessionConfig,
      getActiveSources: () => this.getActiveSources?.() ?? [],
      onSessionStarted: (sessionId) => this.runtimeHealth.activateSession(sessionId),
    });
    this.sessionRoutes = new DashboardSessionRoutes({
      config: this.sessionConfig,
      sessions: this.sessions,
      sendJson: (res, status, body) => this.sendJson(res, status, body),
      readRequestBuffer: (req, maxBytes) => this.readRequestBuffer(req, maxBytes),
    });
    this.staticFiles = new DashboardStaticFiles({
      distDir: this.distDir,
      mediaDirs: this.mediaDirs,
      scopeFromRequest: (req, body, url) => this.scopeFromRequest(req, body, url),
      sourceVisibleToSession: (sourceId, scope) => this.sourceVisibleToSession(sourceId, scope),
    });
    this.liveProxy = new DashboardLiveProxy({
      go2rtcApiPort: this.go2rtcApiPort,
      scopeFromRequest: (req, body, url) => this.scopeFromRequest(req, body, url),
      sourceVisibleToSession: (sourceId, scope) => this.sourceVisibleToSession(sourceId, scope),
      sendJson: (res, status, body) => this.sendJson(res, status, body),
    });
    this.sourceStatuses = new DashboardSourceStatusService({
      sessionEnabled: () => this.sessionConfig.enabled,
      getActiveSources: () => this.getActiveSources?.() ?? [],
      getAnalysisStatus: () => this.getAnalysisStatus?.() ?? { active: [], recent: [] },
      sourceVisibleToSession: (sourceId, scope) => this.sourceVisibleToSession(sourceId, scope),
      getGo2rtcStreams: () => this.getGo2rtcStreams(),
      readGo2rtcStreamHealth: (streams, sourceId) => this.readGo2rtcStreamHealth(streams, sourceId),
      store: this.store,
      uploadsDir: this.uploadsDir,
      fixtureVideosDir: this.fixtureVideosDir,
    });
    this.segments = new DashboardSegmentProjector({
      store: this.store,
      stateDir: this.stateDir,
      sessionEnabled: () => this.sessionConfig.enabled,
      getAnalysisStatus: () => this.getAnalysisStatus?.() ?? { active: [], recent: [] },
      sourceVisibleToSession: (sourceId, scope) => this.sourceVisibleToSession(sourceId, scope),
      visibleSourceStatusesSync: (scope) => this.sourceStatuses.visibleSourceStatusesSync(scope),
      sourceLabel: (source) => this.sourceStatuses.sourceLabel(source),
      broadcastEnvelope: (envelope) => this.broadcastDashboardEnvelope(envelope),
      nextDashboardVersion: () => this.nextDashboardVersion(),
    });
    this.dashboardState = new DashboardStateBus({
      sessions: this.sessions,
      segments: this.segments,
      sourceStatuses: this.sourceStatuses,
      getDashboardWss: () => this.dashboardWss,
      getGo2rtcStreams: () => this.getGo2rtcStreams(),
    });
    this.sourceActions = new DashboardSourceActionController({
      sessionEnabled: () => this.sessionConfig.enabled,
      getAddSource: () => this.addSource,
      getAnalyze: () => this.analyze,
      getStreamAnalyze: () => this.streamAnalyze,
      getRemoveSource: () => this.removeSource,
      getStopSource: () => this.stopSource,
      getPurgeSource: () => this.purgeSource,
      getActiveSources: () => this.getActiveSources?.() ?? [],
      getAnalysisStatus: () => this.getAnalysisStatus?.() ?? { active: [], recent: [] },
      getClearDashboardData: () => this.clearDashboardData,
      store: this.store,
      videos: this.videos,
      sessions: this.sessions,
      sourceStatuses: this.sourceStatuses,
      clearActiveStaticGap: (sourceId) => this.segments.clearActiveStaticGap(sourceId),
      publishSourceState: (sourceId) => this.publishDashboardSourceState(sourceId),
      publishSourceRemoval: (sourceId, event) => this.publishDashboardSourceRemoval(sourceId, event),
      purgeSessionHealth: (sessionId) => this.runtimeHealth.purgeSession(sessionId),
      requireDashboardSession: (req, res, body, url) => this.requireDashboardSession(req, res, body, url),
      sendJson: (res, status, body) => this.sendJson(res, status, body),
      readRequestBuffer: (req, maxBytes) => this.readRequestBuffer(req, maxBytes),
    });
    this.memoryProxy = new DashboardMemoryProxy({
      reflectworldEndpoint: this.reflectworldEndpoint,
      buildEntityRefMap: (limit, cameraId, scope) => this.segments.buildEntityRefMap(limit, cameraId, scope),
    });
    this.proxyRoutes = new DashboardProxyRoutes({
      reflectworldEndpoint: this.reflectworldEndpoint,
      internalWebhookToken: this.internalWebhookToken,
      requireInternalWebhookToken: this.dashboardSecurityStrict,
      sessionEnabled: () => this.sessionConfig.enabled,
      memoryProxy: this.memoryProxy,
      requireDashboardSession: (req, res, body, url) => this.requireDashboardSession(req, res, body, url),
      sendJson: (res, status, body) => this.sendJson(res, status, body),
      readRequestBuffer: (req, maxBytes) => this.readRequestBuffer(req, maxBytes),
    });
    this.segmentClips = new DashboardSegmentClipService({
      store: this.store,
      recordingsDir: this.recordingsDir,
      uploadsDir: this.uploadsDir,
      scopeFromRequest: (req, body, url) => this.scopeFromRequest(req, body, url),
      sourceVisibleToSession: (sourceId, scope) => this.sourceVisibleToSession(sourceId, scope),
      sourceLabels: (scope) => this.segments.sourceLabels(scope),
      readSourceConfig: (cameraId) => this.segments.readSourceConfig(cameraId),
      runFfmpegToFile: (args, outputPath, label, res) => this.runFfmpegToFile(args, outputPath, label, res),
    });
    this.contexts = new DashboardContextBuilder({
      store: this.store,
      sessionEnabled: () => this.sessionConfig.enabled,
      getActiveSources: () => this.getActiveSources?.() ?? [],
      getAnalysisStatus: () => this.getAnalysisStatus?.() ?? { active: [], recent: [] },
      sourceVisibleToSession: (sourceId, scope) => this.sourceVisibleToSession(sourceId, scope),
    });
    this.chatController = new DashboardChatController({
      sessionEnabled: () => this.sessionConfig.enabled,
      getDashboardChat: () => this.dashboardChat,
      getSemanticContext: () => this.getSemanticContext,
      requireDashboardSession: (req, res, body, url) => this.requireDashboardSession(req, res, body, url),
      scopeFromRequest: (req, body, url) => this.scopeFromRequest(req, body, url),
      sourceVisibleToSession: (sourceId, scope) => this.sourceVisibleToSession(sourceId, scope),
      consumeChatRateLimit: (req, scope) => this.consumeChatRateLimit(req, scope),
      sendJson: (res, status, body) => this.sendJson(res, status, body),
      readRequestBuffer: (req, maxBytes) => this.readRequestBuffer(req, maxBytes),
      buildDashboardChatContext: (cameraId, limit, scope) => this.contexts.buildChatContext(cameraId, limit, scope),
      buildDashboardRuntimeContext: (cameraId, scope) => this.contexts.buildRuntimeContext(cameraId, scope),
    });
    this.liveAgentController = new DashboardLiveAgentController({
      sessionEnabled: () => this.sessionConfig.enabled,
      getDashboardChat: () => this.dashboardChat,
      scopeFromRequest: (req, body, url) => this.scopeFromRequest(req, body, url),
      sourceVisibleToSession: (sourceId, scope) => this.sourceVisibleToSession(sourceId, scope),
      consumeChatRateLimit: (req, scope) => this.consumeChatRateLimit(req, scope),
      sendJson: (res, status, body) => this.sendJson(res, status, body),
      buildDashboardChatContext: (cameraId, limit, scope) => this.contexts.buildChatContext(cameraId, limit, scope),
      buildDashboardRuntimeContext: (cameraId, scope) => this.contexts.buildRuntimeContext(cameraId, scope),
    });
    this.runtimeConfig = new DashboardRuntimeConfigController({
      sessionEnabled: () => this.sessionConfig.enabled,
      requireDashboardSession: (req, res, body, url) => this.requireDashboardSession(req, res, body, url),
      sendJson: (res, status, body) => this.sendJson(res, status, body),
      readRequestBuffer: (req, maxBytes) => this.readRequestBuffer(req, maxBytes),
    });
    this.monitorListener = (event: MonitorEvent) => {
      if (!this.forwardDashboardMonitorEvent(event)) return;
      try {
        this.observeOperationalMonitorEvent(event);
      } catch {
        // Runtime monitoring must not affect monitor event producers.
      }
    };
  }

  private forwardDashboardMonitorEvent(event: MonitorEvent): boolean {
    const wss = this.wss;
    if (!wss) return false;
    const msg = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      const scope = (client as WebSocket & { dashboardSession?: DashboardSessionScope }).dashboardSession;
      if (this.eventVisibleToSession(event, scope)) client.send(msg);
    }
    void this.projectRawMonitorEvent(event).catch(() => {
      // Dashboard projection failures must not escape into event producers.
    });
    return true;
  }

  private observeOperationalMonitorEvent(event: MonitorEvent): void {
    const sourceId = typeof event.data.source_id === "string" ? event.data.source_id : event.camera_id;
    if ((event.type === "cam:source_added" || event.type === "cam:watch_started") && sourceId) {
      this.runtimeHealth.activateSource(sourceId);
      if (event.type === "cam:source_added") return;
    }
    if (event.type === "cam:source_removed" && sourceId) {
      this.runtimeHealth.purgeSource(sourceId, event.timestamp);
      return;
    }
    if (event.type === "cam:watch_stopped" && sourceId) {
      this.runtimeHealth.deactivateSource(sourceId, event.timestamp);
      return;
    }
    const status = event.type === "cam:first_frame"
      ? "ok"
      : event.type === "cam:source_reconnecting"
        ? "degraded"
        : event.type === "cam:source_unavailable"
          ? "down"
          : null;
    if (!status || !sourceId) return;
    const observation: RuntimeHealthObservation = {
      producer: "dashboard-source-events",
      producer_epoch: this.runtimeHealthEpoch,
      sequence: ++this.runtimeHealthSequence,
      component: "source",
      operation: "stream",
      status,
      observed_at: event.timestamp,
      scope: { source_id: sourceId },
      ...(status === "down" ? { code: "stream_unavailable" } : {}),
    };
    this.runtimeHealth.observe(observation);
  }

  private scopeFromRequest(req: IncomingMessage, body?: Record<string, unknown>, url?: URL): DashboardSessionScope | null {
    return this.sessions.scopeFromRequest(req, body, url);
  }

  private runtimeHealthVisibleToSession(healthScope: RuntimeHealthScope | undefined, scope: DashboardSessionScope | null): boolean {
    if (!this.sessionConfig.enabled) return true;
    if (!scope) return false;
    if (scope.isAdmin) return true;
    if (healthScope?.user_id && healthScope.user_id !== scope.userId) return false;
    if (healthScope?.session_id && healthScope.session_id !== scope.sessionId) return false;
    if (healthScope?.source_id && !this.sourceVisibleToSession(healthScope.source_id, scope)) return false;
    return Boolean(healthScope?.user_id || healthScope?.session_id || healthScope?.source_id) || !healthScope;
  }

  private requireDashboardSession(req: IncomingMessage, res: ServerResponse, body?: Record<string, unknown>, url?: URL): DashboardSessionScope | null {
    if (!this.sessionConfig.enabled) return null;
    const scope = this.scopeFromRequest(req, body, url);
    if (!scope) this.sendJson(res, 401, { error: "Dashboard session is required" });
    return scope;
  }

  private normalizeAllowedOrigin(origin: string): string | null {
    const trimmed = origin.trim();
    if (!trimmed) return null;
    if (trimmed === "*") return "*";
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      return null;
    }
  }

  private requestOriginAllowed(req: IncomingMessage): boolean {
    if (!this.dashboardSecurityStrict) return true;
    const origin = typeof req.headers.origin === "string" ? this.normalizeAllowedOrigin(req.headers.origin) : null;
    if (!origin) return true;
    if (this.wsAllowedOrigins.has("*") || this.wsAllowedOrigins.has(origin)) return true;
    const host = typeof req.headers.host === "string" ? req.headers.host.toLowerCase() : "";
    try {
      const parsed = new URL(origin);
      return !!host && parsed.host.toLowerCase() === host;
    } catch {
      return false;
    }
  }

  private currentWsConnections(): number {
    return (this.wss?.clients.size ?? 0)
      + (this.dashboardWss?.clients.size ?? 0)
      + (this.liveAgentWss?.clients.size ?? 0);
  }

  private writeUpgradeError(socket: Duplex, statusCode: number, message: string): void {
    socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  private chatRateLimitKey(req: IncomingMessage, scope: DashboardSessionScope | null): string {
    if (scope) return `session:${scope.sessionId}`;
    return `ip:${req.socket.remoteAddress ?? "unknown"}`;
  }

  private consumeChatRateLimit(req: IncomingMessage, scope: DashboardSessionScope | null): { ok: true } | { ok: false; retryAfterSec: number } {
    if (!this.dashboardSecurityStrict || this.chatRateLimitPerMinute <= 0) return { ok: true };
    const now = Date.now();
    const windowMs = 60_000;
    const key = this.chatRateLimitKey(req, scope);
    const bucket = this.chatRateBuckets.get(key);
    if (!bucket || now - bucket.windowStart >= windowMs) {
      this.chatRateBuckets.set(key, { windowStart: now, count: 1 });
      return { ok: true };
    }
    if (bucket.count >= this.chatRateLimitPerMinute) {
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((bucket.windowStart + windowMs - now) / 1000)) };
    }
    bucket.count += 1;
    return { ok: true };
  }

  private cleanupChatRateBuckets(now = Date.now()): void {
    const windowMs = 60_000;
    for (const [key, bucket] of this.chatRateBuckets) {
      if (bucket.windowStart + windowMs < now) this.chatRateBuckets.delete(key);
    }
  }

  private sourceVisibleToSession(sourceId: string, scope?: DashboardSessionScope | null): boolean {
    return this.sessions.sourceVisibleToSession(sourceId, scope);
  }

  private eventVisibleToSession(event: MonitorEvent, scope?: DashboardSessionScope | null): boolean {
    return this.sessions.eventVisibleToSession(event, scope);
  }

  private nextDashboardVersion(): number {
    return this.dashboardState.nextVersion();
  }

  private dashboardReplayEnvelopes(cursor: number): DashboardStateEnvelope[] {
    return this.dashboardState.replayEnvelopes(cursor);
  }

  private dashboardEnvelopeVisibleToSession(envelope: DashboardStateEnvelope, scope?: DashboardSessionScope | null): boolean {
    return this.dashboardState.envelopeVisibleToSession(envelope, scope);
  }

  private sourceStatusEnvelope(source: ActiveSourceStatus, version: number): DashboardStateEnvelope {
    return this.dashboardState.sourceStatusEnvelope(source, version);
  }

  private broadcastDashboardEnvelope(envelope: DashboardStateEnvelope): void {
    this.dashboardState.broadcastEnvelope(envelope);
  }

  private publishDashboardSourceRemoval(sourceId: string, event: MonitorEvent): void {
    this.dashboardState.publishSourceRemoval(sourceId, event);
  }

  private async publishDashboardSourceState(sourceId: string, event?: MonitorEvent): Promise<void> {
    await this.dashboardState.publishSourceState(sourceId, event);
  }

  private async projectRawMonitorEvent(event: MonitorEvent): Promise<void> {
    await this.dashboardState.projectRawMonitorEvent(event);
  }

  private enforceSourceLimit(scope: DashboardSessionScope | null): { ok: true } | { ok: false; status: number; body: Record<string, unknown> } {
    return this.sessions.enforceSourceLimit(scope);
  }

  private get partialSegmentStates(): Map<string, DashboardSegmentState> {
    return this.segments.getPartialSegmentStates();
  }

  private buildDashboardSegments(limit: number, cameraId?: string, scope?: DashboardSessionScope | null): DashboardSegmentState[] {
    return this.segments.buildDashboardSegments(limit, cameraId, scope);
  }

  private enrichSourceStatus(
    source: ActiveSourceStatus,
    streams: Record<string, unknown> | null,
    analysis?: AnalysisStatusItem,
  ): ActiveSourceStatus {
    return this.sourceStatuses.enrichSourceStatus(source, streams, analysis);
  }

  async start(): Promise<void> {
    if (this.server) return;
    if (this.sessionConfig.enabled && !this.sessionCleanupTimer) {
      this.sessionCleanupTimer = setInterval(() => {
        void this.sourceActions.cleanupDashboardSessions((now) => this.cleanupChatRateBuckets(now));
      }, 60_000);
      this.sessionCleanupTimer.unref?.();
    }

    const hasIndex = this.staticFiles.hasIndex();

    const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const url = new URL(req.url ?? "/", "http://localhost");

      // Serve keyframe images from local media dir
      if (this.staticFiles.handleMedia(req, res, url)) {
        return;
      }

      if (url.pathname.startsWith("/api/") && req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }

      if (url.pathname === "/api/dashboard/session/start" && req.method === "POST") {
        await this.sessionRoutes.handleStart(req, res);
        return;
      }

      if (url.pathname === "/api/dashboard/session/heartbeat" && req.method === "POST") {
        await this.sessionRoutes.handleHeartbeat(req, res);
        return;
      }

      if (url.pathname === "/api/dashboard/session/end" && req.method === "POST") {
        await this.sessionRoutes.handleEnd(req, res);
        return;
      }

      // GET /api/videos — list uploaded and bundled demo videos.
      if (url.pathname === "/api/videos" && req.method === "GET") {
        const scope = this.scopeFromRequest(req, undefined, url);
        this.videoRoutes.handleList(res, scope);
        return;
      }

      // GET /api/dashboard/runtime — small public runtime facts needed by UI.
      if (url.pathname === "/api/dashboard/runtime" && req.method === "GET") {
        this.sendJson(res, 200, {
          go2rtc_api_port: this.go2rtcApiPort,
          multi_user: this.sessionConfig.enabled,
          max_active_sessions: this.sessionConfig.maxActiveSessions,
          max_sources_per_session: this.sessionConfig.maxSourcesPerSession,
        });
        return;
      }

      // GET /api/live/stream.mp4?src=cam — same-origin proxy for go2rtc fragmented MP4.
      if (url.pathname === "/api/live/stream.mp4" && req.method === "GET") {
        await this.handleLiveStreamProxy(req, res, url, "mp4");
        return;
      }

      // GET /api/live/stream.mjpeg?src=cam — same-origin proxy for go2rtc MJPEG.
      if (url.pathname === "/api/live/stream.mjpeg" && req.method === "GET") {
        await this.handleLiveStreamProxy(req, res, url, "mjpeg");
        return;
      }

      // GET /api/live/status?src=cam — lightweight stream health without opening a frame consumer.
      if (url.pathname === "/api/live/status" && req.method === "GET") {
        await this.handleLiveStatus(req, res, url);
        return;
      }

      // GET /api/live/frame.jpeg?src=cam — same-origin single-frame preview proxy.
      if (url.pathname === "/api/live/frame.jpeg" && req.method === "GET") {
        await this.handleLiveFrameProxy(req, res, url);
        return;
      }

      // GET/HEAD /api/videos/file?video_id=upload/foo.mp4 — browser preview for selected videos.
      if (url.pathname === "/api/videos/file" && (req.method === "GET" || req.method === "HEAD")) {
        await this.videoRoutes.handleFile(req, res, url);
        return;
      }

      // GET/HEAD /api/videos/preview?video_id=upload/foo.mp4 — browser-safe H.264 preview.
      if (url.pathname === "/api/videos/preview" && (req.method === "GET" || req.method === "HEAD")) {
        await this.videoRoutes.handlePreview(req, res, url);
        return;
      }

      // GET/HEAD /api/videos/thumbnail?video_id=upload/foo.mp4 — fast JPEG thumbnail for video pickers.
      if (url.pathname === "/api/videos/thumbnail" && (req.method === "GET" || req.method === "HEAD")) {
        await this.videoRoutes.handleThumbnail(req, res, url);
        return;
      }

      // POST /api/videos/upload — upload one local video file.
      if (url.pathname === "/api/videos/upload" && req.method === "POST") {
        await this.videoRoutes.handleUpload(req, res, url);
        return;
      }

      // POST /api/videos/delete — delete one uploaded video file and its preview cache.
      if (url.pathname === "/api/videos/delete" && req.method === "POST") {
        await this.videoRoutes.handleDelete(req, res, url);
        return;
      }

      // POST /api/analyze — add source + start watch for a selected video.
      if (url.pathname === "/api/analyze" && req.method === "POST") {
        await this.sourceActions.handleAnalyze(req, res);
        return;
      }

      // POST /api/streams/analyze — Dashboard-only add_source + watch wrapper.
      if (url.pathname === "/api/streams/analyze" && req.method === "POST") {
        await this.sourceActions.handleStreamAnalyze(req, res);
        return;
      }

      // GET /api/semantic-context?camera_id=xxx — read current Semantic Context for a Dashboard source.
      if (url.pathname === "/api/semantic-context" && req.method === "GET") {
        await this.chatController.handleSemanticContext(req, res, url);
        return;
      }

      // GET /api/analysis/status — active + recently completed dashboard video analyses.
      if (url.pathname === "/api/analysis/status" && req.method === "GET") {
        const scope = this.sessionConfig.enabled
          ? this.requireDashboardSession(req, res, undefined, url)
          : this.scopeFromRequest(req, undefined, url);
        if (this.sessionConfig.enabled && !scope) return;
        const snapshot = this.getAnalysisStatus?.() ?? { active: [], recent: [] };
        this.sendJson(res, 200, {
          active: snapshot.active.filter((item) => this.sourceVisibleToSession(item.camera_id, scope)),
          recent: snapshot.recent.filter((item) => this.sourceVisibleToSession(item.camera_id, scope)),
        });
        return;
      }

      // GET /api/dashboard/state — canonical Dashboard snapshot / hydration.
      if (url.pathname === "/api/dashboard/state" && req.method === "GET") {
        const scope = this.sessionConfig.enabled
          ? this.requireDashboardSession(req, res, undefined, url)
          : this.scopeFromRequest(req, undefined, url);
        if (this.sessionConfig.enabled && !scope) return;
        const cursor = this.dashboardState.version;
        const sources = await this.sourceStatuses.visibleSourceStatuses(scope);
        const segments = this.segments.buildDashboardSegments(100, undefined, scope);
        let runtimeHealth = { component_statuses: [], recent_operation_errors: [] } as ReturnType<DashboardRuntimeHealthRegistry["snapshot"]>;
        try {
          runtimeHealth = this.runtimeHealth.snapshot((healthScope) => this.runtimeHealthVisibleToSession(healthScope, scope));
        } catch {
          // Dashboard state remains available if observability state is damaged.
        }
        this.sendJson(res, 200, {
          cursor,
          server_time: Date.now(),
          sources,
          segments,
          ...runtimeHealth,
        });
        return;
      }

      // GET /api/sources — all dashboard-manageable live sources for hydration.
      if (url.pathname === "/api/sources" && req.method === "GET") {
        const scope = this.scopeFromRequest(req, undefined, url);
        const sources = await this.sourceStatuses.visibleSourceStatuses(scope);
        this.sendJson(res, 200, { sources });
        return;
      }

      // GET /api/sources/active — active live watches only.
      if (url.pathname === "/api/sources/active" && req.method === "GET") {
        const scope = this.scopeFromRequest(req, undefined, url);
        const sources = (await this.sourceStatuses.visibleSourceStatuses(scope)).filter((source) => source.status === "active");
        this.sendJson(res, 200, { sources });
        return;
      }

      // POST /api/dashboard/clear — clear uploaded videos and dashboard-visible analysis data.
      if (url.pathname === "/api/dashboard/clear" && req.method === "POST") {
        const raw = await this.readRequestBuffer(req, 1024 * 1024);
        const body = raw.length > 0 ? JSON.parse(raw.toString("utf8")) as Record<string, unknown> : {};
        const scope = this.requireDashboardSession(req, res, body, url);
        if (this.sessionConfig.enabled && !scope) return;
        await this.sourceActions.handleDashboardClear(res, scope);
        return;
      }

      // GET /api/segments/recent?limit=30&camera_id=video-xxx — hydrate active video analysis.
      if (url.pathname === "/api/segments/recent" && req.method === "GET") {
        if (!this.store) {
          this.sendJson(res, 503, { error: "PipelineStore not available" });
          return;
        }
        const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "30", 10) || 30, 500);
        const cameraId = url.searchParams.get("camera_id") || undefined;
        const scope = this.scopeFromRequest(req, undefined, url);
        if (cameraId && !this.sourceVisibleToSession(cameraId, scope)) {
          this.sendJson(res, 200, { events: [] });
          return;
        }
        this.sendJson(res, 200, { events: this.segments.buildRecentSegmentEvents(limit, cameraId, scope) });
        return;
      }

      // POST /api/dashboard/chat — lightweight QA over current dashboard context.
      if (url.pathname === "/api/dashboard/chat" && req.method === "POST") {
        await this.chatController.handleDashboardChat(req, res);
        return;
      }

      // GET /api/dashboard/live-agent/config — feature-gated voice/live chat config.
      if (url.pathname === "/api/dashboard/live-agent/config" && req.method === "GET") {
        this.liveAgentController.handleConfig(res);
        return;
      }

      // POST /v1/chat/completions — OpenAI-compatible wrapper over Dashboard chat.
      if ((url.pathname === "/v1/chat/completions" || url.pathname === "/api/openai/v1/chat/completions") && req.method === "POST") {
        await this.chatController.handleOpenAIChatCompletions(req, res, url);
        return;
      }

      // GET /api/traces?limit=50&camera_id=xxx — recent pipeline traces
      if (url.pathname === "/api/traces" && req.method === "GET") {
        if (!this.store) {
          res.writeHead(503, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end('{"error":"PipelineStore not available"}');
          return;
        }
        const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 500);
        const cameraId = url.searchParams.get("camera_id") || undefined;
        const scope = this.scopeFromRequest(req, undefined, url);
        if (cameraId && !this.sourceVisibleToSession(cameraId, scope)) {
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ traces: [], count: 0 }));
          return;
        }
        const traces = this.contexts.visibleTraces(cameraId, scope, limit);
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ traces, count: traces.length }));
        return;
      }

      // GET /api/traces/stats?minutes=60&camera_id=xxx — P50/P95 aggregated stats
      if (url.pathname === "/api/traces/stats" && req.method === "GET") {
        if (!this.store) {
          res.writeHead(503, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end('{"error":"PipelineStore not available"}');
          return;
        }
        const minutes = parseInt(url.searchParams.get("minutes") ?? "60", 10) || 60;
        const cameraId = url.searchParams.get("camera_id") || undefined;
        const since = Date.now() - minutes * 60_000;
        const scope = this.scopeFromRequest(req, undefined, url);
        if (cameraId && !this.sourceVisibleToSession(cameraId, scope)) {
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify(this.contexts.emptyTraceStats()));
          return;
        }
        const stats = this.sessionConfig.enabled
          ? this.contexts.traceStats(this.contexts.visibleTraces(cameraId, scope, 5000).filter((trace) => (
            trace.timestamps.analysis_completed_at >= since
          )))
          : this.store.getTraceStats(cameraId, since);
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(stats));
        return;
      }

      // GET /api/config — return current runtime config
      if (url.pathname === "/api/config" && req.method === "GET") {
        this.runtimeConfig.handleGet(res);
        return;
      }

      // POST /api/config — update a single config key
      if (url.pathname === "/api/config" && req.method === "POST") {
        await this.runtimeConfig.handlePost(req, res, url);
        return;
      }

      // CORS preflight for /api/config
      if (url.pathname === "/api/config" && req.method === "OPTIONS") {
        this.runtimeConfig.handleOptions(res);
        return;
      }

      // POST /api/sources/remove — stop watch, then remove a camera source.
      if (url.pathname === "/api/sources/remove" && req.method === "POST") {
        await this.sourceActions.handleSourceRemove(req, res);
        return;
      }

      // POST /api/sources/stop — stop the watch while preserving source data/history.
      if (url.pathname === "/api/sources/stop" && req.method === "POST") {
        await this.sourceActions.handleSourceStop(req, res);
        return;
      }

      // POST /api/sources — register a new camera source via cam add_source
      if (url.pathname === "/api/sources" && req.method === "POST") {
        await this.sourceActions.handleSourceAdd(req, res, url);
        return;
      }

      // CORS preflight for /api/sources
      if (url.pathname === "/api/sources" && req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }

      // GET /api/segment/:segmentId/clip — serve segment video clip
      const clipMatch = url.pathname.match(/^\/api\/segment\/([^/]+)\/clip$/);
      if (clipMatch && req.method === "GET") {
        await this.segmentClips.handle(req, clipMatch[1], res, url);
        return;
      }
      if (clipMatch && req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Range",
        });
        res.end();
        return;
      }

      // Proxy: forward /api/reflectworld/* to ReflectWorld service
      if (url.pathname.startsWith("/api/reflectworld/")) {
        await this.proxyRoutes.handleReflectWorldProxy(req, res, url);
        return;
      }

      // Webhook: ReflectWorld notifies us when memories change
      if (url.pathname === "/api/memory-event" && req.method === "POST") {
        await this.proxyRoutes.handleMemoryEvent(req, res);
        return;
      }

      if (url.pathname === "/api/runtime-health/observe" && req.method === "POST") {
        if (!isAuthorizedInternalWebhookRequest(
          req,
          this.internalWebhookToken,
          this.dashboardSecurityStrict,
        )) {
          this.sendJson(res, 403, { error: "Forbidden" });
          return;
        }
        try {
          const raw = await this.readRequestBuffer(req, 16 * 1024);
          const observation = parseRuntimeHealthObservation(JSON.parse(raw.toString("utf8") || "{}"));
          if (!observation) {
            this.sendJson(res, 400, { error: "Invalid runtime health observation" });
            return;
          }
          this.runtimeHealth.observe(observation);
          this.sendJson(res, 200, { ok: true });
        } catch {
          this.sendJson(res, 400, { error: "Invalid runtime health observation" });
        }
        return;
      }

      this.staticFiles.handleStatic(res, url, hasIndex);
    };

    // WebSocket for raw real-time monitor events. Keep this as a diagnostics /
    // compatibility stream; product state should move to /ws/dashboard.
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    this.dashboardWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    this.liveAgentWss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
    const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const attachedMode = !!this.opts.existingServer;
      const target = url.pathname === "/ws/monitor"
        ? attachedMode ? null : this.wss
        : url.pathname === "/ws/dashboard"
          ? this.dashboardWss
          : url.pathname === "/ws/live-agent"
            ? this.liveAgentWss
            : null;
      if (!target) {
        // In attached mode, let other upgrade handlers on the shared server
        // handle unrelated paths such as the CLI monitor websocket.
        if (attachedMode) return;
        socket.destroy();
        return;
      }
      if (!this.requestOriginAllowed(req)) {
        this.writeUpgradeError(socket, 403, "Forbidden");
        return;
      }
      if (this.maxWsConnections > 0 && this.currentWsConnections() >= this.maxWsConnections) {
        this.writeUpgradeError(socket, 429, "Too Many Requests");
        return;
      }
      if (this.sessionConfig.enabled && !this.scopeFromRequest(req, undefined, url)) {
        this.writeUpgradeError(socket, 401, "Unauthorized");
        return;
      }
      target.handleUpgrade(req, socket, head, (ws) => {
        target.emit("connection", ws, req);
      });
    };
    this.upgradeHandler = handleUpgrade;

    const existingServer = this.opts.existingServer;
    if (existingServer && this.opts.registerHandler) {
      this.server = existingServer;
      this.ownsServer = false;
      this.opts.registerHandler(async (req, res) => {
        await handleRequest(req, res);
        return true;
      });
      this.server.on("upgrade", handleUpgrade);
    } else {
      this.server = createServer(async (req, res) => {
        await handleRequest(req, res);
      });
      this.ownsServer = true;
      this.server.on("upgrade", handleUpgrade);
    }

    monitorBus.on("monitor", this.monitorListener);
    this.unsubscribeRuntimeHealth = subscribeRuntimeHealth((observation) => {
      this.runtimeHealth.observe(observation);
    });

    this.wss.on("connection", (ws, req) => {
      const url = new URL(req.url ?? "/ws/monitor", "http://localhost");
      const scope = this.scopeFromRequest(req, undefined, url);
      (ws as WebSocket & { dashboardSession?: DashboardSessionScope }).dashboardSession = scope ?? undefined;
      ws.send(JSON.stringify({
        type: "system:connected",
        timestamp: Date.now(),
        data: {},
      }));
    });

    this.dashboardWss.on("connection", (ws, req) => {
      const url = new URL(req.url ?? "/ws/dashboard", "http://localhost");
      const scope = this.scopeFromRequest(req, undefined, url);
      (ws as WebSocket & { dashboardSession?: DashboardSessionScope }).dashboardSession = scope ?? undefined;
      const cursor = parseInt(url.searchParams.get("cursor") ?? "0", 10) || 0;
      ws.send(JSON.stringify({
        domain: "system",
        id: "__connected__",
        version: this.dashboardState.version,
        op: "upsert",
        timestamp: Date.now(),
        data: { connected: true },
      } satisfies DashboardStateEnvelope));

      for (const envelope of this.dashboardReplayEnvelopes(cursor)) {
        if (this.dashboardEnvelopeVisibleToSession(envelope, scope)) ws.send(JSON.stringify(envelope));
      }

      const snapshotVersion = this.dashboardState.version;
      void this.sourceStatuses.visibleSourceStatuses(scope).then((sources) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        for (const source of sources) {
          ws.send(JSON.stringify(this.sourceStatusEnvelope(source, snapshotVersion)));
        }
        for (const segment of this.segments.buildDashboardSegments(100, undefined, scope)) {
          ws.send(JSON.stringify(this.segments.stateEnvelope(segment, snapshotVersion)));
        }
      }).catch((err) => {
        writeStderr("[dashboard-state] initial source projection failed", err);
      });
    });

    this.liveAgentWss.on("connection", (ws, req) => {
      this.liveAgentController.handleConnection(ws, req);
    });

    if (!this.ownsServer) return;

    return new Promise((resolve, reject) => {
      this.server!.listen(this.port, () => resolve());
      this.server!.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          // Port taken — skip silently (another instance may be running)
          this.server = null;
          this.wss = null;
          this.dashboardWss = null;
          this.liveAgentWss = null;
          resolve();
        } else {
          reject(err);
        }
      });
    });
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    if (res.destroyed || res.writableEnded) return;
    if (!res.headersSent) {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        ...res.getHeaders(),
      });
    }
    res.end(JSON.stringify(body));
  }

  private requireVisibleLiveSource(req: IncomingMessage, res: ServerResponse, url: URL, src: string): boolean {
    return this.liveProxy.requireVisibleSource(req, res, url, src);
  }

  private async handleLiveStreamProxy(req: IncomingMessage, res: ServerResponse, url: URL, format: "mp4" | "mjpeg"): Promise<void> {
    await this.liveProxy.handleStream(req, res, url, format);
  }

  private async handleLiveStatus(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    await this.liveProxy.handleStatus(req, res, url);
  }

  private async getGo2rtcStreams(): Promise<Record<string, unknown> | null> {
    return this.liveProxy.getStreams();
  }

  private readGo2rtcStreamHealth(streams: Record<string, unknown> | null, src: string): Go2rtcStreamHealth {
    return this.liveProxy.readStreamHealth(streams, src);
  }

  private async handleLiveFrameProxy(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    await this.liveProxy.handleFrame(req, res, url);
  }

  private async readRequestBuffer(req: IncomingMessage, maxBytes = MAX_UPLOAD_BYTES): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        throw new Error(`Request body exceeds ${Math.round(maxBytes / 1024 / 1024)}MB limit`);
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  }

  private async runFfmpegToFile(
    args: string[],
    outputPath: string,
    label: string,
    res?: ServerResponse,
  ): Promise<void> {
    await this.ffmpegJobs.runToFile(args, outputPath, label, res);
  }

  private async ensurePreviewVideo(videoId: string, sourcePath: string, res?: ServerResponse): Promise<string> {
    return this.videoRoutes.ensurePreviewVideo(videoId, sourcePath, res);
  }

  /** Get current runtime config (used by orchestrator for initialization). */
  getRuntimeConfig(): Readonly<RuntimeConfig> {
    return this.runtimeConfig.getConfig();
  }

  publishSegmentWatchingPreview(req: {
    segmentId: string;
    cameraId: string;
    timestamp: number;
    currentTimestamp?: number;
    frameBase64?: string;
    detections: FrameDetection[];
    inputMode?: "local_file" | "live_stream";
  }): void {
    this.segments.publishWatchingPreview(req);
  }

  publishSegmentQueuedPreview(segment: Segment): void {
    this.segments.publishQueuedPreview(segment);
  }

  publishSegmentProcessingPreview(segment: Segment, gifPath?: string): void {
    this.segments.publishProcessingPreview(segment, gifPath);
  }

  publishSegmentSkippedPreview(
    segment: Segment,
    info: { reason: string; lagMs: number; thresholdMs: number; skippedTotal?: number },
  ): void {
    this.segments.publishSkippedPreview(segment, info);
  }

  setAnalyzeCallback(cb: (req: AnalyzeRequest) => Promise<AnalyzeResponse>): void {
    this.analyze = cb;
  }

  setStreamAnalyzeCallback(cb: (req: StreamAnalyzeRequest) => Promise<StreamAnalyzeResponse>): void {
    this.streamAnalyze = cb;
  }

  setSourceRemoveCallback(cb: (req: SourceRemoveRequest) => Promise<SourceRemoveResponse>): void {
    this.removeSource = cb;
  }

  setSourceStopCallback(cb: (req: SourceStopRequest) => Promise<SourceStopResponse>): void {
    this.stopSource = cb;
  }

  setSourcePurgeCallback(cb: (req: SourcePurgeRequest) => Promise<SourcePurgeResponse>): void {
    this.purgeSource = cb;
  }

  setActiveSourcesCallback(cb: () => ActiveSourceStatus[]): void {
    this.getActiveSources = cb;
  }

  setAnalysisStatusCallback(cb: () => AnalysisStatusSnapshot): void {
    this.getAnalysisStatus = cb;
  }

  setClearDashboardDataCallback(cb: (scope?: DashboardSessionScope | null) => Promise<void>): void {
    this.clearDashboardData = cb;
  }

  setDashboardChatCallback(cb: (req: DashboardChatRequest) => Promise<DashboardChatResponse>): void {
    this.dashboardChat = cb;
  }

  setSemanticContextCallback(cb: (req: SemanticContextRequest) => Promise<SemanticContextResponse>): void {
    this.getSemanticContext = cb;
  }

  /** Update a runtime config value programmatically (e.g., from orchestrator init). */
  setRuntimeConfigValue(key: RuntimeConfigKey, value: string): void {
    this.runtimeConfig.setValue(key, value);
  }

  stop(): void {
    monitorBus.off("monitor", this.monitorListener);
    try {
      this.unsubscribeRuntimeHealth?.();
    } catch {
      // Dashboard shutdown must not depend on observability cleanup.
    }
    this.unsubscribeRuntimeHealth = null;
    if (this.sessionCleanupTimer) {
      clearInterval(this.sessionCleanupTimer);
      this.sessionCleanupTimer = null;
    }
    this.ffmpegJobs.stop();
    this.segments.stop();
    this.wss?.close();
    this.dashboardWss?.close();
    this.liveAgentWss?.close();
    if (this.server && this.upgradeHandler) {
      this.server.off("upgrade", this.upgradeHandler);
      this.upgradeHandler = null;
    }
    if (this.ownsServer) this.server?.close();
    this.ownsServer = false;
    this.wss = null;
    this.dashboardWss = null;
    this.liveAgentWss = null;
    this.server = null;
  }
}
