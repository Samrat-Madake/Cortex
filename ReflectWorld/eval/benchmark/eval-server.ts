// eval/benchmark/eval-server.ts
// HTTP evaluation service for lmms-eval integration.
// Wraps ReflectWorld pipeline as a single /evaluate endpoint.

import dotenv from "dotenv";
import { resolve, dirname, join, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, existsSync, readdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
const __root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
dotenv.config({ path: resolve(__root, ".env") });

import { monitorBus, resolveReflectWorldHome, resolveReflectWorldStateDir } from "@reflectworld/shared";
import { createPipelineDeps, NarrativeMemory, resolvePerceptionConfig, VlmAnalyzer } from "@reflectworld/percept";
import { OnnxInferenceEngine } from "../../packages/percept/src/models/onnx-engine.js";
import { ReflectWorldClient } from "@reflectworld/mem";
import { PipelineStore } from "../../packages/reflectworld/src/store.js";
import { QdrantService } from "../../packages/reflectworld/src/services/qdrant-service.js";
import { ReflectWorldService } from "../../packages/reflectworld/src/services/reflectworld-service.js";
import { runSessionPipeline, type SessionPipelineClip } from "./pipeline/session-pipeline.js";
import type { VideoPipelineCheckpoint } from "./pipeline/video-pipeline.js";
import { runAgentQA } from "./pipeline/agent-qa.js";
import { extractMcqPrediction, extractOptionLetter } from "./pipeline/eval-answer-extract.js";
import { countEpisodicMemories, countSemanticMemories, dumpMemories } from "./pipeline/memory-dump.js";
import { rehydrateMemoriesFromDump } from "./pipeline/memory-rehydrate.js";
import { qaArtifactDirForCheckpoint, qaRunDirForVideo } from "./pipeline/qa-artifact-path.js";
import { summarizeQaTraceDiagnostics } from "./pipeline/qa-trace-diagnostics.js";
import { wireBenchmarkReidMemory } from "./pipeline/pipeline-memory.js";
import { recordBenchmarkSemanticContextObservation, wireBenchmarkSemanticContext } from "./pipeline/semantic-context.js";
import { buildVisionControllerConsultationPrompt, parseVisionControllerConsultationResponse } from "./pipeline/consultation.js";
import type { AgentQATrace, BenchmarkQuestion, QAResult } from "./pipeline/types.js";
import { createBenchmarkVisionControllerConfig } from "../../packages/reflectworld/src/vision-controller/default-config.js";
import { SingleFileFrameSource, SessionFrameSource } from "./pipeline/video-frame-source.js";

// ── CLI args ──
const args = process.argv.slice(2);
function getArg(name: string, defaultVal?: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return defaultVal;
}

const port = parseInt(getArg("port", "8300")!, 10);
const fps = parseInt(getArg("fps", "1")!, 10);
const framesPerSegment = parseInt(getArg("frames-per-segment", "15")!, 10);
const maxDurationSecRaw = getArg("max-duration-sec") ?? process.env.EVAL_MAX_DURATION_SEC;
const maxDurationSec = maxDurationSecRaw && Number.isFinite(Number(maxDurationSecRaw)) && Number(maxDurationSecRaw) > 0
  ? Number(maxDurationSecRaw)
  : undefined;

// ── Pipeline cache ──
interface PipelineCacheEntry {
  status: "running" | "done" | "error";
  cameraId: string;
  videoId?: string;
  userId: string;
  segmentCount: number;
  vlmFailedSegments?: number;
  vlmFailRate?: number;
  outputDir: string;
  qaArtifactDir: string;
  promise: Promise<void>;
  error?: string;
}

const pipelineCache = new Map<string, PipelineCacheEntry>();
const checkpointEntryCache = new Map<string, Promise<PipelineCacheEntry>>();

type CheckpointManifest = Record<string, unknown>;

interface QueryCheckpoint {
  id: string;
  mediaTimeMs: number;
  metadata?: Record<string, unknown>;
}

interface SessionTimeline {
  key: string;
  storageId: string;
  videoId?: string;
  sessionId?: string;
  primaryVideoPath: string;
  clips: SessionPipelineClip[];
  checkpoints: QueryCheckpoint[];
}

function videoKey(videoPath: string): string {
  const abs = resolve(videoPath);
  return createHash("sha256").update(abs).digest("hex").substring(0, 16);
}

function envFlag(name: string): boolean {
  const raw = process.env[name];
  if (!raw) return false;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function videoUserId(videoPath: string): string {
  return basename(videoPath, extname(videoPath));
}

function sanitizePathSegment(value: string | undefined, fallback: string): string {
  const raw = (value ?? "").trim();
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || fallback;
}

function writeJsonFile(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function readJsonFile<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

const DATASET_METADATA_FIELDS = [
  "task",
  "split",
  "doc_id",
  "video_id",
  "videoID",
  "question_id",
  "domain",
  "sub_category",
  "task_type",
  "duration",
  "url",
  "group_type",
  "group_structure",
  "level",
  "second_head",
  "third_head",
] as const;

function pickDatasetMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!metadata) return out;
  for (const field of DATASET_METADATA_FIELDS) {
    const value = metadata[field];
    if (value !== undefined && value !== null && value !== "") out[field] = value;
  }
  return out;
}

function numericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function inferClipTimeBasis(rawPath: string): string | undefined {
  const normalizedPath = rawPath.replace(/\\/g, "/").toLowerCase();
  const file = basename(rawPath);
  if (normalizedPath.includes("/egolife") || /\bday\d+[_-]/i.test(file)) {
    return "dataset_day_time";
  }
  return undefined;
}

function checkpointFromMetadata(metadata?: Record<string, unknown>): QueryCheckpoint | null {
  if (!metadata) return null;
  const explicit = numericValue(metadata.query_time_ms);
  if (explicit != null) {
    const rounded = Math.round(explicit);
    return {
      id: sanitizePathSegment(String(metadata.query_time_id ?? `query_${rounded}`), `query_${rounded}`),
      mediaTimeMs: rounded,
      metadata: { source: "request", query_time_ms: rounded },
    };
  }
  const beforeClip = numericValue(metadata.before_clip);
  if (beforeClip != null) {
    const clip = Math.trunc(beforeClip);
    const mediaTimeMs = (clip + 1) * 30_000;
    return {
      id: `before_${clip}`,
      mediaTimeMs,
      metadata: { source: "request", before_clip: clip, query_time_ms: mediaTimeMs },
    };
  }
  return null;
}

function normalizeManifestCheckpoint(raw: unknown): QueryCheckpoint | null {
  if (typeof raw === "number" || typeof raw === "string") {
    const mediaTimeMs = numericValue(raw);
    if (mediaTimeMs == null) return null;
    const rounded = Math.round(mediaTimeMs);
    return { id: `query_${rounded}`, mediaTimeMs: rounded, metadata: { source: "manifest" } };
  }
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const explicit = numericValue(item.query_time_ms ?? item.media_time_ms ?? item.time_ms);
  const beforeClip = numericValue(item.before_clip);
  const mediaTimeMs = explicit != null
    ? Math.round(explicit)
    : beforeClip != null
      ? (Math.trunc(beforeClip) + 1) * 30_000
      : null;
  if (mediaTimeMs == null) return null;
  const fallbackId = beforeClip != null ? `before_${Math.trunc(beforeClip)}` : `query_${mediaTimeMs}`;
  return {
    id: sanitizePathSegment(String(item.id ?? fallbackId), fallbackId),
    mediaTimeMs,
    metadata: { ...item, source: "manifest", query_time_ms: mediaTimeMs },
  };
}

function manifestEntryFor(
  manifest: CheckpointManifest,
  ids: (string | undefined)[],
): unknown {
  for (const id of ids) {
    if (id && manifest[id] !== undefined) return manifest[id];
  }
  return undefined;
}

function manifestCheckpointsFor(
  manifest: CheckpointManifest,
  ids: (string | undefined)[],
): QueryCheckpoint[] {
  const entry = manifestEntryFor(manifest, ids);
  const raw = entry && typeof entry === "object" && !Array.isArray(entry) && "checkpoints" in entry
    ? (entry as Record<string, unknown>).checkpoints
    : entry;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(normalizeManifestCheckpoint).filter((cp): cp is QueryCheckpoint => cp !== null);
  if (typeof raw === "object") {
    if ("clips" in (raw as Record<string, unknown>) || "videos" in (raw as Record<string, unknown>)) {
      return [];
    }
    return Object.entries(raw as Record<string, unknown>)
      .map(([id, value]) => {
        const cp = normalizeManifestCheckpoint(value);
        return cp ? { ...cp, id: sanitizePathSegment(cp.id || id, id) } : null;
      })
      .filter((cp): cp is QueryCheckpoint => cp !== null);
  }
  const cp = normalizeManifestCheckpoint(raw);
  return cp ? [cp] : [];
}

function normalizeManifestClip(raw: unknown): SessionPipelineClip | null {
  if (typeof raw === "string") {
    const timeBasis = inferClipTimeBasis(raw);
    return {
      path: raw,
      mediaStartMs: 0,
      ...(timeBasis ? { metadata: { time_basis: timeBasis } } : {}),
    };
  }
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const rawPath = item.path ?? item.video_path ?? item.visual_path ?? item.file;
  if (typeof rawPath !== "string" || !rawPath.trim()) return null;
  const mediaStartMs = numericValue(
    item.media_start_ms
    ?? item.video_start_time_ms
    ?? item.start_time_ms
    ?? item.mediaTimeOffsetMs
    ?? item.media_time_offset_ms
  ) ?? 0;
  const mediaDurationMs = numericValue(item.media_duration_ms ?? item.duration_ms);
  const timeBasis = stringValue(item.time_basis) ?? inferClipTimeBasis(rawPath);
  return {
    path: resolve(rawPath),
    mediaStartMs: Math.round(mediaStartMs),
    ...(mediaDurationMs != null ? { mediaDurationMs: Math.max(0, Math.round(mediaDurationMs)) } : {}),
    metadata: {
      ...item,
      ...(timeBasis ? { time_basis: timeBasis } : {}),
    },
  };
}

function manifestClipsFor(
  manifest: CheckpointManifest,
  ids: (string | undefined)[],
): SessionPipelineClip[] {
  const entry = manifestEntryFor(manifest, ids);
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
  const item = entry as Record<string, unknown>;
  const rawClips = item.clips ?? item.videos ?? item.segments;
  if (!Array.isArray(rawClips)) return [];
  return rawClips
    .map(normalizeManifestClip)
    .filter((clip): clip is SessionPipelineClip => clip !== null)
    .sort((a, b) => a.mediaStartMs - b.mediaStartMs || a.path.localeCompare(b.path));
}

function dedupeCheckpoints(checkpoints: QueryCheckpoint[]): QueryCheckpoint[] {
  const byId = new Map<string, QueryCheckpoint>();
  for (const cp of checkpoints) {
    byId.set(cp.id, cp);
  }
  return [...byId.values()].sort((a, b) => a.mediaTimeMs - b.mediaTimeMs || a.id.localeCompare(b.id));
}

function currentDateStamp(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

function buildDefaultVersionId(datasetName: string, commitShort?: string): string {
  return sanitizePathSegment(
    `${datasetName}_${currentDateStamp()}_${commitShort?.trim() || "nogit"}`,
    `${datasetName}_${currentDateStamp()}_nogit`,
  );
}

function videoStorageId(videoId: string | undefined, key: string): string {
  return sanitizePathSegment(videoId || key, key);
}

function buildSessionTimeline(
  videoPath: string,
  metadata: Record<string, unknown> | undefined,
  manifest: CheckpointManifest,
): SessionTimeline {
  const pathKey = videoKey(videoPath);
  const videoId = metadata?.video_id == null ? undefined : String(metadata.video_id);
  const sessionId = metadata?.session_id == null ? undefined : String(metadata.session_id);
  const lookupIds = [sessionId, videoId, pathKey];
  const manifestClips = manifestClipsFor(manifest, lookupIds);
  const isMultiClipSession = manifestClips.length > 0;
  const key = isMultiClipSession
    ? sanitizePathSegment(sessionId ?? videoId ?? pathKey, pathKey)
    : pathKey;
  const mediaTimeOffsetMs = numericValue(metadata?.media_time_offset_ms ?? metadata?.video_start_time_ms) ?? 0;
  const timeBasis = stringValue(metadata?.time_basis) ?? inferClipTimeBasis(videoPath);
  const requestCheckpoint = checkpointFromMetadata(metadata);
  const checkpoints = dedupeCheckpoints([
    ...manifestCheckpointsFor(manifest, lookupIds),
    ...(requestCheckpoint ? [requestCheckpoint] : []),
  ]);

  return {
    key,
    storageId: videoStorageId(sessionId ?? videoId, key),
    videoId,
    sessionId,
    primaryVideoPath: resolve(manifestClips[0]?.path ?? videoPath),
    clips: isMultiClipSession
      ? manifestClips
      : [{
        path: resolve(videoPath),
        mediaStartMs: Math.round(mediaTimeOffsetMs),
        metadata: {
          ...(metadata ?? {}),
          ...(timeBasis ? { time_basis: timeBasis } : {}),
        },
      }],
    checkpoints,
  };
}

type VideoQaSummary = {
  video_id?: string;
  camera_id: string;
  qa_run_version: string;
  answered: number;
  correct: number;
  incorrect: number;
  unknown: number;
  updated_at: string;
  scored: number;
  accuracy: number | null;
};

// ── Request/Response types ──
interface EvalRequest {
  prompt: string;
  visual_paths: string[];
  generation_kwargs?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  model?: string;
}

interface EvalResponse {
  answer: string;
  text?: string;
  metadata?: Record<string, unknown>;
}

function loadSegmentTranscripts(videoDir: string): string {
  const segmentsDir = join(videoDir, "segments");
  if (!existsSync(segmentsDir)) return "";
  const blocks: string[] = [];
  for (const file of readdirSync(segmentsDir).filter(f => f.endsWith(".json")).sort()) {
    try {
      const raw = JSON.parse(readFileSync(join(segmentsDir, file), "utf-8")) as {
        segment_id?: string;
        transcript?: string;
        perception_memory?: {
          summary?: string;
          detailed_summary?: string;
          timestamp?: number;
          custom_fields?: Record<string, unknown>;
        };
      };
      const transcript = raw.transcript?.trim();
      const summary = raw.perception_memory?.summary?.trim();
      const detailedSummary = raw.perception_memory?.detailed_summary?.trim();
      const onScreenText = [
        raw.perception_memory?.custom_fields?.on_screen_text,
        raw.perception_memory?.custom_fields?.viewer_comments,
      ].filter(Boolean).map(String).join("\n");
      if (!transcript && !summary && !detailedSummary && !onScreenText) continue;
      const title = `Transcript ${file.replace(/\.json$/, "")} ${raw.segment_id ?? ""}`.trim();
      const timestamp = typeof raw.perception_memory?.timestamp === "number"
        ? `Timestamp: ${Math.round(raw.perception_memory.timestamp / 1000)}s\n`
        : "";
      blocks.push([
        `## Archive Chapter: ${title}`,
        "",
        timestamp.trim(),
        summary ? `Summary: ${summary}` : "",
        detailedSummary ? `Detailed summary: ${detailedSummary}` : "",
        onScreenText ? `On-screen text: ${onScreenText}` : "",
        transcript ? `Transcript: ${transcript}` : "",
      ].filter(Boolean).join("\n"));
    } catch {
      // Keep eval robust to partially written/malformed debug files.
    }
  }
  return blocks.join("\n\n---\n\n");
}

function countSegmentFiles(videoDir: string): number {
  const segmentsDir = join(videoDir, "segments");
  if (!existsSync(segmentsDir)) return 0;
  return readdirSync(segmentsDir).filter((file) => file.endsWith(".json")).length;
}

function countMemoryItems(response: unknown): number {
  if (Array.isArray(response)) return response.length;
  if (!response || typeof response !== "object") return 0;
  let total = 0;
  for (const value of Object.values(response as Record<string, unknown>)) {
    if (Array.isArray(value)) total += value.length;
  }
  return total;
}

function resolveReuseOutputDir(root: string, key: string, videoId?: string): string {
  const absRoot = resolve(root);
  const candidates = [
    absRoot,
    videoId ? join(absRoot, "videos", videoStorageId(videoId, key)) : null,
    videoId ? join(absRoot, videoStorageId(videoId, key)) : null,
    join(absRoot, "videos", key),
    join(absRoot, key),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "segments"))) return candidate;
  }

  return videoId ? join(absRoot, "videos", videoStorageId(videoId, key)) : join(absRoot, key);
}

async function writeMemoryCheckpoint(params: {
  checkpoint: QueryCheckpoint;
  videoOutputDir: string;
  memClient: ReflectWorldClient;
  cameraId: string;
  userId: string;
  segmentId: string;
  segmentIndex: number;
  segmentMediaStartMs: number;
  segmentDurationMs: number;
}): Promise<string> {
  const checkpointDir = join(params.videoOutputDir, "checkpoints", params.checkpoint.id);
  mkdirSync(checkpointDir, { recursive: true });

  const memDump = await dumpMemories(params.memClient, params.cameraId, params.userId);
  writeJsonFile(join(checkpointDir, "memory_dump.json"), memDump);
  writeJsonFile(join(checkpointDir, "checkpoint_meta.json"), {
    id: params.checkpoint.id,
    media_time_ms: params.checkpoint.mediaTimeMs,
    metadata: params.checkpoint.metadata ?? {},
    source_camera_id: params.cameraId,
    source_user_id: params.userId,
    segment_id: params.segmentId,
    segment_index: params.segmentIndex,
    segment_media_start_ms: params.segmentMediaStartMs,
    segment_media_duration_ms: params.segmentDurationMs,
    created_at: new Date().toISOString(),
    memory_counts: {
      episodic: countEpisodicMemories(memDump),
      semantic: countSemanticMemories(memDump),
      procedural: memDump.procedural.length,
      episodic_trace: memDump.episodic_trace.length,
      episodic_entity: memDump.episodic_entity.length,
      episodic_schema: memDump.episodic_schema.length,
      semantic_entity: memDump.semantic_entity.length,
      semantic_context: memDump.semantic_context.length,
    },
  });

  for (const dirName of ["segments", "narratives"]) {
    const src = join(params.videoOutputDir, dirName);
    if (existsSync(src)) {
      cpSync(src, join(checkpointDir, dirName), { recursive: true });
    }
  }
  return checkpointDir;
}

function parseQuestionFromPrompt(prompt: string): Pick<BenchmarkQuestion, "question" | "type" | "options"> {
  const optionPattern = /^\s*([A-H])[\).:]\s+(.+?)\s*$/;
  const options: string[] = [];
  const questionLines: string[] = [];

  for (const line of prompt.split(/\r?\n/)) {
    const option = line.match(optionPattern);
    if (option) {
      options.push(option[2]!.trim());
      continue;
    }
    if (/^\s*(reply|answer|choose)\b.*\b(letter|option)\b/i.test(line)) continue;
    questionLines.push(line);
  }

  const question = questionLines
    .join("\n")
    .replace(/^\s*question\s*:\s*/i, "")
    .trim() || prompt;

  return {
    question,
    type: options.length >= 2 ? "mcq" : "open",
    ...(options.length >= 2 ? { options } : {}),
  };
}

// ── Main ──
async function main() {
  const stateDir = resolveReflectWorldStateDir();
  const runId = process.env.EVAL_RUN_ID?.trim() || `eval_${Date.now().toString(36)}`;
  const datasetName = sanitizePathSegment(process.env.EVAL_DATASET_NAME?.trim() || "benchmark", "benchmark");
  const gitCommit = process.env.EVAL_GIT_COMMIT?.trim() || null;
  const gitCommitShort = process.env.EVAL_GIT_COMMIT_SHORT?.trim() || undefined;
  const gitBranch = process.env.EVAL_GIT_BRANCH?.trim() || null;
  const snapshotVersion = sanitizePathSegment(
    process.env.EVAL_SNAPSHOT_VERSION?.trim() || buildDefaultVersionId(datasetName, gitCommitShort),
    buildDefaultVersionId(datasetName, gitCommitShort),
  );
  const qaRunVersion = sanitizePathSegment(
    process.env.EVAL_QA_RUN_VERSION?.trim() || buildDefaultVersionId(datasetName, gitCommitShort),
    buildDefaultVersionId(datasetName, gitCommitShort),
  );
  const workerLabel = sanitizePathSegment(
    process.env.EVAL_WORKER_LABEL?.trim() || `worker_port${port}`,
    `worker_port${port}`,
  );
  const defaultVersionRoot = join(stateDir, "benchmark_results", snapshotVersion);
  const versionRoot = resolve(process.env.EVAL_VERSION_ROOT?.trim() || defaultVersionRoot);
  const workerRoot = resolve(process.env.EVAL_WORKER_ROOT?.trim() || join(versionRoot, "workers", workerLabel));
  const videosRoot = resolve(process.env.EVAL_VIDEO_OUTPUT_ROOT?.trim() || join(versionRoot, "videos"));
  const tmpDir = resolve(process.env.EVAL_OUTPUT_ROOT?.trim() || join(workerRoot, runId));
  mkdirSync(versionRoot, { recursive: true });
  mkdirSync(workerRoot, { recursive: true });
  mkdirSync(videosRoot, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  const collectionPrefix = sanitizePathSegment(
    process.env.EVAL_COLLECTION_PREFIX?.trim() || workerLabel,
    runId,
  );
  const runtimeManifestPath = join(tmpDir, "runtime_manifest.json");
  const checkpointManifestPath = process.env.EVAL_CHECKPOINT_MANIFEST?.trim()
    || getArg("checkpoint-manifest")
    || "";
  const checkpointManifest = checkpointManifestPath
    ? readJsonFile<CheckpointManifest>(resolve(checkpointManifestPath), {})
    : {};
  const externalMemBaseUrl = process.env.EVAL_REFLECTWORLD_BASE_URL?.trim();
  const reuseExistingVideoMemory = envFlag("EVAL_REUSE_EXISTING_VIDEO_MEMORY");
  const reuseVideoOutputRoot = process.env.EVAL_REUSE_VIDEO_OUTPUT_ROOT?.trim();
  const cleanVideoMemoryOnStart = reuseExistingVideoMemory
    ? false
    : process.env.EVAL_CLEAN_VIDEO_MEMORY_ON_START === "false"
    ? false
    : true;
  const strictVideoMemoryCleanup = envFlag("EVAL_STRICT_VIDEO_MEMORY_CLEANUP");

  // ── Start/Reuse Mem service ──
  let qdrantService: QdrantService | null = null;
  let memService: ReflectWorldService | null = null;
  let memBaseUrl: string;

  if (externalMemBaseUrl) {
    memBaseUrl = externalMemBaseUrl.replace(/\/$/, "");
    console.error(`[eval-server] Reusing external Mem service (endpoint=${memBaseUrl})`);
  } else {
    const qdrantPort = parseInt(process.env.EVAL_QDRANT_PORT ?? "6333", 10);
    const qdrantGrpcPort = parseInt(process.env.EVAL_QDRANT_GRPC_PORT ?? "6334", 10);
    const qdrantStateDir = process.env.EVAL_QDRANT_STATE_DIR?.trim() || join(workerRoot, "qdrant-state");

    qdrantService = new QdrantService({
      stateDir: qdrantStateDir,
      httpPort: qdrantPort,
      grpcPort: qdrantGrpcPort,
    });
    console.error("[eval-server] Starting Qdrant...");
    await qdrantService.start();
    console.error(`[eval-server] Qdrant ready (mode=${qdrantService.mode}, endpoint=${qdrantService.endpoint}, state=${qdrantStateDir})`);

    const memPort = parseInt(process.env.EVAL_REFLECTWORLD_PORT ?? "18219", 10);
    const memStoragePath = process.env.EVAL_REFLECTWORLD_STORAGE_PATH?.trim() || join(workerRoot, "mem-storage");
    mkdirSync(memStoragePath, { recursive: true });

    memService = new ReflectWorldService({
      stateDir,
      port: memPort,
      qdrantHost: "127.0.0.1",
      qdrantPort,
      storagePath: memStoragePath,
      collectionName: collectionPrefix,
    });

    console.error("[eval-server] Starting Mem service...");
    await memService.start();
    memBaseUrl = memService.endpoint;
    console.error(`[eval-server] Mem service ready (endpoint=${memBaseUrl})`);
  }

  const memClientTimeoutMs = Math.max(
    10_000,
    Number.parseInt(process.env.EVAL_MEM_CLIENT_TIMEOUT_MS ?? "60000", 10) || 60_000,
  );
  const memClient = new ReflectWorldClient({ baseUrl: memBaseUrl, timeoutMs: memClientTimeoutMs });
  console.error(`[eval-server] QA runs: dataset=${datasetName} snapshot=${snapshotVersion} qa_run=${qaRunVersion} mem_timeout_ms=${memClientTimeoutMs}`);
  if (reuseExistingVideoMemory) {
    console.error(
      `[eval-server] QA-only mode enabled: reusing existing memories, clean_on_start=false` +
      `${reuseVideoOutputRoot ? ` reuse_output_root=${reuseVideoOutputRoot}` : ""}`,
    );
  }

  writeJsonFile(runtimeManifestPath, {
    run_id: runId,
    dataset_name: datasetName,
    snapshot_version: snapshotVersion,
    qa_run_version: qaRunVersion,
    git_commit: gitCommit,
    git_commit_short: gitCommitShort || null,
    git_branch: gitBranch,
    worker_label: workerLabel,
    version_root: versionRoot,
    worker_root: workerRoot,
    videos_root: videosRoot,
    output_root: tmpDir,
    collection_prefix: collectionPrefix,
    reuse_existing_video_memory: reuseExistingVideoMemory,
    reuse_video_output_root: reuseVideoOutputRoot || null,
    checkpoint_manifest: checkpointManifestPath || null,
    external_mem_base_url: externalMemBaseUrl || null,
    ports: {
      eval_server: port,
      mem_service: memService?.endpoint ?? externalMemBaseUrl ?? null,
      qdrant_http: qdrantService?.endpoint ?? null,
    },
    paths: {
      qdrant_state_dir: process.env.EVAL_QDRANT_STATE_DIR?.trim() || join(workerRoot, "qdrant-state"),
      mem_storage_path: process.env.EVAL_REFLECTWORLD_STORAGE_PATH?.trim() || join(workerRoot, "mem-storage"),
    },
  });
  writeJsonFile(join(versionRoot, "version_meta.json"), {
    dataset_name: datasetName,
    snapshot_version: snapshotVersion,
    git_commit: gitCommit,
    git_commit_short: gitCommitShort || null,
    git_branch: gitBranch,
    created_at: new Date().toISOString(),
    version_root: versionRoot,
    videos_root: videosRoot,
  });
  writeJsonFile(join(workerRoot, "worker_meta.json"), {
    dataset_name: datasetName,
    snapshot_version: snapshotVersion,
    qa_run_version: qaRunVersion,
    worker_label: workerLabel,
    run_id: runId,
    task_name: process.env.EVAL_TASK_NAME?.trim() || null,
    offset: process.env.EVAL_WORKER_OFFSET?.trim() || null,
    limit: process.env.EVAL_WORKER_LIMIT?.trim() || null,
    gpu: process.env.EVAL_WORKER_GPU?.trim() || null,
    eval_port: port,
    mem_port: process.env.EVAL_REFLECTWORLD_PORT?.trim() || null,
    qdrant_port: process.env.EVAL_QDRANT_PORT?.trim() || null,
    worker_root: workerRoot,
    runtime_manifest: runtimeManifestPath,
    updated_at: new Date().toISOString(),
  });

  // ── Perception config (shared, immutable) ──
  // Prefer runtime-local model cache; some checked-in .env files still contain
  // machine-specific absolute paths which do not exist on servers.
  const configuredModelsDir = process.env.REFLECTWORLD_MODELS_DIR?.trim();
  const homeModelsDir = join(resolveReflectWorldHome(), "models");
  let resolvedModelsDir = configuredModelsDir || homeModelsDir;
  if (!existsSync(resolvedModelsDir) && configuredModelsDir && existsSync(homeModelsDir)) {
    console.error(`[eval-server] REFLECTWORLD_MODELS_DIR not found: ${configuredModelsDir}; fallback -> ${homeModelsDir}`);
    resolvedModelsDir = homeModelsDir;
  }
  const hasLocalOnnxModels = (() => {
    try { return readdirSync(resolvedModelsDir).some((f) => f.endsWith(".onnx")); } catch { return false; }
  })();
  const stubsOnly = process.env.STUBS_ONLY === "false"
    ? false
    : process.env.STUBS_ONLY === "true"
      ? true
      : !hasLocalOnnxModels;
  const configuredSttModelDir = process.env.STT_MODEL_DIR?.trim();
  const defaultSttModelDir = join(resolvedModelsDir, "sherpa-onnx-moonshine-tiny-en-int8");
  let sttModelDir = configuredSttModelDir || defaultSttModelDir;
  if (configuredSttModelDir && !existsSync(configuredSttModelDir) && existsSync(defaultSttModelDir)) {
    console.error(`[eval-server] STT_MODEL_DIR not found: ${configuredSttModelDir}; fallback -> ${defaultSttModelDir}`);
    sttModelDir = defaultSttModelDir;
  }

  const perceptionConfig = resolvePerceptionConfig({
    models_dir: resolvedModelsDir,
    stubs_only: stubsOnly,
    stt_model_dir: sttModelDir,
    runtime_mode: "offline_quality",
  });
  console.error(
    `[eval-server] perception: stubs_only=${perceptionConfig.stubs_only} models_dir=${perceptionConfig.models_dir} ` +
    `stt_model_dir=${perceptionConfig.stt_model_dir}`,
  );

  if (!perceptionConfig.stubs_only) {
    const ortAvailable = await OnnxInferenceEngine.isAvailable();
    const runtime = OnnxInferenceEngine.getRuntime();
    console.error(
      `[eval-server] onnxruntime: available=${ortAvailable} variant=${runtime.variant} primary_ep=${runtime.primaryEp}`,
    );
    if (!ortAvailable) {
      throw new Error("Local models enabled but onnxruntime is unavailable");
    }
    if (runtime.primaryEp === "cpu") {
      console.error(
        "[MODEL WARNING] eval-server local ONNX models will run on CPU. " +
        "This is allowed but slow; check onnxruntime-node CUDA/cuDNN setup if GPU was expected.",
      );
    }
  }

  // ── Agent config ──
  // QA-only runs often need to switch Agent-QA to a different OpenAI-compatible
  // endpoint from perception. Keep VLM_* as fallback for existing scripts.
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

  const pipelineEnvTemplate = {
    dataset_name: datasetName,
    snapshot_version: snapshotVersion,
    worker_label: workerLabel,
    run_id: runId,
    git_commit: gitCommit,
    git_commit_short: gitCommitShort || null,
    git_branch: gitBranch,
    perception: {
      vlm_provider: perceptionConfig.vlm_provider,
      vlm_model: perceptionConfig.vlm_model,
      llm_model: perceptionConfig.llm_model,
      // embedder_model is not part of PerceptionConfig; read via a local optional
      // view so this informational metadata field stays compatible if the shared
      // config gains it later. Resolves to undefined today (dropped by JSON.stringify).
      embedder_model: (perceptionConfig as { embedder_model?: string }).embedder_model,
      stubs_only: perceptionConfig.stubs_only,
      models_dir: perceptionConfig.models_dir,
      stt_model_dir: perceptionConfig.stt_model_dir,
      fps,
      frames_per_segment: framesPerSegment,
    },
  };

  const qaEnvTemplate = {
    dataset_name: datasetName,
    snapshot_version: snapshotVersion,
    qa_run_version: qaRunVersion,
    worker_label: workerLabel,
    run_id: runId,
    git_commit: gitCommit,
    git_commit_short: gitCommitShort || null,
    git_branch: gitBranch,
    qa: {
      provider: agentProvider,
      model: agentModel,
      api_base: agentApiBase,
      mem_timeout_ms: memClientTimeoutMs,
    },
  };

  function writeVideoMeta(params: {
    videoDir: string;
    videoId?: string;
    sessionId?: string;
    videoPath: string;
    key: string;
    cameraId: string;
    userId: string;
    clips?: SessionPipelineClip[];
    reuseOutputDir?: string;
  }): void {
    mkdirSync(params.videoDir, { recursive: true });
    const metaPath = join(params.videoDir, "video_meta.json");
    const existing = readJsonFile<Record<string, unknown>>(metaPath, {});
    writeJsonFile(metaPath, {
      ...existing,
      dataset_name: datasetName,
      snapshot_version: snapshotVersion,
      video_id: params.videoId ?? existing.video_id ?? null,
      session_id: params.sessionId ?? existing.session_id ?? null,
      video_key: params.key,
      camera_id: params.cameraId,
      user_id: params.userId,
      source_video_path: resolve(params.videoPath),
      source_video_name: basename(params.videoPath),
      clips: params.clips?.map((clip) => ({
        path: resolve(clip.path),
        media_start_ms: clip.mediaStartMs,
        ...(clip.mediaDurationMs != null ? { media_duration_ms: clip.mediaDurationMs } : {}),
      })) ?? existing.clips ?? undefined,
      worker_label: workerLabel,
      version_root: versionRoot,
      video_dir: params.videoDir,
      reuse_output_dir: params.reuseOutputDir ?? existing.reuse_output_dir ?? undefined,
      updated_at: new Date().toISOString(),
      created_at: existing.created_at ?? new Date().toISOString(),
    });
  }

  function writePipelineEnv(videoDir: string): void {
    mkdirSync(videoDir, { recursive: true });
    writeJsonFile(join(videoDir, "pipeline_env.json"), pipelineEnvTemplate);
  }

  function ensureQaRunEnv(videoDir: string): string {
    const qaDir = qaRunDirForVideo(videoDir, qaRunVersion);
    writeJsonFile(join(qaDir, "env.json"), qaEnvTemplate);
    return qaDir;
  }

  function persistVideoQaArtifacts(params: {
    videoDir: string;
    videoId?: string;
    cameraId: string;
    qaRecord: Record<string, unknown>;
    qaTrace?: AgentQATrace;
  }): VideoQaSummary {
    const qaDir = ensureQaRunEnv(params.videoDir);
    const qaResultsPath = join(qaDir, "qa_results.jsonl");
    const qaSummaryPath = join(qaDir, "qa_summary.json");
    if (params.qaTrace) {
      const traceDir = join(qaDir, "traces");
      mkdirSync(traceDir, { recursive: true });
      const safeQuestionId = String(params.qaRecord.question_id ?? params.qaTrace.question_id)
        .replace(/[^a-zA-Z0-9_.-]+/g, "_")
        .slice(0, 160);
      writeJsonFile(join(traceDir, `${safeQuestionId || "question"}.json`), {
        ...params.qaTrace,
        dataset_name: datasetName,
        snapshot_version: snapshotVersion,
        qa_run_version: qaRunVersion,
        video_id: params.videoId,
        camera_id: params.cameraId,
        trace_schema_version: 1,
        updated_at: new Date().toISOString(),
      });
    }
    appendFileSync(qaResultsPath, `${JSON.stringify(params.qaRecord)}\n`);
    const summary = readJsonFile<VideoQaSummary>(qaSummaryPath, {
      video_id: params.videoId,
      camera_id: params.cameraId,
      qa_run_version: qaRunVersion,
      answered: 0,
      correct: 0,
      incorrect: 0,
      unknown: 0,
      updated_at: new Date().toISOString(),
      scored: 0,
      accuracy: null,
    });
    summary.video_id = params.videoId ?? summary.video_id;
    summary.camera_id = params.cameraId;
    summary.qa_run_version = qaRunVersion;
    const correct = params.qaRecord.correct;
    summary.answered += 1;
    if (correct === true) summary.correct += 1;
    else if (correct === false) summary.incorrect += 1;
    else summary.unknown += 1;
    summary.updated_at = new Date().toISOString();
    summary.scored = summary.correct + summary.incorrect;
    summary.accuracy = summary.scored > 0 ? Number((summary.correct / summary.scored).toFixed(4)) : null;
    writeJsonFile(qaSummaryPath, summary);
    return summary;
  }

  // ── VC config ──
  const vcConfig = createBenchmarkVisionControllerConfig();

  // ── Graceful shutdown ──
  const stopServices = async () => {
    console.error("[eval-server] Stopping services...");
    if (memService) {
      await memService.stop().catch((err: unknown) => console.error(`Mem stop error: ${err}`));
    }
    if (qdrantService) {
      await qdrantService.stop().catch((err: unknown) => console.error(`Qdrant stop error: ${err}`));
    }
  };
  process.on("SIGINT", async () => { await stopServices(); process.exit(130); });
  process.on("SIGTERM", async () => { await stopServices(); process.exit(143); });

  // ── Run pipeline for a video (cached) ──
  async function ensurePipeline(videoPath: string, metadata?: Record<string, unknown>): Promise<PipelineCacheEntry> {
    const timeline = buildSessionTimeline(videoPath, metadata, checkpointManifest);
    const key = timeline.key;
    const existing = pipelineCache.get(key);
    if (existing) {
      if (existing.status === "running") {
        await existing.promise;
      }
      return existing;
    }

    const cameraId = `eval_${key}`;
    const reqVideoId = timeline.videoId;
    const storageLookupId = timeline.sessionId ?? reqVideoId;
    const userId = timeline.sessionId ?? (timeline.clips.length > 1 ? key : videoUserId(videoPath));
    const storageId = timeline.storageId;
    const videoOutputDir = join(videosRoot, storageId);
    const checkpoints = timeline.checkpoints;
    mkdirSync(join(videoOutputDir, "keyframes"), { recursive: true });
    writeVideoMeta({
      videoDir: videoOutputDir,
      videoId: reqVideoId,
      sessionId: timeline.sessionId,
      videoPath: timeline.primaryVideoPath,
      key,
      cameraId,
      userId,
      clips: timeline.clips,
    });
    writePipelineEnv(videoOutputDir);

    const entry: PipelineCacheEntry = {
      status: "running",
      cameraId,
      videoId: reqVideoId,
      userId,
      segmentCount: 0,
      outputDir: videoOutputDir,
      qaArtifactDir: videoOutputDir,
      promise: Promise.resolve(),
      error: undefined,
    };
    pipelineCache.set(key, entry);

    if (reuseExistingVideoMemory) {
      entry.promise = (async () => {
        try {
          const reuseDir = reuseVideoOutputRoot
            ? resolveReuseOutputDir(reuseVideoOutputRoot, key, storageLookupId)
            : videoOutputDir;
          const probe = await memClient.getMemories({
            camera_id: cameraId,
            memory_type: "episodic",
            limit: 1,
          });
          let memoryCount = countMemoryItems(probe);

          if (memoryCount === 0) {
            const dumpPath = join(reuseDir, "memory_dump.json");
            const restore = await rehydrateMemoriesFromDump(
              memClient,
              cameraId,
              userId,
              dumpPath,
              (message) => console.error(`[eval-server][rehydrate] ${message}`),
            );
            if (restore.skipped) {
              console.error(`[eval-server] QA-only rehydrate skipped for ${key}: ${restore.reason}`);
            } else {
              console.error(
                `[eval-server] QA-only rehydrated ${key}: episodic=${restore.restored.episodic} ` +
                `semantic=${restore.restored.semantic} procedural=${restore.restored.procedural}` +
                `${restore.failed ? ` failed=${restore.failed}` : ""}`,
              );
            }
            const reprobe = await memClient.getMemories({
              camera_id: cameraId,
              memory_type: "episodic",
              limit: 1,
            });
            memoryCount = countMemoryItems(reprobe);
          }

          if (memoryCount === 0) {
            throw new Error(
              `QA-only mode requested but no existing episodic memory found for camera=${cameraId}`,
            );
          }

          entry.outputDir = reuseDir;
          writeVideoMeta({
            videoDir: entry.qaArtifactDir,
            videoId: reqVideoId,
            sessionId: timeline.sessionId,
            videoPath: timeline.primaryVideoPath,
            key,
            cameraId,
            userId,
            clips: timeline.clips,
            reuseOutputDir: reuseDir,
          });
          entry.segmentCount = countSegmentFiles(reuseDir);
          entry.status = "done";
          console.error(
            `[eval-server] Reusing existing memories for ${key}: camera=${cameraId} ` +
            `segments=${entry.segmentCount} output_dir=${reuseDir}`,
          );
        } catch (err) {
          entry.status = "error";
          entry.error = String(err);
          console.error(`[eval-server] QA-only memory reuse failed for ${key}: ${err}`);
        }
      })();

      await entry.promise;
      return entry;
    }

    entry.promise = (async () => {
      let traceHandler: ((event: { type: string; data: unknown }) => void) | undefined;
      let pipelineDeps: Awaited<ReturnType<typeof createPipelineDeps>> | undefined;
      try {
        if (cleanVideoMemoryOnStart) {
          const cleanupStart = Date.now();
          try {
            const cleanupResult = await memClient.deleteMemories({
              camera_id: cameraId,
            });
            console.error(
              `[eval-server] Cleared old memories for camera=${cameraId}` +
              `${reqVideoId ? ` video_id=${reqVideoId}` : ""}` +
              ` (${Date.now() - cleanupStart}ms): ${cleanupResult.message}`,
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (strictVideoMemoryCleanup) {
              throw new Error(`memory cleanup failed for camera=${cameraId}: ${msg}`);
            }
            console.error(
              `[eval-server] WARN memory cleanup failed for camera=${cameraId}` +
              `${reqVideoId ? ` video_id=${reqVideoId}` : ""}: ${msg}`,
            );
          }
        }

        // Fresh pipelineDeps per video — prevents cross-video state pollution.
        pipelineDeps = await createPipelineDeps(perceptionConfig, {
          saveMedia: (_cameraId, segmentId, mediaType, data, suffix) => {
            const name = suffix != null
              ? `${segmentId}_${mediaType}_${suffix}.jpg`
              : `${segmentId}_${mediaType}.jpg`;
            const path = join(videoOutputDir, "keyframes", name);
            writeFileSync(path, data);
            return path;
          },
        });
        // Stable non-undefined binding so closures below (NarrativeMemory.llm,
        // consultationDispatcher) capture the assigned value, not the `| undefined` let.
        const deps = pipelineDeps;
        wireBenchmarkReidMemory({
          pipelineDeps,
          memClient,
          userId,
          enabled: !perceptionConfig.stubs_only,
        });

        const narrativeMemory = new NarrativeMemory({
          baseDir: join(videoOutputDir, "narratives"),
          memClient,
          userId,
          schemaEventBudget: 5,
          schemaMaxIntervalMs: 3_600_000,
          updateBufferSize: Math.max(
            1,
            Number.parseInt(process.env.EVAL_NARRATIVE_UPDATE_BUFFER_SIZE ?? "12", 10) || 12,
          ),
          llm: (prompt, options) => deps.vlmAnalyzer.compressText(prompt, {
            ...options,
            promptVersion: deps.logging?.promptVersion,
            llmContext: { ...deps.logging?.llmContext, ...options?.llmContext },
          }),
        });

        const store = new PipelineStore(videoOutputDir);
        pipelineDeps.logging = {
          archiveSegments: true,
          promptVersion: gitCommit ?? gitCommitShort ?? snapshotVersion,
          llmContext: {
            run_id: runId,
            snapshot_version: snapshotVersion,
            video_id: reqVideoId,
            camera_id: cameraId,
          },
        };
        pipelineDeps.vlmAnalyzer.setLlmCallRecorder((call) => {
          try { store.saveLlmCall(call); } catch { /* best-effort */ }
        });
        const semanticContextManager = wireBenchmarkSemanticContext({
          pipelineDeps,
          memClient,
          store,
          userId,
          model: perceptionConfig.vlm_model_lite,
          promptVersion: pipelineDeps.logging?.promptVersion,
          llmContext: pipelineDeps.logging?.llmContext,
          logPrefix: "eval-server",
        });
        const semanticContextPromises: Promise<void>[] = [];

        const consultationAnalyzer = new VlmAnalyzer(agentProvider === "gemini"
          ? {
              provider: "gemini",
              apiKey: agentApiKey,
              textModel: agentModel,
              llmCallRecorder: (call) => {
                try { store.saveLlmCall(call); } catch { /* best-effort */ }
              },
              llmContext: pipelineDeps.logging?.llmContext,
            }
          : {
              provider: "openai",
              apiKey: agentApiKey,
              baseUrl: agentApiBase,
              textModel: agentModel,
              llmCallRecorder: (call) => {
                try { store.saveLlmCall(call); } catch { /* best-effort */ }
              },
              llmContext: pipelineDeps.logging?.llmContext,
            });
        const consultationDispatcher = {
          async submitConsultation(context: Record<string, unknown>) {
            const prompt = buildVisionControllerConsultationPrompt(context);
            const segmentId = typeof context.segment_id === "string" ? context.segment_id : undefined;
            const text = await consultationAnalyzer.completeText(prompt, {
              responseFormat: "json",
              model: agentModel,
              stage: "vision_controller.consultation",
              reasoningEffort: "low",
              promptVersion: deps.logging?.promptVersion,
              llmContext: { ...deps.logging?.llmContext, segment_id: segmentId },
            });
            if (!text) return null;
            return parseVisionControllerConsultationResponse(text, "eval-server");
          },
        };

        // Wire trace subscriber
        traceHandler = (event: { type: string; data: unknown }) => {
          if (event.type === "system:pipeline_trace") {
            try { store.saveTrace(event.data as any); } catch { /* best-effort */ }
          }
        };
        monitorBus.on("monitor", traceHandler);

        pipelineDeps.postProcessor = {
          async sendNotifications() { /* no-op */ },
          onPipelineComplete(result, segment, meta) {
            try {
              store.logResult(segment, result, meta.vlm ? {
                notify_user: meta.vlm.notify_user,
                is_static_scene: meta.vlm.is_static_scene,
                vlm_model: meta.vlm.vlm_model,
                vlm_latency_ms: meta.vlm.vlm_latency_ms,
              } : undefined);
            } catch { /* ignore logging errors */ }
            const semanticContextPromise = recordBenchmarkSemanticContextObservation(semanticContextManager, result)
              .catch((err) => {
                console.error(`[eval-server][semantic-context] onSegmentProcessed failed: ${err instanceof Error ? err.message : err}`);
              });
            semanticContextPromises.push(semanticContextPromise);
          },
          onPipelineError(segId, camId, stage, msg) {
            store.logError(segId, camId, stage, msg);
          },
        };

        console.error(
          `[eval-server] Pipeline starting for ${key} (${timeline.primaryVideoPath}) ` +
          `clips=${timeline.clips.length}` +
          `${checkpoints.length ? ` checkpoints=${checkpoints.length}` : ""}`,
        );
        const pipelineResult = await runSessionPipeline({
          clips: timeline.clips,
          cameraId,
          userId,
          fps,
          framesPerSegment,
          maxDurationSec,
          outputDir: videoOutputDir,
          pipelineDeps,
          memClient,
          vcConfig,
          consultationDispatcher,
          narrativeMemory,
          checkpoints: checkpoints.map((cp): VideoPipelineCheckpoint => ({
            id: cp.id,
            mediaTimeMs: cp.mediaTimeMs,
            metadata: cp.metadata,
          })),
          onMemoryCheckpoint: checkpoints.length
            ? async ({ checkpoint, segment, segmentIndex }) => {
                await Promise.all(semanticContextPromises);
                const segmentDurationMs = Math.max(0, Math.round((segment.duration_sec ?? 0) * 1000));
                const checkpointDir = await writeMemoryCheckpoint({
                  checkpoint,
                  videoOutputDir,
                  memClient,
                  cameraId,
                  userId,
                  segmentId: segment.segment_id,
                  segmentIndex,
                  segmentMediaStartMs: segment.timestamp,
                  segmentDurationMs,
                });
                console.error(
                  `[eval-server] Memory checkpoint ${checkpoint.id} for ${key}: ` +
                  `media_time_ms=${checkpoint.mediaTimeMs} dir=${checkpointDir}`,
                );
              }
            : undefined,
          ignoreNarrativeFlushErrors: process.env.EVAL_REQUIRE_NARRATIVE_FLUSH === "true" ? false : true,
          selfCheckComponents: [
            qdrantService
              ? {
                  name: "qdrant",
                  status: qdrantService.mode === "stopped" ? "error" : "ok",
                  required: true,
                  detail: `mode=${qdrantService.mode} endpoint=${qdrantService.endpoint}`,
                }
              : {
                  name: "qdrant",
                  status: "disabled",
                  detail: "external memory service; qdrant is not managed by eval-server",
                },
            {
              name: "memory_service",
              status: memBaseUrl ? "ok" : "error",
              required: true,
              detail: `mode=${memService?.mode ?? "external"} endpoint=${memBaseUrl}`,
            },
          ],
        });
        entry.segmentCount = pipelineResult.segmentCount;
        const vlmFailed = pipelineResult.segmentResults.filter(
          (r) => r.perception_memory.summary === "VLM call failed.",
        ).length;
        entry.vlmFailedSegments = vlmFailed;
        entry.vlmFailRate = entry.segmentCount > 0 ? vlmFailed / entry.segmentCount : 0;
        console.error(
          `[eval-server] Pipeline stats for ${key}: segments=${entry.segmentCount} ` +
          `vlm_failed=${entry.vlmFailedSegments} fail_rate=${(entry.vlmFailRate * 100).toFixed(1)}%`,
        );
        console.error(`[eval-server] ${pipelineResult.segmentCount} segments, waiting for memory writes...`);
        await pipelineResult.memoryBarrier;
        await Promise.all(semanticContextPromises);
        try {
          writeVideoMeta({
            videoDir: videoOutputDir,
            videoId: reqVideoId,
            sessionId: timeline.sessionId,
            videoPath: timeline.primaryVideoPath,
            key,
            cameraId,
            userId,
            clips: timeline.clips,
          });
          const memDump = await dumpMemories(memClient, cameraId, userId);
          writeJsonFile(join(videoOutputDir, "memory_dump.json"), memDump);
          console.error(
            `[eval-server] Memory dump for ${key}: episodic=${countEpisodicMemories(memDump)} ` +
            `semantic=${countSemanticMemories(memDump)} procedural=${memDump.procedural.length}`,
          );
        } catch (err) {
          console.error(`[eval-server] WARN memory dump failed for ${key}: ${err}`);
        }
        console.error(`[eval-server] Pipeline done for ${key}`);
        entry.status = "done";
      } catch (err) {
        entry.status = "error";
        entry.error = String(err);
        console.error(`[eval-server] Pipeline failed for ${key}: ${err}`);
      } finally {
        if (traceHandler) monitorBus.off("monitor", traceHandler);
        if (pipelineDeps) {
          try {
            pipelineDeps.sttAnalyzer?.dispose();
            await pipelineDeps.router?.disposeAll();
            await pipelineDeps.modelManager?.dispose();
            console.error(`[eval-server] Released pipeline resources for ${key}`);
          } catch (disposeErr) {
            console.error(`[eval-server] WARN failed to release pipeline resources for ${key}: ${disposeErr}`);
          }
        }
      }
    })();

    await entry.promise;
    return entry;
  }

  async function ensureCheckpointEntry(
    baseEntry: PipelineCacheEntry,
    videoPath: string,
    metadata?: Record<string, unknown>,
  ): Promise<PipelineCacheEntry> {
    const checkpoint = checkpointFromMetadata(metadata);
    if (!checkpoint) return baseEntry;

    const checkpointDir = join(baseEntry.outputDir, "checkpoints", checkpoint.id);
    const checkpointQaArtifactDir = qaArtifactDirForCheckpoint(baseEntry.qaArtifactDir, checkpoint.id);
    const dumpPath = join(checkpointDir, "memory_dump.json");
    if (!existsSync(dumpPath)) {
      throw new Error(`checkpoint not found for ${checkpoint.id}: ${dumpPath}`);
    }

    const cacheKey = `${baseEntry.cameraId}:${checkpoint.id}`;
    const existing = checkpointEntryCache.get(cacheKey);
    if (existing) return existing;

    const promise = (async (): Promise<PipelineCacheEntry> => {
      const cameraId = sanitizePathSegment(`${baseEntry.cameraId}__${checkpoint.id}`, `${baseEntry.cameraId}_checkpoint`);
      const userId = cameraId;
      const probe = await memClient.getMemories({
        camera_id: cameraId,
        user_id: userId,
        memory_type: "episodic",
        limit: 1,
      });
      let memoryCount = countMemoryItems(probe);

      if (memoryCount === 0) {
        const restore = await rehydrateMemoriesFromDump(
          memClient,
          cameraId,
          userId,
          dumpPath,
          (message) => console.error(`[eval-server][checkpoint:${checkpoint.id}] ${message}`),
        );
        if (restore.skipped) {
          console.error(`[eval-server] Checkpoint rehydrate skipped for ${checkpoint.id}: ${restore.reason}`);
        } else {
          console.error(
            `[eval-server] Checkpoint rehydrated ${checkpoint.id}: episodic=${restore.restored.episodic} ` +
            `semantic=${restore.restored.semantic} procedural=${restore.restored.procedural}` +
            `${restore.failed ? ` failed=${restore.failed}` : ""}`,
          );
        }
        const reprobe = await memClient.getMemories({
          camera_id: cameraId,
          user_id: userId,
          memory_type: "episodic",
          limit: 1,
        });
        memoryCount = countMemoryItems(reprobe);
      }

      if (memoryCount === 0) {
        throw new Error(`checkpoint ${checkpoint.id} has no episodic memories after rehydrate`);
      }

      writeVideoMeta({
        videoDir: checkpointQaArtifactDir,
        videoId: baseEntry.videoId,
        videoPath,
        key: `${baseEntry.cameraId}:${checkpoint.id}`,
        cameraId,
        userId,
        reuseOutputDir: checkpointDir !== checkpointQaArtifactDir ? checkpointDir : undefined,
      });

      return {
        ...baseEntry,
        cameraId,
        userId,
        outputDir: checkpointDir,
        qaArtifactDir: checkpointQaArtifactDir,
        segmentCount: countSegmentFiles(checkpointDir),
        promise: Promise.resolve(),
        status: "done",
      };
    })();

    checkpointEntryCache.set(cacheKey, promise);
    return promise;
  }

  // ── Handle single evaluate request ──
  async function handleEvaluate(req: EvalRequest): Promise<EvalResponse> {
    const videoPath = req.visual_paths?.[0];
    if (!videoPath) {
      return { answer: "[ERROR] No visual_paths provided", text: "[ERROR] No visual_paths provided" };
    }
    if (!existsSync(videoPath)) {
      const message = `[ERROR] Video not found: ${videoPath}`;
      return { answer: message, text: message };
    }

    const startTime = Date.now();

    // Ensure pipeline is done (cached)
    const baseEntry = await ensurePipeline(videoPath, req.metadata);
    if (baseEntry.status === "error") {
      const message = `[ERROR] Pipeline failed: ${baseEntry.error}`;
      return {
        answer: message,
        text: message,
        metadata: { video_id: req.metadata?.video_id, error: baseEntry.error },
      };
    }
    let entry: PipelineCacheEntry;
    try {
      entry = await ensureCheckpointEntry(baseEntry, videoPath, req.metadata);
    } catch (err) {
      const message = `[ERROR] Checkpoint failed: ${String(err).slice(0, 200)}`;
      return {
        answer: message,
        text: message,
        metadata: { video_id: req.metadata?.video_id, error: String(err) },
      };
    }

    const pipelineLatencyMs = Date.now() - startTime;

    // Single-question QA
    const questionId = (req.metadata?.question_id as string)
      ?? `${entry.cameraId}-${Date.now()}`;

    const parsed = parseQuestionFromPrompt(req.prompt);
    const question: BenchmarkQuestion = {
      id: questionId,
      question: parsed.question,
      type: parsed.type,
      options: parsed.options,
      ground_truth: (req.metadata?.answer as string) ?? "",
    };

    const qaStart = Date.now();
    const videoId = (req.metadata?.video_id as string | undefined) ?? entry.videoId;
    const qaStore = new PipelineStore(entry.qaArtifactDir);
    let result: QAResult | undefined;
    try {
      [result] = await runAgentQA([question], {
        agentProvider,
        agentApiBase,
        agentApiKey,
        agentModel,
        cameraId: entry.cameraId,
        userId: entry.userId,
        memClient,
        videoFrameSource: (() => {
          const timelineForQa = buildSessionTimeline(videoPath, req.metadata, checkpointManifest);
          const clips = timelineForQa.clips;
          // Use SingleFileFrameSource only when truly zero-offset single file;
          // otherwise SessionFrameSource handles mediaStartMs translation correctly.
          const isTrivialSingleClip = clips.length <= 1
            && (clips[0]?.mediaStartMs ?? 0) === 0
            && clips[0]?.mediaDurationMs == null;
          if (isTrivialSingleClip) {
            return new SingleFileFrameSource(resolve(clips[0]?.path ?? videoPath));
          }
          return new SessionFrameSource(
            clips.map(c => ({ path: resolve(c.path), mediaStartMs: c.mediaStartMs, mediaDurationMs: c.mediaDurationMs })),
          );
        })(),
        promptVersion: gitCommit ?? gitCommitShort ?? snapshotVersion,
        llmContext: {
          run_id: runId,
          snapshot_version: snapshotVersion,
          video_id: videoId,
          camera_id: entry.cameraId,
        },
        llmCallRecorder: (call) => {
          try { qaStore.saveLlmCall(call); } catch { /* best-effort */ }
        },
      });
    } finally {
      qaStore.close();
    }
    const qaLatencyMs = Date.now() - qaStart;
    if (!result) throw new Error("Agent QA returned no result");
    const optionCount = question.options?.length ?? 0;
    const gtLetter = extractOptionLetter((req.metadata?.answer as string) ?? "", optionCount);
    const predLetter = question.type === "mcq"
      ? extractMcqPrediction(result, optionCount)
      : null;
    const answer = question.type === "mcq"
      ? (predLetter ?? "")
      : result.agent_answer;
    const correct = gtLetter && predLetter ? predLetter === gtLetter : null;
    const traceDiagnostics = summarizeQaTraceDiagnostics(result.trace);
    const datasetMetadata = pickDatasetMetadata(req.metadata);

    const qaRecord = {
      ts: new Date().toISOString(),
      run_id: runId,
      dataset_name: datasetName,
      dataset_metadata: datasetMetadata,
      snapshot_version: snapshotVersion,
      qa_run_version: qaRunVersion,
      video_key: videoId ?? entry.cameraId,
      video_id: videoId,
      camera_id: entry.cameraId,
      question_id: questionId,
      status: result.status,
      answer_mode: result.answer_mode ?? null,
      failure_reason: result.failure_reason ?? null,
      fallback_reason: result.fallback_reason ?? null,
      retryable: result.retryable ?? false,
      degraded: result.degraded ?? false,
      degraded_reasons: result.degraded_reasons ?? [],
      answer_payload: result.trace?.answer_payload ?? null,
      gt_answer: gtLetter,
      pred_answer: predLetter,
      correct,
      raw_answer: result.agent_answer,
      tool_calls: result.tool_calls.length,
      total_rounds: result.total_rounds,
      trace_diagnostics: traceDiagnostics,
      pipeline_latency_ms: pipelineLatencyMs,
      qa_latency_ms: qaLatencyMs,
      segments: entry.segmentCount,
      vlm_failed_segments: entry.vlmFailedSegments ?? null,
      vlm_fail_rate: entry.vlmFailRate ?? null,
      trace_available: Boolean(result.trace),
    };
    const row = persistVideoQaArtifacts({
      videoDir: entry.qaArtifactDir,
      videoId,
      cameraId: entry.cameraId,
      qaRecord,
      qaTrace: result.trace,
    });

    const accuracy = row.accuracy == null ? null : row.accuracy;
    console.error(
      `[eval-server][qa] video=${videoId ?? "-"} question_id=${questionId} status=${result.status} ` +
      `gt=${gtLetter ?? "-"} pred=${predLetter ?? "-"} correct=${correct == null ? "na" : String(correct)} ` +
      `acc=${accuracy == null ? "na" : (accuracy * 100).toFixed(1) + "%"} ` +
      `answered=${row.answered} tools=${result.tool_calls.length} rounds=${result.total_rounds} ` +
      `pipeline_ms=${pipelineLatencyMs} qa_ms=${qaLatencyMs}`,
    );

    return {
      answer,
      text: answer,
      metadata: {
        video_id: req.metadata?.video_id,
        user_id: entry.userId,
        question_id: questionId,
        dataset_metadata: datasetMetadata,
        question_type: question.type,
        option_count: question.options?.length ?? 0,
        raw_answer: result.agent_answer,
        segments: entry.segmentCount,
        vlm_failed_segments: entry.vlmFailedSegments ?? null,
        vlm_fail_rate: entry.vlmFailRate ?? null,
        pipeline_cached: pipelineLatencyMs < 100,
        pipeline_latency_ms: pipelineLatencyMs,
        qa_latency_ms: qaLatencyMs,
        qa_status: result.status,
        answer_mode: result.answer_mode ?? null,
        failure_reason: result.failure_reason ?? null,
        fallback_reason: result.fallback_reason ?? null,
        retryable: result.retryable ?? false,
        degraded: result.degraded ?? false,
        degraded_reasons: result.degraded_reasons ?? [],
        answer_payload: result.trace?.answer_payload ?? null,
        gt_answer: gtLetter,
        pred_answer: predLetter,
        correct,
        qa_artifact_dir: entry.qaArtifactDir,
        video_answered: row.answered,
        video_correct: row.correct,
        video_incorrect: row.incorrect,
        video_unknown: row.unknown,
        tool_calls: result.tool_calls.length,
        total_rounds: result.total_rounds,
        trace_diagnostics: traceDiagnostics,
        trace_available: Boolean(result.trace),
      },
    };
  }

  // ── HTTP server ──
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;

    // Health check
    if (req.method === "GET" && (path === "/health" || path === "/healthz")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", cached_videos: pipelineCache.size }));
      return;
    }

    if (req.method === "POST" && path === "/v1/lmms_eval/reset_cache") {
      pipelineCache.clear();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", cache_size: 0 }));
      return;
    }

    const isEvaluatePath = path === "/evaluate" || path === "/v1/lmms_eval/generate";
    if (req.method !== "POST" || !isEvaluatePath) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    // Parse body
    let body = "";
    for await (const chunk of req) body += chunk;

    let evalReq: EvalRequest;
    try {
      evalReq = JSON.parse(body) as EvalRequest;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON", answer: "[ERROR] Invalid JSON" }));
      return;
    }

    try {
      const result = await handleEvaluate(evalReq);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error(`[eval-server] Request error: ${err}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: String(err),
        answer: `[ERROR] ${String(err).slice(0, 200)}`,
        text: `[ERROR] ${String(err).slice(0, 200)}`,
      }));
    }
  });

  server.listen(port, () => {
    console.error(`\n══════════════════════════════════════════`);
    console.error(`  ReflectWorld Eval Server`);
    console.error(`  POST http://localhost:${port}/evaluate`);
    console.error(`  POST http://localhost:${port}/v1/lmms_eval/generate`);
    console.error(`  GET  http://localhost:${port}/health`);
    console.error(`  GET  http://localhost:${port}/healthz`);
    console.error(`══════════════════════════════════════════`);
    console.error(`  Run ID:     ${runId}`);
    console.error(`  Dataset:    ${datasetName}`);
    console.error(`  Snapshot:   ${snapshotVersion}`);
    console.error(`  QA Run:     ${qaRunVersion}`);
    console.error(`  VLM:        ${perceptionConfig.vlm_provider} / ${perceptionConfig.vlm_model}`);
    console.error(`  Agent:      ${agentModel}`);
    console.error(`  FPS:        ${fps}`);
    console.error(`  VC Policy:  basic_frame_policy`);
    console.error(`  Worker Dir: ${tmpDir}`);
    console.error(`  Version:    ${versionRoot}`);
    console.error(`  Videos:     ${videosRoot}`);
    console.error(`══════════════════════════════════════════\n`);
  });
}

main().catch((err) => {
  console.error(`[eval-server] Fatal: ${err}`);
  process.exit(1);
});
