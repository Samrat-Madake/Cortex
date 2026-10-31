// packages/cam/src/segmenter/fixed-window.ts

import type { FrameResult } from "../types.js";
import type { Segmenter, CutSignal } from "./types.js";

/**
 * FixedWindowSegmenter — cut every N frames (fallback strategy).
 * Used when no smarter signal (VAD/Motion) is available.
 */
export class FixedWindowSegmenter implements Segmenter {
  readonly name = "fixed_window";
  private count = 0;

  constructor(private readonly windowSize: number = 10) {}

  feed(_frame: FrameResult, index: number): CutSignal | null {
    this.count++;
    if (this.count >= this.windowSize) {
      this.count = 0;
      return { endIndex: index, reason: `fixed_window(${this.windowSize})` };
    }
    return null;
  }

  reset(): void {
    this.count = 0;
  }
}
