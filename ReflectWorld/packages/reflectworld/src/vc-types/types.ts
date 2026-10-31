// ── Vision Controller Shared Types ──

// ── Trigger Conditions ──

export type TriggerCondition =
  // Detection
  | { type: "class_detected"; class: string }
  | { type: "class_absent"; class: string }
  | { type: "class_disappeared"; class: string }
  | { type: "class_count_gte"; class: string; count: number }
  | { type: "face_detected" }
  // Motion (from Segment._motion_hint)
  | { type: "motion_sustained_ms"; duration: number }
  | { type: "no_motion_ms"; duration: number }
  // VAD
  | { type: "voice_detected" }
  // ReID
  | { type: "unknown_entity" }
  | { type: "known_entity"; entity_id: string }
  // VLM
  | { type: "security_risk" }
  | { type: "static_scene_count"; count: number }
  // VLM custom fields (Agent-defined, for complex semantic judgments)
  | { type: "custom_field"; key: string; value: string | number | boolean }
  // Budget (auto-generated, not user-configurable)
  | { type: "periodic_budget"; event_budget: number }
  // Composite
  | { type: "all_of"; conditions: TriggerCondition[] }
  | { type: "any_of"; conditions: TriggerCondition[] };

// ── Actions ──

export interface RuleAction {
  /** Cam sampling FPS. */
  fps?: number;
  /** Cam capture mode. */
  mode?: "event" | "stream";
  /** Skip VLM analysis (Detection/ReID still run). */
  skip_vlm?: boolean;
  /** Perception level cap (0=VLM only, 1=+Detection+ReID, 2=reserved future local tier). */
  max_level?: 0 | 1 | 2;
  /** VLM model override (e.g. "gemini-2.5-flash-lite"). */
  vlm_model?: string;
}

// ── Rules ──

export interface Rule {
  /** Human-readable name for logging. */
  name: string;
  /** Condition to trigger this rule. */
  trigger: TriggerCondition;
  /** Action to apply. Must explicitly set all intended fields. */
  action: RuleAction;
  /** Don't re-trigger within N ms. Default 0 (no cooldown). */
  cooldown_ms?: number;
  /** Keep action for N ms after last trigger, even if condition stops matching. Default 10000 (10s). */
  hold_ms?: number;
}

// ── Segment Policy ──

export interface SegmentPolicy {
  /** Segment-level semantic conditions that trigger Agent consultation. Any match triggers. */
  consultation_triggers: TriggerCondition[];
  /** Cooldown between Agent consultations (seconds). */
  consultation_cooldown_seconds: number;
  /** After at least N new events since the last consultation, request consultation once cooldown allows. 0 = disabled. */
  consultation_event_budget?: number;
}

// ── Config ──

export interface VCLegacyConfig {
  enabled: boolean;
  /** Default parameters when no rules match. */
  baseline: RuleAction;
  /**
   * Deterministic rules, evaluated after every PerceptionResult.
   * Ordered by priority (index 0 = highest).
   * All rules are scanned; action fields merge with first-write-wins semantics.
   */
  auto_rules: Rule[];
  /**
   * Segment-complete policy. This runs after PerceptionResult is available
   * and can trigger Agent consultation from semantic signals.
   */
  segment_policy?: SegmentPolicy;
}

// ── Signals ──

export interface SegmentSignals {
  detected_classes: Set<string>;
  class_counts: Map<string, number>;
  face_detected: boolean;
  has_motion: boolean;
  motion_sustained_ms: number;
  no_motion_ms: number;
  voice_detected: boolean;
  has_unknown_entity: boolean;
  known_entity_ids: Set<string>;
  security_risk: boolean;
  /** Consecutive static scenes, tracked across evaluations. */
  static_scene_count: number;
  /** Classes present in previous segment but absent now (edge trigger). */
  disappeared_classes: Set<string>;
  /** Agent-defined fields from VLM output. */
  custom_fields: Record<string, string | number | boolean>;
}

// ── Output ──

export interface LegacyOutput {
  /** Merged action to apply (from rules or baseline). */
  action: RuleAction;
  /** Names of rules that fired (empty if baseline applied). */
  firedRules: string[];
  /** Structured details for fired rules. */
  firedRuleDetails?: Array<{
    name: string;
    trigger: TriggerCondition;
    action: RuleAction;
  }>;
  /** Signal snapshot used for this evaluation. */
  signals?: SegmentSignals;
  /** Whether to consult Agent via Notifier. */
  shouldConsultAgent: boolean;
  /** Context to send to Agent (if shouldConsultAgent is true). */
  consultationContext?: {
    camera_id: string;
    signals: SegmentSignals;
    trigger_reason: TriggerCondition;
  };
}

// ── Per-camera state ──

export interface CameraState {
  prevSignals: SegmentSignals | null;
  ruleCooldowns: Map<string, number>;
  lastAgentConsultAt: number;
  /** Last escalated action (held until hold period expires). */
  lastEscalatedAction: RuleAction | null;
  /** Timestamp when hold period expires → revert to baseline. */
  holdUntil: number;
}
