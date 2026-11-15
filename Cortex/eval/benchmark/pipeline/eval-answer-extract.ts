import type { QAResult } from "./types.js";

const OPTION_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function optionLetters(optionCount: number | undefined): string {
  const count = Number.isInteger(optionCount) ? Math.max(0, Math.min(OPTION_LETTERS.length, optionCount ?? 0)) : 0;
  return OPTION_LETTERS.slice(0, count);
}

export function extractOptionLetter(raw: string | undefined | null, optionCount: number | undefined): string | null {
  if (!raw) return null;
  const letters = optionLetters(optionCount);
  if (!letters) return null;

  const text = raw.trim();
  const letterClass = `[${letters}]`;
  const head = text.match(new RegExp(`^\\s*${letterClass}(?:[\\)\\].:：,\\s]|$)`, "i"));
  if (head?.[0]) return head[0].trim()[0]?.toUpperCase() ?? null;

  const explicit = text.match(new RegExp(`^\\s*(?:the\\s+)?(?:final\\s+)?(?:answer|option|choice)\\s*(?:is|:)?\\s*["'\`]?(${letterClass})\\b`, "i"))
    ?? text.match(new RegExp(`^\\s*(?:i\\s+)?(?:choose|select|pick)\\s+["'\`]?(${letterClass})\\b`, "i"));
  if (explicit?.[1]) return explicit[1].toUpperCase();

  if (text.length <= 20) {
    const any = text.match(new RegExp(`\\b(${letterClass})\\b`, "i"));
    return any?.[1]?.toUpperCase() ?? null;
  }
  return null;
}

export function extractAnswerLetter(text: string | undefined | null, optionCount: number | undefined): string {
  return extractOptionLetter(text, optionCount) ?? "";
}

function structuredAnswerPayload(result: QAResult): Record<string, unknown> | null {
  const payload = result.trace?.answer_payload;
  return payload && typeof payload === "object" ? payload : null;
}

export function shouldExtractPrediction(result: QAResult): boolean {
  return result.status === "ok"
    && result.answer_mode !== "unable"
    && !result.failure_reason;
}

export function extractMcqPrediction(result: QAResult, optionCount: number | undefined): string | null {
  if (!shouldExtractPrediction(result)) return null;

  const payload = structuredAnswerPayload(result);
  if (payload && Object.prototype.hasOwnProperty.call(payload, "answer")) {
    const structuredAnswer = payload.answer;
    return typeof structuredAnswer === "string"
      ? extractOptionLetter(structuredAnswer, optionCount)
      : null;
  }

  return extractOptionLetter(result.agent_answer, optionCount);
}
