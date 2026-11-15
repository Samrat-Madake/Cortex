import type { LlmCallRecord, LlmTokenUsage } from "@cortex/shared";

export class VlmAnalysisError extends Error {
  archive?: Record<string, unknown>;
  llmCall?: LlmCallRecord;

  constructor(message: string, opts?: { archive?: Record<string, unknown>; llmCall?: LlmCallRecord; cause?: unknown }) {
    super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "VlmAnalysisError";
    this.archive = opts?.archive;
    this.llmCall = opts?.llmCall;
  }
}

export class VlmApiError extends Error {
  status?: number;
  retryAfterMs?: number;
  details?: Record<string, unknown>;
  usage?: LlmTokenUsage | null;

  constructor(message: string, opts?: { status?: number; retryAfterMs?: number; details?: Record<string, unknown>; usage?: LlmTokenUsage | null }) {
    super(message);
    this.name = "VlmApiError";
    this.status = opts?.status;
    this.retryAfterMs = opts?.retryAfterMs;
    this.details = opts?.details;
    this.usage = opts?.usage;
  }
}
