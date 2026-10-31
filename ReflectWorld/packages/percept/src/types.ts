// packages/percept/src/types.ts
import type { PerceptionLevel, BoundingBox, PerceptionDialogueLine } from "@reflectworld/shared";
import type { FacePose } from "./analyzers/face-pose.js";

/** @deprecated Use BoundingBox from @reflectworld/shared. Kept as alias for backward compat. */
export type BBox = BoundingBox;

// ── Detection Registry ──

/** Single detection box with cross-frame continuous D{id}. */
export interface DIdEntry {
  did: string;
  frame_idx: number;
  bbox: BoundingBox;
  class_name: string;
  confidence: number;
  face?: {
    bbox: BoundingBox;
    landmarks?: Array<{ x: number; y: number }>;
    pose?: FacePose;
    sharpness?: number;
    embedding?: number[];
    entity_id?: string;
    match_score?: number;
    top_entity_id?: string;
    top_score?: number;
    miss_reason?: string;
    quality?: number;
  };
  body?: {
    embedding?: number[];
    entity_id?: string;
    match_score?: number;
    quality?: number;
    body_yaw_ratio?: number;
    visibility?: "full" | "upper" | "partial";
  };
}

// ── Subject Proposal Output ──

export interface VlmTargetIdentity {
  /** Human-readable person name mentioned or bound by current-segment evidence. */
  name: string;
  /** Evidence explaining why the name is relevant to this visible target. */
  evidence?: string;
  /** Evidence source. Resolver maps this to confirmed vs hint-only writes. */
  source?:
    | "visible_nameplate"
    | "visible_text"
    | "spoken"
    | "direct_address"
    | "self_introduction"
    | "direct_address_response"
    | "third_person_reference"
    | "dialogue_about_person"
    | "dialogue_about_visible_person"
    | "other";
}

/** Single target from subject-proposal VLM output (before parser validation). */
export interface VlmSubjectProposalTarget {
  /** Live-latency only: temporary target correlation id, used to join targets with target_details. */
  tid?: string;
  type: string;
  bbox_ids: string[];
  matched_wm_target?: string | null;
  /** Target-owned identity clue. Prefer this over legacy top-level identity arrays. */
  identity?: VlmTargetIdentity;
  /** STT diarization speaker ids that belong to this target, e.g. speaker_0. */
  speaker_ids?: string[];
  appearance?: string;
  behavior?: string;
}

/** Optional descriptive payload for a target split out of the critical target array. */
export interface VlmSubjectProposalTargetDetail {
  /** Live-latency only: match to targets[].tid. Dropped after parser reconciliation. */
  tid?: string;
  /** Match target_ref to the first bbox_id of the corresponding target. */
  target_ref?: string;
  /** Backward-compatible aliases accepted by the parser. */
  track_id?: string;
  bbox_id?: string;
  bbox_ids?: string[];
  appearance?: string;
  behavior?: string;
}

// ── Working Memory Target Continuity ──

/** Event-scoped identity clue attached to a visual working-memory target. */
export interface WorkingMemoryTargetIdentity {
  /** Person name inferred from dialogue. */
  name: string;
  /** Evidence for binding this name to the visual target. */
  evidence: string;
  /** Segment where the name was first inferred. */
  source_segment_id: string;
  /** Different names were observed for the same target; do not promote until resolved. */
  conflict?: boolean;
  /** Entity id this clue has already been promoted to, if any. */
  promoted_entity_id?: string;
}

/** Weak event-local identity clue that must not update stable entity names. */
export interface WorkingMemoryTargetIdentityHint {
  name: string;
  evidence: string;
  source_segment_id: string;
  source?: VlmTargetIdentity["source"];
}

/** Unified target context for working memory subject continuity. */
export interface WorkingMemoryTargetStableCrop {
  crop_path: string;
  segment_id: string;
  did: string;
  score: number;
  timestamp: number;
  source: "face" | "body" | "fallback";
  face_quality?: number;
  face_yaw?: number;
  face_pitch?: number;
}

export type WorkingMemoryTargetContinuityStrength = "weak_visual" | "stable_visual" | "identity";

export interface WorkingMemoryTarget {
  target_id: string;
  entity_id?: string;
  class_name: string;
  appearance: string;
  behavior?: string;
  crop_path: string;
  /** Stable history crops selected by quality; VLM continuity should use these, not the latest crop_path. */
  stable_crops?: WorkingMemoryTargetStableCrop[];
  /**
   * How much downstream code may trust this WM target as cross-segment
   * continuity. Weak visual targets can be retained in WM, but their crops
   * should not compete with identity-backed targets in VLM matching.
   */
  continuity_strength?: WorkingMemoryTargetContinuityStrength;
  last_seen_segment_id: string;
  last_seen_timestamp: number;
  segments_seen: number;
  segments_missed: number;
  /**
   * Temporary rematch budget for targets carried across a max-segment event
   * rollover. Undefined means the target belongs to the active event normally.
   */
  carry_rematch_remaining?: number;
  /** Event-local identity clue, used before this target gets a stable entity_id. */
  identity?: WorkingMemoryTargetIdentity;
  /** Weak dialogue-derived identity clues retained for audit/context only. */
  identity_hints?: WorkingMemoryTargetIdentityHint[];
  /** Accumulated face embeddings pending multi-frame ReID entity creation. */
  pending_face_embeddings?: PendingEmbedding[];
  /** Confirmed face anchors for an entity-backed WM target, used to validate later WM inheritance. */
  stable_face_embeddings?: PendingEmbedding[];
  /** Accumulated body embeddings pending multi-frame ReID entity creation. */
  pending_body_embeddings?: PendingEmbedding[];
  /** Tentative entity_id assigned during accumulation, not yet committed to gallery. */
  pending_entity_id?: string;
}

/** Embedding cached in WM target pending pool for multi-frame accumulation. */
export interface PendingEmbedding {
  embedding: number[];
  quality: number;
  segment_id: string;
  did: string;
  // face-specific
  yaw?: number;
  pitch?: number;
  // body-specific
  body_yaw_ratio?: number;
  visibility?: "full" | "upper" | "partial";
}

/** Input type for upsertTarget. null = clear field, undefined = preserve existing, array = replace. */
export type WorkingMemoryTargetUpsert = Omit<WorkingMemoryTarget, "stable_crops" | "identity_hints" | "pending_face_embeddings" | "stable_face_embeddings" | "pending_body_embeddings" | "pending_entity_id"> & {
  stable_crops?: WorkingMemoryTargetStableCrop[] | null;
  pending_face_embeddings?: PendingEmbedding[] | null;
  stable_face_embeddings?: PendingEmbedding[] | null;
  pending_body_embeddings?: PendingEmbedding[] | null;
  pending_entity_id?: string | null;
};

// ── Working Memory Entity Context ──

/** Per-entity context tracked across segments within an event. */
export interface EntityContext {
  /** Textual appearance description from VLM (e.g. "person in blue jacket"). */
  appearance: string;
  /** Behavioural description accumulated across segments. */
  behavior: string;
  /** Unix timestamp in ms when this entity was last observed. */
  last_seen: number;
  /** Stable entity_id from ReID (if matched). */
  entity_id?: string;
  /** Segment timestamp that last updated this context. Prevents late older writes. */
  segment_timestamp?: number;
}

/** Cross-segment context for a non-face target matched by VLM visual comparison. */
export interface AnonymousSubjectContext {
  /** Stable ID across segments, e.g. "anon_<hash>". */
  anonymous_subject_id: string;
  /** Detection class (person, car, dog). */
  class_name: string;
  /** VLM-generated appearance description. */
  appearance: string;
  /** Disk path to thumbnail JPEG (short edge ~128px). */
  crop_path: string;
  /** Segment ID where this subject was last seen. */
  last_seen_segment_id: string;
  /** Unix timestamp (ms) when last seen. */
  last_seen_timestamp: number;
  /** VLM confidence on most recent match (undefined for newly created). */
  last_match_confidence?: number;
  /** Total segments this subject appeared in. */
  segments_seen: number;
  /** Consecutive segments without a match. */
  segments_missed: number;
}

/** Per-camera in-memory state managed by WorkingMemoryManager. */
export interface WorkingMemoryState {
  /** Camera identifier. */
  camera_id: string;
  /** Active event group identifier, null when no event is open. */
  current_event_id: string | null;
  /** Unix timestamp in ms when the current event started. */
  event_start_time: number;
  /** Number of segments processed within the current event. */
  segment_count: number;
  /** Unix timestamp in ms of the most recent segment. */
  last_activity_time: number;
  /** Per-entity context map keyed by stable id (entity_id or track_id). */
  entity_context: Map<string, EntityContext>;
  /** Accumulated scene description from prior VLM analyses in this event. */
  scene_context: string;
  /** VLM-maintained rolling summary for the current event, max 100 words. */
  event_summary: string;
  /** Segment timestamp that last updated event_summary. */
  event_summary_segment_timestamp?: number;
  /** Most recent segment summaries for the current event, newest last. */
  recent_segment_summaries: string[];
  /** Segment IDs already present in recent_segment_summaries. */
  recent_segment_summary_ids: string[];
  /** Structured recent segment context; rendered to recent_segment_summaries for prompt compatibility. */
  recent_segment_contexts?: Array<{
    segment_id: string;
    title?: string;
    summary?: string;
    detailed_summary?: string;
    dialogue?: PerceptionDialogueLine[];
  }>;
  /** Lightweight event-level context maintained inside the active event. */
  event_state?: WorkingMemoryEventState;
  /** Signals from analyzers that suggest escalation (e.g. "unknown person detected"). */
  escalation_hints: string[];
  /** Descriptions of recently sent notifications (for VLM dedup context). */
  recent_notifications: string[];
  /** Unix timestamp (ms) of the last summary notification sent. */
  last_summary_timestamp?: number;
  /** Active anonymous (non-face) subjects for VLM cross-segment matching. */
  anonymous_subjects: AnonymousSubjectContext[];
  /** Segment IDs recorded in this event (populated by recordSegment, after boundary detection). */
  segment_ids: string[];
  /** Evidence time range start (ms), set by recordSegment. Separate from event_start_time (lifecycle).
   *  undefined = no segments recorded yet. Do NOT use 0 as sentinel — video PTS can be 0. */
  evidence_start_ms: number | undefined;
  /** Evidence time range end (ms), set by recordSegment. */
  evidence_end_ms: number | undefined;
  /** Subject targets tracked in working memory. */
  targets: WorkingMemoryTarget[];
  /** Monotonic counter for allocating stable target IDs within an event. */
  target_counter: number;
}

export interface WorkingMemoryEventState {
  setting?: string;
  participants: Array<{
    role?: string;
    visual_hints?: string;
  }>;
}

export interface VlmEventContextUpdate {
  setting?: string;
  participant_updates?: Array<{
    role?: string;
    visual_hints?: string;
  }>;
}

// ── Strategy ──

/** Analyzer combination chosen by StrategyManager for a given segment. */
export interface StrategyConfig {
  /**
   * Perception level to target.
   * 0: VLM only (no local models needed)
   * 1: VLM + frame detections + face detection + ReID
   * 2: Reserved for future local-model tiers; not selected today
   */
  level: PerceptionLevel;
  /** Run the VLM cloud analyzer. Always true for level 0-1. */
  run_vlm: boolean;
  /** Run the detection stub (or real detector when available). */
  run_detection: boolean;
  /** Run the ReID stub (or real ReID when available). */
  run_reid: boolean;
  /** Run STT on audio segments (when available + model loaded). */
  run_stt: boolean;
  /** Gemini model identifier to use for VLM analysis. */
  vlm_model: string;
}

// ── Detection / ReID Types ──

/** Single face detection with optional landmarks. */
export interface FaceDetection {
  bbox: BoundingBox;
  confidence: number;
  landmarks?: Array<{ x: number; y: number }>; // 5-point landmarks
}

// ── Analyzers ──

/** Structured output from the VLM analyzer. */
export interface VlmOutput {
  /** Very short card title, 2-3 words. */
  title?: string;
  /** One-sentence event-based summary (max 15 words). */
  summary: string;
  /** Natural-language segment description for memory and continuity context (max 60 words). */
  detailed_summary: string;
  /** Short retrieval-oriented anchors appended to detailed_summary for text embedding. */
  retrieval_compact?: string[];
  /** Whether the VLM identified a security risk. */
  security_risk: boolean;
  /** Explanation of the security risk (max 20 words), if any. */
  security_reason?: string;
  /** Whether the scene is effectively static (no meaningful movement). */
  is_static_scene: boolean;
  /** Whether the VLM considers this event noteworthy enough to notify the user. */
  notify_user: boolean;
  /** 0-based index of the most representative frame (as selected by VLM). */
  best_frame_index?: number;
  /** Salient subjects with appearance descriptions. */
  main_targets: Array<{
    /** Entity class: person, vehicle, animal, or object. */
    type: string;
    /** Objective visual description (clothing, color, size, distinguishing features). */
    appearance: string;
    /** Actions, movements, or "static" if not moving. */
    behavior?: string;
    /** Interactions with other entities or objects. */
    interaction?: string;
    /** Subject label from detection (cluster_id for face path, kf{idx}_{class}{seq} for Path B). */
    track_id?: string;
    /** Matched anonymous subject ID for non-face targets (null = new target). */
    matched_anonymous_subject_id?: string | null;
    /** VLM confidence in the anonymous match (required when matched_anonymous_subject_id is non-null). */
    match_confidence?: number;
    /** Target-owned identity clue. Preferred over legacy top-level identity arrays. */
    identity?: VlmTargetIdentity;
    /** STT diarization speaker ids that belong to this target. */
    speaker_ids?: string[];
  }>;
  /** Agent-defined extra fields for VisionController semantic triggers. */
  custom_fields?: Record<string, string | number | boolean>;
  /** Stable user procedural rule ids explicitly matched by the VLM. */
  matched_rule_ids?: string[];
  /** VLM judgment: whether the segment policy exit condition is met. */
  segment_policy_exit_met?: boolean;
  /** VLM-inferred content type of the video. */
  content_type?: "surveillance" | "lecture" | "conversation" | "activity" | "sports" | "other";
  /** Which modality carries the primary information. */
  key_modality?: "visual" | "audio" | "both";
  /** VLM judgment: content has significantly shifted from prior context. */
  event_boundary?: boolean;
  /** VLM-maintained rolling event summary, max 100 words. */
  event_summary?: string;
  /** Lightweight event-state update for future segment grounding. */
  event_context_update?: VlmEventContextUpdate;
  /** Raw VLM JSON response before parsing. */
  raw_response: string;
}

/** Generic result wrapper returned by every analyzer. */
export interface AnalyzerResult {
  /** Whether this analyzer ran and produced data (false for stubs). */
  available: boolean;
  /** Analyzer name for logging. */
  analyzer: "vlm" | "detection" | "reid" | "stt";
  /** Analyzer output data (undefined when available=false). */
  data?: VlmOutput | DetectionOutput | ReIdOutput | SttOutput;
  /** Human-readable error or unavailability message. */
  error?: string;
  /** Wall-clock time in ms taken by this analyzer. */
  latency_ms: number;
  /** Structured analyzer diagnostics for trace/debug, not model output. */
  trace?: Record<string, unknown>;
}

/** Detection output shape. */
export interface DetectionOutput {
  detections: Array<{
    label: string;
    confidence: number;
    bbox: BoundingBox;
    /** Best associated face for this person detection, if any. */
    face?: FaceDetection;
  }>;
}

/** ReID output shape. */
export interface ReIdOutput {
  matches: Array<{
    /** Temporary subject label this match belongs to when a caller can provide one. */
    track_id?: string;
    /** Stable entity ID from ReflectWorld when ReID matched or created one. */
    entity_id?: string;
    subject_index?: number | null;
    name?: string | null;
    first_seen?: string | number | null;
    confidence: number;
    /** Whether this is a newly created entity (first time seen). */
    is_new?: boolean;
    /** Semantic history from ReflectWorld for the matched entity. */
    history_behavior?: string;
  }>;
}

/** STT analyzer output shape. */
export interface SttOutput {
  /** Full transcript from all speech segments. */
  transcript: string;
  /** Per-segment transcripts with timing and optional speaker identity. */
  segments: Array<{
    /** Start sample index (divide by 16000 for seconds). */
    start: number;
    /** End sample index (divide by 16000 for seconds). Optional — absent if VAD doesn't provide it. */
    end?: number;
    /** Transcribed text. */
    text: string;
    /** Speaker/entity ID from speaker diarization. Absent if no diarization model. */
    entity_id?: string;
    /** Speaker label (e.g. "speaker_0") from diarization. Absent if no diarization model. */
    speaker?: string;
    /** STT inference latency for this segment. */
    latency_ms: number;
  }>;
}

// ── Narrative Memory Types ──

/** Summary of a closed event, passed to NarrativeMemory via onEventClosed callback. */
export interface EventCloseSummary {
  event_id: string;
  /** Final event summary produced by the VLM, max 100 words. */
  event_summary?: string;
  /** @deprecated Compatibility field; mirrors event_summary when available. */
  compressed_context: string;
  entities: Array<{ key: string; context: EntityContext }>;
  segment_count: number;
  segment_ids: string[];
  time_range: { start_ms: number; end_ms: number };
}

/** Callbacks from WorkingMemory to NarrativeMemory. */
export interface NarrativeCallbacks {
  onContextCompressed?: (cameraId: string, compressed: string, entitySnapshot: Array<{ key: string; context: EntityContext }>) => void;
  onEventClosed?: (cameraId: string, summary: EventCloseSummary) => void;
}
