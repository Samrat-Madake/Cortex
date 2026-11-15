import type { AgentQATrace } from "./types.js";

export interface QaTraceDiagnostics {
  tool_counts: Record<string, number>;
  memory_search_calls: number;
  memory_get_calls: number;
  visual_evidence_calls: number;
  candidate_coverage_counts: {
    supported: number;
    refuted: number;
    unknown: number;
    missing: number;
  } | null;
  candidate_coverage_bucket: string | null;
  selected_candidate_letter: string | null;
  selected_candidate_status: string | null;
  selected_candidate_coverage_source: string | null;
  selected_candidate_expected_status: "supported" | "refuted" | null;
  selected_candidate_matches_expected: boolean | null;
  extraction_insufficient_result_count: number;
  extraction_last_result_sufficiency: string | null;
  extraction_visual_insufficient_count: number;
  extraction_followup_request_count: number;
  extraction_last_followup_requests: Array<Record<string, unknown>>;
  duplicate_option_group_count: number | null;
  evidence_slot_counts: {
    supported: number;
    contradicted: number;
    unknown: number;
    other: number;
  } | null;
  timestamped_supported_slots: number | null;
  order_verifier_status: string | null;
  order_selected_answer: string | null;
  order_selected_order: string[] | null;
  order_timestamp_order: string[] | null;
  order_issue_count: number | null;
  order_issue_types: string[];
  order_material_item_count: number | null;
  order_direct_binding_count: number | null;
  order_boundary_risk_count: number | null;
  order_weak_binding_count: number | null;
  order_non_canonical_count: number | null;
  order_timestamped_item_count: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function numericCounts<T extends string>(value: unknown, keys: readonly T[]): Record<T, number> | null {
  const record = asRecord(value);
  if (!record) return null;
  const out = {} as Record<T, number>;
  for (const key of keys) {
    const raw = record[key];
    out[key] = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  }
  return out;
}

function lastEvent(trace: AgentQATrace | undefined, type: string): Record<string, unknown> | null {
  const events = trace?.events ?? [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type === type) return event;
  }
  return null;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : null;
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

const OPTION_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function isValidOptionLetter(letter: string, optionCount: number): boolean {
  const idx = OPTION_LETTERS.indexOf(letter.toUpperCase());
  return idx >= 0 && idx < optionCount;
}

function extractOptionLetter(value: unknown, optionCount: number): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  const direct = text.match(/^[\s"'`{(\[]*([A-Z])(?:[\)\].:：,\s"'`}]|$)/i);
  if (direct?.[1] && isValidOptionLetter(direct[1], optionCount)) return direct[1].toUpperCase();
  const explicit = text.match(/\b(?:answer|option|choice)\s*(?:is|:)?\s*["'`]?([A-Z])\b/i);
  if (explicit?.[1] && isValidOptionLetter(explicit[1], optionCount)) return explicit[1].toUpperCase();
  return null;
}

function selectedAnswerText(trace: AgentQATrace | undefined): string | null {
  const payloadAnswer = asRecord(trace?.answer_payload)?.answer;
  if (typeof payloadAnswer === "string" && payloadAnswer.trim()) return payloadAnswer;
  return typeof trace?.final_answer === "string" && trace.final_answer.trim()
    ? trace.final_answer
    : null;
}

function isNegativeCandidateQuestion(trace: AgentQATrace | undefined): boolean {
  const question = trace?.question ?? "";
  return /\b(?:not|except|false|incorrect|wrong|least|cannot|can't|can\s+not|unable|unavailable|without|does\s+not|did\s+not|is\s+not|are\s+not|was\s+not|were\s+not)\b/i.test(question);
}

function selectedCandidateFromSummary(
  candidateSummary: Record<string, unknown> | null,
  letter: string | null,
): Record<string, unknown> | null {
  if (!letter || !Array.isArray(candidateSummary?.candidates)) return null;
  for (const item of candidateSummary.candidates) {
    const candidate = asRecord(item);
    if (typeof candidate?.letter === "string" && candidate.letter.toUpperCase() === letter) {
      return candidate;
    }
  }
  return null;
}

function countOrderItems(
  orderSummary: Record<string, unknown> | null,
  predicate: (item: Record<string, unknown>) => boolean,
): number | null {
  const items = Array.isArray(orderSummary?.material_items) ? orderSummary.material_items : null;
  if (!items) return null;
  return items
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .filter(predicate).length;
}

export function summarizeQaTraceDiagnostics(trace: AgentQATrace | undefined): QaTraceDiagnostics {
  const tool_counts: Record<string, number> = {};
  for (const event of trace?.events ?? []) {
    if (event.type !== "tool_result") continue;
    const tool = typeof event.tool === "string" ? event.tool : "unknown";
    tool_counts[tool] = (tool_counts[tool] ?? 0) + 1;
  }

  const candidateSummary = asRecord(lastEvent(trace, "candidate_coverage_summary")?.summary);
  const candidateCounts = numericCounts(candidateSummary?.counts, ["supported", "refuted", "unknown", "missing"] as const);
  const duplicateGroups = candidateSummary?.duplicate_option_groups;
  const optionCount = trace?.type === "mcq" && Array.isArray(trace.options) ? trace.options.length : 0;
  const selectedCandidateLetter = optionCount > 0 ? extractOptionLetter(selectedAnswerText(trace), optionCount) : null;
  const selectedCandidate = selectedCandidateFromSummary(candidateSummary, selectedCandidateLetter);
  const selectedCandidateStatus = typeof selectedCandidate?.status === "string" ? selectedCandidate.status : null;
  const selectedCandidateCoverageSource = typeof selectedCandidate?.coverage_source === "string"
    ? selectedCandidate.coverage_source
    : null;
  const selectedCandidateExpectedStatus = selectedCandidateLetter
    ? isNegativeCandidateQuestion(trace) ? "refuted" : "supported"
    : null;
  const extractionPayloads = (trace?.events ?? [])
    .filter(event => event.type === "tool_result_evidence_extraction")
    .map(event => parseJsonRecord(event.update) ?? parseJsonRecord(event.raw_update))
    .filter((payload): payload is Record<string, unknown> => Boolean(payload));
  const lastExtractionPayload = extractionPayloads.length
    ? extractionPayloads[extractionPayloads.length - 1]
    : null;
  const extractionInsufficientResultCount = extractionPayloads
    .filter(payload => payload.latest_result_sufficiency === "insufficient")
    .length;
  const extractionVisualInsufficientCount = extractionPayloads
    .filter(payload => payload.visual_evidence_insufficient === true)
    .length;
  const followupRequestArray = (value: unknown): Array<Record<string, unknown>> | null => Array.isArray(value)
    ? value.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item))
    : null;
  const extractionFollowupRequestCount = extractionPayloads.reduce((total, payload) => {
    const requests = followupRequestArray(payload.followup_requests);
    return total + (requests?.length ?? 0);
  }, 0);
  const extractionLastFollowupRequests = followupRequestArray(lastExtractionPayload?.followup_requests) ?? [];

  const slotSummary = asRecord(lastEvent(trace, "evidence_slot_summary")?.summary);
  const slotCounts = numericCounts(slotSummary?.counts, ["supported", "contradicted", "unknown", "other"] as const);
  const timestampedSupported = slotSummary?.timestamped_supported;
  const orderSummary = asRecord(lastEvent(trace, "order_verifier")?.summary);
  const orderIssues = Array.isArray(orderSummary?.issues)
    ? orderSummary.issues
      .map(issue => asRecord(issue)?.type)
      .filter((type): type is string => typeof type === "string")
    : null;
  const orderItems = Array.isArray(orderSummary?.material_items) ? orderSummary.material_items : null;

  return {
    tool_counts,
    memory_search_calls: tool_counts.cortex_memory_search ?? 0,
    memory_get_calls: tool_counts.cortex_memory_get ?? 0,
    visual_evidence_calls: tool_counts.view_visual_evidence ?? 0,
    candidate_coverage_counts: candidateCounts,
    candidate_coverage_bucket: candidateCounts
      ? `sup${candidateCounts.supported}_ref${candidateCounts.refuted}_unk${candidateCounts.unknown}_miss${candidateCounts.missing}`
      : null,
    selected_candidate_letter: selectedCandidateLetter,
    selected_candidate_status: selectedCandidateStatus,
    selected_candidate_coverage_source: selectedCandidateCoverageSource,
    selected_candidate_expected_status: selectedCandidateExpectedStatus,
    selected_candidate_matches_expected: selectedCandidateExpectedStatus && selectedCandidateStatus
      ? selectedCandidateStatus === selectedCandidateExpectedStatus
      : null,
    extraction_insufficient_result_count: extractionInsufficientResultCount,
    extraction_last_result_sufficiency: typeof lastExtractionPayload?.latest_result_sufficiency === "string"
      ? lastExtractionPayload.latest_result_sufficiency
      : null,
    extraction_visual_insufficient_count: extractionVisualInsufficientCount,
    extraction_followup_request_count: extractionFollowupRequestCount,
    extraction_last_followup_requests: extractionLastFollowupRequests,
    duplicate_option_group_count: Array.isArray(duplicateGroups) ? duplicateGroups.length : null,
    evidence_slot_counts: slotCounts,
    timestamped_supported_slots: typeof timestampedSupported === "number" && Number.isFinite(timestampedSupported)
      ? timestampedSupported
      : null,
    order_verifier_status: typeof orderSummary?.status === "string" ? orderSummary.status : null,
    order_selected_answer: typeof orderSummary?.selected_answer === "string" ? orderSummary.selected_answer : null,
    order_selected_order: stringArray(orderSummary?.selected_order),
    order_timestamp_order: stringArray(orderSummary?.timestamp_order),
    order_issue_count: orderIssues ? orderIssues.length : null,
    order_issue_types: orderIssues ? [...new Set(orderIssues)] : [],
    order_material_item_count: orderItems ? orderItems.length : null,
    order_direct_binding_count: countOrderItems(orderSummary, item => item.semantic_binding === "direct"),
    order_boundary_risk_count: countOrderItems(orderSummary, item => item.semantic_binding === "boundary_risk"),
    order_weak_binding_count: countOrderItems(orderSummary, item => item.semantic_binding === "weak"),
    order_non_canonical_count: countOrderItems(orderSummary, item => item.canonical_slot === false),
    order_timestamped_item_count: countOrderItems(orderSummary, item => typeof item.timestamp_sec === "number"),
  };
}
