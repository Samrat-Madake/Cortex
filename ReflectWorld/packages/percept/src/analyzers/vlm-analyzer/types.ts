import type { Frame, LlmCallContext, LlmCallRecord } from "@cortex/shared";
import type { VlmEventContextUpdate, VlmOutput, VlmTargetIdentity } from "../../types.js";

export interface RawVlmResponse {
  title?: string;
  summary?: string;
  detailed_summary?: string;
  retrieval_compact?: string[] | string;
  security_risk?: boolean;
  security_reason?: string | null;
  is_static_scene?: boolean;
  notify_user?: boolean;
  matched_rule_ids?: unknown;
  best_frame_index?: number;
  main_targets?: Array<{
    type?: string;
    appearance?: string;
    behavior?: string;
    interaction?: string;
    track_id?: string;
    matched_anonymous_subject_id?: string | null;
    match_confidence?: number;
    identity?: VlmTargetIdentity;
    speaker_ids?: string[];
  }>;
  target_details?: Array<{
    target_ref?: string;
    track_id?: string;
    bbox_id?: string;
    appearance?: string;
    behavior?: string;
    interaction?: string;
    identity?: VlmTargetIdentity;
    speaker_ids?: string[];
  }>;
  custom_fields?: Record<string, string | number | boolean>;
  segment_policy_exit_met?: boolean;
  content_type?: string;
  key_modality?: string;
  event_boundary?: boolean;
  event_summary?: string;
  event_context_update?: VlmEventContextUpdate;
}

// ── Gemini types ──

export interface GeminiRequest {
  contents: Array<{
    role: string;
    parts: Array<
      | { text: string }
      | { inline_data: { mime_type: string; data: string } }
    >;
  }>;
  generationConfig: {
    responseMimeType?: string;
    maxOutputTokens?: number;
    temperature?: number;
  };
}

export interface GeminiResponse {
  candidates?: Array<{
    finishReason?: string;
    safetyRatings?: unknown;
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  promptFeedback?: unknown;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
}

// ── OpenAI types ──

export type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } };

export interface OpenAIRequest {
  model: string;
  messages: Array<{
    role: string;
    content: string | OpenAIContentPart[];
  }>;
  response_format?: { type: string };
  max_tokens?: number;
  max_completion_tokens?: number;
  reasoning_effort?: ReasoningEffort;
  temperature?: number;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  [key: string]: unknown;
}

export interface OpenAIResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string;
      refusal?: string | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
}

export interface CompletionImage {
  base64: string;
  label?: string;
}

export type CompletionContentPart =
  | { type: "text"; text: string }
  | { type: "image"; base64: string; detail?: "high" };

export interface CompletionRequest {
  model: string;
  prompt: string;
  /** Ordered multimodal content. When present, this is sent instead of prompt/frames/extraImages. */
  contentParts?: CompletionContentPart[];
  frames?: Frame[];
  extraImageHeader?: string;
  extraImages?: CompletionImage[];
  extraImagesPlacement?: "before_frames" | "after_frames";
  responseFormat: "json" | "text";
  maxTokens: number;
  reasoningEffort?: ReasoningEffort;
  providerOptions?: {
    openaiCompat?: Record<string, unknown>;
  };
  temperature?: number;
  stage: string;
  promptVersion?: string;
  context?: LlmCallContext;
  hasDetectionContext?: boolean;
  hasWorkingMemoryImages?: boolean;
  fallbackLayer?: string;
  targetAggregation?: string;
  stream?: boolean;
  onPartial?: (partial: VlmPartialField) => void | Promise<void>;
}

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface VlmPartialField {
  field: string;
  value: unknown;
  /** Unix ms timestamp when this complete field was emitted from the stream parser. */
  received_at?: number;
  /** Unix ms timestamp when the upstream VLM request started. */
  request_started_at?: number;
  /** Request start to first SSE data chunk. */
  ttft_ms?: number;
  /** Request start to first non-empty content delta. */
  first_content_ms?: number;
}

export interface StreamTimingMeta {
  requestStartedAt: number;
  firstChunkAt?: number;
  firstContentAt?: number;
}

export interface CompletionResult {
  text: string;
  call: LlmCallRecord;
}

export type LlmCallRecorder = (call: LlmCallRecord) => void;

/** Results from local models injected into VLM prompt for contextual analysis. */
export interface VlmAnalyzeOptions {
  /** Runtime mode controls streaming-oriented output contracts. Default offline_quality preserves benchmark behavior. */
  runtimeMode?: "offline_quality" | "live_latency";
  localModelResults?: LocalModelResults;
  skipBestFrameSelection?: boolean;
  segmentPolicyExitPrompt?: string;
  suppressSceneDescription?: boolean;
  /** Object states to track (from Semantic Context "Track States" section). */
  trackStates?: string[];
  /** Activity labels to report (from Semantic Context "Track Activities" section). */
  trackActivities?: string[];
  /** Semantic Context has Anomaly Baseline — instruct VLM to flag deviations. */
  hasAnomalyBaseline?: boolean;
  /** Base64 reference frame for teach-by-example comparison. */
  referenceFrameBase64?: string;
  /** VLM-maintained summary for the current event before this segment. */
  currentEventSummary?: string;
  /** Latest segment summaries from the current event, newest last. */
  recentSegmentSummaries?: string[];
  /** Lightweight structured event context maintained by WorkingMemory. */
  currentEventContext?: string;
  /** Anonymous subject crops + descriptions for cross-segment visual matching. */
  anonymousSubjectContext?: Array<{
    anonymous_subject_id: string;
    class_name: string;
    appearance: string;
    /** Base64-encoded JPEG crop thumbnail. */
    crop_base64: string;
  }>;
}

export interface SubjectProposalContext {
  /** Text list of D{id} detections drawn on the provided frames. */
  didContext: string;
  /** Disable target aggregation in the last-resort fallback; keep segment descriptions only. */
  targetAggregation?: "enabled" | "disabled";
  /** Internal fallback layer used for logging and downstream parsing semantics. */
  fallbackLayer?: "previous_targets_with_crops" | "previous_targets_text" | "current_only_targets" | "summary_only";
  /** Prior working-memory targets that the VLM may match current targets against. */
  wmTargets?: Array<{
    target_id: string;
    class_name: string;
    entity_id?: string;
    continuity_strength?: "weak_visual" | "stable_visual" | "identity";
    appearance: string;
    history_behavior?: string;
    behavior?: string;
    /** Event-local known name inferred from dialogue, if available. */
    identity?: {
      name: string;
      evidence?: string;
    };
    /** Weak prior dialogue clues; useful for later confirmation, not stable identity facts. */
    identity_hints?: Array<{
      name: string;
      evidence?: string;
      source?: VlmTargetIdentity["source"];
    }>;
    /** Optional JPEG crop thumbnail. Text appearance is the primary matching signal. */
    crop_base64?: string;
    /** Optional stable JPEG crop thumbnails in continuity order. */
    crop_base64s?: string[];
  }>;
}

export interface VlmSegmentAnalyzeOptions extends VlmAnalyzeOptions {
  /** Camera profile, recent notifications, and other session-level context. */
  sceneContext?: string;
  /** Present when frames include D{id} annotations from local detections. */
  subjectProposal?: SubjectProposalContext;
  /** Raw/unannotated frames used by the summary-only fallback. */
  summaryOnlyFrames?: Frame[];
  /** Optional logging context attached to LLM call records. */
  llmContext?: LlmCallContext;
  /** Prompt/version identifier. Usually the git commit id for benchmark runs. */
  promptVersion?: string;
  /** Internal output budget. Provider adapters translate this to provider-specific API fields. */
  maxTokens?: number;
  /** Optional OpenAI reasoning effort. Omit to use the model/provider default. */
  reasoningEffort?: ReasoningEffort;
  /** Provider-specific request body extensions. */
  providerOptions?: {
    openaiCompat?: Record<string, unknown>;
  };
  /** Optional sampling temperature. Omit to use the model/provider default. */
  temperature?: number;
  /** Stream response chunks and emit complete partial fields as they arrive. */
  stream?: boolean;
  /** Called when a streamed field value is complete. */
  onPartial?: (partial: VlmPartialField) => void | Promise<void>;
}

export interface VlmSegmentAnalysis {
  /** Parsed and repaired JSON serialized back to a stable string. */
  normalizedJson: string;
  /** Provider raw text before JSON repair/normalization. */
  rawText: string;
  output: VlmOutput;
  latency_ms: number;
  llm_call?: LlmCallRecord;
  archive?: Record<string, unknown>;
  subject_proposal_context?: {
    fallback_layer: "previous_targets_with_crops" | "previous_targets_text" | "current_only_targets" | "summary_only";
    wm_target_ids: string[];
    wm_target_image_count: number;
    target_aggregation: "enabled" | "disabled";
  };
}

/** Local subject evidence injected into the VLM prompt.
 *  The `tracks` option key is retained for prompt API compatibility; these are
 *  temporary segment subject labels, not persistent tracker state. */
export interface LocalSubjectInput {
  track_id: string;
  class_name: string;
  keyframe_idx?: number;
  keyframe_bbox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  entity_id?: string;
  is_new?: boolean;
  history_behavior?: string;
  prior_appearance?: string;
  prior_behavior?: string;
  displacement_px?: { dx: number; dy: number };
}

export interface LocalModelResults {
  /** Segment-local subject labels for prompt grounding; not persistent tracker state. */
  tracks?: LocalSubjectInput[];
  /** Timestamped transcript from STT for VLM context. */
  sttTranscript?: string;
  /** True when STT provides speaker diarization (e.g. ElevenLabs). Changes the VLM prompt
   *  from per-line speaker attribution to a simpler speaker→target mapping task. */
  hasSpeakerDiarization?: boolean;
}

/** User-configurable prompt context injected into the base prompt. */
export interface PromptContext {
  /** Describes the camera's scene, e.g. "Front door camera overlooking the porch". */
  sceneDescription?: string;
  /** Targets to pay extra attention to, e.g. "packages, pets, unfamiliar vehicles". */
  focusTargets?: string;
  /** Custom security criteria, e.g. "No one should be on the property after 10pm". */
  securityRules?: string;
  /** User-defined rules from Cortex procedural collection, merged into analysis context. */
  userRules?: string;
}

export interface BaseVlmOptions {
  promptContext?: PromptContext;
  /** Text-only model used by compressText(). */
  textModel: string;
  /**
   * Max retry count after the first attempt.
   * Example: 2 means up to 3 total attempts.
   */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff. */
  retryBaseDelayMs?: number;
  /** Max backoff delay in ms. */
  retryMaxDelayMs?: number;
  /** Per-request timeout in ms for VLM API calls. */
  requestTimeoutMs?: number;
  /** Optional sink for LLM call records. */
  llmCallRecorder?: LlmCallRecorder;
  /** Default context merged into all LLM call records. */
  llmContext?: LlmCallContext;
}

/** Options for Gemini API key mode. */
export interface GeminiApiKeyOptions extends BaseVlmOptions {
  provider: "gemini";
  apiKey: string;
  baseUrl?: string;
}

/** Options for OpenAI-compatible mode, including LiteLLM/vLLM/SGLang proxies. */
export interface OpenAIOptions extends BaseVlmOptions {
  provider: "openai";
  apiKey: string;
  baseUrl: string;
}

export type VlmAnalyzerOptions = GeminiApiKeyOptions | OpenAIOptions;
