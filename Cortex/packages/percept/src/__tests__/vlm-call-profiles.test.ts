import { describe, expect, it } from "vitest";
import { resolveVlmCallProfile } from "../vlm-call-profiles.js";

describe("VLM call profiles", () => {
  const withBenchmarkSegmentReasoning = <T>(value: string, fn: () => T): T => {
    const previous = process.env.BENCH_VLM_SEGMENT_REASONING_EFFORT;
    process.env.BENCH_VLM_SEGMENT_REASONING_EFFORT = value;
    try {
      return fn();
    } finally {
      if (previous === undefined) {
        delete process.env.BENCH_VLM_SEGMENT_REASONING_EFFORT;
      } else {
        process.env.BENCH_VLM_SEGMENT_REASONING_EFFORT = previous;
      }
    }
  };

  it("uses gpt-5-mini stage defaults for segment analysis", () => {
    expect(resolveVlmCallProfile({
      model: "gpt-5-mini",
      stage: "segment_analysis",
      mode: "vlm_only",
    })).toEqual({
      maxOutputTokens: 2048,
      reasoning: "minimal",
      stream: true,
    });
  });

  it("allows benchmark runs to raise segment analysis reasoning", () => {
    withBenchmarkSegmentReasoning("low", () => {
      expect(resolveVlmCallProfile({
        model: "gpt-5-mini",
        stage: "segment_analysis",
        mode: "vlm_only",
      })).toEqual({
        maxOutputTokens: 2048,
        reasoning: "low",
        stream: true,
      });
    });
  });

  it("normalizes provider-prefixed model names", () => {
    expect(resolveVlmCallProfile({
      model: "openai/gpt-5-mini",
      stage: "segment_analysis",
      mode: "subject_proposal",
    })).toEqual({
      maxOutputTokens: 2048,
      reasoning: "minimal",
      stream: true,
    });
  });

  it("matches versioned gpt-5 mini model names", () => {
    expect(resolveVlmCallProfile({
      model: "gpt-5.4-mini",
      stage: "segment_analysis",
      mode: "vlm_only",
    })).toEqual({
      maxOutputTokens: 2048,
      reasoning: "none",
      stream: true,
    });

    expect(resolveVlmCallProfile({
      model: "openai/gpt-5.4-mini",
      stage: "segment_analysis",
      mode: "subject_proposal",
    })).toEqual({
      maxOutputTokens: 2048,
      reasoning: "none",
      stream: true,
    });
  });

  it("uses qwen thinking controls for qwen3.6-flash", () => {
    expect(resolveVlmCallProfile({
      model: "qwen3.6-flash",
      stage: "segment_analysis",
      mode: "vlm_only",
    })).toEqual({
      maxOutputTokens: 2048,
      stream: true,
      providerOptions: {
        openaiCompat: {
          enable_thinking: true,
          thinking_budget: 512,
        },
      },
    });
  });

  it("normalizes provider-prefixed qwen model names", () => {
    expect(resolveVlmCallProfile({
      model: "openai/qwen3.6-flash",
      stage: "segment_analysis",
      mode: "subject_proposal",
    })).toEqual({
      maxOutputTokens: 2048,
      stream: true,
      providerOptions: {
        openaiCompat: {
          enable_thinking: true,
          thinking_budget: 512,
        },
      },
    });
  });

  it("matches dated qwen model variants", () => {
    expect(resolveVlmCallProfile({
      model: "qwen3.6-flash-2026-04-16",
      stage: "segment_analysis",
      mode: "vlm_only",
    })).toEqual({
      maxOutputTokens: 2048,
      stream: true,
      providerOptions: {
        openaiCompat: {
          enable_thinking: true,
          thinking_budget: 512,
        },
      },
    });

    expect(resolveVlmCallProfile({
      model: "openai/qwen3.6-flash-2026-04-16",
      stage: "segment_analysis",
      mode: "subject_proposal",
    })).toEqual({
      maxOutputTokens: 2048,
      stream: true,
      providerOptions: {
        openaiCompat: {
          enable_thinking: true,
          thinking_budget: 512,
        },
      },
    });
  });

  it("falls back to default profile for unknown models", () => {
    expect(resolveVlmCallProfile({
      model: "unknown-model",
      stage: "segment_analysis",
      mode: "vlm_only",
    })).toEqual({
      maxOutputTokens: 2048,
    });
  });

  it("keeps narrative sub-stage reasoning explicit", () => {
    expect(resolveVlmCallProfile({
      model: "gpt-5-mini",
      stage: "narrative_memory",
      mode: "schema_summary",
    })).toEqual({
      maxOutputTokens: 2048,
      reasoning: "low",
      stream: false,
    });

    expect(resolveVlmCallProfile({
      model: "gpt-5-mini",
      stage: "narrative_memory",
      mode: "chapter_summary",
    })).toEqual({
      maxOutputTokens: 2048,
      reasoning: "minimal",
      stream: false,
    });
  });
});
