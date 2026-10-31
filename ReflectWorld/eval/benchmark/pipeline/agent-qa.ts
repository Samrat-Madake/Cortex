// eval/benchmark/pipeline/agent-qa.ts
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLlmCallId,
  mergeLlmCallContext,
  normalizeTokenUsage,
  type LlmCallContext,
  type LlmCallRecord,
  type LlmTokenUsage,
} from "@reflectworld/shared";
import { resolveFfmpegBin } from "@reflectworld/cam";
import {
  ReflectWorldClient,
  flattenSearchResults,
  flattenMemoriesResponse,
} from "@reflectworld/mem";
// MemoryType import removed — agent-qa uses `as any` casts since tool schemas
// expose group aliases (episodic, semantic) alongside specific collection names.
import {
  buildCandidateQueries,
  rewriteMemorySearchQueryForSemanticSearch,
} from "./agent-qa-plan.js";
import {
  buildRelatedTraceContext,
  isEpisodicEntityMemory,
  isEpisodicSchemaMemory,
  isSemanticEntityMemory,
} from "./agent-qa-related-context.js";
import type { AgentQATrace, BenchmarkQuestion, QAResult, ToolCallRecord } from "./types.js";
import type { VideoFrameSource } from "./video-frame-source.js";
const TOOL_MAX_RETRIES = Math.max(
  0,
  Number.parseInt(process.env.BENCH_TOOL_MAX_RETRIES ?? "2", 10) || 2,
);
const TOOL_RETRY_BASE_DELAY_MS = Math.max(
  0,
  Number.parseInt(process.env.BENCH_TOOL_RETRY_BASE_DELAY_MS ?? "800", 10) || 800,
);
const TOOL_RETRY_MAX_DELAY_MS = Math.max(
  TOOL_RETRY_BASE_DELAY_MS,
  Number.parseInt(process.env.BENCH_TOOL_RETRY_MAX_DELAY_MS ?? "5000", 10) || 5000,
);
const AGENT_REQUEST_TIMEOUT_MS = 90_000;
const AGENT_MAX_RETRIES = 2;
const AGENT_RETRY_BASE_DELAY_MS = 3000;
const AGENT_RETRY_MAX_DELAY_MS = 30_000;
const MAX_VISUAL_EVIDENCE_IMAGES = Math.max(
  1,
  Math.min(30, Number.parseInt(process.env.BENCH_AGENT_QA_MAX_VISUAL_IMAGES ?? "30", 10) || 30),
);
const MAX_RELATED_TRACE_CONTEXT = 5;
const RELATED_TRACE_FETCH_LIMIT = Math.max(
  20,
  Math.min(200, Number.parseInt(process.env.BENCH_AGENT_QA_RELATED_TRACE_FETCH_LIMIT ?? "120", 10) || 120),
);
const AGENT_QA_LENGTH_FALLBACK_MAX_TOKENS = 6000;
const AGENT_QA_OUTPUT_RETRY_MIN_MAX_TOKENS = Math.max(
  AGENT_QA_LENGTH_FALLBACK_MAX_TOKENS,
  Number.parseInt(process.env.BENCH_AGENT_QA_OUTPUT_RETRY_MIN_MAX_TOKENS ?? "6000", 10) || 6000,
);
const TOOL_CONTEXT_SOURCE_MAX_CHARS = Math.max(
  4_000,
  Math.min(30_000, Number.parseInt(process.env.BENCH_AGENT_QA_TOOL_CONTEXT_SOURCE_MAX_CHARS ?? "15000", 10) || 15_000),
);
const OPENAI_GPT5_FAMILY_RE = /(?:^|\/)gpt-5(?:$|[-.])/i;
const OPENAI_GPT5_MINI_RE = /(?:^|\/)gpt-5(?:\.\d+)?-mini(?:$|-)/i;

const TRACE_MAX_STRING = Math.max(
  500,
  Number.parseInt(process.env.BENCH_QA_TRACE_MAX_STRING ?? "4000", 10) || 4000,
);
const TRACE_MAX_ARRAY_ITEMS = Math.max(
  3,
  Number.parseInt(process.env.BENCH_QA_TRACE_MAX_ARRAY_ITEMS ?? "20", 10) || 20,
);
const TRACE_MAX_DEPTH = Math.max(
  2,
  Number.parseInt(process.env.BENCH_QA_TRACE_MAX_DEPTH ?? "5", 10) || 5,
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncateTraceString(text: string): string {
  if (text.startsWith("data:image/")) {
    return `[image data omitted; ${text.length} chars]`;
  }
  if (text.length <= TRACE_MAX_STRING) return text;
  return `${text.slice(0, TRACE_MAX_STRING)}...[truncated ${text.length - TRACE_MAX_STRING} chars]`;
}

function sanitizeForTrace(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "string") return truncateTraceString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= TRACE_MAX_DEPTH) return `[max depth reached: ${typeof value}]`;
  if (Array.isArray(value)) {
    const items = value.slice(0, TRACE_MAX_ARRAY_ITEMS).map((item) => sanitizeForTrace(item, depth + 1));
    if (value.length > TRACE_MAX_ARRAY_ITEMS) {
      items.push(`[truncated ${value.length - TRACE_MAX_ARRAY_ITEMS} items]`);
    }
    return items;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (key === "image_url" || key === "image_urls") {
        out[key] = Array.isArray(raw)
          ? `[${raw.length} image data item(s) omitted]`
          : typeof raw === "string"
            ? truncateTraceString(raw)
            : "[image data omitted]";
      } else {
        out[key] = sanitizeForTrace(raw, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

function sanitizeToolResultForArtifact(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    return value.startsWith("data:image/")
      ? `[image data omitted; ${value.length} chars]`
      : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 20) return `[max depth reached: ${typeof value}]`;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeToolResultForArtifact(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (key === "image_url" || key === "image_urls") {
        out[key] = Array.isArray(raw)
          ? `[${raw.length} image data item(s) omitted]`
          : typeof raw === "string"
            ? sanitizeToolResultForArtifact(raw, depth + 1)
            : "[image data omitted]";
      } else {
        out[key] = sanitizeToolResultForArtifact(raw, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

function getErrorStatusCode(err: unknown): number | null {
  const raw = (err as { statusCode?: unknown })?.statusCode;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const msg = toErrorMessage(err);
  const match = msg.match(/\b(4\d\d|5\d\d)\b/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1]!, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRetryableMemError(err: unknown): boolean {
  const code = getErrorStatusCode(err);
  if (code != null) {
    return [0, 408, 409, 425, 429, 500, 502, 503, 504].includes(code);
  }
  const msg = toErrorMessage(err).toLowerCase();
  if (msg.includes("network error")) return true;
  if (msg.includes("timed out") || msg.includes("timeout")) return true;
  if (msg.includes("econn") || msg.includes("socket")) return true;
  if (msg.includes("temporar")) return true;
  return false;
}

function retryDelayMs(attempt: number): number {
  const exp = Math.min(8, Math.max(0, attempt));
  const delay = Math.min(TOOL_RETRY_MAX_DELAY_MS, TOOL_RETRY_BASE_DELAY_MS * (2 ** exp));
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(delay * 0.2)));
  return delay + jitter;
}

function agentRetryDelayMs(attempt: number): number {
  const exp = Math.min(8, Math.max(0, attempt));
  const delay = Math.min(AGENT_RETRY_MAX_DELAY_MS, AGENT_RETRY_BASE_DELAY_MS * (2 ** exp));
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(delay * 0.2)));
  return delay + jitter;
}

function isRetryableHttpStatus(status: number): boolean {
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(status);
}

type AgentHttpResponse = {
  ok: boolean;
  status: number;
  bodyText: string;
};

function isNonRetryableQuotaResponse(response: AgentHttpResponse): boolean {
  if (response.status !== 429) return false;
  const lower = response.bodyText.toLowerCase();
  return lower.includes("insufficient_quota") || lower.includes("exceeded your current quota");
}

function isNonRetryableQuotaErrorMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("insufficient_quota") || lower.includes("exceeded your current quota");
}

export function chatCompletionControls(
  model: string | undefined,
  maxTokens: number,
  temperature?: number,
  reasoningEffort?: ReasoningEffort,
): {
  max_completion_tokens?: number;
  max_tokens?: number;
  reasoning_effort?: ReasoningEffort;
  temperature?: number;
} {
  const isGpt5 = isOpenAIReasoningModel(model);
  return {
    ...(isGpt5
      ? { max_completion_tokens: maxTokens }
      : { max_tokens: maxTokens }),
    ...(reasoningEffort == null ? {} : { reasoning_effort: reasoningEffort }),
    ...(temperature == null || isGpt5 ? {} : { temperature }),
  };
}

export function isOpenAIReasoningModel(model: string | undefined): boolean {
  return OPENAI_GPT5_FAMILY_RE.test(model ?? "");
}

function isCompactReasoningModel(model: string | undefined): boolean {
  return OPENAI_GPT5_MINI_RE.test(model ?? "");
}

export function effectiveAgentMaxTokens(
  config: Pick<AgentConfig, "provider" | "model">,
  requestedMaxTokens: number,
  options: { json?: boolean; tools?: boolean },
): number {
  if (config.provider !== "openai" || !isOpenAIReasoningModel(config.model)) {
    return requestedMaxTokens;
  }
  if (!options.json && !options.tools) return requestedMaxTokens;
  return Math.max(requestedMaxTokens, AGENT_QA_OUTPUT_RETRY_MIN_MAX_TOKENS);
}

type AgentProvider = "openai" | "gemini";
type ReasoningEffort = "minimal" | "low" | "medium" | "high";

interface AgentConfig {
  provider: AgentProvider;
  apiBase: string;
  apiKey: string;
  model: string;
}

interface AgentToolCall {
  id: string;
  function: { name: string; arguments: string };
}

interface AgentMessageResult {
  content: string;
  tool_calls: AgentToolCall[];
  finish_reason?: string;
  usage?: unknown;
  request?: LlmCallRecord["request"];
  llm_call_id?: string;
  llm_latency_ms?: number;
  retry_count?: number;
}

type LlmCallRecorder = (call: LlmCallRecord) => void;

function buildOpenAIRequest(apiBase: string, apiKey: string): { url: string; headers: Record<string, string> } {
  return {
    url: `${apiBase.replace(/\/$/, "")}/chat/completions`,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
  };
}

function buildGeminiRequest(model: string, apiKey: string): { url: string; headers: Record<string, string> } {
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
  };
}

function imageUrlToGeminiPart(url: string): Record<string, unknown> {
  const match = url.match(/^data:([^;]+);base64,(.*)$/);
  if (!match) return { text: `[image omitted: unsupported URL ${url.slice(0, 80)}]` };
  return { inline_data: { mime_type: match[1], data: match[2] } };
}

function openAIContentToGeminiParts(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) return [{ text: JSON.stringify(content ?? "") }];
  const parts: Array<Record<string, unknown>> = [];
  for (const item of content as Array<Record<string, any>>) {
    if (item.type === "text") parts.push({ text: String(item.text ?? "") });
    else if (item.type === "image_url") parts.push(imageUrlToGeminiPart(String(item.image_url?.url ?? "")));
  }
  return parts.length ? parts : [{ text: "" }];
}

function normalizeAgentUsage(provider: AgentProvider, usage: unknown): LlmTokenUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const raw = usage as Record<string, any>;
  if (provider === "gemini") {
    return normalizeTokenUsage({
      prompt_tokens: raw.promptTokenCount,
      completion_tokens: raw.candidatesTokenCount,
      reasoning_tokens: raw.thoughtsTokenCount,
      total_tokens: raw.totalTokenCount,
    });
  }
  return normalizeTokenUsage({
    prompt_tokens: raw.prompt_tokens,
    completion_tokens: raw.completion_tokens,
    reasoning_tokens: raw.completion_tokens_details?.reasoning_tokens,
    total_tokens: raw.total_tokens,
  });
}

function countMessageImages(messages: Array<Record<string, unknown>>): number {
  let count = 0;
  for (const message of messages) {
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const item of content as Array<Record<string, any>>) {
      if (item?.type === "image_url" || item?.inline_data || item?.image_url) count += 1;
    }
  }
  return count;
}

function promptHashForMessages(messages: Array<Record<string, unknown>>): string {
  const sanitized = sanitizeForTrace(messages);
  return createHash("sha256").update(JSON.stringify(sanitized)).digest("hex").slice(0, 16);
}

function buildAgentRequestMeta(
  config: AgentConfig,
  messages: Array<Record<string, unknown>>,
  options: {
    tools?: boolean;
    json?: boolean;
    maxTokens: number;
    temperature?: number;
    reasoningEffort?: ReasoningEffort;
  },
): LlmCallRecord["request"] {
  const maxTokens = effectiveAgentMaxTokens(config, options.maxTokens, options);
  const imageCount = countMessageImages(messages);
  if (config.provider === "gemini") {
    return {
      response_format: options.json ? "json" : "text",
      max_output_tokens: maxTokens,
      ...(options.temperature == null ? {} : { temperature: options.temperature }),
      ...(imageCount > 0 ? { image_count: imageCount } : {}),
      prompt_hash: promptHashForMessages(messages),
    };
  }

  const controls = chatCompletionControls(config.model, maxTokens, options.temperature, options.reasoningEffort);
  return {
    response_format: options.json ? "json" : "text",
    ...(typeof controls.max_tokens === "number" ? { max_tokens: controls.max_tokens } : {}),
    ...(typeof controls.max_completion_tokens === "number"
      ? { max_completion_tokens: controls.max_completion_tokens }
      : {}),
    ...(typeof controls.temperature === "number" ? { temperature: controls.temperature } : {}),
    ...(typeof controls.reasoning_effort === "string" ? { reasoning_effort: controls.reasoning_effort } : {}),
    ...(imageCount > 0 ? { image_count: imageCount } : {}),
    prompt_hash: promptHashForMessages(messages),
  };
}

function recordAgentLlmCall(params: {
  config: AgentConfig;
  stage: string;
  promptVersion?: string;
  llmContext?: LlmCallContext;
  llmCallRecorder?: LlmCallRecorder;
  request: LlmCallRecord["request"];
  usage?: unknown;
  startedAt: number;
  status: "ok" | "error";
  retryCount: number;
  error?: string | null;
}): LlmCallRecord {
  const call = mergeLlmCallContext({
    schema_version: 1,
    call_id: createLlmCallId("qa_llm"),
    stage: params.stage,
    provider: params.config.provider,
    model: params.config.model,
    prompt_version: params.promptVersion,
    request: params.request,
    usage: normalizeAgentUsage(params.config.provider, params.usage),
    latency_ms: Date.now() - params.startedAt,
    status: params.status,
    retry_count: params.retryCount,
    error: params.error ?? null,
    created_at: new Date(params.startedAt).toISOString(),
  }, params.llmContext ?? {});
  try {
    params.llmCallRecorder?.(call);
  } catch (err) {
    console.warn(`[agent-qa] LLM call recorder failed: ${toErrorMessage(err)}`);
  }
  return call;
}

function toGeminiContents(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const contents: Array<Record<string, unknown>> = [];
  const toolNamesById = new Map<string, string>();
  let pendingSystem = "";

  for (const message of messages) {
    const role = String(message.role ?? "user");
    if (role === "system") {
      pendingSystem += `${pendingSystem ? "\n\n" : ""}${String(message.content ?? "")}`;
      continue;
    }

    if (role === "assistant") {
      const parts: Array<Record<string, unknown>> = [];
      const content = typeof message.content === "string" ? message.content : "";
      if (content.trim()) parts.push({ text: content });
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls as AgentToolCall[] : [];
      for (const call of toolCalls) {
        toolNamesById.set(call.id, call.function.name);
        let args: unknown = {};
        try { args = JSON.parse(call.function.arguments || "{}"); } catch { args = {}; }
        parts.push({ functionCall: { name: call.function.name, args } });
      }
      if (parts.length) contents.push({ role: "model", parts });
      continue;
    }

    if (role === "tool") {
      const id = String(message.tool_call_id ?? "");
      const name = toolNamesById.get(id) ?? "tool_result";
      let response: unknown = message.content;
      if (typeof response === "string") {
        try { response = JSON.parse(response); } catch { response = { text: response }; }
      }
      contents.push({ role: "user", parts: [{ functionResponse: { name, response } }] });
      continue;
    }

    const parts = openAIContentToGeminiParts(message.content);
    if (pendingSystem) {
      const firstText = parts.find((part) => typeof part.text === "string");
      if (firstText) firstText.text = `${pendingSystem}\n\n${firstText.text}`;
      else parts.unshift({ text: pendingSystem });
      pendingSystem = "";
    }
    contents.push({ role: "user", parts });
  }

  if (pendingSystem) contents.unshift({ role: "user", parts: [{ text: pendingSystem }] });
  return contents;
}

function toGeminiTools(): Array<Record<string, unknown>> {
  return [{
    functionDeclarations: TOOL_DEFS.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    })),
  }];
}

function parseGeminiMessage(json: any): AgentMessageResult {
  const candidate = json?.candidates?.[0] ?? {};
  const parts = candidate?.content?.parts ?? [];
  const content: string[] = [];
  const toolCalls: AgentToolCall[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? {};
    if (typeof part.text === "string") content.push(part.text);
    const fc = part.functionCall ?? part.function_call;
    if (fc?.name) {
      toolCalls.push({
        id: `gemini_tool_${Date.now()}_${i}`,
        function: { name: String(fc.name), arguments: JSON.stringify(fc.args ?? {}) },
      });
    }
  }
  return {
    content: content.join("\n").trim(),
    tool_calls: toolCalls,
    finish_reason: typeof candidate.finishReason === "string" ? candidate.finishReason : undefined,
    usage: json?.usageMetadata,
  };
}

async function postAgentMessage(
  config: AgentConfig,
  messages: Array<Record<string, unknown>>,
  options: {
    tools?: boolean;
    requireTool?: boolean;
    json?: boolean;
    maxTokens: number;
    temperature?: number;
    reasoningEffort?: ReasoningEffort;
    opName?: string;
    stage?: string;
    promptVersion?: string;
    llmContext?: LlmCallContext;
    llmCallRecorder?: LlmCallRecorder;
  },
): Promise<AgentMessageResult> {
  const startedAt = Date.now();
  const maxTokens = effectiveAgentMaxTokens(config, options.maxTokens, options);
  const requestMeta = buildAgentRequestMeta(config, messages, { ...options, maxTokens });
  const stage = options.stage ?? options.opName ?? "qa.agent";
  if (config.provider === "openai") {
    const { url, headers } = buildOpenAIRequest(config.apiBase, config.apiKey);
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      ...chatCompletionControls(config.model, maxTokens, options.temperature, options.reasoningEffort),
    };
    if (options.json) body.response_format = { type: "json_object" };
    if (options.tools) {
      body.tools = TOOL_DEFS;
      body.tool_choice = options.requireTool ? "required" : "auto";
    }
    let resp: AgentHttpResponse;
    let retryCount = 0;
    try {
      const posted = await postChatCompletions(url, headers, body, AGENT_REQUEST_TIMEOUT_MS, options.opName ?? "agent chat");
      resp = posted.response;
      retryCount = posted.retryCount;
    } catch (err) {
      recordAgentLlmCall({
        config,
        stage,
        promptVersion: options.promptVersion,
        llmContext: options.llmContext,
        llmCallRecorder: options.llmCallRecorder,
        request: requestMeta,
        startedAt,
        status: "error",
        retryCount: AGENT_MAX_RETRIES,
        error: toErrorMessage(err),
      });
      throw err;
    }
    if (!resp.ok) {
      recordAgentLlmCall({
        config,
        stage,
        promptVersion: options.promptVersion,
        llmContext: options.llmContext,
        llmCallRecorder: options.llmCallRecorder,
        request: requestMeta,
        startedAt,
        status: "error",
        retryCount,
        error: `agent API ${resp.status}: ${resp.bodyText.slice(0, 500)}`,
      });
      throw new Error(`agent API ${resp.status}: ${resp.bodyText.slice(0, 500)}`);
    }
    let json: {
      choices?: Array<{
        finish_reason?: string;
        message?: { content?: string; tool_calls?: AgentToolCall[] };
      }>;
      usage?: unknown;
    };
    try {
      json = JSON.parse(resp.bodyText) as typeof json;
    } catch (err) {
      recordAgentLlmCall({
        config,
        stage,
        promptVersion: options.promptVersion,
        llmContext: options.llmContext,
        llmCallRecorder: options.llmCallRecorder,
        request: requestMeta,
        startedAt,
        status: "error",
        retryCount,
        error: `agent API returned invalid JSON: ${toErrorMessage(err)}`,
      });
      throw err;
    }
    const choice = json.choices?.[0];
    const message = choice?.message;
    if (!message) {
      recordAgentLlmCall({
        config,
        stage,
        promptVersion: options.promptVersion,
        llmContext: options.llmContext,
        llmCallRecorder: options.llmCallRecorder,
        request: requestMeta,
        usage: json.usage,
        startedAt,
        status: "error",
        retryCount,
        error: "agent API returned no choice",
      });
      throw new Error("agent API returned no choice");
    }
    const call = recordAgentLlmCall({
      config,
      stage,
      promptVersion: options.promptVersion,
      llmContext: options.llmContext,
      llmCallRecorder: options.llmCallRecorder,
      request: requestMeta,
      usage: json.usage,
      startedAt,
      status: "ok",
      retryCount,
      error: null,
    });
    return {
      content: message.content ?? "",
      tool_calls: message.tool_calls ?? [],
      finish_reason: choice?.finish_reason,
      usage: json.usage,
      request: requestMeta,
      llm_call_id: call.call_id,
      llm_latency_ms: call.latency_ms,
      retry_count: retryCount,
    };
  }

  const { url, headers } = buildGeminiRequest(config.model, config.apiKey);
  const body: Record<string, unknown> = {
    contents: toGeminiContents(messages),
    generationConfig: {
      maxOutputTokens: maxTokens,
      ...(options.temperature == null ? {} : { temperature: options.temperature }),
      ...(options.json ? { responseMimeType: "application/json" } : {}),
    },
  };
  if (options.tools) {
    body.tools = toGeminiTools();
    body.toolConfig = { functionCallingConfig: { mode: options.requireTool ? "ANY" : "AUTO" } };
  }
  let resp: AgentHttpResponse;
  let retryCount = 0;
  try {
    const posted = await postChatCompletions(url, headers, body, AGENT_REQUEST_TIMEOUT_MS, options.opName ?? "gemini agent");
    resp = posted.response;
    retryCount = posted.retryCount;
  } catch (err) {
    recordAgentLlmCall({
      config,
      stage,
      promptVersion: options.promptVersion,
      llmContext: options.llmContext,
      llmCallRecorder: options.llmCallRecorder,
      request: requestMeta,
      startedAt,
      status: "error",
      retryCount: AGENT_MAX_RETRIES,
      error: toErrorMessage(err),
    });
    throw err;
  }
  if (!resp.ok) {
    recordAgentLlmCall({
      config,
      stage,
      promptVersion: options.promptVersion,
      llmContext: options.llmContext,
      llmCallRecorder: options.llmCallRecorder,
      request: requestMeta,
      startedAt,
      status: "error",
      retryCount,
      error: `gemini API ${resp.status}: ${resp.bodyText.slice(0, 500)}`,
    });
    throw new Error(`gemini API ${resp.status}: ${resp.bodyText.slice(0, 500)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(resp.bodyText);
  } catch (err) {
    recordAgentLlmCall({
      config,
      stage,
      promptVersion: options.promptVersion,
      llmContext: options.llmContext,
      llmCallRecorder: options.llmCallRecorder,
      request: requestMeta,
      startedAt,
      status: "error",
      retryCount,
      error: `gemini API returned invalid JSON: ${toErrorMessage(err)}`,
    });
    throw err;
  }
  const parsed = parseGeminiMessage(json);
  const call = recordAgentLlmCall({
    config,
    stage,
    promptVersion: options.promptVersion,
    llmContext: options.llmContext,
    llmCallRecorder: options.llmCallRecorder,
    request: requestMeta,
    usage: parsed.usage,
    startedAt,
    status: "ok",
    retryCount,
    error: null,
  });
  return {
    ...parsed,
    request: requestMeta,
    llm_call_id: call.call_id,
    llm_latency_ms: call.latency_ms,
    retry_count: retryCount,
  };
}

async function postAgentMessageWithLengthFallback(
  config: AgentConfig,
  messages: Array<Record<string, unknown>>,
  options: {
    tools?: boolean;
    requireTool?: boolean;
    json?: boolean;
    maxTokens: number;
    fallbackMaxTokens: number;
    temperature?: number;
    reasoningEffort?: ReasoningEffort;
    opName?: string;
    fallbackOpName?: string;
    stage?: string;
    fallbackStage?: string;
    promptVersion?: string;
    llmContext?: LlmCallContext;
    llmCallRecorder?: LlmCallRecorder;
  },
): Promise<AgentMessageResult> {
  const first = await postAgentMessage(config, messages, {
    tools: options.tools,
    requireTool: options.requireTool,
    json: options.json,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    reasoningEffort: options.reasoningEffort,
    opName: options.opName,
    stage: options.stage,
    promptVersion: options.promptVersion,
    llmContext: options.llmContext,
    llmCallRecorder: options.llmCallRecorder,
  });
  if (
    !isLengthFinishReason(first.finish_reason)
    && (first.content.trim() || first.tool_calls.length > 0)
  ) {
    return first;
  }
  return postAgentMessage(config, messages, {
    tools: options.tools,
    requireTool: options.requireTool,
    json: options.json,
    maxTokens: options.fallbackMaxTokens,
    temperature: options.temperature,
    reasoningEffort: options.reasoningEffort,
    opName: options.fallbackOpName ?? `${options.opName ?? "agent message"} fallback`,
    stage: options.fallbackStage ?? `${options.stage ?? "qa.agent"}_fallback`,
    promptVersion: options.promptVersion,
    llmContext: options.llmContext,
    llmCallRecorder: options.llmCallRecorder,
  });
}

async function withMemRetry<T>(opName: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt <= TOOL_MAX_RETRIES; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= TOOL_MAX_RETRIES || !isRetryableMemError(err)) {
        throw err;
      }
      const delay = retryDelayMs(attempt);
      console.error(
        `[agent-qa] ${opName} attempt ${attempt + 1}/${TOOL_MAX_RETRIES + 1} failed, retrying in ${delay}ms: ${toErrorMessage(err)}`,
      );
      await sleep(delay);
    }
  }
  throw new Error(`[agent-qa] unreachable retry state for ${opName}`);
}

const TOOL_DEFS = [
  {
    type: "function" as const,
    function: {
      name: "reflectworld_memory_search",
      description:
        "Semantic search over a selected memory collection. Use it to locate candidate segments, people, topics, speech, or events by meaning. Results are relevance-ranked, not time-ordered; use memory_get for segment drilldown, neighboring context, or time-ordered reads. For visible facts, use search to find the segment_id, then verify with view_visual_evidence.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Short English query phrased like stored memory text, not the full benchmark question." },
          entity_id: {
            type: "string",
            description: "Optional local entity_id filter. Use only as one candidate expansion axis; do not assume entity_id is a stable global person identity.",
          },
          verification_slot: {
            type: "string",
            description: "Optional evidence slot this query is meant to verify, such as 'candidate A motive' or 'object picked up after box opens'.",
          },
          candidate: {
            type: "string",
            description: "Optional candidate label this query helps verify, such as A, B, C, or D.",
          },
          memory_type: {
            type: "string",
            enum: ["episodic_trace", "episodic_entity", "episodic_schema", "semantic_entity", "semantic_context", "episodic", "semantic"],
            description: "Memory collection to search. episodic_trace = segment facts; episodic_entity = entity observations; episodic_schema = coarse event summaries; semantic_entity = entity/topic profiles; semantic_context = global scene/background context. Group aliases search multiple collections.",
          },
          limit: { type: "integer", description: "Max results (default 20)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "reflectworld_memory_get",
      description:
        "Deterministically fetch or list memory records. Use segment_id to expand one retrieved segment, around_segment_id to read neighboring episodic_trace context, or sort_order to read records in time order. This is for context expansion, order comparison, and exact lookup; it is not semantic search.",
      parameters: {
        type: "object",
        properties: {
          entity_id: { type: "string", description: "Filter by local entity_id when following an entity history." },
          segment_id: { type: "string", description: "Retrieve one episodic_trace segment by segment/video_id from a memory result." },
          around_segment_id: { type: "string", description: "Retrieve neighboring episodic_trace records around a segment/video_id from a memory result." },
          verification_slot: {
            type: "string",
            description: "Optional evidence slot this lookup is meant to verify.",
          },
          candidate: {
            type: "string",
            description: "Optional candidate label this lookup helps verify, such as A, B, C, or D.",
          },
          neighbor_window: { type: "integer", description: "Number of neighboring segments before and after around_segment_id. Default 3; capped at 5." },
          memory_type: {
            type: "string",
            enum: ["episodic_trace", "episodic_entity", "episodic_schema", "semantic_entity", "semantic_context", "procedural", "episodic", "semantic"],
            description: "Memory collection to query. Prefer specific collection names. Group aliases (episodic, semantic) query all sub-collections.",
          },
          limit: { type: "integer", description: "Max results" },
          sort_order: {
            type: "string",
            enum: ["asc", "desc"],
            description: "Time order for list results. asc = oldest-first/start of video; desc = newest-first/end of video.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "view_visual_evidence",
      description:
        "Direct visual observation for one retrieved memory segment. Use it after memory_search/memory_get has found a segment_id and the answer depends on visible evidence such as color, count, OCR, object appearance, held items, action, motion, layout, screen/scoreboard details, or conflicting text summaries. The final answer node receives images grouped with segment_id, time metadata, frame indexes, and per-frame timestamps. keyframe checks a static visible fact; video_segment checks motion, within-segment order, repeated events, or time-scoped counts. Do not pass memory_id values.",
      parameters: {
        type: "object",
        properties: {
          source: {
            type: "string",
            enum: ["keyframe", "video_segment"],
            description: "Visual evidence type to inspect.",
          },
          segment_id: {
            type: "string",
            description: "Segment/video_id from the memory record being verified.",
          },
          verification_slot: {
            type: "string",
            description: "Optional visual evidence slot to inspect, such as OCR text, object attribute, count, motion, or order.",
          },
          candidate: {
            type: "string",
            description: "Optional candidate label this visual check helps verify, such as A, B, C, or D.",
          },
          keyframe_path: {
            type: "string",
            description: "Absolute filesystem path to a keyframe image from visual_evidence.keyframes.",
          },
          video_path: {
            type: "string",
            description: "Absolute filesystem path to a segment video from visual_evidence.video_segments.",
          },
          start_sec: {
            type: "number",
            description: "Optional offset inside the segment video. Default 0.",
          },
          duration_sec: {
            type: "number",
            description: "Optional duration to inspect. Default 30; capped at 30.",
          },
        },
        required: ["source", "segment_id"],
      },
    },
  },
];

function memoryUserIdFor(cameraId: string, userId?: string): string {
  return userId?.trim() || cameraId;
}

function injectToolScope(params: Record<string, unknown>, cameraId: string): Record<string, unknown> {
  const scoped: Record<string, unknown> = { ...params, camera_id: cameraId };
  delete scoped.user_id;
  return scoped;
}

const OPTION_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

type AugmentedMemoryToolResult = {
  __reflectworld_augmented_tool_result: true;
  result_kind: "memory_search" | "memory_get";
  primary_result: unknown;
  expanded_context: unknown[];
};

function isAugmentedMemoryToolResult(result: unknown): result is AugmentedMemoryToolResult {
  return Boolean(
    result
    && typeof result === "object"
    && !Array.isArray(result)
    && (result as Record<string, unknown>).__reflectworld_augmented_tool_result === true,
  );
}

async function augmentMemoryToolResultWithRelatedTrace(
  resultKind: AugmentedMemoryToolResult["result_kind"],
  result: unknown,
  primaryItems: unknown[],
  memClient: ReflectWorldClient,
  cameraId: string,
  userId?: string,
): Promise<unknown> {
  if (primaryItems.length === 0) return result;
  const relatedPrimaryItems = primaryItems
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .filter(item =>
      isEpisodicSchemaMemory(item)
      || isEpisodicEntityMemory(item)
      || isSemanticEntityMemory(item)
    );
  if (relatedPrimaryItems.length === 0) return result;

  const scopedUserId = memoryUserIdFor(cameraId, userId);
  const traceRaw = await withMemRetry("tool.related_trace_context", () => memClient.getMemories({
    camera_id: cameraId,
    user_id: scopedUserId,
    memory_type: "episodic_trace" as any,
    limit: RELATED_TRACE_FETCH_LIMIT,
    sort_order: "asc",
  }));
  const traceItems = flattenMemoriesResponse(traceRaw);
  const expandedContext = buildRelatedTraceContext(
    relatedPrimaryItems as Array<Record<string, unknown>>,
    traceItems as unknown as Array<Record<string, unknown>>,
    MAX_RELATED_TRACE_CONTEXT,
  );
  if (expandedContext.length === 0) return result;
  return {
    __reflectworld_augmented_tool_result: true,
    result_kind: resultKind,
    primary_result: result,
    expanded_context: expandedContext,
  };
}

/**
 * Execute a single tool call against the ReflectWorld client.
 * Returns the raw API result and the flattened item count.
 */
async function executeTool(
  toolName: string,
  params: Record<string, unknown>,
  memClient: ReflectWorldClient,
  cameraId: string,
  userId?: string,
  videoFrameSource?: VideoFrameSource,
): Promise<{ result: unknown; count: number }> {
  switch (toolName) {
    case "reflectworld_memory_search": {
      const query = String(params.query ?? "");
      const scopedUserId = memoryUserIdFor(cameraId, userId);
      const memoryType = (params.memory_type as string) ?? "episodic_trace";
      const limit = (params.limit as number) ?? 20;

      const result = await withMemRetry("tool.memory_search", () => memClient.search({
        query,
        camera_id: cameraId,
        user_id: scopedUserId,
        entity_id: params.entity_id as string | undefined,
        memory_type: memoryType as any,
        limit,
      }));
      const items = flattenSearchResults(result);
      const augmented = await augmentMemoryToolResultWithRelatedTrace(
        "memory_search",
        result,
        items,
        memClient,
        cameraId,
        userId,
      );
      return { result: augmented, count: items.length };
    }
    case "reflectworld_memory_get": {
      const memoryType = (params.memory_type as string) ?? "episodic_trace";
      const segmentId = firstString(params.segment_id);
      const aroundSegmentId = firstString(params.around_segment_id);
      if (memoryType === "episodic_trace" && segmentId) {
        const item = await resolveEpisodicTraceItemBySegmentLikeId({
          memClient,
          cameraId,
          userId,
          segmentId,
        });
        const canonicalSegmentId = item ? segmentIdFromItem(item) : undefined;
        const result = {
          episodic_trace: item ? [item] : [],
          lookup: {
            segment_id: segmentId,
            resolved_segment_id: canonicalSegmentId,
            found: Boolean(item),
          },
        };
        return { result, count: item ? 1 : 0 };
      }
      if (memoryType === "episodic_trace" && aroundSegmentId) {
        const neighborWindow = Math.max(1, Math.min(5, numberValue(params.neighbor_window) ?? 3));
        const orderedRaw = await withMemRetry("tool.memory_get.around_segment", () => memClient.getMemories({
          camera_id: cameraId,
          user_id: memoryUserIdFor(cameraId, userId),
          memory_type: "episodic_trace" as any,
          limit: 1200,
          sort_order: "asc",
        }));
        const orderedItems = flattenMemoriesResponse(orderedRaw);
        const index = orderedItems.findIndex(item =>
          segmentIdFromItem(item) === aroundSegmentId
          || memoryIdFromItem(item) === aroundSegmentId
          || firstString((item as unknown as Record<string, unknown>).id) === aroundSegmentId
          || firstString((item as unknown as Record<string, unknown>).memory_id) === aroundSegmentId
        );
        const items = index >= 0
          ? orderedItems.slice(Math.max(0, index - neighborWindow), index + neighborWindow + 1)
          : [];
        return {
          result: {
            episodic_trace: items,
            lookup: {
              around_segment_id: aroundSegmentId,
              resolved_segment_id: index >= 0 ? segmentIdFromItem(orderedItems[index]) : undefined,
              neighbor_window: neighborWindow,
              found: index >= 0,
            },
          },
          count: items.length,
        };
      }
      const result = await withMemRetry("tool.memory_get", () => memClient.getMemories({
        camera_id: cameraId,
        user_id: memoryUserIdFor(cameraId, userId),
        entity_id: params.entity_id as string | undefined,
        memory_type: memoryType as any,
        limit: (params.limit as number) ?? 50,
        sort_order: params.sort_order === "asc" ? "asc" : params.sort_order === "desc" ? "desc" : undefined,
      }));
      const items = flattenMemoriesResponse(result);
      return { result, count: items.length };
    }
    case "reflectworld_memory_get_history": {
      const limit = (params.limit as number) ?? 50;
      const position = (params.position as string) ?? "latest";
      // Use Mem API sort_order explicitly; Qdrant scroll's natural order is not chronological.
      // No 500-cap workaround needed — Qdrant order_by handles any collection size.
      const result = await withMemRetry("tool.memory_get_history", () => memClient.getMemories({
        camera_id: cameraId,
        user_id: memoryUserIdFor(cameraId, userId),
        memory_type: "episodic_trace" as any,
        limit,
        sort_order: position === "earliest" ? "asc" : "desc",
      }));
      const items = flattenMemoriesResponse(result);
      return { result, count: items.length };
    }
    case "view_visual_evidence": {
      const source = String(params.source ?? "");
      const segmentId = firstString(params.segment_id);
      if (!segmentId) {
        return { result: { error: "view_visual_evidence requires segment_id from a memory record" }, count: 0 };
      }
      let keyframePath = params.keyframe_path as string | undefined;
      let videoPath = params.video_path as string | undefined;
      if (!keyframePath && !videoPath && /^memory_id:/i.test(segmentId)) {
        return {
          result: {
            error: "view_visual_evidence received a memory_id, not a visual segment_id.",
            segment_id: segmentId,
            suggestion: "Use memory_search or memory_get to retrieve the corresponding episodic_trace, then pass its segment_id/video_id (for example a seg_* id) to view_visual_evidence.",
          },
          count: 0,
        };
      }

      // Shared segment lookup: precise video_id filter first, fallback to scan.
      // Reused by keyframe path resolution, video path resolution, AND timing extraction.
      let resolvedSegmentItem: Record<string, unknown> | undefined;
      let resolvedSegmentId = segmentId;
      if (!keyframePath || !videoPath || source === "video_segment") {
        resolvedSegmentItem = await resolveEpisodicTraceItemBySegmentLikeId({
          memClient,
          cameraId,
          userId,
          segmentId,
        });
        if (resolvedSegmentItem) {
          resolvedSegmentId = segmentIdFromItem(resolvedSegmentItem) ?? segmentId;
          const mediaUrls = mediaUrlsFromItem(resolvedSegmentItem);
          keyframePath = keyframePath ?? mediaUrls.find(url => /\.(jpe?g|png|webp)$/i.test(url));
          videoPath = videoPath ?? mediaUrls.find(url => /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(url));
        }
      }

      if (source === "keyframe") {
        const path = keyframePath;
        if (!path || !existsSync(path)) {
          const timingMeta = (resolvedSegmentItem?.metadata ?? resolvedSegmentItem) as Record<string, unknown> | undefined;
          const mediaStartMs = timingMeta ? numberValue(timingMeta.media_start_ms) : undefined;
          if (videoFrameSource && mediaStartMs !== undefined) {
            try {
              const frames = await videoFrameSource.extractFrames({
                startMs: mediaStartMs,
                durationMs: 1000,
                fps: 1,
                maxFrames: 1,
                maxShortEdge: 1080,
              });
              const frame = frames[0];
              if (frame) {
                return {
                  result: {
                    source,
                    visual_scope: "single_frame",
                    evidence_limits: [
                      "This keyframe fallback samples the first frame of the resolved segment because no keyframe_path was stored.",
                      "Do not use this result alone to prove process, motion, temporal order, repeated occurrences, frequency, or whole-video counts.",
                    ],
                    segment_id: resolvedSegmentId,
                    requested_segment_id: segmentId !== resolvedSegmentId ? segmentId : undefined,
                    media_start_ms: mediaStartMs,
                    source_time_label: timingMeta ? firstString(timingMeta.source_time_label) : undefined,
                    time_basis: timingMeta ? firstString(timingMeta.time_basis) : undefined,
                    image_urls: [`data:image/jpeg;base64,${frame.data}`],
                    frame_timestamps_sec: [frame.timestampMs / 1000],
                    keyframe_fallback: "video_frame_source_first_frame",
                  },
                  count: 1,
                };
              }
            } catch {
              // Fall through to the structured missing-keyframe error below.
            }
          }
          return {
            result: {
              error: `Keyframe not found: ${path || "(missing keyframe_path)"}`,
              segment_id: resolvedSegmentId,
              requested_segment_id: segmentId,
              suggestion: "Pass keyframe_path explicitly if the segment_id cannot be resolved from memory visual_evidence.",
            },
            count: 0,
          };
        }
        const keyframeTimingMeta = (resolvedSegmentItem?.metadata ?? resolvedSegmentItem) as Record<string, unknown> | undefined;
        // Downscale to max short edge 720px to limit API payload
        const sharp = (await import("sharp")).default;
        const meta = await sharp(path).metadata();
        const w = meta.width ?? 1024;
        const h = meta.height ?? 576;
        const shortEdge = Math.min(w, h);
        let buf: Buffer;
        if (shortEdge > 720) {
          const scale = 720 / shortEdge;
          buf = await sharp(path)
            .resize(Math.round(w * scale), Math.round(h * scale))
            .jpeg({ quality: 80 })
            .toBuffer();
        } else {
          buf = readFileSync(path);
        }
        const base64 = buf.toString("base64");
        return {
          result: {
            source,
            visual_scope: "single_frame",
            evidence_limits: [
              "This keyframe proves only visible facts in one sampled frame.",
              "Do not use this result alone to prove process, motion, temporal order, repeated occurrences, frequency, or whole-video counts.",
            ],
            segment_id: resolvedSegmentId,
            requested_segment_id: segmentId !== resolvedSegmentId ? segmentId : undefined,
            media_start_ms: keyframeTimingMeta ? numberValue(keyframeTimingMeta.media_start_ms) : undefined,
            media_duration_ms: keyframeTimingMeta ? numberValue(keyframeTimingMeta.media_duration_ms) : undefined,
            source_time_label: keyframeTimingMeta ? firstString(keyframeTimingMeta.source_time_label) : undefined,
            time_basis: keyframeTimingMeta ? firstString(keyframeTimingMeta.time_basis) : undefined,
            can_escalate_to_video_segment: Boolean(videoFrameSource || (videoPath && existsSync(videoPath))),
            image_urls: [`data:image/jpeg;base64,${base64}`],
            path,
            size_bytes: buf.length,
          },
          count: 1,
        };
      }

      if (source === "video_segment") {
        // Resolve segment timing from memory metadata for VideoFrameSource seek.
        let mediaStartMs = 0;
        let mediaDurationMs = 30_000;
        if (!videoFrameSource) {
          // Filesystem video path fallback when segment metadata lacks a direct media path.
          if (!videoPath || !existsSync(videoPath)) {
            return {
              result: {
                error: "No VideoFrameSource configured and no direct video_path found.",
                segment_id: resolvedSegmentId,
                requested_segment_id: segmentId,
                suggestion: "Pass videoFrameSource to AgentQAOptions, or provide video_path in memory metadata.",
              },
              count: 0,
            };
          }
        }

        // Reuse the segment item already resolved above (shared lookup).
        const timingMeta = (resolvedSegmentItem?.metadata ?? resolvedSegmentItem) as Record<string, unknown> | undefined;
        if (timingMeta) {
          mediaStartMs = numberValue(timingMeta.media_start_ms) ?? 0;
          mediaDurationMs = numberValue(timingMeta.media_duration_ms) ?? 30_000;
        } else if (videoFrameSource) {
          // Bug fix: videoFrameSource requires accurate timing — don't guess with 0ms defaults
          return {
            result: {
              error: `Cannot resolve timing for segment_id=${segmentId}. No matching episodic_trace found.`,
              segment_id: resolvedSegmentId,
              requested_segment_id: segmentId,
              suggestion: "Verify segment_id exists in memory, or use source='keyframe' instead.",
            },
            count: 0,
          };
        }

        const requestedFps = Math.max(0.5, Math.min(5, numberValue(params.fps) ?? 1));

        if (videoFrameSource) {
          // start_sec = offset within segment, duration_sec = how long from that offset
          const offsetMs = Math.max(0, (numberValue(params.start_sec) ?? 0) * 1000);
          const requestedDurationMs = params.duration_sec != null
            ? Math.max(1000, Math.min(30_000, (numberValue(params.duration_sec) ?? 30) * 1000))
            : mediaDurationMs;
          // Clamp: don't extend past segment end
          const remainingMs = Math.max(0, mediaDurationMs - offsetMs);
          const adjustedDurationMs = Math.min(requestedDurationMs, remainingMs, 30_000);
          if (adjustedDurationMs <= 0) {
            return {
              result: {
                error: `start_sec=${offsetMs / 1000} exceeds segment duration ${mediaDurationMs / 1000}s`,
                segment_id: resolvedSegmentId,
                requested_segment_id: segmentId !== resolvedSegmentId ? segmentId : undefined,
              },
              count: 0,
            };
          }
          const effectiveStartMs = mediaStartMs + offsetMs;

          // Cap resolution to avoid blowing up payload with 4K frames
          const videoMaxShortEdge = parseInt(process.env.BENCH_AGENT_QA_VIDEO_MAX_SHORT_EDGE ?? "1080", 10) || undefined;

          try {
            const frames = await videoFrameSource.extractFrames({
              startMs: effectiveStartMs,
              durationMs: adjustedDurationMs,
              fps: requestedFps,
              maxFrames: MAX_VISUAL_EVIDENCE_IMAGES,
              maxShortEdge: videoMaxShortEdge,
            });
            const imageUrls = frames.map(f => `data:image/jpeg;base64,${f.data}`);
            return {
              result: {
                source,
                visual_scope: "segment_storyboard",
                evidence_limits: [
                  "Storyboard frames sample the requested segment; use them for visible motion/process/order evidence within this segment, not as full-video coverage.",
                ],
                segment_id: resolvedSegmentId,
                requested_segment_id: segmentId !== resolvedSegmentId ? segmentId : undefined,
                media_start_ms: mediaStartMs,
                source_time_label: timingMeta ? firstString(timingMeta.source_time_label) : undefined,
                time_basis: timingMeta ? firstString(timingMeta.time_basis) : undefined,
                requested_start_sec: offsetMs / 1000,
                effective_start_ms: effectiveStartMs,
                media_duration_ms: adjustedDurationMs,
                fps: requestedFps,
                frame_count: imageUrls.length,
                image_urls: imageUrls,
                frame_timestamps_sec: frames.map(f => f.timestampMs / 1000),
              },
              count: imageUrls.length,
            };
          } catch (err) {
            return {
              result: {
                error: `VideoFrameSource extraction failed: ${err instanceof Error ? err.message : String(err)}`,
                segment_id: resolvedSegmentId,
                requested_segment_id: segmentId !== resolvedSegmentId ? segmentId : undefined,
                media_start_ms: mediaStartMs,
                effective_start_ms: mediaStartMs + offsetMs,
              },
              count: 0,
            };
          }
        }

        // Filesystem video fallback when VideoFrameSource cannot serve this segment.
        const startSec = Math.max(0, numberValue(params.start_sec) ?? 0);
        const durationSec = Math.max(1, Math.min(30, numberValue(params.duration_sec) ?? 30));
        const frameDir = mkdtempSync(join(tmpdir(), "reflectworld-agent-video-"));
        try {
          const outputPattern = join(frameDir, "frame_%03d.jpg");
          execFileSync(resolveFfmpegBin(), [
            "-y",
            "-ss", String(startSec),
            "-i", videoPath!,
            "-t", String(durationSec),
            "-vf", "fps=1,scale='if(gt(iw,ih),min(iw,1024),-2)':'if(gt(iw,ih),-2,min(ih,1024))'",
            "-q:v", "3",
            outputPattern,
          ], { stdio: "pipe" });
          const files = readdirSync(frameDir)
            .filter(file => file.endsWith(".jpg"))
            .sort()
            .slice(0, MAX_VISUAL_EVIDENCE_IMAGES);
          const imageUrls = files.map(file => `data:image/jpeg;base64,${readFileSync(join(frameDir, file)).toString("base64")}`);
          return {
            result: {
              source,
              visual_scope: "segment_storyboard",
              evidence_limits: [
                "Storyboard frames sample the requested segment; use them for visible motion/process/order evidence within this segment, not as full-video coverage.",
              ],
              segment_id: resolvedSegmentId,
              requested_segment_id: segmentId !== resolvedSegmentId ? segmentId : undefined,
              video_path: videoPath,
              start_sec: startSec,
              duration_sec: durationSec,
              fps: 1,
              frame_count: imageUrls.length,
              image_urls: imageUrls,
              frame_timestamps_sec: imageUrls.map((_, index) => startSec + index),
            },
            count: imageUrls.length,
          };
        } finally {
          rmSync(frameDir, { recursive: true, force: true });
        }
      }

      return { result: { error: `Unsupported visual evidence source: ${source}`, segment_id: segmentId }, count: 0 };
    }
    default:
      return { result: { error: `Unknown tool: ${toolName}` }, count: 0 };
  }
}

async function postChatCompletions(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  timeoutMs: number,
  opName = "agent chat",
): Promise<{ response: AgentHttpResponse; retryCount: number }> {
  for (let attempt = 0; attempt <= AGENT_MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attemptStartedAt = Date.now();
    console.error(
      `[agent-qa] ${opName} request attempt ${attempt + 1}/${AGENT_MAX_RETRIES + 1} ` +
      `started timeout_ms=${timeoutMs}`,
    );
    try {
      const response = await Promise.race<AgentHttpResponse>([
        (async () => {
          const fetched = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          return {
            ok: fetched.ok,
            status: fetched.status,
            bodyText: await fetched.text(),
          };
        })(),
        new Promise<AgentHttpResponse>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`${opName} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      console.error(
        `[agent-qa] ${opName} request attempt ${attempt + 1}/${AGENT_MAX_RETRIES + 1} ` +
        `completed status=${response.status} bytes=${response.bodyText.length} ` +
        `latency_ms=${Date.now() - attemptStartedAt}`,
      );
      if (
        response.ok
        || attempt >= AGENT_MAX_RETRIES
        || isNonRetryableQuotaResponse(response)
        || !isRetryableHttpStatus(response.status)
      ) {
        if (isNonRetryableQuotaResponse(response)) {
          console.error(`[agent-qa] ${opName} HTTP 429 insufficient_quota is non-retryable; returning after attempt ${attempt + 1}.`);
        }
        return { response, retryCount: attempt };
      }
      const delay = agentRetryDelayMs(attempt);
      console.error(
        `[agent-qa] ${opName} HTTP ${response.status} attempt ${attempt + 1}/${AGENT_MAX_RETRIES + 1}; ` +
        `retrying in ${delay}ms: ${response.bodyText.slice(0, 200)}`,
      );
      await sleep(delay);
    } catch (err) {
      if (timer) clearTimeout(timer);
      if (attempt >= AGENT_MAX_RETRIES) throw err;
      const delay = agentRetryDelayMs(attempt);
      console.error(
        `[agent-qa] ${opName} request attempt ${attempt + 1}/${AGENT_MAX_RETRIES + 1} failed; ` +
        `retrying in ${delay}ms: ${toErrorMessage(err)}`,
      );
      await sleep(delay);
    }
  }
  throw new Error(`[agent-qa] unreachable retry state for ${opName}`);
}

export interface AgentQAOptions {
  agentProvider: AgentProvider;
  agentApiBase: string;
  agentApiKey: string;
  agentModel: string;
  cameraId: string;
  userId?: string;
  memClient: ReflectWorldClient;
  /** Video frame source for view_visual_evidence video_segment mode.
   *  When provided, enables extracting frames from original video at original resolution. */
  videoFrameSource?: VideoFrameSource;
  promptVersion?: string;
  llmContext?: LlmCallContext;
  llmCallRecorder?: LlmCallRecorder;
}

function isValidOptionLetter(letter: string, optionCount: number): boolean {
  const idx = OPTION_LETTERS.indexOf(letter.toUpperCase());
  return idx >= 0 && idx < optionCount;
}

function extractMcqLetter(text: string | undefined, optionCount: number): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed) as { answer?: unknown };
    const answer = String(parsed.answer ?? "").trim().toUpperCase();
    if (/^[A-Z]$/.test(answer) && isValidOptionLetter(answer, optionCount)) return answer;
  } catch {
    // Not JSON; fall through to text patterns.
  }

  const head = trimmed.match(/^\s*["'`{(\[]?\s*([A-Z])(?:[\)\].:：,\s"'`}]|$)/i);
  if (head?.[1] && isValidOptionLetter(head[1], optionCount)) return head[1].toUpperCase();

  const explicit = trimmed.match(/\b(?:answer|option|choice)\s*(?:is|:)?\s*["'`]?([A-Z])\b/i);
  if (explicit?.[1] && isValidOptionLetter(explicit[1], optionCount)) return explicit[1].toUpperCase();

  const jsonish = trimmed.match(/["']answer["']\s*:\s*["']([A-Z])["']/i);
  if (jsonish?.[1] && isValidOptionLetter(jsonish[1], optionCount)) return jsonish[1].toUpperCase();

  return null;
}

type ConstrainedAnswerSet = {
  kind: "mcq" | "binary" | "alternatives";
  allowed: string[];
  instruction: string;
  optionCount?: number;
};

function constrainedAnswerSetForQuestion(q: BenchmarkQuestion): ConstrainedAnswerSet | null {
  if (q.options?.length) {
    const allowed = q.options.map((_, index) => OPTION_LETTERS[index]).filter(Boolean);
    return {
      kind: "mcq",
      allowed,
      optionCount: q.options.length,
      instruction: `Allowed answers: ${allowed.join(", ")}. Output exactly one letter.`,
    };
  }

  const question = q.question.trim();
  const lower = question.toLowerCase();
  if (/\b(?:yes\s*\/\s*no|yes\s+or\s+no|answer\s+yes\s+or\s+no)\b/.test(lower)) {
    return {
      kind: "binary",
      allowed: ["Yes", "No"],
      instruction: `Allowed answers: Yes, No. Output exactly one of these words.`,
    };
  }
  if (/\b(?:true\s*\/\s*false|true\s+or\s+false|answer\s+true\s+or\s+false)\b/.test(lower)) {
    return {
      kind: "binary",
      allowed: ["True", "False"],
      instruction: `Allowed answers: True, False. Output exactly one of these words.`,
    };
  }

  const alternatives = extractExplicitOrAlternatives(question);
  if (alternatives) {
    return {
      kind: "alternatives",
      allowed: alternatives,
      instruction: `Allowed answers: ${alternatives.join(" | ")}. Output exactly one of these alternatives, preserving the wording.`,
    };
  }

  return null;
}

function extractExplicitOrAlternatives(question: string): string[] | null {
  const cleaned = question.replace(/\s+/g, " ").trim();
  if (!/\bor\b/i.test(cleaned)) return null;
  const tail = cleaned
    .replace(/\?+$/, "")
    .split(/[,;:]/)
    .pop()
    ?.trim();
  if (!tail) return null;
  const match = tail.match(/^(.{1,60}?)\s+or\s+(.{1,60}?)$/i);
  if (!match) return null;
  const choices = [match[1], match[2]]
    .map(choice => choice.replace(/^(?:is it|was it|were they|are they|does it|did it|do they|which is|which are|whether)\s+/i, "").trim())
    .filter(choice => choice.length > 0 && choice.split(/\s+/).length <= 8);
  if (choices.length !== 2) return null;
  if (choices.some(choice => /\b(?:following|video|subtitle|based on)\b/i.test(choice))) return null;
  return choices;
}

function normalizeConstrainedAnswer(text: string | undefined, answerSet: ConstrainedAnswerSet | null): string | null {
  if (!answerSet) return text?.trim() || null;
  const raw = text?.trim();
  if (!raw) return null;

  if (answerSet.kind === "mcq") {
    return extractMcqLetter(raw, answerSet.optionCount ?? answerSet.allowed.length);
  }

  const normalized = raw.replace(/^["'`]+|["'`.]+$/g, "").trim();
  for (const allowed of answerSet.allowed) {
    if (normalized.localeCompare(allowed, undefined, { sensitivity: "accent" }) === 0) return allowed;
  }

  const lower = normalized.toLowerCase();
  for (const allowed of answerSet.allowed) {
    const allowedLower = allowed.toLowerCase();
    if (new RegExp(`\\b${escapeRegExp(allowedLower)}\\b`, "i").test(lower)) return allowed;
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isLengthFinishReason(reason: string | undefined): boolean {
  return /^(?:length|max_tokens)$/i.test(reason ?? "");
}

function firstString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function mediaUrlsFromItem(item: any): string[] {
  const metadata = item?.metadata ?? {};
  const urls: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.trim()) urls.push(value);
  };
  const pushArray = (value: unknown): void => {
    if (Array.isArray(value)) for (const item of value) push(item);
  };
  const pushAssets = (value: unknown): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const assets = value as Record<string, unknown>;
    push(assets.raw);
    pushArray(assets.keyframes);
    pushArray(assets.crops);
    pushArray(assets.video_segments);
    pushArray(assets.videos);
    pushArray(assets.gifs);
  };
  pushArray(metadata.media_urls);
  pushArray(item?.media_urls);
  pushAssets(metadata.media_assets);
  pushAssets(item?.media_assets);
  return [...new Set(urls)];
}

function looksLikeCanonicalSegmentId(value: string | undefined): boolean {
  return Boolean(value && /^seg_[A-Za-z0-9_-]+$/i.test(value.trim()));
}

function segmentIdFromItem(item: any): string | undefined {
  const metadata = item?.metadata ?? {};
  const candidates = [
    firstString(metadata.segment_id),
    firstString(metadata.video_id),
    firstString(item?.segment_id),
    firstString(item?.video_id),
    firstString(metadata.event_id),
    firstString(item?.run_id),
  ].filter((value): value is string => Boolean(value));
  return candidates.find(looksLikeCanonicalSegmentId) ?? candidates[0];
}

function memoryIdFromItem(item: any): string | undefined {
  const metadata = item?.metadata ?? {};
  return firstString(item?.id)
    ?? firstString(item?.memory_id)
    ?? firstString(metadata.id)
    ?? firstString(metadata.memory_id);
}

async function resolveEpisodicTraceItemBySegmentLikeId(params: {
  memClient: ReflectWorldClient;
  cameraId: string;
  userId?: string;
  segmentId: string;
  limit?: number;
}): Promise<Record<string, unknown> | undefined> {
  const scopedUser = memoryUserIdFor(params.cameraId, params.userId);
  const preciseRaw = await withMemRetry("tool.resolve_segment.precise", () => params.memClient.getMemories({
    camera_id: params.cameraId,
    user_id: scopedUser,
    memory_type: "episodic_trace" as any,
    video_id: params.segmentId,
    limit: 1,
  }));
  const preciseResults = flattenMemoriesResponse(preciseRaw);
  if (preciseResults.length > 0) return preciseResults[0] as unknown as Record<string, unknown>;

  const scanRaw = await withMemRetry("tool.resolve_segment.scan", () => params.memClient.getMemories({
    camera_id: params.cameraId,
    user_id: scopedUser,
    memory_type: "episodic_trace" as any,
    limit: params.limit ?? 1600,
    sort_order: "asc",
  }));
  return flattenMemoriesResponse(scanRaw)
    .find(item =>
      segmentIdFromItem(item) === params.segmentId
      || memoryIdFromItem(item) === params.segmentId
      || firstString((item as unknown as Record<string, unknown>).id) === params.segmentId
      || firstString((item as unknown as Record<string, unknown>).memory_id) === params.segmentId
      || firstString(((item as unknown as Record<string, unknown>).metadata as Record<string, unknown> | undefined)?.event_id) === params.segmentId
      || firstString(((item as unknown as Record<string, unknown>).metadata as Record<string, unknown> | undefined)?.video_id) === params.segmentId
    ) as unknown as Record<string, unknown> | undefined;
}

function visualEvidenceFromMediaUrls(mediaUrls: string[]): Record<string, unknown> | undefined {
  if (!mediaUrls.length) return undefined;
  const keyframes = mediaUrls.filter(url => /\.(jpe?g|png|webp)$/i.test(url));
  const videoSegments = mediaUrls.filter(url => /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(url));
  const gifs = mediaUrls.filter(url => /\.gif$/i.test(url));
  if (!keyframes.length && !videoSegments.length && !gifs.length) return undefined;
  return {
    ...(keyframes.length ? { keyframes: keyframes.slice(0, 4) } : {}),
    ...(videoSegments.length ? { video_segments: videoSegments.slice(0, 2) } : {}),
    ...(gifs.length ? { gifs: gifs.slice(0, 2) } : {}),
  };
}

export function shouldPreferVideoSegmentForQuestion(q: BenchmarkQuestion): boolean {
  const text = `${q.question} ${(q.options ?? []).join(" ")}`.toLowerCase();
  const hasExplicitSingleFrameScope =
    /\b(?:in this image|in the image|in the picture|in the frame|in the keyframe|visible in the scene|shown in the scene|on screen in the scene)\b/i.test(text);
  if (hasExplicitSingleFrameScope) return false;
  return /\b(?:sequence|order|first|last|before|after|then|next|while|during|process|steps?|procedure|motion|moving|movement|move|moves|moved|walking|running|driving|turns?|changes?|transition|enters?|exits?|leaves?|comes? into view|appears? first|how many times|number of times|times? does|occur(?:s|red|rence)?|repeated|again|frequency|throughout|over the video|whole video|fewest|most|least)\b/i.test(text);
}

function memoryTimestampMs(item: any): number | undefined {
  const metadata = item?.metadata ?? {};
  const value = metadata.media_start_ms
    ?? metadata.timestamp_ms
    ?? metadata.timestamp
    ?? metadata.time_range_start_ms
    ?? metadata.time_range?.start_ms;
  return typeof value === "number" ? value : undefined;
}

function sourceTimeMetadataFromItem(item: any): Record<string, string> {
  const metadata = item?.metadata ?? {};
  const sourceTimeLabel = firstString(metadata.source_time_label);
  const timeBasis = firstString(metadata.time_basis);
  return {
    ...(sourceTimeLabel ? { source_time_label: sourceTimeLabel } : {}),
    ...(timeBasis ? { time_basis: timeBasis } : {}),
  };
}

function extractMemorySection(text: string, label: string, maxChars: number): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`${escaped}:\\s*([\\s\\S]*?)(?=\\n(?:summary|detailed_summary|transcript|speech_events_text|main_targets|media_urls):|$)`, "i"));
  return match?.[1]?.replace(/\s+/g, " ").trim().slice(0, maxChars) || undefined;
}

function compactToolResultForExtraction(toolName: string, result: unknown): unknown {
  if (result && typeof result === "object" && !Array.isArray(result) && "error" in result) {
    return sanitizeToolResultForArtifact(result);
  }

  if (isAugmentedMemoryToolResult(result)) {
    const primary = compactToolResultForExtraction(toolName, result.primary_result) as Record<string, unknown>;
    return {
      schema: "reflectworld.compact_tool_result.v1",
      result_kind: result.result_kind,
      primary_hits: primary.collections ?? primary.results ?? [],
      expanded_context: result.expanded_context,
      visual_handles: result.expanded_context
        .filter(item => item && typeof item === "object")
        .map((item) => {
          const context = item as Record<string, unknown>;
          return {
            segment_id: context.segment_id,
            timestamp_sec: context.timestamp_sec,
            source_time_label: context.source_time_label,
            time_basis: context.time_basis,
            visual_evidence: context.visual_evidence,
            source: "expanded_context",
            reason: context.reason,
          };
        })
        .filter(handle => handle.segment_id && handle.visual_evidence),
    };
  }

  if (toolName === "reflectworld_memory_search" && result && typeof result === "object" && !Array.isArray(result)) {
    const collections = Object.entries(result as Record<string, unknown>)
      .filter(([, value]) => Array.isArray(value))
      .map(([collection, value]) => ({
        collection,
        results: (value as unknown[]).map((item, index) => compactEvidenceItem(item, index, {
          collection,
          source: "memory_search",
        })),
      }))
      .filter(collection => collection.results.length > 0);
    return {
      schema: "reflectworld.compact_tool_result.v1",
      result_kind: "memory_search",
      result_count: collections.reduce((sum, collection) => sum + collection.results.length, 0),
      collections,
    };
  }

  if (toolName === "reflectworld_memory_get" && result) {
    const items = flattenMemoriesResponse(result as any);
    return {
      schema: "reflectworld.compact_tool_result.v1",
      result_kind: "memory_get",
      result_count: items.length,
      results: items.map((item, index) => compactEvidenceItem(item, index, {
        source: "memory_get",
      })),
    };
  }

  if (toolName === "view_visual_evidence") {
    return compactVisualEvidenceResult(result);
  }

  return sanitizeToolResultForArtifact(result);
}

function serializeToolResultForCompaction(toolName: string, result: unknown): string {
  const compacted = compactToolResultForExtraction(toolName, result);
  const serialized = JSON.stringify(compacted, (_key, value) => {
    if (typeof value === "string" && value.startsWith("data:image/")) {
      return `[image data omitted; ${value.length} chars]`;
    }
    if (Array.isArray(value) && value.some(item => typeof item === "string" && item.startsWith("data:image/"))) {
      return `[${value.length} image data item(s) omitted]`;
    }
    return value;
  });
  if (serialized.length <= TOOL_CONTEXT_SOURCE_MAX_CHARS) return serialized;
  return `${serialized.slice(0, TOOL_CONTEXT_SOURCE_MAX_CHARS)}\n...[truncated ${serialized.length - TOOL_CONTEXT_SOURCE_MAX_CHARS} chars by transport budget]`;
}

type PendingVisualEvidence = {
  source?: string;
  visual_scope?: string;
  segment_id?: string;
  requested_segment_id?: string;
  verification_slot?: string;
  candidate?: string;
  time?: Record<string, unknown>;
  evidence_limits?: unknown;
  fps?: number;
  frame_count?: number;
  frames: Array<{
    index: number;
    timestamp_sec?: number;
    image_url: string;
  }>;
};

function compactEvidenceItem(
  item: any,
  index: number,
  opts: { collection?: string; source?: string } = {},
): Record<string, unknown> {
  const memory = String(item?.memory ?? item?.data ?? "").trim();
  const metadata = item?.metadata ?? {};
  const memoryType = inferMemoryType(item, opts.collection);
  const mediaUrls = mediaUrlsFromItem(item);
  const visualEvidence = visualEvidenceFromMediaUrls(mediaUrls);
  const base: Record<string, unknown> = {
    rank: index + 1,
    source: opts.source,
    collection: opts.collection,
    memory_type: memoryType,
    memory_id: firstString(item?.id),
    score: typeof item?.score === "number" ? Number(item.score.toFixed(4)) : undefined,
    importance: numberValue(item?.importance) !== undefined
      ? Number(numberValue(item?.importance)!.toFixed(4))
      : numberValue(metadata.importance) !== undefined ? Number(numberValue(metadata.importance)!.toFixed(4)) : undefined,
  };
  const time = compactMemoryTime(item);
  const speech = compactSpeech(item, memory);

  if (memoryType === "episodic_trace") {
    return stripUndefined({
      ...base,
      segment_id: segmentIdFromItem(item),
      time,
      affordances: memoryAffordances(item, visualEvidence),
      event_id: firstString(metadata.event_id),
      detailed_summary: compactText(firstString(metadata.detailed_summary)
        ?? extractMemorySection(memory, "detailed_summary", 1200)
        ?? memory, 1200),
      speech,
      entity_ids: stringArray(item?.entity_ids, metadata.entity_ids),
      retrieval_compact: stringArray(metadata.retrieval_compact).slice(0, 12),
      visual_available: Boolean(visualEvidence),
      ...(visualEvidence ? { visual_evidence: visualEvidence } : {}),
    });
  }

  if (memoryType === "episodic_entity") {
    return stripUndefined({
      ...base,
      segment_id: segmentIdFromItem(item),
      time,
      affordances: memoryAffordances(item, visualEvidence),
      entity_id: firstString(item?.entity_id) ?? firstString(metadata.entity_id),
      class_name: firstString(item?.class_name) ?? firstString(metadata.class_name),
      memory: compactText(memory, 900),
      speech,
      retrieval_compact: stringArray(metadata.retrieval_compact).slice(0, 8),
      visual_available: Boolean(visualEvidence),
    });
  }

  if (memoryType === "semantic_entity") {
    return stripUndefined({
      ...base,
      entity_id: firstString(item?.entity_id) ?? firstString(metadata.entity_id),
      class_name: firstString(item?.entity_class)
        ?? firstString(item?.class_name)
        ?? firstString(metadata.entity_class)
        ?? firstString(metadata.class_name),
      category: firstString(item?.category) ?? firstString(metadata.category),
      memory: compactText(memory, 1000),
      video_ids: stringArray(item?.video_ids, metadata.video_ids).slice(0, 30),
      provenance_count: stringArray(item?.video_ids, metadata.video_ids).length || undefined,
      source_segment_id: segmentIdFromItem(item),
      source_time: time,
    });
  }

  if (memoryType === "episodic_schema") {
    return stripUndefined({
      ...base,
      time_range: compactTimeRange(item),
      event_ids: stringArray(metadata.event_ids).slice(0, 30),
      event_count: stringArray(metadata.event_ids).length || undefined,
      memory: compactText(memory, 1400),
    });
  }

  if (memoryType === "semantic_context") {
    return stripUndefined({
      ...base,
      memory: compactText(memory, 1400),
      scene_description: compactText(firstString(metadata.scene_description), 500),
      known_entities: compactText(firstString(metadata.known_entities), 700),
      daily_routine: compactText(firstString(metadata.daily_routine), 400),
      anomaly_baseline: compactText(firstString(metadata.anomaly_baseline), 400),
    });
  }

  return stripUndefined({
    ...base,
    segment_id: segmentIdFromItem(item),
    time,
    affordances: memoryAffordances(item, visualEvidence),
    memory: compactText(memory, 1000),
    speech,
    ...(visualEvidence ? { visual_evidence: visualEvidence } : {}),
  });
}

function memoryAffordances(item: any, visualEvidence?: Record<string, unknown>): string[] | undefined {
  const affordances: string[] = [];
  if (segmentIdFromItem(item)) {
    affordances.push("memory_get:segment_id", "memory_get:around_segment_id");
  }
  if (visualEvidence) affordances.push("view_visual_evidence:segment_id");
  return affordances.length ? affordances : undefined;
}

function inferMemoryType(item: any, collection?: string): string | undefined {
  const metadata = item?.metadata ?? {};
  const explicit = firstString(item?.memory_type) ?? firstString(metadata.memory_type);
  if (explicit) return explicit;
  const collectionMatch = collection?.match(/(episodic_trace|episodic_entity|episodic_schema|semantic_entity|semantic_context|procedural|episodic_visual)$/);
  if (collectionMatch) return collectionMatch[1];
  if (firstString(item?.category) === "semantic_context" || firstString(metadata.category) === "semantic_context" || firstString(metadata.scene_description)) {
    return "semantic_context";
  }
  if (metadata.event_ids || metadata.time_range_start_ms !== undefined || metadata.time_range?.start_ms !== undefined) {
    return "episodic_schema";
  }
  if (firstString(item?.entity_id) || firstString(metadata.entity_id)) {
    if (firstString(item?.category) || firstString(metadata.category) || firstString(item?.entity_class) || firstString(metadata.entity_class)) {
      return "semantic_entity";
    }
    return "episodic_entity";
  }
  if (firstString(item?.video_id) || firstString(metadata.segment_id) || Array.isArray(item?.entity_ids) || Array.isArray(metadata.entity_ids)) {
    return "episodic_trace";
  }
  return undefined;
}

function compactMemoryTime(item: any): Record<string, unknown> | undefined {
  const metadata = item?.metadata ?? {};
  const timestampMs = memoryTimestampMs(item);
  const durationMs = numberValue(metadata.media_duration_ms);
  const source = sourceTimeMetadataFromItem(item);
  if (timestampMs === undefined && durationMs === undefined && !source.source_time_label && !source.time_basis) return undefined;
  return stripUndefined({
    label: source.source_time_label,
    basis: source.time_basis,
    start_ms: timestampMs,
    start_sec: timestampMs !== undefined ? Number((timestampMs / 1000).toFixed(1)) : undefined,
    duration_ms: durationMs,
    duration_sec: durationMs !== undefined ? Number((durationMs / 1000).toFixed(1)) : undefined,
  });
}

function compactTimeRange(item: any): Record<string, unknown> | undefined {
  const metadata = item?.metadata ?? {};
  const startMs = numberValue(metadata.time_range_start_ms) ?? numberValue(metadata.time_range?.start_ms);
  const endMs = numberValue(metadata.time_range_end_ms) ?? numberValue(metadata.time_range?.end_ms);
  if (startMs === undefined && endMs === undefined) return undefined;
  return stripUndefined({
    start_ms: startMs,
    end_ms: endMs,
    start_sec: startMs !== undefined ? Number((startMs / 1000).toFixed(1)) : undefined,
    end_sec: endMs !== undefined ? Number((endMs / 1000).toFixed(1)) : undefined,
  });
}

function compactSpeech(item: any, memory: string): Record<string, unknown> | undefined {
  const metadata = item?.metadata ?? {};
  const speechEvents = firstString(metadata.speech_events_text)
    ?? extractMemorySection(memory, "speech_events_text", 900);
  const transcript = firstString(metadata.transcript)
    ?? extractMemorySection(memory, "transcript", 700);
  const speechText = firstString(metadata.speech_text)
    ?? firstString(item?.speech_text)
    ?? extractMemorySection(memory, "speech_text", 700);
  const text = speechEvents ?? transcript ?? speechText;
  if (!text) return undefined;
  return stripUndefined({
    text: compactText(text, 1000),
    source: speechEvents ? "speech_events_text" : transcript ? "transcript" : "speech_text",
  });
}

function stringArray(...values: unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const candidates = Array.isArray(value) ? value : value == null ? [] : [value];
    for (const candidate of candidates) {
      const text = typeof candidate === "string" ? candidate.trim() : "";
      if (text && !out.includes(text)) out.push(text);
    }
  }
  return out;
}

function compactText(value: string | undefined, maxChars: number): string | undefined {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
    if (Array.isArray(value[key]) && (value[key] as unknown[]).length === 0) delete value[key];
  }
  return value;
}

function compactVisualEvidenceResult(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return sanitizeToolResultForArtifact(result) as Record<string, unknown>;
  }
  const raw = result as Record<string, unknown>;
  if (raw.error) {
    return {
      schema: "reflectworld.compact_tool_result.v1",
      result_kind: "visual_evidence",
      ...(sanitizeToolResultForArtifact(raw) as Record<string, unknown>),
    };
  }
  const imageUrls = Array.isArray(raw.image_urls) ? raw.image_urls : [];
  const frameTimestamps = Array.isArray(raw.frame_timestamps_sec) ? raw.frame_timestamps_sec : [];
  return stripUndefined({
    schema: "reflectworld.compact_tool_result.v1",
    result_kind: "visual_evidence",
    source: firstString(raw.source),
    visual_scope: firstString(raw.visual_scope),
    segment_id: firstString(raw.segment_id),
    requested_segment_id: firstString(raw.requested_segment_id),
    verification_slot: firstString(raw.verification_slot),
    candidate: firstString(raw.candidate),
    time: compactVisualEvidenceTime(raw),
    evidence_limits: raw.evidence_limits,
    fps: numberValue(raw.fps),
    frame_count: numberValue(raw.frame_count) ?? imageUrls.length,
    frames: imageUrls.map((_url, index) => stripUndefined({
      index: index + 1,
      timestamp_sec: numberValue(frameTimestamps[index]),
      image_ref: `visual_frame_${index + 1}`,
    })),
  });
}

function pendingVisualEvidenceFromResult(
  result: unknown,
  maxImages: number,
): PendingVisualEvidence | undefined {
  if (maxImages <= 0 || !result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const raw = result as Record<string, unknown>;
  const imageUrls = Array.isArray(raw.image_urls)
    ? raw.image_urls.filter((url): url is string => typeof url === "string" && url.startsWith("data:image/"))
    : [];
  if (!imageUrls.length) return undefined;
  const frameTimestamps = Array.isArray(raw.frame_timestamps_sec) ? raw.frame_timestamps_sec : [];
  const selectedUrls = imageUrls.slice(0, maxImages);
  return stripUndefined({
    source: firstString(raw.source),
    visual_scope: firstString(raw.visual_scope),
    segment_id: firstString(raw.segment_id),
    requested_segment_id: firstString(raw.requested_segment_id),
    verification_slot: firstString(raw.verification_slot),
    candidate: firstString(raw.candidate),
    time: compactVisualEvidenceTime(raw),
    evidence_limits: raw.evidence_limits,
    fps: numberValue(raw.fps),
    frame_count: numberValue(raw.frame_count) ?? imageUrls.length,
    frames: selectedUrls.map((url, index) => stripUndefined({
      index: index + 1,
      timestamp_sec: numberValue(frameTimestamps[index]),
      image_url: url,
    })),
  }) as PendingVisualEvidence;
}

function compactVisualEvidenceTime(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const sourceTimeLabel = firstString(raw.source_time_label);
  const timeBasis = firstString(raw.time_basis);
  const mediaStartMs = numberValue(raw.media_start_ms);
  const effectiveStartMs = numberValue(raw.effective_start_ms);
  const durationMs = numberValue(raw.media_duration_ms);
  const requestedStartSec = numberValue(raw.requested_start_sec) ?? numberValue(raw.start_sec);
  const durationSec = numberValue(raw.duration_sec);
  if (
    mediaStartMs === undefined
    && effectiveStartMs === undefined
    && durationMs === undefined
    && requestedStartSec === undefined
    && durationSec === undefined
    && !sourceTimeLabel
    && !timeBasis
  ) {
    return undefined;
  }
  return stripUndefined({
    label: sourceTimeLabel,
    basis: timeBasis,
    media_start_ms: mediaStartMs,
    media_start_sec: mediaStartMs !== undefined ? Number((mediaStartMs / 1000).toFixed(1)) : undefined,
    effective_start_ms: effectiveStartMs,
    effective_start_sec: effectiveStartMs !== undefined ? Number((effectiveStartMs / 1000).toFixed(1)) : undefined,
    requested_start_sec: requestedStartSec,
    duration_ms: durationMs,
    duration_sec: durationMs !== undefined ? Number((durationMs / 1000).toFixed(1)) : durationSec,
  });
}

function pendingVisualImageCount(items: PendingVisualEvidence[]): number {
  return items.reduce((sum, item) => sum + item.frames.length, 0);
}

function appendVisualEvidenceToAnswerContent(
  answerContent: Array<Record<string, unknown>>,
  visuals: PendingVisualEvidence[],
): void {
  if (!visuals.length) return;
  answerContent.push({
    type: "text",
    text: "\n\nVisual evidence images are grouped by segment and frame timestamp. Use the segment/time labels below when comparing visible details, counts, motion, or order.",
  });
  visuals.forEach((visual, visualIndex) => {
    answerContent.push({
      type: "text",
      text: formatVisualEvidenceHeader(visual, visualIndex),
    });
    visual.frames.forEach((frame) => {
      answerContent.push({
        type: "text",
        text: `Frame ${frame.index}${frame.timestamp_sec !== undefined ? `, t=${formatSeconds(frame.timestamp_sec)}` : ""}`,
      });
      answerContent.push({ type: "image_url", image_url: { url: frame.image_url } });
    });
  });
}

function formatVisualEvidenceHeader(visual: PendingVisualEvidence, index: number): string {
  const lines = [
    `\nVisual Evidence #${index + 1}`,
    visual.segment_id ? `segment_id: ${visual.segment_id}` : undefined,
    visual.requested_segment_id && visual.requested_segment_id !== visual.segment_id
      ? `requested_segment_id: ${visual.requested_segment_id}`
      : undefined,
    visual.source ? `source: ${visual.source}` : undefined,
    visual.visual_scope ? `scope: ${visual.visual_scope}` : undefined,
    visual.verification_slot ? `purpose: ${visual.verification_slot}` : undefined,
    visual.candidate ? `candidate: ${visual.candidate}` : undefined,
    visual.time ? `time: ${JSON.stringify(visual.time)}` : undefined,
    visual.fps !== undefined ? `fps: ${visual.fps}` : undefined,
    `frames: ${visual.frames.length}${visual.frame_count && visual.frame_count !== visual.frames.length ? ` shown of ${visual.frame_count}` : ""}`,
    Array.isArray(visual.evidence_limits) && visual.evidence_limits.length
      ? `limits: ${visual.evidence_limits.join(" ")}`
      : undefined,
  ].filter(Boolean);
  return lines.join("\n");
}

function formatSeconds(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const total = Math.max(0, value);
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// Simple QA path — the only Agent-QA implementation.
//
// A thin, WorldMM-style flow. Two LLM roles, zero host-side semantic gates:
//   1. reasoning loop: LLM decides search / get / view_visual / answer itself, and
//      picks the memory type + query. Host only executes the tool and appends
//      the raw retrieved content (no extraction node, no evidence ledger, no
//      controller policy, no resolver/derived_answer/answer-constraints).
//   2. answer: LLM reads the accumulated raw evidence and outputs the letter.
//
// Sufficiency is judged by the reasoning LLM (it says "answer"); the final
// choice is judged by the answer LLM from the raw evidence. This mirrors the
// 178/240 baseline + WorldMM philosophy: keep the architecture clear and thin,
// keep all semantic judgement in the model rather than in host heuristics.
// ---------------------------------------------------------------------------

const SIMPLE_MAX_ROUNDS = Math.max(
  1,
  Math.min(8, Number.parseInt(process.env.BENCH_AGENT_QA_SIMPLE_MAX_ROUNDS ?? "5", 10) || 5),
);
const SIMPLE_MAX_ACTIONS_PER_ROUND = Math.max(
  1,
  Math.min(5, Number.parseInt(process.env.BENCH_AGENT_QA_SIMPLE_MAX_ACTIONS_PER_ROUND ?? "3", 10) || 3),
);
const SIMPLE_REASONING_MAX_TOKENS = 2000;
const SIMPLE_REASONING_FALLBACK_MAX_TOKENS = 6000;
const SIMPLE_ANSWER_MAX_TOKENS = 3000;
const SIMPLE_ANSWER_FALLBACK_MAX_TOKENS = 6000;
const SIMPLE_CONSTRAINED_RETRY_MAX_TOKENS = 400;
const SIMPLE_SEARCH_LIMIT = 8;
const SIMPLE_MEMORY_TYPES = new Set([
  "episodic_trace", "episodic_schema", "episodic_entity", "semantic_entity", "semantic_context",
]);

function buildSimpleReasoningSystemPrompt(): string {
  return `You are a retrieval-reasoning agent for a video-memory QA system. Each turn you plan the next action, or a short ordered list of actions, that most reduces uncertainty: SEARCH memory, GET memory context, VIEW visual evidence, or ANSWER.

Tool capabilities:

memory_search:
- episodic_trace: per-segment events — what is visible/heard in each segment (scene, actions, people, objects, on-screen text, speech), with segment_id and time. Use for concrete facts, dialogue, order, and local details.
- episodic_schema: chapter/global summaries — coarse event flow, topics, ordering. Use for whole-video / summary / "overall" / theme questions.
- semantic_entity: per-person/topic profiles, aliases, roles, relationships. Use for identity / who-is questions.
- semantic_context: scene/background/known-entity context.

memory_get:
- Expand a known segment_id, read neighboring episodic_trace records around a segment, or list records in time order with sort_order.
- Use this when search found a candidate segment but you need context, neighboring events, or timestamps to compare order/sequence/first/last/before/after.

view_visual_evidence:
- Directly inspect frames from a retrieved segment_id. Memory text is a compressed description; visual evidence is the direct observation tool.
- Use keyframe for static visible facts. Use video_segment for motion, order, repeated actions, or within-segment counts.
- The answer node receives images grouped by segment_id, time, frame index, and timestamp.

Operating guidance:
- Decide FIRST: "search", "get", "view_visual", or "answer".
- Choose the next tool call or ordered action list that most reduces the remaining evidence gap. Answer when one option/answer is directly supported and the other plausible alternatives have been reasonably checked.
- You may return multiple actions in one round when they are part of one coherent plan, such as searching two candidate facts, expanding/viewing an already known segment, or reading neighboring context for a found segment. Keep the list short and purposeful.
- Later actions in the same round must use segment_id/entity_id values already present in "Retrieved so far"; they cannot depend on IDs that might be discovered by earlier actions in the same list.
- For order / sequence / "first/last/before/after" / count / whole-video questions, use memory_get with sort_order or around_segment_id after search, so you can compare timestamps and nearby events rather than relying on relevance order.
- Prefer episodic_trace for concrete facts; episodic_schema for global/summary; semantic_* for identity.
- Write a short keyword/phrase query that sounds like the stored memory text (segment summaries, speech snippets, on-screen text), NOT the benchmark question wording (avoid "which of the following", "based on the video", etc.).
- When the answer depends on visible facts (color, count, OCR, object appearance, held items, action, motion, layout, screen/scoreboard/jersey details), use memory to locate the segment and visual evidence to verify what is actually visible.
- Do not over-search, but do not stop while a cheap tool can resolve a clear evidence gap.

Output valid JSON only, no commentary:
{"decision":"search"|"get"|"view_visual"|"answer","memory_type":"episodic_trace|episodic_schema|episodic_entity|semantic_entity|semantic_context","search_query":"<short phrase for search>","sort_order":"asc|desc","around_segment_id":"<segment id for neighboring context>","segment_id":"<segment id for get/view_visual>","source":"keyframe|video_segment","verification_slot":"<optional fact or option to verify>","candidate":"<optional option label/name>","evidence_gap":"<what is still uncertain>","expected_tool_gain":"<what this step can verify>"}
Or:
{"actions":[{"decision":"search"|"get"|"view_visual","memory_type":"episodic_trace|episodic_schema|episodic_entity|semantic_entity|semantic_context","search_query":"<short phrase>","segment_id":"<segment id>","around_segment_id":"<segment id>","sort_order":"asc|desc","source":"keyframe|video_segment","verification_slot":"<optional fact>","candidate":"<optional option label/name>","evidence_gap":"<what is uncertain>","expected_tool_gain":"<what this action verifies>"}]}
For decision="search" give memory_type+search_query; for "get" give segment_id, around_segment_id, or memory_type+sort_order; for "view_visual" give segment_id, source, and optionally verification_slot/candidate. Use decision="answer" only when no more tools are needed.`;
}

function buildSimpleAnswerSystemPrompt(): string {
  return `You answer a question about a video using the retrieved memory evidence provided.

General reasoning (independent of question type):
- Work out exactly what the question asks for — an entity, a relation or cause, an order, a count, a yes/no, or which of several options — then find the evidence that directly settles THAT. Prefer evidence that states the asked fact over evidence that merely shares words with the question or an option.
- Surface-match traps: evidence that something was believed, said, or thought is not proof it is true; do not overstate with only / most / all / always unless the evidence says so; respect the asked scope (a named part, time window, or person).
- Order / "first / before / after / next / sequence" questions: read each relevant item's timestamp from the evidence and sort by time; do not infer order from how results were ranked.
- Count / "how many" questions: list the distinct instances first, de-duplicating repeats of the same event (same segment/time), then give the number.
- Visual evidence: image groups are labeled by segment_id, time range, frame index, and timestamp. Use those labels when comparing visible facts, motion/order, or counts; do not treat unlabeled image order as global video order.
- Evidence priority: direct visual evidence settles visible facts; speech/text memory settles spoken claims and opinions; timestamps settle order. If sources conflict, prefer the source that directly observes the asked fact.
- If the evidence is genuinely unclear, give the most reasonable inference from it; for open questions you may also state what is known and what cannot be determined.

Output format by question type:
- Multiple choice: weigh each option against the evidence (supported / refuted / not mentioned), then output ONE letter (A, B, C, or D) and nothing else.
- Yes/no: output "Yes" or "No" following the evidence.
- Any question with an explicit answer set (yes/no, true/false, X or Y, or listed options in the question text): identify the allowed answers from the question and choose exactly one of them. Do not answer "unknown" unless it is one of the allowed answers.
- Open-ended / short answer: a short, specific phrase, preferably in the evidence's own wording.`;
}

type SimpleReasoningAction = {
  decision: string;
  memory_type?: string;
  search_query?: string;
  segment_id?: string;
  source?: string;
  sort_order?: string;
  around_segment_id?: string;
  verification_slot?: string;
  candidate?: string;
  evidence_gap?: string;
  expected_tool_gain?: string;
};

type SimpleReasoningPlan = SimpleReasoningAction & {
  actions?: SimpleReasoningAction[];
};

function parseSimpleReasoningAction(data: Record<string, unknown>): SimpleReasoningAction {
  return {
    decision: String(data.decision ?? "answer").toLowerCase(),
    memory_type: typeof data.memory_type === "string" ? data.memory_type : undefined,
    search_query: typeof data.search_query === "string" ? data.search_query : undefined,
    segment_id: typeof data.segment_id === "string" ? data.segment_id : undefined,
    source: typeof data.source === "string" ? data.source : undefined,
    sort_order: typeof data.sort_order === "string" ? data.sort_order.toLowerCase() : undefined,
    around_segment_id: typeof data.around_segment_id === "string" ? data.around_segment_id : undefined,
    verification_slot: typeof data.verification_slot === "string" ? data.verification_slot : undefined,
    candidate: typeof data.candidate === "string" ? data.candidate : undefined,
    evidence_gap: typeof data.evidence_gap === "string" ? data.evidence_gap : undefined,
    expected_tool_gain: typeof data.expected_tool_gain === "string" ? data.expected_tool_gain : undefined,
  };
}

export function parseSimpleReasoning(raw: string): SimpleReasoningPlan {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    const data = JSON.parse(match ? match[0] : raw) as Record<string, unknown>;
    const first = parseSimpleReasoningAction(data);
    if (Array.isArray(data.actions)) {
      const actions = data.actions
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
        .map(parseSimpleReasoningAction)
        .slice(0, SIMPLE_MAX_ACTIONS_PER_ROUND);
      return { ...first, actions: actions.length ? actions : undefined };
    }
    return first;
  } catch {
    return { decision: "answer" };
  }
}

export async function runAgentQASimple(
  questions: BenchmarkQuestion[],
  opts: AgentQAOptions,
): Promise<QAResult[]> {
  const results: QAResult[] = [];
  const config: AgentConfig = {
    provider: opts.agentProvider,
    apiBase: opts.agentApiBase,
    apiKey: opts.agentApiKey,
    model: opts.agentModel,
  };

  for (const q of questions) {
    const start = Date.now();
    const toolCalls: ToolCallRecord[] = [];
    const trace: AgentQATrace = {
      question_id: q.id,
      question: q.question,
      type: q.type,
      ...(q.options?.length ? { options: q.options } : {}),
      camera_id: opts.cameraId,
      events: [],
    };

    const optionText = q.options?.length
      ? q.options.map((o, i) => `${OPTION_LETTERS[i]}) ${o}`).join("\n")
      : "";
    const fullQuery = optionText
      ? `Question: ${q.question}\nChoices:\n${optionText}`
      : `Question: ${q.question}`;
    const constrainedAnswerSet = constrainedAnswerSetForQuestion(q);

    const roundHistory: string[] = [];
    const retrievedTexts: string[] = [];
    const pendingVisualEvidence: PendingVisualEvidence[] = [];
    const viewedSegments = new Set<string>();
    let round = 0;
    let answer = "";
    let status: "ok" | "incomplete" = "ok";

    try {
      // MCQ candidate coverage (mechanical, mirrors f460 host_candidate_prefetch).
      // The dominant simple-vs-f460 regression (22/30) was the reasoning LLM never
      // searching the correct candidate (e.g. 832-1 never searched the gold option),
      // so it answered without ever seeing the decisive evidence. Before the reasoning
      // loop, probe episodic_trace once per candidate using an option-derived query so
      // every option is retrieved. This is pure retrieval coverage, not a semantic gate:
      // the reasoning LLM still decides what else to search and when to answer.
      if (q.options?.length) {
        const candidateQueries = buildCandidateQueries(q, q.options.length);
        for (const [index, candidateQuery] of candidateQueries.entries()) {
          const query = rewriteMemorySearchQueryForSemanticSearch(candidateQuery);
          if (!query) continue;
          const letter = OPTION_LETTERS[index] ?? String(index + 1);
          const params: Record<string, unknown> = {
            query,
            memory_type: "episodic_trace",
            camera_id: opts.cameraId,
            limit: 4,
            candidate: letter,
            verification_slot: `candidate ${letter} coverage`,
          };
          const toolStart = Date.now();
          let result: unknown;
          let count = 0;
          try {
            const out = await executeTool("reflectworld_memory_search", params, opts.memClient, opts.cameraId, opts.userId, opts.videoFrameSource);
            result = out.result;
            count = out.count;
          } catch (err) {
            result = { error: toErrorMessage(err) };
            count = 0;
          }
          const latencyMs = Date.now() - toolStart;
          toolCalls.push({ round: 0, source: "host_candidate_prefetch", tool: "reflectworld_memory_search", params, result_count: count, latency_ms: latencyMs });
          const rendered = serializeToolResultForCompaction("reflectworld_memory_search", result);
          const evidenceBlock = `### Candidate ${letter} coverage — ${count} result(s)\n${rendered}`;
          roundHistory.push(evidenceBlock);
          retrievedTexts.push(evidenceBlock);
          trace.events.push({
            type: "tool_result",
            round: 0,
            source: "host_candidate_prefetch",
            tool: "reflectworld_memory_search",
            params: sanitizeForTrace(params),
            result_count: count,
            latency_ms: latencyMs,
            result_preview: sanitizeForTrace(result),
          });
        }
      }
      while (round < SIMPLE_MAX_ROUNDS) {
        round += 1;
        const reasoningUser = `${fullQuery}

Retrieved so far:
${roundHistory.length ? roundHistory.join("\n\n") : "(nothing yet)"}

Step 1: decide "search", "get", "view_visual", "answer", or a short ordered "actions" list.
Step 2 (if search): pick one memory_type and a short query.
Step 2 (if get): expand a segment_id, get neighbors around a segment_id, or read a memory_type in time order with sort_order.
Step 2 (if view_visual): pick a segment_id that appears in the retrieved results above.`;

        let reasoningRaw = "";
        try {
          const choice = await postAgentMessageWithLengthFallback(config, [
            { role: "system", content: buildSimpleReasoningSystemPrompt() },
            { role: "user", content: reasoningUser },
          ], {
            json: true,
            maxTokens: SIMPLE_REASONING_MAX_TOKENS,
            fallbackMaxTokens: SIMPLE_REASONING_FALLBACK_MAX_TOKENS,
            temperature: 0,
            opName: `simple reasoning r${round} ${q.id}`,
            fallbackOpName: `simple reasoning r${round} ${q.id} fallback`,
            stage: "qa.simple_reasoning",
            fallbackStage: "qa.simple_reasoning_fallback",
            promptVersion: opts.promptVersion,
            llmContext: opts.llmContext,
            llmCallRecorder: opts.llmCallRecorder,
          });
          reasoningRaw = choice.content ?? "";
        } catch (err) {
          trace.events.push({ type: "simple_reasoning_error", round, error: toErrorMessage(err) });
          break;
        }

        const plan = parseSimpleReasoning(reasoningRaw);
        const actions = plan.actions?.length ? plan.actions : [plan];
        trace.events.push({ type: "simple_reasoning", round, plan: sanitizeForTrace(plan), action_count: actions.length });

        let stopForAnswer = false;
        let executedActionCount = 0;

        for (const [actionIndex, decision] of actions.entries()) {
          if (decision.decision === "answer") {
            stopForAnswer = true;
            break;
          }

          let toolName = "";
          let params: Record<string, unknown> = {};
          let label = "";
          if (decision.decision === "view_visual" && decision.segment_id) {
            toolName = "view_visual_evidence";
            const visualSource = decision.source === "keyframe" || decision.source === "video_segment"
              ? decision.source
              : shouldPreferVideoSegmentForQuestion(q) ? "video_segment" : "keyframe";
            const visualKey = [
              decision.segment_id,
              visualSource,
              decision.verification_slot ?? "",
              decision.candidate ?? "",
            ].join("|");
            if (viewedSegments.has(visualKey)) {
              trace.events.push({
                type: "simple_action_skipped",
                round,
                action_index: actionIndex + 1,
                reason: "duplicate_visual_evidence",
                decision: sanitizeForTrace(decision),
              });
              continue;
            }
            viewedSegments.add(visualKey);
            params = {
              source: visualSource,
              segment_id: decision.segment_id,
              camera_id: opts.cameraId,
              ...(decision.verification_slot ? { verification_slot: decision.verification_slot } : {}),
              ...(decision.candidate ? { candidate: decision.candidate } : {}),
            };
            label = `visual ${decision.segment_id}`;
          } else if (decision.decision === "get" && (decision.segment_id || decision.around_segment_id || decision.sort_order || decision.memory_type)) {
            toolName = "reflectworld_memory_get";
            if (decision.segment_id) {
              params = {
                memory_type: "episodic_trace",
                segment_id: decision.segment_id,
                camera_id: opts.cameraId,
                ...(decision.verification_slot ? { verification_slot: decision.verification_slot } : {}),
                ...(decision.candidate ? { candidate: decision.candidate } : {}),
              };
              label = `get segment ${decision.segment_id}`;
            } else if (decision.around_segment_id) {
              params = {
                memory_type: "episodic_trace",
                around_segment_id: decision.around_segment_id,
                neighbor_window: 4,
                camera_id: opts.cameraId,
                ...(decision.verification_slot ? { verification_slot: decision.verification_slot } : {}),
                ...(decision.candidate ? { candidate: decision.candidate } : {}),
              };
              label = `get neighbors around ${decision.around_segment_id}`;
            } else {
              const memType = decision.memory_type && SIMPLE_MEMORY_TYPES.has(decision.memory_type)
                ? decision.memory_type
                : "episodic_trace";
              const sort = decision.sort_order === "desc" ? "desc" : "asc";
              params = {
                memory_type: memType,
                sort_order: sort,
                limit: 16,
                camera_id: opts.cameraId,
                ...(decision.verification_slot ? { verification_slot: decision.verification_slot } : {}),
                ...(decision.candidate ? { candidate: decision.candidate } : {}),
              };
              label = `get ${memType} ${sort}`;
            }
          } else if (decision.decision === "search" && decision.search_query) {
            toolName = "reflectworld_memory_search";
            const memType = decision.memory_type && SIMPLE_MEMORY_TYPES.has(decision.memory_type)
              ? decision.memory_type
              : "episodic_trace";
            params = {
              query: rewriteMemorySearchQueryForSemanticSearch(decision.search_query),
              memory_type: memType,
              camera_id: opts.cameraId,
              limit: SIMPLE_SEARCH_LIMIT,
              ...(decision.verification_slot ? { verification_slot: decision.verification_slot } : {}),
              ...(decision.candidate ? { candidate: decision.candidate } : {}),
            };
            label = `${memType} "${decision.search_query}"`;
          } else {
            trace.events.push({
              type: "simple_action_skipped",
              round,
              action_index: actionIndex + 1,
              reason: "invalid_or_missing_parameters",
              decision: sanitizeForTrace(decision),
            });
            continue;
          }

          const toolStart = Date.now();
          let result: unknown;
          let count = 0;
          try {
            const out = await executeTool(toolName, params, opts.memClient, opts.cameraId, opts.userId, opts.videoFrameSource);
            result = out.result;
            count = out.count;
          } catch (err) {
            result = { error: toErrorMessage(err) };
            count = 0;
          }
          if (toolName === "view_visual_evidence" && result && typeof result === "object" && !Array.isArray(result)) {
            result = stripUndefined({
              ...(result as Record<string, unknown>),
              verification_slot: params.verification_slot,
              candidate: params.candidate,
            });
          }
          const latencyMs = Date.now() - toolStart;
          toolCalls.push({ round, source: "controller_executor", tool: toolName, params, result_count: count, latency_ms: latencyMs });
          executedActionCount += 1;

          if (toolName === "view_visual_evidence") {
            const remainingImages = MAX_VISUAL_EVIDENCE_IMAGES - pendingVisualImageCount(pendingVisualEvidence);
            const visual = pendingVisualEvidenceFromResult(result, remainingImages);
            if (visual) pendingVisualEvidence.push(visual);
          }

          const rendered = serializeToolResultForCompaction(toolName, result);
          const evidenceBlock = `### Round ${round}.${actionIndex + 1} (${label}) — ${count} result(s)\n${rendered}`;
          roundHistory.push(evidenceBlock);
          retrievedTexts.push(evidenceBlock);
          trace.events.push({
            type: "tool_result",
            round,
            action_index: actionIndex + 1,
            tool: toolName,
            params: sanitizeForTrace(params),
            result_count: count,
            latency_ms: latencyMs,
            result_preview: sanitizeForTrace(result),
          });
        }

        if (stopForAnswer || executedActionCount === 0) break;
      }

      const evidenceText = retrievedTexts.length ? retrievedTexts.join("\n\n") : "(no evidence retrieved)";
      const answerContent: Array<Record<string, unknown>> = [
        { type: "text", text: `${fullQuery}\n\nRetrieved memory evidence:\n${evidenceText}` },
      ];
      appendVisualEvidenceToAnswerContent(answerContent, pendingVisualEvidence);
      if (constrainedAnswerSet) {
        answerContent.push({ type: "text", text: `\n${constrainedAnswerSet.instruction}` });
      }

      let answerRaw = "";
      try {
        const choice = await postAgentMessageWithLengthFallback(config, [
          { role: "system", content: buildSimpleAnswerSystemPrompt() },
          { role: "user", content: answerContent },
        ], {
          maxTokens: SIMPLE_ANSWER_MAX_TOKENS,
          fallbackMaxTokens: SIMPLE_ANSWER_FALLBACK_MAX_TOKENS,
          temperature: 0,
          opName: `simple answer ${q.id}`,
          fallbackOpName: `simple answer ${q.id} fallback`,
          stage: "qa.simple_answer",
          fallbackStage: "qa.simple_answer_fallback",
          promptVersion: opts.promptVersion,
          llmContext: opts.llmContext,
          llmCallRecorder: opts.llmCallRecorder,
        });
        answerRaw = choice.content ?? "";
      } catch (err) {
        trace.events.push({ type: "simple_answer_error", error: toErrorMessage(err) });
        status = "incomplete";
      }

      let constrainedAnswer = normalizeConstrainedAnswer(answerRaw, constrainedAnswerSet);
      if (constrainedAnswerSet && !constrainedAnswer && status === "ok") {
        const retryContent: Array<Record<string, unknown>> = [
          {
            type: "text",
            text:
              `${fullQuery}\n\nRetrieved memory evidence:\n${evidenceText}\n\n` +
              `Your previous response did not match the required answer set.\n` +
              `${constrainedAnswerSet.instruction}\n` +
              `Choose the best-supported answer from the allowed set. Do not explain.`,
          },
        ];
        appendVisualEvidenceToAnswerContent(retryContent, pendingVisualEvidence);
        try {
          const retry = await postAgentMessageWithLengthFallback(config, [
            { role: "system", content: buildSimpleAnswerSystemPrompt() },
            { role: "user", content: retryContent },
          ], {
            maxTokens: SIMPLE_CONSTRAINED_RETRY_MAX_TOKENS,
            fallbackMaxTokens: SIMPLE_CONSTRAINED_RETRY_MAX_TOKENS,
            temperature: 0,
            opName: `simple constrained answer retry ${q.id}`,
            fallbackOpName: `simple constrained answer retry ${q.id} fallback`,
            stage: "qa.simple_answer_constrained_retry",
            fallbackStage: "qa.simple_answer_constrained_retry_fallback",
            promptVersion: opts.promptVersion,
            llmContext: opts.llmContext,
            llmCallRecorder: opts.llmCallRecorder,
          });
          answerRaw = retry.content ?? "";
          constrainedAnswer = normalizeConstrainedAnswer(answerRaw, constrainedAnswerSet);
          trace.events.push({
            type: "simple_constrained_answer_retry",
            answer_raw: answerRaw,
            normalized_answer: constrainedAnswer,
            allowed: constrainedAnswerSet.allowed,
          });
        } catch (err) {
          trace.events.push({ type: "simple_constrained_answer_retry_error", error: toErrorMessage(err) });
        }
      }

      if (constrainedAnswerSet) {
        answer = constrainedAnswer ?? answerRaw.trim();
        if (!constrainedAnswer) {
          trace.events.push({
            type: "simple_constrained_answer_unresolved",
            answer_raw: answerRaw,
            allowed: constrainedAnswerSet.allowed,
          });
        }
      } else {
        answer = answerRaw.trim();
      }
      trace.events.push({ type: "simple_final_answer", answer, total_rounds: round });
    } catch (err) {
      status = "incomplete";
      answer = "";
      trace.events.push({ type: "simple_fatal_error", error: toErrorMessage(err) });
    }

    trace.final_answer = answer;
    trace.status = status;
    trace.answer_mode = "answer_node";
    results.push({
      id: q.id,
      question: q.question,
      type: q.type,
      status,
      answer_mode: "answer_node",
      tool_calls: toolCalls,
      trace,
      agent_answer: answer,
      total_rounds: round,
      total_latency_ms: Date.now() - start,
    });
  }

  return results;
}

/**
 * Run multi-round agent QA for a list of benchmark questions.
 *
 * Each question follows a deterministic evidence workflow:
 * - controller emits retrieval plans
 * - deterministic executor runs bounded retrieval/expansion under AGENT_QA_POLICY
 * - extraction writes the ledger
 * - answer node produces the final answer
 */
export async function runAgentQA(
  questions: BenchmarkQuestion[],
  opts: AgentQAOptions,
): Promise<QAResult[]> {
  // The thin WorldMM-style path (runAgentQASimple) is now the only Agent-QA
  // implementation; the former thick five-node full path has been removed.
  return runAgentQASimple(questions, opts);
}
