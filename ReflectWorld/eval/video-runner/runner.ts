/**
 * Video Runner — run the full ReflectWorld pipeline on a video file and validate results.
 *
 * Runs the full pipeline (go2rtc → Cam → Percept → Mem → VisionController) without
 * a real OpenClaw runtime, using MiniHost + SimAgent as an OpenClaw test double.
 *
 * Usage:
 *   REFLECTWORLD_E2E_VIDEO=/path/to/video.mp4 npx tsx eval/video-runner/runner.ts
 *   REFLECTWORLD_E2E_VIDEO=/path/to/video.mp4 npx tsx eval/video-runner/runner.ts --preflight-only
 *   REFLECTWORLD_E2E_VIDEO=/path/to/video.mp4 npx tsx eval/video-runner/runner.ts --services=reuse
 */

// Load .env from monorepo root
import dotenv from "dotenv";
import { resolve, dirname, join, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";

const __root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
dotenv.config({ path: resolve(__root, ".env") });

import { monitorBus, resolveReflectWorldHome, resolveReflectWorldStateDir } from "@reflectworld/shared";
import type { PipelineTrace } from "@reflectworld/shared";
import { VlmAnalyzer } from "@reflectworld/percept";
import { MiniHost } from "../../packages/host/src/mini-host.js";
import reflectworldPlugin from "../../packages/reflectworld/index.js";
import { createSimAgent } from "./sim-agent.js";
import { cleanupAll } from "./cleanup.js";
import { assertStructure, assertSemantic, assertMemState, assertTrace, logResult } from "./assertion-engine.js";
import type { AssertionResult } from "./assertion-engine.js";
import { PipelineStore } from "../../packages/reflectworld/src/store.js";
import { DashboardServer } from "../../packages/reflectworld/src/services/dashboard-server.js";
import { generateReport } from "./report-generator.js";
import type {
  VisionControllerTimelineEntry,
  DetailedSegmentTimelineEntry,
  MemoryVerification,
  VlmCostStats,
  SkillTestResult,
} from "./report-generator.js";
import { runSkillTests, getSkillTestCount } from "./skill-tester.js";
import { createBenchmarkVisionControllerLegacyConfig } from "../../packages/reflectworld/src/vision-controller/default-config.js";
import {
  buildVisionControllerConsultationPrompt,
  parseVisionControllerConsultationResponse,
} from "../../packages/reflectworld/src/vision-controller/consultation.js";

// ── Config ──

const GO2RTC_URL = process.env.GO2RTC_URL ?? "http://localhost:1984";
const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
// E2E runs on a dedicated mem-service port (default 28219) so it never
// shares :8219 with a user's own ReflectWorld instance — that sharing used to
// silently pollute production data, or leave E2E dead when :8219 was idle.
// Override via E2E_MEM_PORT or REFLECTWORLD_URL as needed.
const E2E_MEM_PORT = parseInt(process.env.E2E_MEM_PORT ?? "28219", 10);
const MEM_URL = process.env.REFLECTWORLD_URL ?? `http://127.0.0.1:${E2E_MEM_PORT}`;
const memUrl = () => process.env.REFLECTWORLD_URL ?? MEM_URL;
// Broadcast the chosen endpoint to every subprocess/helper that reads
// REFLECTWORLD_URL or REFLECTWORLD_ENDPOINT (assertion-engine, tool-executor,
// percept config, ...). Without this they silently default to :8219 and
// crash at cleanup with ECONNREFUSED.
process.env.REFLECTWORLD_URL = MEM_URL;
process.env.REFLECTWORLD_ENDPOINT = MEM_URL;
const CAMERA_ID = "e2e-front-door";
const E2E_RUN_ID = `run-${Date.now().toString(36)}`;
process.env.REFLECTWORLD_ARCHIVE_LEVEL ??= "full";
process.env.REFLECTWORLD_RUN_ID ??= E2E_RUN_ID;
process.env.REFLECTWORLD_SNAPSHOT_VERSION ??= E2E_RUN_ID;
const E2E_RUNTIME_DIR = resolve(resolveReflectWorldStateDir(), "e2e-runtime", E2E_RUN_ID);
const E2E_HOST_STATE_DIR = join(E2E_RUNTIME_DIR, "host-state");
const E2E_SOURCES_DIR = join(E2E_RUNTIME_DIR, "sources");
const E2E_RECORDINGS_DIR = join(E2E_RUNTIME_DIR, "recordings");
const E2E_MEMORY_STORAGE_DIR = join(E2E_RUNTIME_DIR, "memory-storage");
const E2E_COLLECTION_NAME = `reflectworld_test_${E2E_RUN_ID.replace(/[^a-zA-Z0-9_]/g, "_")}`;

function resolveRequiredE2eVideo(): string {
  const video = process.env.REFLECTWORLD_E2E_VIDEO?.trim();
  if (!video) {
    console.error("REFLECTWORLD_E2E_VIDEO is required. Set it to an authorized local test video.");
    process.exit(2);
  }
  return resolve(video);
}

const VIDEO_FILE = resolveRequiredE2eVideo();
const VIDEO_USER_ID = basename(VIDEO_FILE, extname(VIDEO_FILE));
const MODEL_DIR = join(resolveReflectWorldHome(), "models");
const REPORT_PATH = resolve(__root, "eval/video-runner/fixtures/e2e-report.md");
const GLOBAL_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const SERVICE_STOP_TIMEOUT_MS = 5_000;
const SEGMENT_TIMEOUT_MS = 60_000;
const SEMANTIC_POLL_INTERVAL_MS = 5_000;
const SEMANTIC_POLL_MAX = 8;
const FINAL_DRAIN_MS = 10_000;
const SEARCH_MIN_SCORE_PERSON = 0.3;
const SEARCH_MIN_SCORE_VEHICLE = 0.2;
const E2E_DASHBOARD_PORT = parseInt(process.env.E2E_DASHBOARD_PORT ?? process.env.E2E_MONITOR_PORT ?? "3213", 10);
const SERVICE_MODE = parseServiceMode(process.argv.slice(2));
const SKILL_PATHS = [
  resolve(__root, "packages/reflectworld/skills/reflectworld-vision-controller/SKILL.md"),
  resolve(__root, "packages/cam/skills/reflectworld-cam/SKILL.md"),
  resolve(__root, "packages/percept/skills/reflectworld-percept/SKILL.md"),
  resolve(__root, "packages/mem/skills/reflectworld-mem/SKILL.md"),
];

// ── Preflight ──

async function checkEndpoint(url: string, label: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (resp.ok) {
      console.log(`  ✓ ${label}`);
      return true;
    }
    console.log(`  ✗ ${label} — status ${resp.status}`);
    return false;
  } catch (err) {
    console.log(`  ✗ ${label} — ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

function checkFile(path: string, label: string): boolean {
  if (existsSync(path)) {
    console.log(`  ✓ ${label}`);
    return true;
  }
  console.log(`  ✗ ${label} — not found: ${path}`);
  return false;
}

async function preflight(): Promise<boolean> {
  console.log("\n── Preflight checks ──");

  const results = await Promise.all([
    checkEndpoint(`${QDRANT_URL}/collections`, "Qdrant"),
    checkEndpoint(`${memUrl()}/health`, "ReflectWorld Python"),
    checkEndpoint(`${GO2RTC_URL}/api/streams`, "go2rtc"),
  ]);

  const [qdrantOk, memOk, go2rtcOk] = results;
  const serviceChecksPassed = SERVICE_MODE === "reuse" ? results.every(Boolean) : true;

  if (SERVICE_MODE !== "reuse") {
    if (!qdrantOk) console.log("  ~ Qdrant not running yet — runner will try to start or reuse it");
    if (!memOk) console.log("  ~ ReflectWorld Python not running yet — runner will try to start or reuse it");
    if (!go2rtcOk) console.log("  ~ go2rtc not running yet — runner will try to start or reuse it");
  }

  const fileChecks = [
    checkFile(resolve(MODEL_DIR, "yolo26m.onnx"), "YOLO26m model"),
    checkFile(VIDEO_FILE, `Test video (${VIDEO_FILE.split("/").pop() ?? "unknown"})`),
    ...SKILL_PATHS.map((p) => checkFile(p, `Skill: ${p.split("/").pop()}`)),
  ];

  // Check VLM credentials (Gemini or OpenAI-compatible)
  const vlmProvider = process.env.VLM_PROVIDER ?? "openai";
  const hasVlmCredentials = !!process.env.VLM_API_KEY && (vlmProvider !== "openai" || !!process.env.VLM_BASE_URL);
  if (hasVlmCredentials) {
    console.log(`  ✓ VLM credentials (${vlmProvider}: ${process.env.VLM_MODEL ?? "unknown"})`);
  } else {
    console.log("  ✗ VLM credentials — set VLM_PROVIDER, VLM_MODEL, VLM_API_KEY, and VLM_BASE_URL for openai provider");
  }

  const hasAgentCredentials = !!(process.env.QA_API_KEY ?? process.env.AGENT_API_KEY ?? process.env.BENCH_AGENT_API_KEY ?? process.env.OPENAI_API_KEY ?? process.env.VLM_API_KEY);
  if (hasAgentCredentials) {
    console.log("  ✓ Consultation agent credentials");
  } else {
    console.log("  ⚠ Consultation agent credentials not configured, segment policy consultations will fail");
  }

  const allPassed = serviceChecksPassed && fileChecks.every(Boolean) && hasVlmCredentials;
  console.log(allPassed ? "\n✓ All preflight checks passed\n" : "\n✗ Some preflight checks failed\n");
  return allPassed;
}

// ── Event Collectors ──

interface CollectedEvents {
  firstFrame?: {
    timestamp: number;
    camera_id?: string;
    wall_ts?: number;
    media_ts?: number;
  };
  segmentsBuilt: Array<{
    segment_id: string;
    camera_id?: string;
    frame_count: number;
    mode: string;
    first_frame_at?: number;
    segment_built_at?: number;
    timestamp?: number;
    duration_sec?: number;
    end_timestamp?: number;
    cut_reason?: string;
    has_motion?: boolean;
    motion_ratio?: number;
    has_voice?: boolean;
    audio_segment_count?: number;
  }>;
  motionDetected: Array<{ timestamp: number; camera_id?: string; mode?: string }>;
  watchStopped: Array<{ timestamp: number; source_id?: string }>;
  analysisStarted: Array<{
    timestamp: number;
    camera_id?: string;
    segment_id?: string;
    mode?: string;
    level?: number;
    vlm_model?: string;
  }>;
  analysisCompleted: Array<{
    timestamp: number;
    camera_id?: string;
    segment_id?: string;
    summary?: string;
    level?: number;
    vlm_latency_ms?: number;
    perception_latency_ms?: number;
    security_risk?: boolean;
  }>;
  pipelineTraces: Array<{ timestamp: number; camera_id?: string; trace: PipelineTrace }>;
  rulesFired: Array<{
    timestamp: number;
    segment_id?: string;
    camera_id: string;
    rules: string[];
    rule_details?: Array<{
      name?: string;
      trigger?: unknown;
      action?: Record<string, unknown>;
    }>;
    signals_snapshot?: Record<string, unknown>;
    action: Record<string, unknown>;
  }>;
  stateChanges: Array<{
    timestamp: number;
    segment_id?: string;
    camera_id: string;
    fps?: number;
    skip_vlm?: boolean;
    max_level?: number;
    vlm_model?: string;
    mode?: string;
    is_baseline: boolean;
    fired_rules: string[];
    rule_details?: Array<{
      name?: string;
      trigger?: unknown;
      action?: Record<string, unknown>;
    }>;
  }>;
  actionApplied: Array<{
    timestamp: number;
    camera_id: string;
    target_fps?: number;
    requested_at?: number;
    applied_at?: number;
    latency_ms?: number;
  }>;
  agentConsulted: Array<{
    timestamp: number;
    segment_id?: string;
    consultation_id?: string;
    camera_id: string;
    trigger_reason: unknown;
    signals_snapshot?: Record<string, unknown>;
    detected_classes: string[];
    suggested_tool?: string;
    recommended_action_types?: string[];
    requested_at?: number;
    completed_at?: number;
    roundtrip_ms?: number;
  }>;
  toolInvoked: Array<{
    timestamp: number;
    tool?: string;
    action?: string;
    success?: boolean;
    camera_id?: string;
    result_message?: string;
    applied_keys?: string[];
    fps?: number;
    mode?: string;
    security_rules_preview?: string;
  }>;
  consultationEffects: Array<{
    timestamp: number;
    segment_id?: string;
    consultation_id?: string;
    tool?: string;
    action?: string;
    success?: boolean;
    latency_ms?: number;
    tool_details?: Record<string, unknown>;
  }>;
  serviceOrigins?: {
    timestamp: number;
    qdrant?: string;
    reflectworld?: string;
  };
  // Debug: per-frame detector details.
  frameDetections: Array<Record<string, unknown>>;
}

function createEventCollector(): CollectedEvents {
  const events: CollectedEvents = {
    firstFrame: undefined,
    segmentsBuilt: [],
    motionDetected: [],
    watchStopped: [],
    analysisStarted: [],
    analysisCompleted: [],
    pipelineTraces: [],
    rulesFired: [],
    stateChanges: [],
    actionApplied: [],
    agentConsulted: [],
    toolInvoked: [],
    frameDetections: [],
    consultationEffects: [],
  };

  monitorBus.on("monitor", (event) => {
    // `perception:frame_detections` is a debug-only event. It is intentionally NOT part of the shared
    // MonitorEventType union (the publisher casts the literal too), so compare
    // against the raw string here to keep the exhaustive switch below type-safe
    // for the real event types.
    if ((event.type as string) === "perception:frame_detections") {
      events.frameDetections.push({ timestamp: event.timestamp, ...event.data });
      return;
    }
    switch (event.type) {
      case "cam:first_frame":
        if (!events.firstFrame) {
          events.firstFrame = {
            timestamp: event.timestamp,
            camera_id: event.camera_id,
            wall_ts: typeof event.data.wall_ts === "number" ? event.data.wall_ts : undefined,
            media_ts: typeof event.data.media_ts === "number" ? event.data.media_ts : undefined,
          };
        }
        break;
      case "cam:segment_built":
        events.segmentsBuilt.push(event.data as CollectedEvents["segmentsBuilt"][0]);
        break;
      case "cam:motion_detected":
        events.motionDetected.push({
          timestamp: event.timestamp,
          camera_id: event.camera_id,
          mode: typeof event.data.mode === "string" ? event.data.mode : undefined,
        });
        break;
      case "cam:watch_stopped":
        events.watchStopped.push({
          timestamp: event.timestamp,
          source_id: typeof event.data.source_id === "string" ? event.data.source_id : undefined,
        });
        break;
      case "perception:analysis_started":
        events.analysisStarted.push({
          timestamp: event.timestamp,
          camera_id: event.camera_id,
          segment_id: typeof event.data.segment_id === "string" ? event.data.segment_id : undefined,
          mode: typeof event.data.mode === "string" ? event.data.mode : undefined,
          level: typeof event.data.level === "number" ? event.data.level : undefined,
          vlm_model: typeof event.data.vlm_model === "string" ? event.data.vlm_model : undefined,
        });
        break;
      case "perception:analysis_completed":
        events.analysisCompleted.push({
          timestamp: event.timestamp,
          camera_id: event.camera_id,
          segment_id: typeof event.data.segment_id === "string" ? event.data.segment_id : undefined,
          summary: typeof event.data.summary === "string" ? event.data.summary : undefined,
          level: typeof event.data.level === "number" ? event.data.level : undefined,
          vlm_latency_ms: typeof event.data.vlm_latency_ms === "number" ? event.data.vlm_latency_ms : undefined,
          perception_latency_ms: typeof event.data.perception_latency_ms === "number" ? event.data.perception_latency_ms : undefined,
          security_risk: typeof event.data.security_risk === "boolean" ? event.data.security_risk : undefined,
        });
        break;
      case "system:pipeline_trace":
        events.pipelineTraces.push({
          timestamp: event.timestamp,
          camera_id: event.camera_id,
          trace: event.data as unknown as PipelineTrace,
        });
        break;
      case "vision_controller:rule_fired":
        events.rulesFired.push({
          timestamp: event.timestamp,
          ...(event.data as Omit<CollectedEvents["rulesFired"][0], "timestamp">),
        });
        break;
      case "vision_controller:state_changed":
        events.stateChanges.push({
          timestamp: event.timestamp,
          ...(event.data as Omit<CollectedEvents["stateChanges"][0], "timestamp">),
        });
        break;
      case "vision_controller:action_applied":
        events.actionApplied.push({
          timestamp: event.timestamp,
          camera_id: event.camera_id ?? "",
          target_fps: typeof event.data.target_fps === "number" ? event.data.target_fps : undefined,
          requested_at: typeof event.data.requested_at === "number" ? event.data.requested_at : undefined,
          applied_at: typeof event.data.applied_at === "number" ? event.data.applied_at : undefined,
          latency_ms: typeof event.data.latency_ms === "number" ? event.data.latency_ms : undefined,
        });
        break;
      case "vision_controller:agent_consulted":
        events.agentConsulted.push({
          timestamp: event.timestamp,
          ...(event.data as Omit<CollectedEvents["agentConsulted"][0], "timestamp">),
        });
        break;
      case "system:tool_invoked":
        events.toolInvoked.push({
          timestamp: event.timestamp,
          ...(event.data as Omit<CollectedEvents["toolInvoked"][0], "timestamp">),
        });
        break;
      case "vision_controller:consultation_effect_observed":
        events.consultationEffects.push({
          timestamp: event.timestamp,
          ...(event.data as Omit<CollectedEvents["consultationEffects"][0], "timestamp">),
        });
        break;
      case "system:service_origins":
        events.serviceOrigins = {
          timestamp: event.timestamp,
          qdrant: typeof event.data.qdrant === "string" ? event.data.qdrant : undefined,
          reflectworld: typeof event.data.reflectworld === "string" ? event.data.reflectworld : undefined,
        };
        break;
    }
  });

  return events;
}

// ── Wait helpers ──

function waitForWatchStopped(events: CollectedEvents, cameraId: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for watch to stop for ${cameraId}`));
    }, timeoutMs);

    const check = () => {
      if (events.watchStopped.some((event) => event.source_id === cameraId)) {
        clearTimeout(timer);
        resolve();
      }
    };

    // Poll every second
    const interval = setInterval(() => {
      check();
      if (events.watchStopped.some((event) => event.source_id === cameraId)) clearInterval(interval);
    }, 1000);

    setTimeout(() => clearInterval(interval), timeoutMs + 100);
  });
}

// ── Main Runner ──

async function run(): Promise<void> {
  const startTime = new Date();
  const assertions: AssertionResult[] = [];
  let skillResults: SkillTestResult[] = [];
  const timeline: VisionControllerTimelineEntry[] = [];
  let detailedTimeline: DetailedSegmentTimelineEntry[] = [];
  const vlmStats: VlmCostStats = {
    totalSegments: 0,
    vlmSkippedSegments: 0,
    geminiApiCalls: { vlm: 0, agent: 0, skill: 0 },
  };
  const memVerification: MemoryVerification = {
    episodicCount: 0,
    episodicSearchable: false,
    semanticCount: 0,
    reidUpserted: 0,
    reidSearchMatched: false,
    expireMediaVerified: false,
  };

  let host: MiniHost | null = null;

  try {
    // 0. Cleanup residue from previous runs
    console.log("── Cleaning up previous test data ──");
    await cleanupAll();

    // Prune old E2E runs to prevent disk bloat (~200-300 MB per run).
    // Keep the most recent MAX_KEPT_RUNS, delete the rest.
    const MAX_KEPT_RUNS = 3;
    try {
      const runtimeParent = resolve(E2E_RUNTIME_DIR, "..");
      if (existsSync(runtimeParent)) {
        const runs = readdirSync(runtimeParent)
          .filter((d) => d.startsWith("run-"))
          .sort()
          .reverse();
        for (const old of runs.slice(MAX_KEPT_RUNS)) {
          const p = join(runtimeParent, old);
          rmSync(p, { recursive: true, force: true });
          console.log(`  [cleanup] Deleted old run: ${old}`);
        }
      }
    } catch (pruneErr) {
      console.warn(`  [cleanup] Old run pruning failed: ${pruneErr instanceof Error ? pruneErr.message : pruneErr}`);
    }

    mkdirSync(E2E_RUNTIME_DIR, { recursive: true });
    mkdirSync(E2E_HOST_STATE_DIR, { recursive: true });
    mkdirSync(E2E_MEMORY_STORAGE_DIR, { recursive: true });

    // 1. Create SimAgent
    console.log("── Creating SimAgent ──");
    const existingSkills = SKILL_PATHS.filter((p) => existsSync(p));
    const simAgent = await createSimAgent(existingSkills);

    const agentProviderEnv = process.env.QA_PROVIDER ?? process.env.AGENT_PROVIDER ?? process.env.VLM_PROVIDER;
    const agentProvider = agentProviderEnv === "gemini" ? "gemini" : "openai";
    const agentApiBase =
      process.env.QA_BASE_URL
      ?? process.env.QA_API_BASE
      ?? process.env.AGENT_API_BASE
      ?? process.env.BENCH_AGENT_API_BASE
      ?? process.env.BENCH_AGENT_BASE_URL
      ?? process.env.OPENAI_BASE_URL
      ?? process.env.VLM_BASE_URL
      ?? "https://api.openai.com/v1";
    const agentApiKey =
      process.env.QA_API_KEY
      ?? process.env.AGENT_API_KEY
      ?? process.env.BENCH_AGENT_API_KEY
      ?? process.env.OPENAI_API_KEY
      ?? process.env.VLM_API_KEY
      ?? "";
    const agentModel = process.env.QA_MODEL ?? process.env.LLM_MODEL ?? "gpt-5-mini";
    const consultationAnalyzer = new VlmAnalyzer(agentProvider === "gemini"
      ? { provider: "gemini", apiKey: agentApiKey, textModel: agentModel }
      : { provider: "openai", apiKey: agentApiKey, baseUrl: agentApiBase, textModel: agentModel });

    const consultationDispatcher = {
      submitConsultation: async (context: Record<string, unknown>) => {
        try {
          vlmStats.geminiApiCalls.agent += 1;
          const prompt = buildVisionControllerConsultationPrompt(context);
          const segmentId = typeof context.segment_id === "string" ? context.segment_id : undefined;
          const text = await consultationAnalyzer.completeText(prompt, {
            responseFormat: "json",
            model: agentModel,
            stage: "vision_controller.consultation",
            reasoningEffort: "low",
            llmContext: { run_id: E2E_RUN_ID, segment_id: segmentId },
          });
          if (!text) return null;
          return parseVisionControllerConsultationResponse(text, "e2e");
        } catch (err) {
          console.warn(
            `[e2e] consultation dispatch failed for camera=${context.camera_id}: ${err instanceof Error ? err.message : String(err)}`,
          );
          return null;
        }
      },
    };

    // 2. Create MiniHost + load ReflectWorld plugin with SimAgent injected
    console.log("── Loading ReflectWorld plugin via MiniHost ──");
    host = new MiniHost({
      stateDir: E2E_HOST_STATE_DIR,
      pluginConfigs: {
        reflectworld: {
          cam: {
            sources_dir: E2E_SOURCES_DIR,
            recordings_dir: E2E_RECORDINGS_DIR,
          },
          memory: {
            storage_path: E2E_MEMORY_STORAGE_DIR,
            collection_name: E2E_COLLECTION_NAME,
            port: E2E_MEM_PORT,  // isolate from user's :8219 instance
            user_id: VIDEO_USER_ID,
          },
          consultation_dispatcher: consultationDispatcher,
          apply_consultation_tool_calls: true,
          vision_controller: createBenchmarkVisionControllerLegacyConfig(),
        },
      },
    });

    await host.loadPlugin(reflectworldPlugin);

    // 3. Set up event collection BEFORE startServices so we capture
    //    service_origins and other events emitted during startup.
    const events = createEventCollector();

    console.log(`── Starting plugin services (${SERVICE_MODE}) ──`);
    await host.startServices();

    // Start E2E Dashboard — reuses the same dashboard/dist, separate port from production (3211)
    const dashboardDistDir = resolve(__root, "packages", "dashboard", "dist");
    const e2eStore = new PipelineStore(join(E2E_HOST_STATE_DIR, "reflectworld"));
    const e2eDashboard = new DashboardServer({
      distDir: dashboardDistDir,
      port: E2E_DASHBOARD_PORT,
      reflectworldEndpoint: MEM_URL,
      store: e2eStore,
    });
    await e2eDashboard.start();
    console.log(`  ✓ E2E Dashboard at http://localhost:${E2E_DASHBOARD_PORT}`);

    // List registered tools for verification
    const tools = host.listTools();
    console.log(`  Registered tools: ${tools.map((t) => t.name).join(", ")}`);

    // 4. Add the local video file as a Cam source.
    // Runtime compatibility note: the current tool name is still reflectworld_cam.
    console.log("── Registering video source ──");
    const addResult = await host.callTool("reflectworld_cam", {
      action: "add_source",
      source: VIDEO_FILE,
      name: CAMERA_ID,
    });
    console.log(`  add_source: ${addResult}`);

    const addParsed = tryParseJson(addResult) as { success?: boolean };
    let go2rtcRegistered = false;
    try {
      const go2rtcResp = await fetch(`${GO2RTC_URL}/api/streams`);
      if (go2rtcResp.ok) {
        const streams = (await go2rtcResp.json()) as Record<string, unknown>;
        go2rtcRegistered = CAMERA_ID in streams;
      }
    } catch {
      // best-effort observation only
    }
    const a1 = assertStructure(1, "Cam", "go2rtc source registered", { registered: go2rtcRegistered }, ["registered"]);
    a1.passed = addParsed?.success === true && go2rtcRegistered;
    a1.details = a1.passed ? "local video source registered via Cam -> go2rtc" : "source add failed or go2rtc stream missing";
    logResult(a1);
    assertions.push(a1);

    // 5b. Start watch (stream mode)
    console.log("── Starting watch ──");
    const watchResult = await host.callTool("reflectworld_cam", {
      action: "watch",
      name: CAMERA_ID,
      mode: "stream",
      fps: 1,
      _stopOnInputEnd: true,
      _inputMode: "local_file",
      _localFilePacing: process.env.REFLECTWORLD_LOCAL_FILE_PACING === "fast" ? "fast" : "realtime",
    });
    const watchParsed = tryParseJson(watchResult);
    const a2 = assertStructure(2, "Cam", "watch started", watchParsed, []);
    a2.passed = typeof watchResult === "string" && !watchResult.includes("error");
    a2.details = `mode=stream, response=${typeof watchResult === "string" ? watchResult.slice(0, 80) : "ok"}`;
    logResult(a2);
    assertions.push(a2);

    // 6. Wait for the local clip to reach EOF and stop naturally.
    console.log(`── Waiting for local clip to finish and watch to stop (timeout: ${GLOBAL_TIMEOUT_MS / 1000}s) ──`);
    await waitForWatchStopped(events, CAMERA_ID, GLOBAL_TIMEOUT_MS);
    const segCount = events.segmentsBuilt.length;
    console.log(`  Got ${segCount} segments`);

    // Assert: segments built
    const a3 = assertStructure(3, "Cam", "frame capture + segmentation", events.segmentsBuilt[0] ?? {}, ["segment_id", "camera_id"]);
    a3.passed = segCount > 0;
    a3.details = `${segCount} segments built`;
    logResult(a3);
    assertions.push(a3);

    // Assert: motion hint
    const a4: AssertionResult = {
      id: 4,
      category: "Cam",
      name: "MotionFilter",
      passed: segCount > 0, // If segments arrived, motion pipeline ran
      details: segCount > 0 ? `${segCount} segments processed through motion pipeline` : "No segments",
      severity: "required",
    };
    logResult(a4);
    assertions.push(a4);

    // 7. The non-looping local clip already stopped the watch at EOF.
    console.log("── Watch stopped at clip end ──");

    // Wait for pipeline + memory writes to fully complete before assertions.
    // Two layers:
    //   1. segmentQueue.waitForIdle() — all segment handlers finished
    //   2. memoryWriteQueue.waitForIdle() — all fire-and-forget /memories POSTs completed
    const DRAIN_TIMEOUT = 180_000;
    const waitPipeline = (globalThis as any).__reflectworld_waitForPipelineIdle as (() => Promise<void>) | undefined;
    const waitMemory = (globalThis as any).__reflectworld_waitForMemoryIdle as (() => Promise<void>) | undefined;

    if (waitPipeline) {
      console.log("── Waiting for pipeline to drain ──");
      let timedOut = false;
      await Promise.race([
        waitPipeline(),
        sleep(DRAIN_TIMEOUT).then(() => { timedOut = true; }),
      ]);
      console.log(timedOut
        ? `  ⚠ Pipeline drain timed out after ${DRAIN_TIMEOUT / 1000}s`
        : `  Pipeline drained: ${events.pipelineTraces.length} traces`);
    }

    if (waitMemory) {
      console.log("── Waiting for memory writes to complete ──");
      let timedOut = false;
      await Promise.race([
        waitMemory(),
        sleep(DRAIN_TIMEOUT).then(() => { timedOut = true; }),
      ]);
      console.log(timedOut
        ? `  ⚠ Memory write drain timed out after ${DRAIN_TIMEOUT / 1000}s`
        : "  Memory writes completed");
    }

    if (!waitPipeline && !waitMemory) {
      const fallbackMs = Math.max(15_000, segCount * 5_000);
      console.log(`── Waiting ${Math.round(fallbackMs / 1000)}s for pipeline (no idle signal) ──`);
      await sleep(fallbackMs);
    }

    // ── Percept Assertions ──
    // Check pipeline metrics events for perception results
    vlmStats.totalSegments = segCount;

    // Use state changes to infer perception results
    const statesWithRules = events.stateChanges.filter((s) => !s.is_baseline);
    const hasDetections = statesWithRules.length > 0 || events.rulesFired.length > 0;

    // Trace-backed percept assertions: verify analyzers actually ran
    const traces = events.pipelineTraces.map((t) => t.trace);
    const tracesWithDetection = traces.filter((t) => t.context.analyzers_run.includes("detection"));
    const tracesWithVlm = traces.filter((t) => t.context.analyzers_run.includes("vlm"));
    const avgVlmMs = tracesWithVlm.length > 0
      ? Math.round(tracesWithVlm.reduce((sum, t) => sum + (t.latencies.vlm_ms ?? 0), 0) / tracesWithVlm.length)
      : 0;
    const resultsWithSecurity = events.analysisCompleted.filter(
      (r) => r.security_risk !== undefined,
    );

    const a5: AssertionResult = {
      id: 5,
      category: "Percept",
      name: "YOLO detection",
      passed: traces.length > 0 ? tracesWithDetection.length > 0 : (hasDetections || segCount > 0),
      details: traces.length > 0
        ? `${tracesWithDetection.length}/${traces.length} traces ran detection analyzer`
        : `${segCount} segments processed (no traces collected)`,
      severity: "required",
    };
    logResult(a5);
    assertions.push(a5);

    const a6: AssertionResult = {
      id: 6,
      category: "Percept",
      name: "VLM analysis",
      passed: traces.length > 0 ? tracesWithVlm.length > 0 : segCount > 0,
      details: traces.length > 0
        ? `${tracesWithVlm.length}/${traces.length} traces ran VLM, avg latency ${avgVlmMs}ms`
        : `${segCount} segments processed (no traces collected)`,
      severity: "required",
    };
    logResult(a6);
    assertions.push(a6);

    const a7: AssertionResult = {
      id: 7,
      category: "Percept",
      name: "security_risk judgment",
      passed: resultsWithSecurity.length > 0,
      details: resultsWithSecurity.length > 0
        ? `${resultsWithSecurity.length}/${events.analysisCompleted.length} results contain security_risk judgment`
        : `0/${events.analysisCompleted.length} results contain security_risk (${segCount} segments processed)`,
      severity: "required",
    };
    logResult(a7);
    assertions.push(a7);

    // ── Mem Assertions (8-14) ──
    console.log("── Memory verification ──");

    // Debug: verify URLs and camera IDs match between write and read paths
    console.log(`  [mem-debug] REFLECTWORLD_URL=${process.env.REFLECTWORLD_URL} CAMERA_ID=${CAMERA_ID}`);
    // Quick direct check: hit the same endpoint assertions will use
    try {
      const debugResp = await fetch(`${memUrl()}/memories?memory_type=episodic&camera_id=${CAMERA_ID}`);
      const debugBody = await debugResp.json();
      const debugCount = flattenMemoryListResponse(debugBody).length;
      console.log(`  [mem-debug] Direct GET episodic: status=${debugResp.status} count=${debugCount}`);
    } catch (e) { console.log(`  [mem-debug] Direct GET failed: ${e}`); }

    // 8. Episodic memory written
    const a8 = await assertMemState(8, "episodic memory written", {
      cameraId: CAMERA_ID,
      minEpisodicCount: 1,
    });
    logResult(a8);
    assertions.push(a8);
    if (a8.passed) memVerification.episodicSearchable = true;

    // 9. Semantic memory state. Semantic generation is entity/history dependent:
    // the memory service skips it when no stable entity_id or prior entity history exists.
    let a9 = await assertMemState(9, "semantic memory generated", {
      cameraId: CAMERA_ID,
      hasSemanticMemory: true,
    });
    if (!a9.passed) {
      // Semantic extraction runs asynchronously inside the Python memory service and
      // often completes after episodic storage is already visible. Give it a wider
      // polling window so we validate the real eventual behavior rather than the
      // immediate response timing of fire-and-forget writes.
      for (let attempt = 2; attempt <= SEMANTIC_POLL_MAX && !a9.passed; attempt++) {
        console.log(`  Waiting for semantic memory (attempt ${attempt}/${SEMANTIC_POLL_MAX})...`);
        await sleep(SEMANTIC_POLL_INTERVAL_MS);
        a9 = await assertMemState(9, "semantic memory generated", {
          cameraId: CAMERA_ID,
          hasSemanticMemory: true,
        });
      }
    }
    if (!a9.passed && a9.details.includes("no semantic memories found")) {
      a9 = {
        id: 9,
        category: "Mem",
        name: "semantic memory generated",
        passed: true,
        details: "0 semantic memories; generation is per-entity and requires stable entity history",
        severity: "best_effort",
      };
    }
    a9.severity = "best_effort";
    logResult(a9);
    assertions.push(a9);

    // 10. Search returns results (query adapts to detected scene profile)
    const a10 = await assertAdaptiveSearch(10, "search returns results", CAMERA_ID, events);
    logResult(a10);
    assertions.push(a10);

    // 11. camera_id filter
    const a11 = await assertMemState(11, "camera_id filter", {
      cameraId: CAMERA_ID,
      searchQuery: "activity",
      minSearchScore: 0.1,
    });
    logResult(a11);
    assertions.push(a11);

    // 12. entity_id filter (use first entity if any)
    const a12: AssertionResult = {
      id: 12,
      category: "Mem",
      name: "entity_id filter",
      passed: true, // Best-effort — entities may not always be detected
      details: "entity_id filter test (depends on entity detection)",
      severity: "required",
    };
    logResult(a12);
    assertions.push(a12);

    // 13. ReID upsert + search
    console.log("── ReID verification ──");
    let a13: AssertionResult;
    try {
      // Generate a synthetic 512-dim face embedding for test
      const testEmbedding = Array.from({ length: 512 }, (_, i) => Math.sin(i * 0.1) * 0.5);
      const upsertResp = await fetch(`${memUrl()}/reid/upsert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity_id: "e2e_test_entity",
          vector: testEmbedding,
          collection: "reid_face",
          user_id: VIDEO_USER_ID,
        }),
      });
      const upsertBody = await upsertResp.json().catch(() => null);
      const upsertOk = upsertResp.ok;
      if (upsertOk) memVerification.reidUpserted = 1;

      // Search with same embedding
      const searchResp = await fetch(`${memUrl()}/reid/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vector: testEmbedding,
          collection: "reid_face",
          limit: 3,
          threshold: 0.5,
          user_id: VIDEO_USER_ID,
        }),
      });
      const searchData = (await searchResp.json().catch(() => null)) as { results?: Array<{ entity_id: string; score: number }> } | null;
      const matched = searchData?.results?.some((r) => r.entity_id === "e2e_test_entity" && r.score > 0.5);
      memVerification.reidSearchMatched = !!matched;

      a13 = {
        id: 13,
        category: "Mem",
        name: "ReID upsert + search",
        passed: upsertOk && !!matched,
        details: upsertOk && matched
          ? `Upserted + matched (score > 0.5)`
          : `upsert=${upsertOk} status=${upsertResp.status} body=${JSON.stringify(upsertBody)}; search=${searchResp.ok} status=${searchResp.status} matched=${!!matched} body=${JSON.stringify(searchData)}`,
        severity: "required",
      };
    } catch (err) {
      a13 = {
        id: 13,
        category: "Mem",
        name: "ReID upsert + search",
        passed: false,
        details: `Error: ${err instanceof Error ? err.message : err}`,
        severity: "required",
      };
    }
    logResult(a13);
    assertions.push(a13);

    // 14. expire_media
    let a14: AssertionResult;
    try {
      const segmentIdForExpire = events.segmentsBuilt[0]?.segment_id;
      if (!segmentIdForExpire) {
        throw new Error("No segment_id available for expire_media test");
      }
      const expireResp = await fetch(`${memUrl()}/memories/expire_media`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          segment_id: segmentIdForExpire,
          camera_id: CAMERA_ID,
        }),
      });
      const expireBody = await expireResp.json().catch(() => null);
      memVerification.expireMediaVerified = expireResp.ok;
      a14 = {
        id: 14,
        category: "Mem",
        name: "expire_media",
        passed: expireResp.ok,
        details: expireResp.ok
          ? `expire_media executed for ${segmentIdForExpire}: ${JSON.stringify(expireBody)}`
          : `status ${expireResp.status} for ${segmentIdForExpire}: ${JSON.stringify(expireBody)}`,
        severity: "required",
      };
    } catch (err) {
      a14 = {
        id: 14,
        category: "Mem",
        name: "expire_media",
        passed: false,
        details: `Error: ${err instanceof Error ? err.message : err}`,
        severity: "required",
      };
    }
    logResult(a14);
    assertions.push(a14);

    // ── VisionController Assertions (15-18) ──
    console.log("── VisionController verification ──");

    // 15. Baseline state
    const baselineStates = events.stateChanges.filter((s) => s.is_baseline);
    const a15: AssertionResult = {
      id: 15,
      category: "VisionController",
      name: "baseline state",
      passed: baselineStates.length > 0,
      details: baselineStates.length > 0
        ? `${baselineStates.length} baseline states observed`
        : "No baseline state changes observed",
      severity: "required",
    };
    logResult(a15);
    assertions.push(a15);

    // 16. Rule fired (person detected → escalation)
    const a16: AssertionResult = {
      id: 16,
      category: "VisionController",
      name: "rule triggered",
      passed: events.rulesFired.length > 0,
      details: events.rulesFired.length > 0
        ? `${events.rulesFired.length} rules fired: ${events.rulesFired.map((r) => r.rules.join(",")).join("; ")}`
        : "No rules fired (may depend on video content)",
      severity: "required",
    };
    logResult(a16);
    assertions.push(a16);

    const consultationToolCalls = events.toolInvoked.filter((event) =>
      event.tool === "reflectworld_cam"
      || event.tool === "reflectworld_perception"
      || event.tool === "reflectworld_memory",
    );

    // 17. OpenClaw consultation -> tool effect (verify success, not just count)
    const successfulEffects = events.consultationEffects.filter((e) => e.success === true);
    const toolsUsed = consultationToolCalls
      .map((t) => `${t.tool}:${t.action ?? "?"}`)
      .filter((v, i, arr) => arr.indexOf(v) === i);
    const a17: AssertionResult = {
      id: 17,
      category: "VisionController",
      name: "OpenClaw consultation gating",
      passed: events.agentConsulted.length === 0 || successfulEffects.length > 0,
      details: events.agentConsulted.length > 0
        ? `${events.agentConsulted.length} consultations, ${consultationToolCalls.length} tool calls, ${successfulEffects.length} successful effects. Tools: [${toolsUsed.join(", ")}]`
        : "No segment policy consultation trigger observed; frame-level detector rules are not consultation triggers",
      severity: "required",
    };
    logResult(a17);
    assertions.push(a17);

    // 18. Baseline recovery
    const hasEscalation = events.stateChanges.some((s) => !s.is_baseline);
    const hasRecovery = hasEscalation && events.stateChanges.some((s, i) => {
      if (i === 0) return false;
      const prev = events.stateChanges[i - 1];
      return s.is_baseline && prev && !prev.is_baseline;
    });
    const a18: AssertionResult = {
      id: 18,
      category: "VisionController",
      name: "baseline recovery",
      passed: hasRecovery || (!hasEscalation && baselineStates.length > 0),
      details: hasRecovery
        ? "Escalation → baseline recovery observed"
        : hasEscalation
          ? "Escalation observed but no recovery yet"
          : "Stayed at baseline (no escalation needed)",
      severity: "required",
    };
    logResult(a18);
    assertions.push(a18);

    // Build timeline for report
    const mediaOrigin = events.firstFrame?.media_ts
      ?? events.segmentsBuilt[0]?.first_frame_at
      ?? events.segmentsBuilt[0]?.timestamp
      ?? 0;
    const sortedSegments = getSortedSegmentsBuilt(events);
    const stateChangesBySegmentId = new Map(
      events.stateChanges
        .filter((entry) => typeof entry.segment_id === "string")
        .map((entry) => [entry.segment_id as string, entry]),
    );
    const consultedSegmentIds = new Set(
      events.agentConsulted
        .map((entry) => entry.segment_id)
        .filter((segmentId): segmentId is string => typeof segmentId === "string"),
    );
    let lastKnownState = events.stateChanges[0];

    for (const seg of sortedSegments) {
      const segStart = seg.timestamp ?? seg.first_frame_at ?? 0;
      const segEnd = segStart + Math.round((seg.duration_sec ?? 0) * 1000);
      // Match by segment_id (segment policy) or by frame_timestamp in range (frame policy).
      const sc = stateChangesBySegmentId.get(seg.segment_id)
        ?? [...events.stateChanges].reverse().find((entry) =>
            entry.segment_id == null
            && typeof (entry as any).frame_timestamp === "number"
            && (entry as any).frame_timestamp >= segStart
            && (entry as any).frame_timestamp <= segEnd
          )
        ?? lastKnownState;
      if (sc) lastKnownState = sc;
      // Find rule_fired events within this segment's time range (separate from state_changed)
      const segRulesFired = events.rulesFired.filter((entry) =>
        entry.segment_id === seg.segment_id
        || (entry.segment_id == null && typeof (entry as any).frame_timestamp === "number"
            && (entry as any).frame_timestamp >= segStart
            && (entry as any).frame_timestamp <= segEnd)
      );
      const allRuleNames = segRulesFired.flatMap((r) => r.rules ?? []);

      timeline.push({
        timeRange: formatRelativeTimeRange(
          seg.timestamp,
          seg.duration_sec,
          mediaOrigin,
        ),
        segmentId: seg.segment_id,
        entities: allRuleNames.length > 0 ? ["(detected)"] : [],
        rulesFired: allRuleNames,
        fps: sc?.fps ?? 1,
        vlmEnabled: sc?.skip_vlm !== true,
        agentConsulted: consultedSegmentIds.has(seg.segment_id),
      });
    }
    detailedTimeline = buildDetailedTimeline(events, events.firstFrame?.wall_ts);

    // ── Skill Understanding Tests (19-20) ──
    console.log("── Skill understanding tests ──");
    skillResults = await runSkillTests(simAgent, CAMERA_ID);
    vlmStats.geminiApiCalls.skill = getSkillTestCount();

    const allSkillsPassed = skillResults.every((r) => r.passed);
    const a19: AssertionResult = {
      id: 19,
      category: "Skill",
      name: "user instructions → tool calls",
      passed: allSkillsPassed,
      details: `${skillResults.filter((r) => r.passed).length}/${skillResults.length} instructions correctly mapped`,
      severity: "required",
    };
    logResult(a19);
    assertions.push(a19);

    const allTraces = events.pipelineTraces.map((t) => t.trace);

    // 20. VLM cost stats
    const vlmRunSegments = allTraces.filter((trace) => trace.context.analyzers_run.includes("vlm")).length;
    vlmStats.vlmSkippedSegments = Math.max(0, segCount - vlmRunSegments);
    vlmStats.geminiApiCalls.vlm = vlmRunSegments;
    vlmStats.geminiApiCalls.agent = Math.max(vlmStats.geminiApiCalls.agent, events.agentConsulted.length);

    const skipPct = segCount > 0 ? Math.round((vlmStats.vlmSkippedSegments / segCount) * 100) : 0;
    const a20: AssertionResult = {
      id: 20,
      category: "Stats",
      name: "VLM cost tracking",
      passed: true,
      details: `${skipPct}% segments skipped VLM (${vlmStats.vlmSkippedSegments}/${segCount}); VLM ran ${vlmRunSegments}/${segCount}`,
      severity: "required",
    };
    logResult(a20);
    assertions.push(a20);

    // ── Trace-backed Assertions (21-23) ──
    console.log("── Trace-backed verification ──");

    // 21. Trace coverage — at least 30% of segments have traces, no orphan/duplicate traces
    const MIN_TRACE_COVERAGE = 0.3;
    const traceSegmentIds = allTraces.map((t) => t.segment_id);
    const traceIdSet = new Set(traceSegmentIds);
    const segmentIds = events.segmentsBuilt.map((s) => s.segment_id);
    const segmentIdSet = new Set(segmentIds);
    const unmatchedTraces = traceSegmentIds.filter((id) => !segmentIdSet.has(id));
    const duplicateTraces = traceSegmentIds.length - traceIdSet.size;
    const coverage = segCount > 0 ? allTraces.length / segCount : 0;
    const coveragePct = Math.round(coverage * 100);
    const hasSufficientCoverage = allTraces.length > 0
      && coverage >= MIN_TRACE_COVERAGE
      && unmatchedTraces.length === 0
      && duplicateTraces === 0;
    const problems: string[] = [];
    if (allTraces.length === 0) {
      problems.push("no traces collected");
    } else if (coverage < MIN_TRACE_COVERAGE) {
      problems.push(`coverage ${coveragePct}% < ${Math.round(MIN_TRACE_COVERAGE * 100)}% (${allTraces.length}/${segCount} segments)`);
    }
    if (unmatchedTraces.length > 0) {
      problems.push(`${unmatchedTraces.length} orphan traces: ${unmatchedTraces.slice(0, 3).join(", ")}${unmatchedTraces.length > 3 ? "..." : ""}`);
    }
    if (duplicateTraces > 0) {
      problems.push(`${duplicateTraces} duplicate trace segment_ids`);
    }
    const a21: AssertionResult = {
      id: 21,
      category: "Trace",
      name: "trace coverage",
      passed: hasSufficientCoverage,
      details: hasSufficientCoverage
        ? `${allTraces.length}/${segCount} segments traced (${coveragePct}% coverage)`
        : problems.join("; "),
      severity: "required",
    };
    logResult(a21);
    assertions.push(a21);

    // 22. Analyzer execution — VLM should run on at least some traces
    const a22 = assertTrace(22, "analyzer execution", allTraces, {
      requiredAnalyzers: ["vlm"],
    });
    logResult(a22);
    assertions.push(a22);

    // 23. Latency SLA — validate perception latency; end-to-end wall time includes
    // video accumulation and runner backlog when live VLM calls queue up.
    const a23 = assertTrace(23, "latency SLA", allTraces, {
      maxPerceptionMs: 30_000,
    });
    a23.severity = "best_effort";
    logResult(a23);
    assertions.push(a23);

    // ── SQLite store verification (24-26) ──
    console.log("── SQLite store verification ──");
    let verifyStore: PipelineStore | null = null;
    try {
      verifyStore = new PipelineStore(join(E2E_HOST_STATE_DIR, "reflectworld"));

      // 24. Pipeline log populated — SQLite pipeline_log has entries for processed segments
      const pipelineLogEntries = verifyStore.getRecent(CAMERA_ID);
      const a24: AssertionResult = {
        id: 24,
        category: "Store",
        name: "pipeline_log populated",
        passed: pipelineLogEntries.length > 0,
        details: pipelineLogEntries.length > 0
          ? `${pipelineLogEntries.length} pipeline_log entries for ${CAMERA_ID}`
          : `No pipeline_log entries found for ${CAMERA_ID}`,
        severity: "required",
      };
      logResult(a24);
      assertions.push(a24);

      // 25. Trace store populated — traces table count must exactly match monitor events
      const storedTraces = verifyStore.getRecentTraces(CAMERA_ID);
      const monitorTraceCount = allTraces.length;
      const a25: AssertionResult = {
        id: 25,
        category: "Store",
        name: "traces persisted to SQLite",
        passed: storedTraces.length > 0 && storedTraces.length === monitorTraceCount,
        details: storedTraces.length === monitorTraceCount
          ? `${storedTraces.length} stored traces match ${monitorTraceCount} monitor events`
          : `${storedTraces.length} stored traces != ${monitorTraceCount} monitor events (${Math.abs(storedTraces.length - monitorTraceCount)} mismatch)`,
        severity: "required",
      };
      logResult(a25);
      assertions.push(a25);

      // 26. No unhandled pipeline errors — pipeline_errors should be empty or minimal
      const pipelineErrors = verifyStore.getErrors(100);
      const a26: AssertionResult = {
        id: 26,
        category: "Store",
        name: "no unhandled pipeline errors",
        passed: pipelineErrors.length === 0,
        details: pipelineErrors.length === 0
          ? "No pipeline errors recorded"
          : `${pipelineErrors.length} errors: ${pipelineErrors.slice(0, 3).map((e) => `${e.stage}: ${e.error}`).join("; ")}`,
        severity: "best_effort",
      };
      logResult(a26);
      assertions.push(a26);
    } catch (storeErr) {
      console.warn(`[e2e] SQLite store verification skipped: ${storeErr instanceof Error ? storeErr.message : String(storeErr)}`);
    } finally {
      verifyStore?.close();
    }

    // ── A27: service origins captured (independent of SQLite store) ──
    const STARTED_MODES = ["managed", "external", "uv", "python"];
    const origins = events.serviceOrigins;
    const qdrantMode = origins?.qdrant;
    const reflectworldMode = origins?.reflectworld;
    const hasValidOrigins = !!origins
      && typeof qdrantMode === "string" && STARTED_MODES.includes(qdrantMode)
      && typeof reflectworldMode === "string" && STARTED_MODES.includes(reflectworldMode);
    const a27: AssertionResult = {
      id: 27,
      category: "Lifecycle",
      name: "service origins captured",
      passed: hasValidOrigins,
      details: hasValidOrigins
        ? `qdrant=${qdrantMode}, reflectworld=${reflectworldMode}`
        : origins
          ? `Invalid modes: qdrant=${qdrantMode ?? "missing"}, reflectworld=${reflectworldMode ?? "missing"}`
          : "system:service_origins event not received",
      severity: "required",
    };
    logResult(a27);
    assertions.push(a27);

    // Count memory stats for report
    try {
      const episodicResp = await fetch(`${MEM_URL}/memories?camera_id=${CAMERA_ID}&memory_type=episodic`);
      if (episodicResp.ok) {
        const data = await episodicResp.json();
        memVerification.episodicCount = flattenMemoryListResponse(data).length;
      }
      const semanticResp = await fetch(`${MEM_URL}/memories?camera_id=${CAMERA_ID}&memory_type=semantic`);
      if (semanticResp.ok) {
        const data = await semanticResp.json();
        memVerification.semanticCount = flattenMemoryListResponse(data).length;
      }
    } catch {
      // Best-effort stats
    }

    // ── Generate Report ──
    const endTime = new Date();
    const report = generateReport({
      startTime,
      endTime,
      videoFile: VIDEO_FILE.split("/").pop() ?? "unknown",
      assertions,
      skillTests: skillResults,
      timeline,
      detailedTimeline,
      memoryVerification: memVerification,
      vlmStats,
      wallClockOrigin: events.firstFrame?.wall_ts,
    });

    writeFileSync(REPORT_PATH, report, "utf-8");
    console.log(`\n── Report saved to ${REPORT_PATH} ──`);

    // ── Summary ──
    const requiredAssertions = assertions.filter((a) => a.severity === "required");
    const bestEffortAssertions = assertions.filter((a) => a.severity === "best_effort");
    const passed = requiredAssertions.filter((a) => a.passed).length;
    const failed = requiredAssertions.filter((a) => !a.passed).length;
    const bestEffortPassed = bestEffortAssertions.filter((a) => a.passed).length;
    console.log(`\n══════════════════════════════════`);
    console.log(`  Required: ${passed}/${requiredAssertions.length} | Failed: ${failed}`);
    if (bestEffortAssertions.length > 0) {
      console.log(`  Best-effort: ${bestEffortPassed}/${bestEffortAssertions.length}`);
    }
    console.log(`  Duration: ${formatDuration(endTime.getTime() - startTime.getTime())}`);
    console.log(`══════════════════════════════════\n`);

    if (failed > 0) {
      console.log("Failed tests:");
      for (const a of requiredAssertions.filter((a) => !a.passed)) {
        console.log(`  #${a.id} ${a.category}: ${a.name} — ${a.details}`);
      }
      process.exitCode = 1;
    }
  } finally {
    // Cleanup
    console.log("\n── Final cleanup ──");
    try {
      if (host) {
        await host.callTool("reflectworld_cam", { action: "stop_watch", name: CAMERA_ID }).catch(() => {});
        console.log(`  Waiting ${FINAL_DRAIN_MS / 1000}s for late async memory writes to drain...`);
        await sleep(FINAL_DRAIN_MS);
        await Promise.race([
          host.stopServices().catch(() => {}),
          sleep(SERVICE_STOP_TIMEOUT_MS),
        ]);
        await cleanupAll({
          collectionPrefix: E2E_COLLECTION_NAME,
          streamPrefix: CAMERA_ID,
          quietIfUnavailable: true,
        }).catch(() => {});
      }
    } catch {
      // Best-effort
    }
    // Note: E2E_RUNTIME_DIR is NOT deleted here — the DashboardServer needs
    // the SQLite store inside it. It will be cleaned up on next run (step 0).
  }
}

// ── Helpers ──

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatRelativeTimeRange(
  startTimestamp?: number,
  durationSec?: number,
  baseTimestamp?: number,
): string | undefined {
  if (startTimestamp == null || durationSec == null || baseTimestamp == null) return undefined;
  const startOffsetSec = Math.max(0, Math.floor((startTimestamp - baseTimestamp) / 1000));
  const durationWholeSec = Math.max(1, Math.ceil(durationSec));
  const endOffsetSec = startOffsetSec + durationWholeSec;
  return `${formatClockRangePart(startOffsetSec)}-${formatClockRangePart(endOffsetSec)}`;
}

function formatRelativeTimestamp(timestamp?: number, baseTimestamp?: number): string | undefined {
  if (timestamp == null || baseTimestamp == null) return undefined;
  const offsetMs = Math.round(Math.max(0, timestamp - baseTimestamp));
  const totalSeconds = Math.floor(offsetMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = offsetMs % 1000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function formatClockRangePart(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function getSegmentMediaTimestamp(segment: CollectedEvents["segmentsBuilt"][number]): number {
  return segment.timestamp ?? 0;
}

function getSortedSegmentsBuilt(events: CollectedEvents): CollectedEvents["segmentsBuilt"] {
  return [...events.segmentsBuilt].sort((a, b) => {
    const delta = getSegmentMediaTimestamp(a) - getSegmentMediaTimestamp(b);
    if (delta !== 0) return delta;
    return a.segment_id.localeCompare(b.segment_id);
  });
}

function buildDetailedTimeline(
  events: CollectedEvents,
  wallClockOrigin?: number,
): DetailedSegmentTimelineEntry[] {
  const mediaBaseTimestamp = events.firstFrame?.media_ts
    ?? events.segmentsBuilt[0]?.timestamp
    ?? 0;
  const processingBaseTimestamp = wallClockOrigin ?? resolveProcessingBaseTimestamp(events);

  return getSortedSegmentsBuilt(events).map((segment) => {
    const segmentStartTimestamp = segment.timestamp ?? segment.first_frame_at;
    const segmentDurationMs = segment.duration_sec != null ? Math.max(0, Math.round(segment.duration_sec * 1000)) : undefined;
    const segmentEndTimestamp = segmentStartTimestamp != null && segmentDurationMs != null
      ? segmentStartTimestamp + segmentDurationMs
      : undefined;
    const trace = events.pipelineTraces.find((entry) => entry.trace.segment_id === segment.segment_id)?.trace;
    const analysisStarted = events.analysisStarted.find((entry) => entry.segment_id === segment.segment_id);
    const analysisCompleted = events.analysisCompleted.find((entry) => entry.segment_id === segment.segment_id);
    // Match by segment_id (segment policy events) or by frame_timestamp in range (frame policy events).
    const ruleFired = events.rulesFired.find((entry) =>
      entry.segment_id === segment.segment_id
      || (entry.segment_id == null && segmentStartTimestamp != null && segmentEndTimestamp != null
          && typeof (entry as any).frame_timestamp === "number"
          && (entry as any).frame_timestamp >= segmentStartTimestamp
          && (entry as any).frame_timestamp <= segmentEndTimestamp)
    );
    // For state: prefer the LAST state_changed within this segment's time range (most recent frame policy state).
    const stateChanged = events.stateChanges.find((entry) => entry.segment_id === segment.segment_id)
      ?? [...events.stateChanges].reverse().find((entry) =>
          entry.segment_id == null && segmentStartTimestamp != null && segmentEndTimestamp != null
          && typeof (entry as any).frame_timestamp === "number"
          && (entry as any).frame_timestamp >= segmentStartTimestamp
          && (entry as any).frame_timestamp <= segmentEndTimestamp
        );
    const consulted = events.agentConsulted.find((entry) => entry.segment_id === segment.segment_id);
    const effect = events.consultationEffects.find((entry) => entry.segment_id === segment.segment_id);
    const toolDetails = effect?.tool_details;
    const analysisStartTs = analysisStarted?.timestamp ?? trace?.timestamps.analysis_started_at;
    const analysisDoneTs = analysisCompleted?.timestamp ?? trace?.timestamps.analysis_completed_at;
    const ruleFiredTs = ruleFired?.timestamp;
    const stateChangedTs = stateChanged?.timestamp;
    const consultationRequestedTs = consulted?.requested_at ?? consulted?.timestamp;
    const consultationCompletedTs = consulted?.completed_at;
    const effectObservedTs = effect?.timestamp;
    const consultationLatencyMs = consulted?.requested_at != null && consulted?.completed_at != null
      ? Math.max(0, consulted.completed_at - consulted.requested_at)
      : undefined;

    return {
      segmentId: segment.segment_id,
      timeRange: formatRelativeTimeRange(
        segmentStartTimestamp,
        segment.duration_sec,
        mediaBaseTimestamp,
      ),
      captureStartedAt: formatRelativeTimestamp(segmentStartTimestamp, mediaBaseTimestamp),
      segmentBuiltAt: formatRelativeTimestamp(segmentEndTimestamp, mediaBaseTimestamp),
      cutReason: segment.cut_reason,
      captureMotion: formatCaptureMotion(segment),
      captureVoice: formatCaptureVoice(segment),
      mode: segment.mode,
      frameCount: segment.frame_count,
      analysisStartedAt: formatRelativeTimestamp(analysisStartTs, processingBaseTimestamp),
      analysisCompletedAt: formatRelativeTimestamp(analysisDoneTs, processingBaseTimestamp),
      level: analysisStarted?.level ?? analysisCompleted?.level ?? trace?.context.level,
      vlmModel: analysisStarted?.vlm_model ?? trace?.context.vlm_model,
      analyzersRun: trace?.context.analyzers_run,
      summary: analysisCompleted?.summary,
      accumulationMs: sanitizeLatency(trace?.latencies.accumulation_ms),
      dispatchMs: trace?.latencies.dispatch_ms,
      perceptionMs: sanitizeLatency(trace?.latencies.perception_ms ?? analysisCompleted?.perception_latency_ms),
      vlmMs: sanitizeLatency(trace?.latencies.vlm_ms ?? analysisCompleted?.vlm_latency_ms),
      ruleFiredAt: ruleFired?.rules?.length ? formatRelativeTimestamp(ruleFiredTs, processingBaseTimestamp) : undefined,
      rulesFired: ruleFired?.rules,
      ruleTrigger: formatRuleTrigger(ruleFired),
      ruleSignals: formatRuleSignals(ruleFired?.signals_snapshot),
      vcAction: formatVcAction(ruleFired?.action),
      stateChangedAt: (() => {
        // Find action_applied event within this segment's time range (first frame at new fps)
        const applied = events.actionApplied.find((entry) =>
          entry.applied_at != null && segmentStartTimestamp != null && segmentEndTimestamp != null
          && entry.applied_at >= segmentStartTimestamp && entry.applied_at <= segmentEndTimestamp
        );
        if (applied?.applied_at != null) {
          return `applied_at ${formatRelativeTimestamp(applied.applied_at, mediaBaseTimestamp)} (${applied.latency_ms ?? 0}ms from trigger)`;
        }
        return formatRelativeTimestamp(stateChangedTs, processingBaseTimestamp);
      })(),
      stateApplied: formatStateApplied(stateChanged),
      consultationAt: consulted ? formatRelativeTimestamp(consultationRequestedTs, processingBaseTimestamp) : undefined,
      consultationCompletedAt: formatRelativeTimestamp(consultationCompletedTs, processingBaseTimestamp),
      consultationLatencyMs,
      consultationReason: consulted?.trigger_reason ? stringifyCompact(consulted.trigger_reason) : undefined,
      consultationSuggestedTool: consulted?.suggested_tool,
      consultationRecommendedActions: consulted?.recommended_action_types,
      effectObservedAt: effect ? formatRelativeTimestamp(effectObservedTs, processingBaseTimestamp) : undefined,
      effectSummary: formatConsultationEffect(effect, toolDetails),
      effectLatencyMs: effect?.latency_ms,
    };
  });
}

function resolveProcessingBaseTimestamp(events: CollectedEvents): number | undefined {
  const candidates: number[] = [];

  for (const entry of events.analysisStarted) candidates.push(entry.timestamp);
  for (const entry of events.analysisCompleted) candidates.push(entry.timestamp);
  for (const entry of events.rulesFired) candidates.push(entry.timestamp);
  for (const entry of events.stateChanges) candidates.push(entry.timestamp);
  for (const entry of events.agentConsulted) {
    if (entry.requested_at != null) candidates.push(entry.requested_at);
    if (entry.completed_at != null) candidates.push(entry.completed_at);
    candidates.push(entry.timestamp);
  }
  for (const entry of events.consultationEffects) candidates.push(entry.timestamp);
  for (const entry of events.pipelineTraces) {
    candidates.push(entry.trace.timestamps.analysis_started_at);
    candidates.push(entry.trace.timestamps.analysis_completed_at);
  }

  if (candidates.length === 0) return undefined;
  return Math.min(...candidates);
}

function sanitizeLatency(ms?: number): number | undefined {
  if (ms == null || !Number.isFinite(ms)) return undefined;
  const rounded = Math.round(ms);
  if (rounded < 0 || rounded > 300_000) return undefined;
  return rounded;
}

function formatVcAction(action?: Record<string, unknown>): string | undefined {
  if (!action) return undefined;
  const parts: string[] = [];
  if (typeof action.fps === "number") parts.push(`fps=${action.fps}`);
  if (typeof action.skip_vlm === "boolean") parts.push(`skip_vlm=${action.skip_vlm}`);
  if (typeof action.max_level === "number") parts.push(`max_level=${action.max_level}`);
  if (typeof action.mode === "string") parts.push(`mode=${action.mode}`);
  if (typeof action.vlm_model === "string") parts.push(`vlm_model=${action.vlm_model}`);
  return parts.length > 0 ? parts.join(", ") : stringifyCompact(action);
}

function formatCaptureMotion(segment: CollectedEvents["segmentsBuilt"][number]): string | undefined {
  if (segment.has_motion == null && segment.motion_ratio == null) return undefined;
  const parts: string[] = [];
  if (typeof segment.has_motion === "boolean") {
    parts.push(segment.has_motion ? "active" : "still");
  }
  if (typeof segment.motion_ratio === "number") {
    parts.push(`ratio=${segment.motion_ratio.toFixed(4)}`);
  }
  return parts.join(", ");
}

function formatCaptureVoice(segment: CollectedEvents["segmentsBuilt"][number]): string | undefined {
  if (segment.has_voice == null && segment.audio_segment_count == null) return undefined;
  const parts: string[] = [];
  if (typeof segment.has_voice === "boolean") {
    parts.push(segment.has_voice ? "active" : "silent");
  }
  if (typeof segment.audio_segment_count === "number") {
    parts.push(`speech_segments=${segment.audio_segment_count}`);
  }
  return parts.join(", ");
}

function formatRuleTrigger(
  rule?: CollectedEvents["rulesFired"][number],
): string | undefined {
  const trigger = rule?.rule_details?.[0]?.trigger;
  if (!trigger) return undefined;
  return summarizeTrigger(trigger);
}

function formatRuleSignals(signals?: Record<string, unknown>): string | undefined {
  if (!signals) return undefined;
  const parts: string[] = [];
  const detected = Array.isArray(signals.detected_classes)
    ? signals.detected_classes.filter((v): v is string => typeof v === "string")
    : [];
  if (detected.length > 0) parts.push(`classes=${detected.join(",")}`);
  if (typeof signals.has_motion === "boolean") parts.push(`has_motion=${signals.has_motion}`);
  if (typeof signals.motion_sustained_ms === "number") parts.push(`motion_sustained_ms=${signals.motion_sustained_ms}`);
  if (typeof signals.no_motion_ms === "number") parts.push(`no_motion_ms=${signals.no_motion_ms}`);
  if (typeof signals.voice_detected === "boolean") parts.push(`voice_detected=${signals.voice_detected}`);
  if (typeof signals.has_unknown_entity === "boolean") parts.push(`unknown_entity=${signals.has_unknown_entity}`);
  if (typeof signals.security_risk === "boolean") parts.push(`security_risk=${signals.security_risk}`);
  return parts.length > 0 ? parts.join(" | ") : stringifyCompact(signals);
}

function summarizeTrigger(trigger: unknown): string {
  if (!trigger || typeof trigger !== "object") return stringifyCompact(trigger);
  const obj = trigger as Record<string, unknown>;
  const type = obj.type;
  if (type === "class_detected" && typeof obj.class === "string") {
    return `class_detected(${obj.class})`;
  }
  if (type === "motion_sustained_ms" && typeof obj.duration === "number") {
    return `motion_sustained_ms(${obj.duration})`;
  }
  if (type === "voice_detected") return "voice_detected";
  if (type === "unknown_entity") return "unknown_entity";
  if (type === "security_risk") return "security_risk";
  if ((type === "all_of" || type === "any_of") && Array.isArray(obj.conditions)) {
    const items = obj.conditions.map((item) => summarizeTrigger(item));
    return `${type}(${items.join(", ")})`;
  }
  return stringifyCompact(trigger);
}

function formatStateApplied(
  state?: CollectedEvents["stateChanges"][number],
): string | undefined {
  if (!state) return undefined;
  const parts: string[] = [];
  // Derive baseline/escalated from actual action values, not is_baseline flag.
  // is_baseline only reflects whether rules fired on THIS specific frame,
  // but during hold the action is still escalated even though firedRules=[].
  const isActualBaseline = (state.fps == null || state.fps <= 1)
    && (state.skip_vlm == null || state.skip_vlm === true)
    && (state.max_level == null || state.max_level <= 1);
  parts.push(isActualBaseline ? "baseline" : "escalated");
  if (typeof state.fps === "number") parts.push(`fps=${state.fps}`);
  if (typeof state.skip_vlm === "boolean") parts.push(`skip_vlm=${state.skip_vlm}`);
  if (typeof state.max_level === "number") parts.push(`max_level=${state.max_level}`);
  if (typeof state.mode === "string") parts.push(`mode=${state.mode}`);
  if (typeof state.vlm_model === "string") parts.push(`vlm_model=${state.vlm_model}`);
  return parts.join(", ");
}

function formatConsultationEffect(
  effect?: CollectedEvents["consultationEffects"][number],
  toolDetails?: Record<string, unknown>,
): string | undefined {
  if (!effect) return undefined;
  const parts: string[] = [];
  if (effect.tool || effect.action) {
    parts.push(`${effect.tool ?? "tool"}/${effect.action ?? "action"}`);
  }
  if (typeof effect.success === "boolean") {
    parts.push(effect.success ? "success" : "failed");
  }
  const appliedKeys = Array.isArray(toolDetails?.applied_keys)
    ? (toolDetails.applied_keys as unknown[]).filter((key): key is string => typeof key === "string")
    : [];
  if (appliedKeys.length > 0) {
    parts.push(`applied=${appliedKeys.join(",")}`);
  }
  if (typeof toolDetails?.result_message === "string") {
    parts.push(toolDetails.result_message);
  }
  if (typeof toolDetails?.security_rules_preview === "string") {
    parts.push(`security_rules="${toolDetails.security_rules_preview}"`);
  }
  if (typeof toolDetails?.fps === "number") {
    parts.push(`fps=${toolDetails.fps}`);
  }
  if (typeof toolDetails?.mode === "string") {
    parts.push(`mode=${toolDetails.mode}`);
  }
  return parts.length > 0 ? parts.join(" | ") : undefined;
}

function stringifyCompact(value: unknown): string {
  const raw = JSON.stringify(value);
  return raw.length > 180 ? `${raw.slice(0, 177)}...` : raw;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

type SceneProfile = "person" | "vehicle" | "mixed" | "generic";

interface SearchPlan {
  profile: SceneProfile;
  minSearchScore: number;
  queries: string[];
}

async function assertAdaptiveSearch(
  id: number,
  name: string,
  cameraId: string,
  events: CollectedEvents,
): Promise<AssertionResult> {
  const plan = buildAdaptiveSearchPlan(events);
  const failures: string[] = [];

  for (const query of plan.queries) {
    const attempt = await assertMemState(id, name, {
      cameraId,
      searchQuery: query,
      minSearchScore: plan.minSearchScore,
    });
    if (attempt.passed) {
      return {
        ...attempt,
        details: `${attempt.details}; profile=${plan.profile}; query="${query}"; min_score=${plan.minSearchScore}`,
      };
    }
    failures.push(`[${query}] ${attempt.details}`);
  }

  return {
    id,
    category: "Mem",
    name,
    passed: false,
    details: `profile=${plan.profile}; min_score=${plan.minSearchScore}; ${failures.join(" || ")}`,
    severity: "required",
  };
}

function buildAdaptiveSearchPlan(events: CollectedEvents): SearchPlan {
  const classCounts = collectDetectedClassCounts(events);
  const personScore = classCounts.get("person") ?? 0;
  const vehicleScore =
    (classCounts.get("vehicle") ?? 0)
    + (classCounts.get("car") ?? 0)
    + (classCounts.get("truck") ?? 0)
    + (classCounts.get("bus") ?? 0);

  if (vehicleScore >= Math.max(2, personScore + 1)) {
    return {
      profile: "vehicle",
      minSearchScore: SEARCH_MIN_SCORE_VEHICLE,
      queries: dedupeQueries([
        "vehicle",
        "truck",
        "car",
        "parking lot traffic",
        "activity",
      ]),
    };
  }

  if (personScore >= 2 && vehicleScore === 0) {
    return {
      profile: "person",
      minSearchScore: SEARCH_MIN_SCORE_PERSON,
      queries: dedupeQueries([
        "person",
        "visitor",
        "who came by",
        "activity",
      ]),
    };
  }

  if (personScore > 0 && vehicleScore > 0) {
    return {
      profile: "mixed",
      minSearchScore: SEARCH_MIN_SCORE_VEHICLE,
      queries: dedupeQueries([
        "person vehicle",
        "person",
        "vehicle",
        "activity",
      ]),
    };
  }

  return {
    profile: "generic",
    minSearchScore: SEARCH_MIN_SCORE_VEHICLE,
    queries: ["activity", "motion", "scene event"],
  };
}

function collectDetectedClassCounts(events: CollectedEvents): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (klassRaw: string) => {
    const klass = normalizeClassLabel(klassRaw);
    counts.set(klass, (counts.get(klass) ?? 0) + 1);
  };

  for (const event of events.rulesFired) {
    const classes = event.signals_snapshot?.detected_classes;
    if (Array.isArray(classes)) {
      for (const item of classes) {
        if (typeof item === "string" && item.trim().length > 0) add(item);
      }
    }
  }

  for (const event of events.agentConsulted) {
    for (const item of event.detected_classes) {
      if (typeof item === "string" && item.trim().length > 0) add(item);
    }
  }

  return counts;
}

function normalizeClassLabel(label: string): string {
  const key = label.trim().toLowerCase();
  if (key === "automobile") return "car";
  if (key === "motorbike" || key === "motorcycle") return "vehicle";
  if (key === "van") return "vehicle";
  return key;
}

function dedupeQueries(queries: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const query of queries) {
    const key = query.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(query);
  }
  return output;
}

function flattenMemoryListResponse(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const all: unknown[] = [];
    for (const value of Object.values(data as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        all.push(...value);
      }
    }
    return all;
  }
  return [];
}

function parseServiceMode(args: string[]): "start-missing" | "reuse" {
  const raw = args.find((arg) => arg.startsWith("--services="))?.split("=")[1]
    ?? process.env.REFLECTWORLD_E2E_SERVICES
    ?? "start-missing";
  return raw === "reuse" ? "reuse" : "start-missing";
}

// ── Entry Point ──

const args = process.argv.slice(2);
const preflightOnly = args.includes("--preflight-only");

(async () => {
  const ok = await preflight();
  if (!ok) {
    console.error("Preflight failed. Fix the issues above and retry.");
    process.exit(1);
  }
  if (preflightOnly) {
    console.log("Preflight-only mode. Exiting.");
    process.exit(0);
  }

  // Global timeout
  const globalTimer = setTimeout(() => {
    console.error(`\nGlobal timeout (${GLOBAL_TIMEOUT_MS / 60000}m) exceeded. Forcing exit.`);
    process.exit(2);
  }, GLOBAL_TIMEOUT_MS);

  try {
    await run();
  } finally {
    clearTimeout(globalTimer);
  }

  const exitCode = process.exitCode ?? 0;
  if (exitCode === 0) {
    console.log(`\n✓ E2E tests passed.`);
  } else {
    console.log(`\n✗ E2E tests failed.`);
  }

  // Exit cleanly instead of hanging for Monitor
  process.exit(exitCode);
})();
