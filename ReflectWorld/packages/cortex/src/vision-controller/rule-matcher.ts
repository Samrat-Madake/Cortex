import type { TriggerCondition, SegmentSignals } from "../vc-types/types.js";
import type { FrameLevelSignals } from "./types.js";

/** Condition types that can be evaluated from frame-level signals alone (no VLM). */
const FRAME_LEVEL_TYPES = new Set<TriggerCondition["type"]>([
  "class_detected",
  "class_absent",
  "class_count_gte",
  "motion_sustained_ms",
  "no_motion_ms",
  "all_of",
  "any_of",
]);

/**
 * Match a trigger condition against full segment-level signals.
 * Exhaustive — every TriggerCondition variant is handled.
 */
export function matchCondition(
  condition: TriggerCondition,
  signals: SegmentSignals,
): boolean {
  switch (condition.type) {
    case "class_detected":
      return signals.detected_classes.has(condition.class);
    case "class_absent":
      return !signals.detected_classes.has(condition.class);
    case "class_disappeared":
      return signals.disappeared_classes.has(condition.class);
    case "class_count_gte":
      return (signals.class_counts.get(condition.class) ?? 0) >= condition.count;
    case "face_detected":
      return signals.face_detected;
    case "motion_sustained_ms":
      return signals.motion_sustained_ms >= condition.duration;
    case "no_motion_ms":
      return signals.no_motion_ms >= condition.duration;
    case "voice_detected":
      return signals.voice_detected;
    case "unknown_entity":
      return signals.has_unknown_entity;
    case "known_entity":
      return signals.known_entity_ids.has(condition.entity_id);
    case "security_risk":
      return signals.security_risk;
    case "static_scene_count":
      return signals.static_scene_count >= condition.count;
    case "custom_field":
      return signals.custom_fields[condition.key] === condition.value;
    case "periodic_budget":
      return false; // Not a matchable condition; budget is checked separately in evaluateSegment
    case "all_of":
      return condition.conditions.every((c) => matchCondition(c, signals));
    case "any_of":
      return condition.conditions.some((c) => matchCondition(c, signals));
    default: {
      const _exhaustive: never = condition;
      throw new Error(`Unknown condition type: ${(_exhaustive as { type: string }).type}`);
    }
  }
}

/**
 * Match a trigger condition against frame-level signals only.
 * Segment-policy-only condition types (face_detected, security_risk, etc.) return false gracefully
 * because they require VLM output that is not available at frame-evaluation time.
 */
export function matchFrameCondition(
  condition: TriggerCondition,
  signals: FrameLevelSignals,
): boolean {
  switch (condition.type) {
    case "class_detected":
      return signals.detected_classes.has(condition.class);
    case "class_absent":
      return !signals.detected_classes.has(condition.class);
    case "class_count_gte":
      return (signals.class_counts.get(condition.class) ?? 0) >= condition.count;
    case "motion_sustained_ms":
      return signals.motion_sustained_ms >= condition.duration;
    case "no_motion_ms":
      return signals.no_motion_ms >= condition.duration;
    case "all_of":
      return condition.conditions.every((c) => matchFrameCondition(c, signals));
    case "any_of":
      return condition.conditions.some((c) => matchFrameCondition(c, signals));
    // Segment-policy-only condition types require VLM/segment output, unavailable at frame time.
    case "class_disappeared":
    case "face_detected":
    case "voice_detected":
    case "unknown_entity":
    case "known_entity":
    case "security_risk":
    case "static_scene_count":
    case "custom_field":
    case "periodic_budget":
      return false;
    default: {
      const _exhaustive: never = condition;
      throw new Error(`Unknown condition type: ${(_exhaustive as { type: string }).type}`);
    }
  }
}

/**
 * Returns true if a condition can be fully evaluated from frame-level signals alone.
 * Composite conditions (all_of/any_of) are frame-level only when ALL sub-conditions are.
 */
export function isFrameLevelRule(condition: TriggerCondition): boolean {
  if (condition.type === "all_of" || condition.type === "any_of") {
    return condition.conditions.every((c) => isFrameLevelRule(c));
  }
  return FRAME_LEVEL_TYPES.has(condition.type);
}
