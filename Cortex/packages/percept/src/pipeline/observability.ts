import type {
  EntityRecord,
  PipelineTrace,
  Segment,
  SegmentArchive,
} from "@cortex/shared";
import type { PipelineProfiler } from "../profiling.js";
import type { AnalyzerResult, VlmOutput } from "../types.js";
import type { PipelineDeps } from "./types.js";

type DecisionContext = NonNullable<PipelineTrace["context"]["decision_context"]>;

export type MemoryHistoryTiming = {
  completedAt: number;
  latencyMs: number;
};

export type PipelinePartialFirstMetric = {
  received_at: number;
  refresh_ms: number;
  vlm_refresh_ms?: number;
  vlm_ttft_ms?: number;
  vlm_first_content_ms?: number;
};

export function applyMemoryHistoryTiming(
  trace: PipelineTrace,
  timing: MemoryHistoryTiming,
  blockingMs: number,
): void {
  trace.timestamps.memory_stored_at = timing.completedAt;
  trace.latencies.memory_ms = timing.latencyMs;
  trace.latencies.memory_blocking_ms = blockingMs;
}

export function buildPipelineTrace(input: {
  segment: Segment;
  analysisStartedAt: number;
  profiler: PipelineProfiler;
  strategy: { level: number; vlm_model: string };
  analyzerResults: AnalyzerResult[];
  analyzersSkipped: string[];
  partialFirstMetrics: Map<string, PipelinePartialFirstMetric>;
  vlmAnalyzeCompletedAt?: number;
  vlmCompletedAt?: number;
  vlmAnalyzeStartedAt?: number;
  vlmStageStartedAt?: number;
  streamingCriticalSectionClosedAt?: number;
  streamingCriticalSectionClosedBy?: string;
  criticalStateCommittedAt?: number;
  notificationSentAt?: number;
  memoryHistoryTiming?: MemoryHistoryTiming;
  memoryHistoryBlockingMs?: number;
  detectionFilterDecision: DecisionContext["detection_filter"];
  reidDecision: DecisionContext["reid"];
  workingMemoryDecision: DecisionContext["working_memory"];
  vlmGateDecision?: DecisionContext["vlm_gate"];
  eventBoundaryDecision?: DecisionContext["event_boundary"];
  runtimeMode: PipelineDeps["runtimeMode"];
  streamingCriticalFields: ReadonlyMap<string, unknown>;
  streamedCriticalContextCommitted: boolean;
  streamingCriticalFallbackReason?: string;
  streamingCriticalLastMissingFields: string[];
  streamedCriticalParseErrors: string[];
  streamingCriticalConflictFields: string[];
}): {
  trace: PipelineTrace;
  analysisCompletedAt: number;
  perceptionMs: number;
} {
  const analysisCompletedAt = Date.now();
  const firstFrameAt = input.segment._trace?.first_frame_at ?? input.analysisStartedAt;
  const segmentBuiltAt = input.segment._trace?.segment_built_at ?? input.analysisStartedAt;
  const summaryPartialMetrics = input.partialFirstMetrics.get("summary");
  const mainTargetsPartialMetrics = input.partialFirstMetrics.get("main_targets");
  const targetsPartialMetrics = input.partialFirstMetrics.get("targets");
  const targetPartialMetrics = mainTargetsPartialMetrics ?? targetsPartialMetrics;
  const eventBoundaryPartialMetrics = input.partialFirstMetrics.get("event_boundary");
  const criticalFieldMetrics = [
    input.partialFirstMetrics.get("title"),
    summaryPartialMetrics,
    input.partialFirstMetrics.get("security_risk"),
    input.partialFirstMetrics.get("is_static_scene"),
    input.partialFirstMetrics.get("notify_user"),
    input.partialFirstMetrics.get("matched_rule_ids"),
    input.partialFirstMetrics.get("best_frame_index"),
    targetPartialMetrics,
    eventBoundaryPartialMetrics,
  ].filter((metric): metric is PipelinePartialFirstMetric => metric !== undefined);
  const criticalFieldsArrivedMs = criticalFieldMetrics.length > 0
    ? Math.max(...criticalFieldMetrics.map((metric) => metric.vlm_refresh_ms ?? metric.refresh_ms))
    : undefined;
  const fullVlmCompletedAt = input.vlmAnalyzeCompletedAt ?? input.vlmCompletedAt;
  const vlmTimingStartedAt = input.vlmAnalyzeStartedAt ?? input.vlmStageStartedAt;
  const criticalSectionClosedMs = input.streamingCriticalSectionClosedAt !== undefined
    ? Math.max(0, input.streamingCriticalSectionClosedAt - (vlmTimingStartedAt ?? input.analysisStartedAt))
    : undefined;
  const effectiveCriticalFieldsArrivedMs = criticalFieldsArrivedMs !== undefined && criticalSectionClosedMs !== undefined
    ? Math.max(criticalFieldsArrivedMs, criticalSectionClosedMs)
    : criticalFieldsArrivedMs ?? criticalSectionClosedMs;
  const criticalToFullVlmGapMs = effectiveCriticalFieldsArrivedMs !== undefined && fullVlmCompletedAt !== undefined
    ? Math.max(0, fullVlmCompletedAt - ((vlmTimingStartedAt ?? input.analysisStartedAt) + effectiveCriticalFieldsArrivedMs))
    : undefined;
  const profileTimestamps = input.profiler.traceTimestamps();
  const profileLatencies = input.profiler.traceLatencies();

  const decisionContext: DecisionContext = {
    detection_filter: input.detectionFilterDecision,
    reid: input.reidDecision,
    working_memory: input.workingMemoryDecision,
  };
  if (input.vlmGateDecision) decisionContext.vlm_gate = input.vlmGateDecision;
  if (input.eventBoundaryDecision) decisionContext.event_boundary = input.eventBoundaryDecision;
  if (input.runtimeMode === "live_latency") {
    decisionContext.streaming_critical = {
      fields_seen: [...input.streamingCriticalFields.keys()],
      section_closed_by: input.streamingCriticalSectionClosedBy,
      committed: input.streamedCriticalContextCommitted,
      fallback_reason: input.streamingCriticalFallbackReason,
      last_missing_fields: input.streamingCriticalLastMissingFields.length > 0 ? input.streamingCriticalLastMissingFields : undefined,
      parse_error_count: input.streamedCriticalParseErrors.length > 0 ? input.streamedCriticalParseErrors.length : undefined,
      conflict_count: input.streamingCriticalConflictFields.length > 0 ? input.streamingCriticalConflictFields.length : undefined,
      conflict_fields: input.streamingCriticalConflictFields.length > 0 ? input.streamingCriticalConflictFields : undefined,
    };
  }

  const trace: PipelineTrace = {
    segment_id: input.segment.segment_id,
    camera_id: input.segment.camera_id,
    timestamps: {
      first_frame_at: firstFrameAt,
      segment_built_at: segmentBuiltAt,
      analysis_started_at: input.analysisStartedAt,
      ...profileTimestamps,
      summary_partial_first_at: summaryPartialMetrics?.received_at,
      targets_partial_first_at: targetPartialMetrics?.received_at,
      event_boundary_partial_first_at: eventBoundaryPartialMetrics?.received_at,
      critical_state_committed_at: input.criticalStateCommittedAt,
      analysis_completed_at: analysisCompletedAt,
      memory_stored_at: undefined,
      notification_sent_at: input.notificationSentAt,
    },
    latencies: {
      accumulation_ms: segmentBuiltAt - firstFrameAt,
      dispatch_ms: input.analysisStartedAt - segmentBuiltAt,
      ...profileLatencies,
      vlm_ttft_ms: summaryPartialMetrics?.vlm_ttft_ms,
      vlm_first_content_ms: summaryPartialMetrics?.vlm_first_content_ms,
      summary_refresh_ms: summaryPartialMetrics?.vlm_refresh_ms,
      targets_arrived_ms: targetPartialMetrics?.vlm_refresh_ms,
      event_boundary_arrived_ms: eventBoundaryPartialMetrics?.vlm_refresh_ms,
      critical_fields_arrived_ms: effectiveCriticalFieldsArrivedMs,
      critical_to_full_vlm_gap_ms: criticalToFullVlmGapMs,
      critical_state_committed_ms: input.criticalStateCommittedAt !== undefined
        ? input.criticalStateCommittedAt - input.analysisStartedAt
        : undefined,
      perception_ms: analysisCompletedAt - input.analysisStartedAt,
      memory_blocking_ms: input.memoryHistoryBlockingMs,
      memory_ms: undefined,
      e2e_ms: analysisCompletedAt - firstFrameAt,
    },
    context: {
      mode: input.segment.mode,
      level: input.strategy.level,
      frame_count: input.segment.frames.length,
      vlm_model: input.strategy.vlm_model,
      analyzers_run: input.analyzerResults.filter(r => r.available).map(r => r.analyzer),
      analyzers_skipped: input.analyzersSkipped.length > 0 ? input.analyzersSkipped : undefined,
      decision_context: decisionContext,
    },
  };
  if (input.memoryHistoryTiming) {
    applyMemoryHistoryTiming(trace, input.memoryHistoryTiming, input.memoryHistoryBlockingMs ?? 0);
  }

  return {
    trace,
    analysisCompletedAt,
    perceptionMs: analysisCompletedAt - input.analysisStartedAt,
  };
}

function wordCount(text: string | undefined): number {
  return text?.trim() ? text.trim().split(/\s+/).length : 0;
}

function compactAnalyzerResult(result: AnalyzerResult): Record<string, unknown> {
  return {
    status: result.available ? "ok" : "error",
    latency_ms: Math.round(result.latency_ms),
    error: result.error,
    trace: result.trace,
  };
}

export function buildSegmentArchive(input: {
  segment: Segment;
  vadSpeechObserved: boolean;
  transcript?: string;
  semanticContextPresent: boolean;
  sceneContext: string;
  recentSegmentSummaries: string[];
  currentEventSummary?: string;
  recentNotificationCount: number;
  analyzerResults: AnalyzerResult[];
  vlmArchive?: Record<string, unknown>;
  postprocessArchive?: Record<string, unknown>;
  segmentKeyframePaths: string[];
  selectedSegmentKeyframeIndex?: number;
  vlmBestFrameIndex?: number;
  segmentAnalysis: Pick<VlmOutput, "summary" | "detailed_summary">;
  subjects: EntityRecord[];
  shouldStoreMemory: boolean;
  finalEventId: string;
  eventId: string;
  eventBoundaryDecision?: DecisionContext["event_boundary"];
  currentEventSegmentCount: number;
  vlmEventSummary?: string;
  narrativeMemoryAttached: boolean;
}): SegmentArchive {
  return {
    schema_version: 1,
    input: {
      segment_id: input.segment.segment_id,
      camera_id: input.segment.camera_id,
      mode: input.segment.mode,
      timestamp_ms: input.segment.timestamp,
      duration_sec: input.segment.duration_sec,
      time_range_ms: {
        start: input.segment.timestamp,
        end: input.segment.timestamp + Math.max(0, Math.round((input.segment.duration_sec ?? 0) * 1000)),
      },
      frame_count: input.segment.frames.length,
      sampled_frame_indices: input.segment.frames.map((frame) => frame.index),
      vad_speech_observed: input.vadSpeechObserved,
      transcript_chars: input.transcript?.length ?? 0,
      working_memory_context: {
        semantic_context_present: input.semanticContextPresent,
        scene_context_chars: input.sceneContext.length,
        recent_segment_count: input.recentSegmentSummaries.length,
        recent_segment_summary_chars: input.recentSegmentSummaries.join("\n").length,
        current_event_summary_chars: input.currentEventSummary?.length ?? 0,
        recent_notification_count: input.recentNotificationCount,
      },
    },
    analyzers: Object.fromEntries(
      input.analyzerResults.map((analyzerResult) => [
        analyzerResult.analyzer,
        compactAnalyzerResult(analyzerResult),
      ]),
    ),
    vlm: input.vlmArchive,
    postprocess: {
      ...(input.postprocessArchive ?? {}),
      selected_keyframes: input.segmentKeyframePaths.map((path, index) => ({
        frame_index: index === 0 ? input.selectedSegmentKeyframeIndex : undefined,
        path,
        reason: index === 0 && input.vlmBestFrameIndex != null ? "vlm_selected" : "fallback_or_entity",
      })),
      summary: {
        summary_words: wordCount(input.segmentAnalysis.summary),
        detailed_summary_words: wordCount(input.segmentAnalysis.detailed_summary),
      },
      entities: {
        count: input.subjects.length,
        with_entity_id: input.subjects.filter((subject) => subject.entity_id).length,
        with_anonymous_subject_id: input.subjects.filter((subject) => subject.anonymous_subject_id).length,
      },
    },
    memory_write: {
      attempted: input.shouldStoreMemory,
      status: input.shouldStoreMemory ? "pending" : "skipped",
      memory_type: "episodic_trace",
      text_preview: [
        input.segmentAnalysis.summary,
        input.segmentAnalysis.detailed_summary,
        input.transcript,
      ].filter(Boolean).join("\n").slice(0, 1000),
      metadata: {
        event_id: input.finalEventId,
        segment_id: input.segment.segment_id,
        keyframe_count: input.segmentKeyframePaths.length,
      },
    },
    event_narrative: {
      event_id_before: input.eventId,
      event_id_after: input.finalEventId,
      event_boundary: input.eventBoundaryDecision,
      current_event_segment_count: input.currentEventSegmentCount,
      event_summary_chars: input.vlmEventSummary?.length ?? 0,
      narrative_memory_attached: input.narrativeMemoryAttached,
    },
    warnings: [],
  };
}
