// packages/percept/src/analyzers/vlm-analyzer.ts
import type { Frame, LlmCallContext } from "@cortex/shared";
import type { VlmOutput } from "../types.js";
import { buildVlmArchive } from "./vlm-analyzer/archive.js";
import { buildOrderedContentParts } from "./vlm-analyzer/content-parts.js";
import { VlmAnalysisError } from "./vlm-analyzer/errors.js";
import { parseJsonResponse, repairTruncatedJson } from "./vlm-analyzer/json.js";
import { VlmPromptBuilder } from "./vlm-analyzer/prompt-builder.js";
import { VlmTransport } from "./vlm-analyzer/transport.js";
import type {
  LlmCallRecorder,
  PromptContext,
  RawVlmResponse,
  ReasoningEffort,
  SubjectProposalContext,
  VlmAnalyzerOptions,
  VlmSegmentAnalysis,
  VlmSegmentAnalyzeOptions,
} from "./vlm-analyzer/types.js";

export { VlmAnalysisError } from "./vlm-analyzer/errors.js";
export type {
  LocalModelResults,
  PromptContext,
  ReasoningEffort,
  SubjectProposalContext,
  VlmAnalyzeOptions,
  VlmPartialField,
  VlmSegmentAnalysis,
  VlmSegmentAnalyzeOptions,
} from "./vlm-analyzer/types.js";

const ANALYZE_MAX_TOKENS = 2048;

/**
 * Cloud VLM analyzer supporting two API shapes:
 *
 * 1. **OpenAI-compatible** — /chat/completions with bearer auth.
 * 2. **Gemini API key** — generativelanguage.googleapis.com.
 */
export class VlmAnalyzer {
  private promptContext: PromptContext;
  private allowedUserRuleIds = new Set<string>();
  private promptBuilder: VlmPromptBuilder;
  private transport: VlmTransport;

  constructor(options: VlmAnalyzerOptions) {
    this.promptContext = options.promptContext ?? {};
    this.promptBuilder = new VlmPromptBuilder(this.promptContext);
    this.transport = new VlmTransport({
      provider: options.provider,
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      textModel: options.textModel,
      maxRetries: options.maxRetries,
      retryBaseDelayMs: options.retryBaseDelayMs,
      retryMaxDelayMs: options.retryMaxDelayMs,
      requestTimeoutMs: options.requestTimeoutMs,
      llmCallRecorder: options.llmCallRecorder,
      llmContext: options.llmContext,
      normalizeTitle: (title, fallbackSummary) => this.normalizeTitle(title, fallbackSummary),
    });
  }

  setLlmCallRecorder(recorder: LlmCallRecorder | undefined): void {
    this.transport.setLlmCallRecorder(recorder);
  }

  setLlmContext(context: LlmCallContext): void {
    this.transport.setLlmContext(context);
  }

  /** Updates user-defined rules injected into the VLM prompt. */
  setUserRules(rules: string | undefined): void {
    this.promptContext.userRules = rules;
    this.allowedUserRuleIds = this.extractRuleIds(rules);
  }

  /** Hot-updates user-configured prompt context (scene, focus, security rules). */
  setPromptContext(ctx: Partial<PromptContext>): void {
    if (ctx.sceneDescription !== undefined) this.promptContext.sceneDescription = ctx.sceneDescription;
    if (ctx.focusTargets !== undefined) this.promptContext.focusTargets = ctx.focusTargets;
    if (ctx.securityRules !== undefined) this.promptContext.securityRules = ctx.securityRules;
  }

  /**
   * Analyze one video segment using the configured VLM provider.
   *
   * When subjectProposal is present, frames are expected to include D{id}
   * annotations and the prompt requires the VLM to return target proposals.
   * Otherwise this is the VLM-only segment prompt.
   */
  async analyzeSegment(
    frames: Frame[],
    model: string,
    options: VlmSegmentAnalyzeOptions = {},
  ): Promise<VlmSegmentAnalysis> {
    const start = Date.now();

    const hasReferenceFrame = !!options.referenceFrameBase64;
    const attempts = this.subjectProposalAttempts(options);
    let lastErr: unknown;
    for (const attemptOptions of attempts) {
      const attemptFrames = attemptOptions.subjectProposal?.targetAggregation === "disabled" && attemptOptions.summaryOnlyFrames?.length
        ? attemptOptions.summaryOnlyFrames
        : frames;
      const effectiveFrames = this.withReferenceFrame(attemptFrames, attemptOptions.referenceFrameBase64);
      try {
        return await this.analyzeSegmentOnce(effectiveFrames, model, attemptOptions, hasReferenceFrame, start);
      } catch (err) {
        lastErr = err;
        if (!this.isSubjectProposalDegradableError(err)) throw err;
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private withReferenceFrame(frames: Frame[], referenceFrameBase64?: string): Frame[] {
    if (!referenceFrameBase64) return frames;
    const refFrame: Frame = { data: referenceFrameBase64, timestamp: 0, index: -1 };
    return [refFrame, ...frames];
  }

  private async analyzeSegmentOnce(
    effectiveFrames: Frame[],
    model: string,
    options: VlmSegmentAnalyzeOptions,
    hasReferenceFrame: boolean,
    start: number,
  ): Promise<VlmSegmentAnalysis> {
    const targetAggregation = options.subjectProposal?.targetAggregation ?? "enabled";
    const prompt = options.subjectProposal
      ? this.promptBuilder.buildSubjectProposalPrompt(options.subjectProposal.didContext, options)
      : this.promptBuilder.buildPrompt(
          effectiveFrames.length,
          options.sceneContext,
          options,
          hasReferenceFrame,
        );
    const extraImageHeader = options.subjectProposal
      ? "\nCurrent Event Story participant crop images. Each crop image represents the wm_target in the immediately preceding label. Use these crops to link current visible D{id} targets back to the same wm_target via matched_wm_target when the current target is visually the same person/animal:"
      : "\nPreviously seen anonymous subjects (compare visually with current targets):";
    const extraImages = options.subjectProposal
      ? this.promptBuilder.wmTargetImages(options.subjectProposal.wmTargets, { includeBehavior: options.runtimeMode !== "live_latency" })
      : this.promptBuilder.anonymousContextImages(options.anonymousSubjectContext);
    const contentParts = buildOrderedContentParts({
      prompt,
      frames: effectiveFrames,
      extraImageHeader,
      extraImages,
      subjectProposal: Boolean(options.subjectProposal),
    });

    const completion = await this.transport.complete({
      model,
      prompt,
      contentParts,
      frames: effectiveFrames,
      extraImageHeader,
      extraImages,
      extraImagesPlacement: options.subjectProposal ? "before_frames" : "after_frames",
      responseFormat: "json",
      maxTokens: options.maxTokens ?? ANALYZE_MAX_TOKENS,
      reasoningEffort: options.reasoningEffort,
      providerOptions: options.providerOptions,
      temperature: options.temperature,
      stage: "percept.analyze_segment",
      promptVersion: options.promptVersion,
      context: options.llmContext,
      stream: options.stream,
      onPartial: options.onPartial,
      hasDetectionContext: Boolean(options.subjectProposal) && targetAggregation !== "disabled",
      hasWorkingMemoryImages: Boolean(
        options.subjectProposal?.wmTargets?.some((target) => !!target.crop_base64 || !!target.crop_base64s?.length) || options.anonymousSubjectContext?.length,
      ),
      fallbackLayer: options.subjectProposal?.fallbackLayer ?? (options.subjectProposal ? this.inferSubjectProposalFallbackLayer(options.subjectProposal) : undefined),
      targetAggregation,
    });
    const providerRawText = completion.text;

    let parsed: RawVlmResponse;
    let repairApplied = false;
    const parseErrors: string[] = [];
    try {
      parsed = parseJsonResponse(providerRawText);
    } catch (err) {
      parseErrors.push(err instanceof Error ? err.message : String(err));
      // Attempt to repair truncated JSON by closing open strings/objects/arrays.
      repairApplied = true;
      try {
        parsed = parseJsonResponse(repairTruncatedJson(providerRawText));
      } catch (repairErr) {
        parseErrors.push(repairErr instanceof Error ? repairErr.message : String(repairErr));
        throw new VlmAnalysisError("VLM response JSON parse failed", {
          cause: repairErr,
          llmCall: completion.call,
          archive: buildVlmArchive({
            call: completion.call,
            rawText: providerRawText,
            normalizedJson: null,
            parseStatus: "error",
            repairApplied,
            errors: parseErrors,
          }),
        });
      }
    }

    let output: VlmOutput;
    const normalizedJson = JSON.stringify(parsed);
    try {
      output = this.toVlmOutput(parsed, {
        hasReferenceFrame,
      });
    } catch (err) {
      throw new VlmAnalysisError(err instanceof Error ? err.message : String(err), {
        cause: err,
        llmCall: completion.call,
        archive: buildVlmArchive({
          call: completion.call,
          rawText: providerRawText,
          normalizedJson,
          parseStatus: "error",
          repairApplied,
          errors: [...parseErrors, err instanceof Error ? err.message : String(err)],
        }),
      });
    }

    return {
      normalizedJson,
      rawText: providerRawText,
      output,
      latency_ms: Date.now() - start,
      llm_call: completion.call,
      archive: buildVlmArchive({
        call: completion.call,
        rawText: providerRawText,
        normalizedJson,
        parseStatus: "ok",
        repairApplied,
        errors: parseErrors,
      }),
      subject_proposal_context: options.subjectProposal
        ? {
            fallback_layer: options.subjectProposal.fallbackLayer ?? this.inferSubjectProposalFallbackLayer(options.subjectProposal),
            wm_target_ids: (options.subjectProposal.wmTargets ?? []).map((target) => target.target_id),
            wm_target_image_count: (options.subjectProposal.wmTargets ?? []).reduce((count, target) => count + (target.crop_base64s?.length ?? (target.crop_base64 ? 1 : 0)), 0),
            target_aggregation: options.subjectProposal.targetAggregation ?? "enabled",
          }
        : undefined,
    };
  }

  private subjectProposalAttempts(options: VlmSegmentAnalyzeOptions): VlmSegmentAnalyzeOptions[] {
    if (!options.subjectProposal) return [options];
    if (options.subjectProposal.targetAggregation === "disabled") {
      return [this.withSubjectProposalFallbackLayer(options, "summary_only")];
    }

    const targets = options.subjectProposal?.wmTargets;
    const attempts: VlmSegmentAnalyzeOptions[] = [];

    if (targets?.length) {
      const hasCrop = targets.some((target) => !!target.crop_base64 || !!target.crop_base64s?.length);
      const textOnlyTargets = targets.map(({ crop_base64: _crop_base64, crop_base64s: _crop_base64s, ...target }) => target);
      if (hasCrop) {
        attempts.push(this.withSubjectProposalFallbackLayer(options, "previous_targets_with_crops"));
      }
      attempts.push(this.withSubjectProposalFallbackLayer({
        ...options,
        subjectProposal: {
          ...options.subjectProposal,
          wmTargets: textOnlyTargets,
        },
      }, "previous_targets_text"));
    }

    attempts.push(this.withSubjectProposalFallbackLayer({
      ...options,
      subjectProposal: {
        didContext: options.subjectProposal.didContext,
      },
    }, "current_only_targets"));

    attempts.push(this.withSubjectProposalFallbackLayer({
      ...options,
      subjectProposal: {
        didContext: "",
        targetAggregation: "disabled",
      },
    }, "summary_only"));
    return attempts;
  }

  private withSubjectProposalFallbackLayer(
    options: VlmSegmentAnalyzeOptions,
    fallbackLayer: NonNullable<SubjectProposalContext["fallbackLayer"]>,
  ): VlmSegmentAnalyzeOptions {
    if (!options.subjectProposal) return options;
    return {
      ...options,
      subjectProposal: {
        ...options.subjectProposal,
        fallbackLayer,
      },
    };
  }

  private inferSubjectProposalFallbackLayer(context: SubjectProposalContext): NonNullable<SubjectProposalContext["fallbackLayer"]> {
    if (context.targetAggregation === "disabled") return "summary_only";
    if (!context.wmTargets?.length) return "current_only_targets";
    return context.wmTargets.some((target) => !!target.crop_base64 || !!target.crop_base64s?.length)
      ? "previous_targets_with_crops"
      : "previous_targets_text";
  }

  private isSubjectProposalDegradableError(err: unknown): boolean {
    const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
    return message.includes("content safety") ||
      message.includes("content_filter") ||
      message.includes("content filter") ||
      message.includes("content_policy") ||
      message.includes("policy_violation") ||
      message.includes("safety system") ||
      (message.includes("invalid prompt") && message.includes("usage policy")) ||
      message.includes("empty json response");
  }

  private toVlmOutput(
    parsed: RawVlmResponse,
    opts?: { hasReferenceFrame?: boolean },
  ): VlmOutput {
    const bestFrameIndex = parsed.best_frame_index;
    const normalizedBestFrameIndex = opts?.hasReferenceFrame && bestFrameIndex != null
      ? bestFrameIndex - 1
      : bestFrameIndex;

    const summary = parsed.summary?.trim() || parsed.detailed_summary?.trim();
    if (!summary) {
      throw new Error("VLM response missing summary");
    }
    const title = this.normalizeTitle(parsed.title, summary);
    const detailedSummary = parsed.detailed_summary?.trim() || summary;
    const retrievalCompact = this.normalizeRetrievalCompact(parsed.retrieval_compact);
    const targetDetails = this.indexTargetDetails(parsed.target_details);

    return {
      title,
      summary,
      detailed_summary: detailedSummary,
      retrieval_compact: retrievalCompact,
      security_risk: parsed.security_risk ?? false,
      security_reason: parsed.security_reason ?? undefined,
      is_static_scene: parsed.is_static_scene ?? false,
      notify_user: parsed.notify_user ?? false,
      best_frame_index: normalizedBestFrameIndex != null && normalizedBestFrameIndex >= 0
        ? normalizedBestFrameIndex
        : undefined,
      main_targets: (parsed.main_targets ?? []).map((t, index) => {
        const details = this.findTargetDetails(targetDetails, t.track_id, index);
        return {
          type: t.type ?? "unknown",
          appearance: t.appearance ?? details?.appearance ?? "",
          behavior: t.behavior ?? details?.behavior,
          interaction: t.interaction ?? details?.interaction,
          track_id: t.track_id,
          matched_anonymous_subject_id: t.matched_anonymous_subject_id,
          match_confidence: t.match_confidence,
          ...(t.identity?.name?.trim()
            ? {
                identity: {
                  name: t.identity.name.trim(),
                  ...(t.identity.evidence?.trim() ? { evidence: t.identity.evidence.trim() } : {}),
                  ...(t.identity.source ? { source: t.identity.source } : {}),
                },
              }
            : {}),
          ...(Array.isArray(t.speaker_ids)
            ? { speaker_ids: [...new Set(t.speaker_ids.map((id) => id.trim()).filter(Boolean))] }
            : {}),
        };
      }),
      custom_fields: parsed.custom_fields ?? undefined,
      matched_rule_ids: this.normalizeMatchedRuleIds(parsed.matched_rule_ids),
      segment_policy_exit_met: parsed.segment_policy_exit_met,
      content_type: parsed.content_type as VlmOutput["content_type"],
      key_modality: parsed.key_modality as VlmOutput["key_modality"],
      event_boundary: parsed.event_boundary ?? false,
      event_summary: this.normalizeEventSummary(parsed.event_summary),
      event_context_update: parsed.event_context_update,
      raw_response: JSON.stringify(parsed),
    };
  }

  private indexTargetDetails(details: RawVlmResponse["target_details"]): {
    byRef: Map<string, NonNullable<RawVlmResponse["target_details"]>[number]>;
    byIndex: Array<NonNullable<RawVlmResponse["target_details"]>[number]>;
  } {
    const byRef = new Map<string, NonNullable<RawVlmResponse["target_details"]>[number]>();
    const byIndex: Array<NonNullable<RawVlmResponse["target_details"]>[number]> = [];
    for (const detail of details ?? []) {
      if (!detail || typeof detail !== "object") continue;
      byIndex.push(detail);
      for (const ref of [detail.target_ref, detail.track_id, detail.bbox_id]) {
        const key = typeof ref === "string" ? ref.trim() : "";
        if (key) byRef.set(key, detail);
      }
    }
    return { byRef, byIndex };
  }

  private findTargetDetails(
    details: ReturnType<VlmAnalyzer["indexTargetDetails"]>,
    trackId: string | undefined,
    index: number,
  ): NonNullable<RawVlmResponse["target_details"]>[number] | undefined {
    const key = trackId?.trim();
    if (key && details.byRef.has(key)) return details.byRef.get(key);
    return details.byIndex[index];
  }

  private normalizeEventSummary(summary: string | undefined): string | undefined {
    const normalized = (summary ?? "").replace(/\s+/g, " ").trim();
    return normalized || undefined;
  }

  private normalizeRetrievalCompact(value: string[] | string | undefined): string[] | undefined {
    const rawItems = Array.isArray(value) ? value : (typeof value === "string" ? value.split(/[;\n]/) : []);
    const items = rawItems
      .map((item) => typeof item === "string" ? item.replace(/\s+/g, " ").trim() : "")
      .filter(Boolean)
      .slice(0, 8)
      .map((item) => item.split(/\s+/).slice(0, 8).join(" "));
    return items.length > 0 ? items : undefined;
  }

  private normalizeTitle(title: string | undefined, fallbackSummary: string): string {
    const toTitleCase = (value: string): string => value
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => {
        const lower = word.toLocaleLowerCase();
        return lower.charAt(0).toLocaleUpperCase() + lower.slice(1);
      })
      .join(" ");
    const cleanWords = (value: string): string[] => value
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const words = cleanWords(title ?? "").slice(0, 3);
    if (words.length >= 2) {
      return toTitleCase(words.join(" "));
    }
    const fallbackWords = cleanWords(fallbackSummary).slice(0, 3);
    if (fallbackWords.length >= 2) return toTitleCase(fallbackWords.join(" "));
    return "Observed Activity";
  }

  private extractRuleIds(rules: string | undefined): Set<string> {
    const out = new Set<string>();
    if (!rules) return out;
    for (const line of rules.split(/\r?\n/)) {
      const marker = "rule_id=";
      const markerIndex = line.indexOf(marker);
      if (markerIndex < 0) continue;
      const rest = line.slice(markerIndex + marker.length).trim();
      const delimiterIndex = rest.indexOf(": ");
      const rawId = delimiterIndex >= 0 ? rest.slice(0, delimiterIndex) : rest.split(/\s+/)[0];
      const id = rawId?.trim();
      if (id) out.add(id);
    }
    return out;
  }

  private normalizeMatchedRuleIds(raw: unknown): string[] | undefined {
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    if (this.allowedUserRuleIds.size === 0) return undefined;
    const out: string[] = [];
    for (const item of raw) {
      if (typeof item !== "string") continue;
      const id = item.trim();
      if (!id || out.includes(id)) continue;
      if (!this.allowedUserRuleIds.has(id)) continue;
      out.push(id);
    }
    return out.length > 0 ? out : undefined;
  }

  /** Text-only completion through the shared provider transport. */
  async completeText(
    prompt: string,
    options?: {
      responseFormat?: "json" | "text";
      maxTokens?: number;
      reasoningEffort?: ReasoningEffort;
      providerOptions?: {
        openaiCompat?: Record<string, unknown>;
      };
      temperature?: number;
      model?: string;
      stage?: string;
      promptVersion?: string;
      llmContext?: LlmCallContext;
    },
  ): Promise<string> {
    return this.transport.completeText(prompt, options);
  }

  /**
   * Text-only completion — direct API call, no images, plain text response.
   * Defaults are tuned for short NarrativeMemory text maintenance. Callers that
   * need complete longer documents should raise maxTokens.
   */
  async compressText(prompt: string, options?: {
    maxTokens?: number;
    reasoningEffort?: ReasoningEffort;
    temperature?: number;
    stage?: string;
    promptVersion?: string;
    llmContext?: LlmCallContext;
  }): Promise<string> {
    return this.completeText(prompt, {
      ...options,
      responseFormat: "text",
    });
  }


}
