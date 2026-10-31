import { normalizeTokenUsage, type LlmCallRecord, type LlmTokenUsage } from "@reflectworld/shared";
import type { GeminiResponse, OpenAIResponse } from "./types.js";
import { VlmApiError } from "./errors.js";

export function retryErrorType(err: unknown): string {
  if (err instanceof VlmApiError) {
    return err.status !== undefined ? `http_${err.status}` : "vlm_api_error";
  }
  if (err instanceof Error) {
    const name = err.name || "Error";
    const message = err.message.toLowerCase();
    if (name.toLowerCase().includes("abort") || message.includes("abort") || message.includes("timeout")) {
      return "timeout";
    }
    if (message.includes("econn") || message.includes("network")) {
      return "network";
    }
    return name;
  }
  return typeof err;
}

export function normalizeOpenAIUsage(usage: OpenAIResponse["usage"]): LlmTokenUsage | null {
  return normalizeTokenUsage({
    prompt_tokens: usage?.prompt_tokens,
    completion_tokens: usage?.completion_tokens,
    reasoning_tokens: usage?.completion_tokens_details?.reasoning_tokens,
    total_tokens: usage?.total_tokens,
  });
}

export function normalizeGeminiUsage(usage: GeminiResponse["usageMetadata"]): LlmTokenUsage | null {
  return normalizeTokenUsage({
    prompt_tokens: usage?.promptTokenCount,
    completion_tokens: usage?.candidatesTokenCount,
    reasoning_tokens: usage?.thoughtsTokenCount,
    total_tokens: usage?.totalTokenCount,
  });
}

export function truncateArchiveText(text: string, maxChars = 65_536): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n[truncated:${text.length - maxChars}]`;
}

export function truncateLogText(text: string, maxChars = 4096): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n[truncated:${text.length - maxChars}]`;
}

export function tryParseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

export function summarizeOpenAIResponse(resp: OpenAIResponse): Record<string, unknown> {
  return {
    choice_count: resp.choices?.length ?? 0,
    choices: (resp.choices ?? []).map((choice) => ({
      finish_reason: choice.finish_reason ?? null,
      message_keys: choice.message ? Object.keys(choice.message) : [],
      content_length: choice.message?.content?.length ?? 0,
      has_refusal: Boolean(choice.message?.refusal),
      refusal_preview: choice.message?.refusal ? truncateLogText(choice.message.refusal, 512) : undefined,
    })),
    usage: normalizeOpenAIUsage(resp.usage),
  };
}

export function summarizeGeminiResponse(resp: GeminiResponse): Record<string, unknown> {
  return {
    candidate_count: resp.candidates?.length ?? 0,
    candidates: (resp.candidates ?? []).map((candidate) => ({
      finish_reason: candidate.finishReason ?? null,
      part_count: candidate.content?.parts?.length ?? 0,
      text_lengths: (candidate.content?.parts ?? []).map((part) => part.text?.length ?? 0),
      has_safety_ratings: candidate.safetyRatings != null,
      safety_ratings: candidate.safetyRatings,
    })),
    prompt_feedback: resp.promptFeedback,
    usage: normalizeGeminiUsage(resp.usageMetadata),
  };
}

export function simpleHash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `fnv1a32:${(h >>> 0).toString(16).padStart(8, "0")}`;
}

export function buildVlmArchive(params: {
  call: LlmCallRecord;
  rawText: string;
  normalizedJson?: string | null;
  parseStatus: "ok" | "error";
  repairApplied: boolean;
  errors: string[];
}): Record<string, unknown> {
  return {
    call_id: params.call.call_id,
    stage: params.call.stage,
    provider: params.call.provider,
    model: params.call.model,
    prompt_version: params.call.prompt_version,
    request: params.call.request,
    usage: params.call.usage ?? null,
    latency_ms: params.call.latency_ms,
    raw_text: truncateArchiveText(params.rawText),
    normalized_json: params.normalizedJson == null ? null : truncateArchiveText(params.normalizedJson),
    parse: {
      status: params.parseStatus,
      repair_applied: params.repairApplied,
      errors: params.errors,
    },
  };
}
