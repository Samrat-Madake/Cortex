// packages/cam/src/segmenter/index.ts

export type { Segmenter, CutSignal, SegmenterHints } from "./types.js";
export { FixedWindowSegmenter } from "./fixed-window.js";
export { MotionSegmenter, type MotionSegmenterOptions } from "./motion-stub.js";
export { VADSegmenter, type VADSegmenterOptions } from "./vad-stub.js";
export { CompositeSegmenter, type CompositeSegmenterOptions } from "./composite.js";

import type { Segmenter } from "./types.js";
import { FixedWindowSegmenter } from "./fixed-window.js";
import { MotionSegmenter, type MotionSegmenterOptions } from "./motion-stub.js";
import { VADSegmenter, type VADSegmenterOptions } from "./vad-stub.js";
import { CompositeSegmenter, type CompositeSegmenterOptions } from "./composite.js";

/**
 * Create a segmenter chain.
 *
 * When both motion and VAD are enabled, returns a single CompositeSegmenter
 * that coordinates cutting decisions cooperatively.
 * Otherwise, returns the legacy chain (first to fire wins).
 */
export function createSegmenterChain(
  windowSize: number = 10,
  enableMotion: boolean = false,
  enableVad: boolean = false,
  motionOptions?: MotionSegmenterOptions,
  vadOptions?: VADSegmenterOptions,
  compositeOptions?: CompositeSegmenterOptions,
): Segmenter[] {
  // If both motion and VAD are enabled, use CompositeSegmenter
  if (enableMotion && enableVad) {
    return [new CompositeSegmenter({
      idleWindowFrames: windowSize,
      ...compositeOptions,
    })];
  }

  // Fallback: legacy chain for single-signal modes
  const chain: Segmenter[] = [];
  if (enableVad) chain.push(new VADSegmenter(vadOptions));
  if (enableMotion) chain.push(new MotionSegmenter(motionOptions));
  chain.push(new FixedWindowSegmenter(windowSize));
  return chain;
}
