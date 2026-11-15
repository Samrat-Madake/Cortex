// .env is loaded by CLI start.ts before plugin registration
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { basename, resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * @cortex/cortex — All-in-one OpenClaw plugin.
 *
 * One install gives AI agents:
 *   - Video capture (cam)
 *   - VLM analysis (perception)
 *   - Persistent memory (memory + Cortex)
 *   - VLM-driven notifications (replaces rule engine)
 *
 * Infrastructure (Qdrant, Cortex) auto-starts as services after setup-prepared binaries are present.
 * Media stored locally (SQLite + filesystem).
 * User only needs: VLM_PROVIDER, VLM_MODEL, VLM_API_KEY, and VLM_BASE_URL for OpenAI-compatible APIs.
 *
 * Config (split by module key):
 *   pluginConfig: {
 *     cam: { ... },
 *     perception: { vlm_provider: "openai", vlm_api_key: "...", vlm_base_url: "..." },
 *     memory: { baseUrl: "..." },
 *   }
 */
import {
  createRuntimeHealthReporter,
  monitorBus,
  resolveCortexHome,
} from "@cortex/shared";
import type {
  OpenClawPluginApi,
  Segment,
  PerceptionResult,
} from "@cortex/shared";
import camPlugin from "@cortex/cam";
import perceptionPlugin from "@cortex/percept";
import { analyze, createPipelineDeps, resolvePerceptionConfig, FrameAnalyzer, SemanticContextManager, buildSummarizationPrompt, logPipelineSelfCheck, clearCameraRuntimeState, parseSemanticContextSections, executeToolAction, resolveVlmCallProfile, buildAnimatedSegmentPreviewBuffer } from "@cortex/percept";
import type { EventCloseSummary, PipelineMemory, PipelineSelfCheckComponent, PostProcessor, VlmMeta, SummarizationResult } from "@cortex/percept";
import memoryPlugin from "@cortex/mem";
import { CortexClient, parseMemoryConfig, flattenMemoriesResponse, flattenSearchResults } from "@cortex/mem";
import { QdrantService } from "./src/services/qdrant-service.js";
import { CortexService } from "./src/services/cortex-service.js";
import { DEFAULT_MEDIA_RETENTION_DAYS, DEFAULT_TEXT_RETENTION_DAYS, PipelineStore } from "./src/store.js";
import { Notifier, type DeliveryResult } from "./src/notifier.js";
import { loadActiveWatchStates, loadPersistedWatchStates, logSourceSecurityEnvWarningsOnce, updateWatchState } from "@cortex/cam";
import type { NotifyPolicy } from "@cortex/cam";
import { DashboardServer } from "./src/services/dashboard-server.js";
import type { ActiveSourceStatus, AnalysisStatusItem, AnalysisStatusSnapshot, DashboardChatRequest, DashboardChatResponse, SourcePurgeRequest, SourcePurgeResponse, SourceRemoveRequest, SourceRemoveResponse, SourceStopRequest, SourceStopResponse, StreamAnalyzeResponse } from "./src/services/dashboard-server.js";
import type { DashboardServerOptions } from "./src/services/dashboard-server.js";
import type { DashboardSessionScope } from "./src/services/dashboard-common.js";
import { FRAME_POLICY_MAX_FPS, VisionController, mergeWithBenchmarkVisionControllerDefaults } from "./src/vision-controller/index.js";
import { resolveInternalWebhookToken } from "./src/services/internal-webhook-auth.js";
import type {
  VisionControllerConfig,
  FramePolicyOutput,
  SegmentPolicyOutput,
} from "./src/vision-controller/index.js";
import type { TriggerCondition } from "./src/vision-controller/types.js";
import type { VCLegacyConfig, SegmentSignals as VisionControllerSignals } from "./src/vc-types/index.js";
import { MemoryWriteScheduler } from "./src/memory-write-scheduler.js";
import { PerceptionRuntime } from "./src/runtime/perception-runtime.js";
import type { SegmentRuntimeTask } from "./src/runtime/perception-runtime.js";
import { buildPerceptionAddRequest, countAddMemoryTypes, createMemoryReidAdapter, createMemoryStorePerception } from "./src/memory-adapter.js";
import { buildCamConfig, resolveGo2rtcEndpoint } from "./src/config-helpers.js";
import type { CortexPortOverlay } from "./src/config-helpers.js";
import { bridgePluginConfigToEnv } from "./src/config-env-bridge.js";
import {
  buildDashboardChatUnavailablePrompt,
  DASHBOARD_CHAT_NON_EXHAUSTIVE_EVIDENCE_RULE,
  DASHBOARD_CHAT_UNAVAILABLE_FALLBACK,
  dashboardChatFinalEvidenceInstructions,
  dashboardChatRequestFailureResponse,
  dashboardChatRequiredSearchFailureResponse,
  decideDashboardChatAgentStep,
  type DashboardChatQuestionScope,
} from "./src/services/dashboard-chat-agent-policy.js";
import {
  executeDashboardChatMemorySearch,
  type DashboardChatToolResult,
} from "./src/services/dashboard-chat-memory-search.js";

const runtimeHealth = createRuntimeHealthReporter("cortex");

/**
 * Structured payload submitted when VisionController segment policy wants
 * OpenClaw to decide whether the visual scene configuration should change.
 */
export interface ConsultationRequest {
  camera_id: string;
  segment_id?: string;
  signals: Record<string, unknown>;
  trigger_reason: Record<string, unknown>;
  eventText: string;
  video_context?: Record<string, unknown>;
  event_context?: Record<string, unknown>;
  current_segment?: Record<string, unknown>;
  policy_state?: Record<string, unknown>;
  constraints?: Record<string, unknown>;
  current_baseline?: Record<string, unknown>;
  current_overrides?: Record<string, unknown>;
  recommended_action_types?: string[];
  /** When true, require Agent to specify exit_condition in response. */
  requires_exit_condition?: boolean;
  /** Hint for Agent on exit_condition format. */
  exit_condition_hint?: string;
}

/**
 * Pluggable dispatcher for VisionController segment policy consultations.
 *
 * Production path:
 *   Cortex submits a consultation to OpenClaw via system events.
 *
 * E2E path:
 *   A SimAgent test double can receive the same consultation payload and
 *   simulate what OpenClaw would decide to do next.
 *
 * Important:
 * - Frame policy fast rules are still executed locally inside Cortex.
 * - Segment policy is an OpenClaw consultation path, not an internal synchronous
 *   tool-execution loop.
 * - A returned tool call is treated as test-only metadata and is NOT executed
 *   internally by Cortex.
 */
export interface ConsultationDispatcher {
  submitConsultation(context: ConsultationRequest): Promise<{
    tool?: string;
    params?: Record<string, unknown>;
    exit_condition?: TriggerCondition;
  } | null | void>;
}

/**
 * @deprecated Use ConsultationDispatcher. Kept as a compatibility alias for
 * existing E2E injection code that still passes `onConsult(...)`.
 */
export interface ConsultationHandler {
  onConsult(context: ConsultationRequest): Promise<{
    tool?: string;
    params?: Record<string, unknown>;
    exit_condition?: TriggerCondition;
  } | null | void>;
}

/** Walk up from startDir to find the @cortex/cortex package root. */
function findPkgRoot(startDir: string): string {
  let d = startDir;
  while (d !== dirname(d)) {
    if (existsSync(join(d, "package.json"))) {
      try {
        const pkg = JSON.parse(readFileSync(join(d, "package.json"), "utf8"));
        if (pkg.name === "@cortex/cortex") return d;
      } catch { /* skip unreadable package.json */ }
    }
    d = dirname(d);
  }
  return startDir;
}

function expandHomePath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function commandAvailable(bin: string): boolean {
  const value = expandHomePath(bin.trim());
  if (!value) return false;
  if (value.includes("/") || value.includes("\\") || value.startsWith(".")) {
    if (existsSync(resolve(value))) return true;
    if (existsSync(resolve(value + ".exe"))) return true;
  }
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(cmd, [value], { timeout: 3000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function stableCortexBin(home: string, name: string): string {
  return join(home, "bin", name);
}

function requiredBinaryComponent(
  name: string,
  configured: unknown,
  fallbackCommand: string | undefined,
  fallbackPath: string | undefined,
): PipelineSelfCheckComponent {
  const configuredBin = typeof configured === "string" && configured.trim() ? configured.trim() : undefined;
  const candidates = configuredBin
    ? [configuredBin]
    : [fallbackCommand, fallbackPath].filter((v): v is string => typeof v === "string" && v.length > 0);
  const ok = candidates.some(commandAvailable);
  return {
    name,
    status: ok ? "ok" : "error",
    required: true,
    detail: `candidates=${candidates.join(",") || "none"}`,
  };
}

async function waitHttpOk(endpoint: string, healthPath: string, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  const url = `${endpoint.replace(/\/$/, "")}${healthPath}`;
  while (Date.now() - started < timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (res.ok) return true;
    } catch {
      // keep retrying until timeout
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolveRetry) => setTimeout(resolveRetry, 300));
  }
  return false;
}

const NOTIFICATION_DELIVERY_TIMEOUT_MS = 10_000;

interface NotificationDeliveryState {
  logIds: Array<number | undefined>;
  results: Array<DeliveryResult | undefined>;
}

function notificationDeliveryState(notifications: unknown): NotificationDeliveryState {
  const carrier = notifications as { __deliveryState?: NotificationDeliveryState };
  carrier.__deliveryState ??= { logIds: [], results: [] };
  return carrier.__deliveryState;
}

async function withNotificationTimeout(
  delivery: Promise<DeliveryResult>,
  startedAt: number,
): Promise<DeliveryResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      delivery,
      new Promise<DeliveryResult>((resolveTimeout) => {
        timeout = setTimeout(() => {
          resolveTimeout({
            delivered: false,
            delivery_ms: Date.now() - startedAt,
            delivery_error: "notification timeout",
          });
        }, NOTIFICATION_DELIVERY_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    return {
      delivered: false,
      delivery_ms: Date.now() - startedAt,
      delivery_error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export default {
  id: "cortex",
  name: "Cortex",
  description:
    "Visual perception + persistent memory platform — " +
    "video capture, VLM analysis, memory storage, VLM-driven notifications. " +
    "Infrastructure (Qdrant, Cortex) auto-starts after setup-prepared binaries are present.",

  async register(api: OpenClawPluginApi) {
    const bridgedConfig = bridgePluginConfigToEnv((api.pluginConfig ?? {}) as Record<string, unknown>);
    const config = bridgedConfig as Record<string, Record<string, unknown> | undefined>;
    const rawConfig = bridgedConfig;
    const logger = api.logger;
    logSourceSecurityEnvWarningsOnce(logger);

    // ── Resolve canonical homeDir / stateDir from pluginConfig (injected by CLI start.ts) ──
    const homeDir = typeof rawConfig?._homeDir === "string" ? rawConfig._homeDir : resolveCortexHome();
    const stateDir = typeof rawConfig?._stateDir === "string" ? rawConfig._stateDir : api.runtime.state.resolveStateDir();
    const ports = (typeof rawConfig?._ports === "object" && rawConfig._ports !== null ? rawConfig._ports : {}) as CortexPortOverlay;

    const memoryServiceStoragePath = typeof config.memory?.storage_path === "string"
      ? config.memory.storage_path
      : undefined;
    const memoryServiceCollectionName = typeof config.memory?.collection_name === "string"
      ? config.memory.collection_name
      : undefined;
    const memoryServiceSourceDir = typeof config.memory?.source_dir === "string"
      ? config.memory.source_dir
      : undefined;
    const qdrantPort = typeof config.memory?.qdrant_port === "number"
      ? config.memory.qdrant_port
      : typeof config.qdrant?.port === "number"
        ? config.qdrant.port
        : undefined;
    const qdrantGrpcPort = typeof config.memory?.qdrant_grpc_port === "number"
      ? config.memory.qdrant_grpc_port
      : typeof config.qdrant?.grpc_port === "number"
        ? config.qdrant.grpc_port
        : undefined;
    const resolvedQdrantPort = typeof ports.qdrant === "number" ? ports.qdrant : qdrantPort;
    const resolvedQdrantGrpcPort = typeof ports.qdrantGrpc === "number" ? ports.qdrantGrpc : qdrantGrpcPort;
    // Allow the runner (E2E / benchmark) to choose its own mem-service port
    // via pluginConfig.memory.port so it can isolate from a production
    // :8219 instance. Defaults to 8219 when unspecified.
    const memoryServicePort = typeof config.memory?.port === "number"
      ? config.memory.port
      : typeof ports.mem === "number" ? ports.mem : undefined;
    const internalWebhookToken = resolveInternalWebhookToken(
      stateDir,
      process.env.CORTEX_INTERNAL_WEBHOOK_TOKEN,
    );
    process.env.CORTEX_INTERNAL_WEBHOOK_TOKEN = internalWebhookToken;
    const pendingConsultations = new Map<string, {
      consultationId: string;
      segmentId: string;
      submittedAt: number;
      recommendedActionTypes: string[];
    }>();
    const activeAdaptivePromptConfigByCamera = new Map<string, Record<string, unknown>>();

    // Intelligence feature flags per camera (parsed from Semantic Context)
    const explainDecisionsPerCamera = new Set<string>();
    const lastVcRuleFired = new Map<string, string>();

    // ── Infrastructure services (resolve prepared binaries + auto-start) ──
    const qdrant = new QdrantService({
      homeDir,
      stateDir,
      httpPort: resolvedQdrantPort,
      grpcPort: resolvedQdrantGrpcPort,
    });
    const cortex = new CortexService({
      homeDir,
      stateDir,
      port: memoryServicePort,
      qdrantPort: resolvedQdrantPort,
      sourceDir: memoryServiceSourceDir,
      storagePath: memoryServiceStoragePath,
      collectionName: memoryServiceCollectionName,
    });

    api.registerService({
      id: "qdrant",
      async start() {
        await qdrant.start();
        logger.info(`[cortex] qdrant ${qdrant.mode === "external" ? "reused external instance" : "started as managed service"}`);
      },
      async stop() {
        await qdrant.stop();
      },
    });

    api.registerService({
      id: "cortex",
      async start() {
        await cortex.start();
        // Expose actual endpoint for E2E/assertion harness (port may have changed)
        process.env.CORTEX_URL = cortex.endpoint;
        process.env.CORTEX_ENDPOINT = cortex.endpoint;
        logger.info(
          `[cortex] python service ${
            cortex.mode === "external"
              ? "reused external instance"
              : `started as managed service (${cortex.mode})`
          } at ${cortex.endpoint}`,
        );
      },
      async stop() {
        await cortex.stop();
      },
    });

    // ── Local SQLite store for pipeline logs + media ──
    const store = new PipelineStore(stateDir);
    const activeAnalyses = new Map<string, AnalysisStatusItem & { sourcePath: string }>();
    const recentAnalyses = new Map<string, AnalysisStatusItem>();
    const clearedDashboardSources = new Set<string>();

    const archiveSegments = (process.env.CORTEX_ARCHIVE_LEVEL ?? "off").toLowerCase() !== "off";
    const segmentArchiveDir = join(stateDir, "segments");
    const segmentFileById = new Map<string, string>();
    const segmentCameraById = new Map<string, string>();
    const segmentIdsByCamera = new Map<string, Set<string>>();
    const lastResultByCamera = new Map<string, PerceptionResult>();
    if (archiveSegments) mkdirSync(segmentArchiveDir, { recursive: true });
    const rememberSegmentArchiveIndex = (result: PerceptionResult, path: string): void => {
      segmentFileById.set(result.segment_id, path);
      segmentCameraById.set(result.segment_id, result.camera_id);
      let ids = segmentIdsByCamera.get(result.camera_id);
      if (!ids) {
        ids = new Set<string>();
        segmentIdsByCamera.set(result.camera_id, ids);
      }
      ids.add(result.segment_id);
    };
    const forgetSegmentArchiveIndex = (segmentId: string): void => {
      const cameraId = segmentCameraById.get(segmentId);
      segmentFileById.delete(segmentId);
      segmentCameraById.delete(segmentId);
      if (!cameraId) return;
      const ids = segmentIdsByCamera.get(cameraId);
      ids?.delete(segmentId);
      if (ids && ids.size === 0) segmentIdsByCamera.delete(cameraId);
    };
    const forgetCameraArchiveIndex = (cameraId: string): void => {
      const ids = segmentIdsByCamera.get(cameraId);
      if (ids) {
        for (const segmentId of ids) {
          segmentFileById.delete(segmentId);
          segmentCameraById.delete(segmentId);
        }
        segmentIdsByCamera.delete(cameraId);
      }
      lastResultByCamera.delete(cameraId);
    };
    const writeSegmentArchive = (result: PerceptionResult): void => {
      if (!archiveSegments) return;
      const path = join(segmentArchiveDir, `${result.segment_id}.json`);
      rememberSegmentArchiveIndex(result, path);
      lastResultByCamera.set(result.camera_id, result);
      writeFileSync(path, JSON.stringify(result, null, 2));
    };
    const patchSegmentArchive = (result: PerceptionResult): void => {
      if (!archiveSegments || !result._archive) return;
      const path = segmentFileById.get(result.segment_id);
      if (!path || !existsSync(path)) return;
      try {
        const raw = JSON.parse(readFileSync(path, "utf-8")) as PerceptionResult;
        raw._archive = result._archive;
        writeFileSync(path, JSON.stringify(raw, null, 2));
      } catch {
        // Best-effort debug artifact patching.
      }
    };
    const updateSegmentArchive = (
      segmentId: string,
      updater: (archive: NonNullable<PerceptionResult["_archive"]>) => void,
    ): void => {
      const path = segmentFileById.get(segmentId);
      if (!path || !existsSync(path)) return;
      try {
        const raw = JSON.parse(readFileSync(path, "utf-8")) as PerceptionResult;
        if (!raw._archive) return;
        updater(raw._archive);
        writeFileSync(path, JSON.stringify(raw, null, 2));
      } catch {
        // Best-effort debug artifact patching.
      }
    };
    const countWords = (text: string | undefined): number =>
      text?.trim() ? text.trim().split(/\s+/).length : 0;
    const recordEventClose = (summary: EventCloseSummary): void => {
      const eventClose = {
        closed: true,
        event_id: summary.event_id,
        segment_count: summary.segment_count,
        summary_words: countWords(summary.event_summary ?? summary.compressed_context),
        time_range: summary.time_range,
        segment_ids: summary.segment_ids,
      };
      for (const segmentId of summary.segment_ids) {
        updateSegmentArchive(segmentId, (archive) => {
          archive.event_narrative = {
            ...(archive.event_narrative ?? {}),
            event_close: eventClose,
          };
        });
      }
    };
    const recordNarrativeFlush = (
      result: PerceptionResult | undefined,
      flush: { attempted: boolean; status: "ok" | "error"; finalize?: boolean; error?: string },
    ): void => {
      if (!result?._archive) return;
      result._archive.event_narrative = {
        ...(result._archive.event_narrative ?? {}),
        narrative_flush: flush,
      };
      patchSegmentArchive(result);
    };

    // ── Dashboard Web UI (serves dashboard + WebSocket for real-time events) ──
    const __pkgRoot = findPkgRoot(dirname(fileURLToPath(import.meta.url)));
    const dashboardDistCandidates = [
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "dashboard", "dist"),
      resolve(__pkgRoot, "..", "dashboard", "dist"),
      resolve(__pkgRoot, "bundled-dashboard"),
    ];
    const dashboardDistDir = dashboardDistCandidates.find((d) => existsSync(d)) ?? dashboardDistCandidates[0]!;
    const dashboardConfig = (config.dashboard ?? config.monitor ?? {}) as Record<string, unknown>;
    const configuredDashboardPort = Number.parseInt(process.env.DASHBOARD_PORT ?? process.env.MONITOR_PORT ?? "", 10);
    const home = process.env.HOME ?? "";
    // Pre-compute merged cam config for DashboardServer (full camConfig is declared later for plugin wiring)
    const mergedCamForDashboard = buildCamConfig(config.eye as Record<string, unknown> | undefined, config.cam as Record<string, unknown> | undefined, ports);
    const resolvedRecordingsDir = ((mergedCamForDashboard.recordings_dir as string) ?? join(stateDir, "recordings")).replace("~", home);
    const resolvedSourcesDir = ((mergedCamForDashboard.sources_dir as string) ?? join(stateDir, "sources")).replace("~", home);
    const uploadsDir = join(stateDir, "uploads");
    const parseDashboardDirs = (raw: unknown): string[] => {
      if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
      if (typeof raw === "string") return raw.split(",").map((item) => item.trim()).filter(Boolean);
      return [];
    };
    const normalizeDashboardDir = (dir: string): string => dir.replace("~", home);
    const legacyUploadDirsConfig = dashboardConfig.legacy_uploads_dirs ?? dashboardConfig.legacyUploadsDirs;
    const legacyUploadDirsEnv = process.env.CORTEX_DASHBOARD_LEGACY_UPLOADS_DIRS;
    const legacyUploadsDirs = [
      ...parseDashboardDirs(legacyUploadDirsConfig),
      ...parseDashboardDirs(legacyUploadDirsEnv),
    ].map(normalizeDashboardDir).filter((dir) => resolve(dir) !== resolve(uploadsDir));
    const fixtureVideosDir = (
      typeof dashboardConfig.public_videos_dir === "string" ? dashboardConfig.public_videos_dir
        : typeof dashboardConfig.fixture_videos_dir === "string" ? dashboardConfig.fixture_videos_dir
          : typeof dashboardConfig.fixtureVideosDir === "string" ? dashboardConfig.fixtureVideosDir
            : process.env.CORTEX_DASHBOARD_PUBLIC_VIDEOS_DIR
              ?? process.env.CORTEX_DASHBOARD_FIXTURE_VIDEOS_DIR
              ?? ""
    ).trim();
    const dashboardServer = new DashboardServer({
      distDir: dashboardDistDir,
      stateDir,
      port: typeof dashboardConfig.port === "number"
        ? dashboardConfig.port
        : Number.isFinite(configuredDashboardPort) && configuredDashboardPort > 0 ? configuredDashboardPort : undefined,
      cortexEndpoint: cortex.endpoint,
      internalWebhookToken,
      store,
      recordingsDir: resolvedRecordingsDir,
      mediaDirs: [join(stateDir, "media")],
      ffmpegBin: typeof mergedCamForDashboard.ffmpeg_bin === "string" && mergedCamForDashboard.ffmpeg_bin.trim()
        ? mergedCamForDashboard.ffmpeg_bin
        : stableCortexBin(homeDir, "ffmpeg"),
      ffprobeBin: typeof mergedCamForDashboard.ffprobe_bin === "string" && mergedCamForDashboard.ffprobe_bin.trim()
        ? mergedCamForDashboard.ffprobe_bin
        : stableCortexBin(homeDir, "ffprobe"),
      go2rtcApiPort: mergedCamForDashboard.go2rtc_api_port as number | string | undefined,
      uploadsDir,
      legacyUploadsDirs,
      ...(fixtureVideosDir ? { fixtureVideosDir: normalizeDashboardDir(fixtureVideosDir) } : {}),
      addSource: async (source, name, opts) => {
        if (!executeCam) throw new Error("Cam service not ready");
        return executeCam("add_source", {
          source,
          ...(name ? { name } : {}),
          ...(opts?.userId ? { _dashboardUserId: opts.userId } : {}),
          ...(opts?.sessionId ? { _dashboardSessionId: opts.sessionId } : {}),
        });
      },
      existingServer: dashboardConfig.existingServer as import("node:http").Server | undefined,
      registerHandler: dashboardConfig.registerHandler as DashboardServerOptions["registerHandler"],
    });
    api.registerService({
      id: "dashboard",
      async start() {
        await dashboardServer.start();
        logger.info(`[dashboard] Web UI at http://localhost:${dashboardServer.port}`);
      },
      async stop() {
        dashboardServer.stop();
      },
    });

    // ── Service origin reporter (emit startup summary for dashboard/logging) ──
    api.registerService({
      id: "service-reporter",
      async start() {
        monitorBus.publish("system:service_origins", {
          qdrant: qdrant.mode,
          cortex: cortex.mode,
        });
        logger.info(
          `[services] origins: qdrant=${qdrant.mode}, cortex=${cortex.mode}`,
        );
      },
    });

    // ── VisionController: adaptive perception strategy engine ──
    // Benchmark-aligned defaults keep production, demo, and eval behavior comparable.
    const legacyConfig = mergeWithBenchmarkVisionControllerDefaults(
      config.vision_controller as Partial<VCLegacyConfig> | undefined,
    );

    // Build VisionController from legacy config key (backward-compatible mapping)
    const vcConfig: VisionControllerConfig | undefined = legacyConfig?.enabled
      ? {
          enabled: true,
          baseline: legacyConfig.baseline ?? {},
          rules: legacyConfig.auto_rules ?? [],
          segment_policy: legacyConfig.segment_policy,
        }
      : undefined;
    const visionController = vcConfig?.enabled ? new VisionController(vcConfig) : null;
    if (visionController) {
      logger.info(`[vision-controller] Enabled: ${vcConfig!.rules.length} rules, baseline fps=${vcConfig!.baseline?.fps ?? "default"}`);
    }

    // ── Inject infrastructure endpoints into sub-plugin configs ──

    // Cam action executor — set by onCamReady callback from Cam plugin
    let executeCam: ((action: string, params: Record<string, unknown>) => Promise<string>) | null = null;
    let waitForCameraIdle = async (_cameraId: string): Promise<void> => {};

    const camConfig: Record<string, unknown> = {
      ...buildCamConfig(config.eye as Record<string, unknown> | undefined, config.cam as Record<string, unknown> | undefined, ports),
      cortex_endpoint: cortex.endpoint,
      mediaDir: join(stateDir, "media"),
      onCamReady: (executor: (action: string, params: Record<string, unknown>) => Promise<string>) => {
        executeCam = executor;
        logger.info("[cortex] Cam action executor ready for VisionController");
      },
      waitForCameraIdle: (cameraId: string) => waitForCameraIdle(cameraId),
    };
    // ── Resolve go2rtc endpoint (used by self-check + health heartbeat) ──
    const go2rtcEndpoint = resolveGo2rtcEndpoint(ports, config.cam as Record<string, unknown> | undefined, config.eye as Record<string, unknown> | undefined);

    // Auto-detect stubs_only: if models directory has ONNX files, enable local models.
    const modelsDir = (config.perception?.models_dir as string)
      ?? process.env.CORTEX_MODELS_DIR;
    const resolvedModelsDir = expandHomePath(modelsDir ?? join(homeDir, "models"));
    const hasModels = (() => {
      try {
        return readdirSync(resolvedModelsDir).some((f: string) => f.endsWith(".onnx"));
      } catch { return false; }
    })();
    if (hasModels) logger.info(`[cortex] Models found in ${resolvedModelsDir}, local inference enabled`);

    const perceptionConfig = {
      ...config.perception,
      cortex_endpoint: cortex.endpoint,
      models_dir: resolvedModelsDir,
      stubs_only: hasModels ? false : (config.perception?.stubs_only ?? true),
    };
    const resolvedPerceptionConfig = resolvePerceptionConfig(perceptionConfig);
    // ── Build memory client ──
    const memoryConfig = { ...(config.memory ?? {}) } as Record<string, unknown>;
    const configuredMemoryBaseUrl = typeof memoryConfig.baseUrl === "string"
      ? memoryConfig.baseUrl
      : undefined;
    const memoryUserId = typeof memoryConfig.user_id === "string" && memoryConfig.user_id.trim()
      ? memoryConfig.user_id.trim()
      : "admin";
    memoryConfig.defaultUserId = memoryUserId;
    const resolvedMemoryConfig = parseMemoryConfig(memoryConfig);
    const memoryClient = new CortexClient({
      // CortexService.start() may move to a free port at runtime.
      // Resolve the endpoint per request so writes follow the active service.
      baseUrl: () => configuredMemoryBaseUrl ?? cortex.endpoint,
      timeoutMs: resolvedMemoryConfig.timeoutMs,
    });

    // ── Local retention: bounded dashboard data and generated media ──
    const retentionConfig = (typeof rawConfig.retention === "object" && rawConfig.retention !== null
      ? rawConfig.retention
      : {}) as Record<string, unknown>;
    const mediaRetentionDays = readNonNegativeInt(
      process.env.CORTEX_MEDIA_RETENTION_DAYS
        ?? retentionConfig.media_days
        ?? retentionConfig.media_retention_days,
      DEFAULT_MEDIA_RETENTION_DAYS,
    );
    const textRetentionDays = readNonNegativeInt(
      process.env.CORTEX_TEXT_RETENTION_DAYS
        ?? retentionConfig.text_days
        ?? retentionConfig.text_retention_days,
      DEFAULT_TEXT_RETENTION_DAYS,
    );
    const retentionIntervalHours = readPositiveInt(
      process.env.CORTEX_RETENTION_INTERVAL_HOURS
        ?? retentionConfig.interval_hours,
      24,
    );
    const retentionIntervalMs = retentionIntervalHours * 3_600_000;

    const pruneFilesOlderThan = (
      root: string,
      cutoffMs: number,
      onDeleted?: (path: string) => void,
    ): number => {
      if (!existsSync(root)) return 0;
      let deleted = 0;
      const visit = (dir: string): boolean => {
        let entries: Dirent[];
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return false;
        }
        for (const entry of entries) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) {
            const empty = visit(path);
            if (empty && path !== root) {
              try { rmSync(path, { recursive: false, force: true }); } catch { /* best-effort */ }
            }
            continue;
          }
          try {
            const stat = statSync(path);
            if (stat.mtimeMs >= cutoffMs) continue;
            rmSync(path, { force: true });
            deleted += 1;
            onDeleted?.(path);
          } catch {
            // Best-effort retention only.
          }
        }
        try {
          return readdirSync(dir).length === 0;
        } catch {
          return false;
        }
      };
      visit(root);
      return deleted;
    };

    let retentionTimer: ReturnType<typeof setInterval> | null = null;
    let retentionRunning = false;
    const runLocalRetention = async (reason: "startup" | "interval"): Promise<void> => {
      if (retentionRunning) return;
      retentionRunning = true;
      try {
        const result = store.runRetention({
          mediaRetentionDays,
          textRetentionDays,
        });
        let expiredMediaInMem = 0;
        for (const segment of result.mediaSegmentsExpired) {
          try {
            await memoryClient.expireMedia({
              segment_id: segment.segment_id,
              camera_id: segment.camera_id,
            });
            expiredMediaInMem += 1;
          } catch (err) {
            logger.warn(
              `[retention] expire_media failed for ${segment.segment_id}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        let cacheFilesDeleted = 0;
        if (result.mediaCutoffMs !== null) {
          cacheFilesDeleted += pruneFilesOlderThan(resolvedRecordingsDir, result.mediaCutoffMs);
          cacheFilesDeleted += pruneFilesOlderThan(join(uploadsDir, ".preview"), result.mediaCutoffMs);
          cacheFilesDeleted += pruneFilesOlderThan(join(uploadsDir, ".segment-clips"), result.mediaCutoffMs);
          if (archiveSegments) {
            cacheFilesDeleted += pruneFilesOlderThan(segmentArchiveDir, result.mediaCutoffMs, (path) => {
              const name = basename(path);
              if (name.endsWith(".json")) forgetSegmentArchiveIndex(name.slice(0, -".json".length));
            });
          }
        }

        const changed = result.mediaFilesDeleted
          + result.mediaReferencesExpired
          + result.pipelineRowsDeleted
          + result.notificationRowsDeleted
          + result.errorRowsDeleted
          + result.traceRowsDeleted
          + result.llmCallRowsDeleted
          + result.memoryWriteFailureRowsDeleted
          + cacheFilesDeleted
          + expiredMediaInMem;
        if (changed > 0) {
          logger.info(
            `[retention] ${reason}: media_days=${mediaRetentionDays} text_days=${textRetentionDays} ` +
            `media_files=${result.mediaFilesDeleted} media_refs=${result.mediaReferencesExpired} mem_media=${expiredMediaInMem} ` +
            `cache_files=${cacheFilesDeleted} pipeline=${result.pipelineRowsDeleted} traces=${result.traceRowsDeleted} ` +
            `llm_calls=${result.llmCallRowsDeleted} notifications=${result.notificationRowsDeleted} ` +
            `errors=${result.errorRowsDeleted} memory_failures=${result.memoryWriteFailureRowsDeleted}`,
          );
        }
      } catch (err) {
        logger.warn(`[retention] ${reason} failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        retentionRunning = false;
      }
    };

    api.registerService({
      id: "local-retention",
      async start() {
        logger.info(
          `[retention] local retention enabled: media_days=${mediaRetentionDays}, text_days=${textRetentionDays}, interval_hours=${retentionIntervalHours}`,
        );
        void runLocalRetention("startup");
        retentionTimer = setInterval(() => { void runLocalRetention("interval"); }, retentionIntervalMs);
        retentionTimer.unref?.();
      },
      async stop() {
        if (!retentionTimer) return;
        clearInterval(retentionTimer);
        retentionTimer = null;
      },
    });

    // ── Notifier: dual-path push (direct for alerts, subagent for summaries) ──
    let notifier: Notifier | null = null;

    // Default dispatcher: submit segment policy consultations to OpenClaw. The
    // decision itself should happen in OpenClaw, not synchronously inside
    // Cortex.
    const defaultConsultationDispatcher: ConsultationDispatcher = {
      async submitConsultation({ eventText, camera_id }) {
        try {
          api.runtime.system.enqueueSystemEvent(eventText, { sessionKey: "agent:main:main" });
          const hasHeartbeat = typeof api.runtime.system.requestHeartbeatNow === "function";
          if (hasHeartbeat) {
            api.runtime.system.requestHeartbeatNow!({ reason: "exec-event", coalesceMs: 2000 });
          }
          logger.info(`[vision-controller] Agent consultation queued for ${camera_id} (heartbeat=${hasHeartbeat})`);
        } catch (err) {
          logger.error(`[vision-controller] Failed to enqueue consultation: ${err instanceof Error ? err.message : err}`);
        }
        return null;
      },
    };

    // Accept pluggable dispatcher via config. For backward compatibility, an
    // old-style `consultation_handler.onConsult(...)` object is still accepted.
    const configuredDispatcher = (
      config.consultation_dispatcher
      ?? config.consultation_handler
    ) as ConsultationDispatcher | ConsultationHandler | undefined;
    const applyConsultationToolCalls = (config as Record<string, unknown>).apply_consultation_tool_calls === true;
    const consultationDispatcher: ConsultationDispatcher = configuredDispatcher
      ? ("submitConsultation" in configuredDispatcher
          ? configuredDispatcher
          : { submitConsultation: (context) => configuredDispatcher.onConsult(context) })
      : defaultConsultationDispatcher;

    /** Extract sub-path after /media/ marker (e.g. "cam_5/keyframe/seg_xxx.jpg"). */
    function toMediaSubpath(absPath: string | undefined): string | undefined {
      if (!absPath) return undefined;
      const marker = "/media/";
      const idx = absPath.indexOf(marker);
      return idx >= 0 ? absPath.slice(idx + marker.length) : absPath;
    }

    // ── Memory write scheduler: serializes actual storePerception attempts ──
    // Failed attempts are retried after a delay without occupying the serial
    // queue, so one camera's transient memory failure does not block all others.
    const memoryWriteScheduler = new MemoryWriteScheduler({
      maxSize: 500, // large enough to never drop — memory writes are correctness-sensitive
      maxAttempts: 2,
      retryDelayMs: 2_000,
      onHookError: (err, hook) => {
        logger.warn(`[memory-write] ${hook} hook failed: ${err instanceof Error ? err.message : String(err)}`);
      },
    });
    (globalThis as any).__cortex_waitForMemoryIdle = () => memoryWriteScheduler.waitForIdle();

    // ── Memory adapter: all Memory-service interactions used by Percept ──
    const userIdByCamera = new Map<string, string>();
    const sessionIdByCamera = new Map<string, string>();
    const storePerceptionByUser = new Map<string, ReturnType<typeof createMemoryStorePerception>>();
    const reidAdapterByUser = new Map<string, PipelineMemory>();
    const reidAnalysisContext = new AsyncLocalStorage<{ userId: string; cameraId: string }>();
    const getMemoryUserIdForCamera = (cameraId: string): string => userIdByCamera.get(cameraId) ?? memoryUserId;
    const getStorePerception = (userId: string) => {
      const existing = storePerceptionByUser.get(userId);
      if (existing) return existing;
      const created = createMemoryStorePerception({
        memClient: memoryClient,
        userId,
        ...(resolvedPerceptionConfig.runtime_mode === "live_latency" ? { semanticMode: "background" as const } : {}),
        onStored(addResponse, context) {
        const { segmentAnalysis, memorySubjects, entityObservations, result, segment } = context;
        const memoryCounts = Object.entries(countAddMemoryTypes(addResponse))
          .map(([type, count]) => `${type}=${count}`)
          .join(" ");

        // Episodic monitor events are published from onPipelineComplete, where
        // notification metadata is available. Publishing here as well races and
        // can overwrite a notified segment with a later "normal" event.

        // Semantic monitor events are handled by Python service webhook
        // (services/mem/src/main.py notify_monitor) — no duplicate publish here.
        logger.info(
          `[memory-write] Written ${segment.segment_id} camera=${segment.camera_id} ` +
          `targets=${memorySubjects.length} entity_data=${entityObservations.length} results=${addResponse.results.length}` +
          (memoryCounts ? ` ${memoryCounts}` : ""),
        );
      },
      });
      storePerceptionByUser.set(userId, created);
      return created;
    };
    const getReidAdapter = (userId: string): PipelineMemory => {
      const existing = reidAdapterByUser.get(userId);
      if (existing) return existing;
      const created = createMemoryReidAdapter({
        memClient: memoryClient,
        userId,
        cameraId: () => reidAnalysisContext.getStore()?.cameraId,
      });
      reidAdapterByUser.set(userId, created);
      return created;
    };
    const getCurrentReidAdapter = (): PipelineMemory => {
      return getReidAdapter(reidAnalysisContext.getStore()?.userId ?? memoryUserId);
    };
    const reidWriteLocksByUser = new Map<string, Promise<void>>();
    const withCurrentReidWriteLock = async <T>(fn: () => Promise<T>): Promise<T> => {
      const userId = reidAnalysisContext.getStore()?.userId ?? memoryUserId;
      const previous = reidWriteLocksByUser.get(userId) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => current, () => current);
      reidWriteLocksByUser.set(userId, tail);
      await previous.catch(() => undefined);
      try {
        return await fn();
      } finally {
        release();
        if (reidWriteLocksByUser.get(userId) === tail) {
          reidWriteLocksByUser.delete(userId);
        }
      }
    };
    const runWithCameraMemoryUser = <T>(cameraId: string, fn: () => T): T => {
      return reidAnalysisContext.run({ userId: getMemoryUserIdForCamera(cameraId), cameraId }, fn);
    };
    const memoryAdapter: PipelineMemory = {
      async storePerception(result, segment) {
        const startedAt = Date.now();
        if (result._archive?.memory_write) {
          result._archive.memory_write = {
            ...result._archive.memory_write,
            attempted: true,
            status: "pending",
          };
        }
        // Enqueue into memoryWriteScheduler for serialized, bounded execution.
        // Returns a Promise that resolves/rejects when the final write state is
        // known, preserving the contract that pipeline's writeMemoryHistory uses.
        const queueDepthAtEnqueue = memoryWriteScheduler.depth;
        logger.info(`[memory-write] Enqueuing for ${segment.segment_id} camera=${segment.camera_id} url=${cortex.endpoint} (depth: ${queueDepthAtEnqueue})`);
        return memoryWriteScheduler.enqueue({
          run: async ({ attempt, queueWaitMs }) => {
            if (result._trace) {
              result._trace.context.decision_context ??= {};
              result._trace.context.decision_context.memory_profile = {
                ...result._trace.context.decision_context.memory_profile,
                queue_wait_ms: queueWaitMs,
                queue_depth_at_enqueue: queueDepthAtEnqueue,
                retry_count: attempt,
              };
            }
            await getStorePerception(getMemoryUserIdForCamera(segment.camera_id))(result, segment);
          },
          onRetry: ({ error, nextAttempt, delayMs }) => {
            const msg = error instanceof Error ? error.message : String(error);
            logger.warn(`[memory-write] RETRY ${segment.segment_id} camera=${segment.camera_id} attempt=${nextAttempt + 1}/2 in ${delayMs}ms: ${msg}`);
            if (result._archive?.memory_write) {
              result._archive.memory_write = {
                ...result._archive.memory_write,
                retry_count: nextAttempt,
                error: msg,
              };
              patchSegmentArchive(result);
            }
          },
          onSuccess: ({ attempts }) => {
            runtimeHealth.observe({
              component: "memory",
              operation: "write",
              status: "ok",
              scope: {
                user_id: getMemoryUserIdForCamera(segment.camera_id),
                source_id: segment.camera_id,
              },
            });
            if (result._archive?.memory_write) {
              result._archive.memory_write = {
                ...result._archive.memory_write,
                status: "ok",
                retry_count: attempts - 1,
                latency_ms: Date.now() - startedAt,
              };
              patchSegmentArchive(result);
            }
          },
          onFinalError: ({ error, attempts }) => {
            runtimeHealth.observe({
              component: "memory",
              operation: "write",
              status: "down",
              code: "write_failed",
              scope: {
                user_id: getMemoryUserIdForCamera(segment.camera_id),
                source_id: segment.camera_id,
              },
            });
            const msg = error instanceof Error ? error.message : String(error);
            logger.error(`[memory-write] FAILED ${segment.segment_id}: ${msg}`);
            if (result._archive?.memory_write) {
              result._archive.memory_write = {
                ...result._archive.memory_write,
                status: "error",
                retry_count: Math.max(0, attempts - 1),
                latency_ms: Date.now() - startedAt,
                error: msg,
              };
              patchSegmentArchive(result);
            }
            try {
              const userId = getMemoryUserIdForCamera(segment.camera_id);
              const { request } = buildPerceptionAddRequest({ result, segment, userId });
              store.logMemoryWriteFailure({
                segment_id: result.segment_id,
                camera_id: result.camera_id,
                user_id: userId,
                attempts,
                error: msg,
                request,
              });
            } catch (deadLetterErr) {
              logger.error(`[memory-write] Failed to record dead-letter for ${segment.segment_id}: ${deadLetterErr instanceof Error ? deadLetterErr.message : deadLetterErr}`);
            }
            store.logError(result.segment_id, result.camera_id, "cortex", msg);
          },
        });
      },
    };

    // ── PostProcessor: VLM-decided notifications + pipeline logging ──
    const postProcessor: PostProcessor = {
      getNotifyPolicy(cameraId: string): "always" | "smart" | "security_only" {
        const ws = loadPersistedWatchStates().find((w) => w.id === cameraId);
        return (ws?.notifyPolicy as NotifyPolicy) ?? "smart";
      },

      async sendNotifications(notifications, cameraId, keyframePath) {
        const deliveryState = notificationDeliveryState(notifications);
        const recordDelivery = (index: number, delivery: DeliveryResult): void => {
          deliveryState.results[index] = delivery;
          const logId = deliveryState.logIds[index];
          if (logId != null) {
            try {
              store.updateNotificationDelivery(logId, delivery);
            } catch (err) {
              logger.error(`Notification delivery update failed: ${err instanceof Error ? err.message : err}`);
            }
          }
        };
        if (!notifier) {
          notifications.forEach((_, index) => {
            recordDelivery(index, {
              delivered: false,
              delivery_ms: 0,
              delivery_error: "notifier unavailable",
            });
          });
          return;
        }
        // Look up the originating session key for this camera
        const watchStates = loadPersistedWatchStates();
        const watchState = watchStates.find((ws) => ws.id === cameraId);
        const sessionKey = watchState?.sessionKey;

        // Decision explanation: if Semantic Context declares "Explain Decisions",
        // enrich notifications with VC reasoning (what rule fired and what action was taken).
        if (explainDecisionsPerCamera.has(cameraId)) {
          const lastRuleInfo = lastVcRuleFired.get(cameraId);
          if (lastRuleInfo) {
            for (const n of notifications) {
              n.message += `\n[Decision: ${lastRuleInfo}]`;
            }
          }
        }

        for (let index = 0; index < notifications.length; index++) {
          const n = notifications[index]!;
          const startedAt = Date.now();
          let delivery: Promise<DeliveryResult>;
          switch (n.type) {
            case "alert":
            case "admin_command":
              // Path A: direct channel send for safety-critical notifications
              delivery = notifier.sendAlert(
                n.type === "admin_command" ? `[ADMIN] ${n.message}` : n.message,
                cameraId,
                sessionKey,
                keyframePath,
              );
              break;
            case "summary":
              // Path B: subagent formats and delivers
              delivery = notifier.sendSummary(n.message, cameraId, sessionKey, keyframePath);
              break;
            case "identify":
              // Path B: subagent formats and delivers
              delivery = notifier.sendIdentify(n.message, cameraId, sessionKey, keyframePath);
              break;
            default:
              delivery = Promise.resolve({ delivered: false, delivery_ms: 0, delivery_error: `unknown type: ${n.type}` });
          }
          recordDelivery(index, await withNotificationTimeout(delivery, startedAt));
        }
      },

      onPipelineComplete(result, segment, meta) {
        if (clearedDashboardSources.has(segment.camera_id) || clearedDashboardSources.has(result.camera_id)) {
          logger.info(`[dashboard-clear] dropping late pipeline result for cleared source ${segment.camera_id} segment=${result.segment_id}`);
          return;
        }
        monitorBus.publish("system:pipeline_metrics", {
          segment_id: result.segment_id,
          camera_id: result.camera_id,
          mode: result.mode,
          level: result.perception_memory.perception_level,
          vlm_latency_ms: meta.vlm?.vlm_latency_ms ?? 0,
          vlm_model: meta.vlm?.vlm_model ?? "none",
          notify_user: meta.vlm?.notify_user ?? false,
          notification_count: meta.notifications.length,
          policy: meta.policy,
          frames: segment.frames.length,
        }, result.camera_id);

        // Publish episodic memory event to Monitor (moved here from storeMemory
        // so notification data is available for server-assisted rule matching).
        const pm = result.perception_memory;
        if (!pm.summary.startsWith("[")) {
          const notificationFired = meta.notifications.length > 0;
          const dashboardUserId = userIdByCamera.get(segment.camera_id);
          const dashboardSessionId = sessionIdByCamera.get(segment.camera_id);
          monitorBus.publish("memory:memory_added", {
            camera_id: segment.camera_id,
            segment_id: result.segment_id,
            ...(dashboardUserId ? { user_id: dashboardUserId } : {}),
            ...(dashboardSessionId ? { session_id: dashboardSessionId } : {}),
            mode: segment.mode,
            memory_type: "episodic",
            event_id: result.event_id,
            segment_start: segment.timestamp,
            duration_sec: segment.duration_sec,
            is_static: pm.is_static_scene === true,
            summary_preview: pm.summary,
            detailed_summary: pm.detailed_summary,
            notification_fired: notificationFired,
            notification_reasons: notificationFired
              ? meta.notifications.map((n: { message: string }) => n.message)
              : undefined,
          }, segment.camera_id);
        }

        try {
          store.logResult(segment, result, meta.vlm ? {
            notify_user: meta.vlm.notify_user,
            is_static_scene: meta.vlm.is_static_scene,
            best_frame_index: meta.vlm.best_frame_index,
            vlm_model: meta.vlm.vlm_model,
            vlm_latency_ms: meta.vlm.vlm_latency_ms,
          } : undefined);
        } catch (err) {
          logger.error(`Store log failed: ${err instanceof Error ? err.message : err}`);
        }
        try {
          writeSegmentArchive(result);
        } catch (err) {
          logger.error(`Segment archive write failed: ${err instanceof Error ? err.message : err}`);
        }

        // Profiling trace saved via monitorBus listener (see below)

        const deliveryState = notificationDeliveryState(meta.notifications);

        for (let i = 0; i < meta.notifications.length; i++) {
          const n = meta.notifications[i]!;
          const dr = deliveryState.results[i];
          const status = dr ? (dr.delivered ? "delivered" : "failed") : "delivery_pending";
          try {
            const logId = store.logNotification({
              segment_id: result.segment_id,
              camera_id: result.camera_id,
              type: n.type,
              message: n.message,
              policy: meta.policy,
              path: n.type === "alert" || n.type === "admin_command" ? "direct" : "subagent",
              keyframe_path: result.media_urls?.keyframes?.[0],
              status,
              delivered: dr?.delivered,
              delivery_error: dr?.delivery_error,
              delivery_ms: dr?.delivery_ms,
            });
            deliveryState.logIds[i] = logId;
          } catch (err) {
            logger.error(`Notification log failed: ${err instanceof Error ? err.message : err}`);
          }
        }

        // Semantic Context: buffer observations and check triggers (async, non-blocking)
        if (semanticContextManager) {
          const entities = (result.perception_memory.entities ?? []).map((e) => ({
            entity_id: e.entity_id,
            track_id: e.track_id,
            type: e.type,
            appearance: e.appearance,
            is_new_entity: e.is_new_entity,
          }));
          const identityCues = [
            ...(result.perception_memory.entities ?? [])
              .filter((entity) => entity.name)
              .map((entity) => ({
                name: entity.name!,
                entity_id: entity.entity_id,
                segment_id: result.segment_id,
                track_id: entity.track_id,
                evidence: entity.identity_evidence,
                source: "target_identity" as const,
              })),
          ];
          semanticContextManager.onSegmentProcessed(
            result.camera_id,
            result.perception_memory.summary,
            entities,
            identityCues,
          ).catch((err) => {
            logger.error(`[semantic-context] onSegmentProcessed failed: ${err instanceof Error ? err.message : err}`);
          });
        }
      },

      onPipelineError(segmentId, cameraId, stage, message) {
        store.logError(segmentId, cameraId, stage, message);
      },

      onCaptureHint(cameraId, hint) {
        logger.info(`[adaptive] ${cameraId}: ${hint.action} — ${hint.reason}`);
        monitorBus.publish("system:capture_hint", {
          camera_id: cameraId,
          action: hint.action,
          reason: hint.reason,
          suggested_fps: hint.suggestedFps,
        }, cameraId);
      },
    };

    // ── Runtime config changes from dashboard Settings ──
    monitorBus.on("monitor", (event) => {
      if ((event.type as string) !== "system:config_changed") return;
      const key = event.data.key as string;
      const value = event.data.value as string;
      switch (key) {
        case "vlm_model":
          // StrategyManager supports hot-swap of VLM model override
          if (value === "auto") {
            pipelineDeps.strategyManager.setVlmModels({
              modelLite: resolvedPerceptionConfig.vlm_model_lite,
              modelFull: resolvedPerceptionConfig.vlm_model,
            });
          } else {
            pipelineDeps.strategyManager.setVlmModels({ modelLite: value, modelFull: value });
          }
          logger.info(`[config] VLM model override set to: ${value}`);
          break;
        case "analysis_level": {
          // "auto" clears override, numeric sets maxLevel for all cameras.
          const targetCameraIds = new Set<string>([
            ...loadPersistedWatchStates().map((state) => state.id),
            ...activeAnalyses.keys(),
          ]);
          if (value === "auto") {
            for (const cameraId of targetCameraIds) pipelineDeps.strategyManager.clearFramePolicyOverride(cameraId);
          } else {
            const level = parseInt(value, 10) as 0 | 1 | 2;
            for (const cameraId of targetCameraIds) {
              pipelineDeps.strategyManager.setFramePolicyOverride(cameraId, { maxLevel: level });
            }
          }
          logger.info(`[config] Analysis level override set to: ${value}`);
          break;
        }
        case "capture_mode":
          // Cam mode switching requires executeCam; applied to all active cameras
          if (executeCam) {
            const watchStates = loadPersistedWatchStates();
            for (const ws of watchStates) {
              executeCam("switch_mode", { name: ws.id, mode: value }).catch((err) => {
                logger.error(`[config] switch_mode failed for ${ws.id}: ${err instanceof Error ? err.message : err}`);
              });
            }
          }
          logger.info(`[config] Capture mode set to: ${value}`);
          break;
        case "sampling_rate": {
          // Apply new sampling rate to all active cameras
          const fps = parseFloat(value);
          if (executeCam && !isNaN(fps)) {
            const watchStates = loadPersistedWatchStates();
            for (const ws of watchStates) {
              executeCam("set_sampling", { name: ws.id, fps }).catch((err) => {
                logger.error(`[config] set_sampling failed for ${ws.id}: ${err instanceof Error ? err.message : err}`);
              });
            }
          }
          logger.info(`[config] Sampling rate set to: ${value}`);
          break;
        }
        case "audio_model":
          // Audio model hot-swap not supported yet; stored for next pipeline restart
          logger.info(`[config] Audio model set to: ${value} (takes effect on next restart)`);
          break;
      }
    });


    // ── Clean up per-camera state when watch stops ──
    monitorBus.on("monitor", (event) => {
      if (event.type === "cam:segment_built") {
        const cameraId = (event.data?.camera_id as string | undefined) ?? event.camera_id;
        const active = cameraId ? activeAnalyses.get(cameraId) : undefined;
        if (active) active.segments_count += 1;
      }
      if (event.type === "cam:watch_stopped") {
        const cameraId = event.data?.source_id as string | undefined;
        if (!cameraId) return;
        void cleanupCameraRuntime(cameraId);
      }
    });

    // ── Save profiling traces to SQLite and correlate consultation follow-up ──
    monitorBus.on("monitor", (event) => {
      if (event.type === "system:pipeline_trace") {
        try { store.saveTrace(event.data as any); } catch { /* best-effort */ }
      }
      if (event.type === "system:tool_invoked") {
        const cameraId = event.camera_id;
        const pending = cameraId ? pendingConsultations.get(cameraId) : undefined;
        if (!pending) return;
        const now = Date.now();
        if (now - pending.submittedAt > 120_000) {
          pendingConsultations.delete(cameraId!);
          return;
        }
        monitorBus.publish("vision_controller:consultation_effect_observed", {
          consultation_id: pending.consultationId,
          segment_id: pending.segmentId,
          tool: event.data.tool,
          action: event.data.action,
          success: event.data.success ?? true,
          latency_ms: now - pending.submittedAt,
          tool_details: event.data,
        }, cameraId);
        pendingConsultations.delete(cameraId!);
      }
    });

    // ── User rules provider: fetches from Cortex procedural collection ──
    // Caches per camera_id; merges global rules + per-camera rules.
    const rulesCache = new Map<string, { rules: string | undefined; expiry: number }>();
    const RULES_CACHE_TTL_MS = 30_000; // refresh every 30s

    const fetchUserRules = async (cameraId: string): Promise<string | undefined> => {
      const cacheKey = cameraId;
      const now = Date.now();
      const cached = rulesCache.get(cacheKey);
      if (cached && now < cached.expiry) return cached.rules;

      try {
        // Query global rules + camera-specific rules in parallel
        const [globalRaw, cameraRaw] = await Promise.all([
          memoryClient.getMemories({ camera_id: "global", memory_type: "procedural", limit: 50 }),
          cameraId !== "global"
            ? memoryClient.getMemories({ camera_id: cameraId, memory_type: "procedural", limit: 50 })
            : Promise.resolve([]),
        ]);
        // Cortex may return collection-keyed object { "coll_name": [...] } or []
        const flattenMemories = (raw: unknown): Array<{ id: string; memory: string }> => {
          if (Array.isArray(raw)) return raw;
          if (raw && typeof raw === "object") {
            // { "coll_procedural": [item1, item2] } → [item1, item2]
            const values = Object.values(raw as Record<string, unknown>);
            return values
              .filter((v): v is Array<{ id: string; memory: string }> => Array.isArray(v))
              .flat();
          }
          return [];
        };
        const globalItems = flattenMemories(globalRaw);
        const cameraItems = flattenMemories(cameraRaw);

        const allItems = [...globalItems, ...cameraItems];
        const rules = allItems.length === 0
          ? undefined
          : allItems
            .filter((item) => typeof item.id === "string" && item.id.trim() && typeof item.memory === "string" && item.memory.trim())
            .map((item) => `- rule_id=${item.id}: ${item.memory}`)
            .join("\n");
        rulesCache.set(cacheKey, { rules, expiry: now + RULES_CACHE_TTL_MS });
        return rules;
      } catch (err) {
        logger.error(`Failed to fetch user rules: ${err instanceof Error ? err.message : err}`);
        // Keep stale cache on error
        return cached?.rules;
      }
    };

    // ── Build perception pipeline deps ──
    const pipelineDeps = await createPipelineDeps(resolvedPerceptionConfig, store);
    memoryAdapter.fetchUserRules = fetchUserRules;
    pipelineDeps.memory = memoryAdapter;
    pipelineDeps.postProcessor = postProcessor;
    pipelineDeps.logging = {
      archiveSegments,
      promptVersion: process.env.CORTEX_GIT_COMMIT
        ?? process.env.EVAL_GIT_COMMIT
        ?? process.env.BENCH_GIT_COMMIT
        ?? process.env.CORTEX_PROMPT_VERSION,
      llmContext: {
        run_id: process.env.CORTEX_RUN_ID,
        snapshot_version: process.env.CORTEX_SNAPSHOT_VERSION,
      },
    };
    pipelineDeps.vlmAnalyzer.setLlmCallRecorder((call) => {
      try { store.saveLlmCall(call); } catch { /* best-effort */ }
    });

    // ── NarrativeMemory: video-level cognitive layer ──
    const { NarrativeMemory } = await import("@cortex/percept");
    const narrativeMemory = new NarrativeMemory({
      baseDir: join(stateDir, "narratives"),
      memClient: memoryClient,
      userId: memoryUserId,
      schemaEventBudget: 5,
      schemaMaxIntervalMs: 3_600_000,
      llm: (prompt, options) => {
        const mode = options?.stage === "narrative.schema_summary"
          ? "schema_summary"
          : options?.stage === "narrative.chapter_summary"
            ? "chapter_summary"
            : "default";
        const profile = resolveVlmCallProfile({
          model: resolvedPerceptionConfig.llm_model,
          stage: "narrative_memory",
          mode,
        });
        return pipelineDeps.vlmAnalyzer.compressText(prompt, {
          ...options,
          maxTokens: options?.maxTokens ?? profile.maxOutputTokens,
          reasoningEffort: options?.reasoningEffort ?? profile.reasoning,
          temperature: options?.temperature ?? profile.temperature,
          promptVersion: pipelineDeps.logging?.promptVersion,
          llmContext: { ...pipelineDeps.logging?.llmContext, ...options?.llmContext },
        });
      },
    });
    pipelineDeps.narrativeMemory = narrativeMemory;

    // Wire narrative callbacks onto WorkingMemory
    pipelineDeps.workingMemory.setNarrativeCallbacks({
      onContextCompressed: (cameraId, compressed, entitySnapshot) => {
        narrativeMemory.onContextCompressed(cameraId, compressed, entitySnapshot);
      },
      onEventClosed: (cameraId, summary) => {
        narrativeMemory.onEventClosed(cameraId, summary);
        recordEventClose(summary);
      },
    });

    // ── Semantic Context: per-camera persistent scene profiles ──
    const semanticContextManager = new SemanticContextManager({
      memClient: memoryClient,
      userId: memoryUserId,
      getSegmentCount: (cameraId) => store.getSegmentCount(cameraId),
      onLlmUpdate: async (cameraId, currentProfile, observations): Promise<SummarizationResult> => {
        const prompt = buildSummarizationPrompt(currentProfile, observations);
        const semanticContextProfile = resolveVlmCallProfile({
          model: resolvedPerceptionConfig.vlm_model_lite,
          stage: "semantic_context",
        });
        try {
          const jsonText = await pipelineDeps.vlmAnalyzer.completeText(prompt, {
            responseFormat: "json",
            model: resolvedPerceptionConfig.vlm_model_lite,
            stage: "semantic_context.profile_summary",
            maxTokens: semanticContextProfile.maxOutputTokens,
            reasoningEffort: semanticContextProfile.reasoning,
            temperature: semanticContextProfile.temperature,
            promptVersion: pipelineDeps.logging?.promptVersion,
            llmContext: { ...pipelineDeps.logging?.llmContext, camera_id: cameraId },
          });
          const result = JSON.parse(jsonText) as SummarizationResult;
          const hasProfileUpdate = [
            result.scene_description,
            result.known_entities,
            result.daily_routine,
            result.anomaly_baseline,
          ].some((value) => typeof value === "string" && value.trim().length > 0);
          if (result.no_update === true || hasProfileUpdate) {
            return result;
          }
          throw new Error("invalid SemanticContext LLM result: missing no_update=true or profile update fields");
        } catch (err) {
          logger.error(`[semantic-context] LLM update failed: ${err instanceof Error ? err.message : err}`);
          throw err; // Rethrow — manager preserves buffer and metadata on failure
        }
      },
      onAgentConsult: async (cameraId, currentProfile, observationSummary) => {
        const eventText = `[Semantic Context Review] Camera "${cameraId}" has accumulated new observations. Current profile:\n${currentProfile}\n\nRecent observations:\n${observationSummary}\n\nReview the semantic context profile and update if needed using cortex_perception configure action with semantic_context_notes.`;
        try {
          api.runtime.system.enqueueSystemEvent(eventText, { sessionKey: "agent:main:main" });
          if (typeof api.runtime.system.requestHeartbeatNow === "function") {
            api.runtime.system.requestHeartbeatNow!({ reason: "semantic-context-consult", coalesceMs: 5000 });
          }
          logger.info(`[semantic-context] Agent consultation queued for ${cameraId}`);
        } catch (err) {
          logger.error(`[semantic-context] Agent consultation failed: ${err instanceof Error ? err.message : err}`);
          throw err; // Rethrow so .then() metadata update is skipped on failure
        }
      },
    });
    // Wrap semanticContext.load to parse intelligence directives (explainDecisions flag)
    const origLoad = semanticContextManager.load.bind(semanticContextManager);
    const setSemanticContextUserBackground = async (input: {
      cameraId: string;
      content: string | undefined;
      source: "dashboard" | "perception_tool" | "tool" | "api";
    }): Promise<{ ok: true; camera_id: string; initialized: boolean; content_length: number } | { ok: false; error: string }> => {
      const cameraId = input.cameraId.trim();
      if (!cameraId) return { ok: false, error: "camera_id is required" };
      const text = input.content?.trim();
      if (!text) return { ok: true, camera_id: cameraId, initialized: false, content_length: 0 };
      const clipped = text.slice(0, 4000);
      try {
        await semanticContextManager.setUserBackground(cameraId, clipped);
        monitorBus.publish("semantic_context:user_background_updated", {
          camera_id: cameraId,
          source: input.source,
          content_length: clipped.length,
        }, cameraId);
        return { ok: true, camera_id: cameraId, initialized: true, content_length: clipped.length };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[semantic-context] init failed for ${cameraId} source=${input.source}: ${message}`);
        return { ok: false, error: message };
      }
    };
    pipelineDeps.semanticContext = {
      onSegmentProcessed: semanticContextManager.onSegmentProcessed.bind(semanticContextManager),
      clearBuffer: semanticContextManager.clearBuffer.bind(semanticContextManager),
      setUserNotes: semanticContextManager.setUserNotes.bind(semanticContextManager),
      setUserBackground: semanticContextManager.setUserBackground.bind(semanticContextManager),
      initProfile: async (cameraId: string, sceneDescription: string) => {
        const result = await setSemanticContextUserBackground({
          cameraId,
          content: sceneDescription,
          source: "perception_tool",
        });
        if (!result.ok) throw new Error(result.error);
      },
      updateDirectives: semanticContextManager.updateDirectives.bind(semanticContextManager),
      async load(cameraId: string) {
        const content = await origLoad(cameraId);
        if (content) {
          const { parseSemanticContextSections } = await import("@cortex/percept");
          const sections = parseSemanticContextSections(content);
          if (sections.explainDecisions) explainDecisionsPerCamera.add(cameraId);
          else explainDecisionsPerCamera.delete(cameraId);
        }
        return content;
      },
    };
    pipelineDeps.getSegmentCount = (cameraId) => store.getSegmentCount(cameraId);
    pipelineDeps.subjectRegistry = {
      createSession(cameraId: string) {
        return store.createSubjectIndexSession(getMemoryUserIdForCamera(cameraId), cameraId);
      },
    };

    const setDashboardSemanticContextUserBackground = async (cameraId: string, raw?: string): Promise<string | null> => {
      const result = await setSemanticContextUserBackground({ cameraId, content: raw, source: "dashboard" });
      return result.ok ? null : "Semantic Context background update failed - analysis continues without it";
    };

    if (visionController) {
      pipelineDeps.visionControllerEnabled = true;

      // Wire segment policy exit prompt injection into VLM.
      pipelineDeps.getSegmentPolicyExitPrompt = (cameraId: string) => {
        const segmentPolicy = visionController.getSegmentPolicyState(cameraId);
        if (!segmentPolicy?.exitCondition) return undefined;
        return formatAdaptivePromptForDisplay(
          activeAdaptivePromptConfigByCamera.get(cameraId),
          segmentPolicy.exitCondition,
        );
      };

      pipelineDeps.onVisionControllerConfigure = (vcConfig) => {
        const enabledFlag = vcConfig.vc_enabled;
        if (enabledFlag !== undefined) {
          visionController.reconfigure({ enabled: Boolean(enabledFlag) });
        }
        const rulesJson = vcConfig.vc_rules_json;
        if (typeof rulesJson === "string") {
          try {
            const rules = JSON.parse(rulesJson);
            visionController.reconfigure({ rules });
            return `Added ${rules.length} rules`;
          } catch { return "Invalid vc_rules_json"; }
        }
        const triggerJson = vcConfig.vc_segment_policy_json;
        if (typeof triggerJson === "string") {
          try {
            const tp = JSON.parse(triggerJson);
            visionController.reconfigure({ segment_policy: tp });
            return "Segment policy updated";
          } catch { return "Invalid vc_segment_policy_json"; }
        }
        return `VisionController updated: ${JSON.stringify(visionController.getConfig().rules?.length ?? 0)} rules`;
      };
    }

    // ── Wire STT analyzer (Moonshine Tiny via sherpa-onnx-node) ──
    const sttModelDir = resolvedPerceptionConfig.stt_model_dir
      || join(homeDir, "models", "sherpa-onnx-moonshine-tiny-en-int8");
    if (resolvedPerceptionConfig.stt_provider === "moonshine" && sttModelDir) {
      try {
        const { SttAnalyzer } = await import("@cortex/percept");
        const stt = new SttAnalyzer({
          modelDir: sttModelDir,
          numThreads: resolvedPerceptionConfig.stt_num_threads,
        });
        const ok = await stt.init();
        if (ok) {
          pipelineDeps.sttAnalyzer = stt;
          logger.info(`[stt] Moonshine Tiny STT ready (threads=${resolvedPerceptionConfig.stt_num_threads})`);
        } else {
          logger.warn(`[MODEL WARNING] STT init failed for ${sttModelDir}; STT disabled`);
        }
      } catch (err) {
        logger.warn(`[MODEL WARNING] STT setup failed for ${sttModelDir}; STT disabled: ${err instanceof Error ? err.message : err}`);
      }
    }

    // ── Wire Memory ReID operations (face + body) ──
    if (!resolvedPerceptionConfig.stubs_only) {
      const defaultReidAdapter = getReidAdapter(memoryUserId);
      memoryAdapter.reidSearch = (embedding, type) => getCurrentReidAdapter().reidSearch!(embedding, type);
      memoryAdapter.reidUpsert = (embeddings, identity) => getCurrentReidAdapter().reidUpsert!(embeddings, identity);
      memoryAdapter.reidGalleryUpdate = (entityId, embeddings) =>
        getCurrentReidAdapter().reidGalleryUpdate?.(entityId, embeddings) ?? Promise.resolve();
      memoryAdapter.withReidWriteLock = withCurrentReidWriteLock;
      if (defaultReidAdapter.reserveEntityId && defaultReidAdapter.reidBatchInit) {
        memoryAdapter.reserveEntityId = () => getCurrentReidAdapter().reserveEntityId!();
        memoryAdapter.reidBatchInit = (request) => getCurrentReidAdapter().reidBatchInit!(request);
      }
    }

    // ── Create FrameAnalyzer for per-frame frame policy detection ──
    const frameAnalyzer = pipelineDeps.router
      ? new FrameAnalyzer({ router: pipelineDeps.router })
      : null;

    // Debug: publish per-frame detection details to monitorBus.
    const debugFrames = !!config.debug_frames;

    const parseCamResult = (raw: string): Record<string, unknown> => {
      try {
        const parsed = JSON.parse(raw) as unknown;
        return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
      } catch {
        return { error: raw };
      }
    };

    const resolveExistingDashboardSourceId = async (name: string): Promise<string | null> => {
      if (!executeCam) return null;
      const listResult = parseCamResult(await executeCam("list_sources", {}));
      const sources = Array.isArray(listResult.sources) ? listResult.sources : [];
      for (const source of sources) {
        if (!source || typeof source !== "object") continue;
        const item = source as Record<string, unknown>;
        const id = typeof item.id === "string" ? item.id : "";
        const sourceName = typeof item.name === "string" ? item.name : "";
        if (id === name || sourceName === name) return id || sourceName;
      }
      return null;
    };

    const publicAnalysis = ({ sourcePath: _sourcePath, ...item }: AnalysisStatusItem & { sourcePath?: string }) => item;

    const readDashboardVideoSource = (cameraId: string): { videoId: string; createdAt: number; userId?: string; sessionId?: string } | null => {
      const sourceFile = join(resolvedSourcesDir, `${cameraId}.json`);
      if (!existsSync(sourceFile)) return null;
      try {
        const raw = JSON.parse(readFileSync(sourceFile, "utf-8")) as Record<string, unknown>;
        const input = typeof raw.input === "string" ? raw.input : "";
        if (!input) return null;
        const normalizedUploadsDir = uploadsDir.endsWith("/") ? uploadsDir : `${uploadsDir}/`;
        const videoId = input.startsWith(normalizedUploadsDir)
          ? `upload/${input.slice(normalizedUploadsDir.length)}`
          : input;
        const createdAt = typeof raw.created_at === "number" && Number.isFinite(raw.created_at)
          ? raw.created_at
          : Date.now();
        const userId = typeof raw.dashboard_user_id === "string" && raw.dashboard_user_id ? raw.dashboard_user_id : undefined;
        const sessionId = typeof raw.dashboard_session_id === "string" && raw.dashboard_session_id ? raw.dashboard_session_id : undefined;
        return { videoId, createdAt, ...(userId ? { userId } : {}), ...(sessionId ? { sessionId } : {}) };
      } catch {
        return null;
      }
    };

    const readDashboardSourceInfo = (cameraId: string): {
      name?: string;
      input?: string;
      protocol?: string;
      userId?: string;
      sessionId?: string;
      status?: "waiting" | "active" | "stopped" | "unavailable";
      mode?: "event" | "stream";
      fps?: number;
      width?: number;
      height?: number;
    } => {
      const sourceFile = join(resolvedSourcesDir, `${cameraId}.json`);
      if (!existsSync(sourceFile)) return {};
      try {
        const raw = JSON.parse(readFileSync(sourceFile, "utf-8")) as Record<string, unknown>;
        const config = raw.dashboard_config && typeof raw.dashboard_config === "object"
          ? raw.dashboard_config as Record<string, unknown>
          : {};
        const status = typeof raw.dashboard_status === "string" && ["waiting", "active", "stopped", "unavailable"].includes(raw.dashboard_status)
          ? raw.dashboard_status as "waiting" | "active" | "stopped" | "unavailable"
          : undefined;
        const mode = config.mode === "event" || config.mode === "stream" ? config.mode : undefined;
        const fps = typeof config.fps === "number" && Number.isFinite(config.fps) ? config.fps : undefined;
        const width = typeof config.width === "number" && Number.isFinite(config.width) ? config.width : undefined;
        const height = typeof config.height === "number" && Number.isFinite(config.height) ? config.height : undefined;
        return {
          ...(typeof raw.name === "string" && raw.name ? { name: raw.name } : {}),
          ...(typeof raw.input === "string" && raw.input ? { input: raw.input } : {}),
          ...(typeof raw.protocol === "string" && raw.protocol ? { protocol: raw.protocol } : {}),
          ...(typeof raw.dashboard_user_id === "string" && raw.dashboard_user_id ? { userId: raw.dashboard_user_id } : {}),
          ...(typeof raw.dashboard_session_id === "string" && raw.dashboard_session_id ? { sessionId: raw.dashboard_session_id } : {}),
          ...(status ? { status } : {}),
          ...(mode ? { mode } : {}),
          ...(typeof fps === "number" ? { fps } : {}),
          ...(typeof width === "number" ? { width } : {}),
          ...(typeof height === "number" ? { height } : {}),
        };
      } catch {
        return {};
      }
    };

    const writeDashboardSourcePatch = (cameraId: string, patch: Record<string, unknown>) => {
      const sourceFile = join(resolvedSourcesDir, `${cameraId}.json`);
      if (!existsSync(sourceFile)) return;
      try {
        const raw = JSON.parse(readFileSync(sourceFile, "utf-8")) as Record<string, unknown>;
        const nextConfig = patch.dashboard_config && typeof patch.dashboard_config === "object"
          ? {
              ...(raw.dashboard_config && typeof raw.dashboard_config === "object" ? raw.dashboard_config as Record<string, unknown> : {}),
              ...(patch.dashboard_config as Record<string, unknown>),
            }
          : raw.dashboard_config;
        writeFileSync(sourceFile, JSON.stringify({
          ...raw,
          ...patch,
          ...(nextConfig ? { dashboard_config: nextConfig } : {}),
        }, null, 2));
      } catch (err) {
        logger.warn(`[dashboard-source] failed to persist metadata for ${cameraId}: ${err instanceof Error ? err.message : err}`);
      }
    };

    const writeDashboardSourceStatus = (cameraId: string, status: "waiting" | "active" | "stopped" | "unavailable") => {
      writeDashboardSourcePatch(cameraId, { dashboard_status: status });
    };

    const writeDashboardSourceConfigSnapshot = (
      cameraId: string,
      snapshot: { mode?: "event" | "stream"; fps?: number; width?: number; height?: number },
    ) => {
      writeDashboardSourcePatch(cameraId, {
        dashboard_config: {
          ...(snapshot.mode ? { mode: snapshot.mode } : {}),
          ...(typeof snapshot.fps === "number" ? { fps: snapshot.fps } : {}),
          ...(typeof snapshot.width === "number" ? { width: snapshot.width } : {}),
          ...(typeof snapshot.height === "number" ? { height: snapshot.height } : {}),
        },
      });
    };

    const deleteDashboardSourceFile = (cameraId: string) => {
      try {
        rmSync(join(resolvedSourcesDir, `${cameraId}.json`), { force: true });
      } catch {
        // Best-effort cleanup only.
      }
    };

    const cleanupCameraRuntime = async (cameraId: string): Promise<void> => {
      pipelineDeps.workingMemory.closeCurrentEvent(cameraId);
      pipelineDeps.workingMemory.resetCamera(cameraId);
      activeAdaptivePromptConfigByCamera.delete(cameraId);
      if (pipelineDeps._runtimeState) clearCameraRuntimeState(pipelineDeps._runtimeState, cameraId);

      const FLUSH_TIMEOUT_MS = 5000;
      try {
        await Promise.race([
          narrativeMemory.flush(cameraId, { finalize: true }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("narrative flush timeout")), FLUSH_TIMEOUT_MS)),
        ]);
        recordNarrativeFlush(lastResultByCamera.get(cameraId), {
          attempted: true,
          status: "ok",
          finalize: true,
        });
      } catch (err) {
        recordNarrativeFlush(lastResultByCamera.get(cameraId), {
          attempted: true,
          status: "error",
          finalize: true,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      narrativeMemory.clear(cameraId);
      forgetCameraArchiveIndex(cameraId);

      visionController?.resetCamera(cameraId);
      semanticContextManager.clearBuffer(cameraId);
      pipelineDeps.strategyManager.clearFramePolicyOverride(cameraId);
      pipelineDeps.strategyManager.clearSegmentPolicyOverride(cameraId);
      pendingConsultations.delete(cameraId);
      lastFramePolicyStateKey.delete(cameraId);
      lastVcRuleFired.delete(cameraId);
      lastAppliedFps.delete(cameraId);
      pendingFpsChange.delete(cameraId);
      logger.info(`[lifecycle] Cleaned up per-camera state for ${cameraId}`);
    };

    const deleteDashboardSourceMemories = async (cameraId: string, userId?: string): Promise<void> => {
      try {
        await memoryClient.deleteMemories({
          camera_id: cameraId,
          ...(userId ? { user_id: userId } : {}),
          memory_type: "all",
        });
        logger.info(`[dashboard-source] Deleted memories for ${cameraId}`);
        await memoryClient.reidDelete({
          camera_id: cameraId,
          ...(userId ? { user_id: userId } : {}),
        });
        logger.info(`[dashboard-source] Deleted ReID vectors for ${cameraId}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[dashboard-source] delete memories failed for ${cameraId}: ${message}`);
        throw new Error(message);
      }
    };

    const listDashboardSourceIds = (): Set<string> => {
      const ids = new Set<string>();
      if (!existsSync(resolvedSourcesDir)) return ids;
      for (const file of readdirSync(resolvedSourcesDir)) {
        if (!file.endsWith(".json")) continue;
        const sourceId = file.slice(0, -".json".length);
        if (sourceId) ids.add(sourceId);
      }
      return ids;
    };

    const deleteDashboardCameraArtifacts = (cameraId: string): void => {
      for (const dir of [
        join(stateDir, "media", cameraId),
        join(stateDir, "recordings", cameraId),
        join(stateDir, "narratives", cameraId),
        join(stateDir, "cortex", "media", cameraId),
        join(stateDir, "cortex", "narratives", cameraId),
      ]) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup only.
        }
      }
    };

    const cleanupDashboardCameraData = async (cameraId: string, userId?: string): Promise<void> => {
      clearedDashboardSources.add(cameraId);
      await cleanupCameraRuntime(cameraId);
      await deleteDashboardSourceMemories(cameraId, userId);
      store.clearCamera(cameraId);
      deleteDashboardCameraArtifacts(cameraId);
      deleteDashboardSourceFile(cameraId);
      activeAnalyses.delete(cameraId);
      recentAnalyses.delete(cameraId);
      userIdByCamera.delete(cameraId);
      sessionIdByCamera.delete(cameraId);
    };

    const rememberCompletedAnalysis = (analysis: AnalysisStatusItem & { sourcePath?: string }) => {
      recentAnalyses.delete(analysis.camera_id);
      recentAnalyses.set(analysis.camera_id, {
        ...publicAnalysis(analysis),
        completed_at: Date.now(),
        status: "completed",
      });
      while (recentAnalyses.size > 5) {
        const oldest = recentAnalyses.keys().next().value;
        if (typeof oldest !== "string") break;
        recentAnalyses.delete(oldest);
      }
    };

    dashboardServer.setAnalysisStatusCallback((): AnalysisStatusSnapshot => {
      const active = new Map<string, AnalysisStatusItem>();
      for (const analysis of activeAnalyses.values()) {
        active.set(analysis.camera_id, publicAnalysis(analysis));
      }
      for (const watch of loadActiveWatchStates()) {
        if (!watch.id.startsWith("video-") || active.has(watch.id)) continue;
        const source = readDashboardVideoSource(watch.id);
        if (!source) continue;
        active.set(watch.id, {
          camera_id: watch.id,
          video_id: source.videoId,
          ...(source.userId ? { user_id: source.userId } : {}),
          ...(source.sessionId ? { session_id: source.sessionId } : {}),
          started_at: source.createdAt,
          segments_count: 0,
          status: "active",
        });
      }
      return {
        active: Array.from(active.values()),
        recent: Array.from(recentAnalyses.values()),
      };
    });

    dashboardServer.setSemanticContextCallback(async ({ cameraId }) => {
      try {
        const content = await semanticContextManager.load(cameraId);
        return { ok: true, camera_id: cameraId, content: content ?? "" };
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : "Semantic Context load failed",
          statusCode: 500,
        };
      }
    });

    dashboardServer.setActiveSourcesCallback(() => {
      const activeWatches = loadActiveWatchStates();
      const activeWatchIds = new Set(activeWatches.map((watch) => watch.id));
      const out: ActiveSourceStatus[] = activeWatches.map((watch) => {
        const source = readDashboardSourceInfo(watch.id);
        if (source.userId) userIdByCamera.set(watch.id, source.userId);
        if (source.sessionId) sessionIdByCamera.set(watch.id, source.sessionId);
        return {
          source_id: watch.id,
          source_name: source.name ?? watch.id,
          ...(source.userId ? { user_id: source.userId } : {}),
          ...(source.sessionId ? { session_id: source.sessionId } : {}),
          ...(source.input ? { input: source.input } : {}),
          ...(source.protocol ? { protocol: source.protocol } : {}),
          mode: watch.mode,
          ...(typeof watch.fps === "number" ? { fps: watch.fps } : {}),
          ...(typeof watch.width === "number" ? { width: watch.width } : {}),
          ...(typeof watch.height === "number" ? { height: watch.height } : {}),
          status: "active" as const,
        };
      });

      if (existsSync(resolvedSourcesDir)) {
        for (const file of readdirSync(resolvedSourcesDir)) {
          if (!file.endsWith(".json")) continue;
          const sourceId = file.slice(0, -".json".length);
          if (!sourceId || activeWatchIds.has(sourceId)) continue;
          const source = readDashboardSourceInfo(sourceId);
          const status = source.status === "active"
            ? "stopped"
            : source.status ?? ("waiting" as const);
          if (source.status === "active") writeDashboardSourceStatus(sourceId, "stopped");
          const sourceFile = join(resolvedSourcesDir, file);
          const createdAt = existsSync(sourceFile) ? statSync(sourceFile).mtimeMs : Date.now();
          out.push({
            source_id: sourceId,
            source_name: source.name ?? sourceId,
            ...(source.userId ? { user_id: source.userId } : {}),
            ...(source.sessionId ? { session_id: source.sessionId } : {}),
            ...(source.input ? { input: source.input } : {}),
            ...(source.protocol ? { protocol: source.protocol } : {}),
            ...(source.mode ? { mode: source.mode } : {}),
            ...(typeof source.fps === "number" ? { fps: source.fps } : {}),
            ...(typeof source.width === "number" ? { width: source.width } : {}),
            ...(typeof source.height === "number" ? { height: source.height } : {}),
            status,
            created_at: createdAt,
          });
        }
      }

      return out;
    });

    const dashboardCameraMatchesScope = (cameraId: string, scope?: DashboardSessionScope | null, analysis?: AnalysisStatusItem): boolean => {
      if (!scope || scope.isAdmin) return true;
      const info = readDashboardSourceInfo(cameraId);
      const sourceUserId = analysis?.user_id ?? userIdByCamera.get(cameraId) ?? info.userId;
      const sourceSessionId = analysis?.session_id ?? sessionIdByCamera.get(cameraId) ?? info.sessionId;
      if (sourceUserId && sourceSessionId) return sourceUserId === scope.userId && sourceSessionId === scope.sessionId;
      if (sourceSessionId) return sourceSessionId === scope.sessionId;
      if (sourceUserId) return sourceUserId === scope.userId;
      return false;
    };

    const dashboardSourceIdsForRuntimeClear = (scope?: DashboardSessionScope | null): string[] => {
      const ids = new Set<string>();
      const addIfVisible = (cameraId: string | undefined, analysis?: AnalysisStatusItem): void => {
        if (!cameraId) return;
        if (dashboardCameraMatchesScope(cameraId, scope, analysis)) ids.add(cameraId);
      };

      for (const analysis of activeAnalyses.values()) addIfVisible(analysis.camera_id, analysis);
      for (const analysis of recentAnalyses.values()) addIfVisible(analysis.camera_id, analysis);
      for (const watch of loadActiveWatchStates()) addIfVisible(watch.id);
      for (const sourceId of listDashboardSourceIds()) addIfVisible(sourceId);
      for (const row of store.getRecent(undefined, 1000)) addIfVisible(row.camera_id);

      return Array.from(ids);
    };

    dashboardServer.setClearDashboardDataCallback(async (scope) => {
      const cameraIds = dashboardSourceIdsForRuntimeClear(scope);
      for (const cameraId of cameraIds) {
        if (executeCam) {
          await executeCam("stop_watch", { name: cameraId }).catch((err) => {
            logger.error(`[dashboard-clear] stop_watch failed for ${cameraId}: ${err instanceof Error ? err.message : err}`);
          });
          await executeCam("remove_source", { name: cameraId }).catch((err) => {
            logger.error(`[dashboard-clear] remove_source failed for ${cameraId}: ${err instanceof Error ? err.message : err}`);
          });
        }
        const sourceUserId = userIdByCamera.get(cameraId) ?? readDashboardSourceInfo(cameraId).userId;
        await cleanupDashboardCameraData(cameraId, sourceUserId).catch((err) => {
          logger.error(`[dashboard-clear] cleanup data failed for ${cameraId}: ${err instanceof Error ? err.message : err}`);
        });
      }
      if (!scope || scope.isAdmin) {
        activeAnalyses.clear();
        recentAnalyses.clear();
      }
    });

    dashboardServer.setSourcePurgeCallback(async (req: SourcePurgeRequest): Promise<SourcePurgeResponse> => {
      try {
        const sourceUserId = req.userId ?? userIdByCamera.get(req.sourceId) ?? readDashboardSourceInfo(req.sourceId).userId;
        await cleanupDashboardCameraData(req.sourceId, sourceUserId);
        return { ok: true };
      } catch (err) {
        return { error: err instanceof Error ? err.message : "source purge failed", statusCode: 500 };
      }
    });

    const dashboardMemoryUserId = (cameraId?: string, requestUserId?: string): string => {
      if (requestUserId?.trim()) return requestUserId.trim();
      return cameraId ? getMemoryUserIdForCamera(cameraId) : memoryUserId;
    };

    const trimMemoryText = (value: unknown, max = 520): string => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      if (!text) return "";
      const compact = text.replace(/\s+/g, " ").trim();
      return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
    };

    const memoryField = (item: Record<string, unknown>, key: string): string | undefined => {
      const direct = item[key];
      if (typeof direct === "string" && direct.trim()) return direct.trim();
      const metadata = item.metadata;
      if (metadata && typeof metadata === "object") {
        const nested = (metadata as Record<string, unknown>)[key];
        if (typeof nested === "string" && nested.trim()) return nested.trim();
        if (typeof nested === "number" && Number.isFinite(nested)) return String(nested);
      }
      return undefined;
    };

    const formatMemoryItem = (item: Record<string, unknown>, index: number): string => {
      const memoryType = memoryField(item, "memory_type") ?? "memory";
      const cameraId = memoryField(item, "camera_id");
      const segmentId = memoryField(item, "video_id") ?? memoryField(item, "segment_id") ?? memoryField(item, "event_id") ?? memoryField(item, "run_id");
      const entityId = memoryField(item, "entity_id");
      const sourceTime = memoryField(item, "source_time_label");
      const mediaStart = memoryField(item, "media_start_ms");
      const mediaDuration = memoryField(item, "media_duration_ms");
      const mediaRange = sourceTime
        ? sourceTime
        : mediaStart && mediaDuration
          ? `${Math.max(0, Math.round(Number(mediaStart) / 1000))}s-${Math.max(0, Math.round((Number(mediaStart) + Number(mediaDuration)) / 1000))}s`
          : undefined;
      const score = typeof item.score === "number" ? ` score=${item.score.toFixed(3)}` : "";
      const parts = [
        `${index + 1}. ${memoryType}${score}`,
        cameraId ? `source=${cameraId}` : "",
        segmentId ? `segment=${segmentId}` : "",
        mediaRange ? `time=${mediaRange}` : "",
        entityId ? `entity=${entityId}` : "",
      ].filter(Boolean);
      return `${parts.join(" | ")}\n   ${trimMemoryText(item.memory)}`;
    };

    const evidenceLinesFromContext = (context: string, limit: number): string[] => {
      const lines: string[] = [];
      for (const raw of context.split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith("summary=") || line.startsWith("detail=")) {
          lines.push(line.replace(/^(summary|detail)=/, "").trim());
        } else if (/^\d+\.\s/.test(line)) {
          continue;
        } else if (raw.startsWith("   ")) {
          lines.push(line);
        }
        if (lines.length >= limit) break;
      }
      return [...new Set(lines.map((line) => trimMemoryText(line, 220)).filter(Boolean))].slice(0, limit);
    };

    type DashboardChatMemoryType =
      | "episodic_trace"
      | "episodic_entity"
      | "episodic_schema"
      | "semantic_entity"
      | "semantic_context"
      | "procedural"
      | "episodic"
      | "semantic"
      | "all";
    type DashboardChatSortOrder = "asc" | "desc";
    type DashboardChatToolCall = {
      name: "memory_search" | "memory_get";
      query?: string;
      entity_id?: string;
      segment_id?: string;
      around_segment_id?: string;
      memory_type?: DashboardChatMemoryType;
      limit?: number;
      sort_order?: DashboardChatSortOrder;
      neighbor_window?: number;
    };
    type DashboardChatAgentPlan = {
      questionScope: DashboardChatQuestionScope;
      answerReady: boolean;
      answer: string;
      toolCalls: DashboardChatToolCall[];
    };

    const dashboardChatSearchMemoryTypes = new Set<DashboardChatMemoryType>([
      "episodic_trace",
      "episodic_entity",
      "episodic_schema",
      "semantic_entity",
      "semantic_context",
      "procedural",
      "episodic",
      "semantic",
      "all",
    ]);
    const dashboardChatGetMemoryTypes = new Set<DashboardChatMemoryType>([
      ...dashboardChatSearchMemoryTypes,
    ]);

    const clampDashboardChatLimit = (value: unknown, fallback: number): number => {
      const raw = typeof value === "number" && Number.isFinite(value) ? value : fallback;
      return Math.max(1, Math.min(12, Math.floor(raw)));
    };

    const dashboardChatMemoryType = (
      value: unknown,
      allowed: Set<DashboardChatMemoryType>,
      fallback: DashboardChatMemoryType,
    ): DashboardChatMemoryType => {
      if (typeof value !== "string") return fallback;
      const candidate = value.trim() as DashboardChatMemoryType;
      return allowed.has(candidate) ? candidate : fallback;
    };

    const dashboardChatString = (value: unknown, max = 240): string | undefined => {
      return typeof value === "string" && value.trim()
        ? value.trim().slice(0, max)
        : undefined;
    };

    const dashboardChatSortOrder = (value: unknown): DashboardChatSortOrder | undefined => {
      return value === "asc" || value === "desc" ? value : undefined;
    };

    const dashboardChatNeighborWindow = (value: unknown): number => {
      const raw = typeof value === "number" && Number.isFinite(value) ? value : 3;
      return Math.max(1, Math.min(5, Math.floor(raw)));
    };

    const memorySegmentId = (item: Record<string, unknown>): string | undefined => {
      return memoryField(item, "video_id")
        ?? memoryField(item, "segment_id")
        ?? memoryField(item, "memory_id")
        ?? memoryField(item, "id");
    };

    const extractDashboardChatJsonObject = (text: string): string | null => {
      const start = text.indexOf("{");
      if (start < 0) return null;
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let i = start; i < text.length; i += 1) {
        const ch = text[i]!;
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === "\"") {
          inString = !inString;
          continue;
        }
        if (inString) continue;
        if (ch === "{") depth += 1;
        if (ch === "}") {
          depth -= 1;
          if (depth === 0) return text.slice(start, i + 1);
        }
      }
      return null;
    };

    const parseDashboardChatPlan = (raw: string): DashboardChatAgentPlan => {
      const jsonText = extractDashboardChatJsonObject(raw);
      if (!jsonText) return { questionScope: "video_content", answerReady: false, answer: "", toolCalls: [] };
      try {
        const parsed = JSON.parse(jsonText) as Record<string, unknown>;
        const questionScope = parsed.question_scope === "non_video" ? "non_video" : "video_content";
        const answer = typeof parsed.answer === "string" ? parsed.answer.trim() : "";
        const rawCalls = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [];
        const toolCalls = rawCalls.flatMap((item): DashboardChatToolCall[] => {
          if (!item || typeof item !== "object") return [];
          const call = item as Record<string, unknown>;
          const name = call.name === "memory_search" || call.name === "memory_get" ? call.name : null;
          if (!name) return [];
          return [{
            name,
            ...(typeof call.query === "string" && call.query.trim() ? { query: call.query.trim().slice(0, 2000) } : {}),
            ...(dashboardChatString(call.entity_id) ? { entity_id: dashboardChatString(call.entity_id) } : {}),
            ...(dashboardChatString(call.segment_id) ? { segment_id: dashboardChatString(call.segment_id) } : {}),
            ...(dashboardChatString(call.around_segment_id) ? { around_segment_id: dashboardChatString(call.around_segment_id) } : {}),
            memory_type: dashboardChatMemoryType(
              call.memory_type,
              name === "memory_search" ? dashboardChatSearchMemoryTypes : dashboardChatGetMemoryTypes,
              "episodic_trace",
            ),
            limit: clampDashboardChatLimit(call.limit, name === "memory_get" ? 10 : 8),
            ...(dashboardChatSortOrder(call.sort_order) ? { sort_order: dashboardChatSortOrder(call.sort_order) } : {}),
            ...(typeof call.neighbor_window === "number" ? { neighbor_window: dashboardChatNeighborWindow(call.neighbor_window) } : {}),
          }];
        }).slice(0, 3);
        return {
          questionScope,
          answerReady: parsed.answer_ready === true,
          answer,
          toolCalls,
        };
      } catch {
        return { questionScope: "video_content", answerReady: false, answer: "", toolCalls: [] };
      }
    };

    const buildDashboardChatAgentPrompt = (
      req: DashboardChatRequest,
      history: string,
      toolContext: string,
    ): string => `You are a planner for a lightweight video-memory assistant.
Decide whether the available context is enough to answer the user, or whether memory tools are needed.
Return strict JSON only. Do not include markdown.

JSON schema:
{
  "question_scope": "video_content" | "non_video",
  "answer_ready": boolean,
  "answer": "final answer when enough evidence is available, otherwise empty string",
  "tool_calls": [
    {
      "name": "memory_search" | "memory_get",
      "query": "short English keyword query for memory_search",
      "entity_id": "optional entity filter from a memory result",
      "segment_id": "optional segment/video_id from a memory result for memory_get",
      "around_segment_id": "optional segment/video_id from a memory result for neighboring context",
      "memory_type": "episodic_trace" | "episodic_entity" | "episodic_schema" | "semantic_entity" | "semantic_context" | "procedural" | "episodic" | "semantic" | "all",
      "limit": number,
      "sort_order": "asc" | "desc",
      "neighbor_window": number
    }
  ]
}

Available tools:
- memory_search: semantic relevance search over stored observations. It returns a bounded top-k set ordered by relevance, not time. Results are candidate evidence and are not exhaustive.
- memory_get: deterministic retrieval of stored observations. It can retrieve an exact segment, neighboring segments, entity-filtered observations, or a bounded time-ordered window. It does not perform semantic search.

Memory types:
- episodic_trace: per-segment facts, including visible scene, actions, people, objects, speech, on-screen text, segment_id, and time. Prefer this for concrete questions and source-local events.
- episodic_schema: coarse event or chapter summaries. Use for whole-video summaries, broad topics, or ordering.
- episodic_entity: per-entity observations from specific segments.
- semantic_entity: consolidated person/entity/topic profiles, aliases, roles, repeated behavior, and known identity.
- semantic_context: source/background context.
- procedural: user rules or notification policies. Use only for rules, alerts, or policy questions.
- episodic: grouped episodic collections. Use when both trace and entity observations may matter.
- semantic: grouped semantic collections. Use when identity/background summaries may matter.
- all: broad fallback only when the memory type is genuinely unclear.

Evidence and planning:
- Your task is to produce an evidence-grounded answer.
- Set question_scope to video_content when answering depends on what was observed in the selected video or source; otherwise set it to non_video.
- On the first planning round, video_content questions require a memory_search observation before an answer can be produced.
- Dashboard context contains a limited set of recent observations. Memory tools provide access to broader stored observations.
- Set answer_ready=true only when the answer is directly supported by the Runtime context, Dashboard context, or memory tool observations provided here.
- The user question and your prior knowledge are not evidence.
- Treat tool result metadata as evidence limits. ${DASHBOARD_CHAT_NON_EXHAUSTIVE_EVIDENCE_RULE}
- If the available evidence does not cover the requested scope, select the tool that can obtain the missing evidence and reassess afterward.
- When the question has a time scope, evidence is sufficient only if it covers that requested time.
- Search queries should be concise English phrases that resemble stored observations. Rewrite non-English questions into English and include useful synonyms when appropriate.
- If sufficient evidence cannot be obtained, state the uncertainty. Keep final answers concise and use the user's language.

${history}Runtime/source context:
${req.runtimeContext ?? "No runtime context available."}

Dashboard context:
${req.context}

Memory tool observations:
${toolContext || "No memory tools have been called yet."}

User question:
${req.prompt}`;

    const executeDashboardChatTool = async (req: DashboardChatRequest, call: DashboardChatToolCall): Promise<DashboardChatToolResult> => {
      const userId = dashboardMemoryUserId(req.cameraId, req.userId);
      const scope = {
        user_id: userId,
        ...(req.cameraId ? { camera_id: req.cameraId } : {}),
      };
      const healthScope = {
        user_id: userId,
        ...(req.sessionId ? { session_id: req.sessionId } : {}),
        ...(req.cameraId ? { source_id: req.cameraId } : {}),
      };
      if (call.name === "memory_search") {
        req.emit?.({ type: "status", message: "Searching memory..." });
        const query = call.query?.trim() || req.prompt;
        const memoryType = dashboardChatMemoryType(call.memory_type, dashboardChatSearchMemoryTypes, "episodic_trace");
        const limit = clampDashboardChatLimit(call.limit, 8);
        return executeDashboardChatMemorySearch({
          execute: () => memoryClient.search({
            query,
            ...scope,
            ...(call.entity_id ? { entity_id: call.entity_id } : {}),
            memory_type: memoryType,
            limit,
          }),
          formatSuccess: (searchRaw) => {
            const searchItems = flattenSearchResults(searchRaw).slice(0, limit);
            return [
              `Tool memory_search(query=${JSON.stringify(query)}, memory_type=${memoryType}, limit=${limit}):`,
              `Result metadata: ok=true, result_count=${searchItems.length}, exhaustive=false.`,
              searchItems.length
                ? searchItems.map((item, index) => formatMemoryItem(item as unknown as Record<string, unknown>, index)).join("\n")
                : "No matching memories.",
            ].join("\n");
          },
          onSuccess: () => runtimeHealth.observe({ component: "memory_search", operation: "search", status: "ok", scope: healthScope }),
          onFailure: (err) => {
            runtimeHealth.observe({ component: "memory_search", operation: "search", status: "down", code: "request_failed", scope: healthScope });
            logger.warn(`[dashboard-chat] memory_search unavailable: ${err instanceof Error ? err.message : String(err)}`);
          },
        });
      }

      req.emit?.({ type: "status", message: "Reading recent memory..." });
      try {
        const memoryType = dashboardChatMemoryType(call.memory_type, dashboardChatGetMemoryTypes, "episodic_trace");
        const limit = clampDashboardChatLimit(call.limit, 10);
        if (call.segment_id) {
          const exactRaw = await memoryClient.getMemories({
            ...scope,
            memory_type: "episodic_trace",
            video_id: call.segment_id,
            limit: 1,
          });
          let exactItems = flattenMemoriesResponse(exactRaw).slice(0, 1);
          if (exactItems.length === 0) {
            const timelineRaw = await memoryClient.getMemories({
              ...scope,
              memory_type: "episodic_trace",
              limit: 1200,
              sort_order: "asc",
            });
            exactItems = flattenMemoriesResponse(timelineRaw)
              .filter((item) => memorySegmentId(item as unknown as Record<string, unknown>) === call.segment_id)
              .slice(0, 1);
          }
          runtimeHealth.observe({ component: "memory", operation: "get", status: "ok", scope: healthScope });
          return {
            ok: true,
            observation: [
              `Tool memory_get(segment_id=${JSON.stringify(call.segment_id)}, memory_type=episodic_trace):`,
              exactItems.length
                ? exactItems.map((item, index) => formatMemoryItem(item as unknown as Record<string, unknown>, index)).join("\n")
                : "No memory found for that segment_id.",
            ].join("\n"),
          };
        }

        if (call.around_segment_id) {
          const neighborWindow = dashboardChatNeighborWindow(call.neighbor_window);
          const timelineRaw = await memoryClient.getMemories({
            ...scope,
            memory_type: "episodic_trace",
            limit: 1200,
            sort_order: "asc",
          });
          const timelineItems = flattenMemoriesResponse(timelineRaw).map((item) => item as unknown as Record<string, unknown>);
          const index = timelineItems.findIndex((item) => memorySegmentId(item) === call.around_segment_id);
          const neighbors = index >= 0
            ? timelineItems.slice(Math.max(0, index - neighborWindow), index + neighborWindow + 1)
            : [];
          runtimeHealth.observe({ component: "memory", operation: "get", status: "ok", scope: healthScope });
          return {
            ok: true,
            observation: [
              `Tool memory_get(around_segment_id=${JSON.stringify(call.around_segment_id)}, memory_type=episodic_trace, neighbor_window=${neighborWindow}):`,
              neighbors.length
                ? neighbors.map((item, itemIndex) => formatMemoryItem(item, itemIndex)).join("\n")
                : "No neighboring memories found for that segment_id.",
            ].join("\n"),
          };
        }

        const recentRaw = await memoryClient.getMemories({
          ...scope,
          ...(call.entity_id ? { entity_id: call.entity_id } : {}),
          memory_type: memoryType,
          limit,
          sort_order: call.sort_order ?? "desc",
        });
        const recentItems = flattenMemoriesResponse(recentRaw).slice(0, limit);
        runtimeHealth.observe({ component: "memory", operation: "get", status: "ok", scope: healthScope });
        return {
          ok: true,
          observation: [
            `Tool memory_get(memory_type=${memoryType}, sort_order=${call.sort_order ?? "desc"}, limit=${limit}${call.entity_id ? `, entity_id=${call.entity_id}` : ""}):`,
            recentItems.length
              ? recentItems.map((item, index) => formatMemoryItem(item as unknown as Record<string, unknown>, index)).join("\n")
              : `No recent ${memoryType} memories.`,
          ].join("\n"),
        };
      } catch (err) {
        runtimeHealth.observe({ component: "memory", operation: "get", status: "down", code: "request_failed", scope: healthScope });
        return {
          ok: false,
          observation: `Tool memory_get failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    };

    dashboardServer.setDashboardChatCallback(async (req: DashboardChatRequest): Promise<DashboardChatResponse> => {
      const healthScope = {
        ...(req.userId ? { user_id: req.userId } : {}),
        ...(req.sessionId ? { session_id: req.sessionId } : {}),
        ...(req.cameraId ? { source_id: req.cameraId } : {}),
      };
      const completeChat = (response: DashboardChatResponse): DashboardChatResponse => {
        runtimeHealth.observe({
          component: "chat",
          operation: "answer",
          status: response.error ? "down" : "ok",
          ...(response.error ? { code: "request_failed" } : {}),
          scope: healthScope,
        });
        return response;
      };
      const history = req.history.length
        ? `Conversation context from recent chat. Use it to resolve follow-up references, pronouns, omitted objects, and source-specific context:\n${req.history.map((m) => `${m.role}: ${m.text}`).join("\n")}\n\n`
        : "";
      const chatProfile = resolveVlmCallProfile({
        model: resolvedPerceptionConfig.llm_model,
        stage: "dashboard_chat",
      });
      const composeUnavailableReply = async (): Promise<string> => {
        try {
          const reply = await pipelineDeps.vlmAnalyzer.compressText(
            buildDashboardChatUnavailablePrompt(req.prompt),
            {
              maxTokens: Math.min(chatProfile.maxOutputTokens ?? 240, 240),
              reasoningEffort: chatProfile.reasoning,
              temperature: 0,
              stage: "dashboard.chat.unavailable",
              llmContext: {
                camera_id: req.cameraId,
              },
            },
          );
          return reply.trim() || DASHBOARD_CHAT_UNAVAILABLE_FALLBACK;
        } catch {
          return DASHBOARD_CHAT_UNAVAILABLE_FALLBACK;
        }
      };
      const toolObservations: string[] = [];
      const fallbackEvidence = evidenceLinesFromContext(req.context, 2);
      const fallbackAnswer = fallbackEvidence.length
        ? `Available evidence:\n${fallbackEvidence.map((line) => `- ${line}`).join("\n")}`
        : "The available video memory is not enough to answer that.";

      try {
        for (let round = 0; round < 3; round += 1) {
          req.emit?.({ type: "status", message: round === 0 ? "Planning answer..." : "Reviewing memory..." });
          const planRaw = await pipelineDeps.vlmAnalyzer.completeText(
            buildDashboardChatAgentPrompt(req, history, toolObservations.join("\n\n")),
            {
              responseFormat: "json",
              maxTokens: Math.min(chatProfile.maxOutputTokens ?? 800, 800),
              reasoningEffort: chatProfile.reasoning,
              temperature: 0,
              stage: "dashboard.chat.plan",
              llmContext: {
                camera_id: req.cameraId,
              },
            },
          );
          const plan = parseDashboardChatPlan(planRaw);
          const decision = decideDashboardChatAgentStep(round, plan, {
            name: "memory_search",
            query: req.prompt.trim().slice(0, 2000),
            memory_type: "episodic_trace",
            limit: 8,
          });
          if (decision.type === "initial_search") {
            const result = await executeDashboardChatTool(req, decision.call);
            toolObservations.push(result.observation);
            if (!result.ok) req.emit?.({ type: "status", message: "Preparing response..." });
            const failureResponse = await dashboardChatRequiredSearchFailureResponse(result, composeUnavailableReply);
            if (failureResponse) {
              return completeChat(failureResponse);
            }
            continue;
          }
          if (decision.type === "answer") {
            return completeChat({ ok: true, answer: decision.answer });
          }
          if (decision.type === "stop") break;
          for (const call of decision.calls) {
            const result = await executeDashboardChatTool(req, call);
            toolObservations.push(result.observation);
          }
        }

        req.emit?.({ type: "status", message: "Composing answer..." });
        const prompt = `You are the lightweight Reflect.World Dashboard assistant.
Answer questions using ONLY the dashboard context and memory tool results below.
If the answer is not in the context, say that the dashboard does not have enough information yet.
You are a warm, observant video-understanding assistant, not a generic chatbot and not a raw log summarizer.
Use runtime context for source/playback/analysis-health questions.
Use memory tool results for historical/entity/event questions.
${dashboardChatFinalEvidenceInstructions()}
Never mention internal tool failures unless the user asks for diagnostics.
Write naturally, as if explaining what you watched in the video.
Do not offer to replay video or take actions unless a tool/action for that is explicitly available in context.
Keep answers concise and question-focused:
1. Answer the user's question directly in the first sentence.
2. Include only the key evidence needed to support the answer, usually 1-2 short bullets at most.
3. Do not list every related moment or all available context unless the user explicitly asks for a summary, timeline, or diagnostics.
4. Use human-friendly labels like "the man in the light cap" or "the woman in the light top" when supported by evidence; avoid overclaiming identity.
5. Avoid mechanical labels such as "Notes", "Key points", "Dashboard shows", "tool", "memory", "segment", or raw IDs unless the user asks for diagnostics.
6. For uncertain details, use cautious language such as "looks like" or "appears to" instead of stating them as facts.
For runtime/status questions, be direct and operational.
Reply in the user's language.

${history}Intent:
thin_agent_final

Runtime/source context:
${req.runtimeContext ?? "No runtime context available."}

Dashboard context:
${req.context}

Memory tool results:
${toolObservations.join("\n\n") || "No memory tool observations."}

User question:
${req.prompt}`;
        const answer = await pipelineDeps.vlmAnalyzer.compressText(prompt, {
          maxTokens: chatProfile.maxOutputTokens ?? 1200,
          reasoningEffort: chatProfile.reasoning,
          temperature: chatProfile.temperature,
          stage: "dashboard.chat",
          llmContext: {
            camera_id: req.cameraId,
          },
        });
        const trimmed = answer.trim();
        if (trimmed) return completeChat({ ok: true, answer: trimmed });
        return completeChat({ ok: true, answer: fallbackAnswer });
      } catch (err) {
        logger.warn(`[dashboard-chat] request failed: ${err instanceof Error ? err.message : String(err)}`);
        return completeChat(dashboardChatRequestFailureResponse());
      }
    });

    dashboardServer.setSourceRemoveCallback(async (req: SourceRemoveRequest): Promise<SourceRemoveResponse> => {
      if (!executeCam) {
        return { error: "Cam service not ready", statusCode: 503 };
      }
      const sourceId = req.name;
      try {
        const sourceUserId = req.userId ?? userIdByCamera.get(sourceId) ?? readDashboardSourceInfo(sourceId).userId;
        await executeCam("stop_watch", { name: sourceId }).catch((err) => {
          logger.error(`[dashboard-source] stop_watch failed for ${sourceId}: ${err instanceof Error ? err.message : err}`);
        });
        const removeResult = parseCamResult(await executeCam("remove_source", { name: sourceId }));
        const sourceAlreadyGone = typeof removeResult.error === "string" && removeResult.error.includes("not found");
        if ((removeResult.error || removeResult.success === false) && !sourceAlreadyGone) {
          return { error: String(removeResult.error ?? "remove_source failed"), statusCode: 400 };
        }
        if (sourceAlreadyGone) {
          logger.info(`[dashboard-source] source ${sourceId} already removed; cleaning dashboard data for ${req.videoId ?? sourceId}`);
          deleteDashboardSourceFile(sourceId);
        }
        await cleanupDashboardCameraData(sourceId, sourceUserId);
        const removedSourceId = typeof removeResult.source_id === "string" ? removeResult.source_id : sourceId;
        return { ok: true, source_id: removedSourceId, ...(req.videoId ? { video_id: req.videoId } : {}) };
      } catch (err) {
        return { error: err instanceof Error ? err.message : "remove_source failed", statusCode: 500 };
      }
    });

    dashboardServer.setSourceStopCallback(async (req: SourceStopRequest): Promise<SourceStopResponse> => {
      if (!executeCam) {
        return { error: "Cam service not ready", statusCode: 503 };
      }
      const sourceId = req.name;
      try {
        await executeCam("stop_watch", { name: sourceId }).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          if (!message.includes("Not watching") && !message.includes("No active extraction")) {
            throw err;
          }
        });
        writeDashboardSourceStatus(sourceId, "stopped");
        await cleanupCameraRuntime(sourceId);
        activeAnalyses.delete(sourceId);
        const source = readDashboardSourceInfo(sourceId);
        monitorBus.publish("cam:watch_stopped", {
          source_id: sourceId,
          source_name: source.name ?? sourceId,
          ...(source.input ? { input: source.input } : {}),
          ...(source.protocol ? { protocol: source.protocol } : {}),
          status: "stopped",
          ...(req.userId ? { user_id: req.userId } : {}),
          ...(req.sessionId ? { session_id: req.sessionId } : {}),
        }, sourceId);
        return { ok: true, source_id: sourceId };
      } catch (err) {
        return { error: err instanceof Error ? err.message : "stop_watch failed", statusCode: 500 };
      }
    });

    const DASHBOARD_MIN_SEGMENT_DURATION_MS = 8_000;
    const DASHBOARD_INITIAL_SEGMENT_DURATION_MS = 2_000;

    dashboardServer.setAnalyzeCallback(async ({ videoId, filePath, fps, localFilePacing, semanticContextInit, userId, sessionId }) => {
      if (!executeCam) {
        return { error: "Cam service not ready", statusCode: 503 };
      }
      const conflictingAnalysis = Array.from(activeAnalyses.values()).some((analysis) => {
        if (sessionId) return analysis.session_id === sessionId && analysis.status !== "completed";
        return analysis.status !== "completed";
      });
      if (conflictingAnalysis) {
        return { error: "Another analysis is in progress", statusCode: 409 };
      }

      const cameraId = `video-${Date.now().toString(36)}`;
      clearedDashboardSources.delete(cameraId);
      if (userId) userIdByCamera.set(cameraId, userId);
      if (sessionId) sessionIdByCamera.set(cameraId, sessionId);
      const warnings: string[] = [];
      let sourceAdded = false;

      const rollback = async () => {
        if (sourceAdded && executeCam) {
          await executeCam("remove_source", { name: cameraId }).catch((err) => {
            logger.error(`[analyze] remove_source rollback failed for ${cameraId}: ${err instanceof Error ? err.message : err}`);
          });
        }
        activeAnalyses.delete(cameraId);
        userIdByCamera.delete(cameraId);
        sessionIdByCamera.delete(cameraId);
      };

      try {
        const addResult = parseCamResult(await executeCam("add_source", {
          source: filePath,
          name: cameraId,
          _allowLocalFileSource: true,
          ...(userId ? { _dashboardUserId: userId } : {}),
          ...(sessionId ? { _dashboardSessionId: sessionId } : {}),
        }));
        if (addResult.error || addResult.success !== true) {
          return { error: String(addResult.error ?? "add_source failed"), statusCode: 400 };
        }
        sourceAdded = true;
        writeDashboardSourceStatus(cameraId, "waiting");
        writeDashboardSourceConfigSnapshot(cameraId, { mode: "stream", fps });

        activeAnalyses.set(cameraId, {
          camera_id: cameraId,
          video_id: videoId,
          ...(userId ? { user_id: userId } : {}),
          ...(sessionId ? { session_id: sessionId } : {}),
          started_at: Date.now(),
          segments_count: 0,
          status: "starting",
          sourcePath: filePath,
        });
        monitorBus.publish("cam:source_added", {
          id: cameraId,
          name: cameraId,
          source_id: cameraId,
          source_name: videoId,
          protocol: "file",
          input: videoId,
          video_id: videoId,
          ...(userId ? { user_id: userId } : {}),
          ...(sessionId ? { session_id: sessionId } : {}),
          preview_url: `/api/videos/preview?video_id=${encodeURIComponent(videoId)}`,
        }, cameraId);

        const semanticWarning = await setDashboardSemanticContextUserBackground(cameraId, semanticContextInit);
        if (semanticWarning) warnings.push(semanticWarning);

        const uploadDispatchInputMode = localFilePacing === "realtime" ? "live_stream" : "local_file";
        const watchResult = parseCamResult(await executeCam("watch", {
          name: cameraId,
          mode: "stream",
          fps,
          _stopOnInputEnd: true,
          _inputMode: "local_file",
          _dispatchInputMode: uploadDispatchInputMode,
          _localFilePacing: localFilePacing,
          _fullRate: false,
          _minSegmentDurationMs: DASHBOARD_MIN_SEGMENT_DURATION_MS,
          _initialSegmentDurationMs: DASHBOARD_INITIAL_SEGMENT_DURATION_MS,
        }));
        if (watchResult.error || watchResult.status !== "watching") {
          await rollback();
          return { error: String(watchResult.error ?? "watch failed"), statusCode: 400 };
        }
        writeDashboardSourceStatus(cameraId, "active");

        const analysis = activeAnalyses.get(cameraId);
        if (!analysis) {
          return { ok: true, camera_id: cameraId, video_id: videoId, completed: true, warnings };
        }
        analysis.status = "active";
        return { ok: true, camera_id: cameraId, video_id: videoId, warnings };
      } catch (err) {
        await rollback();
        return { error: err instanceof Error ? err.message : "analyze failed", statusCode: 500 };
      }
    });

    dashboardServer.setStreamAnalyzeCallback(async ({ source, name, mode, fps, width, height, duration, deferWatch, semanticContextInit, userId, sessionId }) => {
      if (!executeCam) {
        return { error: "Cam service not ready", statusCode: 503 };
      }
      const runCam = executeCam;

      const warnings: string[] = [];
      let sourceAdded = false;
      let cameraId = name;
      let phoneSetup: StreamAnalyzeResponse["phone_setup"];
      const dashboardSourceId = sessionId ? `${sessionId}_${name}` : undefined;

      const rollback = async () => {
        if (sourceAdded) {
          await executeCam?.("remove_source", { name: cameraId }).catch((err) => {
            logger.error(`[stream-analyze] remove_source rollback failed for ${cameraId}: ${err instanceof Error ? err.message : err}`);
          });
        }
        userIdByCamera.delete(cameraId);
        sessionIdByCamera.delete(cameraId);
      };

      try {
        if (source) {
          const existingSourceId = await resolveExistingDashboardSourceId(dashboardSourceId ?? name);
          if (existingSourceId) {
            await executeCam("stop_watch", { name: existingSourceId }).catch((err) => {
              logger.error(`[stream-analyze] stop_watch before source replace failed for ${existingSourceId}: ${err instanceof Error ? err.message : err}`);
            });
            const removeExisting = parseCamResult(await executeCam("remove_source", { name: existingSourceId }));
            if (removeExisting.error || removeExisting.success === false) {
              return { error: String(removeExisting.error ?? "remove_source failed before re-add"), statusCode: 400 };
            }
            await cleanupCameraRuntime(existingSourceId);
            userIdByCamera.delete(existingSourceId);
            sessionIdByCamera.delete(existingSourceId);
          }

          const addResult = parseCamResult(await executeCam("add_source", {
            source,
            name,
            ...(dashboardSourceId ? { _sourceId: dashboardSourceId } : {}),
            ...(userId ? { _dashboardUserId: userId } : {}),
            ...(sessionId ? { _dashboardSessionId: sessionId } : {}),
          }));
          if (addResult.error || addResult.success !== true) {
            return { error: String(addResult.error ?? "add_source failed"), statusCode: 400 };
          }
          const addedSource = addResult.source && typeof addResult.source === "object"
            ? addResult.source as Record<string, unknown>
            : {};
          cameraId = typeof addedSource.id === "string" ? addedSource.id : cameraId;
          clearedDashboardSources.delete(cameraId);
          if (userId) userIdByCamera.set(cameraId, userId);
          if (sessionId) sessionIdByCamera.set(cameraId, sessionId);
          sourceAdded = true;
          writeDashboardSourceStatus(cameraId, "waiting");
          writeDashboardSourceConfigSnapshot(cameraId, { mode, fps, width, height });

          const protocol = typeof addedSource.protocol === "string" ? addedSource.protocol : undefined;
          const input = typeof addedSource.input === "string" ? addedSource.input : source;
          if (protocol === "phone") {
            const rawSetup = addResult.phone_setup && typeof addResult.phone_setup === "object"
              ? addResult.phone_setup as Record<string, unknown>
              : {};
            const nodeUrl = typeof rawSetup.nodeUrl === "string" ? rawSetup.nodeUrl : undefined;
            const qrPath = typeof rawSetup.qrImagePath === "string" ? rawSetup.qrImagePath : undefined;
            const message = typeof rawSetup.message === "string" ? rawSetup.message : undefined;
            let qrDataUrl: string | undefined;
            if (qrPath && existsSync(qrPath)) {
              try {
                qrDataUrl = `data:image/png;base64,${readFileSync(qrPath).toString("base64")}`;
              } catch {
                // Link is enough for fallback setup.
              }
            }
            phoneSetup = {
              ...(nodeUrl ? { node_url: nodeUrl } : {}),
              ...(qrDataUrl ? { qr_data_url: qrDataUrl } : {}),
              ...(message ? { message } : {}),
            };
          }

          monitorBus.publish("cam:source_added", {
            id: cameraId,
            name,
            source_id: cameraId,
            source_name: name,
            protocol,
            input,
            ...(userId ? { user_id: userId } : {}),
            ...(sessionId ? { session_id: sessionId } : {}),
          }, cameraId);
        } else {
          const existingSourceId = await resolveExistingDashboardSourceId(dashboardSourceId ?? name);
          if (!existingSourceId) {
            return { error: `Source "${name}" is not registered. Generate the web camera link first.`, statusCode: 404 };
          }
          cameraId = existingSourceId;
          clearedDashboardSources.delete(cameraId);
        }

        if (deferWatch) {
          return {
            ok: true,
            camera_id: cameraId,
            source_id: cameraId,
            warnings,
            ...(phoneSetup ? { phone_setup: phoneSetup } : {}),
          };
        }

        const startDashboardWatch = async (): Promise<{ ok: true } | { error: string; statusCode: number }> => {
          const semanticWarning = await setDashboardSemanticContextUserBackground(cameraId, semanticContextInit);
          if (semanticWarning) warnings.push(semanticWarning);
          writeDashboardSourceConfigSnapshot(cameraId, { mode, fps, width, height });

          const watchResult = parseCamResult(await runCam("watch", {
            name: cameraId,
            mode,
            fps,
            ...(width ? { width } : {}),
            ...(height ? { height } : {}),
            ...(duration ? { duration } : {}),
            _fullRate: false,
            _minSegmentDurationMs: DASHBOARD_MIN_SEGMENT_DURATION_MS,
            _initialSegmentDurationMs: DASHBOARD_INITIAL_SEGMENT_DURATION_MS,
          }));
          const alreadyWatching = typeof watchResult.error === "string" && watchResult.error.includes("Already watching");
          if (alreadyWatching) {
            writeDashboardSourceStatus(cameraId, "active");
            monitorBus.publish("cam:watch_started", {
              source_id: cameraId,
              source_name: name,
              mode,
              fps,
              ...(userId ? { user_id: userId } : {}),
              ...(sessionId ? { session_id: sessionId } : {}),
            }, cameraId);
            return { ok: true };
          }
          if (watchResult.error || watchResult.status !== "watching") {
            await rollback();
            return { error: String(watchResult.error ?? "watch failed"), statusCode: 400 };
          }
          writeDashboardSourceStatus(cameraId, "active");

          monitorBus.publish("cam:watch_started", {
            source_id: cameraId,
            source_name: name,
            mode,
            fps,
            ...(userId ? { user_id: userId } : {}),
            ...(sessionId ? { session_id: sessionId } : {}),
          }, cameraId);
          return { ok: true };
        };

        const existingSourceInfo = readDashboardSourceInfo(cameraId);
        const shouldStartPhoneWatchInBackground = !source && existingSourceInfo.protocol === "phone";
        if (shouldStartPhoneWatchInBackground) {
          writeDashboardSourceStatus(cameraId, "waiting");
          monitorBus.publish("cam:source_waiting", {
            source_id: cameraId,
            source_name: existingSourceInfo.name ?? name,
            input: existingSourceInfo.input ?? "phone",
            protocol: existingSourceInfo.protocol,
            mode,
            fps,
            ...(userId ? { user_id: userId } : {}),
            ...(sessionId ? { session_id: sessionId } : {}),
          }, cameraId);

          void startDashboardWatch().then((result) => {
            if ("error" in result) {
              writeDashboardSourceStatus(cameraId, "unavailable");
              logger.error(`[stream-analyze] background phone watch failed for ${cameraId}: ${result.error}`);
              monitorBus.publish("cam:source_unavailable", {
                source_id: cameraId,
                source_name: existingSourceInfo.name ?? name,
                input: existingSourceInfo.input ?? "phone",
                protocol: existingSourceInfo.protocol,
                error: result.error,
              }, cameraId);
            }
          }).catch((err) => {
            const message = err instanceof Error ? err.message : "stream watch failed";
            writeDashboardSourceStatus(cameraId, "unavailable");
            logger.error(`[stream-analyze] background phone watch failed for ${cameraId}: ${message}`);
            monitorBus.publish("cam:source_unavailable", {
              source_id: cameraId,
              source_name: existingSourceInfo.name ?? name,
              input: existingSourceInfo.input ?? "phone",
              protocol: existingSourceInfo.protocol,
              error: message,
            }, cameraId);
          });

          return { ok: true, camera_id: cameraId, source_id: cameraId, status: "starting", warnings };
        }

        const watchStart = await startDashboardWatch();
        if ("error" in watchStart) return watchStart;

        return { ok: true, camera_id: cameraId, source_id: cameraId, warnings };
      } catch (err) {
        await rollback();
        return { error: err instanceof Error ? err.message : "stream analyze failed", statusCode: 500 };
      }
    });

    monitorBus.on("monitor", (event) => {
      if (event.type === "cam:source_unavailable") {
        const cameraId = event.data?.source_id as string | undefined;
        if (!cameraId) return;
        const active = activeAnalyses.get(cameraId);
        if (!active) return;
        active.status = "failed";
        active.completed_at = Date.now();
        active.segments_count = store.getSegmentCount(cameraId);
        rememberCompletedAnalysis(active);
        activeAnalyses.delete(cameraId);
        writeDashboardSourceStatus(cameraId, "unavailable");
        return;
      }
      if (event.type !== "cam:watch_stopped") return;
      const cameraId = event.data?.source_id as string | undefined;
      if (!cameraId) return;
      if (!activeAnalyses.has(cameraId)) return;
      const completed = activeAnalyses.get(cameraId);
      if (completed) rememberCompletedAnalysis(completed);
      activeAnalyses.delete(cameraId);
      writeDashboardSourceStatus(cameraId, "stopped");
    });

    // ── Build active model list for Monitor ──
    const activeModels: string[] = ["VLM Analysis"];
    if (pipelineDeps.router) {
      const caps = pipelineDeps.router.getAvailableCapabilities();
      const LABELS: Record<string, string> = {
        "general-detection": "Object Detection",
        "face-detection": "Face Detection",
        "face-reid": "Face ReID",
        "body-reid": "Body ReID",
      };
      for (const cap of caps) {
        if (LABELS[cap]) activeModels.push(LABELS[cap]);
      }
    }

    // ── applyFramePolicy: write frame policy override to StrategyManager, adjust fps ──
    // Track last published state per camera to avoid spamming state_changed every frame.
    const lastFramePolicyStateKey = new Map<string, string>();
    const clampFramePolicyFps = (fps: number) => Math.min(fps, FRAME_POLICY_MAX_FPS);
    const clampFramePolicyAction = (action: FramePolicyOutput["action"]) => {
      const clamped = { ...action };
      if (clamped.fps != null) clamped.fps = clampFramePolicyFps(clamped.fps);
      return clamped;
    };

    const applyFramePolicy = (framePolicy: FramePolicyOutput, cameraId: string, frameTimestamp?: number) => {
      const frameAction = clampFramePolicyAction(framePolicy.action);
      const frameRuleDetails = framePolicy.firedRuleDetails?.map((detail) => ({
        ...detail,
        action: clampFramePolicyAction(detail.action),
      }));
      // Only apply changes when state actually differs from last frame
      const stateKey = `${frameAction.fps ?? "-"}|${frameAction.skip_vlm ?? "-"}|${frameAction.max_level ?? "-"}|${frameAction.vlm_model ?? "-"}|${frameAction.mode ?? "-"}`;
      const stateChanged = stateKey !== lastFramePolicyStateKey.get(cameraId);

      if (stateChanged) {
        // Write frame policy perception overrides via dual-slot.
        if (frameAction.skip_vlm != null || frameAction.max_level != null || frameAction.vlm_model != null) {
          pipelineDeps.strategyManager.setFramePolicyOverride(cameraId, {
            skipVlm: frameAction.skip_vlm,
            maxLevel: frameAction.max_level as 0 | 1 | 2 | undefined,
            vlmModel: frameAction.vlm_model,
          });
        } else if (framePolicy.firedRules.length === 0) {
          pipelineDeps.strategyManager.clearFramePolicyOverride(cameraId);
        }

        // Apply Cam adjustments (fps, mode) — only on actual change
        if (executeCam) {
          if (frameAction.fps != null) {
            const lastKnownFps = pendingFpsChange.get(cameraId)?.targetFps ?? lastAppliedFps.get(cameraId);
            if (lastKnownFps == null) {
              lastAppliedFps.set(cameraId, frameAction.fps);
            } else if (lastKnownFps !== frameAction.fps) {
              pendingFpsChange.set(cameraId, { targetFps: frameAction.fps, requestedAt: frameTimestamp ?? Date.now() });
            }
            executeCam("set_sampling", { name: cameraId, fps: frameAction.fps }).catch((err) => {
              logger.error(`[vision-controller] set_sampling failed: ${err instanceof Error ? err.message : err}`);
            });
          }
          if (frameAction.mode != null) {
            executeCam("switch_mode", { name: cameraId, mode: frameAction.mode }).catch((err) => {
              logger.error(`[vision-controller] switch_mode failed: ${err instanceof Error ? err.message : err}`);
            });
          }
        }
      }

      // Monitor events + decision tracking
      if (framePolicy.firedRules.length > 0) {
        const actionDesc = Object.entries(frameAction).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join(", ");
        lastVcRuleFired.set(cameraId, `${framePolicy.firedRules.join("+")} → ${actionDesc}`);
        monitorBus.publish("vision_controller:rule_fired", {
          camera_id: cameraId,
          layer: "frame_policy",
          frame_timestamp: frameTimestamp,
          rules: framePolicy.firedRules,
          rule_details: frameRuleDetails,
          signals_snapshot: framePolicy.signals ? {
            detected_classes: [...framePolicy.signals.detected_classes],
            has_motion: framePolicy.signals.has_motion,
            motion_sustained_ms: framePolicy.signals.motion_sustained_ms,
          } : undefined,
          action: frameAction,
        }, cameraId);
      }

      // Publish state_changed + update tracking (guarded by stateChanged above)
      if (stateChanged) {
        lastFramePolicyStateKey.set(cameraId, stateKey);
        monitorBus.publish("vision_controller:state_changed", {
          camera_id: cameraId,
          layer: "frame_policy",
          frame_timestamp: frameTimestamp,
          fps: frameAction.fps,
          skip_vlm: frameAction.skip_vlm,
          max_level: frameAction.max_level,
          vlm_model: frameAction.vlm_model,
          mode: frameAction.mode,
          fired_rules: framePolicy.firedRules,
          rule_details: frameRuleDetails,
          is_baseline: framePolicy.firedRules.length === 0,
        }, cameraId);
      }
    };

    // ── applySegmentPolicy: write segment policy override to StrategyManager, handle exit condition ──
    const applySegmentPolicy = (segmentPolicy: SegmentPolicyOutput, cameraId: string, segmentId?: string) => {
      if (segmentPolicy.segmentPolicyCleared) {
        // Segment policy exit condition met: clear segment policy override,
        // then revert fps to frame policy action or baseline.
        pipelineDeps.strategyManager.clearSegmentPolicyOverride(cameraId);
        activeAdaptivePromptConfigByCamera.delete(cameraId);
        const framePolicyState = visionController!.getFramePolicyState(cameraId);
        // If frame policy has an active hold with fps, revert to that; otherwise baseline.
        const revertFps = (framePolicyState.holdActive && framePolicyState.lastAction?.fps != null)
          ? clampFramePolicyFps(framePolicyState.lastAction.fps)
          : (visionController!.getConfig().baseline?.fps ?? 1);
        if (executeCam) {
          executeCam("set_sampling", { name: cameraId, fps: revertFps }).catch((err) => {
            logger.error(`[vision-controller] set_sampling revert failed: ${err instanceof Error ? err.message : err}`);
          });
        }
        monitorBus.publish("vision_controller:state_changed", {
          camera_id: cameraId,
          layer: "segment_policy",
          segment_policy_cleared: true,
          is_baseline: true,
        }, cameraId);
        return;
      }

      // Write segment policy perception overrides.
      if (segmentPolicy.action.skip_vlm != null || segmentPolicy.action.max_level != null || segmentPolicy.action.vlm_model != null) {
        pipelineDeps.strategyManager.setSegmentPolicyOverride(cameraId, {
          skipVlm: segmentPolicy.action.skip_vlm,
          maxLevel: segmentPolicy.action.max_level as 0 | 1 | 2 | undefined,
          vlmModel: segmentPolicy.action.vlm_model,
        });
      }

      // Segment policy may also adjust fps (e.g., "increase fps to 5 for detailed monitoring").
      if (executeCam && segmentPolicy.action.fps != null) {
        executeCam("set_sampling", { name: cameraId, fps: segmentPolicy.action.fps }).catch((err) => {
          logger.error(`[vision-controller] segment policy set_sampling failed: ${err instanceof Error ? err.message : err}`);
        });
      }

      // Monitor events
      if (segmentPolicy.firedRules.length > 0) {
        monitorBus.publish("vision_controller:rule_fired", {
          camera_id: cameraId,
          ...(segmentId ? { segment_id: segmentId } : {}),
          layer: "segment_policy",
          rules: segmentPolicy.firedRules,
          rule_details: segmentPolicy.firedRuleDetails,
          action: segmentPolicy.action,
        }, cameraId);
      }

      monitorBus.publish("vision_controller:state_changed", {
          camera_id: cameraId,
          ...(segmentId ? { segment_id: segmentId } : {}),
          layer: "segment_policy",
        skip_vlm: segmentPolicy.action.skip_vlm,
        max_level: segmentPolicy.action.max_level,
        vlm_model: segmentPolicy.action.vlm_model,
        fps: segmentPolicy.action.fps,
        fired_rules: segmentPolicy.firedRules,
        rule_details: segmentPolicy.firedRuleDetails,
        is_baseline: segmentPolicy.firedRules.length === 0,
      }, cameraId);
    };

    // ── Per-source segment processing (stream/event mode) ──
    // Benchmark is single-source and keeps one perception in flight while the
    // next segment accumulates. Live multi-source runs need the same per-source
    // ordering without making a slow camera block unrelated cameras.
    const DASHBOARD_DEFAULT_SOURCE_CONCURRENCY = 2;
    const maxConcurrentPerceptionSources = readPositiveInt(
      (config.perception as Record<string, unknown> | undefined)?.source_concurrency
        ?? (config.perception as Record<string, unknown> | undefined)?.segment_concurrency
        ?? process.env.CORTEX_PERCEPTION_SOURCE_CONCURRENCY,
      DASHBOARD_DEFAULT_SOURCE_CONCURRENCY,
    );
    const maxQueuedPerCamera = readPositiveInt(
      (config.perception as Record<string, unknown> | undefined)?.max_queued_per_source
        ?? process.env.CORTEX_PERCEPTION_MAX_QUEUED_PER_SOURCE,
      resolvedPerceptionConfig.max_queued_per_source,
    );
    const liveBacklogSkipAfterMs = readPositiveInt(
      (config.perception as Record<string, unknown> | undefined)?.live_backlog_skip_after_ms
        ?? process.env.CORTEX_PERCEPTION_LIVE_BACKLOG_SKIP_AFTER_MS,
      resolvedPerceptionConfig.live_backlog_skip_after_ms,
    );
    let rejectedSegmentsTotal = 0;
    let skippedSegmentsTotal = 0;
    const processStreamSegmentCompleted = async (segment: Segment, onCriticalReady?: () => void): Promise<void> => {
      try {
        const depsForSegment = onCriticalReady
          ? { ...pipelineDeps, onCriticalStateCommitted: onCriticalReady }
          : pipelineDeps;
        const result = await runWithCameraMemoryUser(segment.camera_id, () => analyze(segment, depsForSegment));

        // ── VisionController segment policy: evaluate after perception completes ──
        if (visionController) {
          const segmentPolicy = visionController.evaluateSegment(result, segment);
          applySegmentPolicy(segmentPolicy, segment.camera_id, segment.segment_id);

          // Segment policy: submit consultation to OpenClaw (or E2E test double).
          if (segmentPolicy.shouldConsultAgent && segmentPolicy.consultationContext) {
            const ctx = segmentPolicy.consultationContext;
            const riskLabel = ctx.signals?.security_risk ? " ⚠️ SECURITY RISK" : "";
            let semanticContext: string | undefined;
            try {
              const semanticContextContent = await pipelineDeps.semanticContext?.load(segment.camera_id);
              semanticContext = compactVisionControllerText(
                semanticContextContent ? parseSemanticContextSections(semanticContextContent).profileContent : undefined,
                1800,
              );
            } catch { /* best-effort context */ }
            const currentEventSummary = pipelineDeps.workingMemory.getCurrentEventSummary(segment.camera_id);
            const recentSegmentSummaries = pipelineDeps.workingMemory.getRecentSegmentSummaries(segment.camera_id);
            const baseline = visionController.getConfig().baseline as Record<string, unknown> | undefined;
            const currentOverrides = {
              fps: segmentPolicy.action.fps,
              skip_vlm: segmentPolicy.action.skip_vlm,
              max_level: segmentPolicy.action.max_level,
              vlm_model: segmentPolicy.action.vlm_model,
            };
            const serializedSignals = serializeVisionControllerSignals(ctx.signals);
            const consultationRequestedAt = Date.now();
            const consultationId = `consult_${consultationRequestedAt.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
            const recommendedActionTypes = ["perception_config"];
            const consultationPayload = {
              camera_id: segment.camera_id,
              segment_id: segment.segment_id,
              trigger_reason: ctx.trigger_reason as Record<string, unknown>,
              video_context: {
                semantic_context: semanticContext,
              },
              event_context: {
                current_event_summary: compactVisionControllerText(currentEventSummary, 1000),
                recent_segments: recentSegmentSummaries.slice(-6)
                  .map((summary) => compactVisionControllerText(summary, 360))
                  .filter(Boolean),
              },
              current_segment: {
                summary: compactVisionControllerText(result.perception_memory.summary, 600),
                detailed_summary: compactVisionControllerText(result.perception_memory.detailed_summary, 1000),
                event_summary: compactVisionControllerText(String((result.perception_memory as unknown as Record<string, unknown>).event_summary ?? ""), 1000),
                signals: serializedSignals,
              },
              policy_state: {
                baseline,
                active_overrides: currentOverrides,
              },
              constraints: {
                allowed_config_keys: ["scene_description", "focus_targets", "security_rules"],
                requires_exit_condition: true,
              },
            };
            const eventText = [
              `[VisionController Consultation] Camera "${segment.camera_id}"${riskLabel}.`,
              "Decide whether a temporary perception prompt adjustment is needed.",
              "Usually do nothing. If needed, call cortex_perception with action=\"configure\" only.",
              "Allowed config keys: scene_description, focus_targets, security_rules.",
              "Do not change vc_rules_json, vc_segment_policy_json, semantic_context_notes, source_context, semantic_context_background, track_states, track_activities, explain_decisions, or model settings.",
              "Every tool call must include an exit_condition.",
              `Context: ${JSON.stringify(consultationPayload)}`,
            ].join("\n");
            pendingConsultations.set(segment.camera_id, {
              consultationId,
              segmentId: segment.segment_id,
              submittedAt: consultationRequestedAt,
              recommendedActionTypes,
            });
            const suggestedToolCall = await consultationDispatcher.submitConsultation({
              ...consultationPayload,
              signals: serializedSignals ?? {},
              eventText,
              current_baseline: baseline,
              current_overrides: currentOverrides,
              recommended_action_types: recommendedActionTypes,
              requires_exit_condition: true,
              exit_condition_hint: 'Specify when to revert the temporary perception adjustment (e.g., {"type":"event_boundary"} or {"type":"no_motion","duration_ms":30000})',
            });
            const consultationCompletedAt = Date.now();
            const suggestedConfig = suggestedToolCall?.params?.config && typeof suggestedToolCall.params.config === "object"
              ? suggestedToolCall.params.config as Record<string, unknown>
              : undefined;

            if (
              applyConsultationToolCalls
              && suggestedToolCall?.tool === "cortex_perception"
              && suggestedToolCall.params
            ) {
              try {
                await executeToolAction(suggestedToolCall.params, pipelineDeps);
                monitorBus.publish("vision_controller:consultation_effect_observed", {
                  consultation_id: consultationId,
                  segment_id: segment.segment_id,
                  tool: suggestedToolCall.tool,
                  action: suggestedToolCall.params.action,
                  success: true,
                  latency_ms: Date.now() - consultationRequestedAt,
                  tool_details: suggestedToolCall.params,
                }, segment.camera_id);
              } catch (err) {
                logger.error(
                  `[vision-controller] Consultation tool execution failed: ${err instanceof Error ? err.message : err}`,
                );
                monitorBus.publish("vision_controller:consultation_effect_observed", {
                  consultation_id: consultationId,
                  segment_id: segment.segment_id,
                  tool: suggestedToolCall.tool,
                  action: suggestedToolCall.params.action,
                  success: false,
                  latency_ms: Date.now() - consultationRequestedAt,
                  tool_details: suggestedToolCall.params,
                  error: err instanceof Error ? err.message : String(err),
                }, segment.camera_id);
              }
            }

            // If Agent returned an exit_condition, wire it into VisionController
            if (suggestedToolCall?.exit_condition) {
              if (suggestedConfig) {
                activeAdaptivePromptConfigByCamera.set(segment.camera_id, suggestedConfig);
              }
              visionController.setSegmentPolicyExitCondition(segment.camera_id, suggestedToolCall.exit_condition);
            }

            if (suggestedToolCall && !applyConsultationToolCalls) {
              logger.info(
                `[vision-controller] Consultation test double suggested tool=${suggestedToolCall.tool}; ` +
                "ignoring internal execution and waiting for external OpenClaw/tool invocation.",
              );
            }

            monitorBus.publish("vision_controller:agent_consulted", {
              consultation_id: consultationId,
              segment_id: segment.segment_id,
              camera_id: segment.camera_id,
              trigger_reason: ctx.trigger_reason,
              signals_snapshot: serializedSignals,
              detected_classes: serializedSignals?.detected_classes,
              security_risk: ctx.signals?.security_risk ?? false,
              phase: suggestedToolCall ? "submitted_with_suggestion" : "submitted",
              suggested_tool: suggestedToolCall?.tool,
              suggested_params: suggestedToolCall?.params,
              suggested_config: suggestedConfig,
              exit_condition: suggestedToolCall?.exit_condition,
              recommended_action_types: recommendedActionTypes,
              requested_at: consultationRequestedAt,
              completed_at: consultationCompletedAt,
              roundtrip_ms: consultationCompletedAt - consultationRequestedAt,
            }, segment.camera_id);
          }
        }

        logger.info(
          `Pipeline: ${segment.camera_id}/${segment.mode} → level ${result.perception_memory.perception_level} → "${result.perception_memory.summary.slice(0, 60)}"`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Pipeline failed for ${segment.segment_id}: ${msg}`);
        store.logError(segment.segment_id, segment.camera_id, "perception", msg);
      }
    };

    const processStreamSegment = (segment: Segment): Promise<void> | SegmentRuntimeTask => {
      if (resolvedPerceptionConfig.runtime_mode !== "live_latency") {
        return processStreamSegmentCompleted(segment);
      }

      let settledCritical = false;
      let resolveCritical!: () => void;
      let rejectCritical!: (err: unknown) => void;
      const criticalReady = new Promise<void>((resolve, reject) => {
        resolveCritical = () => {
          if (settledCritical) return;
          settledCritical = true;
          resolve();
        };
        rejectCritical = (err) => {
          if (settledCritical) return;
          settledCritical = true;
          reject(err);
        };
      });

      const completed = processStreamSegmentCompleted(segment, resolveCritical)
        .catch((err) => {
          rejectCritical(err);
          throw err;
        })
        .finally(() => {
          resolveCritical();
        });

      return { criticalReady, completed };
    };

    /** Synchronous analysis path for snapshot mode (tool needs the result). */
    const analyzeSnapshot = async (segment: Segment): Promise<PerceptionResult | null> => {
      try {
        return await runWithCameraMemoryUser(segment.camera_id, () => analyze(segment, pipelineDeps));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Pipeline failed for ${segment.segment_id}: ${msg}`);
        store.logError(segment.segment_id, segment.camera_id, "perception", msg);
        return null;
      }
    };

    const perceptionRuntime = new PerceptionRuntime({
      processStreamSegment,
      analyzeSnapshot,
      waitForObservers: () => memoryWriteScheduler.waitForIdle(),
      onStart: (segment) => {
        if (segment.mode !== "snapshot") {
          dashboardServer.publishSegmentProcessingPreview(segment);
          if (resolvedPerceptionConfig.animated_segment_previews === true) {
            void buildAnimatedSegmentPreviewBuffer(segment.frames)
              .then((buffer) => {
                if (!buffer) return;
                const gifPath = store.saveMedia(segment.camera_id, segment.segment_id, "gif", buffer, "preview");
                dashboardServer.publishSegmentProcessingPreview(segment, gifPath);
              })
              .catch((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                logger.warn(`[dashboard-preview] animated processing preview failed for ${segment.segment_id}: ${msg}`);
              });
          }
        }
      },
      onReject: (cameraId, segment) => {
        rejectedSegmentsTotal += 1;
        const msg = `Perception queue full for ${cameraId}; segment ${segment.segment_id} was not accepted`;
        logger.error(`[perception:scheduler] ${msg}`);
        store.logError(segment.segment_id, cameraId, "perception", msg);
        monitorBus.publish("system:queue_overflow", {
          queue: "segment",
          camera_id: cameraId,
          dropped_total: rejectedSegmentsTotal,
          rejected: true,
        }, cameraId);
      },
      onSkip: (cameraId, segment, info) => {
        skippedSegmentsTotal += 1;
        const msg = `Perception skipped ${cameraId}/${segment.segment_id}: backlog lag ${info.lagMs}ms exceeded ${info.thresholdMs}ms`;
        logger.warn(`[perception:scheduler] ${msg}`);
        store.logError(segment.segment_id, cameraId, "perception_skipped", msg);
        dashboardServer.publishSegmentSkippedPreview(segment, {
          reason: info.reason,
          lagMs: info.lagMs,
          thresholdMs: info.thresholdMs,
          skippedTotal: skippedSegmentsTotal,
        });
        monitorBus.publish("perception:segment_skipped", {
          camera_id: cameraId,
          segment_id: segment.segment_id,
          mode: segment.mode,
          raw_url: segment.raw_url,
          segment_start: segment.timestamp,
          duration_sec: segment.duration_sec,
          reason: info.reason,
          lag_ms: info.lagMs,
          threshold_ms: info.thresholdMs,
          latest_segment_id: info.latestSegmentId,
          skipped_total: skippedSegmentsTotal,
        }, cameraId);
      },
      onError: (err, segment) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Pipeline failed for ${segment.segment_id}: ${msg}`);
        store.logError(segment.segment_id, segment.camera_id, "perception", msg);
        runtimeHealth.observe({
          component: "pipeline",
          operation: "run",
          status: "down",
          code: "analysis_failed",
          scope: { source_id: segment.camera_id },
        });
      },
    }, {
      sourceConcurrency: maxConcurrentPerceptionSources,
      maxQueuedPerCamera,
      liveBacklogSkipAfterMs,
      streamDispatchMode: "by_input_mode",
      sourceOrderBarrier: resolvedPerceptionConfig.runtime_mode === "live_latency" ? "critical_ready" : "completed",
      maxInFlightPerCamera: 2,
    });
    logger.info(
      `[perception:scheduler] per-source FIFO enabled, source_concurrency=${maxConcurrentPerceptionSources}, ` +
      `max_queued_per_source=${maxQueuedPerCamera}, live_backlog_skip_after_ms=${liveBacklogSkipAfterMs}`,
    );

    // Expose pipeline drain for E2E / graceful shutdown.
    // Stored on process-level so test runners in the same process can access it.
    (globalThis as any).__cortex_waitForPipelineIdle = () => perceptionRuntime.waitForIdle();
    (globalThis as any).__cortex_getPerceptionBacklog = (cameraId?: string) => perceptionRuntime.getBacklog(cameraId);
    waitForCameraIdle = (cameraId: string) => perceptionRuntime.waitForCameraIdle(cameraId);

    // ── onSegment callback: Cam → Perception ──
    // Snapshot mode: synchronous (returns PerceptionResult for inline tool response).
    // Stream/event mode: dispatched through PerceptionRuntime.
    const onSegment = (segment: Segment): Promise<PerceptionResult | null> | void => {
      if (segment.mode !== "snapshot") {
        closedPreviewSegmentIds.add(segment.segment_id);
        if (closedPreviewSegmentIds.size > 500) {
          const first = closedPreviewSegmentIds.values().next().value as string | undefined;
          if (first) closedPreviewSegmentIds.delete(first);
        }
        if (perceptionRuntime.canAcceptSegment(segment)) {
          dashboardServer.publishSegmentQueuedPreview(segment);
        }
      }
      return perceptionRuntime.handleSegment(segment);
    };

    // ── onFrameProcessed hook: called by Cam after each sampled frame is fed to pipeline ──
    // Runs FrameAnalyzer (YOLO detection) and VisionController frame policy evaluation.
    const pendingFpsChange = new Map<string, { targetFps: number; requestedAt: number }>();
    const lastAppliedFps = new Map<string, number>();
    const closedPreviewSegmentIds = new Set<string>();
    const initializedPreviewSegmentIds = new Set<string>();
    const lastPreviewPublishedAtBySegment = new Map<string, number>();
    const frameDetectionDropLastReported = new Map<string, number>();

    if (frameAnalyzer && visionController) {
      camConfig.onFrameProcessed = (
        frame: {
          data: string;
          timestamp: number;
          width?: number;
          height?: number;
          detections?: unknown[];
          _segment_id?: string;
          _segment_start_timestamp?: number;
        },
        cameraId: string,
        motionHint: { has_motion: boolean; last_motion_at: number; last_still_at: number },
        vadHint?: { has_voice: boolean },
        context?: { input_mode: "local_file" | "live_stream" },
      ) => {
        // Check if a pending fps change was applied (first frame at new fps)
        const pending = pendingFpsChange.get(cameraId);
        if (pending) {
          pendingFpsChange.delete(cameraId);
          lastAppliedFps.set(cameraId, pending.targetFps);
          monitorBus.publish("vision_controller:action_applied", {
            camera_id: cameraId,
            target_fps: pending.targetFps,
            requested_at: pending.requestedAt,
            applied_at: frame.timestamp,
            latency_ms: frame.timestamp - pending.requestedAt,
          }, cameraId);
        }

        const initialPreviewSegmentId = typeof frame._segment_id === "string" ? frame._segment_id : "";
        if (initialPreviewSegmentId && !closedPreviewSegmentIds.has(initialPreviewSegmentId) && !initializedPreviewSegmentIds.has(initialPreviewSegmentId)) {
          initializedPreviewSegmentIds.add(initialPreviewSegmentId);
          if (initializedPreviewSegmentIds.size > 500) {
            const first = initializedPreviewSegmentIds.keys().next().value as string | undefined;
            if (first) initializedPreviewSegmentIds.delete(first);
          }
          dashboardServer.publishSegmentWatchingPreview({
            segmentId: initialPreviewSegmentId,
            cameraId,
            timestamp: typeof frame._segment_start_timestamp === "number"
              ? frame._segment_start_timestamp
              : context?.input_mode === "live_stream"
                ? Date.now()
                : frame.timestamp,
            currentTimestamp: frame.timestamp,
            frameBase64: frame.data,
            detections: [],
            inputMode: context?.input_mode,
          });
        }
        return frameAnalyzer.feedFrame(frame, cameraId, (result) => {
          // Attach detections to frame for downstream use by segment pipeline
          (frame as any).detections = result.detections;
          const segmentId = typeof frame._segment_id === "string" ? frame._segment_id : "";
          if (segmentId && !closedPreviewSegmentIds.has(segmentId)) {
            const now = Date.now();
            const lastPreviewAt = lastPreviewPublishedAtBySegment.get(segmentId) ?? 0;
            if (lastPreviewAt === 0 || now - lastPreviewAt >= 1000) {
              lastPreviewPublishedAtBySegment.set(segmentId, now);
              if (lastPreviewPublishedAtBySegment.size > 500) {
                const first = lastPreviewPublishedAtBySegment.keys().next().value as string | undefined;
                if (first) lastPreviewPublishedAtBySegment.delete(first);
              }
              dashboardServer.publishSegmentWatchingPreview({
                segmentId,
                cameraId,
                timestamp: typeof frame._segment_start_timestamp === "number"
                  ? frame._segment_start_timestamp
                  : context?.input_mode === "live_stream"
                    ? Date.now()
                    : result.frame_timestamp,
                currentTimestamp: result.frame_timestamp,
                frameBase64: frame.data,
                detections: result.detections,
                inputMode: context?.input_mode,
              });
            }
          }

          // Publish per-frame detections for E2E debug analysis
          if (debugFrames && result.detections.length > 0) {
            monitorBus.publish("perception:frame_detections", {
              camera_id: cameraId,
              timestamp: result.frame_timestamp,
              detections: result.detections,
            });
          }

          const framePolicy = visionController.evaluateFrame(
            cameraId,
            result.detections,
            motionHint,
            frame.timestamp,
            vadHint,
          );
          applyFramePolicy(framePolicy, cameraId, frame.timestamp);
        }, {
          policy: context?.input_mode === "local_file" ? "lossless" : "latest_only",
          onDrop: (event) => {
            const lastReported = frameDetectionDropLastReported.get(cameraId) ?? 0;
            if (event.dropped_total === 1 || event.dropped_total - lastReported >= 30) {
              frameDetectionDropLastReported.set(cameraId, event.dropped_total);
              logger.warn(
                `[frame-analyzer] Dropped live detection frame for ${cameraId} ` +
                `(total=${event.dropped_total}, ts=${Math.round(event.frame_timestamp)})`,
              );
              monitorBus.publish("perception:frame_detection_dropped", {
                camera_id: cameraId,
                frame_timestamp: event.frame_timestamp,
                dropped_total: event.dropped_total,
                reason: event.reason,
              }, cameraId);
            }
          },
        });
      };
    }

    // ── Load sub-plugins synchronously ──
    const subPlugins = [
      { plugin: camPlugin, config: { ...camConfig, onSegment } },
      { plugin: perceptionPlugin, config: perceptionConfig },
      { plugin: memoryPlugin, config: memoryConfig },
    ];

    for (const { plugin, config: subConfig } of subPlugins) {
      const subApi: OpenClawPluginApi = {
        ...api,
        pluginConfig: subConfig,
        logger: {
          info: (msg, ...args) => api.logger.info(`[${plugin.id}] ${msg}`, ...args),
          warn: (msg, ...args) => api.logger.warn(`[${plugin.id}] ${msg}`, ...args),
          error: (msg, ...args) => api.logger.error(`[${plugin.id}] ${msg}`, ...args),
        },
      };

      plugin.register(subApi);
      logger.info(`Loaded sub-plugin: ${plugin.name}`);
    }

    api.registerService({
      id: "cortex-pipeline-self-check",
      async start() {
        const go2rtcHealthy = await waitHttpOk(go2rtcEndpoint, "/api", 8000);
        const go2rtcConfigured = typeof config.cam?.go2rtc_bin === "string" && config.cam.go2rtc_bin.trim()
          ? config.cam.go2rtc_bin.trim()
          : undefined;
        const go2rtcCandidates = go2rtcConfigured ? [go2rtcConfigured] : [stableCortexBin(homeDir, "go2rtc")];
        const go2rtcBinaryOk = go2rtcCandidates.some(commandAvailable);

        const qdrantHealthy = await waitHttpOk(qdrant.endpoint, "/healthz", 5000);
        const memoryHealthy = await waitHttpOk(cortex.endpoint, "/health", 5000);
        const dashboardReachable = await waitHttpOk(`http://127.0.0.1:${dashboardServer.port}`, "/", 1500);
        const vadEnabled = config.cam?.vad_enabled !== false;
        const vadModel = typeof config.cam?.silero_vad_model === "string" && config.cam.silero_vad_model.trim()
          ? config.cam.silero_vad_model.trim()
          : join(homeDir, "models", "silero_vad.onnx");

        const components: PipelineSelfCheckComponent[] = [
          {
            name: "qdrant",
            status: qdrant.mode !== "stopped" && qdrantHealthy ? "ok" : "error",
            required: true,
            detail: `mode=${qdrant.mode} endpoint=${qdrant.endpoint} healthy=${qdrantHealthy}`,
          },
          {
            name: "memory_service",
            status: cortex.mode !== "stopped" && memoryHealthy ? "ok" : "error",
            required: true,
            detail: `mode=${cortex.mode} endpoint=${cortex.endpoint} healthy=${memoryHealthy}`,
          },
          requiredBinaryComponent("ffmpeg", config.cam?.ffmpeg_bin, undefined, stableCortexBin(homeDir, "ffmpeg")),
          requiredBinaryComponent("ffprobe", config.cam?.ffprobe_bin, undefined, stableCortexBin(homeDir, "ffprobe")),
          {
            name: "go2rtc",
            status: go2rtcHealthy ? "ok" : "error",
            required: true,
            detail: `endpoint=${go2rtcEndpoint} healthy=${go2rtcHealthy} binary_available=${go2rtcBinaryOk} binary_candidates=${go2rtcCandidates.join(",")}`,
          },
          {
            name: "pipeline_store",
            status: "ok",
            required: true,
            detail: `state_dir=${stateDir}`,
          },
          {
            name: "monitor_ui",
            status: dashboardReachable ? "ok" : "warn",
            detail: `url=http://127.0.0.1:${dashboardServer.port} reachable=${dashboardReachable}`,
          },
          {
            name: "semantic_context",
            status: pipelineDeps.semanticContext ? "ok" : "disabled",
            detail: pipelineDeps.semanticContext ? "wired" : "not wired",
          },
          {
            name: "vision_controller",
            status: visionController ? "ok" : "disabled",
            detail: visionController ? `rules=${visionController.getConfig().rules?.length ?? 0}` : "not configured",
          },
          {
            name: "frame_analyzer",
            status: frameAnalyzer ? "ok" : "disabled",
            detail: frameAnalyzer ? "router-backed detection enabled" : "local frame detection disabled",
          },
          {
            name: "vad",
            status: !vadEnabled ? "disabled" : commandAvailable(vadModel) ? "ok" : "warn",
            detail: !vadEnabled ? "vad_enabled=false" : `model=${vadModel}`,
          },
        ];

        logPipelineSelfCheck(pipelineDeps, {
          mode: "cortex-main",
          label: "all-in-one",
          throwOnFatal: true,
          components,
          logger: (message) => logger.info(message),
        });
      },
    });

    // ── Notification policy tool ──
    api.registerTool({
      name: "cortex_notify",
      description: `Manage per-camera notification policies.

Actions:
- get_policy: Show current notification policy for a camera. Params: name (required).
- set_policy: Change notification policy. Params: name (required), policy (required).
- list_policies: Show all cameras and their policies. No params needed.

Policies:
- "always": Push a notification for every segment with activity (continuous updates).
- "smart": Let the AI decide what's noteworthy (default — only significant events).
- "security_only": Only push security alerts (intrusion, emergency, etc.).

Note: The first segment after starting a watch ALWAYS sends a notification regardless of policy.`,
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["get_policy", "set_policy", "list_policies"] },
          name: { type: "string", description: "Camera name or id" },
          policy: { type: "string", enum: ["always", "smart", "security_only"] },
        },
        required: ["action"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const action = params.action as string;
        const watchStates = loadPersistedWatchStates();

        if (action === "list_policies") {
          if (watchStates.length === 0) return JSON.stringify({ message: "No active watches." });
          const policies = watchStates.map((ws) => ({
            camera: ws.id,
            policy: ws.notifyPolicy ?? "smart",
            mode: ws.mode,
          }));
          return JSON.stringify({ cameras: policies });
        }

        const nameOrId = params.name as string;
        if (!nameOrId) return JSON.stringify({ error: "name is required" });

        const ws = watchStates.find((w) => w.id === nameOrId || w.id === nameOrId.toLowerCase().replace(/\s+/g, "_"));
        if (!ws) return JSON.stringify({ error: `No active watch for "${nameOrId}". Use cortex_cam list_sources.` });

        if (action === "get_policy") {
          return JSON.stringify({ camera: ws.id, policy: ws.notifyPolicy ?? "smart" });
        }

        if (action === "set_policy") {
          const policy = params.policy as NotifyPolicy;
          if (!["always", "smart", "security_only"].includes(policy)) {
            return JSON.stringify({ error: `Invalid policy: ${policy}. Must be always, smart, or security_only.` });
          }
          const ok = updateWatchState(ws.id, { notifyPolicy: policy });
          if (!ok) return JSON.stringify({ error: `Failed to update policy for "${ws.id}".` });
          logger.info(`[cortex] Notification policy for ${ws.id} changed to: ${policy}`);
          return JSON.stringify({ camera: ws.id, policy, message: `Policy updated to "${policy}".` });
        }

        return JSON.stringify({ error: `Unknown action: ${action}` });
      },
    });

    // ── Source Context tool: stable external entry point for user-provided background ──
    api.registerTool({
      name: "cortex_source_context",
      description: `Set or read user-provided background context for a camera/source.

Actions:
- set: Update the user-provided Background Context subsection. Params: camera_id (or name), content (or source_context/semantic_context_background).
- get: Read current full Semantic Context. Params: camera_id (or name).

Use this for source background supplied by a user. Runtime observations continue updating the generated Semantic Context sections separately.`,
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["set", "get"] },
          camera_id: { type: "string", description: "Camera/source id" },
          name: { type: "string", description: "Camera/source id alias" },
          content: { type: "string", description: "User-provided source background context" },
          source_context: { type: "string", description: "User-provided source background context" },
          semantic_context_background: { type: "string", description: "User-provided source background context" },
        },
        required: ["action"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const action = params.action as string;
        const cameraId = typeof params.camera_id === "string" && params.camera_id.trim()
          ? params.camera_id.trim()
          : typeof params.name === "string" && params.name.trim()
            ? params.name.trim()
            : "";
        if (!cameraId) return JSON.stringify({ error: "camera_id is required" });

        if (action === "get") {
          try {
            const content = await pipelineDeps.semanticContext?.load(cameraId);
            return JSON.stringify({ ok: true, camera_id: cameraId, content: content ?? "" });
          } catch (err) {
            return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
          }
        }

        if (action === "set") {
          const content = typeof params.content === "string" && params.content.trim()
            ? params.content
            : typeof params.source_context === "string" && params.source_context.trim()
              ? params.source_context
              : typeof params.semantic_context_background === "string" && params.semantic_context_background.trim()
                ? params.semantic_context_background
                : "";
          const result = await setSemanticContextUserBackground({ cameraId, content, source: "tool" });
          return JSON.stringify(result.ok ? result : { error: result.error });
        }

        return JSON.stringify({ error: `Unknown action: ${action}` });
      },
    });

    // ── Periodic health broadcasting for monitor (every 30s) ──
    const broadcastHealth = async () => {
      try {
        const health: Record<string, string> = {};
        try {
          const memHealth = await memoryClient.health();
          health.Cortex = memHealth.status ?? "unknown";
        } catch { health.Cortex = "down"; }
        try {
          const resp = await fetch(`${qdrant.endpoint}/collections`);
          health.Qdrant = resp.ok ? "ok" : "down";
        } catch { health.Qdrant = "down"; }
        try {
          const resp = await fetch(`${go2rtcEndpoint}/api`);
          health.Go2RTC = resp.ok ? "ok" : "down";
        } catch { health.Go2RTC = "down"; }
        try {
          const resp = await fetch(`http://localhost:${dashboardServer.port}/`);
          health.Monitor = resp.ok ? "ok" : "down";
        } catch { health.Monitor = "down"; }
        monitorBus.publish("system:service_health", { services: health });
        monitorBus.publish("system:active_models", { models: activeModels });
        const backlog = perceptionRuntime.getBacklog();
        monitorBus.publish("system:pipeline_metrics", {
          metric_type: "perception_backlog",
          queued: backlog.queued,
          running: backlog.running,
          pending: backlog.pending,
          total_backlog: backlog.total,
          rejected_total: backlog.rejectedTotal,
          skipped_total: skippedSegmentsTotal,
          by_camera: backlog.byCamera,
          running_by_camera: backlog.runningByCamera,
          pending_by_camera: backlog.pendingByCamera,
          rejected_by_camera: backlog.rejectedByCamera,
          degraded: backlog.total >= Math.max(1, maxQueuedPerCamera)
            || rejectedSegmentsTotal > 0
            || skippedSegmentsTotal > 0,
        });
      } catch {
        // Health check must never crash the process
      }
    };
    let healthInterval: ReturnType<typeof setInterval> | null = null;

    // Start/stop the heartbeat with the gateway service lifecycle. Keeping the
    // timer out of register() lets plugin introspection commands exit cleanly.
    api.registerService({
      id: "health-heartbeat",
      async start() {
        if (healthInterval) return;
        healthInterval = setInterval(() => { void broadcastHealth(); }, 30_000);
        void broadcastHealth();
      },
      async stop() {
        if (!healthInterval) return;
        clearInterval(healthInterval);
        healthInterval = null;
      },
    });

    // Initialize notifier when runtime is available (gateway_start ensures
    // both channel send functions and subagent dispatch are ready)
    api.on("gateway_start", () => {
      logger.info("gateway_start hook fired — initializing Notifier");

      // Parse session key to extract channel + target for direct send (Path A)
      // Session key format: "agent:main:discord:direct:123456" or "agent:main:main"
      const parseSessionKey = (sessionKey: string): { channel: string; to: string } | null => {
        const parts = sessionKey.split(":");
        // agent:<agentId>:<channel>:<kind>:<peerId>
        if (parts.length >= 5) {
          const channel = parts[2]!;
          const kind = parts[3]!; // "direct", "channel", "guild", etc.
          const peerId = parts.slice(4).join(":");
          // Discord/Telegram/Slack need "user:ID" or "channel:ID" prefix
          const prefix = kind === "direct" ? "user" : "channel";
          return { channel, to: `${prefix}:${peerId}` };
        }
        // agent:<agentId>:main (webchat) — no direct send target for webchat
        return null;
      };

      // Channel-agnostic send: routes to the correct channel's send function
      const sendMessage = async (channel: string, to: string, text: string, mediaUrl?: string) => {
        const cfg = api.runtime.config.loadConfig();
        const stateDir = api.runtime.state.resolveStateDir();
        const mediaOpts = mediaUrl ? { mediaUrl, mediaLocalRoots: [stateDir] } : {};
        switch (channel) {
          case "discord":
            await api.runtime.channel.discord.sendMessageDiscord(to, text, { cfg, ...mediaOpts });
            break;
          case "telegram":
            await api.runtime.channel.telegram.sendMessageTelegram(to, text, { cfg, ...mediaOpts });
            break;
          case "slack":
            await api.runtime.channel.slack.sendMessageSlack(to, text, { cfg, ...mediaOpts });
            break;
          default:
            logger.error(`[cortex] Unsupported channel for direct send: ${channel}`);
        }
      };

      notifier = new Notifier({
        sendMessage,
        subagentRun: (params) => api.runtime.subagent.run(params),
        parseSessionKey,
        logger,
      });

      logger.info("[cortex] Notifier ready — per-camera channel routing enabled");
    });
  },
};

function serializeVisionControllerSignals(signals?: VisionControllerSignals): Record<string, unknown> | undefined {
  if (!signals) return undefined;
  return {
    detected_classes: [...signals.detected_classes],
    class_counts: Object.fromEntries(signals.class_counts),
    face_detected: signals.face_detected,
    has_motion: signals.has_motion,
    motion_sustained_ms: signals.motion_sustained_ms,
    no_motion_ms: signals.no_motion_ms,
    voice_detected: signals.voice_detected,
    has_unknown_entity: signals.has_unknown_entity,
    known_entity_ids: [...signals.known_entity_ids],
    security_risk: signals.security_risk,
    static_scene_count: signals.static_scene_count,
    disappeared_classes: [...signals.disappeared_classes],
    custom_fields: signals.custom_fields,
  };
}

function compactVisionControllerText(text: string | undefined, maxChars: number): string | undefined {
  const value = text?.replace(/\s+/g, " ").trim();
  if (!value) return undefined;
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

function readPositiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function readNonNegativeInt(value: unknown, fallback: number): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function formatAdaptivePromptForDisplay(config: Record<string, unknown> | undefined, exitCondition: unknown): string | undefined {
  const sections: string[] = [];
  const addConfigSection = (title: string, value: unknown) => {
    if (typeof value === "string") {
      const text = value.trim();
      if (text) sections.push(`${title}:\n${text}`);
      return;
    }
    if (!Array.isArray(value)) return;
    const items = value
      .map((item) => typeof item === "string" ? item.trim() : "")
      .filter(Boolean);
    if (items.length > 0) sections.push(`${title}:\n${items.map((item) => `- ${item}`).join("\n")}`);
  };

  addConfigSection("Scene description", config?.scene_description);
  addConfigSection("Focus targets", config?.focus_targets);
  addConfigSection("Security rules", config?.security_rules);
  if (exitCondition !== undefined) sections.push(`Exit condition:\n${JSON.stringify(exitCondition)}`);
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}
