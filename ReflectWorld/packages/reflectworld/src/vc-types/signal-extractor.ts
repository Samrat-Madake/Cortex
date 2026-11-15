import type { PerceptionResult, Segment } from "@cortex/shared";
import type { SegmentSignals } from "./types.js";

/**
 * Extract standardized signals from a PerceptionResult + Segment.
 * Uses prevSignals for edge triggers (disappeared_classes) and
 * cumulative counters (static_scene_count).
 */
export function extractSignals(
  result: PerceptionResult,
  segment: Segment,
  prevSignals: SegmentSignals | null,
): SegmentSignals {
  const entities = result.perception_memory.entities ?? [];

  // Class detection
  const detected_classes = new Set(entities.map(e => e.type));
  const class_counts = new Map<string, number>();
  for (const e of entities) {
    class_counts.set(e.type, (class_counts.get(e.type) ?? 0) + 1);
  }

  // Edge trigger: classes that were present before but are gone now
  const prevClasses = prevSignals?.detected_classes ?? new Set<string>();
  const disappeared_classes = new Set([...prevClasses].filter(c => !detected_classes.has(c)));

  // Motion signals from Cam's _motion_hint
  const hint = segment._motion_hint;
  const segmentEndMs = segment.timestamp + Math.round(segment.duration_sec * 1000);
  const now = segmentEndMs;

  // Motion sustained: time since last still frame (when motion is active)
  // Guard against last_motion_at === 0 to avoid epoch-scale values
  const motion_sustained_ms = hint && hint.last_motion_at > hint.last_still_at
    ? now - hint.last_still_at
    : 0;

  // No motion: time since last motion (when currently still)
  // If never had motion (last_motion_at === 0), use time since first still
  const no_motion_ms = hint && !hint.has_motion && hint.last_still_at > 0
    ? (hint.last_motion_at > 0 ? now - hint.last_motion_at : now - hint.last_still_at)
    : 0;

  // Static scene counter (cumulative across evaluations)
  const static_scene_count = result.perception_memory.is_static_scene
    ? (prevSignals?.static_scene_count ?? 0) + 1
    : 0;

  return {
    detected_classes,
    class_counts,
    face_detected: entities.some(e => e.face_bbox != null),
    has_motion: hint?.has_motion ?? false,
    motion_sustained_ms,
    no_motion_ms,
    voice_detected: !!result.transcript,
    has_unknown_entity: entities.some(e => e.is_new_entity === true),
    known_entity_ids: new Set(
      entities.filter(e => e.entity_id != null).map(e => e.entity_id!),
    ),
    security_risk: result.perception_memory.security_risk,
    static_scene_count,
    disappeared_classes,
    custom_fields: result.perception_memory.custom_fields ?? {},
  };
}
