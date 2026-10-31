import type { LlmCallRecord, LlmTokenUsage } from "./types.js";

export type {
  LlmCallRecord,
  LlmCallAttemptRecord,
  LlmCallRequestMeta,
  LlmTokenUsage,
  SegmentArchive,
  SegmentArchiveWarning,
} from "./types.js";

export interface LlmCallContext {
  run_id?: string;
  snapshot_version?: string;
  video_id?: string;
  camera_id?: string;
  segment_id?: string;
}

export function createLlmCallId(prefix = "llm"): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

export function normalizeTokenUsage(usage: LlmTokenUsage | null | undefined): LlmTokenUsage | null {
  if (!usage) return null;
  const normalized: LlmTokenUsage = {};
  for (const key of ["prompt_tokens", "completion_tokens", "reasoning_tokens", "total_tokens"] as const) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) normalized[key] = value;
    else if (value === null) normalized[key] = null;
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

export function mergeLlmCallContext(call: LlmCallRecord, context: LlmCallContext): LlmCallRecord {
  return {
    ...call,
    ...Object.fromEntries(
      Object.entries(context).filter(([, value]) => value !== undefined && value !== ""),
    ),
  };
}
