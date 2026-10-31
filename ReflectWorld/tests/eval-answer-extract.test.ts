import { describe, expect, it } from "vitest";
import {
  extractMcqPrediction,
  extractOptionLetter,
  shouldExtractPrediction,
} from "../eval/benchmark/pipeline/eval-answer-extract.js";
import type { QAResult } from "../eval/benchmark/pipeline/types.js";

function qaResult(overrides: Partial<QAResult>): QAResult {
  return {
    id: "q1",
    question: "Question?",
    type: "mcq",
    status: "ok",
    answer_mode: "answer_node",
    tool_calls: [],
    agent_answer: "A",
    total_rounds: 1,
    total_latency_ms: 1,
    ...overrides,
  };
}

describe("eval answer extraction", () => {
  it("bounds option extraction by the real option count", () => {
    expect(extractOptionLetter("D", 4)).toBe("D");
    expect(extractOptionLetter("E", 4)).toBeNull();
    expect(extractOptionLetter("Evidence is insufficient.", 4)).toBeNull();
    expect(extractOptionLetter("Option E", 4)).toBeNull();
    expect(extractOptionLetter("Option E", 5)).toBe("E");
    expect(extractOptionLetter("The clip does not prove option B.", 4)).toBeNull();
  });

  it("does not extract predictions from incomplete or failed QA results", () => {
    const incomplete = qaResult({
      status: "incomplete",
      answer_mode: "unable",
      failure_reason: "insufficient_evidence",
      agent_answer: "Evidence is insufficient to determine the answer.",
    });

    expect(shouldExtractPrediction(incomplete)).toBe(false);
    expect(extractMcqPrediction(incomplete, 4)).toBeNull();
  });

  it("uses structured answer payload before raw text fallback", () => {
    const structured = qaResult({
      agent_answer: "The answer is B.",
      trace: {
        question_id: "q1",
        question: "Question?",
        type: "mcq",
        camera_id: "cam",
        events: [],
        answer_payload: { answer: "C" },
      },
    });

    expect(extractMcqPrediction(structured, 4)).toBe("C");
  });

  it("falls back to bounded raw text only for ok results with missing structured answer", () => {
    expect(extractMcqPrediction(qaResult({ agent_answer: "The answer is B." }), 4)).toBe("B");
    expect(extractMcqPrediction(qaResult({ agent_answer: "Evidence is insufficient." }), 4)).toBeNull();
    expect(extractMcqPrediction(qaResult({ agent_answer: "E" }), 4)).toBeNull();
  });

  it("does not fall back when structured answer is explicitly null", () => {
    const result = qaResult({
      agent_answer: "A",
      trace: {
        question_id: "q1",
        question: "Question?",
        type: "mcq",
        camera_id: "cam",
        events: [],
        answer_payload: { answer: null },
      },
    });

    expect(extractMcqPrediction(result, 4)).toBeNull();
  });
});
