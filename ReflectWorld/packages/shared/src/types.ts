import type { SegmentArchive } from "./logging/index.js";

// ── PerceptionMemory: unified memory format for perception results ──

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EntityRecord {
  type: string; // "person" / "vehicle" / "animal" / "object"
  bbox?: BoundingBox;
  /** Face bounding box (for person entities with face detection). */
  face_bbox?: BoundingBox;
  /** Quality score for the selected face crop, when available. */
  face_quality?: number;
  /** Pose yaw for the selected face crop, degrees, when available. */
  face_yaw?: number;
  /** Pose pitch for the selected face crop, degrees, when available. */
  face_pitch?: number;
  /** Stable display score for choosing an entity avatar in the dashboard. */
  avatar_score?: number;
  appearance?: string;
  behavior?: string;
  interaction?: string;
  /** Tracking ID from the local tracker (e.g. "track_1"). */
  track_id?: string;
  /** ReID entity ID from Cortex (cross-segment face identity). */
  entity_id?: string;
  /** Stable per-user subject number, used by backend projection for fallback labels. */
  subject_index?: number;
  /** First-seen timestamp for the ReID entity. */
  first_seen?: string | number;
  /** Human-readable identity inferred from target-level spoken or visible evidence. */
  name?: string;
  /** Evidence for the inferred human-readable identity. */
  identity_evidence?: string;
  /** STT diarization speaker ids mapped to this visual entity within the segment. */
  speaker_ids?: string[];
  /** Anonymous subject ID for non-face targets (cross-segment VLM matching). */
  anonymous_subject_id?: string;
  /** Whether this entity was first seen in this segment. */
  is_new_entity?: boolean;
  /** Historical behavior from Cortex (injected from prior observations). */
  history_behavior?: string;
  /** Per-entity keyframe image path (may differ from segment keyframe). */
  keyframe_path?: string;
  /** Per-entity target crop image path; preferred for target/sighting thumbnails. */
  crop_path?: string;
}

export type PerceptionLevel = 0 | 1 | 2;

export interface PerceptionMemory {
  /** Very short human-readable segment title, 2-3 words. */
  title?: string;
  summary: string;
  /** Multi-sentence description for episodic memory storage. */
  detailed_summary: string;
  /** Short retrieval-oriented anchors appended to detailed_summary for text embedding. */
  retrieval_compact?: string[];
  /** Whether the VLM identified a security risk. */
  security_risk: boolean;
  /** Explanation of the security risk, if any. */
  security_reason?: string;
  timestamp: number;
  entities?: EntityRecord[];
  perception_level: PerceptionLevel;
  strategy_context?: string;
  is_static_scene?: boolean;
  custom_fields?: Record<string, string | number | boolean>;
  /** User procedural rule ids that the VLM explicitly matched for this segment. */
  matched_rule_ids?: string[];
  /** VLM judgment: whether the segment policy exit condition is met. */
  segment_policy_exit_met?: boolean;
}

// ── Cortex API types ──

export interface MemoryItem {
  id: string;
  memory: string;
  hash?: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface MemorySearchResult {
  id: string;
  memory: string;
  score: number;
  metadata?: Record<string, unknown>;
}

// ── Speech segment from VAD ──

/** A speech segment detected by Voice Activity Detection. */
export interface SpeechSegment {
  /** Start sample index in the original audio stream. */
  start: number;
  /** PCM Float32 audio samples (16kHz mono). */
  samples: Float32Array;
}

/** Time range where voice was detected, relative to segment audio start. */
export interface VoiceRange {
  /** Start offset in ms from segment audio start. */
  start_ms: number;
  /** End offset in ms from segment audio start. */
  end_ms: number;
}

/** Continuous audio data with voice activity annotations. */
export interface AudioData {
  /** Raw PCM s16le 16kHz mono buffer covering the entire segment duration. */
  pcm: Buffer;
  /** Merged voice ranges (gap < 500ms merged into one). Segment-local ms. */
  voice_ranges: VoiceRange[];
}

// ── Dataflow types: Eye → Perception ──

/** Frame-level detection result from FrameAnalyzer. Canonical definition — re-exported by @cortex/cam. */
export interface FrameDetection {
  label: string;
  confidence: number;
  bbox: { x1: number; y1: number; x2: number; y2: number };
}

/** A single video frame extracted from a Segment. */
export interface Frame {
  /** Base64-encoded JPEG image data. */
  data: string;
  /** Canonical frame time in milliseconds. Live streams use wall-clock; file runners use media PTS. */
  timestamp: number;
  /** Zero-based index within the parent Segment. */
  index: number;
  /** Frame width in pixels, when known. */
  width?: number;
  /** Frame height in pixels, when known. */
  height?: number;
  /** Frame-level general detection results (carried from FrameResult). */
  detections?: FrameDetection[];
}

/** Unified segment produced by Eye across all capture modes. */
export interface Segment {
  /** Globally unique segment identifier. */
  segment_id: string;
  /** Camera identifier this segment originated from. */
  camera_id: string;
  /** Capture mode that produced this segment. */
  mode: "snapshot" | "event" | "stream";
  /** Ordered array of frames (1 frame for snapshot, multiple for event/stream). */
  frames: Frame[];
  /** Local file path of the raw video/image saved by Eye. */
  raw_url: string;
  /** Unix timestamp in milliseconds of the first frame. */
  timestamp: number;
  /** Duration in seconds; 0 for single-frame snapshot segments. */
  duration_sec: number;
  /** Human-readable hint about what triggered this segment (event mode). */
  event_hint?: string;
  /** @deprecated Use audio_data instead. Fragmented speech segments from VAD. */
  audio_segments?: SpeechSegment[];
  /** Continuous audio with voice range annotations. Replaces audio_segments. */
  audio_data?: AudioData;
  /** Timing metadata attached by Eye pipeline for profiling. */
  _trace?: SegmentTrace;
  _motion_hint?: MotionHint;
  /** Internal capture input mode used by runtime dispatch; not user-facing. */
  _input_mode?: "local_file" | "live_stream";
}

// ── Dataflow types: Perception → Cortex / Act ──

/** Media file paths produced by the pipeline for a segment. */
export interface MediaUrls {
  /** Raw video/image file path (saved by Eye). */
  raw: string;
  /** Animated GIF file path (saved by Perception). */
  gif?: string;
  /** Key frame image file paths (saved by Perception). */
  keyframes: string[];
  /** Entity crop image file paths (saved by Perception). */
  crops: string[];
}

export type SpeakerIdentityLevel = "entity_id" | "event_local" | "unknown";

/** Normalized dialogue line produced by Perception after STT + visual grounding. */
export interface PerceptionDialogueLine {
  /** Transcript line start time in seconds. */
  text_start: number;
  /** Human-readable speaker label after entity/target resolution. */
  speaker?: string;
  /** Canonical target id when the speaker is grounded to a visible target. */
  track_id?: string;
  /** Stable entity id when the speaker is grounded to a known entity. */
  entity_id?: string;
  /** Strength of the resolved visual identity. */
  identity_level: SpeakerIdentityLevel;
  /** Grounding confidence. */
  confidence: "high" | "low";
  /** The dialogue text spoken. */
  text?: string;
}

/**
 * Full analysis result produced by the Perception pipeline for one Segment.
 * Sent to both Cortex (for memory storage) and Act (for rule matching).
 */
export interface PerceptionResult {
  /** Source segment identifier. */
  segment_id: string;
  /** Camera identifier. */
  camera_id: string;
  /** Capture mode of the source segment. */
  mode: "snapshot" | "event" | "stream";
  /**
   * Event group identifier assigned by Working Memory.
   * Multiple segments from the same motion event share the same event_id.
   */
  event_id: string;
  /** Structured perception output (VLM summary + optional detection/tracking/identity). */
  perception_memory: PerceptionMemory;
  /** Local file paths for all media artefacts associated with this result. */
  media_urls: MediaUrls;
  /** Transcript from speech-to-text processing of audio segments. */
  transcript?: string;
  /** Unified structured dialogue lines. Names are attached through entities/targets, not separate identity arrays. */
  dialogue?: PerceptionDialogueLine[];
  /** Full pipeline profiling trace (attached when profiling is enabled). */
  _trace?: PipelineTrace;
  /** Optional debug/archive payload written by benchmark/video runners. */
  _archive?: SegmentArchive;
}

/**
 * Event payload sent from Perception to Act via webhook.
 * Extends PerceptionResult with a human-readable subject line.
 */
export interface PerceptionEvent {
  /** Source segment identifier. */
  segment_id: string;
  /** Camera identifier for routing and rule matching. */
  camera_id: string;
  /** Capture mode. */
  mode: "snapshot" | "event" | "stream";
  /** Event group identifier from Working Memory. */
  event_id: string;
  /** Structured perception output. */
  memory: PerceptionMemory;
  /** Local media file paths. */
  media_urls: MediaUrls;
}

// ── Pipeline Profiling ──

/** Timing metadata attached by Eye pipeline for profiling. */
export interface SegmentTrace {
  first_frame_at: number;
  segment_built_at: number;
}

export interface MotionHint {
  has_motion: boolean;
  ratio: number;
  last_motion_at: number;
  last_still_at: number;
}

/** Full pipeline trace from first frame to analysis completion. */
export interface PipelineTrace {
  segment_id: string;
  camera_id: string;
  timestamps: {
    first_frame_at: number;
    segment_built_at: number;
    analysis_started_at: number;
    stt_started_at?: number;
    stt_completed_at?: number;
    detection_started_at?: number;
    detection_completed_at?: number;
    tracking_completed_at?: number;
    reid_started_at?: number;
    reid_completed_at?: number;
    /** VLM module preparation started; includes frame resize / prompt option assembly. */
    vlm_stage_started_at?: number;
    /** VLM analyzer call started. */
    vlm_analyze_started_at?: number;
    /** VLM analyzer call returned; parse inside analyzer is included. */
    vlm_analyze_completed_at?: number;
    vlm_completed_at?: number;
    summary_partial_first_at?: number;
    /** First streamed target array arrival, used to evaluate source-local early-release feasibility. */
    targets_partial_first_at?: number;
    /** First streamed event_boundary arrival, used to evaluate source-local early-release feasibility. */
    event_boundary_partial_first_at?: number;
    /** Segment-local critical state is committed and the next same-source segment may start in live_latency mode. */
    critical_state_committed_at?: number;
    analysis_completed_at: number;
    /** Long-term memory history write completion time. May arrive after analysis_completed_at in observer mode. */
    memory_stored_at?: number;
    notification_sent_at?: number;
  };
  latencies: {
    accumulation_ms: number;
    dispatch_ms: number;
    stt_ms?: number;
    detection_ms?: number;
    tracking_ms?: number;
    reid_ms?: number;
    /** End-to-end VLM stage latency kept for backward compatibility. May include STT wait and prompt prep in some paths. */
    vlm_ms?: number;
    /** VLM preparation time before analyzeSegment(), e.g. frame resize/prompt option assembly. */
    vlm_prep_ms?: number;
    /** VLM analyzer call time. Includes provider call plus analyzer-side prompt/parse work. */
    vlm_analyze_ms?: number;
    /** VLM pipeline finalization after analyzeSegment() returned. */
    vlm_finalize_ms?: number;
    vlm_ttft_ms?: number;
    vlm_first_content_ms?: number;
    /** Time from VLM analyze start to first complete streamed summary. */
    summary_refresh_ms?: number;
    /** Time from VLM analyze start to first complete streamed target array. */
    targets_arrived_ms?: number;
    /** Time from VLM analyze start to first complete streamed event_boundary. */
    event_boundary_arrived_ms?: number;
    /** Time from VLM analyze start until all observed critical streaming fields have arrived. */
    critical_fields_arrived_ms?: number;
    /** Difference between full VLM completion and critical_fields_arrived_ms. */
    critical_to_full_vlm_gap_ms?: number;
    /** Time from analysis start until critical state was committed. */
    critical_state_committed_ms?: number;
    perception_ms: number;
    /** Time the main analysis path spent awaiting long-term memory history writes. Usually 0 in observer mode. */
    memory_blocking_ms?: number;
    /** Total long-term memory history write latency from enqueue to completion. */
    memory_ms?: number;
    e2e_ms: number;
  };
  context: {
    mode: "snapshot" | "event" | "stream";
    level: number;
    frame_count: number;
    vlm_model?: string;
    analyzers_run: string[];
    /** Analyzers that were eligible but intentionally skipped for cost optimization. */
    analyzers_skipped?: string[];
    /** Structured rule decisions captured for debugging and regression checks. */
    decision_context?: {
      detection_filter?: {
        external_detection_count: number;
        person_area_ratio_threshold?: number;
        person_area_filtered_count?: number;
        trackable_detection_count?: number;
        non_trackable_filtered_count?: number;
        retinaface_frames?: number;
        retinaface_skipped_reason?: string;
      };
      vlm_gate?: {
        idle_hint?: string;
        is_idle: boolean;
        vad_speech_observed?: boolean;
        stt_available?: boolean;
        stt_transcript_length?: number;
        strategy_run_vlm?: boolean;
        attempted?: boolean;
        has_audio_content: boolean;
        relevant_detection_count: number;
        cold_start: boolean;
        cold_start_override: boolean;
        skipped: boolean;
        reason: string;
      };
      reid?: {
        pre_match_merge_threshold?: number;
        pre_match_input_tracks?: number;
        pre_match_output_tracks?: number;
        pre_match_merged_groups?: number;
        pre_match_groups?: Array<{
          representative_track_id: string;
          track_ids: string[];
        }>;
        no_embedding_tracks?: number;
        matches?: number;
      };
      working_memory?: {
        cache_hit_tracks?: number;
        scene_context_length: number;
      };
      event_boundary?: {
        requested: boolean;
        applied: boolean;
        old_event_id?: string;
        new_event_id?: string;
        reason?: string;
      };
      streaming_critical?: {
        fields_seen: string[];
        section_closed_by?: string;
        committed: boolean;
        fallback_reason?: string;
        last_missing_fields?: string[];
        parse_error_count?: number;
        conflict_count?: number;
        conflict_fields?: string[];
      };
      memory_profile?: {
        queue_wait_ms?: number;
        queue_depth_at_enqueue?: number;
        retry_count?: number;
        add_http_ms?: number;
        service_profile?: {
          name?: string;
          total_ms?: number;
          stages?: Record<string, {
            count?: number;
            total_ms?: number;
            max_ms?: number;
            avg_ms?: number;
          }>;
          counters?: Record<string, number>;
          metadata?: Record<string, unknown>;
        };
      };
    };
  };
}
