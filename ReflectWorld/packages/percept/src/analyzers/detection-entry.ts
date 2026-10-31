// packages/percept/src/analyzers/detection-entry.ts
import type { Frame } from "@reflectworld/shared";
import type { AnalyzerResult } from "../types.js";
import type { ModelRouter } from "../providers/model-router.js";

/**
 * Detection analyzer entry point.
 * Segment-level object detection is intentionally disabled. Percept consumes
 * frame.detections supplied by the upstream frame analyzer instead.
 */
export async function runDetection(
  _frames: Frame[],
  _router?: ModelRouter,
): Promise<AnalyzerResult> {
  return {
    available: false,
    analyzer: "detection",
    error: "Segment-level object detection is disabled; provide frame.detections on the segment.",
    latency_ms: 0,
  };
}
