import type { ReasoningEffort, VlmSegmentAnalyzeOptions } from "./analyzers/vlm-analyzer.js";

export type VlmCallStage =
  | "segment_analysis"
  | "semantic_context"
  | "narrative_memory"
  | "dashboard_chat"
  | "benchmark_consultation"
  | "agent_qa";

export type VlmCallMode =
  | "default"
  | "subject_proposal"
  | "vlm_only"
  | "summary_only"
  | "schema_summary"
  | "chapter_summary";

export interface VlmCallProfile {
  /** Internal output budget. Provider adapters translate this to provider-specific API fields. */
  maxOutputTokens?: number;
  /** Internal reasoning hint. Provider adapters drop it when unsupported. */
  reasoning?: ReasoningEffort;
  /** Internal sampling hint. Provider adapters drop it when unsupported. */
  temperature?: number;
  /** Whether this call should stream if the caller supports streaming. */
  stream?: boolean;
  /** Provider-specific request body extensions. Adapters only pass through supported sections. */
  providerOptions?: {
    openaiCompat?: Record<string, unknown>;
  };
}

export interface VlmModelProfile {
  model: string;
  stages: Partial<Record<VlmCallStage, VlmCallProfile & {
    modes?: Partial<Record<VlmCallMode, VlmCallProfile>>;
  }>>;
}

const DEFAULT_SEGMENT_TOKENS = 2048;
const DEFAULT_TEXT_TOKENS = 2048;
const DEFAULT_DASHBOARD_CHAT_TOKENS = 1200;

export const DEFAULT_VLM_CALL_PROFILE: VlmModelProfile = {
  model: "default",
  stages: {
    segment_analysis: {
      maxOutputTokens: DEFAULT_SEGMENT_TOKENS,
      modes: {
        subject_proposal: { maxOutputTokens: DEFAULT_SEGMENT_TOKENS },
        vlm_only: { maxOutputTokens: DEFAULT_SEGMENT_TOKENS },
        summary_only: { maxOutputTokens: DEFAULT_SEGMENT_TOKENS },
      },
    },
    semantic_context: { maxOutputTokens: DEFAULT_TEXT_TOKENS, stream: false },
    narrative_memory: {
      maxOutputTokens: DEFAULT_TEXT_TOKENS,
      stream: false,
      modes: {
        schema_summary: { maxOutputTokens: DEFAULT_TEXT_TOKENS, stream: false },
        chapter_summary: { maxOutputTokens: DEFAULT_TEXT_TOKENS, stream: false },
      },
    },
    dashboard_chat: { maxOutputTokens: DEFAULT_DASHBOARD_CHAT_TOKENS, stream: false },
    benchmark_consultation: { maxOutputTokens: 2048, stream: false },
    agent_qa: { maxOutputTokens: 2048, stream: false },
  },
};

export const GPT_5_MINI_VLM_CALL_PROFILE: VlmModelProfile = {
  model: "gpt-5-mini",
  stages: {
    segment_analysis: {
      maxOutputTokens: DEFAULT_SEGMENT_TOKENS,
      reasoning: "minimal",
      stream: true,
      modes: {
        subject_proposal: {
          maxOutputTokens: DEFAULT_SEGMENT_TOKENS,
          reasoning: "minimal",
        },
        vlm_only: {
          maxOutputTokens: DEFAULT_SEGMENT_TOKENS,
          reasoning: "minimal",
        },
        summary_only: {
          maxOutputTokens: DEFAULT_SEGMENT_TOKENS,
          reasoning: "minimal",
        },
      },
    },
    semantic_context: {
      maxOutputTokens: DEFAULT_TEXT_TOKENS,
      reasoning: "low",
      stream: false,
    },
    narrative_memory: {
      maxOutputTokens: DEFAULT_TEXT_TOKENS,
      reasoning: "minimal",
      stream: false,
      modes: {
        schema_summary: {
          maxOutputTokens: DEFAULT_TEXT_TOKENS,
          reasoning: "low",
          stream: false,
        },
        chapter_summary: {
          maxOutputTokens: DEFAULT_TEXT_TOKENS,
          reasoning: "minimal",
          stream: false,
        },
      },
    },
    dashboard_chat: {
      maxOutputTokens: DEFAULT_DASHBOARD_CHAT_TOKENS,
      reasoning: "minimal",
      stream: false,
    },
    benchmark_consultation: {
      maxOutputTokens: 2048,
      reasoning: "low",
      stream: false,
    },
    agent_qa: {
      maxOutputTokens: 2048,
      reasoning: "low",
      stream: false,
    },
  },
};

export const GPT_5_4_MINI_VLM_CALL_PROFILE: VlmModelProfile = {
  model: "gpt-5.4-mini",
  stages: {
    segment_analysis: {
      maxOutputTokens: DEFAULT_SEGMENT_TOKENS,
      reasoning: "none",
      stream: true,
      modes: {
        subject_proposal: {
          maxOutputTokens: DEFAULT_SEGMENT_TOKENS,
          reasoning: "none",
        },
        vlm_only: {
          maxOutputTokens: DEFAULT_SEGMENT_TOKENS,
          reasoning: "none",
        },
        summary_only: {
          maxOutputTokens: DEFAULT_SEGMENT_TOKENS,
          reasoning: "none",
        },
      },
    },
    semantic_context: {
      maxOutputTokens: DEFAULT_TEXT_TOKENS,
      reasoning: "low",
      stream: false,
    },
    narrative_memory: {
      maxOutputTokens: DEFAULT_TEXT_TOKENS,
      reasoning: "none",
      stream: false,
      modes: {
        schema_summary: {
          maxOutputTokens: DEFAULT_TEXT_TOKENS,
          reasoning: "low",
          stream: false,
        },
        chapter_summary: {
          maxOutputTokens: DEFAULT_TEXT_TOKENS,
          reasoning: "none",
          stream: false,
        },
      },
    },
    dashboard_chat: {
      maxOutputTokens: DEFAULT_DASHBOARD_CHAT_TOKENS,
      reasoning: "none",
      stream: false,
    },
    benchmark_consultation: {
      maxOutputTokens: 2048,
      reasoning: "low",
      stream: false,
    },
    agent_qa: {
      maxOutputTokens: 2048,
      reasoning: "low",
      stream: false,
    },
  },
};

export const QWEN_3_6_FLASH_VLM_CALL_PROFILE: VlmModelProfile = {
  model: "qwen3.6-flash",
  stages: {
    segment_analysis: {
      maxOutputTokens: DEFAULT_SEGMENT_TOKENS,
      stream: true,
      providerOptions: {
        openaiCompat: {
          enable_thinking: true,
          thinking_budget: 512,
        },
      },
      modes: {
        subject_proposal: {
          maxOutputTokens: DEFAULT_SEGMENT_TOKENS,
          providerOptions: {
            openaiCompat: {
              enable_thinking: true,
              thinking_budget: 512,
            },
          },
        },
        vlm_only: {
          maxOutputTokens: DEFAULT_SEGMENT_TOKENS,
          providerOptions: {
            openaiCompat: {
              enable_thinking: true,
              thinking_budget: 512,
            },
          },
        },
        summary_only: {
          maxOutputTokens: DEFAULT_SEGMENT_TOKENS,
          providerOptions: {
            openaiCompat: {
              enable_thinking: true,
              thinking_budget: 512,
            },
          },
        },
      },
    },
  },
};

const BUILTIN_PROFILES = [
  GPT_5_4_MINI_VLM_CALL_PROFILE,
  GPT_5_MINI_VLM_CALL_PROFILE,
  QWEN_3_6_FLASH_VLM_CALL_PROFILE,
];

function normalizeModelName(model: string): string {
  const lastPathPart = model.split("/").at(-1) ?? model;
  return lastPathPart.trim().toLowerCase();
}

function resolveModelProfile(model: string): VlmModelProfile {
  const normalized = normalizeModelName(model);
  return BUILTIN_PROFILES.find((profile) => matchesModelProfile(normalized, normalizeModelName(profile.model)))
    ?? DEFAULT_VLM_CALL_PROFILE;
}

function matchesModelProfile(model: string, profileModel: string): boolean {
  return model === profileModel || model.startsWith(`${profileModel}-`);
}

export function resolveVlmCallProfile(input: {
  model: string;
  stage: VlmCallStage;
  mode?: VlmCallMode;
}): VlmCallProfile {
  const profile = resolveModelProfile(input.model);
  const defaults = DEFAULT_VLM_CALL_PROFILE.stages[input.stage] ?? {};
  const stageProfile = profile.stages[input.stage] ?? defaults;
  const mode = input.mode ?? "default";
  const defaultModeProfile = defaults.modes?.[mode] ?? {};
  const modeProfile = stageProfile.modes?.[mode] ?? defaultModeProfile;
  const { modes: _defaultModes, ...defaultStageProfile } = defaults;
  const { modes: _stageModes, ...stageBaseProfile } = stageProfile;
  const resolved = {
    ...defaultStageProfile,
    ...defaultModeProfile,
    ...stageBaseProfile,
    ...modeProfile,
  };
  const benchmarkSegmentReasoning = benchmarkSegmentReasoningOverride(input.stage);
  return benchmarkSegmentReasoning
    ? { ...resolved, reasoning: benchmarkSegmentReasoning }
    : resolved;
}

function benchmarkSegmentReasoningOverride(stage: VlmCallStage): ReasoningEffort | undefined {
  if (stage !== "segment_analysis") return undefined;
  const value = process.env.BENCH_VLM_SEGMENT_REASONING_EFFORT?.trim().toLowerCase();
  if (value === "none" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh") return value;
  return undefined;
}

export function applyVlmCallProfile(
  options: Partial<VlmSegmentAnalyzeOptions>,
  profile: VlmCallProfile,
): Partial<VlmSegmentAnalyzeOptions> {
  return {
    ...options,
    ...(profile.maxOutputTokens == null ? {} : { maxTokens: profile.maxOutputTokens }),
    ...(profile.reasoning == null ? {} : { reasoningEffort: profile.reasoning }),
    ...(profile.temperature == null ? {} : { temperature: profile.temperature }),
    ...(profile.providerOptions == null ? {} : { providerOptions: profile.providerOptions }),
  };
}
