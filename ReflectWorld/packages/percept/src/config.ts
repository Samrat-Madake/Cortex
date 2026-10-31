// packages/percept/src/config.ts
import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeSecretInput } from "@reflectworld/shared";

const VlmProviderEnum = z.enum(["gemini", "openai"]).default("openai");
const PerceptionRuntimeModeEnum = z.enum(["offline_quality", "live_latency"]).default("offline_quality");
const SECRET_FIELDS = new Set(["vlm_api_key", "elevenlabs_api_key"]);

function normalizeRawSecrets(raw?: Record<string, unknown>): Record<string, unknown> {
  if (!raw) return {};
  const normalized = { ...raw };
  for (const key of SECRET_FIELDS) {
    if (!(key in normalized)) continue;
    const value = normalizeSecretInput(normalized[key], "percept");
    if (value !== undefined) normalized[key] = value;
    else delete normalized[key];
  }
  return normalized;
}

function expandHomePath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return path === "~" || path.startsWith("~/")
    ? join(homedir(), path.slice(2))
    : path;
}

/**
 * Runtime configuration for @reflectworld/percept.
 *
 * Model API configuration is intentionally minimal:
 * - VLM_* configures visual analysis.
 * - LLM_MODEL configures text-only work and reuses VLM_API_KEY/VLM_BASE_URL.
 * - Azure OpenAI and Vertex AI are intentionally not supported here; use an
 *   OpenAI-compatible gateway such as LiteLLM when an adapter is needed.
 */
export const PerceptionConfigSchema = z.object({
  // ── Model API ──
  /** Which VLM provider to use for video analysis. */
  vlm_provider: VlmProviderEnum,
  /** Primary VLM model for multi-frame analysis. */
  vlm_model: z.string().default("gpt-5-mini"),
  /** Smaller/cheaper VLM model for snapshot or single-frame analysis. */
  vlm_model_lite: z.string().default("gpt-5-mini"),
  /** API key for the selected VLM provider. */
  vlm_api_key: z.string().default(""),
  /** OpenAI-compatible base URL. Required when vlm_provider=openai. */
  vlm_base_url: z.string().optional(),
  /** Text-only model for compression, narrative summaries, and benchmark QA. */
  llm_model: z.string().default("gpt-5-mini"),

  // ── VLM request reliability ──
  /** Per-request timeout for VLM/LLM calls in milliseconds. */
  vlm_request_timeout_ms: z.number().int().min(1_000).default(120_000),
  /** Max retry count after first VLM attempt (0 => no retry). */
  vlm_max_retries: z.number().int().min(0).default(2),
  /** Base backoff delay for VLM retries in milliseconds. */
  vlm_retry_base_delay_ms: z.number().int().min(0).default(600),
  /** Max backoff delay for VLM retries in milliseconds. */
  vlm_retry_max_delay_ms: z.number().int().min(0).default(4_000),
  /** Downscale frames before VLM calls. Default false preserves benchmark/main behavior. */
  vlm_frame_resize_enabled: z.boolean().default(false),
  /** Target short-edge size when VLM frame resize is enabled. */
  vlm_frame_resize_short_edge: z.number().int().min(1).default(432),
  /** JPEG quality when VLM frame resize is enabled. */
  vlm_frame_resize_jpeg_quality: z.number().int().min(1).max(100).default(75),
  /** Max number of source streams that can execute perception concurrently. */
  source_concurrency: z.number().int().min(1).default(1),
  /** Max queued live segments per source before rejection/degraded signaling. */
  max_queued_per_source: z.number().int().min(1).default(6),
  /** Skip queued live segments once they are more than this many media milliseconds behind the latest segment. */
  live_backlog_skip_after_ms: z.number().int().min(1).default(180_000),
  /** Local-file ffmpeg pacing for Cam input. Upload/dashboard default to fast; video-runner can opt into realtime. */
  local_file_pacing: z.enum(["realtime", "fast"]).default("fast"),
  /** Runtime mode: benchmark-safe offline quality or Dashboard/live low-latency mode. */
  runtime_mode: PerceptionRuntimeModeEnum,
  /** Animated segment media previews. Disabled by default to preserve benchmark/main latency. */
  animated_segment_previews: z.boolean().default(false),

  // ── Prompt customization ──
  /** Describes the camera's scene. */
  scene_description: z.string().optional(),
  /** Targets to pay extra attention to. */
  focus_targets: z.string().optional(),
  /** Custom security criteria. */
  security_rules: z.string().optional(),

  // ── ReflectWorld (memory client) ──
  /** ReflectWorld API base URL. */
  reflectworld_endpoint: z.string().url().default("http://localhost:8219"),

  // ── Working Memory ──
  /** Seconds of inactivity before an open event is closed. */
  working_memory_event_timeout_sec: z.number().int().min(1).default(30),
  /** Maximum segments allowed before an open event is force-rotated. */
  working_memory_max_event_segments: z.number().int().min(1).default(18),

  // ── Strategy ──
  /** When true, local detection/ReID analyzers remain as stubs. */
  stubs_only: z.boolean().default(true),
  /** Minimum perception level required by deployment. 0 keeps local models optional; 1+ makes missing local capability fatal. */
  required_level: z.number().int().min(0).max(2).default(0),

  // ── Models ──
  /** Directory for ONNX model files. Default: ~/.reflectworld/models/ */
  models_dir: z.string().optional(),
  /** Enable experimental body ReID + pose filtering. Resolved only from REFLECTWORLD_BODY_REID_ENABLED. */
  body_reid_enabled: z.boolean().default(false),

  // ── STT ──
  /** STT provider: "moonshine" (local, no diarization), "elevenlabs" (cloud, with diarization), or "" (disabled). */
  stt_provider: z.enum(["moonshine", "elevenlabs", ""]).default(""),
  /** Path to Moonshine Tiny model directory (only used when stt_provider=moonshine). */
  stt_model_dir: z.string().default(""),
  /** Number of CPU threads for STT inference (only used when stt_provider=moonshine). */
  stt_num_threads: z.number().min(1).default(1),
  /** ElevenLabs API key (only used when stt_provider=elevenlabs). */
  elevenlabs_api_key: z.string().default(""),
  /** ElevenLabs model identifier (only used when stt_provider=elevenlabs). Default: "scribe_v1". */
  elevenlabs_model_id: z.string().default("scribe_v1"),
  /** Optional ElevenLabs language code (e.g. "en"). Empty = auto-detect. */
  elevenlabs_language_code: z.string().default(""),

  // ── Profiling ──
  /** Enable performance profiling trace collection. */
  profiling_enabled: z.boolean().default(true),
});

export type PerceptionConfig = z.infer<typeof PerceptionConfigSchema>;

/**
 * Resolves and validates the perception config.
 * Merges explicit `raw` overrides on top of environment variable defaults.
 * body_reid_enabled is intentionally env-only so runtime/API overrides cannot
 * accidentally change the legacy perception path.
 *
 * @throws {ZodError} if required fields are missing or values are invalid
 */
export function resolvePerceptionConfig(
  raw?: Record<string, unknown>,
): PerceptionConfig {
  const parseIntEnv = (name: string): number | undefined => {
    const rawValue = process.env[name];
    if (rawValue == null || rawValue.trim() === "") return undefined;
    const value = Number.parseInt(rawValue, 10);
    return Number.isFinite(value) ? value : undefined;
  };
  const envDefaults: Record<string, unknown> = {
    vlm_provider: process.env.VLM_PROVIDER,
    vlm_model: process.env.VLM_MODEL,
    vlm_model_lite: process.env.VLM_MODEL_LITE,
    vlm_api_key: process.env.VLM_API_KEY,
    vlm_base_url: process.env.VLM_BASE_URL,
    llm_model: process.env.LLM_MODEL,
    vlm_request_timeout_ms: parseIntEnv("VLM_REQUEST_TIMEOUT_MS"),
    vlm_max_retries: parseIntEnv("VLM_MAX_RETRIES"),
    vlm_retry_base_delay_ms: parseIntEnv("VLM_RETRY_BASE_DELAY_MS"),
    vlm_retry_max_delay_ms: parseIntEnv("VLM_RETRY_MAX_DELAY_MS"),
    source_concurrency: parseIntEnv("REFLECTWORLD_PERCEPTION_SOURCE_CONCURRENCY"),
    max_queued_per_source: parseIntEnv("REFLECTWORLD_PERCEPTION_MAX_QUEUED_PER_SOURCE"),
    live_backlog_skip_after_ms: parseIntEnv("REFLECTWORLD_PERCEPTION_LIVE_BACKLOG_SKIP_AFTER_MS"),
    required_level: parseIntEnv("REFLECTWORLD_PERCEPTION_REQUIRED_LEVEL"),
    local_file_pacing: process.env.REFLECTWORLD_LOCAL_FILE_PACING,
    runtime_mode: process.env.REFLECTWORLD_PERCEPTION_RUNTIME_MODE,
    reflectworld_endpoint: process.env.REFLECTWORLD_ENDPOINT,
    working_memory_event_timeout_sec: parseIntEnv("WORKING_MEMORY_EVENT_TIMEOUT_SEC"),
    working_memory_max_event_segments: parseIntEnv("WORKING_MEMORY_MAX_EVENT_SEGMENTS"),
    models_dir: expandHomePath(process.env.REFLECTWORLD_MODELS_DIR),
    stubs_only: process.env.STUBS_ONLY === "false" ? false : undefined,
    scene_description: process.env.SCENE_DESCRIPTION,
    stt_provider: process.env.STT_PROVIDER,
    stt_model_dir: expandHomePath(process.env.STT_MODEL_DIR),
    stt_num_threads: parseIntEnv("STT_NUM_THREADS"),
    elevenlabs_api_key: process.env.ELEVENLABS_API_KEY,
    elevenlabs_model_id: process.env.ELEVENLABS_MODEL_ID,
    elevenlabs_language_code: process.env.ELEVENLABS_LANGUAGE_CODE,
  };

  // Filter out undefined env vars so they don't shadow Zod defaults.
  const filteredEnv = Object.fromEntries(
    Object.entries(envDefaults).filter(([, v]) => v !== undefined),
  );

  const merged: Record<string, unknown> = {
    ...filteredEnv,
    ...normalizeRawSecrets(raw),
    // body_reid_enabled is env-only: runtime/API overrides cannot change the legacy perception path.
    body_reid_enabled: process.env.REFLECTWORLD_BODY_REID_ENABLED === "true",
  };

  // Auto-infer stt_provider from stt_model_dir for backward compatibility:
  // Only when stt_provider key is completely absent (undefined). An explicit empty string
  // (STT_PROVIDER= or stt_provider:"") means "disabled" and must NOT be overridden.
  if (merged.stt_provider === undefined && merged.stt_model_dir) {
    merged.stt_provider = "moonshine";
  }

  return PerceptionConfigSchema.parse(merged);
}
