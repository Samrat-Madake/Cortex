import { normalizeSecretInput } from "@cortex/shared";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PERCEPTION_ENV_MAP: Record<string, string> = {
  vlm_provider: "VLM_PROVIDER",
  vlm_model: "VLM_MODEL",
  vlm_model_lite: "VLM_MODEL_LITE",
  vlm_api_key: "VLM_API_KEY",
  vlm_base_url: "VLM_BASE_URL",
  llm_model: "LLM_MODEL",
  vlm_request_timeout_ms: "VLM_REQUEST_TIMEOUT_MS",
  vlm_max_retries: "VLM_MAX_RETRIES",
  vlm_retry_base_delay_ms: "VLM_RETRY_BASE_DELAY_MS",
  vlm_retry_max_delay_ms: "VLM_RETRY_MAX_DELAY_MS",
  source_concurrency: "CORTEX_PERCEPTION_SOURCE_CONCURRENCY",
  max_queued_per_source: "CORTEX_PERCEPTION_MAX_QUEUED_PER_SOURCE",
  live_backlog_skip_after_ms: "CORTEX_PERCEPTION_LIVE_BACKLOG_SKIP_AFTER_MS",
  local_file_pacing: "CORTEX_LOCAL_FILE_PACING",
  runtime_mode: "CORTEX_PERCEPTION_RUNTIME_MODE",
  working_memory_event_timeout_sec: "WORKING_MEMORY_EVENT_TIMEOUT_SEC",
  working_memory_max_event_segments: "WORKING_MEMORY_MAX_EVENT_SEGMENTS",
  stubs_only: "STUBS_ONLY",
  required_level: "CORTEX_PERCEPTION_REQUIRED_LEVEL",
  models_dir: "CORTEX_MODELS_DIR",
  scene_description: "SCENE_DESCRIPTION",
  stt_provider: "STT_PROVIDER",
  stt_model_dir: "STT_MODEL_DIR",
  stt_num_threads: "STT_NUM_THREADS",
  elevenlabs_api_key: "ELEVENLABS_API_KEY",
  elevenlabs_model_id: "ELEVENLABS_MODEL_ID",
  elevenlabs_language_code: "ELEVENLABS_LANGUAGE_CODE",
};

const MEMORY_ENV_MAP: Record<string, string> = {
  embedder_provider: "EMBEDDER_PROVIDER",
  embedder_model: "EMBEDDER_MODEL",
  embedder_api_key: "EMBEDDER_API_KEY",
  embedder_base_url: "EMBEDDER_BASE_URL",
  embedding_dims: "EMBEDDING_DIMS",
  llm_provider: "LLM_PROVIDER",
  llm_api_key: "LLM_API_KEY",
  llm_base_url: "LLM_BASE_URL",
};

const SECRET_FIELDS = new Set([
  "vlm_api_key",
  "elevenlabs_api_key",
  "embedder_api_key",
  "llm_api_key",
]);

function applyEnvMap(src: Record<string, unknown> | undefined, map: Record<string, string>): Record<string, unknown> | undefined {
  if (!src) return undefined;
  const sanitized = { ...src };
  for (const [key, envName] of Object.entries(map)) {
    const raw = src[key];
    if (raw === undefined || raw === null) continue;
    if (SECRET_FIELDS.has(key)) {
      const value = normalizeSecretInput(raw, "cortex");
      if (value !== undefined) {
        process.env[envName] = value;
        sanitized[key] = value;
      } else {
        delete sanitized[key];
      }
      continue;
    }
    process.env[envName] = String(raw);
  }
  return sanitized;
}

/**
 * Single bridge point from all-in-one pluginConfig to process.env.
 *
 * TS perception receives pluginConfig too, while Python mem only sees env via
 * CortexService.envVars(); writing configured fields here keeps both paths aligned.
 * SecretInput fields are also normalized in the returned config so SecretRef
 * objects do not override the resolved env strings during zod parsing.
 * memory.collection_name is intentionally excluded because it already flows through
 * index.ts -> CortexService -> COLLECTION_PREFIX.
 */
export function bridgePluginConfigToEnv(config: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...config };
  const perception = isRecord(config.perception) ? applyEnvMap(config.perception, PERCEPTION_ENV_MAP) : undefined;
  const memory = isRecord(config.memory) ? applyEnvMap(config.memory, MEMORY_ENV_MAP) : undefined;
  if (perception) sanitized.perception = perception;
  if (memory) sanitized.memory = memory;
  return sanitized;
}
