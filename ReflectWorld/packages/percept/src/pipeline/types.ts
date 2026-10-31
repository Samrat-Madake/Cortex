import type { LlmCallContext, PerceptionResult, Segment } from "@reflectworld/shared";
import type { ElevenLabsStt } from "../analyzers/elevenlabs-stt.js";
import type { SttAnalyzer } from "../analyzers/stt-analyzer.js";
import type { MemoryReIdPort } from "../analyzers/unified-reid-matcher.js";
import type { VlmAnalyzer } from "../analyzers/vlm-analyzer.js";
import type { PerceptionConfig } from "../config.js";
import type { MediaUploader } from "../media-uploader.js";
import type { ModelManager } from "../models/model-manager.js";
import type { NarrativeMemory } from "../narrative-memory.js";
import type { Notification, NotifyPolicy } from "../notification-resolver.js";
import type { ModelRouter } from "../providers/model-router.js";
import type { StrategyManager } from "../strategy-manager.js";
import type { SttOutput } from "../types.js";
import type { WorkingMemoryManager } from "../working-memory.js";

export interface VlmFrameResizeOptions {
  enabled?: boolean;
  shortEdge?: number;
  jpegQuality?: number;
}

/** VLM analysis metadata for logging/storage (not part of PerceptionResult). */
export interface VlmMeta {
  notify_user: boolean;
  is_static_scene: boolean;
  best_frame_index?: number;
  vlm_model: string;
  vlm_latency_ms: number;
}

export interface PostProcessor {
  /** Send notifications resolved from Perception output. keyframePath is the best frame image. */
  sendNotifications(notifications: Notification[], cameraId: string, keyframePath?: string): Promise<void>;
  /** Returns the notification policy for a camera. Default: "smart". */
  getNotifyPolicy?(cameraId: string): NotifyPolicy;
  /** Called when a non-fatal pipeline error occurs (e.g. memory write or notification failure). */
  onPipelineError?(segmentId: string, cameraId: string, stage: string, message: string): void;
  /** Called after pipeline completes with full context for logging. */
  onPipelineComplete?(result: PerceptionResult, segment: Segment, meta: {
    vlm: VlmMeta | null;
    notifications: Notification[];
    policy: NotifyPolicy;
  }): void;
  /**
   * Adaptive capture callback — pipeline suggests Eye adjust capture params
   * based on scene analysis (e.g. switch to event mode after prolonged static scene).
   */
  onCaptureHint?(cameraId: string, hint: CaptureHint): void;
}

export interface PipelineLoggingConfig {
  /** Attach _archive to PerceptionResult. Intended for benchmark/video-runner debug artifacts. */
  archiveSegments?: boolean;
  /** Prompt version identifier recorded with LLM calls. Benchmark uses git commit id. */
  promptVersion?: string;
  /** Static LLM context; analyze() adds camera_id and segment_id per call. */
  llmContext?: LlmCallContext;
}

/** Memory-service operations needed by the perception pipeline. */
export interface PipelineMemory {
  /** Search identity vectors before VLM so tracks can carry entity context. */
  reidSearch?: MemoryReIdPort["reidSearch"];
  /** Store identity vectors before VLM when no existing ReID match is found. */
  reidUpsert?: MemoryReIdPort["reidUpsert"];
  /** Diversity-aware gallery update for previously matched entities. */
  reidGalleryUpdate?: MemoryReIdPort["reidGalleryUpdate"];
  /** Update stable ReID identity metadata such as resolved real-world name. */
  reidUpdateIdentity?: MemoryReIdPort["reidUpdateIdentity"];
  /** Serialize ReID check/write transactions for one identity scope, typically per user. */
  withReidWriteLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Generate a new entity_id for batch-init. */
  reserveEntityId?: () => string;
  /** Multi-slot gallery initialization for new entities. */
  reidBatchInit?: (request: {
    entity_id: string;
    face_vectors?: Array<{ vector: number[]; quality: number; yaw?: number; pitch?: number }>;
    body_vectors?: Array<{ vector: number[]; quality: number; body_yaw_ratio?: number; visibility?: string }>;
    category?: string;
    subject_index?: number;
    name?: string;
    first_seen?: string | number;
  }) => Promise<{
    entity_id: string;
    face_slots_written: number;
    body_slots_written: number;
    event: string;
    subject_index?: number | null;
    name?: string | null;
    first_seen?: string | number | null;
  }>;
  /** Store VLM perception output after a segment is understood. */
  storePerception?: (result: PerceptionResult, segment: Segment) => Promise<void>;
  /** Fetches user-defined rules from Memory procedural collection (global + per-camera). */
  fetchUserRules?: (cameraId: string) => Promise<string | undefined>;
}

/** Hint from Perception to Eye for adaptive capture control. */
export interface CaptureHint {
  /** Suggested action: lower fps, switch mode, or restore defaults. */
  action: "lower_fps" | "switch_to_event" | "restore" | "boost_fps";
  /** Reason for the hint. */
  reason: string;
  /** Suggested fps value (for lower_fps/boost_fps). */
  suggestedFps?: number;
}

/** Mutable per-camera runtime state owned by the pipeline, not shared globals. */
export interface PipelineRuntimeState {
  /** Consecutive static scene counters per camera. */
  staticSceneCounters: Map<string, number>;
  /** Cameras that have processed at least one segment since watch started. */
  firstWatchDone: Set<string>;
}

export type PipelineSelfCheckStatus = "ok" | "warn" | "disabled" | "error";

export interface PipelineSelfCheckComponent {
  name: string;
  status: PipelineSelfCheckStatus;
  detail: string;
  /** Required components with status=error abort startup when throwOnFatal is enabled. */
  required?: boolean;
}

export interface PipelineSelfCheckSnapshot {
  config: PerceptionConfig;
  createdAt: string;
}

export interface PipelineSelfCheckOptions {
  mode?: string;
  label?: string;
  components?: PipelineSelfCheckComponent[];
  throwOnFatal?: boolean;
  logger?: (message: string) => void;
}

/** Dependencies injected into the Perception pipeline. */
export interface PipelineDeps {
  workingMemory: WorkingMemoryManager;
  strategyManager: StrategyManager;
  vlmAnalyzer: VlmAnalyzer;
  mediaUploader: MediaUploader;
  /** Model router for provider resolution (undefined = stubs only). */
  router?: ModelRouter;
  /** Model manager for local inference providers. */
  modelManager?: ModelManager;
  /** Explicit opt-in for experimental body ReID. Default false preserves the original pipeline. */
  bodyReIdEnabled?: boolean;
  /** Optional VLM-only frame downscale. Disabled by default to preserve benchmark/main behavior. */
  vlmFrameResize?: VlmFrameResizeOptions;
  /** Explicit runtime mode. offline_quality preserves benchmark-safe non-streaming behavior. */
  runtimeMode?: "offline_quality" | "live_latency";
  /** Generate animated dashboard previews. Opt-in for isolated Dashboard demos only. */
  animatedSegmentPreview?: boolean;
  /** Called once segment-local critical identity/event/rule state has been committed. */
  onCriticalStateCommitted?: (segment: Segment) => void | Promise<void>;
  /** Memory-service operations (ReID before VLM, storage after VLM). */
  memory?: PipelineMemory;
  /** Long-term behavior memory write mode. Default observer preserves existing fire-and-forget behavior. */
  memoryHistoryMode?: "observer" | "strict";
  /** Optional post-processor for notifications + logging (wired by reflectworld plugin). */
  postProcessor?: PostProcessor;
  /** Optional generic logging/archive settings. */
  logging?: PipelineLoggingConfig;
  /** Optional STT analyzer for speech-to-text transcription of audio segments (Moonshine, local). */
  sttAnalyzer?: SttAnalyzer;
  /** Optional ElevenLabs STT provider (cloud, with speaker diarization). */
  elevenLabsStt?: ElevenLabsStt;
  /**
   * Optional precomputed STT provider. When set, called instead of sttAnalyzer/elevenLabsStt.
   * Must always return SttOutput (empty transcript = confirmed no speech, not failure).
   * Used by benchmark pipeline to inject external subtitle text (SRT files).
   */
  precomputedStt?: (segment: Segment) => SttOutput;
  /** NarrativeMemory for video-level cognitive layer (optional, wired by orchestrator). */
  narrativeMemory?: NarrativeMemory;
  /** Startup self-check context captured by createPipelineDeps. */
  selfCheck?: PipelineSelfCheckSnapshot;
  /** When true, VisionController controls capture — skip built-in CaptureHint logic. */
  visionControllerEnabled?: boolean;
  /** Callback for runtime VisionController reconfiguration (called by configure action). */
  onVisionControllerConfigure?: (config: Record<string, unknown>) => string;
  /**
   * Returns the segment policy exit condition prompt for a camera when an
   * active segment policy override needs VLM judgment. When present, VLM is
   * asked to judge whether the exit condition is met and sets
   * segment_policy_exit_met.
   */
  getSegmentPolicyExitPrompt?: (cameraId: string) => string | undefined;
  /** Semantic context loader for per-camera persistent scene profiles. */
  semanticContext?: {
    load(cameraId: string): Promise<string | undefined>;
    onSegmentProcessed(
      cameraId: string,
      summary: string,
      entities: Array<{ entity_id?: string; track_id?: string; type: string; appearance?: string; is_new_entity?: boolean }>,
      identityCues?: Array<{
        name: string;
        entity_id?: string;
        segment_id?: string;
        track_id?: string;
        speaker_id?: string;
        identity_level?: string;
        evidence?: string;
        source?: "target_identity" | "memory" | "other";
      }>,
    ): Promise<void>;
    clearBuffer(cameraId: string): void;
    setUserNotes(cameraId: string, notes: string): Promise<void>;
    setUserBackground?(cameraId: string, background: string): Promise<void>;
    initProfile(cameraId: string, sceneDescription: string): Promise<void>;
    updateDirectives?(cameraId: string, directives: {
      trackStates?: string[];
      trackActivities?: string[];
      explainDecisions?: boolean;
    }): Promise<string[]>;
  };
  /** Query total segment count for a camera from persistent store. */
  getSegmentCount?: (cameraId: string) => number;
  /** Per-segment subject index allocator backed by the host runtime store. */
  subjectRegistry?: {
      createSession(cameraId: string): {
        resolve(input: {
          category: string;
          entity_id?: string;
          wm_target_id?: string;
          subject_index?: number;
          name?: string;
          timestamp?: number;
        }): {
        category: string;
        subject_index: number;
        name?: string;
        entity_id?: string;
        wm_target_id?: string;
        first_seen: number;
      };
      commit(): void | Promise<void>;
    };
  };
  /** Per-camera runtime state for adaptive capture and first-watch tracking. */
  _runtimeState?: PipelineRuntimeState;
}
