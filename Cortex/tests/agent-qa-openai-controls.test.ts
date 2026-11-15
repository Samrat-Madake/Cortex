import { describe, expect, it } from "vitest";
import {
  chatCompletionControls,
  effectiveAgentMaxTokens,
  isOpenAIReasoningModel,
} from "../eval/benchmark/pipeline/agent-qa.js";

describe("Agent-QA OpenAI completion controls", () => {
  it("treats GPT-5 mini as the same reasoning-model family as GPT-5", () => {
    expect(isOpenAIReasoningModel("gpt-5")).toBe(true);
    expect(isOpenAIReasoningModel("azure/gpt-5")).toBe(true);
    expect(isOpenAIReasoningModel("gpt-5-mini")).toBe(true);
    expect(isOpenAIReasoningModel("azure/gpt-5-mini")).toBe(true);
    expect(isOpenAIReasoningModel("gpt-4.1-mini")).toBe(false);
  });

  it("uses max_completion_tokens and reasoning_effort for GPT-5 mini", () => {
    expect(chatCompletionControls("azure/gpt-5-mini", 6000, 0, "low")).toMatchObject({
      max_completion_tokens: 6000,
      reasoning_effort: "low",
    });
    expect(chatCompletionControls("azure/gpt-5-mini", 6000, 0)).not.toHaveProperty("temperature");
  });

  it("applies the output budget floor to GPT-5 mini JSON and tool calls", () => {
    const config = { provider: "openai" as const, model: "azure/gpt-5-mini" };

    expect(effectiveAgentMaxTokens(config, 1200, { json: true })).toBe(6000);
    expect(effectiveAgentMaxTokens(config, 2048, { tools: true })).toBe(6000);
    expect(effectiveAgentMaxTokens(config, 7000, { json: true })).toBe(7000);
    expect(effectiveAgentMaxTokens(config, 1200, {})).toBe(1200);
  });
});
