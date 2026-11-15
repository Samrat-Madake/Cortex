import type { FrameLevelSignals } from "./types.js";

/**
 * Minimal detection result needed for frame-signal extraction.
 * Intentionally inline (not imported from @cortex/percept) to avoid
 * a cross-package dependency in the vision-controller layer.
 */
export interface FrameDetectionInput {
  label: string;
  confidence: number;
  bbox: { x1: number; y1: number; x2: number; y2: number };
}

/**
 * Motion state forwarded from the cam pipeline's MotionFilter.
 * Mirrors the shape of Segment._motion_hint.
 */
export interface MotionHint {
  has_motion: boolean;
  /** Timestamp (ms) when motion was last detected. 0 if never. */
  last_motion_at: number;
  /** Timestamp (ms) when scene last became still. 0 if never. */
  last_still_at: number;
}

/** Voice activity state forwarded from the cam pipeline's VAD. */
export interface VadHint {
  has_voice: boolean;
}

/**
 * Extract FrameLevelSignals from a single frame's detections and the current
 * motion state. Called before VLM so the rule engine can gate VLM invocation.
 *
 * @param detections      Detection results from the frame (YOLO26m / RetinaFace).
 * @param motionHint      Current motion state from MotionFilter, or undefined if unavailable.
 * @param frameTimestamp  Wall-clock timestamp (ms) of this frame.
 * @param vadHint         Voice activity state from the cam pipeline's VAD, or undefined.
 */
export function extractFrameSignals(
  detections: FrameDetectionInput[],
  motionHint: MotionHint | undefined,
  frameTimestamp: number,
  vadHint?: VadHint,
): FrameLevelSignals {
  const detected_classes = new Set(detections.map((d) => d.label));

  const class_counts = new Map<string, number>();
  for (const d of detections) {
    class_counts.set(d.label, (class_counts.get(d.label) ?? 0) + 1);
  }

  const has_motion = motionHint?.has_motion ?? false;

  // Motion has been sustained since the scene last became still.
  const motion_sustained_ms =
    motionHint != null && motionHint.last_motion_at > motionHint.last_still_at
      ? frameTimestamp - motionHint.last_still_at
      : 0;

  // Scene has been still since the last motion event ended.
  const no_motion_ms =
    motionHint != null && !motionHint.has_motion && motionHint.last_still_at > 0
      ? motionHint.last_motion_at > 0
        ? frameTimestamp - motionHint.last_motion_at
        : frameTimestamp - motionHint.last_still_at
      : 0;

  return {
    detected_classes,
    class_counts,
    has_motion,
    motion_sustained_ms,
    no_motion_ms,
    has_voice: vadHint?.has_voice ?? false,
  };
}
