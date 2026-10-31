import type { TriggerCondition, SegmentSignals } from "./types.js";

/** Match a trigger condition against extracted signals. */
export function matchCondition(condition: TriggerCondition, signals: SegmentSignals): boolean {
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
      return false; // Not a matchable condition; budget is checked separately
    case "all_of":
      return condition.conditions.every(c => matchCondition(c, signals));
    case "any_of":
      return condition.conditions.some(c => matchCondition(c, signals));
    default: {
      const _exhaustive: never = condition;
      throw new Error(`Unknown condition type: ${(_exhaustive as { type: string }).type}`);
    }
  }
}
