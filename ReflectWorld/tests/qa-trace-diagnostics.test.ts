import { describe, expect, it } from "vitest";
import { summarizeQaTraceDiagnostics } from "../eval/benchmark/pipeline/qa-trace-diagnostics.js";
import type { AgentQATrace } from "../eval/benchmark/pipeline/types.js";

function trace(events: AgentQATrace["events"]): AgentQATrace {
  return {
    question_id: "q1",
    question: "Question?",
    type: "mcq",
    options: ["Alpha", "Beta", "Gamma", "Delta"],
    camera_id: "cam",
    events,
  };
}

describe("QA trace diagnostics", () => {
  it("summarizes tool counts and final coverage buckets", () => {
    const diagnostics = summarizeQaTraceDiagnostics({
      ...trace([
        { type: "tool_result", tool: "reflectworld_memory_search" },
        { type: "tool_result", tool: "reflectworld_memory_get" },
        { type: "tool_result", tool: "view_visual_evidence" },
        {
          type: "tool_result_evidence_extraction",
          update: JSON.stringify({
            latest_result_sufficiency: "insufficient",
            visual_evidence_insufficient: false,
            followup_requests: [{ query: "inspect earlier segment", reason: "need earlier context" }],
          }),
        },
        {
          type: "tool_result_evidence_extraction",
          update: JSON.stringify({
            latest_result_sufficiency: "partial",
            visual_evidence_insufficient: true,
            followup_requests: [
              { suggested_tool: "view_visual_evidence", source: "video_segment", segment_id: "seg_001", reason: "view segment video" },
              { suggested_tool: "reflectworld_memory_search", query: "search adjacent transcript", reason: "search adjacent transcript" },
            ],
          }),
        },
        {
          type: "candidate_coverage_summary",
          summary: {
            counts: { supported: 1, refuted: 2, unknown: 1, missing: 0 },
            candidates: [
              { letter: "A", option: "Alpha", status: "refuted", coverage_source: "letter" },
              { letter: "B", option: "Beta", status: "supported", coverage_source: "letter" },
              { letter: "C", option: "Gamma", status: "unknown", coverage_source: "letter" },
              { letter: "D", option: "Delta", status: "refuted", coverage_source: "letter" },
            ],
            duplicate_option_groups: [{ option: "same", letters: ["A", "B"] }],
          },
        },
        {
          type: "evidence_slot_summary",
          summary: {
            counts: { supported: 3, contradicted: 0, unknown: 2, other: 1 },
            timestamped_supported: 2,
          },
        },
        {
          type: "order_verifier",
          summary: {
            status: "conflict",
            selected_answer: "B",
            selected_order: ["(b)", "(a)"],
            timestamp_order: ["(a)", "(b)"],
            material_items: [
              {
                label: "(a)",
                semantic_binding: "direct",
                canonical_slot: true,
                timestamp_sec: 10,
              },
              {
                label: "(b)",
                semantic_binding: "boundary_risk",
                canonical_slot: false,
                timestamp_sec: 20,
              },
              {
                label: "(c)",
                semantic_binding: "weak",
                canonical_slot: false,
              },
            ],
            issues: [
              { type: "candidate_order_conflict" },
              { type: "slot_semantic_boundary_risk" },
              { type: "slot_semantic_boundary_risk" },
            ],
          },
        },
      ]),
      final_answer: "B",
    });

    expect(diagnostics).toEqual(expect.objectContaining({
      memory_search_calls: 1,
      memory_get_calls: 1,
      visual_evidence_calls: 1,
      candidate_coverage_counts: { supported: 1, refuted: 2, unknown: 1, missing: 0 },
      candidate_coverage_bucket: "sup1_ref2_unk1_miss0",
      selected_candidate_letter: "B",
      selected_candidate_status: "supported",
      selected_candidate_coverage_source: "letter",
      selected_candidate_expected_status: "supported",
      selected_candidate_matches_expected: true,
      extraction_insufficient_result_count: 1,
      extraction_last_result_sufficiency: "partial",
      extraction_visual_insufficient_count: 1,
      extraction_followup_request_count: 3,
      extraction_last_followup_requests: [
        { suggested_tool: "view_visual_evidence", source: "video_segment", segment_id: "seg_001", reason: "view segment video" },
        { suggested_tool: "reflectworld_memory_search", query: "search adjacent transcript", reason: "search adjacent transcript" },
      ],
      duplicate_option_group_count: 1,
      evidence_slot_counts: { supported: 3, contradicted: 0, unknown: 2, other: 1 },
      timestamped_supported_slots: 2,
      order_verifier_status: "conflict",
      order_selected_answer: "B",
      order_selected_order: ["(b)", "(a)"],
      order_timestamp_order: ["(a)", "(b)"],
      order_issue_count: 3,
      order_issue_types: ["candidate_order_conflict", "slot_semantic_boundary_risk"],
      order_material_item_count: 3,
      order_direct_binding_count: 1,
      order_boundary_risk_count: 1,
      order_weak_binding_count: 1,
      order_non_canonical_count: 2,
      order_timestamped_item_count: 2,
    }));
  });

  it("uses the latest summary events and tolerates missing traces", () => {
    expect(summarizeQaTraceDiagnostics(undefined)).toEqual(expect.objectContaining({
      tool_counts: {},
      candidate_coverage_counts: null,
      candidate_coverage_bucket: null,
      selected_candidate_letter: null,
      selected_candidate_status: null,
      selected_candidate_coverage_source: null,
      selected_candidate_expected_status: null,
      selected_candidate_matches_expected: null,
      extraction_insufficient_result_count: 0,
      extraction_last_result_sufficiency: null,
      extraction_visual_insufficient_count: 0,
      extraction_followup_request_count: 0,
      extraction_last_followup_requests: [],
      evidence_slot_counts: null,
      order_verifier_status: null,
      order_issue_count: null,
      order_issue_types: [],
      order_material_item_count: null,
      order_boundary_risk_count: null,
      order_weak_binding_count: null,
    }));

    const diagnostics = summarizeQaTraceDiagnostics(trace([
      { type: "candidate_coverage_summary", summary: { counts: { supported: 0, refuted: 0, unknown: 4, missing: 0 } } },
      { type: "candidate_coverage_summary", summary: { counts: { supported: 1, refuted: 3, unknown: 0, missing: 0 } } },
    ]));

    expect(diagnostics.candidate_coverage_bucket).toBe("sup1_ref3_unk0_miss0");
  });

  it("extracts selected candidate diagnostics from answer payload and bounds letters by option count", () => {
    const diagnostics = summarizeQaTraceDiagnostics({
      ...trace([
        {
          type: "candidate_coverage_summary",
          summary: {
            counts: { supported: 1, refuted: 1, unknown: 1, missing: 1 },
            candidates: [
              { letter: "A", option: "Alpha", status: "supported", coverage_source: "letter" },
              { letter: "B", option: "Beta", status: "refuted", coverage_source: "letter" },
              { letter: "C", option: "Gamma", status: "unknown", coverage_source: "letter" },
              { letter: "D", option: "Delta", status: "missing", coverage_source: "missing" },
            ],
          },
        },
      ]),
      final_answer: "Evidence is insufficient.",
      answer_payload: { answer: "C" },
    });

    expect(diagnostics).toEqual(expect.objectContaining({
      selected_candidate_letter: "C",
      selected_candidate_status: "unknown",
      selected_candidate_coverage_source: "letter",
      selected_candidate_expected_status: "supported",
      selected_candidate_matches_expected: false,
    }));

    const insufficient = summarizeQaTraceDiagnostics({
      ...trace([]),
      final_answer: "Evidence is insufficient.",
    });
    expect(insufficient.selected_candidate_letter).toBe(null);
  });

  it("expects refuted coverage for negative candidate questions", () => {
    const diagnostics = summarizeQaTraceDiagnostics({
      ...trace([
        {
          type: "candidate_coverage_summary",
          summary: {
            counts: { supported: 3, refuted: 1, unknown: 0, missing: 0 },
            candidates: [
              { letter: "A", option: "Alpha", status: "supported", coverage_source: "letter" },
              { letter: "B", option: "Beta", status: "refuted", coverage_source: "letter" },
              { letter: "C", option: "Gamma", status: "supported", coverage_source: "letter" },
              { letter: "D", option: "Delta", status: "supported", coverage_source: "letter" },
            ],
          },
        },
      ]),
      question: "Which statement is not true?",
      final_answer: "B",
    });

    expect(diagnostics).toEqual(expect.objectContaining({
      selected_candidate_letter: "B",
      selected_candidate_status: "refuted",
      selected_candidate_expected_status: "refuted",
      selected_candidate_matches_expected: true,
    }));
  });
});
