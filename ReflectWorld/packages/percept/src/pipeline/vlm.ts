import { writeStderr, type Segment, type PipelineTrace } from "@reflectworld/shared";
import { VlmAnalysisError, type VlmAnalyzer, type VlmSegmentAnalyzeOptions } from "../analyzers/vlm-analyzer.js";
import type { AnalyzerResult, DetectionOutput, SttOutput } from "../types.js";
import type { VlmFrameResizeOptions } from "./types.js";
import { hasSpeakerDiarization } from "./live-latency.js";
import { resizeFramesForVlm } from "./vlm-frames.js";

type VlmGateDecision = NonNullable<NonNullable<PipelineTrace["context"]["decision_context"]>["vlm_gate"]>;

/** Parsed intelligence sections from serialized Semantic Context prompt text. */
export interface SemanticContextSections {
  /** Full content for sceneContext injection (everything except intelligence directives). */
  profileContent: string;
  /** Items to track state changes for (e.g. "door: open/closed"). */
  trackStates?: string[];
  /** Activity labels to report (e.g. "cooking, resting, exercising"). */
  trackActivities?: string[];
  /** Anomaly baseline present - instruct VLM to flag deviations. */
  hasAnomalyBaseline: boolean;
  /** Explain decisions flag - attach VC reasoning to notifications. */
  explainDecisions: boolean;
}

/**
 * Parse serialized Semantic Context text into structured sections.
 * Intelligence directives (Track States, Track Activities, etc.) are extracted
 * as structured data and NOT included in the raw profile content sent to VLM,
 * to keep the prompt lean. They are injected as targeted prompt fragments instead.
 */
export function parseSemanticContextSections(content: string): SemanticContextSections {
  const lines = content.split("\n");
  const profileLines: string[] = [];
  let trackStates: string[] | undefined;
  let trackActivities: string[] | undefined;
  let hasAnomalyBaseline = false;
  let explainDecisions = false;
  let currentSection = "";

  for (const line of lines) {
    const headerMatch = line.match(/^##\s+(.+)/);
    if (headerMatch) {
      currentSection = headerMatch[1]!.trim().toLowerCase();
      // Keep profile sections in output, skip directive sections.
      if (currentSection === "track states" || currentSection === "track activities" || currentSection === "explain decisions") {
        continue;
      }
      if (currentSection === "anomaly baseline") {
        hasAnomalyBaseline = true;
      }
    }

    if (currentSection === "track states") {
      const item = line.replace(/^[-*]\s*/, "").trim();
      if (item) {
        if (!trackStates) trackStates = [];
        trackStates.push(item);
      }
    } else if (currentSection === "track activities") {
      const item = line.replace(/^[-*]\s*/, "").trim();
      if (item) {
        if (!trackActivities) trackActivities = [];
        trackActivities.push(item);
      }
    } else if (currentSection === "explain decisions") {
      if (line.toLowerCase().includes("true") || line.toLowerCase().includes("enabled")) {
        explainDecisions = true;
      }
    } else {
      profileLines.push(line);
    }
  }

  return {
    profileContent: profileLines.join("\n").trim(),
    trackStates,
    trackActivities,
    hasAnomalyBaseline,
    explainDecisions,
  };
}

/**
 * Format STT result as structured dialogue JSON for VLM context.
 * Matches the reference `dialogue_lines_json` format.
 */
export function formatSttForVlm(sttData: SttOutput | undefined): string | undefined {
  if (!sttData?.segments?.length) return undefined;
  const lines = sttData.segments
    .filter((s) => s.text.trim())
    .map((s) => {
      const startTime = +(s.start / 16000).toFixed(2);
      const endTime = s.end != null ? +(s.end / 16000).toFixed(2) : undefined;
      const line: Record<string, unknown> = {
        text: s.text.trim(),
        start_time: startTime,
      };
      if (endTime != null) line.end_time = endTime;
      // When diarization is available, output explicit speaker_id for VLM matching.
      if (s.speaker) {
        line.speaker_id = s.speaker;  // "speaker_0", "speaker_1", etc.
      }
      if (s.entity_id) {
        line.entity_id = s.entity_id;
      }
      return line;
    });
  return JSON.stringify(lines, null, 2);
}

export function buildVlmOnlySegmentOptions(input: {
  sttData?: SttOutput;
  sceneContext?: string;
  segmentPolicyExitPrompt?: string;
  suppressSceneDescription?: boolean;
  semanticContextSections?: SemanticContextSections;
  currentEventSummary?: string;
  recentSegmentSummaries?: string[];
  currentEventContext?: string;
  referenceFrameBase64?: string;
  vlmCallOptions: Partial<VlmSegmentAnalyzeOptions>;
}): VlmSegmentAnalyzeOptions {
  const opts: VlmSegmentAnalyzeOptions = {
    sceneContext: input.sceneContext || undefined,
    ...input.vlmCallOptions,
  };
  if (input.segmentPolicyExitPrompt) opts.segmentPolicyExitPrompt = input.segmentPolicyExitPrompt;
  if (input.suppressSceneDescription) opts.suppressSceneDescription = true;
  if (input.semanticContextSections?.trackStates?.length) opts.trackStates = input.semanticContextSections.trackStates;
  if (input.semanticContextSections?.trackActivities?.length) opts.trackActivities = input.semanticContextSections.trackActivities;
  if (input.semanticContextSections?.hasAnomalyBaseline) opts.hasAnomalyBaseline = true;
  if (input.currentEventSummary) opts.currentEventSummary = input.currentEventSummary;
  if (input.recentSegmentSummaries?.length) opts.recentSegmentSummaries = input.recentSegmentSummaries;
  if (input.currentEventContext) opts.currentEventContext = input.currentEventContext;
  if (input.referenceFrameBase64) opts.referenceFrameBase64 = input.referenceFrameBase64;
  const sttTranscript = formatSttForVlm(input.sttData);
  if (sttTranscript) {
    opts.localModelResults = {
      sttTranscript,
      hasSpeakerDiarization: hasSpeakerDiarization(input.sttData),
    };
  }
  return opts;
}

/** Inputs for VLM gate decision. */
export interface VlmGateInput {
  eventHint: string | undefined;
  multiFrameDetections: DetectionOutput[] | undefined;
  detData: DetectionOutput | undefined;
  sttData: SttOutput | undefined;
  vadSpeechObserved: boolean;
  sttAvailable: boolean;
  /** True when STT ran but failed (e.g. ElevenLabs API error). Audio content is unverified. */
  sttFailed: boolean;
  strategyRunVlm: boolean;
  isColdStart: boolean;
}

/** Result of VLM gate decision. */
export interface VlmGateResult {
  skipVlm: boolean;
  localStaticScene: boolean;
  willAttemptVlm: boolean;
  decision: VlmGateDecision;
}

function isIdleSegmentHint(eventHint: string | undefined): boolean {
  return eventHint === "idle_window" || eventHint === "fixed_window_idle";
}

function hasMeaningfulTranscript(sttData: SttOutput | undefined): boolean {
  return Boolean(sttData?.transcript?.trim());
}

/**
 * Determine whether to skip the VLM call based on idle scene heuristics,
 * audio content, detection presence, and cold start rules.
 *
 * Shared by both Subject Proposal and VLM-only fallback paths.
 */
export function resolveVlmGate(input: VlmGateInput): VlmGateResult {
  const { eventHint, multiFrameDetections, detData, sttData, vadSpeechObserved, sttAvailable, sttFailed, strategyRunVlm, isColdStart } = input;

  const isIdleScene = isIdleSegmentHint(eventHint);
  const detFrames = multiFrameDetections ?? (detData ? [detData] : []);
  // Idle gate only considers person detections - static vehicles/animals in
  // idle segments are not worth a VLM call (cost optimization).
  const hasRelevantDetections = detFrames.some(d =>
    d.detections.some(det => det.label.toLowerCase() === "person"),
  );
  const hasAudioContent = hasMeaningfulTranscript(sttData);
  const relevantDetectionCount = detFrames
    .reduce((sum, d) => sum + d.detections.filter(det => det.label.toLowerCase() === "person").length, 0);

  let skipVlm = false;
  let localStaticScene = false;

  // Don't skip VLM if STT failed - audio content is unverified, VLM should still analyze.
  if (isIdleScene && !hasAudioContent && !hasRelevantDetections && !sttFailed) {
    localStaticScene = true;
    skipVlm = true;
  }

  // Audio is "vetted" (confirmed silent) only when STT succeeded and found no content.
  // STT failure means audio is unverified - don't treat as vetted.
  const audioVettedByStt = vadSpeechObserved && !hasAudioContent && !sttFailed;
  if (isColdStart && skipVlm && !audioVettedByStt) {
    skipVlm = false;
  }

  const willAttemptVlm = strategyRunVlm && !skipVlm;

  const decision: VlmGateDecision = {
    is_idle: isIdleScene,
    vad_speech_observed: vadSpeechObserved,
    stt_available: sttAvailable,
    stt_transcript_length: sttData?.transcript?.trim().length ?? 0,
    strategy_run_vlm: strategyRunVlm,
    attempted: willAttemptVlm,
    has_audio_content: hasAudioContent,
    relevant_detection_count: relevantDetectionCount,
    cold_start: isColdStart,
    cold_start_override: isColdStart && isIdleScene && !hasAudioContent && !hasRelevantDetections && !audioVettedByStt && !sttFailed,
    skipped: !willAttemptVlm,
    reason: !strategyRunVlm
      ? "strategy_disabled"
      : skipVlm
        ? vadSpeechObserved
          ? (sttAvailable ? "idle_audio_without_stt_content" : "idle_audio_unverified")
          : "idle_without_audio_or_relevant_detection"
        : sttFailed
          ? "stt_failed_audio_unverified"
          : isColdStart
          ? "cold_start"
          : hasAudioContent
            ? "audio_content"
            : hasRelevantDetections
              ? "relevant_detection"
              : "not_idle",
  };
  if (eventHint) decision.idle_hint = eventHint;

  return { skipVlm, localStaticScene, willAttemptVlm, decision };
}

export async function runVlmSegment(
  vlmAnalyzer: VlmAnalyzer,
  frames: Segment["frames"],
  model: string,
  options: VlmSegmentAnalyzeOptions,
  resizeOptions?: VlmFrameResizeOptions,
): Promise<AnalyzerResult> {
  const start = Date.now();
  try {
    const vlmFrames = await resizeFramesForVlm(frames, resizeOptions);
    const analyzeStartedAt = Date.now();
    const segmentAnalysis = await vlmAnalyzer.analyzeSegment(vlmFrames, model, options);
    const analyzeCompletedAt = Date.now();
    return {
      available: true,
      analyzer: "vlm",
      data: segmentAnalysis.output,
      latency_ms: segmentAnalysis.latency_ms,
      trace: {
        llm_call_id: segmentAnalysis.llm_call?.call_id,
        archive: segmentAnalysis.archive,
        vlm_analyze_started_at: analyzeStartedAt,
        vlm_analyze_completed_at: analyzeCompletedAt,
      },
    };
  } catch (err) {
    const failedAt = Date.now();
    const msg = err instanceof Error ? err.message : String(err);
    writeStderr(`[vlm-analyzer] VLM failed (${failedAt - start}ms): ${msg}`);
    return {
      available: false,
      analyzer: "vlm",
      error: msg,
      latency_ms: failedAt - start,
      trace: err instanceof VlmAnalysisError
        ? {
            llm_call_id: err.llmCall?.call_id,
            archive: err.archive,
            vlm_analyze_completed_at: failedAt,
          }
        : undefined,
    };
  }
}
