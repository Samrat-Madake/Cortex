export interface ConfigureAnswers {
  vlm_provider: string;
  vlm_model: string;
  vlm_model_lite?: string;
  vlm_api_key: string;
  vlm_base_url: string;
  llm_model: string;
  embedderSameGateway: boolean;
  embedder_provider?: string;
  embedder_model?: string;
  embedder_api_key?: string;
  embedder_base_url?: string;
  embedding_dims?: number;
  collection_name?: string;
  stt: "off" | "moonshine" | "elevenlabs";
  stt_model_dir?: string;
  elevenlabs_api_key?: string;
}

const PERCEPTION_PREFIX = "plugins.entries.cortex.config.perception.";
const MEMORY_PREFIX = "plugins.entries.cortex.config.memory.";
const EMBEDDING_DIMS_PATH = `${MEMORY_PREFIX}embedding_dims`;

export function defaultVlmModelLite(provider: string, vlmModel: string): string {
  return provider === "gemini" ? vlmModel : "gpt-5-mini";
}

export function defaultLlmModel(provider: string, vlmModel: string): string {
  return provider === "gemini" ? vlmModel : "gpt-5-mini";
}

export function mustUseIndependentEmbedder(provider: string): boolean {
  return provider === "gemini";
}

export function assertSupportedEmbedderProvider(provider: string): void {
  if (provider !== "openai") {
    throw new Error(`Unsupported embedder provider: ${provider}. Use provider "openai" with a custom base URL for OpenAI-compatible embedding services.`);
  }
}

export function looksLikeNonDefaultEmbedder(model: string | undefined, dims: number | undefined): boolean {
  return Boolean(model && model !== "text-embedding-3-small") || (dims !== undefined && dims !== 1536);
}

export function parsePositiveIntegerInput(raw: string, label: string): number {
  const trimmed = raw.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) throw new Error(`Invalid ${label}: ${raw}`);
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid ${label}: ${raw}`);
  return value;
}

export function configSetValue(path: string, value: string): string {
  if (path === EMBEDDING_DIMS_PATH) return value;
  return JSON.stringify(value);
}

/** Returns an ordered list of [dotPath, value] pairs to feed `openclaw config set`. */
export function buildConfigSetArgs(answers: ConfigureAnswers): Array<[string, string]> {
  if (mustUseIndependentEmbedder(answers.vlm_provider) && answers.embedderSameGateway) {
    throw new Error("Gemini VLM configuration requires an independent OpenAI-compatible embedder.");
  }

  const out: Array<[string, string]> = [];
  out.push([`${PERCEPTION_PREFIX}vlm_provider`, answers.vlm_provider]);
  out.push([`${PERCEPTION_PREFIX}vlm_model`, answers.vlm_model]);
  out.push([`${PERCEPTION_PREFIX}vlm_model_lite`, answers.vlm_model_lite || defaultVlmModelLite(answers.vlm_provider, answers.vlm_model)]);
  out.push([`${PERCEPTION_PREFIX}vlm_api_key`, answers.vlm_api_key]);

  const baseUrl = answers.vlm_base_url || (answers.vlm_provider === "openai" ? "https://api.openai.com/v1" : "");
  if (baseUrl) out.push([`${PERCEPTION_PREFIX}vlm_base_url`, baseUrl]);
  out.push([`${PERCEPTION_PREFIX}llm_model`, answers.llm_model]);

  if (!answers.embedderSameGateway) {
    const embedderProvider = answers.embedder_provider || "openai";
    assertSupportedEmbedderProvider(embedderProvider);
    out.push([`${MEMORY_PREFIX}embedder_provider`, embedderProvider]);
    if (answers.embedder_model) out.push([`${MEMORY_PREFIX}embedder_model`, answers.embedder_model]);
    if (answers.embedder_api_key) out.push([`${MEMORY_PREFIX}embedder_api_key`, answers.embedder_api_key]);
    const embedderBaseUrl = answers.embedder_base_url || "https://api.openai.com/v1";
    if (embedderBaseUrl) out.push([`${MEMORY_PREFIX}embedder_base_url`, embedderBaseUrl]);
    if (answers.embedding_dims !== undefined) out.push([`${MEMORY_PREFIX}embedding_dims`, String(answers.embedding_dims)]);
    if (answers.collection_name) out.push([`${MEMORY_PREFIX}collection_name`, answers.collection_name]);
  }

  out.push([`${PERCEPTION_PREFIX}stt_provider`, answers.stt === "off" ? "" : answers.stt]);
  if (answers.stt === "moonshine" && answers.stt_model_dir) {
    out.push([`${PERCEPTION_PREFIX}stt_model_dir`, answers.stt_model_dir]);
  }
  if (answers.stt === "elevenlabs" && answers.elevenlabs_api_key) {
    out.push([`${PERCEPTION_PREFIX}elevenlabs_api_key`, answers.elevenlabs_api_key]);
  }

  return out;
}
