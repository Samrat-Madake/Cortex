// ── VisionController Types ──
// Re-exports shared types from vc-types library; adds frame-level evaluation types.

// Re-export shared types unchanged
export type { TriggerCondition, RuleAction, Rule, SegmentPolicy } from "../vc-types/types.js";

import type {
  TriggerCondition,
  RuleAction,
  Rule,
  SegmentPolicy,
  SegmentSignals,
} from "../vc-types/types.js";

// ── Frame-level signals (extracted without running VLM) ──

export interface FrameLevelSignals {
  detected_classes: Set<string>;
  class_counts: Map<string, number>;
  has_motion: boolean;
  motion_sustained_ms: number;
  no_motion_ms: number;
  has_voice: boolean;
}

// ── Frame policy output (deterministic rule engine, frame-level) ──

export interface FramePolicyOutput {
  firedRules: string[];
  firedRuleDetails: Array<{
    name: string;
    trigger: TriggerCondition;
    action: RuleAction;
  }>;
  action: {
    fps?: number;
    skip_vlm?: boolean;
    max_level?: number;
    mode?: "event" | "stream";
    vlm_model?: string;
  };
  signals: FrameLevelSignals;
}

// ── Segment policy state (held overrides from segment-level rules/consultation) ──

/** Inlined action type to avoid circular reference with SegmentPolicyOutput. */
export interface SegmentPolicyOverrideAction {
  fps?: number;
  skip_vlm?: boolean;
  max_level?: number;
  vlm_model?: string;
}

export interface SegmentPolicyState {
  override: SegmentPolicyOverrideAction | null;
  exitCondition: TriggerCondition | null;
  activatedAt: number;
  absoluteMaxHoldMs: number;
}

// ── Segment policy output (VLM/segment-level, includes Agent consultation) ──

export interface SegmentPolicyOutput {
  firedRules: string[];
  firedRuleDetails: Array<{
    name: string;
    trigger: TriggerCondition;
    action: RuleAction;
  }>;
  action: SegmentPolicyOverrideAction;
  segmentPolicyCleared: boolean;
  shouldConsultAgent: boolean;
  consultationContext?: {
    camera_id: string;
    signals: SegmentSignals;
    trigger_reason: TriggerCondition;
  };
}

// ── Config ──

export interface VisionControllerConfig {
  enabled: boolean;
  baseline: RuleAction;
  rules: Rule[];
  segment_policy?: SegmentPolicy;
}

// ── Per-camera state ──

export interface CameraState {
  prevFrameSignals: FrameLevelSignals | null;
  ruleCooldowns: Map<string, number>;
  framePolicyHoldUntil: number;
  lastFramePolicyAction: FramePolicyOutput["action"] | null;
  prevSegmentSignals: SegmentSignals | null;
  segmentPolicy: SegmentPolicyState;
  lastAgentConsultAt: number;
  eventsSinceConsult: number;
  lastEventId: string | undefined;
}
