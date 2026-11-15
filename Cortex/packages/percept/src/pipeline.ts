// packages/percept/src/pipeline.ts
import { createRuntimeHealthReporter, monitorBus, resolveCortexStateDir, writeStderr } from "@cortex/shared";
import type {
  LlmCallContext,
  Segment,
  PerceptionResult,
  PerceptionMemory,
  BoundingBox,
  EntityRecord,
  SpeakerIdentityLevel,
} from "@cortex/shared";
import type { AnalyzerResult, VlmOutput, DetectionOutput, ReIdOutput, WorkingMemoryTarget, DIdEntry, PendingEmbedding, SttOutput, VlmTargetIdentity } from "./types.js";
import { VlmAnalyzer, VlmAnalysisError, type SubjectProposalContext, type VlmPartialField, type VlmSegmentAnalyzeOptions } from "./analyzers/vlm-analyzer.js";
import { applyVlmCallProfile, resolveVlmCallProfile, type VlmCallMode } from "./vlm-call-profiles.js";
import { PipelineProfiler } from "./profiling.js";
import { runPerFrameFaceDetection, type PerFrameFaceDetectionDebug } from "./analyzers/detection-analyzer.js";
import { runPerFaceReId, type FaceReIdResult } from "./analyzers/reid-entry.js";
import { runPerBodyReId, type BodyReIdResult } from "./analyzers/body-reid-entry.js";
import { collectFaceQualificationDebug, collectQualifiedFaces, measureFaceSharpness } from "./analyzers/subject-proposal-analyzer.js";
import { DetectionRegistry, associateFaces } from "./did-registry.js";
import { parseSubjectProposalEnvelopeOnly, parseSubjectProposalOutput, type ParsedSubjectProposalOutput, type ParsedSubjectProposalTarget } from "./vlm-output-parser.js";
import {
  classifyTargetIdentityNamePersistence,
  clearAmbiguousResolvedSubjectNames,
  clearResolvedTargetIdentity,
  currentEntityEvidenceDidForCrop,
  directSafeEntityForDid,
  identityBindingKeys,
  mergeParsedTargetsByEntity,
  resolveNameIdentityScope,
  resolveNameIdentityBindings,
  safeTrackIdsForTarget,
  type NameIdentityBindingCandidate,
  type TargetIdentityNamePersistence,
} from "./identity-resolver.js";
import {
  BODY_REID_MATCH_THRESHOLD,
  FACE_REID_MATCH_THRESHOLD,
  GALLERY_APPEND_THRESHOLD,
  PERSON_MIN_BBOX_AREA_RATIO,
  PENDING_FACE_MAX,
} from "./thresholds.js";
import { canAppendFaceGallery } from "./face-reid-policy.js";
import { ReIdAccumulator, type BatchInitMemoryPort } from "./analyzers/reid-accumulator.js";
import {
  bestStableCropPath,
  currentSegmentStableCropPath,
  findCurrentWmTarget,
  buildCompactSubjectEvidenceContext,
  mergeStableWmCrops,
  normalizeEntityType,
  prepareWmTargetsForSubjectProposal,
  resolveTargetContinuityStrength,
  saveReliableTargetCrop,
  selectedTargetAvatarScore,
  shouldAttachWmTargetCropImages,
  shouldAttachWmTargetCrops,
} from "./pipeline/subjects.js";
import {
  cloneFullSubjectProposalTarget,
  cloneStreamingCriticalTarget,
  hasSpeakerDiarization,
  isLiveLatencyCriticalField,
  isLiveLatencyNonCriticalField,
  reconcileStreamingCriticalSnapshot,
  reconcileStreamingCriticalVlmOutput,
  resolveLiveLatencyRequiredFields,
  type StreamingCriticalSnapshot,
} from "./pipeline/live-latency.js";
import { bodyGalleryVectorFromEntry, selectVerifiedBodyGalleryVector } from "./pipeline/reid.js";
import { saveSegmentMedia } from "./pipeline/media.js";
import { runPipelinePostprocess } from "./pipeline/postprocess.js";
import { createPipelineRuntimeState, emitAdaptiveCaptureHint } from "./pipeline/runtime.js";
import { buildSegmentArchive } from "./pipeline/observability.js";
import {
  buildReIdAccumulatorDebug,
  type ReIdAccumulatorDebug,
} from "./pipeline/reid-accumulator-debug.js";
import {
  getMemoryReIdPort,
  getMemorySearchPort,
  reidMatchOrCreate,
} from "./pipeline/reid.js";
import {
  buildPipelineTrace,
  type PipelinePartialFirstMetric,
} from "./pipeline/observability.js";
import {
  buildVlmOnlySegmentOptions,
  formatSttForVlm,
  parseSemanticContextSections,
  resolveVlmGate,
  runVlmSegment,
  type SemanticContextSections,
} from "./pipeline/vlm.js";
import {
  annotateVlmFramesWithDIds,
  resizeFramesForVlm,
  resolveFrameDimensions,
  resolveVlmSelectableDIds,
} from "./pipeline/vlm-frames.js";
import type { PipelineDeps } from "./pipeline/types.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const runtimeHealth = createRuntimeHealthReporter("perception-pipeline");

export { selectVerifiedBodyGalleryVector } from "./pipeline/reid.js";
export type { BodyGalleryVector } from "./pipeline/reid.js";
export { createPipelineDeps } from "./pipeline/dependencies.js";
export {
  collectPipelineSelfCheckComponents,
  formatPipelineSelfCheckReport,
  logPipelineSelfCheck,
} from "./pipeline/self-check.js";
export { clearCameraRuntimeState, createPipelineRuntimeState } from "./pipeline/runtime.js";
export {
  parseSemanticContextSections,
} from "./pipeline/vlm.js";
export type { SemanticContextSections } from "./pipeline/vlm.js";
export type {
  CaptureHint,
  PipelineDeps,
  PipelineLoggingConfig,
  PipelineMemory,
  PipelineRuntimeState,
  PipelineSelfCheckComponent,
  PipelineSelfCheckOptions,
  PipelineSelfCheckSnapshot,
  PipelineSelfCheckStatus,
  PostProcessor,
  VlmFrameResizeOptions,
  VlmMeta,
} from "./pipeline/types.js";

function compactPromptText(value: string | undefined, maxChars: number): string | undefined {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function cleanEntityText(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

type VlmTarget = VlmOutput["main_targets"][number];

const NON_PERSON_IDENTITY_TERMS = [
  "referenced",
  "company",
  "corporation",
  "customer",
  "customers",
  "gpu",
  "gpus",
  "stock",
  "ticker",
  "nvidia",
  "samsung",
  "openai",
  "microsoft",
  "google",
  "apple",
  "meta",
  "tesla",
];

const INDIRECT_IDENTITY_EVIDENCE_PATTERNS = [
  /\bprior\s+context\b/i,
  /\bprevious\s+(?:frames?|context|segment|appearance)\b/i,
  /\bpreviously\s+associated\b/i,
  /\bearlier\s+(?:frames?|context|segment)\b/i,
  /\bhistorical\s+(?:context|appearance|memory)\b/i,
  /\bstable\s+(?:wm\s+)?crops?\b/i,
];

function isLikelyPersonIdentityName(name: string | undefined, evidence?: string): name is string {
  const trimmed = name?.trim();
  if (!trimmed) return false;
  if (trimmed.length < 2 || trimmed.length > 80) return false;
  const normalized = trimmed.toLowerCase();
  if (/[()]/.test(trimmed)) return false;
  if (/\b(?:inc|corp|corporation|llc|ltd|co|company)\b/i.test(trimmed)) return false;
  const evidenceText = evidence?.toLowerCase() ?? "";
  if (evidenceText && INDIRECT_IDENTITY_EVIDENCE_PATTERNS.some((pattern) => pattern.test(evidenceText))) return false;
  const combined = `${normalized} ${evidenceText}`;
  if (NON_PERSON_IDENTITY_TERMS.some((term) => combined.includes(term))) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length > 4) return false;
  return words.every((word) => /^[\p{L}][\p{L}'’.-]*$/u.test(word));
}

function backfillSubjectProposalTargetAppearances(
  targets: ParsedSubjectProposalTarget[],
  wmTargets: WorkingMemoryTarget[],
): void {
  for (const target of targets) {
    if (target.appearance.trim()) continue;
    const matchedWm = target.matched_wm_target
      ? wmTargets.find((wm) => wm.target_id === target.matched_wm_target)
      : undefined;
    const entityMatchedWm = !matchedWm && target.entity_id
      ? wmTargets.find((wm) => wm.entity_id === target.entity_id)
      : undefined;
    const fallbackAppearance = (matchedWm ?? entityMatchedWm)?.appearance?.trim();
    if (fallbackAppearance) target.appearance = fallbackAppearance;
  }
}

function getFrameArea(frame: Segment["frames"][number]): number | undefined {
  if (!frame.width || !frame.height) return undefined;
  return frame.width * frame.height;
}

function isPersonTooSmallForFrame(bbox: BoundingBox, frameArea: number | undefined): boolean {
  if (!frameArea || frameArea <= 0) return false;
  return (bbox.width * bbox.height) / frameArea < PERSON_MIN_BBOX_AREA_RATIO;
}

/**
 * Main Perception pipeline entry point.
 *
 * Orchestrates:
 * 1. Working Memory — assigns event_id, provides scene context
 * 2. Strategy Manager — selects which analyzers to run
 * 3. Analyzers — VLM (cloud) + detection/tracking/ReID (stubs)
 * 4. Media Uploader — saves keyframes to local storage
 * 5. Builds and returns PerceptionResult
 *
 * @param segment - Unified Segment from Eye
 * @param deps - Injected pipeline dependencies
 * @returns PerceptionResult ready to send to Cortex and Act
 */
export async function analyze(
  segment: Segment,
  deps: PipelineDeps,
): Promise<PerceptionResult> {
  const { workingMemory, strategyManager, vlmAnalyzer, mediaUploader } = deps;
  // Lazily ensure runtime state exists (for deps created before this field was added)
  if (!deps._runtimeState) deps._runtimeState = createPipelineRuntimeState();
  const runtimeState = deps._runtimeState;
  const analysisStartedAt = Date.now();
  const profiler = new PipelineProfiler();
  const llmContext: LlmCallContext = {
    ...(deps.logging?.llmContext ?? {}),
    camera_id: segment.camera_id,
    segment_id: segment.segment_id,
  };
  const partialFirstReceivedAt = new Map<string, number>();
  const partialFirstMetrics = new Map<string, PipelinePartialFirstMetric>();
  const streamingCriticalFields = new Map<string, unknown>();
  let streamingCriticalCommitter: ((fields: ReadonlyMap<string, unknown>) => Promise<void>) | undefined;
  let streamingCriticalCommitStarted = false;
  let streamingCriticalFallbackReason: string | undefined;
  let streamingCriticalSectionClosedBy: string | undefined;
  let streamingCriticalSectionClosedAt: number | undefined;
  let streamingCriticalLastMissingFields: string[] = [];
  let streamingCriticalSnapshot: StreamingCriticalSnapshot | undefined;
  let streamingCriticalFrozenTargets: ParsedSubjectProposalTarget[] | undefined;
  let streamingCriticalConflictFields: string[] = [];
  const tryStreamingCriticalCommit = async (): Promise<void> => {
    if (!streamingCriticalCommitter || streamingCriticalCommitStarted || streamingCriticalFallbackReason) return;
    streamingCriticalCommitStarted = true;
    try {
      await streamingCriticalCommitter(streamingCriticalFields);
      streamingCriticalLastMissingFields = [];
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (reason.startsWith("critical fields incomplete:")) {
        streamingCriticalLastMissingFields = reason
          .slice("critical fields incomplete:".length)
          .split(",")
          .map((field) => field.trim())
          .filter(Boolean);
        streamingCriticalCommitStarted = false;
        return;
      }
      streamingCriticalFallbackReason = reason;
      writeStderr(`[perception] streaming critical commit fallback for ${segment.segment_id}: ${streamingCriticalFallbackReason}`);
    }
  };
  const recordStreamingCriticalField = async (field: string, value: unknown): Promise<void> => {
    streamingCriticalFields.set(field, value);
    await tryStreamingCriticalCommit();
  };
  const closeStreamingCriticalSection = async (field: string, receivedAt?: number): Promise<void> => {
    if (!streamingCriticalSectionClosedBy) {
      streamingCriticalSectionClosedBy = field;
      streamingCriticalSectionClosedAt = receivedAt ?? Date.now();
    }
    await tryStreamingCriticalCommit();
  };
  const recordPartialMetric = (partial: {
    field: string;
    received_at?: number;
    ttft_ms?: number;
    first_content_ms?: number;
  }): number => {
    const partialReceivedAt = partialFirstReceivedAt.get(partial.field) ?? partial.received_at ?? Date.now();
    partialFirstReceivedAt.set(partial.field, partialReceivedAt);
    const partialRefreshMs = partialReceivedAt - analysisStartedAt;
    if (!partialFirstMetrics.has(partial.field)) {
      const vlmTimingStartAt = vlmAnalyzeStartedAt ?? vlmStageStartedAt;
      partialFirstMetrics.set(partial.field, {
        received_at: partialReceivedAt,
        refresh_ms: partialRefreshMs,
        vlm_refresh_ms: vlmTimingStartAt !== undefined ? Math.max(0, partialReceivedAt - vlmTimingStartAt) : undefined,
        vlm_ttft_ms: partial.ttft_ms,
        vlm_first_content_ms: partial.first_content_ms,
      });
    }
    return partialRefreshMs;
  };
  const emitVlmPartial = async (partial: VlmPartialField): Promise<void> => {
    const rawValue = partial.value;
    let value: unknown;
    if (partial.field === "title" || partial.field === "summary" || partial.field === "security_reason") {
      const text = typeof rawValue === "string" ? rawValue.trim() : "";
      if (!text) {
        if (isLiveLatencyNonCriticalField(partial.field)) {
          await closeStreamingCriticalSection(partial.field, partial.received_at);
        }
        return;
      }
      value = text;
    } else if (partial.field === "security_risk" || partial.field === "notify_user") {
      if (typeof rawValue !== "boolean") return;
      value = rawValue;
    } else if (partial.field === "matched_rule_ids") {
      if (!Array.isArray(rawValue)) return;
      value = rawValue.filter((id): id is string => typeof id === "string" && id.length > 0);
    } else if (
      partial.field === "main_targets" ||
      partial.field === "targets" ||
      partial.field === "event_boundary" ||
      partial.field === "is_static_scene" ||
      partial.field === "best_frame_index"
    ) {
      // Metrics only. Do not publish large/unstable identity payloads as
      // Dashboard partials; final projection remains the source of truth.
      recordPartialMetric(partial);
      if (isLiveLatencyCriticalField(partial.field)) {
        await recordStreamingCriticalField(partial.field, rawValue);
      }
      return;
    } else {
      if (isLiveLatencyNonCriticalField(partial.field)) {
        await closeStreamingCriticalSection(partial.field, partial.received_at);
      }
      return;
    }
    if (isLiveLatencyCriticalField(partial.field)) {
      await recordStreamingCriticalField(partial.field, value);
    } else if (isLiveLatencyNonCriticalField(partial.field)) {
      await closeStreamingCriticalSection(partial.field, partial.received_at);
    }
    const partialReceivedAt = partialFirstReceivedAt.get(partial.field) ?? partial.received_at ?? Date.now();
    const partialRefreshMs = recordPartialMetric(partial);
    const partialMetric = partialFirstMetrics.get(partial.field);
    monitorBus.publish("perception:segment_partial", {
      camera_id: segment.camera_id,
      segment_id: segment.segment_id,
      event_id: eventId,
      segment_start: segment.timestamp,
      duration_sec: segment.duration_sec,
      analysis_started_at: analysisStartedAt,
      field: partial.field,
      value,
      partial_received_at: partialReceivedAt,
      partial_refresh_ms: partialRefreshMs,
      ...(partial.field === "summary" ? { summary_refresh_ms: partialMetric?.vlm_refresh_ms ?? partialRefreshMs } : {}),
      vlm_ttft_ms: partial.ttft_ms,
      vlm_first_content_ms: partial.first_content_ms,
    }, segment.camera_id);
  };
  const publishDerivedSegmentPartial = (input: {
    field: string;
    value: unknown;
    eventId?: string;
    receivedAt?: number;
    transcript?: string;
  }): void => {
    const receivedAt = input.receivedAt ?? Date.now();
    monitorBus.publish("perception:segment_partial", {
      camera_id: segment.camera_id,
      segment_id: segment.segment_id,
      event_id: input.eventId ?? eventId,
      segment_start: segment.timestamp,
      duration_sec: segment.duration_sec,
      analysis_started_at: analysisStartedAt,
      field: input.field,
      value: input.value,
      ...(input.transcript ? { transcript: input.transcript } : {}),
      partial_received_at: receivedAt,
      partial_refresh_ms: receivedAt - analysisStartedAt,
    }, segment.camera_id);
  };
  const segmentPolicyExitPrompt = deps.getSegmentPolicyExitPrompt?.(segment.camera_id);
  const subjectIndexSession = deps.subjectRegistry?.createSession(segment.camera_id);
  const resolveSubjectIndex = (input: {
    category: string;
    entity_id?: string;
    wm_target_id?: string;
    subject_index?: number | null;
    name?: string;
  }): { category: string; subject_index?: number; name?: string; first_seen?: string | number } => {
    if (!subjectIndexSession) {
      return {
        category: normalizeEntityType(input.category),
        ...(input.name?.trim() ? { name: input.name.trim() } : {}),
      };
    }
    const identity = subjectIndexSession.resolve({
      category: normalizeEntityType(input.category),
      entity_id: input.entity_id,
      wm_target_id: input.wm_target_id,
      subject_index: typeof input.subject_index === "number" ? input.subject_index : undefined,
      name: input.name,
      timestamp: segment.timestamp,
    });
    return {
      category: identity.category,
      subject_index: identity.subject_index,
      ...(identity.name ? { name: identity.name } : {}),
      first_seen: identity.first_seen,
    };
  };
  const applySubjectIdentity = (
    target: ParsedSubjectProposalTarget,
    identity: { subject_index?: number; name?: string; first_seen?: string | number },
  ): void => {
    // Stable ReID identity is the canonical display handle. WM subject indexes
    // are event-local aliases and must not relabel an existing entity.
    const hasStableHandle = Boolean(target.entity_id || target.matched_wm_target);
    if (identity.subject_index != null && (hasStableHandle || target.subject_index == null)) {
      target.subject_index = identity.subject_index;
    }
    target.name = target.name ?? identity.name;
    target.first_seen = target.first_seen ?? identity.first_seen;
  };
  const stableFaceEmbeddingsForTarget = (
    target: ParsedSubjectProposalTarget,
    existing: WorkingMemoryTarget | undefined,
    registry: DetectionRegistry,
  ): PendingEmbedding[] | undefined => {
    const existingAnchors = existing?.stable_face_embeddings ?? [];
    if (!target.entity_id || target.entity_id_source !== "current_reid" || target.reid_unsafe_reason) {
      return existingAnchors.length > 0 ? existingAnchors : undefined;
    }

    const nextAnchors: PendingEmbedding[] = [];
    for (const did of safeTrackIdsForTarget(registry, target)) {
      const entry = registry.get(did);
      if (!canAppendFaceGallery(entry?.face) || !entry?.face?.embedding) continue;
      if (entry.face.entity_id && entry.face.entity_id !== target.entity_id) continue;
      nextAnchors.push({
        embedding: entry.face.embedding,
        quality: entry.face.quality ?? 0,
        segment_id: segment.segment_id,
        did,
        yaw: entry.face.pose?.yaw,
        pitch: entry.face.pose?.pitch,
      });
    }

    const bestByKey = new Map<string, PendingEmbedding>();
    for (const anchor of [...existingAnchors, ...nextAnchors]) {
      const key = `${anchor.segment_id}\u0000${anchor.did}`;
      const existingAnchor = bestByKey.get(key);
      if (!existingAnchor || anchor.quality > existingAnchor.quality) {
        bestByKey.set(key, {
          ...anchor,
          embedding: [...anchor.embedding],
        });
      }
    }
    const merged = [...bestByKey.values()]
      .sort((left, right) => right.quality - left.quality)
      .slice(0, PENDING_FACE_MAX);
    return merged.length > 0 ? merged : undefined;
  };
  let sttCompletedAt: number | undefined;
  let sttStartedAt: number | undefined;
  let detectionStartedAt: number | undefined;
  let detectionCompletedAt: number | undefined;
  let trackingCompletedAt: number | undefined;
  let reidStartedAt: number | undefined;
  let reidCompletedAt: number | undefined;
  let vlmStageStartedAt: number | undefined;
  let vlmAnalyzeStartedAt: number | undefined;
  let vlmAnalyzeCompletedAt: number | undefined;
  let vlmAnalyzeLatencyMs: number | undefined;
  let vlmCompletedAt: number | undefined;
  let criticalStateCommittedAt: number | undefined;
  let criticalStateHookInvoked = false;
  let criticalStateCommitPromise: Promise<void> | null = null;
  const flushSubjectIndexSession = async (stage: "critical_state" | "final"): Promise<void> => {
    try {
      await subjectIndexSession?.commit();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.postProcessor?.onPipelineError?.(segment.segment_id, segment.camera_id, "subject_registry", msg);
      if (stage === "critical_state") throw err;
    }
  };
  const commitCriticalState = async (): Promise<void> => {
    if (criticalStateHookInvoked) return;
    if (criticalStateCommitPromise) return criticalStateCommitPromise;
    criticalStateCommitPromise = (async () => {
      await flushSubjectIndexSession("critical_state");
      await deps.onCriticalStateCommitted?.(segment);
      criticalStateHookInvoked = true;
      criticalStateCommittedAt = Date.now();
    })().finally(() => {
      criticalStateCommitPromise = null;
    });
    return criticalStateCommitPromise;
  };
  const installVlmOnlyStreamingCriticalCommitter = (): void => {
    streamingCriticalCommitter = async (fields) => {
      if (runtimeMode !== "live_latency") return;
      if (streamedCriticalContextCommitted) return;
      const missing = resolveLiveLatencyRequiredFields("vlm_only", {}).filter((field) => !fields.has(field));
      if (missing.length > 0) throw new Error(`critical fields incomplete: ${missing.join(",")}`);

      const eventBoundary = fields.get("event_boundary") === true;
      let criticalEventId = eventId;
      if (eventBoundary && mySegmentCount > 1) {
        const newId = workingMemory.switchEvent(segment.camera_id, segment.mode, segment.timestamp);
        monitorBus.publish("perception:event_boundary", {
          camera_id: segment.camera_id,
          old_event_id: eventId,
          new_event_id: newId,
          reason: "vlm_content_shift",
        }, segment.camera_id);
        criticalEventId = newId;
        eventBoundaryDecision = {
          requested: true,
          applied: true,
          old_event_id: eventId,
          new_event_id: newId,
          reason: "vlm_content_shift",
        };
      } else {
        eventBoundaryDecision = {
          requested: eventBoundary,
          applied: false,
        };
      }

      streamedCriticalFinalEventId = criticalEventId;
      workingMemory.recordSegment(segment.camera_id, segment.segment_id, segment.timestamp);
      const summary = typeof fields.get("summary") === "string" ? fields.get("summary") as string : "";
      const title = typeof fields.get("title") === "string" ? fields.get("title") as string : undefined;
      streamingCriticalSnapshot = {
        title,
        summary,
        security_risk: fields.get("security_risk") === true,
        is_static_scene: fields.get("is_static_scene") === true,
        notify_user: fields.get("notify_user") === true,
        matched_rule_ids: Array.isArray(fields.get("matched_rule_ids")) ? fields.get("matched_rule_ids") as string[] : [],
        best_frame_index: typeof fields.get("best_frame_index") === "number" ? fields.get("best_frame_index") as number : undefined,
        event_boundary: fields.get("event_boundary") === true,
        main_targets: Array.isArray(fields.get("main_targets")) ? fields.get("main_targets") as VlmOutput["main_targets"] : [],
      };
      if (summary) {
        workingMemory.appendSceneContext(segment.camera_id, summary, segment.segment_id, title);
      }
      streamedCriticalContextCommitted = true;
      streamedCriticalTargetsCommitted = true;
      await commitCriticalState();
    };
  };
  let vlmGateDecision: NonNullable<import("@cortex/shared").PipelineTrace["context"]["decision_context"]>["vlm_gate"] | undefined;
  const detectionFilterDecision: NonNullable<import("@cortex/shared").PipelineTrace["context"]["decision_context"]>["detection_filter"] = {
    external_detection_count: 0,
    person_area_ratio_threshold: PERSON_MIN_BBOX_AREA_RATIO,
    person_area_filtered_count: 0,
  };
  const reidDecision: NonNullable<import("@cortex/shared").PipelineTrace["context"]["decision_context"]>["reid"] = {};
  const workingMemoryDecision: NonNullable<import("@cortex/shared").PipelineTrace["context"]["decision_context"]>["working_memory"] = {
    cache_hit_tracks: 0,
    scene_context_length: 0,
  };
  let eventBoundaryDecision: NonNullable<import("@cortex/shared").PipelineTrace["context"]["decision_context"]>["event_boundary"] | undefined;
  let vlmArchive: Record<string, unknown> | undefined;
  let postprocessArchive: Record<string, unknown> | undefined;
  let vlmDidSelectionArchive: Record<string, unknown> | undefined;
  const wmCropSelectionArchive: Array<Record<string, unknown>> = [];
  let streamedCriticalContextCommitted = false;
  let streamedCriticalTargetsCommitted = false;
  let streamedCriticalFinalEventId: string | undefined;
  let streamedCriticalParseErrors: string[] = [];
  const streamedCriticalTargetsByCanonical = new Map<string, ParsedSubjectProposalTarget>();
  const streamedCriticalReidHandledTargetKeys = new Set<string>();
  const streamedCriticalFaceCreatedTargetKeys = new Set<string>();
  const streamedCriticalBodyCreatedTargetKeys = new Set<string>();
  const streamedCriticalAccumulatorCreatedTargetKeys = new Set<string>();
  const streamingTargetKey = (target: Pick<ParsedSubjectProposalTarget, "tid">, fallbackIndex: number): string =>
    target.tid && target.tid.trim() ? `tid:${target.tid.trim()}` : `idx:${fallbackIndex}`;

  // Inject user-defined rules from Cortex procedural collection
  if (deps.memory?.fetchUserRules) {
    try {
      const rules = await deps.memory.fetchUserRules(segment.camera_id);
      vlmAnalyzer.setUserRules(rules);
    } catch {
      // Non-fatal: proceed without rules
    }
  }

  // ── Step 1: Working Memory — get event context ──
  const preArrivalState = workingMemory.getState(segment.camera_id);
  const previousEventId = preArrivalState.current_event_id;
  const previousSegmentCount = preArrivalState.segment_count;
  const maxEventSegments = workingMemory.getMaxEventSegments();
  const preArrivalTimedOut =
    segment.mode !== "snapshot" &&
    previousEventId !== null &&
    segment.timestamp - preArrivalState.last_activity_time > workingMemory.getEventTimeoutMs();
  const eventId = workingMemory.onSegmentArrived(segment.camera_id, segment.mode, segment.timestamp);
  const maxSegmentBoundaryApplied =
    segment.mode !== "snapshot" &&
    previousEventId !== null &&
    !preArrivalTimedOut &&
    previousSegmentCount >= maxEventSegments &&
    eventId !== previousEventId;
  if (maxSegmentBoundaryApplied) {
    monitorBus.publish("perception:event_boundary", {
      camera_id: segment.camera_id,
      old_event_id: previousEventId,
      new_event_id: eventId,
      reason: "max_event_segments",
      segment_count: previousSegmentCount,
      max_event_segments: maxEventSegments,
    }, segment.camera_id);
    eventBoundaryDecision = {
      requested: true,
      applied: true,
      old_event_id: previousEventId,
      new_event_id: eventId,
      reason: "max_event_segments",
    };
  }
  workingMemory.evictStaleEntities(segment.camera_id);
  // Snapshot mutable state now — concurrent segments may mutate it before Step 9
  const mySegmentCount = workingMemory.getState(segment.camera_id).segment_count;
  const myRecentNotifs = [...workingMemory.getRecentNotifications(segment.camera_id)];
  const currentEventSummary = workingMemory.getCurrentEventSummary(segment.camera_id);
  const recentSegmentSummaries = workingMemory.getRecentSegmentSummaries(segment.camera_id);
  const currentEventContext = workingMemory.getEventContextPrompt(segment.camera_id);
  let sceneContext = "";
  // Cold start: first segment of each event must run VLM to bootstrap content_type.
  const isColdStart = mySegmentCount === 1;

  // ── Step 1b: Semantic Context — load persistent scene profile ──
  // Parse intelligence directives (Track States, Track Activities, etc.) as structured data.
  // Only camera/session context goes into sceneContext; recent segment summaries
  // are passed separately via recentSegmentSummaries to avoid duplicate prompt text.
  let suppressSceneDescription = false;
  let semanticContextSections: SemanticContextSections | undefined;
  let referenceFrameBase64: string | undefined;
  if (deps.semanticContext) {
    const semanticContextContent = await deps.semanticContext.load(segment.camera_id);
    if (semanticContextContent) {
      semanticContextSections = parseSemanticContextSections(semanticContextContent);
      sceneContext = semanticContextSections.profileContent;
      suppressSceneDescription = true;
    }
    // Load reference frame if exists (for teach-by-example comparison)
    const refPath = join(resolveCortexStateDir(), "cameras", `${segment.camera_id}_ref.jpg`);
    if (existsSync(refPath)) {
      try { referenceFrameBase64 = (await readFile(refPath)).toString("base64"); } catch { /* best-effort */ }
    }
  }

  // Inject recent notification history so VLM can avoid duplicates
  const recentNotifs = myRecentNotifs;
  if (recentNotifs.length > 0) {
    sceneContext += `${sceneContext ? "\n" : ""}Recently sent notifications (do NOT repeat these):\n${recentNotifs.map(n => `- ${n}`).join("\n")}`;
  }

  // ── Step 2: Strategy — select analyzers ──
  const strategy = strategyManager.selectStrategy(segment);
  const runtimeMode = deps.runtimeMode ?? "offline_quality";
  const buildVlmCallOptions = (mode: VlmCallMode): Partial<VlmSegmentAnalyzeOptions> => {
    const profile = resolveVlmCallProfile({
      model: strategy.vlm_model,
      stage: "segment_analysis",
      mode,
    });
    return applyVlmCallProfile({
      runtimeMode,
      ...(runtimeMode === "live_latency" && profile.stream === true ? { stream: true, onPartial: emitVlmPartial } : {}),
      ...(deps.logging ? { promptVersion: deps.logging.promptVersion, llmContext } : {}),
    }, profile);
  };

  monitorBus.publish("perception:analysis_started", {
    segment_id: segment.segment_id,
    mode: segment.mode,
    level: strategy.level,
    vlm_model: strategy.vlm_model,
  }, segment.camera_id);

  // ── Step 3: Run analyzers — dependency chain at Level 1 ──
  const analyzerResults: AnalyzerResult[] = [];
  let skipVlm = false;
  let localStaticScene = false;
  let vlmFailed = false;
  /** Entity records populated by subject proposal or VLM-only textual fallback. */
  const subjects: EntityRecord[] = [];
  /** SP bbox_id → canonical track_id mapping (all bbox_ids of a target resolve to its first bbox_id). */
  const bboxToCanonical = new Map<string, string>();
  /** SP bbox_id/canonical track_id → working-memory target id. */
  const trackToWmTarget = new Map<string, string>();
  /** SP bbox_id/canonical track_id → entity id confirmed by current-segment ReID. */
  const confirmedEntityByTrack = new Map<string, string>();
  /** Final subject canonical track_id → safe current-ReID entity id. */
  const safeCurrentReidEntityByTrack = new Map<string, string>();
  /** SP bbox_id/canonical track_id that must not drive stable identity writes. */
  const reidUnsafeByTrack = new Map<string, string>();
  /** D{id}s with current-frame face evidence, used to gate visible-text name binding. */
  const visibleNameAnchorTracks = new Set<string>();
  /** Event-local target identities that can now be promoted to stable entity memory. */
  const promotedWmIdentities: Array<{
    track_id: string;
    target_id: string;
    entity_id: string;
    name: string;
    evidence: string;
  }> = [];
  const targetIdentityInputs: Array<{
    track_id: string;
    name: string;
    evidence?: string;
    source?: VlmTargetIdentity["source"];
  }> = [];
  const targetSpeakerLinks: Array<{
    speaker_id: string;
    track_id: string;
  }> = [];
  const assembleDialogueFromSpeakerLinks = (input: {
    sttSegments: SttOutput["segments"];
    transcript?: string;
    speakerLinks: Array<{ speaker_id: string; track_id: string }>;
    normalizeTrackId: (trackId: string) => string;
    isValidTrackReference: (trackId: string) => boolean;
    resolveIdentityLevel: (trackId: string) => {
      canonicalId?: string;
      entityId?: string;
      identityLevel: SpeakerIdentityLevel;
    };
  }): {
    dialogue: NonNullable<PerceptionResult["dialogue"]>;
    speakerToEntity: Map<string, string>;
  } => {
    const dialogue: NonNullable<PerceptionResult["dialogue"]> = [];
    const speakerToEntity = new Map<string, string>();
    const speakerToResolved = new Map<string, {
      track_id: string;
      entity_id?: string;
      identity_level: SpeakerIdentityLevel;
    }>();
    const claimedSpeakerIds = new Set<string>();
    const claimedSpeakerTargets = new Map<string, string>();

    for (const link of input.speakerLinks) {
      if (claimedSpeakerIds.has(link.speaker_id)) continue;
      if (!input.isValidTrackReference(link.track_id)) continue;
      const resolved = input.resolveIdentityLevel(link.track_id);
      const canonicalId = resolved.canonicalId;
      if (!canonicalId) continue;
      const targetKey = resolved.entityId ? `entity:${resolved.entityId}` : `track:${input.normalizeTrackId(link.track_id)}`;
      const claimedBy = claimedSpeakerTargets.get(targetKey);
      if (claimedBy && claimedBy !== link.speaker_id) continue;
      if (resolved.entityId && resolved.identityLevel === "entity_id") {
        speakerToEntity.set(link.speaker_id, resolved.entityId);
      }
      speakerToResolved.set(link.speaker_id, {
        track_id: canonicalId,
        entity_id: resolved.entityId,
        identity_level: resolved.identityLevel,
      });
      claimedSpeakerIds.add(link.speaker_id);
      claimedSpeakerTargets.set(targetKey, link.speaker_id);
    }

    const attributedSttStarts = new Set<string>();
    const sttStartKey = (seconds: number): string => seconds.toFixed(2);
    const markAttributedStart = (seconds: number): void => {
      if (Number.isFinite(seconds) && seconds >= 0) {
        attributedSttStarts.add(sttStartKey(+seconds.toFixed(2)));
      }
    };

    if (speakerToResolved.size > 0 && input.sttSegments.length) {
      for (const seg of input.sttSegments) {
        if (!seg.speaker || !seg.text.trim()) continue;
        const resolved = speakerToResolved.get(seg.speaker);
        if (!resolved) continue;
        const startSec = +(seg.start / 16000).toFixed(2);
        if (attributedSttStarts.has(sttStartKey(startSec))) continue;
        markAttributedStart(startSec);
        dialogue.push({
          text_start: startSec,
          track_id: resolved.track_id,
          entity_id: resolved.entity_id,
          identity_level: resolved.identity_level,
          confidence: "high",
          text: seg.text.trim(),
        });
      }
    }

    if (input.sttSegments.length) {
      for (const seg of input.sttSegments) {
        const text = seg.text.trim();
        if (!text) continue;
        const startSec = +(seg.start / 16000).toFixed(2);
        if (attributedSttStarts.has(sttStartKey(startSec))) continue;
        dialogue.push({
          text_start: startSec,
          identity_level: "unknown",
          confidence: "low",
          text,
        });
      }
    } else if (input.transcript?.trim()) {
      dialogue.push({
        text_start: 0,
        identity_level: "unknown",
        confidence: "low",
        text: input.transcript.trim(),
      });
    }

    return {
      dialogue,
      speakerToEntity,
    };
  };
  const recordSafeCurrentEntityTracks = (
    detectionRegistry: DetectionRegistry,
    target: ParsedSubjectProposalTarget,
  ): void => {
    if (!target.entity_id || target.entity_id_source !== "current_reid" || target.reid_unsafe_reason) return;
    for (const did of target.bbox_ids) {
      const directEntityId = directSafeEntityForDid(detectionRegistry, did, target.entity_id);
      const isUpsertSource = target.upsert_candidate?.did === did;
      if (!directEntityId && !isUpsertSource) continue;
      confirmedEntityByTrack.set(did, target.entity_id);
      safeCurrentReidEntityByTrack.set(did, target.entity_id);
    }
  };
  const currentSegmentSightingCropPath = (
    target: ParsedSubjectProposalTarget,
    cropPath: string | undefined,
  ): string | undefined => {
    if (!cropPath) return undefined;
    if (!target.entity_id) return cropPath;
    if (target.entity_id_source === "current_reid" && !target.reid_unsafe_reason) return cropPath;
    return undefined;
  };
  const seedVisualOnlyReidEntity = async (
    target: ParsedSubjectProposalTarget,
    stage: "critical" | "final",
  ): Promise<void> => {
    if (!target.visual_identity_only || target.type !== "person" || target.reid_unsafe_reason) return;
    const candidate = target.upsert_candidate;
    if (!candidate) return;
    try {
      await reidMatchOrCreate(
        deps.memory,
        { type: "face", vector: candidate.embedding, threshold: FACE_REID_MATCH_THRESHOLD },
        {
          face: {
            vector: candidate.embedding,
            quality: candidate.quality,
            yaw: candidate.yaw,
            pitch: candidate.pitch,
          },
        },
        { category: target.type },
      );
    } catch (err) {
      writeStderr(
        `[perception] visual-only ReID seed failed (${stage}, segment=${segment.segment_id}): ${err instanceof Error ? err.message : err}`,
      );
    }
  };

  const analyzersSkipped: string[] = [];

  // Start STT early for non-snapshot segments, in parallel with Level 1 local work.
  // Supports two providers: ElevenLabs (cloud, async, with diarization) and Moonshine (local, sync).
  const vadSpeechObserved = (segment.audio_data?.voice_ranges?.length ?? 0) > 0
    || (segment.audio_segments?.length ?? 0) > 0;
  const hasPrecomputedStt = Boolean(deps.precomputedStt);
  const sttAvailable = hasPrecomputedStt || Boolean(deps.sttAnalyzer?.isAvailable) || Boolean(deps.elevenLabsStt);
  const shouldRunStt = segment.mode !== "snapshot" && strategy.run_stt && (hasPrecomputedStt || (sttAvailable && vadSpeechObserved));
  if (segment.mode === "snapshot" && vadSpeechObserved) {
    analyzersSkipped.push("stt:snapshot");
  }
  sttStartedAt = shouldRunStt ? profiler.start("stt") : undefined;
  const sttPromise: Promise<AnalyzerResult> | null = shouldRunStt
    ? (hasPrecomputedStt
      ? // Precomputed STT path (external subtitles, zero latency).
        // Always returns available=true — empty transcript means "confirmed no speech".
        Promise.resolve().then(() => {
          const sttData = deps.precomputedStt!(segment);
          return { available: true, analyzer: "stt" as const, data: sttData, latency_ms: 0 } as AnalyzerResult;
        })
      : deps.elevenLabsStt
      ? // ElevenLabs path (async, cloud-based with speaker diarization).
        // ElevenLabs requires raw PCM/WAV — only available via audio_data.pcm.
        // Legacy audio_segments (Float32 fragments) are not supported; skip gracefully.
        (segment.audio_data
          ? (async () => {
              const start = performance.now();
              try {
                const sttResult = await deps.elevenLabsStt!.transcribeAudioData(segment.audio_data!);
                return {
                  available: true,
                  analyzer: "stt" as const,
                  data: { transcript: sttResult.transcript, segments: sttResult.segments } as SttOutput,
                  latency_ms: performance.now() - start,
                } as AnalyzerResult;
              } catch (err) {
                writeStderr(`[STT] ElevenLabs API failed (non-fatal, continuing without STT): ${err instanceof Error ? err.message : String(err)}`);
                return {
                  available: false,
                  analyzer: "stt" as const,
                  latency_ms: performance.now() - start,
                  error: `ElevenLabs API error: ${err instanceof Error ? err.message : String(err)}`,
                } as AnalyzerResult;
              }
            })()
          : Promise.resolve({ available: false, analyzer: "stt" as const, latency_ms: 0, error: "ElevenLabs requires audio_data (not legacy audio_segments)" } as AnalyzerResult))
      : // Moonshine path (local, sync)
        Promise.resolve().then(() => {
          const start = performance.now();
          const sttResult = segment.audio_data
            ? deps.sttAnalyzer!.transcribeAudioData(segment.audio_data)
            : deps.sttAnalyzer!.transcribe(segment.audio_segments!);
          return {
            available: true,
            analyzer: "stt" as const,
            data: { transcript: sttResult.transcript, segments: sttResult.segments } as SttOutput,
            latency_ms: performance.now() - start,
          } as AnalyzerResult;
        }))
    : null;

  let detData: DetectionOutput | undefined;
  let reidData: ReIdOutput | undefined;

  if (strategy.level >= 1) {
    // Level 1: Serial execution — small models first, VLM last with their results
    // Stage 1: Detection
    let detResult: AnalyzerResult | undefined;
    let multiFrameDetections: DetectionOutput[] | undefined;
    let faceDetectionDebug: PerFrameFaceDetectionDebug[] = [];

    if (strategy.run_detection) {
      // Segment-level Percept does not run YOLO. It only consumes detections
      // attached to frames by the upstream frame analyzer. Missing external
      // results are represented as empty per-frame lists. Keep the full
      // detector class set here; tracking narrows to trackable classes below.
      detectionStartedAt = profiler.start("detection");
      const detStart = performance.now();
      multiFrameDetections = segment.frames.map((frame) => {
        const frameArea = getFrameArea(frame);
        const dets: DetectionOutput["detections"] = [];
        for (const d of frame.detections ?? []) {
          detectionFilterDecision.external_detection_count += 1;
          const bbox = {
            x: d.bbox.x1,
            y: d.bbox.y1,
            width: d.bbox.x2 - d.bbox.x1,
            height: d.bbox.y2 - d.bbox.y1,
          };
          if (d.label === "person" && isPersonTooSmallForFrame(bbox, frameArea)) {
            detectionFilterDecision.person_area_filtered_count =
              (detectionFilterDecision.person_area_filtered_count ?? 0) + 1;
            continue;
          }
          dets.push({
            label: d.label,
            confidence: d.confidence,
            bbox,
          });
        }
        return { detections: dets } as DetectionOutput;
      });

      // Gate RetinaFace on person presence: face detection only serves face ReID,
      // VC face_detected signal, and keyframe selection; all handle empty faces gracefully.
      const hasPersonInAnyFrame = multiFrameDetections.some(d =>
        d.detections.some(det => det.label === "person"),
      );

      detectionFilterDecision.retinaface_frames = multiFrameDetections
        .filter(d => d.detections.some(det => det.label === "person"))
        .length;

      if (hasPersonInAnyFrame && deps.router) {
        const faceDetection = await runPerFrameFaceDetection(segment.frames, multiFrameDetections, deps.router);
        multiFrameDetections = faceDetection.detections;
        faceDetectionDebug = faceDetection.debug;
      } else if (!hasPersonInAnyFrame) {
        analyzersSkipped.push("retinaface");
        detectionFilterDecision.retinaface_skipped_reason = "no_person_detection";
      } else if (!deps.router) {
        analyzersSkipped.push("retinaface:no_router");
        detectionFilterDecision.retinaface_skipped_reason = "no_router";
      }

      const detLatency = performance.now() - detStart;
      const midIdx = Math.floor(multiFrameDetections.length / 2);
      detData = multiFrameDetections[midIdx] ?? { detections: [] };
      detResult = { available: true, analyzer: "detection", data: detData, latency_ms: detLatency };
      if (detResult) analyzerResults.push(detResult);
      detectionCompletedAt = Date.now();
      profiler.end("detection", { now: detectionCompletedAt, latencyMs: detLatency });
    }

    const hasDetectionRegistryInput = (multiFrameDetections ?? [])
      .some((frame) => frame.detections.length > 0);

    // ── L1 subject proposal: local detections provide D{id} grounding for the VLM. ──
    if (
      multiFrameDetections &&
      deps.router &&
      hasDetectionRegistryInput
    ) {
      // ══════════════════════════════════════════════════════════
      // SUBJECT PROPOSAL: D{id} registry + per-face ReID + VLM aggregation
      // ══════════════════════════════════════════════════════════

      // Stage SP-1: Build DetectionRegistry with D{id}
      const registry = new DetectionRegistry();
      for (let fi = 0; fi < multiFrameDetections.length; fi++) {
        // Map DetectionOutput.label → RawDetection.class_name
        const rawDets = multiFrameDetections[fi]!.detections.map(d => ({
          bbox: d.bbox,
          class_name: d.label,
          confidence: d.confidence,
        }));
        registry.addFrame(fi, rawDets);
      }

      // Stage SP-2: Face/body ReID pipeline (independent)
      reidStartedAt = profiler.start("reid");
      const firstFrame = segment.frames[0];
      const frameW = firstFrame?.width ?? 1280;
      const frameH = firstFrame?.height ?? 720;
      const faceQualificationDebug = collectFaceQualificationDebug(multiFrameDetections, frameW, frameH);
      const rawFaces = collectQualifiedFaces(multiFrameDetections, frameW, frameH);
      const { usable: sharpFaces, blurRejected } = await measureFaceSharpness(rawFaces, segment.frames);
      const faceResults = await runPerFaceReId(sharpFaces, segment.frames, deps.router, getMemoryReIdPort(deps.memory));
      const faceEntityHistory = new Map<string, string>();
      for (const result of faceResults) {
        if (!result.entity_id) continue;
        const compact = compactPromptText(result.history_behavior, 360);
        if (compact && !faceEntityHistory.has(result.entity_id)) {
          faceEntityHistory.set(result.entity_id, compact);
        }
      }

      // Associate faces to D{id} entries via containment
      associateFaces(registry, faceResults.map(r => ({
        frame_idx: r.face.frameIndex,
        face: {
          bbox: r.face.faceBbox,
          landmarks: r.face.faceLandmarks,
          pose: r.pose,
          embedding: r.embedding,
          entity_id: r.entity_id,
          match_score: r.confidence,
          top_entity_id: r.top_entity_id,
          top_score: r.top_score,
          miss_reason: r.miss_reason,
          quality: r.quality,
          sharpness: r.face.sharpness?.laplacianVariance,
        },
      })));
      const didFaceDebug = registry.all()
        .filter((entry) => entry.class_name === "person")
        .map((entry) => ({
          did: entry.did,
          frame_idx: entry.frame_idx,
          person_bbox: entry.bbox,
          person_confidence: entry.confidence,
          has_face: Boolean(entry.face),
          face_bbox: entry.face?.bbox,
          face_quality: entry.face?.quality,
          face_yaw: entry.face?.pose?.yaw,
          face_pitch: entry.face?.pose?.pitch,
          face_sharpness: entry.face?.sharpness,
          face_entity_id: entry.face?.entity_id,
          face_match_score: entry.face?.match_score,
          face_top_entity_id: entry.face?.top_entity_id,
          face_top_score: entry.face?.top_score,
          face_reid_miss_reason: entry.face?.miss_reason,
          has_face_embedding: Boolean(entry.face?.embedding),
        }));
      // Real visible-name anchoring needs OCR/nameplate-to-person association.
      // Face embeddings alone are not evidence that visible text names a target.

      // Stage SP-2.5: Body ReID (query-only) for all person D{id} entries.
      // Extracts body embeddings and searches reid_entity for matches.
      // NO writes here — gallery update and new entity creation happen in SP-6.
      let bodyReIdResults: BodyReIdResult[] = [];
      let bodyCandidateCount = 0;
      const bodyReidProvider = deps.bodyReIdEnabled === true
        ? deps.router?.getReidProvider?.("body-reid")
        : undefined;
      const poseProvider = deps.bodyReIdEnabled === true
        ? deps.router?.getPoseProvider?.("pose-estimation")
        : undefined;
      if (bodyReidProvider) {
        const personEntries = registry.all().filter((e) => e.class_name === "person");
        const bodyInputs = personEntries.map((entry) => ({
          frameIndex: entry.frame_idx,
          personBbox: entry.bbox,
          personConfidence: entry.confidence,
        }));
        bodyCandidateCount = bodyInputs.length;

        bodyReIdResults = await runPerBodyReId(
          bodyInputs,
          segment.frames,
          poseProvider,
          bodyReidProvider,
          getMemorySearchPort(deps.memory),
        );

        // Associate body results back to D{id} entries via body field
        for (let i = 0; i < personEntries.length; i++) {
          const entry = personEntries[i]!;
          const bodyResult = bodyReIdResults[i];
          if (bodyResult && !bodyResult.skipped && bodyResult.bodyEmbedding) {
            entry.body = {
              embedding: bodyResult.bodyEmbedding,
              entity_id: bodyResult.bodyEntityId,
              match_score: bodyResult.bodyMatchScore,
              quality: bodyResult.bodyQuality,
              body_yaw_ratio: bodyResult.bodyYawRatio,
              visibility: bodyResult.bodyVisibility,
            };
          }
        }
      }

      reidCompletedAt = Date.now();
      profiler.end("reid", { now: reidCompletedAt, latencyMs: reidCompletedAt - reidStartedAt });
      reidData = {
        matches: registry.all()
          .filter((entry) => entry.face?.entity_id)
          .map((entry) => {
            const entityId = entry.face!.entity_id!;
            const match: ReIdOutput["matches"][number] = {
              track_id: entry.did,
              entity_id: entityId,
              confidence: entry.face!.quality ?? 1,
            };
            const history = faceEntityHistory.get(entityId);
            if (history) match.history_behavior = history;
            const faceResult = faceResults.find((result) => result.entity_id === entityId);
            if (faceResult?.subject_index != null) match.subject_index = faceResult.subject_index;
            if (faceResult?.name) match.name = faceResult.name;
            if (faceResult?.first_seen != null) match.first_seen = faceResult.first_seen;
            return match;
          }),
      };
      analyzerResults.push({
        available: true,
        analyzer: "reid",
        data: reidData,
        latency_ms: reidCompletedAt - reidStartedAt,
        trace: {
          mode: "subject_proposal",
          face_candidates: rawFaces.length,
          sharp_face_candidates: sharpFaces.length,
          blur_rejected_face_candidates: blurRejected.length,
          face_matches: faceResults.filter((result) => result.entity_id).length,
          face_detection: faceDetectionDebug,
          face_qualification: faceQualificationDebug,
          did_faces: didFaceDebug,
          body_reid_enabled: deps.bodyReIdEnabled === true,
          body_candidates: bodyCandidateCount,
          body_matches: bodyReIdResults.filter((result) => result && !result.skipped && result.bodyEntityId).length,
        },
      });

      // Await STT (started in parallel with detection)
      let sttData: SttOutput | undefined;
      let sttFailed = false;
      if (sttPromise) {
        const sttResult = await sttPromise;
        if (sttResult.available) {
          sttData = sttResult.data as SttOutput;
        } else if (sttResult.error) {
          sttFailed = true;  // STT ran but failed — audio content unverified
        }
        analyzerResults.push(sttResult);
        sttCompletedAt = Date.now();
        profiler.end("stt", { now: sttCompletedAt, latencyMs: sttResult.latency_ms });
      }

      // VLM gate decision (shared logic)
      const vlmGate = resolveVlmGate({
        eventHint: segment.event_hint,
        multiFrameDetections,
        detData,
        sttData,
        vadSpeechObserved,
        sttAvailable,
        sttFailed,
        strategyRunVlm: strategy.run_vlm,
        isColdStart,
      });
      skipVlm = vlmGate.skipVlm;
      localStaticScene = vlmGate.localStaticScene;
      const willAttemptVlm = vlmGate.willAttemptVlm;
      vlmGateDecision = vlmGate.decision;

      if (skipVlm) {
        writeStderr(`[perception] ${segment.camera_id} seg#${mySegmentCount} | subject proposal SKIP VLM (idle=${vlmGate.decision.is_idle} persons=${vlmGate.decision.relevant_detection_count} audio=${vlmGate.decision.has_audio_content} cold=${isColdStart} segCount=${mySegmentCount})`);
      }

      if (willAttemptVlm) {
        // Prefer text descriptions for cross-segment WM matching. Crops are only
        // attached in ambiguous same-class scenes because extra images increase
        // OpenAI content-safety failures.
        const wmTargets = workingMemory.getTargets(segment.camera_id);
        const vlmWmTargets = prepareWmTargetsForSubjectProposal(wmTargets);
        const frameDimensions = await resolveFrameDimensions(segment.frames);
        const vlmDidSelection = resolveVlmSelectableDIds({ registry, frameDimensions });
        const vlmSelectableEntries = registry.all().filter((entry) => vlmDidSelection.selectableDidIds.has(entry.did));
        vlmDidSelectionArchive = {
          selectable_count: vlmDidSelection.selectableDidIds.size,
          rejected_count: vlmDidSelection.rejected.length,
          rejected: vlmDidSelection.rejected,
        };
        const didContext = buildCompactSubjectEvidenceContext({
          registry,
          wmTargets: vlmWmTargets,
          faceEntityHistory,
          faceResults,
          selectableDidIds: vlmDidSelection.selectableDidIds,
        });
        const attachWmCrops = shouldAttachWmTargetCrops(vlmWmTargets, vlmSelectableEntries);
        const wmTargetCropInputs: Array<{
          target_id: string;
          index: number;
          crop_path: string;
          source: "face" | "body" | "fallback";
          segment_id: string;
          did: string;
          score: number;
          timestamp: number;
          face_quality?: number;
          face_yaw?: number;
          face_pitch?: number;
          attached: boolean;
          error?: "read_failed";
        }> = [];
        const wmTargetContexts: NonNullable<SubjectProposalContext["wmTargets"]> = [];
        for (const t of vlmWmTargets) {
          const context: NonNullable<SubjectProposalContext["wmTargets"]>[number] = {
            target_id: t.target_id,
            class_name: t.class_name,
            appearance: t.appearance?.trim() ?? "",
          };
          if (t.entity_id) context.entity_id = t.entity_id;
          if (t.continuity_strength) context.continuity_strength = t.continuity_strength;
          if (t.entity_id) {
            const history = faceEntityHistory.get(t.entity_id)?.trim();
            if (history) context.history_behavior = history;
          }
          if (t.behavior?.trim()) context.behavior = t.behavior.trim();
          if (t.identity?.name && !t.identity.conflict) {
            context.identity = {
              name: t.identity.name,
              evidence: t.identity.evidence,
            };
          }
          if (t.identity_hints?.length) {
            const hints: Array<{ name: string; evidence?: string; source?: VlmTargetIdentity["source"] }> = t.identity_hints
              .slice(-3)
              .map((hint) => {
                const name = hint.name.trim();
                if (!name) return undefined;
                const evidence = hint.evidence?.trim();
                const source = hint.source;
                return {
                  name,
                  ...(evidence ? { evidence } : {}),
                  ...(source ? { source } : {}),
                };
              })
              .filter((hint): hint is { name: string; evidence?: string; source?: VlmTargetIdentity["source"] } => Boolean(hint));
            if (hints.length > 0) context.identity_hints = hints;
          }
          try {
            if (attachWmCrops && shouldAttachWmTargetCropImages(t)) {
              const stableCrops = (t.stable_crops ?? []).slice(0, 2);
              const crops: string[] = [];
              for (const [index, crop] of stableCrops.entries()) {
                try {
                  const cropBuf = await readFile(crop.crop_path);
                  crops.push(cropBuf.toString("base64"));
                  wmTargetCropInputs.push({
                    target_id: t.target_id,
                    index,
                    crop_path: crop.crop_path,
                    source: crop.source,
                    segment_id: crop.segment_id,
                    did: crop.did,
                    score: crop.score,
                    timestamp: crop.timestamp,
                    ...(crop.face_quality != null ? { face_quality: crop.face_quality } : {}),
                    ...(crop.face_yaw != null ? { face_yaw: crop.face_yaw } : {}),
                    ...(crop.face_pitch != null ? { face_pitch: crop.face_pitch } : {}),
                    attached: true,
                  });
                } catch {
                  wmTargetCropInputs.push({
                    target_id: t.target_id,
                    index,
                    crop_path: crop.crop_path,
                    source: crop.source,
                    segment_id: crop.segment_id,
                    did: crop.did,
                    score: crop.score,
                    timestamp: crop.timestamp,
                    ...(crop.face_quality != null ? { face_quality: crop.face_quality } : {}),
                    ...(crop.face_yaw != null ? { face_yaw: crop.face_yaw } : {}),
                    ...(crop.face_pitch != null ? { face_pitch: crop.face_pitch } : {}),
                    attached: false,
                    error: "read_failed",
                  });
                  // Individual crop may have been cleaned; keep remaining stable crops.
                }
              }
              if (crops.length > 0) {
                context.crop_base64s = crops;
                context.crop_base64 = crops[0];
              }
            }
          } catch { /* crop missing, keep text-only target context */ }
          const hasTextContext = Boolean(
            context.appearance.trim()
            || context.behavior?.trim()
            || context.identity?.name?.trim()
            || context.identity?.evidence?.trim()
            || context.identity_hints?.some((hint) => hint.name.trim() || hint.evidence?.trim())
          );
          if (!hasTextContext && !context.crop_base64 && !context.crop_base64s?.length) continue;
          wmTargetContexts.push(context);
        }

        // Stage SP-4: VLM call with resized frames annotated at final VLM resolution.
        vlmStageStartedAt = profiler.start("vlm_stage");
        const vlmSummaryOnlyFrames = await resizeFramesForVlm(segment.frames, deps.vlmFrameResize);
        const vlmAnnotatedFrames = await annotateVlmFramesWithDIds(
          segment.frames,
          vlmSummaryOnlyFrames,
          registry,
          frameDimensions,
          vlmDidSelection.selectableDidIds,
        );
        const subjectProposal = {
          didContext,
          ...(wmTargetContexts.length > 0 ? { wmTargets: wmTargetContexts } : {}),
        };
        const subjectProposalOptions: VlmSegmentAnalyzeOptions = {
          sceneContext: sceneContext || undefined,
          subjectProposal,
          localModelResults: {
            sttTranscript: formatSttForVlm(sttData),
            hasSpeakerDiarization: hasSpeakerDiarization(sttData),
          },
          segmentPolicyExitPrompt,
          suppressSceneDescription,
          trackStates: semanticContextSections?.trackStates,
          trackActivities: semanticContextSections?.trackActivities,
          hasAnomalyBaseline: semanticContextSections?.hasAnomalyBaseline,
          currentEventSummary,
          recentSegmentSummaries,
          currentEventContext,
          summaryOnlyFrames: vlmSummaryOnlyFrames,
          ...buildVlmCallOptions("subject_proposal"),
        };
        streamingCriticalCommitter = async (fields) => {
          if (runtimeMode !== "live_latency") return;
          if (streamedCriticalContextCommitted) return;
          const missing: string[] = resolveLiveLatencyRequiredFields("subject_proposal")
            .filter((field) => !fields.has(field));
          const rawTargets = fields.get("targets") ?? fields.get("main_targets");
          if (!Array.isArray(rawTargets) && !missing.includes("targets")) missing.push("targets");
          if (missing.length > 0) throw new Error(`critical fields incomplete: ${missing.join(",")}`);

          const criticalJson = JSON.stringify({
            title: fields.get("title"),
            summary: fields.get("summary"),
            security_risk: fields.get("security_risk"),
            is_static_scene: fields.get("is_static_scene"),
            notify_user: fields.get("notify_user"),
            matched_rule_ids: fields.get("matched_rule_ids"),
            best_frame_index: fields.get("best_frame_index"),
            event_boundary: fields.get("event_boundary"),
            targets: rawTargets,
          });
          const parsedCritical = parseSubjectProposalOutput(criticalJson, registry, wmTargets, {
            bodyReIdEnabled: deps.bodyReIdEnabled === true,
            allowedDidIds: vlmDidSelection.selectableDidIds,
            requireTid: true,
          });
          backfillSubjectProposalTargetAppearances(parsedCritical.targets, wmTargets);
          mergeParsedTargetsByEntity(parsedCritical.targets, registry, wmTargets, parsedCritical.errors);
          streamedCriticalParseErrors = parsedCritical.errors;
          streamingCriticalSnapshot = {
            title: parsedCritical.title,
            summary: parsedCritical.summary,
            security_risk: parsedCritical.security_risk,
            is_static_scene: parsedCritical.is_static_scene,
            notify_user: parsedCritical.notify_user,
            matched_rule_ids: parsedCritical.matched_rule_ids,
            best_frame_index: parsedCritical.best_frame_index,
            event_boundary: parsedCritical.event_boundary,
            targets: parsedCritical.targets.map(cloneStreamingCriticalTarget),
          };
          let criticalEventId = eventId;
          if (parsedCritical.event_boundary === true && mySegmentCount > 1) {
            const newId = workingMemory.switchEvent(segment.camera_id, segment.mode, segment.timestamp);
            monitorBus.publish("perception:event_boundary", {
              camera_id: segment.camera_id,
              old_event_id: eventId,
              new_event_id: newId,
              reason: "vlm_content_shift",
            }, segment.camera_id);
            criticalEventId = newId;
            eventBoundaryDecision = {
              requested: true,
              applied: true,
              old_event_id: eventId,
              new_event_id: newId,
              reason: "vlm_content_shift",
            };
          } else {
            eventBoundaryDecision = {
              requested: parsedCritical.event_boundary === true,
              applied: false,
            };
          }
          streamedCriticalFinalEventId = criticalEventId;
          workingMemory.recordSegment(segment.camera_id, segment.segment_id, segment.timestamp);
          if (parsedCritical.summary) {
            workingMemory.appendSceneContext(segment.camera_id, parsedCritical.summary, segment.segment_id, parsedCritical.title);
          }

          const withReidWriteLock = deps.memory?.withReidWriteLock ?? (<T>(fn: () => Promise<T>) => fn());
          await withReidWriteLock(async () => {
            const matchedWmIds = new Set<string>();
            const batchInitPort: BatchInitMemoryPort | undefined =
              deps.memory?.reserveEntityId && deps.memory?.reidBatchInit
                ? {
                    reserveEntityId: deps.memory.reserveEntityId,
                    reidBatchInit: deps.memory.reidBatchInit,
                    ...(deps.memory.reidSearch ? { reidSearch: deps.memory.reidSearch } : {}),
                  }
                : undefined;
            const accumulator = new ReIdAccumulator();
            if (parsedCritical.targets.some((target) => target.visual_identity_only)) {
              const retainedTargets: ParsedSubjectProposalTarget[] = [];
              for (const target of parsedCritical.targets) {
                if (target.visual_identity_only) {
                  await seedVisualOnlyReidEntity(target, "critical");
                } else {
                  retainedTargets.push(target);
                }
              }
              parsedCritical.targets.splice(0, parsedCritical.targets.length, ...retainedTargets);
            }
            for (let targetIdx = 0; targetIdx < parsedCritical.targets.length; targetIdx++) {
              const target = parsedCritical.targets[targetIdx]!;
              const targetKey = streamingTargetKey(target, targetIdx);
              const matchedWmTarget = target.matched_wm_target
                ? wmTargets.find((t) => t.target_id === target.matched_wm_target)
                : undefined;
              const matchedWmNeedsEntity = target.matched_wm_target !== null
                && matchedWmTarget != null
                && !matchedWmTarget.entity_id;
              const allowStableEntityCreate = !(target.matched_wm_target_source === "pending_face" && matchedWmNeedsEntity);
            const subjectIdentity = resolveSubjectIndex({
              category: target.type,
              entity_id: target.entity_id,
              wm_target_id: target.matched_wm_target ?? undefined,
              subject_index: target.subject_index,
              name: target.name ?? undefined,
            });
            applySubjectIdentity(target, subjectIdentity);
            const reidIdentity = {
              category: subjectIdentity.category,
              ...(target.subject_index != null ? { subject_index: target.subject_index } : {}),
              ...(target.name ? { name: target.name } : {}),
              ...(target.first_seen != null ? { first_seen: target.first_seen } : {}),
            };
            const useAccumulator = batchInitPort != null && target.type === "person" && !target.reid_unsafe_reason;
            let pendingFace: PendingEmbedding[] | null = null;
            let pendingBody: PendingEmbedding[] | null = null;
            let pendingEntityId: string | null = null;
            let accumulatorHandled = false;
            if (useAccumulator) {
              const accResult = await accumulator.evaluate(
                { segmentId: segment.segment_id, cameraId: segment.camera_id, identity: reidIdentity },
                target,
                matchedWmTarget,
                registry,
                batchInitPort,
                { allowCreate: allowStableEntityCreate },
              );
              switch (accResult.action) {
                case "match": {
                  target.entity_id = accResult.entity_id;
                  target.subject_index = target.subject_index ?? accResult.subject_index;
                  target.name = accResult.name ?? target.name;
                  target.first_seen = accResult.first_seen ?? target.first_seen;
                  const reboundSubjectIdentity = resolveSubjectIndex({
                    category: target.type,
                    entity_id: target.entity_id,
                    wm_target_id: target.matched_wm_target ?? undefined,
                    subject_index: target.subject_index,
                    name: target.name ?? undefined,
                  });
                  applySubjectIdentity(target, reboundSubjectIdentity);
                  target.entity_id_source = "current_reid";
                  streamedCriticalReidHandledTargetKeys.add(targetKey);
                  accumulatorHandled = true;
                  break;
                }
                case "create": {
                  target.entity_id = accResult.entity_id;
                  target.subject_index = target.subject_index ?? accResult.subject_index;
                  target.name = accResult.name ?? target.name;
                  target.first_seen = accResult.first_seen ?? target.first_seen;
                  const reboundSubjectIdentity = resolveSubjectIndex({
                    category: target.type,
                    entity_id: target.entity_id,
                    wm_target_id: target.matched_wm_target ?? undefined,
                    subject_index: target.subject_index,
                    name: target.name ?? undefined,
                  });
                  applySubjectIdentity(target, reboundSubjectIdentity);
                  target.entity_id_source = "current_reid";
                  streamedCriticalAccumulatorCreatedTargetKeys.add(targetKey);
                  if (accResult.face_slots === 0 && accResult.body_slots > 0) {
                    streamedCriticalBodyCreatedTargetKeys.add(targetKey);
                  }
                  accumulatorHandled = true;
                  break;
                }
                case "gallery_update": {
                  if (deps.bodyReIdEnabled === true && target.entity_id) {
                    const bodyToWrite = await selectVerifiedBodyGalleryVector(target, registry, deps.memory);
                    if (bodyToWrite) {
                      await deps.memory?.reidGalleryUpdate?.(target.entity_id, {
                        body: {
                          vector: bodyToWrite.vector,
                          quality: bodyToWrite.quality,
                          body_yaw_ratio: bodyToWrite.body_yaw_ratio,
                          visibility: bodyToWrite.visibility,
                        },
                      });
                    }
                  }
                  accumulatorHandled = true;
                  break;
                }
                case "pending":
                  pendingFace = accResult.pending_face;
                  pendingBody = accResult.pending_body;
                  pendingEntityId = accResult.pending_entity_id ?? null;
                  if (accResult.wm_entity_inconsistent) {
                    clearResolvedTargetIdentity(
                      target,
                      `wm_inherited_face_inconsistent:max_similarity:${accResult.wm_entity_inconsistent.max_similarity}`,
                    );
                  }
                  accumulatorHandled = true;
                  break;
              }
            }
            if (!accumulatorHandled
                && target.upsert_candidate && !target.entity_id
                && (target.matched_wm_target === null || matchedWmNeedsEntity)
                && allowStableEntityCreate
                && target.type === "person"
                && !target.reid_unsafe_reason) {
              const newEntity = await reidMatchOrCreate(
                deps.memory,
                { type: "face", vector: target.upsert_candidate.embedding, threshold: FACE_REID_MATCH_THRESHOLD },
                {
                  face: {
                    vector: target.upsert_candidate.embedding,
                    quality: target.upsert_candidate.quality,
                    yaw: target.upsert_candidate.yaw,
                    pitch: target.upsert_candidate.pitch,
                  },
                },
                reidIdentity,
              );
              if (newEntity) {
                target.entity_id = newEntity.entity_id;
                target.subject_index = target.subject_index ?? newEntity.subject_index;
                target.name = newEntity.name ?? target.name;
                target.first_seen = newEntity.first_seen ?? target.first_seen;
                const reboundSubjectIdentity = resolveSubjectIndex({
                  category: target.type,
                  entity_id: target.entity_id,
                  wm_target_id: target.matched_wm_target ?? undefined,
                  subject_index: target.subject_index,
                  name: target.name ?? undefined,
                });
                applySubjectIdentity(target, reboundSubjectIdentity);
                target.entity_id_source = "current_reid";
                if (newEntity.is_new) streamedCriticalFaceCreatedTargetKeys.add(targetKey);
                streamedCriticalReidHandledTargetKeys.add(targetKey);
              }
            }
            if (!accumulatorHandled && deps.bodyReIdEnabled === true && target.type === "person" && !target.reid_unsafe_reason) {
              let bodyToWrite = target.entity_id
                ? await selectVerifiedBodyGalleryVector(target, registry, deps.memory)
                : undefined;
              if (!bodyToWrite && !target.entity_id) {
                for (const did of target.bbox_ids) {
                  const entry = registry.get(did);
                  const candidate = entry ? bodyGalleryVectorFromEntry(entry) : undefined;
                  if (!candidate) continue;
                  if (!bodyToWrite || candidate.quality > bodyToWrite.quality) bodyToWrite = candidate;
                }
              }
              if (bodyToWrite) {
                if (target.entity_id && target.entity_id_source === "current_reid") {
                  await deps.memory?.reidGalleryUpdate?.(target.entity_id, {
                    body: { vector: bodyToWrite.vector, quality: bodyToWrite.quality },
                  });
                } else if (!target.entity_id && allowStableEntityCreate) {
                  const newEntity = await reidMatchOrCreate(
                    deps.memory,
                    { type: "body", vector: bodyToWrite.vector, threshold: BODY_REID_MATCH_THRESHOLD },
                    { body: { vector: bodyToWrite.vector, quality: bodyToWrite.quality } },
                    reidIdentity,
                  );
                  if (newEntity) {
                    target.entity_id = newEntity.entity_id;
                    target.subject_index = target.subject_index ?? newEntity.subject_index;
                    target.name = newEntity.name ?? target.name;
                    target.first_seen = newEntity.first_seen ?? target.first_seen;
                    const reboundSubjectIdentity = resolveSubjectIndex({
                      category: target.type,
                      entity_id: target.entity_id,
                      wm_target_id: target.matched_wm_target ?? undefined,
                      subject_index: target.subject_index,
                      name: target.name ?? undefined,
                    });
                    applySubjectIdentity(target, reboundSubjectIdentity);
                    target.entity_id_source = "current_reid";
                    if (newEntity.is_new) streamedCriticalBodyCreatedTargetKeys.add(targetKey);
                    streamedCriticalReidHandledTargetKeys.add(targetKey);
                  }
                }
              }
            }
            let targetId = target.committed_wm_target_id ?? target.matched_wm_target;
            if (!targetId && target.entity_id) {
              targetId = wmTargets.find((t) => t.entity_id === target.entity_id)?.target_id ?? null;
            }
            if (!targetId && target.subject_index != null) {
              targetId = wmTargets.find((t) => t.class_name === target.type && t.last_seen_segment_id !== segment.segment_id && t.target_id === `wm_t${target.subject_index}`)?.target_id ?? null;
            }
            if (!targetId) targetId = workingMemory.allocateTargetId(segment.camera_id);
            target.committed_wm_target_id = targetId;
            matchedWmIds.add(targetId);
            if (target.matched_wm_target) matchedWmIds.add(target.matched_wm_target);
            const boundSubjectIdentity = resolveSubjectIndex({
              category: target.type,
              entity_id: target.entity_id,
              wm_target_id: targetId,
              subject_index: target.subject_index,
              name: target.name ?? undefined,
            });
            applySubjectIdentity(target, boundSubjectIdentity);
            const bestDid = target.bbox_ids[0];
            const safeTrackIds = safeTrackIdsForTarget(registry, target);
            const safeCanonicalDid = safeTrackIds[0];
            if (bestDid) {
              if (target.reid_unsafe_reason) {
                reidUnsafeByTrack.set(bestDid, target.reid_unsafe_reason);
                for (const bid of target.bbox_ids) reidUnsafeByTrack.set(bid, target.reid_unsafe_reason);
              }
              if (safeCanonicalDid) {
                for (const bid of safeTrackIds) streamedCriticalTargetsByCanonical.set(bid, target);
                trackToWmTarget.set(safeCanonicalDid, targetId);
                for (const bid of safeTrackIds) trackToWmTarget.set(bid, targetId);
                for (const bid of safeTrackIds) bboxToCanonical.set(bid, safeCanonicalDid);
              }
              recordSafeCurrentEntityTracks(registry, target);
            }
            const existingWm = matchedWmTarget ?? (target.entity_id ? wmTargets.find((t) => t.entity_id === target.entity_id) : undefined);
            const currentWm = findCurrentWmTarget(workingMemory, segment.camera_id, targetId) ?? existingWm;
            const continuityStrength = resolveTargetContinuityStrength({
              target,
              registry,
              existingTarget: currentWm,
              currentSegmentId: segment.segment_id,
            });
            const stableFaceEmbeddings = stableFaceEmbeddingsForTarget(target, currentWm, registry);
            let cropPath = currentWm?.crop_path ?? "";
            let stableCrops = currentWm?.stable_crops;
            let currentSegmentCropPath = currentSegmentStableCropPath(stableCrops, segment.segment_id);
            try {
              const savedCrop = await saveReliableTargetCrop({
                cameraId: segment.camera_id,
                segmentId: segment.segment_id,
                targetId,
                target,
                registry,
                frames: segment.frames,
                selectableDidIds: vlmDidSelection.selectableDidIds,
                requiredEntityEvidenceId: currentWm?.entity_id,
                preferredDid: currentEntityEvidenceDidForCrop(registry, target),
                mediaUploader,
              });
              if (savedCrop) {
                if (savedCrop.stableCrop) {
                  stableCrops = mergeStableWmCrops(stableCrops, savedCrop.stableCrop);
                  cropPath = bestStableCropPath(stableCrops, savedCrop.cropPath);
                }
                currentSegmentCropPath = savedCrop.cropPath;
                wmCropSelectionArchive.push({
                  stage: "critical",
                  target_id: targetId,
                  selected_did: savedCrop.selectedDid,
                  canonical_did: savedCrop.canonicalDid,
                  score: savedCrop.stableCrop?.score,
                  display_only: savedCrop.displayOnly === true,
                  reused_existing_crop: false,
                });
              }
            } catch {
              // Crop is a continuity hint, not a critical state write requirement.
            }
            const canonicalTargetId = workingMemory.upsertTarget(segment.camera_id, {
              target_id: targetId,
              entity_id: target.entity_id,
              class_name: target.type,
              appearance: target.appearance || currentWm?.appearance || "",
              behavior: target.behavior || currentWm?.behavior,
              crop_path: cropPath,
              stable_crops: stableCrops,
              stable_face_embeddings: stableFaceEmbeddings,
              continuity_strength: continuityStrength,
              last_seen_segment_id: segment.segment_id,
              last_seen_timestamp: segment.timestamp,
              segments_seen: (currentWm?.segments_seen ?? 0) + 1,
              segments_missed: 0,
              pending_face_embeddings: useAccumulator ? (pendingFace ?? null) : undefined,
              pending_body_embeddings: useAccumulator ? (pendingBody ?? null) : undefined,
              pending_entity_id: useAccumulator ? (pendingEntityId ?? null) : undefined,
            });
            if (canonicalTargetId !== targetId) {
              targetId = canonicalTargetId;
              target.committed_wm_target_id = targetId;
              matchedWmIds.add(targetId);
              if (safeCanonicalDid) {
                trackToWmTarget.set(safeCanonicalDid, targetId);
                for (const bid of safeTrackIds) trackToWmTarget.set(bid, targetId);
              }
            }
            // Entity sightings should represent the current segment only.
            // Stable WM crops are kept in working memory for continuity/avatar
            // selection, but must not be emitted as per-segment sightings or
            // the UI will show the same old crop for every later segment.
            target.crop_path = currentSegmentSightingCropPath(target, currentSegmentCropPath);
            }
            workingMemory.tickTargetMiss(segment.camera_id, matchedWmIds);

            const normalizeTrackId = (tid: string): string => bboxToCanonical.get(tid) ?? tid;
            const trackToEntity = new Map<string, string>();
            for (const target of parsedCritical.targets) {
              const canonical = safeTrackIdsForTarget(registry, target)[0];
              if (canonical && target.entity_id && !target.reid_unsafe_reason) trackToEntity.set(canonical, target.entity_id);
            }
            type CriticalIdentityInput = {
              track_id: string;
              name: string;
              evidence: string;
              source: VlmTargetIdentity["source"] | undefined;
              candidateId: string;
            };
            const criticalIdentityInputs = parsedCritical.targets
              .map((target, index) => {
                const identity = target.identity;
                const track_id = safeTrackIdsForTarget(registry, target)[0];
                if (target.identity_write_safe === false || target.reid_unsafe_reason) return undefined;
                if (!identity?.name?.trim() || !track_id) return undefined;
                return {
                  track_id,
                  name: identity.name,
                  evidence: identity.evidence ?? "",
                  source: identity.source,
                  candidateId: `critical:target_identity:${index}:${track_id}`,
                };
              })
              .filter((identity): identity is CriticalIdentityInput => Boolean(identity));
            const hasCriticalVisibleNameAnchor = (trackId: string): boolean => {
              const normalizedTrackId = normalizeTrackId(trackId);
              for (const did of new Set([trackId, normalizedTrackId])) {
                if (visibleNameAnchorTracks.has(did)) return true;
              }
              return false;
            };
            const criticalIdentityCandidates = criticalIdentityInputs
              .map((identity) => {
                const identityName = identity.name?.trim();
                if (!isLikelyPersonIdentityName(identityName, identity.evidence)) return undefined;
                const normalizedTrackId = normalizeTrackId(identity.track_id);
                const directEntityId = confirmedEntityByTrack.get(identity.track_id)
                  ?? safeCurrentReidEntityByTrack.get(identity.track_id);
                const canonicalTrackId = directEntityId
                  ? identity.track_id
                  : (identity.track_id === normalizedTrackId ? normalizedTrackId : identity.track_id);
                const unsafeTrack = reidUnsafeByTrack.has(identity.track_id) || reidUnsafeByTrack.has(normalizedTrackId);
                const confirmedEntityId = unsafeTrack
                  ? undefined
                  : directEntityId ?? (identity.track_id === normalizedTrackId ? confirmedEntityByTrack.get(normalizedTrackId) : undefined);
                const scope = resolveNameIdentityScope({
                  rawTrackId: identity.track_id,
                  normalizedTrackId,
                  canonicalTrackId,
                  entityId: confirmedEntityId,
                  targetIdForTrack: (trackId) => trackToWmTarget.get(trackId),
                  existingNameForTarget: (targetId) => workingMemory.getTargetIdentity(segment.camera_id, targetId)?.name,
                });
                const identityPersistence = classifyTargetIdentityNamePersistence({
                  source: identity.source,
                  evidence: identity.evidence,
                  hasVisibleNameAnchor: hasCriticalVisibleNameAnchor(identity.track_id),
                  bindsStableEntity: Boolean(confirmedEntityId),
                  hasCurrentEntityAnchor: Boolean(directEntityId),
                });
                if (identityPersistence === "reject") {
                  return undefined;
                }
                return {
                  identity,
                  identityName,
                  identityPersistence,
                  canonicalTrackId: scope?.canonicalTrackId ?? canonicalTrackId,
                  targetId: scope?.targetId,
                  unsafeTrack,
                  confirmedEntityId,
                  entityId: confirmedEntityId,
                  existingTargetName: scope?.existingTargetName,
                  bindingKeys: scope?.bindingKeys ?? identityBindingKeys({ trackId: canonicalTrackId }),
                  candidateId: identity.candidateId,
                };
              })
              .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
            const criticalIdentityDecisions = resolveNameIdentityBindings(
              criticalIdentityCandidates.map((candidate): NameIdentityBindingCandidate => ({
                candidate_id: candidate.candidateId,
                name: candidate.identityName,
                binding_keys: candidate.bindingKeys,
                existing_name: candidate.existingTargetName,
              })),
            );
            for (const candidate of criticalIdentityCandidates) {
              const {
                identity,
                identityName,
                identityPersistence,
                canonicalTrackId,
                targetId,
                unsafeTrack,
                confirmedEntityId,
              } = candidate;
              if (criticalIdentityDecisions.get(candidate.candidateId)?.allowed === false) continue;
              if (targetId) {
                if (identityPersistence === "confirmed") {
                  const identityStored = workingMemory.setTargetIdentity(segment.camera_id, targetId, {
                    name: identityName,
                    evidence: identity.evidence,
                    source_segment_id: segment.segment_id,
                  });
                  if (identityStored && confirmedEntityId) {
                    workingMemory.markTargetIdentityPromoted(segment.camera_id, targetId, confirmedEntityId);
                  }
                } else {
                  workingMemory.addTargetIdentityHint(segment.camera_id, targetId, {
                    name: identityName,
                    evidence: identity.evidence,
                    source_segment_id: segment.segment_id,
                    ...(identity.source ? { source: identity.source } : {}),
                  });
                }
              }
              if (identityPersistence !== "confirmed") continue;
              if (!unsafeTrack && confirmedEntityId) {
                const subjectIdentity = resolveSubjectIndex({ category: "person", entity_id: confirmedEntityId, wm_target_id: targetId, name: identityName });
                await deps.memory?.reidUpdateIdentity?.(
                  confirmedEntityId,
                  identityName,
                  subjectIdentity.subject_index != null ? { subject_index: subjectIdentity.subject_index } : undefined,
                );
              } else if (targetId) {
                resolveSubjectIndex({ category: "person", wm_target_id: targetId, name: identityName });
              }
            }
          });

          const criticalSttSegments = sttData?.segments?.filter(s => s.text.trim()) ?? [];
          if (criticalSttSegments.length || sttData?.transcript?.trim()) {
            const normalizeCriticalTrackId = (tid: string): string => bboxToCanonical.get(tid) ?? tid;
            const criticalValidTrackIds = new Set<string>();
            const criticalTrackToEntity = new Map<string, string>();
            const criticalSpeakerLinks: Array<{ speaker_id: string; track_id: string }> = [];
            for (const target of parsedCritical.targets) {
              const safeTrackIds = safeTrackIdsForTarget(registry, target);
              for (const did of safeTrackIds) {
                criticalValidTrackIds.add(did);
                if (target.entity_id && !target.reid_unsafe_reason) criticalTrackToEntity.set(did, target.entity_id);
              }
              const bestDid = safeTrackIds[0];
              if (!bestDid || !target.speaker_ids?.length) continue;
              for (const speakerId of target.speaker_ids) {
                const trimmed = speakerId.trim();
                if (trimmed) criticalSpeakerLinks.push({ speaker_id: trimmed, track_id: bestDid });
              }
            }
            const isValidCriticalTrackReference = (tid: string): boolean =>
              criticalValidTrackIds.has(tid) || criticalValidTrackIds.has(normalizeCriticalTrackId(tid));
            const resolveCriticalIdentityLevel = (trackId: string): {
              canonicalId?: string;
              entityId?: string;
              identityLevel: SpeakerIdentityLevel;
            } => {
              const normalizedTrackId = normalizeCriticalTrackId(trackId);
              if (!isValidCriticalTrackReference(trackId)) return { identityLevel: "unknown" };
              const directEntityId = confirmedEntityByTrack.get(trackId) ?? safeCurrentReidEntityByTrack.get(trackId);
              const entityId = directEntityId
                ?? criticalTrackToEntity.get(trackId)
                ?? criticalTrackToEntity.get(normalizedTrackId);
              return {
                canonicalId: directEntityId ? trackId : (trackId === normalizedTrackId ? normalizedTrackId : trackId),
                entityId,
                identityLevel: entityId ? "entity_id" : "event_local",
              };
            };
            const criticalDialogue = assembleDialogueFromSpeakerLinks({
              sttSegments: criticalSttSegments,
              transcript: sttData?.transcript,
              speakerLinks: criticalSpeakerLinks,
              normalizeTrackId: normalizeCriticalTrackId,
              isValidTrackReference: isValidCriticalTrackReference,
              resolveIdentityLevel: resolveCriticalIdentityLevel,
            });
            if (criticalDialogue.speakerToEntity.size > 0 && sttData) {
              for (const seg of sttData.segments) {
                if (seg.speaker && criticalDialogue.speakerToEntity.has(seg.speaker)) {
                  seg.entity_id = criticalDialogue.speakerToEntity.get(seg.speaker);
                }
              }
            }
            if (criticalDialogue.dialogue.length > 0 || sttData?.transcript?.trim()) {
              publishDerivedSegmentPartial({
                field: "dialogue",
                value: criticalDialogue.dialogue,
                eventId: criticalEventId,
                transcript: sttData?.transcript,
              });
            }
          }

          streamingCriticalFrozenTargets = parsedCritical.targets.map(cloneFullSubjectProposalTarget);
          if (streamingCriticalSnapshot) {
            streamingCriticalSnapshot.targets = parsedCritical.targets.map(cloneStreamingCriticalTarget);
          }
          streamedCriticalContextCommitted = true;
          streamedCriticalTargetsCommitted = true;
          await commitCriticalState();
        };
        let segmentAnalysis: Awaited<ReturnType<VlmAnalyzer["analyzeSegment"]>> | undefined;
        try {
          vlmAnalyzeStartedAt = profiler.start("vlm_analyze");
          segmentAnalysis = await vlmAnalyzer.analyzeSegment(vlmAnnotatedFrames, strategy.vlm_model, subjectProposalOptions);
          vlmAnalyzeCompletedAt = Date.now();
          vlmAnalyzeLatencyMs = segmentAnalysis.latency_ms;
          profiler.end("vlm_analyze", { now: vlmAnalyzeCompletedAt, latencyMs: vlmAnalyzeLatencyMs });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (err instanceof VlmAnalysisError) {
            vlmArchive = err.archive;
          }
          writeStderr(`[vlm-analyzer] VLM failed (${Date.now() - analysisStartedAt}ms): ${msg}`);
          const failedAt = Date.now();
          vlmAnalyzeCompletedAt = failedAt;
          vlmAnalyzeLatencyMs = failedAt - (vlmAnalyzeStartedAt ?? vlmStageStartedAt ?? analysisStartedAt);
          profiler.end("vlm_analyze", { now: vlmAnalyzeCompletedAt, latencyMs: vlmAnalyzeLatencyMs });
          analyzerResults.push({
            available: false,
            analyzer: "vlm",
            error: msg,
            latency_ms: failedAt - (vlmStageStartedAt ?? analysisStartedAt),
            trace: err instanceof VlmAnalysisError
              ? {
                  llm_call_id: err.llmCall?.call_id,
                  archive: err.archive,
                }
              : undefined,
          });
          vlmCompletedAt = failedAt;
          profiler.end("vlm_stage", { now: vlmCompletedAt });
          vlmFailed = true;
        }
        if (!segmentAnalysis) {
          workingMemory.tickTargetMiss(segment.camera_id, new Set());
        } else {
          vlmArchive = segmentAnalysis.archive;
          const rawVlmJson = segmentAnalysis.normalizedJson;
          vlmCompletedAt = Date.now();

          // Stage SP-5: Parse + validate VLM output
          const targetAggregation = segmentAnalysis.subject_proposal_context?.target_aggregation ?? "enabled";
          const effectiveWmTargetIds = new Set(segmentAnalysis.subject_proposal_context?.wm_target_ids ?? wmTargets.map((target) => target.target_id));
          const effectiveWmTargets = wmTargets.filter((target) => effectiveWmTargetIds.has(target.target_id));
          const parsedSubjectProposal = targetAggregation === "disabled"
            ? parseSubjectProposalEnvelopeOnly(rawVlmJson)
            : parseSubjectProposalOutput(rawVlmJson, registry, effectiveWmTargets, {
              bodyReIdEnabled: deps.bodyReIdEnabled === true,
              allowedDidIds: vlmDidSelection.selectableDidIds,
              requireTid: runtimeMode === "live_latency",
            });
          if (runtimeMode === "live_latency" && streamedCriticalContextCommitted) {
            const conflicts = reconcileStreamingCriticalSnapshot(parsedSubjectProposal, streamingCriticalSnapshot, streamingCriticalFrozenTargets);
            if (conflicts.length > 0) {
              streamingCriticalConflictFields = [...new Set([...streamingCriticalConflictFields, ...conflicts])];
            }
          }
          const parsedTargets = parsedSubjectProposal.targets;
          backfillSubjectProposalTargetAppearances(parsedTargets, wmTargets);
          for (const target of parsedTargets) {
            const criticalTarget = target.bbox_ids
              .map((bid) => streamedCriticalTargetsByCanonical.get(bid))
              .find((candidate): candidate is ParsedSubjectProposalTarget => candidate != null);
            if (!criticalTarget) continue;
            target.entity_id = target.entity_id ?? criticalTarget.entity_id;
            target.entity_id_source = target.entity_id_source ?? criticalTarget.entity_id_source;
            target.subject_index = target.subject_index ?? criticalTarget.subject_index;
            target.name = target.name ?? criticalTarget.name;
            target.first_seen = target.first_seen ?? criticalTarget.first_seen;
            target.committed_wm_target_id = target.committed_wm_target_id ?? criticalTarget.committed_wm_target_id;
            target.matched_wm_target = target.matched_wm_target ?? criticalTarget.matched_wm_target;
            target.matched_wm_target_source = target.matched_wm_target_source ?? criticalTarget.matched_wm_target_source;
          }
          mergeParsedTargetsByEntity(parsedTargets, registry, wmTargets, parsedSubjectProposal.errors);
          const parseErrors = parsedSubjectProposal.errors;
          if (parseErrors.length > 0) {
            writeStderr(`[perception] subject proposal parse errors: ${parseErrors.join("; ")}`);
          }
          postprocessArchive = {
            mode: targetAggregation === "disabled" ? "subject_proposal_summary_only" : "subject_proposal",
            fallback_layer: segmentAnalysis.subject_proposal_context?.fallback_layer,
            detection_registry_count: registry.all().length,
            vlm_did_selection: vlmDidSelectionArchive,
            wm_target_count: wmTargets.length,
            wm_target_prompt_count: effectiveWmTargets.length,
            wm_target_image_count: segmentAnalysis.subject_proposal_context?.wm_target_image_count ?? wmTargetContexts.reduce((count, target) => count + (target.crop_base64s?.length ?? (target.crop_base64 ? 1 : 0)), 0),
            wm_target_crop_input_policy: {
              attach_wm_crops: attachWmCrops,
              selectable_did_count: vlmDidSelection.selectableDidIds.size,
              vlm_wm_target_count: vlmWmTargets.length,
            },
            wm_target_crop_inputs: wmTargetCropInputs,
            target_aggregation: targetAggregation,
            subject_input_context: didContext,
            parsed_target_count: parsedTargets.length,
            parse_error_count: parseErrors.length,
            parse_errors: parseErrors,
            target_mapping: {
              vlm_targets: parsedSubjectProposal.targets.length,
              matched_wm_targets: parsedTargets.filter((t) => t.matched_wm_target !== null).length,
              dropped_targets: parseErrors.filter((err) => err.includes("target dropped")),
              unmatched_references: parseErrors.filter((err) => err.includes("not found")),
            },
            wm_crop_selection: wmCropSelectionArchive,
            streaming_critical: {
              committed: streamedCriticalContextCommitted,
              fallback_reason: streamingCriticalFallbackReason,
              section_closed_by: streamingCriticalSectionClosedBy,
              section_closed_at: streamingCriticalSectionClosedAt,
              last_missing_fields: streamingCriticalLastMissingFields.length > 0 ? streamingCriticalLastMissingFields : undefined,
              parse_errors: streamedCriticalParseErrors.length > 0 ? streamedCriticalParseErrors : undefined,
            },
          };

          // Stage SP-6: Post-VLM — gallery update + crop + WM
          const matchedWmIds = new Set<string>();
          const withReidWriteLock = deps.memory?.withReidWriteLock ?? (<T>(fn: () => Promise<T>) => fn());
          if (parsedTargets.some((target) => target.visual_identity_only)) {
            const retainedTargets: ParsedSubjectProposalTarget[] = [];
            await withReidWriteLock(async () => {
              for (const target of parsedTargets) {
                if (target.visual_identity_only) {
                  await seedVisualOnlyReidEntity(target, "final");
                } else {
                  retainedTargets.push(target);
                }
              }
            });
            parsedTargets.splice(0, parsedTargets.length, ...retainedTargets);
          }
          // Collect all gallery candidates across targets, then process
          const allConfirmed: Array<typeof parsedTargets[number]["gallery_candidates"][number]> = [];
          const unmatchedByEntity = new Map<string, Array<typeof parsedTargets[number]["gallery_candidates"][number]>>();
          for (const target of parsedTargets) {
            const galleryWriteDids = target.gallery_write_dids
              ? new Set(target.gallery_write_dids)
              : undefined;
            for (const gc of target.gallery_candidates) {
              if (galleryWriteDids && !galleryWriteDids.has(gc.did)) continue;
              if (gc.trust === "confirmed") {
                allConfirmed.push(gc);
              } else if (
                gc.trust === "unmatched"
                && (target.entity_id_source === "current_reid" || target.entity_id_source === "wm_inherited")
              ) {
                const list = unmatchedByEntity.get(gc.entity_id) ?? [];
                list.push(gc);
                unmatchedByEntity.set(gc.entity_id, list);
              }
            }
          }
          // Gallery updates — pipeline is the SINGLE source of gallery writes
          for (const gc of allConfirmed) {
            await withReidWriteLock(async () => {
              try {
                await deps.memory?.reidGalleryUpdate?.(gc.entity_id, {
                  face: { vector: gc.embedding, quality: gc.quality, yaw: gc.yaw, pitch: gc.pitch },
                });
              } catch (err) {
                writeStderr(`[perception] gallery update failed for entity ${gc.entity_id}: ${err instanceof Error ? err.message : err}`);
              }
            });
          }
          // Max 1 unmatched per entity per segment, pick highest quality
          for (const [entityId, candidates] of unmatchedByEntity) {
            if (!deps.memory?.reidSearch) continue;
            candidates.sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0));
            const best = candidates[0]!;
            await withReidWriteLock(async () => {
              try {
                const searchResults = await deps.memory!.reidSearch!(best.embedding, "face");
                const topMatch = searchResults[0];
                if (topMatch && topMatch.entity_id === entityId && topMatch.score >= GALLERY_APPEND_THRESHOLD) {
                  await deps.memory?.reidGalleryUpdate?.(entityId, {
                    face: { vector: best.embedding, quality: best.quality, yaw: best.yaw, pitch: best.pitch },
                  });
                }
              } catch (err) {
                writeStderr(`[perception] gallery append failed for entity ${entityId}: ${err instanceof Error ? err.message : err}`);
              }
            });
          }
          // Track targets that created entities (used for is_new_entity downstream).
          const faceCreatedEntityTargets = new Set<number>();
          const bodyCreatedEntityTargets = new Set<number>();

          // Multi-frame ReID accumulator — used for person targets when batch-init is available.
          const accumulator = new ReIdAccumulator();
          const batchInitPort: BatchInitMemoryPort | undefined =
            deps.memory?.reserveEntityId && deps.memory?.reidBatchInit
              ? {
                  reserveEntityId: deps.memory.reserveEntityId,
                  reidBatchInit: deps.memory.reidBatchInit,
                  ...(deps.memory.reidSearch ? { reidSearch: deps.memory.reidSearch } : {}),
                }
              : undefined;
          const accumulatorCreatedEntityTargets = new Set<number>();
          const accumulatorDebug: ReIdAccumulatorDebug[] = [];

          for (const target of parsedTargets) {
            const matchedWmTarget = target.matched_wm_target
              ? wmTargets.find((t) => t.target_id === target.matched_wm_target)
              : undefined;
            const matchedWmNeedsEntity = target.matched_wm_target !== null
              && matchedWmTarget != null
              && !matchedWmTarget.entity_id;
            const allowStableEntityCreate = !(target.matched_wm_target_source === "pending_face" && matchedWmNeedsEntity);

            // ── Multi-frame ReID accumulator path ──
            // The accumulator decides create/gallery_update/pending in a
            // multi-frame consistency-verified way when batch-init is available.
            const targetIdx = parsedTargets.indexOf(target);
            const targetKey = streamingTargetKey(target, targetIdx);
            const subjectIdentity = resolveSubjectIndex({
              category: target.type,
              entity_id: target.entity_id,
              wm_target_id: target.matched_wm_target ?? undefined,
              subject_index: target.subject_index,
              name: target.name ?? undefined,
            });
            applySubjectIdentity(target, subjectIdentity);
            const reidIdentity = {
              category: subjectIdentity.category,
              ...(target.subject_index != null ? { subject_index: target.subject_index } : {}),
              ...(target.name ? { name: target.name } : {}),
              ...(target.first_seen != null ? { first_seen: target.first_seen } : {}),
            };
            const useAccumulator = batchInitPort != null
              && target.type === "person"
              && !target.reid_unsafe_reason;
            const reidHandledByCritical = streamedCriticalReidHandledTargetKeys.has(targetKey)
              || streamedCriticalFaceCreatedTargetKeys.has(targetKey)
              || streamedCriticalAccumulatorCreatedTargetKeys.has(targetKey)
              || streamedCriticalBodyCreatedTargetKeys.has(targetKey);

            let pendingFace: PendingEmbedding[] | null = null;
            let pendingBody: PendingEmbedding[] | null = null;
            let pendingEntityId: string | null = null;
            let accumulatorHandled = false;
            const accDebug = useAccumulator
              ? buildReIdAccumulatorDebug(target, targetIdx, matchedWmTarget, registry)
              : undefined;
            const hasFinalBodyReidCandidate = deps.bodyReIdEnabled === true
              && target.bbox_ids.some((did) => Boolean(registry.get(did)?.body?.embedding));

            const runFinalTargetReidDecision = async (): Promise<void> => {
              if (useAccumulator && !reidHandledByCritical) {
                const accResult = await accumulator.evaluate(
                  { segmentId: segment.segment_id, cameraId: segment.camera_id, identity: reidIdentity },
                  target,
                  matchedWmTarget,
                  registry,
                  batchInitPort,
                  { allowCreate: allowStableEntityCreate },
                );

                switch (accResult.action) {
                  case "match":
                    target.entity_id = accResult.entity_id;
                    target.subject_index = target.subject_index ?? accResult.subject_index;
                    target.name = accResult.name ?? target.name;
                    target.first_seen = accResult.first_seen ?? target.first_seen;
                    const matchedSubjectIdentity = resolveSubjectIndex({
                      category: target.type,
                      entity_id: target.entity_id,
                      wm_target_id: target.matched_wm_target ?? undefined,
                      subject_index: target.subject_index,
                      name: target.name ?? undefined,
                    });
                    applySubjectIdentity(target, matchedSubjectIdentity);
                    target.entity_id_source = "current_reid";
                    if (accDebug) {
                      accDebug.result = {
                        action: "match",
                        entity_id: accResult.entity_id,
                        match_type: accResult.match_type,
                        score: accResult.score,
                      };
                    }
                    accumulatorHandled = true;
                    break;

                  case "create":
                    target.entity_id = accResult.entity_id;
                    target.subject_index = target.subject_index ?? accResult.subject_index;
                    target.name = accResult.name ?? target.name;
                    target.first_seen = accResult.first_seen ?? target.first_seen;
                    const reboundSubjectIdentity = resolveSubjectIndex({
                      category: target.type,
                      entity_id: target.entity_id,
                      wm_target_id: target.matched_wm_target ?? undefined,
                      subject_index: target.subject_index,
                      name: target.name ?? undefined,
                    });
                    applySubjectIdentity(target, reboundSubjectIdentity);
                    target.entity_id_source = "current_reid";
                    accumulatorCreatedEntityTargets.add(targetIdx);
                    if (accDebug) {
                      accDebug.result = {
                        action: "create",
                        entity_id: accResult.entity_id,
                        face_slots: accResult.face_slots,
                        body_slots: accResult.body_slots,
                        init_reason: accResult.init_reason,
                      };
                    }
                    if (accResult.face_slots === 0 && accResult.body_slots > 0) {
                      bodyCreatedEntityTargets.add(targetIdx);
                    }
                    accumulatorHandled = true;
                    break;

                  case "gallery_update":
                    if (accDebug) {
                      accDebug.result = {
                        action: "gallery_update",
                        entity_id: target.entity_id,
                        entity_id_source: target.entity_id_source,
                      };
                    }
                    if (deps.bodyReIdEnabled === true && target.entity_id) {
                      const bodyToWrite = await selectVerifiedBodyGalleryVector(target, registry, deps.memory);
                      if (bodyToWrite) {
                        try {
                          await deps.memory?.reidGalleryUpdate?.(target.entity_id!, {
                            body: {
                              vector: bodyToWrite.vector,
                              quality: bodyToWrite.quality,
                              body_yaw_ratio: bodyToWrite.body_yaw_ratio,
                              visibility: bodyToWrite.visibility,
                            },
                          });
                        } catch (err) {
                          writeStderr(`[perception] body gallery update failed: ${err instanceof Error ? err.message : err}`);
                        }
                      }
                    }
                    accumulatorHandled = true;
                    break;

                  case "pending":
                    pendingFace = accResult.pending_face;
                    pendingBody = accResult.pending_body;
                    pendingEntityId = accResult.pending_entity_id ?? null;
                    if (accResult.wm_entity_inconsistent) {
                      clearResolvedTargetIdentity(
                        target,
                        `wm_inherited_face_inconsistent:max_similarity:${accResult.wm_entity_inconsistent.max_similarity}`,
                      );
                    }
                    if (accDebug) {
                      accDebug.result = {
                        action: "pending",
                        pending_reason: accResult.pending_reason,
                        pending_face_count: pendingFace.length,
                        pending_body_count: pendingBody.length,
                        pending_entity_id: pendingEntityId,
                        batch_init_error: accResult.batch_init_error,
                        wm_entity_inconsistent: accResult.wm_entity_inconsistent,
                      };
                    }
                    accumulatorHandled = true;
                    break;
                }
              }

              // Upsert new entity: the upsert_candidate has already passed the
              // strict face-init policy in the parser. Side-profile faces can
              // enrich an existing gallery but cannot single-frame create here.
              // Pipeline only checks structural conditions. If a visual target is already
              // matched to an anonymous WM target, allow the first good face to attach a
              // stable ReID entity to that existing target instead of blocking creation.
              // SKIP when the accumulator already handled this target.
              if (!reidHandledByCritical
                  && !accumulatorHandled
                  && target.upsert_candidate && !target.entity_id
                  && (target.matched_wm_target === null || matchedWmNeedsEntity)
                  && allowStableEntityCreate
                  && target.type === "person"
                  && !target.reid_unsafe_reason) {
                try {
                  const newEntity = await reidMatchOrCreate(
                    deps.memory,
                    { type: "face", vector: target.upsert_candidate!.embedding, threshold: FACE_REID_MATCH_THRESHOLD },
                    {
                      face: {
                        vector: target.upsert_candidate!.embedding,
                        quality: target.upsert_candidate!.quality,
                        yaw: target.upsert_candidate!.yaw,
                        pitch: target.upsert_candidate!.pitch,
                      },
                    },
                    reidIdentity,
                  );
                  if (newEntity) {
                    target.entity_id = newEntity.entity_id;
                    target.subject_index = target.subject_index ?? newEntity.subject_index;
                    target.name = newEntity.name ?? target.name;
                    target.first_seen = newEntity.first_seen ?? target.first_seen;
                    const reboundSubjectIdentity = resolveSubjectIndex({
                      category: target.type,
                      entity_id: target.entity_id,
                      wm_target_id: target.matched_wm_target ?? undefined,
                      subject_index: target.subject_index,
                      name: target.name ?? undefined,
                    });
                    applySubjectIdentity(target, reboundSubjectIdentity);
                    target.entity_id_source = "current_reid";
                    if (newEntity.is_new) faceCreatedEntityTargets.add(targetIdx);
                  }
                } catch { /* non-fatal */ }
              }

              // Body ReID writes — gallery update or body-only upsert.
              // AFTER face upsert so target.entity_id is populated for new face entities.
              // SKIP when the accumulator already handled this target.
              //
              // Write policy:
              //   1. Prefer body whose pre-VLM search already confirmed target.entity_id
              //   2. For confirmed body or face-upsert-initialized entity: gallery-update
              //   3. No entity_id + has body embedding → body-only upsert (new entity)
              //   4. wm_inherited entity_id → SKIP (not confirmed by current segment ReID)
              if (!reidHandledByCritical && !accumulatorHandled && deps.bodyReIdEnabled === true && target.type === "person" && !target.reid_unsafe_reason) {
                // Collect body embeddings from this target's D{id} entries, categorized:
                //  - confirmedBody: body search matched target.entity_id → safe to write
                //  - upsertDidBody: body from the same D{id} as face upsert_candidate → safe for new entity init
                //  - bestUnmatchedBody: any unmatched body → needs verification for pre-existing entities
                let confirmedBody: { embedding: number[]; quality: number } | undefined;
                let upsertDidBody: { embedding: number[]; quality: number } | undefined;
                let bestUnmatchedBody: { embedding: number[]; quality: number } | undefined;
                const upsertDid = target.upsert_candidate?.did;
                for (const did of target.bbox_ids) {
                  const entry = registry.get(did);
                  if (!entry?.body?.embedding) continue;
                  const body = { embedding: entry.body.embedding, quality: entry.body.quality ?? 0 };
                  if (entry.body.entity_id && entry.body.entity_id === target.entity_id) {
                    if (!confirmedBody || body.quality > confirmedBody.quality) confirmedBody = body;
                  } else if (!entry.body.entity_id) {
                    if (did === upsertDid) upsertDidBody = body;
                    if (!bestUnmatchedBody || body.quality > bestUnmatchedBody.quality) bestUnmatchedBody = body;
                  }
                  // body.entity_id !== target.entity_id → skip (belongs to different entity)
                }

                // Decide which body to write:
                let bodyToWrite: { embedding: number[]; quality: number } | undefined;
                if (confirmedBody) {
                  // Body search confirmed this entity — safe
                  bodyToWrite = confirmedBody;
                } else if (target.entity_id && target.entity_id_source === "current_reid") {
                  if (target.upsert_candidate && upsertDidBody) {
                    // Brand-new face entity — only use body from SAME D{id} as the face upsert
                    bodyToWrite = upsertDidBody;
                  } else if (bestUnmatchedBody && deps.memory?.reidSearch) {
                    // Pre-existing entity — verify unmatched body belongs to this entity
                    try {
                      const verifyResults = await deps.memory!.reidSearch!(bestUnmatchedBody.embedding, "body");
                      const topMatch = verifyResults[0];
                      if (topMatch && topMatch.entity_id === target.entity_id && topMatch.score >= BODY_REID_MATCH_THRESHOLD) {
                        bodyToWrite = bestUnmatchedBody;
                      }
                    } catch {
                      /* verification failed → skip */
                    }
                  }
                } else if (bestUnmatchedBody && !target.entity_id) {
                  // No entity at all — will go to body-only upsert below
                  bodyToWrite = bestUnmatchedBody;
                }

                if (bodyToWrite) {
                  if (target.entity_id && target.entity_id_source === "current_reid") {
                    const bodyWrite = bodyToWrite;
                    try {
                      await deps.memory?.reidGalleryUpdate?.(target.entity_id!, {
                        body: { vector: bodyWrite.embedding, quality: bodyWrite.quality },
                      });
                    } catch (err) {
                      writeStderr(`[perception] body gallery update failed for ${target.entity_id}: ${err instanceof Error ? err.message : err}`);
                    }
                  } else if (!target.entity_id && allowStableEntityCreate) {
                    // No entity from face or body search, VLM accepted this target —
                    // create body-only entity so future body searches can match.
                    try {
                      const bodyWrite = bodyToWrite;
                      const newEntity = await reidMatchOrCreate(
                        deps.memory,
                        { type: "body", vector: bodyWrite.embedding, threshold: BODY_REID_MATCH_THRESHOLD },
                        { body: { vector: bodyWrite.embedding, quality: bodyWrite.quality } },
                        reidIdentity,
                      );
                      if (newEntity) {
                        target.entity_id = newEntity.entity_id;
                        target.subject_index = target.subject_index ?? newEntity.subject_index;
                        target.name = newEntity.name ?? target.name;
                        target.first_seen = newEntity.first_seen ?? target.first_seen;
                        const reboundSubjectIdentity = resolveSubjectIndex({
                          category: target.type,
                          entity_id: target.entity_id,
                          wm_target_id: target.matched_wm_target ?? undefined,
                          subject_index: target.subject_index,
                          name: target.name ?? undefined,
                        });
                        applySubjectIdentity(target, reboundSubjectIdentity);
                        target.entity_id_source = "current_reid";
                        if (newEntity.is_new) bodyCreatedEntityTargets.add(targetIdx);
                      }
                    } catch { /* non-fatal */ }
                  }
                  // wm_inherited entity_id → skip body writes (not confirmed by current ReID)
                }
              }
            };

            const needsFinalTargetReidLock = !reidHandledByCritical
              && target.type === "person"
              && !target.reid_unsafe_reason
              && (useAccumulator || target.upsert_candidate != null || hasFinalBodyReidCandidate);
            if (needsFinalTargetReidLock) {
              await withReidWriteLock(runFinalTargetReidDecision);
            } else {
              await runFinalTargetReidDecision();
            }

            const canonicalDid = target.bbox_ids[0];
            const safeTrackIds = safeTrackIdsForTarget(registry, target);
            const safeCanonicalDid = safeTrackIds[0];
            if (canonicalDid) {
              if (target.reid_unsafe_reason) {
                reidUnsafeByTrack.set(canonicalDid, target.reid_unsafe_reason);
                for (const bid of target.bbox_ids) reidUnsafeByTrack.set(bid, target.reid_unsafe_reason);
              }
              if (safeCanonicalDid) {
                for (const bid of safeTrackIds) bboxToCanonical.set(bid, safeCanonicalDid);
              }
              if (target.entity_id && target.entity_id_source === "current_reid" && !target.reid_unsafe_reason) {
                recordSafeCurrentEntityTracks(registry, target);
              }
            }

            // Crop the best reliable bbox. Do not let oversized/ambiguous D{id}s
            // overwrite the stable WM crop, because that poisons later matching.
            if (target.bbox_ids.length > 0) {
              const bestDid = target.bbox_ids[0]!;
              const entry = registry.get(bestDid);
              if (entry) {
                try {
                  // WM update — fallback: if no VLM match but entity_id exists in WM, reuse that target
                  let targetId = target.committed_wm_target_id ?? target.matched_wm_target;
                  if (!targetId && target.entity_id) {
                    const existingWm = wmTargets.find((t) => t.entity_id === target.entity_id);
                    if (existingWm) targetId = existingWm.target_id;
                  }
                  if (!targetId) targetId = workingMemory.allocateTargetId(segment.camera_id);
                  target.committed_wm_target_id = targetId;
                  if (target.matched_wm_target) matchedWmIds.add(target.matched_wm_target);
                  if (targetId !== target.matched_wm_target) matchedWmIds.add(targetId); // also protect entity-fallback
                  if (accDebug) accDebug.chosen_target_id = targetId;

                  const existingTarget = findCurrentWmTarget(workingMemory, segment.camera_id, targetId)
                    ?? wmTargets.find(t => t.target_id === targetId);
                  const continuityStrength = resolveTargetContinuityStrength({
                    target,
                    registry,
                    existingTarget,
                    currentSegmentId: segment.segment_id,
                  });
                  const stableFaceEmbeddings = stableFaceEmbeddingsForTarget(target, existingTarget, registry);
                  let cropPath = existingTarget?.crop_path ?? "";
                  let stableCrops = existingTarget?.stable_crops;
                  let currentSegmentCropPath = currentSegmentStableCropPath(stableCrops, segment.segment_id);
                  const savedCrop = await saveReliableTargetCrop({
                    cameraId: segment.camera_id,
                    segmentId: segment.segment_id,
                    targetId,
                    target,
                    registry,
                    frames: segment.frames,
                    selectableDidIds: vlmDidSelection.selectableDidIds,
                    requiredEntityEvidenceId: existingTarget?.entity_id,
                    preferredDid: currentEntityEvidenceDidForCrop(registry, target),
                    mediaUploader,
                  });
                  if (savedCrop) {
                    if (savedCrop.stableCrop) {
                      stableCrops = mergeStableWmCrops(stableCrops, savedCrop.stableCrop);
                      cropPath = bestStableCropPath(stableCrops, savedCrop.cropPath);
                    }
                    currentSegmentCropPath = savedCrop.cropPath;
                    wmCropSelectionArchive.push({
                      target_id: targetId,
                      selected_did: savedCrop.selectedDid,
                      canonical_did: savedCrop.canonicalDid ?? bestDid,
                      score: savedCrop.stableCrop?.score,
                      display_only: savedCrop.displayOnly === true,
                      reused_existing_crop: false,
                    });
                  } else {
                    wmCropSelectionArchive.push({
                      target_id: targetId,
                      canonical_did: bestDid,
                      rejected_bbox_ids: target.bbox_ids,
                      reused_existing_crop: Boolean(cropPath),
                    });
                  }

                  const boundSubjectIdentity = resolveSubjectIndex({
                    category: target.type,
                    entity_id: target.entity_id,
                    wm_target_id: targetId,
                    subject_index: target.subject_index,
                    name: target.name ?? undefined,
                  });
                  applySubjectIdentity(target, boundSubjectIdentity);

                  const canonicalTargetId = workingMemory.upsertTarget(segment.camera_id, {
                    target_id: targetId,
                    entity_id: target.entity_id,
                    class_name: target.type,
                    appearance: target.appearance,
                    behavior: target.behavior,
                    crop_path: cropPath,
                    stable_crops: stableCrops,
                    stable_face_embeddings: stableFaceEmbeddings,
                    continuity_strength: continuityStrength,
                    last_seen_segment_id: segment.segment_id,
                    last_seen_timestamp: segment.timestamp,
                    segments_seen: (existingTarget?.segments_seen ?? 0) + 1,
                    segments_missed: 0,
                    // Multi-frame accumulator pending state — null clears, undefined preserves existing
                    pending_face_embeddings: useAccumulator ? (pendingFace ?? null) : undefined,
                    pending_body_embeddings: useAccumulator ? (pendingBody ?? null) : undefined,
                    pending_entity_id: useAccumulator ? (pendingEntityId ?? null) : undefined,
                  });
                  if (canonicalTargetId !== targetId) {
                    targetId = canonicalTargetId;
                    target.committed_wm_target_id = targetId;
                    matchedWmIds.add(targetId);
                    if (accDebug) accDebug.chosen_target_id = targetId;
                  }
                  // Entity sightings should represent the current segment only.
                  // Stable WM crops are kept in working memory for continuity/avatar
                  // selection, but must not be emitted as per-segment sightings or
                  // the UI will show the same old crop for every later segment.
                  target.crop_path = currentSegmentSightingCropPath(target, currentSegmentCropPath);
                  const canonical = safeCanonicalDid;
                  if (canonical) trackToWmTarget.set(canonical, targetId);
                  for (const bid of safeTrackIds) trackToWmTarget.set(bid, targetId);
                  if (canonical && target.reid_unsafe_reason) {
                    reidUnsafeByTrack.set(canonical, target.reid_unsafe_reason);
                    for (const bid of target.bbox_ids) reidUnsafeByTrack.set(bid, target.reid_unsafe_reason);
                  }
                  if (canonical && target.entity_id && target.entity_id_source === "current_reid" && !target.reid_unsafe_reason) {
                    recordSafeCurrentEntityTracks(registry, target);
                  }
                  if (target.entity_id) {
                    const targetIdentity = workingMemory.getTargetIdentity(segment.camera_id, targetId);
                    if (
                      targetIdentity?.name
                      && targetIdentity.evidence
                      && !targetIdentity.conflict
                      && target.entity_id_source === "current_reid"
                      && !target.reid_unsafe_reason
                      && targetIdentity.promoted_entity_id !== target.entity_id
                    ) {
                      promotedWmIdentities.push({
                        track_id: canonical ?? target.bbox_ids[0] ?? targetId,
                        target_id: targetId,
                        entity_id: target.entity_id,
                        name: targetIdentity.name,
                        evidence: targetIdentity.evidence,
                      });
                      workingMemory.markTargetIdentityPromoted(segment.camera_id, targetId, target.entity_id);
                    }
                  }
                } catch { /* non-fatal */ }
              }
            }
            if (accDebug) accumulatorDebug.push(accDebug);
          }
          if (accumulatorDebug.length > 0) {
            postprocessArchive.reid_accumulator = accumulatorDebug;
          }

          // Tick miss for unmatched WM targets. If live-latency critical commit
          // already updated target continuity, avoid aging the same segment twice.
          if (!streamedCriticalTargetsCommitted) {
            workingMemory.tickTargetMiss(segment.camera_id, matchedWmIds);
          }

          // Build entities for PerceptionResult from parsed targets.
          // Save per-entity keyframes — deduplicate by frame index.
          const subjectProposalSavedByFrame = new Map<number, string>();
          const displayByTrack = new Map<string, Pick<EntityRecord, "subject_index" | "name" | "first_seen">>();
          for (const match of reidData?.matches ?? []) {
            if (!match.track_id) continue;
            displayByTrack.set(match.track_id, {
              ...(match.subject_index != null ? { subject_index: match.subject_index } : {}),
              ...(match.name ? { name: match.name } : {}),
              ...(match.first_seen != null ? { first_seen: match.first_seen } : {}),
            });
          }
          for (const target of parsedTargets) {
            const targetIdx = parsedTargets.indexOf(target);
            const targetKey = streamingTargetKey(target, targetIdx);
            const safeTrackIds = safeTrackIdsForTarget(registry, target);
            const bestDid = safeTrackIds[0];
            const entry = bestDid ? registry.get(bestDid) : undefined;
            if (!entry) continue;
            const display = bestDid ? displayByTrack.get(bestDid) : undefined;
            if (target.identity?.name?.trim() && target.identity_write_safe !== false && !target.reid_unsafe_reason) {
              targetIdentityInputs.push({
                track_id: bestDid,
                name: target.identity.name.trim(),
                ...(target.identity.evidence?.trim() ? { evidence: target.identity.evidence.trim() } : {}),
                ...(target.identity.source ? { source: target.identity.source } : {}),
              });
            }
            if (target.speaker_ids?.length) {
              for (const speakerId of target.speaker_ids) {
                const trimmed = speakerId.trim();
                if (!trimmed) continue;
                targetSpeakerLinks.push({ speaker_id: trimmed, track_id: bestDid });
              }
            }

            // Save keyframe for this entity's best frame
            let keyframePath = subjectProposalSavedByFrame.get(entry.frame_idx);
            if (!keyframePath) {
              try {
                const buf = Buffer.from(segment.frames[entry.frame_idx]!.data, "base64");
                keyframePath = mediaUploader.saveKeyframe(segment.camera_id, segment.segment_id, entry.frame_idx, buf);
                subjectProposalSavedByFrame.set(entry.frame_idx, keyframePath);
              } catch { /* non-fatal */ }
            }

            subjects.push({
              type: normalizeEntityType(target.type),
              appearance: target.appearance,
              behavior: target.behavior,
              bbox: entry.bbox,
              face_bbox: entry.face?.bbox,
              face_quality: entry.face?.quality,
              face_yaw: entry.face?.pose?.yaw,
              face_pitch: entry.face?.pose?.pitch,
              avatar_score: selectedTargetAvatarScore(entry),
              track_id: bestDid,
              entity_id: target.entity_id,
              ...(target.subject_index != null ? { subject_index: target.subject_index } : display?.subject_index != null ? { subject_index: display.subject_index } : {}),
              ...(target.name ? { name: target.name } : display?.name ? { name: display.name } : {}),
              ...(target.first_seen != null ? { first_seen: target.first_seen } : display?.first_seen != null ? { first_seen: display.first_seen } : {}),
              ...(target.speaker_ids?.length ? { speaker_ids: [...target.speaker_ids] } : {}),
              is_new_entity: (
                faceCreatedEntityTargets.has(targetIdx)
                || bodyCreatedEntityTargets.has(targetIdx)
                || accumulatorCreatedEntityTargets.has(targetIdx)
                || streamedCriticalFaceCreatedTargetKeys.has(targetKey)
                || streamedCriticalBodyCreatedTargetKeys.has(targetKey)
                || streamedCriticalAccumulatorCreatedTargetKeys.has(targetKey)
              ) && target.entity_id != null,
              keyframe_path: keyframePath,
              crop_path: target.crop_path,
            });
          }

          // Build bbox_id → canonical track_id mapping for SP path
          // (a target with bbox_ids=[D0,D3,D5] → all three map to D0)
          for (const target of parsedTargets) {
            const safeTrackIds = safeTrackIdsForTarget(registry, target);
            const canonical = safeTrackIds[0];
            if (canonical) {
              for (const bid of safeTrackIds) {
                bboxToCanonical.set(bid, canonical);
              }
            }
          }

          // Build a VlmOutput so downstream code (event boundary, WM scene context,
          // notification resolver, etc.) works seamlessly. Subject proposal should preserve the
          // same content-description contract as the VLM-only path; target-only text is fallback.
          const targetFallbackSummary = parsedTargets.length > 0
            ? parsedTargets.map(t => `${t.type}: ${t.appearance}`).join("; ")
            : "No targets detected.";
          const subjectProposalVlmOutput: VlmOutput = {
            title: parsedSubjectProposal.title,
            summary: parsedSubjectProposal.summary ?? targetFallbackSummary,
            detailed_summary: parsedSubjectProposal.detailed_summary ?? parsedSubjectProposal.summary ?? targetFallbackSummary,
            retrieval_compact: parsedSubjectProposal.retrieval_compact,
            security_risk: parsedSubjectProposal.security_risk ?? false,
            security_reason: parsedSubjectProposal.security_reason,
            // Do not infer "static" from missing targets. A segment can have no
            // detected subjects while still carrying meaningful speech, text, or scene content.
            is_static_scene: parsedSubjectProposal.is_static_scene ?? false,
            notify_user: parsedSubjectProposal.notify_user ?? false,
            matched_rule_ids: parsedSubjectProposal.matched_rule_ids,
            main_targets: parsedTargets.map(t => ({
              type: t.type,
              appearance: t.appearance,
              behavior: t.behavior,
              ...(t.identity ? { identity: { ...t.identity } } : {}),
              ...(t.speaker_ids?.length ? { speaker_ids: [...t.speaker_ids] } : {}),
            })),
            custom_fields: parsedSubjectProposal.custom_fields,
            content_type: parsedSubjectProposal.content_type,
            key_modality: parsedSubjectProposal.key_modality,
            event_boundary: parsedSubjectProposal.event_boundary,
            event_summary: parsedSubjectProposal.event_summary,
            event_context_update: parsedSubjectProposal.event_context_update,
            segment_policy_exit_met: parsedSubjectProposal.segment_policy_exit_met,
            best_frame_index: parsedSubjectProposal.best_frame_index,
            raw_response: rawVlmJson,
          };
          analyzerResults.push({
            available: true,
            analyzer: "vlm",
            data: subjectProposalVlmOutput,
            latency_ms: vlmCompletedAt - (vlmStageStartedAt ?? analysisStartedAt),
            trace: {
              llm_call_id: segmentAnalysis.llm_call?.call_id,
              archive: segmentAnalysis.archive,
              parse_errors: parseErrors,
            },
          });
          profiler.end("vlm_stage", { now: vlmCompletedAt, latencyMs: vlmCompletedAt - (vlmStageStartedAt ?? vlmCompletedAt) });
        }
      } else {
        // subject proposal idle: tick WM targets with no matches
        workingMemory.tickTargetMiss(segment.camera_id, new Set());
      }

    } else {
      // L1 fallback: no D{id} registry input, so do not run a second target
      // grounding path. Preserve summary/audio/event-policy behavior via the
      // same VLM-only prompt used by Level 0.
      const fallbackReason = !multiFrameDetections
        ? "detection_disabled"
        : !deps.router
          ? "no_router"
          : !hasDetectionRegistryInput
            ? "no_detections"
            : "unknown";

      let sttData: SttOutput | undefined;
      let sttFailed = false;
      if (sttPromise) {
        const sttResult = await sttPromise;
        if (sttResult.available) {
          sttData = sttResult.data as SttOutput;
        } else if (sttResult.error) {
          sttFailed = true;
        }
        analyzerResults.push(sttResult);
        sttCompletedAt = Date.now();
        profiler.end("stt", { now: sttCompletedAt, latencyMs: sttResult.latency_ms });
      }

      const vlmGate = resolveVlmGate({
        eventHint: segment.event_hint,
        multiFrameDetections,
        detData,
        sttData,
        vadSpeechObserved,
        sttAvailable,
        sttFailed,
        strategyRunVlm: strategy.run_vlm,
        isColdStart,
      });
      skipVlm = vlmGate.skipVlm;
      localStaticScene = vlmGate.localStaticScene;
      const willAttemptVlm = vlmGate.willAttemptVlm;
      vlmGateDecision = vlmGate.decision;

      if (skipVlm) {
        writeStderr(`[perception] ${segment.camera_id} seg#${mySegmentCount} | L1 VLM-only fallback SKIP VLM (reason=${fallbackReason} idle=${vlmGate.decision.is_idle} persons=${vlmGate.decision.relevant_detection_count} audio=${vlmGate.decision.has_audio_content} cold=${isColdStart} segCount=${mySegmentCount})`);
      }

      if (willAttemptVlm) {
        vlmStageStartedAt = profiler.start("vlm_stage");
        installVlmOnlyStreamingCriticalCommitter();
        const vlmResult = await runVlmSegment(
          vlmAnalyzer,
          segment.frames,
          strategy.vlm_model,
          buildVlmOnlySegmentOptions({
            sttData,
            sceneContext,
            segmentPolicyExitPrompt,
            suppressSceneDescription,
            semanticContextSections,
            currentEventSummary,
            recentSegmentSummaries,
            currentEventContext,
            referenceFrameBase64,
            vlmCallOptions: buildVlmCallOptions("vlm_only"),
          }),
          deps.vlmFrameResize,
        );
        vlmAnalyzeStartedAt = typeof vlmResult.trace?.vlm_analyze_started_at === "number"
          ? vlmResult.trace.vlm_analyze_started_at as number
          : undefined;
        vlmAnalyzeCompletedAt = typeof vlmResult.trace?.vlm_analyze_completed_at === "number"
          ? vlmResult.trace.vlm_analyze_completed_at as number
          : undefined;
        if (vlmAnalyzeStartedAt !== undefined && vlmAnalyzeCompletedAt !== undefined) {
          profiler.set("vlm_analyze", {
            startedAt: vlmAnalyzeStartedAt,
            completedAt: vlmAnalyzeCompletedAt,
            latencyMs: vlmResult.latency_ms,
          });
        }
        analyzerResults.push(vlmResult);
        vlmAnalyzeLatencyMs = vlmResult.latency_ms;
        vlmArchive = vlmResult.trace?.archive as Record<string, unknown> | undefined;
        postprocessArchive = {
          mode: "vlm_only",
          origin_level: strategy.level,
          fallback_reason: fallbackReason,
        };
        vlmCompletedAt = Date.now();
        profiler.end("vlm_stage", { now: vlmCompletedAt });
        if (!vlmResult.available) vlmFailed = true;
      }

    } // end L1 subject proposal / VLM-only fallback branch
  } else {
    // Level 0: VLM + optional STT
    let sttData: SttOutput | undefined;
    if (sttPromise) {
      const sttResult = await sttPromise;
      if (sttResult.available) sttData = sttResult.data as SttOutput;
      analyzerResults.push(sttResult);
      sttCompletedAt = Date.now();
      profiler.end("stt", { now: sttCompletedAt, latencyMs: sttResult.latency_ms });
    }

    if (strategy.run_vlm) {
      vlmStageStartedAt = profiler.start("vlm_stage");
      installVlmOnlyStreamingCriticalCommitter();
      const vlmResult = await runVlmSegment(
        vlmAnalyzer,
        segment.frames,
        strategy.vlm_model,
        buildVlmOnlySegmentOptions({
          sttData,
          sceneContext,
          segmentPolicyExitPrompt,
          suppressSceneDescription,
          semanticContextSections,
          currentEventSummary,
          recentSegmentSummaries,
          currentEventContext,
          referenceFrameBase64,
          vlmCallOptions: buildVlmCallOptions("vlm_only"),
        }),
        deps.vlmFrameResize,
      );
      vlmAnalyzeStartedAt = typeof vlmResult.trace?.vlm_analyze_started_at === "number"
        ? vlmResult.trace.vlm_analyze_started_at as number
        : undefined;
      vlmAnalyzeCompletedAt = typeof vlmResult.trace?.vlm_analyze_completed_at === "number"
        ? vlmResult.trace.vlm_analyze_completed_at as number
        : undefined;
      if (vlmAnalyzeStartedAt !== undefined && vlmAnalyzeCompletedAt !== undefined) {
        profiler.set("vlm_analyze", {
          startedAt: vlmAnalyzeStartedAt,
          completedAt: vlmAnalyzeCompletedAt,
          latencyMs: vlmResult.latency_ms,
        });
      }
      analyzerResults.push(vlmResult);
      vlmAnalyzeLatencyMs = vlmResult.latency_ms;
      vlmArchive = vlmResult.trace?.archive as Record<string, unknown> | undefined;
      postprocessArchive = { mode: "vlm_only", origin_level: strategy.level };
      vlmCompletedAt = Date.now();
      profiler.end("vlm_stage", { now: vlmCompletedAt });
      if (!vlmResult.available) vlmFailed = true;
    }
  }

  const vlmResult = analyzerResults.find((r) => r.analyzer === "vlm");

  // ── Hoist VLM output to outer scope (needed by event boundary + Step 5+) ──
  const vlmOutput = vlmResult?.available ? (vlmResult.data as VlmOutput) : null;
  if (vlmOutput && runtimeMode === "live_latency" && streamedCriticalContextCommitted) {
    const conflicts = reconcileStreamingCriticalVlmOutput(vlmOutput, streamingCriticalSnapshot);
    if (conflicts.length > 0) {
      streamingCriticalConflictFields = [...new Set([...streamingCriticalConflictFields, ...conflicts])];
    }
  }

  // ── Event boundary — VLM-driven event switching ──
  // MUST happen BEFORE appendSceneContext/updateEntityContext so writes go to new event.
  let finalEventId = streamedCriticalFinalEventId ?? eventId;
  const vlmBoundaryRequested = vlmOutput?.event_boundary === true;
  if (!eventBoundaryDecision) {
    eventBoundaryDecision = {
      requested: vlmBoundaryRequested,
      applied: false,
    };
  } else if (vlmBoundaryRequested && !streamedCriticalContextCommitted) {
    eventBoundaryDecision.requested = true;
  }
  if (!streamedCriticalContextCommitted && vlmBoundaryRequested && mySegmentCount > 1) {
    const newId = workingMemory.switchEvent(segment.camera_id, segment.mode, segment.timestamp);
    monitorBus.publish("perception:event_boundary", {
      camera_id: segment.camera_id,
      old_event_id: eventId,
      new_event_id: newId,
      reason: "vlm_content_shift",
    }, segment.camera_id);
    finalEventId = newId;
    eventBoundaryDecision = {
      requested: true,
      applied: true,
      old_event_id: eventId,
      new_event_id: newId,
      reason: "vlm_content_shift",
    };
  }

  // Record segment evidence in its FINAL event (after boundary detection)
  if (!streamedCriticalContextCommitted) {
    workingMemory.recordSegment(segment.camera_id, segment.segment_id, segment.timestamp);
  }

  // ── Propagate content_type/key_modality to custom_fields for segment policy signal matching ──
  if (vlmOutput?.content_type) {
    const customFields = vlmOutput.custom_fields ?? {};
    customFields.content_type = vlmOutput.content_type;
    if (vlmOutput.key_modality) customFields.key_modality = vlmOutput.key_modality;
    vlmOutput.custom_fields = customFields;
  }

  // ── Step 4: Update Working Memory with VLM output (now writes to correct event) ──
  if (vlmOutput) {
    const sceneContextText = vlmOutput.detailed_summary || vlmOutput.summary;
    if (sceneContextText) {
      workingMemory.appendSceneContext(segment.camera_id, sceneContextText, segment.segment_id, vlmOutput.title, {
        summary: vlmOutput.summary,
        detailedSummary: vlmOutput.detailed_summary,
      });
    }
    if (vlmOutput.event_summary) {
      workingMemory.updateEventSummary(segment.camera_id, vlmOutput.event_summary, segment.timestamp);
    }
    if (vlmOutput.event_context_update) {
      workingMemory.updateEventContext(segment.camera_id, vlmOutput.event_context_update);
    }
    const reidEntityByTrack = new Map<string, string>();
    for (const m of reidData?.matches ?? []) {
      if (m.track_id && m.entity_id) reidEntityByTrack.set(m.track_id, m.entity_id);
    }
    for (const target of vlmOutput.main_targets) {
      const trackId = target.track_id;
      const entityId = trackId ? reidEntityByTrack.get(trackId) : undefined;
      const appearance = cleanEntityText(target.appearance);
      const behavior = cleanEntityText(target.behavior);
      if (!appearance && !behavior && !entityId) continue;
      if (trackId) {
        workingMemory.updateEntityContext(segment.camera_id, trackId,
          { appearance, behavior, entity_id: entityId }, Date.now(), segment.timestamp);
      }
      if (entityId) {
        workingMemory.updateEntityContext(segment.camera_id, entityId,
          { appearance, behavior, entity_id: entityId }, Date.now(), segment.timestamp);
      } else if (!trackId) {
        workingMemory.updateEntityContext(segment.camera_id, target.type,
          { appearance, behavior }, Date.now(), segment.timestamp);
      }
    }
    if (vlmOutput.security_risk && vlmOutput.security_reason) {
      workingMemory.addEscalationHint(segment.camera_id, vlmOutput.security_reason);
    }
  }

  // Set-of-Mark anonymous matching has been removed from the L1 path.
  // Keep aging any existing anonymous subjects so old state does not linger.
  if (strategy.level >= 1) {
    workingMemory.tickAnonymousMiss(segment.camera_id, new Set());
  }

  monitorBus.publish("perception:working_memory_updated", {
    camera_id: segment.camera_id,
    event_id: finalEventId,
    scene_context_length: workingMemory.getSceneContext(segment.camera_id).length,
  }, segment.camera_id);
  workingMemoryDecision.scene_context_length = workingMemory.getSceneContext(segment.camera_id).length;

  // ── Step 6: Save keyframes to local storage ──
  // Segment keyframe follows VLM best_frame_index; SP entity keyframes are saved during SP post-processing.
  const {
    segmentKeyframePaths,
    selectedSegmentKeyframeIndex,
    gifPath,
    analysisMedia,
  } = await saveSegmentMedia({
    segment,
    mediaUploader,
    bestFrameIndex: vlmOutput?.best_frame_index,
    animatedPreview: deps.animatedSegmentPreview === true,
  });

  // ── Step 8: Build PerceptionMemory ──
  // Subject proposal is the visual authority for L1 entities. Only Level 0
  // preserves VLM main_targets as text-only entities.
  const subjectDescriptions: VlmTarget[] = [...(vlmOutput?.main_targets ?? [])];

  if (strategy.level === 0 && subjects.length === 0) {
    for (const target of subjectDescriptions) {
      const appearance = cleanEntityText(target.appearance);
      const behavior = cleanEntityText(target.behavior);
      const interaction = cleanEntityText(target.interaction);
      if (!appearance && !behavior && !interaction) continue;
      if (target.track_id && target.identity?.name?.trim()) {
        targetIdentityInputs.push({
          track_id: target.track_id,
          name: target.identity.name.trim(),
          ...(target.identity.evidence?.trim() ? { evidence: target.identity.evidence.trim() } : {}),
          ...(target.identity.source ? { source: target.identity.source } : {}),
        });
      }
      if (target.track_id && target.speaker_ids?.length) {
        for (const speakerId of target.speaker_ids) {
          const trimmed = speakerId.trim();
          if (!trimmed) continue;
          targetSpeakerLinks.push({ speaker_id: trimmed, track_id: target.track_id });
        }
      }
      subjects.push({
        type: normalizeEntityType(target.type),
        appearance,
        behavior,
        interaction,
        track_id: target.track_id,
        ...(target.speaker_ids?.length ? { speaker_ids: [...target.speaker_ids] } : {}),
        keyframe_path: segmentKeyframePaths[0],
      });
    }
  }

  const segmentAnalysis: PerceptionMemory = {
    title: vlmOutput?.title,
    summary: vlmOutput?.summary ?? (vlmFailed ? "VLM call failed." : "Static scene — no activity detected."),
    detailed_summary: vlmOutput?.detailed_summary ?? "",
    retrieval_compact: vlmOutput?.retrieval_compact,
    security_risk: vlmOutput?.security_risk ?? false,
    security_reason: vlmOutput?.security_reason,
    timestamp: segment.timestamp,
    entities: subjects,
    perception_level: strategy.level,
    strategy_context: `${segment.mode}/level${strategy.level}`,
    is_static_scene: vlmOutput?.is_static_scene ?? localStaticScene,
    custom_fields: vlmOutput?.custom_fields ?? undefined,
    matched_rule_ids: vlmOutput?.matched_rule_ids,
    segment_policy_exit_met: vlmOutput?.segment_policy_exit_met,
  };

  // Monitor emission happens after Step 9c so target-level identity bindings
  // (e.g. "this person is called Lily") are included in main_targets.

  // ── Step 9: Assemble PerceptionResult ──
  const result: PerceptionResult = {
    segment_id: segment.segment_id,
    camera_id: segment.camera_id,
    mode: segment.mode,
    event_id: finalEventId,
    perception_memory: segmentAnalysis,
    media_urls: analysisMedia,
  };

  // ── Step 9b: Extract STT transcript ──
  const sttResult = analyzerResults.find((r) => r.analyzer === "stt");
  if (sttResult?.available && sttResult.data) {
    const sttOut = sttResult.data as SttOutput;
    if (sttOut.transcript) {
      result.transcript = sttOut.transcript;
    }
  }

  // ── Step 9c: Normalize target-level identity and STT dialogue ──
  const sttSegments = (sttResult?.available && sttResult.data)
    ? (sttResult.data as SttOutput).segments?.filter(s => s.text.trim()) ?? []
    : [];
  if (
    targetIdentityInputs.length
    || targetSpeakerLinks.length
    || promotedWmIdentities.length
    || sttSegments.length
    || result.transcript
  ) {
    // Build track→entity map from final subjects (includes SP-created entities).
    // Only fall back to raw ReID matches when the D{id} was already confirmed
    // through a safe subject-proposal target; otherwise VLM grouping conflicts
    // can leak unsafe current-frame identities into speaker/name binding.
    const trackToEntity = new Map<string, string>();
    const rawSafeCurrentReidByTrack = new Map<string, string>();
    for (const m of reidData?.matches ?? []) {
      if (!m.track_id || !m.entity_id) continue;
      const canonicalTrackId = bboxToCanonical.get(m.track_id) ?? m.track_id;
      if (reidUnsafeByTrack.has(m.track_id) || reidUnsafeByTrack.has(canonicalTrackId)) continue;
      if (
        confirmedEntityByTrack.get(m.track_id) === m.entity_id
        || confirmedEntityByTrack.get(canonicalTrackId) === m.entity_id
        || safeCurrentReidEntityByTrack.get(m.track_id) === m.entity_id
        || safeCurrentReidEntityByTrack.get(canonicalTrackId) === m.entity_id
      ) {
        trackToEntity.set(m.track_id, m.entity_id);
        trackToEntity.set(canonicalTrackId, m.entity_id);
      } else {
        rawSafeCurrentReidByTrack.set(m.track_id, m.entity_id);
        rawSafeCurrentReidByTrack.set(canonicalTrackId, m.entity_id);
      }
    }
    for (const s of subjects) {
      if (s.track_id && s.entity_id) trackToEntity.set(s.track_id, s.entity_id);
    }

    // Normalize SP bbox IDs to canonical target IDs
    // (VLM may reference D5 when the canonical track_id is D0 because D0+D3+D5 belong to the same target)
    const normalizeTrackId = (tid: string): string => bboxToCanonical.get(tid) ?? tid;

    // Collect valid track_ids for validation (P2: reject hallucinated IDs)
    const validTrackIds = new Set<string>();
    for (const t of vlmOutput?.main_targets ?? []) {
      if (t.track_id) validTrackIds.add(t.track_id);
    }
    for (const s of subjects) {
      if (s.track_id) validTrackIds.add(s.track_id);
    }
    const isValidTrackReference = (tid: string): boolean =>
      validTrackIds.has(tid) || validTrackIds.has(normalizeTrackId(tid));
    const resolveIdentityLevel = (trackId: string): {
      canonicalId?: string;
      entityId?: string;
      identityLevel: SpeakerIdentityLevel;
    } => {
      const normalizedTrackId = normalizeTrackId(trackId);
      if (!isValidTrackReference(trackId)) {
        return { identityLevel: "unknown" };
      }
      const directEntityId = confirmedEntityByTrack.get(trackId) ?? safeCurrentReidEntityByTrack.get(trackId);
      const entityId = directEntityId ?? (trackId === normalizedTrackId ? trackToEntity.get(normalizedTrackId) : undefined);
      return {
        canonicalId: directEntityId ? trackId : (trackId === normalizedTrackId ? normalizedTrackId : trackId),
        entityId,
        identityLevel: entityId ? "entity_id" : "event_local",
      };
    };
    const hasVisibleNameAnchor = (trackId: string): boolean => {
      const normalizedTrackId = normalizeTrackId(trackId);
      for (const did of new Set([trackId, normalizedTrackId])) {
        if (visibleNameAnchorTracks.has(did)) return true;
      }
      return false;
    };

    type ResolvedNameIdentityCandidate = {
      source: "target_identity";
      rawTrackId: string;
      canonicalTrackId: string;
      entityId?: string;
      identityLevel: SpeakerIdentityLevel;
      targetId?: string;
      name: string;
      evidence?: string;
      identitySource?: VlmTargetIdentity["source"];
      speakerId?: string;
      existingTargetName?: string;
      identityPersistence: TargetIdentityNamePersistence;
      bindingKeys: string[];
      candidateId: string;
    };
    const resolveNameIdentityCandidate = (
      source: ResolvedNameIdentityCandidate["source"],
      rawTrackId: string,
      name: string | undefined,
      evidence?: string,
      identitySource?: VlmTargetIdentity["source"],
      speakerId?: string,
      occurrence = 0,
    ): ResolvedNameIdentityCandidate | undefined => {
      if (!validTrackIds.has(normalizeTrackId(rawTrackId))) return undefined;
      if (!isLikelyPersonIdentityName(name, evidence)) return undefined;
      const resolved = resolveIdentityLevel(rawTrackId);
      if (!resolved.canonicalId) return undefined;
      const normalizedTrackId = normalizeTrackId(rawTrackId);
      const directEntityId = confirmedEntityByTrack.get(rawTrackId)
        ?? safeCurrentReidEntityByTrack.get(rawTrackId)
        ?? (rawTrackId === normalizedTrackId
          ? confirmedEntityByTrack.get(normalizedTrackId) ?? safeCurrentReidEntityByTrack.get(normalizedTrackId)
          : undefined);
      const identityPersistence = classifyTargetIdentityNamePersistence({
        source: identitySource,
        evidence,
        hasVisibleNameAnchor: hasVisibleNameAnchor(rawTrackId),
        bindsStableEntity: Boolean(directEntityId),
        hasCurrentEntityAnchor: Boolean(directEntityId),
      });
      if (identityPersistence === "reject") {
        return undefined;
      }
      const scope = resolveNameIdentityScope({
        rawTrackId,
        normalizedTrackId,
        canonicalTrackId: resolved.canonicalId,
        entityId: directEntityId,
        targetIdForTrack: (trackId) => trackToWmTarget.get(trackId),
        existingNameForTarget: (targetId) => workingMemory.getTargetIdentity(segment.camera_id, targetId)?.name,
      });
      return {
        source,
        rawTrackId,
        canonicalTrackId: scope?.canonicalTrackId ?? resolved.canonicalId,
        entityId: directEntityId,
        identityLevel: directEntityId ? "entity_id" : "event_local",
        targetId: scope?.targetId,
        name: name.trim(),
        evidence,
        identitySource,
        speakerId,
        existingTargetName: scope?.existingTargetName,
        identityPersistence,
        bindingKeys: scope?.bindingKeys ?? identityBindingKeys({ trackId: resolved.canonicalId }),
        candidateId: speakerId
          ? `${source}:${occurrence}:${speakerId}:${rawTrackId}`
          : `${source}:${occurrence}:${rawTrackId}`,
      };
    };
    const targetNameCandidates = targetIdentityInputs
      .map((identity, index) => resolveNameIdentityCandidate(
        "target_identity",
        identity.track_id,
        identity.name,
        identity.evidence,
        identity.source,
        undefined,
        index,
      ))
      .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
    const promotedNameCandidates = promotedWmIdentities
      .map((promoted, index) => {
        if (!isLikelyPersonIdentityName(promoted.name, promoted.evidence)) return undefined;
        const canonicalTrackId = normalizeTrackId(promoted.track_id);
        const targetId = trackToWmTarget.get(canonicalTrackId) ?? promoted.target_id;
        const existingTargetName = targetId
          ? workingMemory.getTargetIdentity(segment.camera_id, targetId)?.name
          : undefined;
        return {
          promoted,
          canonicalTrackId,
          targetId,
          existingTargetName,
          candidateId: `promoted_wm:${index}:${promoted.entity_id}:${canonicalTrackId}`,
          name: promoted.name.trim(),
        };
      })
      .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
    const nameIdentityDecisions = resolveNameIdentityBindings(
      [
        ...targetNameCandidates.map((candidate): NameIdentityBindingCandidate => ({
          candidate_id: candidate.candidateId,
          name: candidate.name,
          binding_keys: candidate.bindingKeys,
          existing_name: candidate.existingTargetName,
        })),
        ...promotedNameCandidates.map((candidate): NameIdentityBindingCandidate => ({
          candidate_id: candidate.candidateId,
          name: candidate.name,
          binding_keys: identityBindingKeys({
            targetId: candidate.targetId,
            entityId: candidate.promoted.entity_id,
            trackId: candidate.canonicalTrackId,
          }),
          existing_name: candidate.existingTargetName,
        })),
      ],
    );
    const isNameCandidateAllowed = (candidate: Pick<ResolvedNameIdentityCandidate, "candidateId">): boolean =>
      nameIdentityDecisions.get(candidate.candidateId)?.allowed !== false;

    // Preferred diarization path: target.speaker_ids maps STT speaker ids to
    // already-resolved visual targets. Downstream memory consumes only
    // normalized dialogue lines. The same helper is used by live-latency
    // critical partials and by this final pass.
    const dialogueResult = assembleDialogueFromSpeakerLinks({
      sttSegments,
      transcript: result.transcript,
      speakerLinks: targetSpeakerLinks,
      normalizeTrackId,
      isValidTrackReference,
      resolveIdentityLevel,
    });
    if (dialogueResult.speakerToEntity.size > 0 && sttResult?.available && sttResult.data) {
      const sttOut = sttResult.data as SttOutput;
      for (const seg of sttOut.segments) {
        if (seg.speaker && dialogueResult.speakerToEntity.has(seg.speaker)) {
          seg.entity_id = dialogueResult.speakerToEntity.get(seg.speaker);
        }
      }
    }
    if (dialogueResult.dialogue.length > 0) {
      result.dialogue = dialogueResult.dialogue;
    }

    if (result.dialogue?.length && vlmOutput) {
      const sceneContextText = vlmOutput.detailed_summary || vlmOutput.summary;
      if (sceneContextText) {
        workingMemory.appendSceneContext(segment.camera_id, sceneContextText, segment.segment_id, vlmOutput.title, {
          summary: vlmOutput.summary,
          detailedSummary: vlmOutput.detailed_summary,
          dialogue: result.dialogue,
        });
      }
    }

    const normalizedIdentities: Array<{
      track_id: string;
      entity_id?: string;
      identity_level: SpeakerIdentityLevel;
      name: string;
      evidence?: string;
    }> = [];
    const resolvedIdentityCandidates = targetNameCandidates;
    if (resolvedIdentityCandidates.length) {
      const evidenceIdentities = resolvedIdentityCandidates
        .filter((candidate) => isNameCandidateAllowed(candidate))
        .map((candidate) => {
          const { targetId } = candidate;
          const confirmedEntityId = confirmedEntityByTrack.get(candidate.canonicalTrackId);
          if (targetId) {
            if (candidate.identityPersistence === "confirmed") {
              const identityStored = workingMemory.setTargetIdentity(segment.camera_id, targetId, {
                name: candidate.name,
                evidence: candidate.evidence ?? "",
                source_segment_id: segment.segment_id,
              });
              if (identityStored && confirmedEntityId) {
                workingMemory.markTargetIdentityPromoted(segment.camera_id, targetId, confirmedEntityId);
              }
            } else {
              workingMemory.addTargetIdentityHint(segment.camera_id, targetId, {
                name: candidate.name,
                evidence: candidate.evidence ?? "",
                source_segment_id: segment.segment_id,
                ...(candidate.identitySource ? { source: candidate.identitySource } : {}),
              });
            }
          }
          if (candidate.identityPersistence !== "confirmed") return undefined;
          return {
            track_id: candidate.canonicalTrackId,
            entity_id: candidate.entityId,
            identity_level: candidate.identityLevel,
            name: candidate.name,
            evidence: candidate.evidence ?? "",
          };
        })
        .filter((identity): identity is NonNullable<typeof identity> => Boolean(identity));
      normalizedIdentities.push(...evidenceIdentities);
    }

    if (promotedWmIdentities.length) {
      const existingIdentityKeys = new Set(
        normalizedIdentities.map((id) => `${id.entity_id ?? ""}\t${id.track_id}\t${id.name.toLocaleLowerCase()}`),
      );
      for (const candidate of promotedNameCandidates) {
        if (nameIdentityDecisions.get(candidate.candidateId)?.allowed === false) continue;
        const { promoted } = candidate;
        const key = `${promoted.entity_id}\t${promoted.track_id}\t${promoted.name.toLocaleLowerCase()}`;
        if (existingIdentityKeys.has(key)) continue;
        existingIdentityKeys.add(key);
        normalizedIdentities.push({
          track_id: candidate.canonicalTrackId,
          entity_id: promoted.entity_id,
          identity_level: "entity_id",
          name: candidate.name,
          evidence: promoted.evidence,
        });
      }
    }

    const withFinalReidWriteLock = deps.memory?.withReidWriteLock ?? (<T>(fn: () => Promise<T>) => fn());
    for (const identity of normalizedIdentities) {
      const name = identity.name?.trim();
      if (!name) continue;
      const category = "person";
      const canonicalTrackId = identity.track_id ? normalizeTrackId(identity.track_id) : undefined;
      const unsafeTrack = canonicalTrackId ? reidUnsafeByTrack.has(canonicalTrackId) : false;
      const confirmedEntityId = canonicalTrackId ? confirmedEntityByTrack.get(canonicalTrackId) : undefined;
      const safeCurrentEntityId = canonicalTrackId && !unsafeTrack
        ? safeCurrentReidEntityByTrack.get(canonicalTrackId) ?? rawSafeCurrentReidByTrack.get(canonicalTrackId)
        : undefined;
      if (!unsafeTrack && identity.entity_id && (confirmedEntityId === identity.entity_id || safeCurrentEntityId === identity.entity_id)) {
        const subjectIdentity = resolveSubjectIndex({
          category,
          entity_id: identity.entity_id,
          wm_target_id: canonicalTrackId ? trackToWmTarget.get(canonicalTrackId) : undefined,
          name,
        });
        try {
          await withFinalReidWriteLock(async () => deps.memory?.reidUpdateIdentity?.(
            identity.entity_id!,
            name,
            subjectIdentity.subject_index != null ? { subject_index: subjectIdentity.subject_index } : undefined,
          ));
        } catch (err) {
          writeStderr(`[perception] ReID identity update failed for ${identity.entity_id}: ${err instanceof Error ? err.message : err}`);
        }
      } else if (identity.track_id) {
        const normalizedTrackId = normalizeTrackId(identity.track_id);
        const scope = resolveNameIdentityScope({
          rawTrackId: identity.track_id,
          normalizedTrackId,
          canonicalTrackId: normalizedTrackId,
          entityId: identity.entity_id,
          targetIdForTrack: (trackId) => trackToWmTarget.get(trackId),
        });
        if (!scope?.targetId) continue;
        resolveSubjectIndex({
          category,
          wm_target_id: scope.targetId,
          name,
        });
      }
    }

    const applyIdentityName = (identity: { track_id?: string; entity_id?: string; name?: string; evidence?: string }): void => {
      const name = identity.name?.trim();
      if (!name) return;
      const rawTrackId = identity.track_id;
      const normalizedTrackId = rawTrackId ? normalizeTrackId(rawTrackId) : undefined;
      const trackId = rawTrackId && normalizedTrackId
        ? (identity.entity_id || rawTrackId === normalizedTrackId ? normalizedTrackId : rawTrackId)
        : undefined;
      const subject = (trackId ? subjects.find((s) => s.track_id === trackId) : undefined)
        ?? (identity.entity_id ? subjects.find((s) => s.entity_id === identity.entity_id) : undefined);
      if (subject) {
        subject.name = name;
        if (identity.evidence) subject.identity_evidence = identity.evidence;
      }

      for (const target of streamedCriticalTargetsByCanonical.values()) {
        const matchesTrack = trackId && target.bbox_ids.some((bid) => normalizeTrackId(bid) === trackId);
        const matchesEntity = identity.entity_id && target.entity_id === identity.entity_id;
        if (!matchesTrack && !matchesEntity) continue;
        target.name = target.name ?? name;
      }
    };

    for (const identity of normalizedIdentities) applyIdentityName(identity);
    clearAmbiguousResolvedSubjectNames(subjects);

  }

  if (runtimeMode === "live_latency" || deps.onCriticalStateCommitted) {
    await commitCriticalState();
  }

  // Emit VLM result with enriched entities for Monitor after identity binding.
  if (vlmOutput) {
    monitorBus.publish("perception:vlm_result", {
      segment_id: segment.segment_id,
      event_id: finalEventId,
      segment_start: segment.timestamp,
      duration_sec: segment.duration_sec,
      title: vlmOutput.title,
      summary: vlmOutput.summary,
      segment_policy_prompt: segmentPolicyExitPrompt,
      security_risk: vlmOutput.security_risk,
      notify_user: vlmOutput.notify_user,
      matched_rule_ids: vlmOutput.matched_rule_ids,
      is_static_scene: vlmOutput.is_static_scene,
      transcript: result.transcript,
      dialogue: result.dialogue,
      main_targets_count: subjects.length,
      main_targets: subjects.map(e => ({
        type: e.type,
        appearance: e.appearance,
        behavior: e.behavior,
        entity_id: e.entity_id,
        subject_index: e.subject_index,
        name: e.name,
        first_seen: e.first_seen,
        identity_evidence: e.identity_evidence,
        track_id: e.track_id,
        is_new: e.is_new_entity,
        bbox: e.bbox,
        face_bbox: e.face_bbox,
        face_quality: e.face_quality,
        face_yaw: e.face_yaw,
        face_pitch: e.face_pitch,
        avatar_score: e.avatar_score,
        keyframe_path: e.keyframe_path,
        crop_path: e.crop_path,
      })),
      keyframe_path: segmentKeyframePaths[0],
      gif_path: gifPath,
    }, segment.camera_id);
  }

  if (deps.logging?.archiveSegments) {
    result._archive = buildSegmentArchive({
      segment,
      vadSpeechObserved,
      transcript: result.transcript,
      semanticContextPresent: Boolean(semanticContextSections?.profileContent),
      sceneContext,
      recentSegmentSummaries,
      currentEventSummary,
      recentNotificationCount: recentNotifs.length,
      analyzerResults,
      vlmArchive,
      postprocessArchive,
      segmentKeyframePaths,
      selectedSegmentKeyframeIndex,
      vlmBestFrameIndex: vlmOutput?.best_frame_index,
      segmentAnalysis,
      subjects,
      shouldStoreMemory: Boolean(vlmOutput && deps.memory?.storePerception),
      finalEventId,
      eventId,
      eventBoundaryDecision,
      currentEventSegmentCount: workingMemory.getState(segment.camera_id).segment_count,
      vlmEventSummary: vlmOutput?.event_summary,
      narrativeMemoryAttached: Boolean(deps.narrativeMemory),
    });
  }

  // ── Step 10: Post-process — Memory storage + code-resolved notifications ──
  const {
    memoryHistoryTiming,
    memoryHistoryBlockingMs,
    notificationSentAt,
  } = await runPipelinePostprocess({
    deps,
    workingMemory,
    runtimeState,
    segment,
    result,
    analyzerResults,
    analyzersSkipped,
    segmentKeyframePaths,
    mySegmentCount,
    myRecentNotifs,
    strategy,
    vlmOutput,
    vlmResult,
    localStaticScene,
  });

  // ── Profiling: build PipelineTrace ──
  const { trace, perceptionMs } = buildPipelineTrace({
    segment,
    analysisStartedAt,
    profiler,
    strategy,
    analyzerResults,
    analyzersSkipped,
    partialFirstMetrics,
    vlmAnalyzeCompletedAt,
    vlmCompletedAt,
    vlmAnalyzeStartedAt,
    vlmStageStartedAt,
    streamingCriticalSectionClosedAt,
    streamingCriticalSectionClosedBy,
    criticalStateCommittedAt,
    notificationSentAt,
    memoryHistoryTiming,
    memoryHistoryBlockingMs,
    detectionFilterDecision,
    reidDecision,
    workingMemoryDecision,
    vlmGateDecision,
    eventBoundaryDecision,
    runtimeMode,
    streamingCriticalFields,
    streamedCriticalContextCommitted,
    streamingCriticalFallbackReason,
    streamingCriticalLastMissingFields,
    streamedCriticalParseErrors,
    streamingCriticalConflictFields,
  });

  monitorBus.publish("system:pipeline_trace", trace as unknown as Record<string, unknown>, segment.camera_id);
  result._trace = trace;

  for (const analyzer of analyzerResults) {
    if (!analyzer.available && !analyzer.error) continue;
    const component = analyzer.analyzer === "detection" ? "detector" : analyzer.analyzer;
    runtimeHealth.observe({
      component,
      operation: "analyze",
      status: analyzer.available ? "ok" : "down",
      ...(analyzer.error ? { code: "analysis_failed" } : {}),
      latency_ms: analyzer.latency_ms,
      scope: { source_id: segment.camera_id },
    });
  }
  runtimeHealth.observe({
    component: "pipeline",
    operation: "run",
    status: "ok",
    latency_ms: perceptionMs,
    scope: { source_id: segment.camera_id },
  });

  monitorBus.publish("perception:analysis_completed", {
    segment_id: segment.segment_id,
    summary: segmentAnalysis.summary,
    security_risk: segmentAnalysis.security_risk,
    level: strategy.level,
    vlm_latency_ms: vlmResult?.latency_ms ?? 0,
    perception_latency_ms: perceptionMs,
  }, segment.camera_id);

  // Pipeline metrics for Monitor dashboard gauge
  monitorBus.publish("system:pipeline_metrics", {
    perception_latency_ms: perceptionMs,
    vlm_latency_ms: vlmResult?.latency_ms ?? 0,
  }, segment.camera_id);

  // ── Adaptive capture: suggest Eye mode/fps changes based on scene activity ──
  emitAdaptiveCaptureHint({
    deps,
    runtimeState,
    segment,
    isStaticScene: vlmOutput?.is_static_scene ?? false,
  });

  try {
    await flushSubjectIndexSession("final");
  } catch { /* final subject registry errors are reported by flushSubjectIndexSession */ }

  return result;
}
