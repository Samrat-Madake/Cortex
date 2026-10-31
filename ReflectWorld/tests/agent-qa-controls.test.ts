import { describe, expect, it } from "vitest";
import { chatCompletionControls, isOpenAIReasoningModel } from "../eval/benchmark/pipeline/agent-qa";

describe("benchmark Agent-QA chat completion controls", () => {
  it("uses max_completion_tokens for versioned GPT-5 family models", () => {
    expect(isOpenAIReasoningModel("gpt-5.4-mini")).toBe(true);
    expect(isOpenAIReasoningModel("openai/gpt-5.4-mini")).toBe(true);

    const controls = chatCompletionControls("gpt-5.4-mini", 700, 0.2, "low");

    expect(controls).toMatchObject({
      max_completion_tokens: 700,
      reasoning_effort: "low",
    });
    expect(controls.max_tokens).toBeUndefined();
    expect(controls.temperature).toBeUndefined();
  });
});
