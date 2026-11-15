// packages/cam/src/segmenter/motion-stub.ts

import type { FrameResult } from "../types.js";
import type { Segmenter, CutSignal, SegmenterHints } from "./types.js";

type MotionState = "idle" | "in_motion" | "cooldown";

export interface MotionSegmenterOptions {
  /** Number of consecutive no-motion frames before cutting. Default 5. */
  cooldownFrames?: number;
  /** Max segment duration in ms. Force cut even if motion continues. Default 30000 (30s). */
  maxDurationMs?: number;
  /** Min segment duration in ms. Won't cut until at least this long. Default 5000 (5s). */
  minDurationMs?: number;
}

/**
 * MotionSegmenter — cut when motion stops.
 *
 * Does NOT do motion detection itself. Reads `hints.hasMotion` from
 * the upstream MotionFilter (computed once in onFrame callback).
 *
 * Constraints:
 *   - minDurationMs: cooldown expires but elapsed < min → stay in_motion, wait longer
 *   - maxDurationMs: force cut even during continuous motion
 *
 * State machine:
 *   IDLE ──(hasMotion)──> IN_MOTION
 *   IN_MOTION ──(!hasMotion)──> COOLDOWN (start counting)
 *   IN_MOTION ──(elapsed >= max)──> CUT (force)
 *   COOLDOWN ──(hasMotion)──> IN_MOTION (reset counter)
 *   COOLDOWN ──(count >= cooldownFrames && elapsed >= min)──> CUT → IDLE
 *   COOLDOWN ──(count >= cooldownFrames && elapsed < min)──> IN_MOTION (keep accumulating)
 */
export class MotionSegmenter implements Segmenter {
  readonly name = "motion";

  private state: MotionState = "idle";
  private cooldownCount = 0;
  private motionStartIndex = -1;
  private motionStartTime = 0;
  private readonly cooldownFrames: number;
  private readonly maxDurationMs: number;
  private readonly minDurationMs: number;

  constructor(options?: MotionSegmenterOptions) {
    this.cooldownFrames = options?.cooldownFrames ?? 5;
    this.maxDurationMs = options?.maxDurationMs ?? 30_000;
    this.minDurationMs = options?.minDurationMs ?? 5_000;
  }

  feed(frame: FrameResult, index: number, hints?: SegmenterHints): CutSignal | null {
    const hasMotion = hints?.hasMotion ?? false;
    const now = frame.timestamp;

    switch (this.state) {
      case "idle":
        if (hasMotion) {
          this.state = "in_motion";
          this.motionStartIndex = index;
          this.motionStartTime = now;
        }
        return null;

      case "in_motion": {
        const elapsed = now - this.motionStartTime;

        // Max duration: force cut even if motion continues
        if (elapsed >= this.maxDurationMs) {
          const signal: CutSignal = {
            endIndex: index,
            reason: `motion_max(${Math.round(elapsed)}ms)`,
          };
          this.reset();
          return signal;
        }

        if (!hasMotion) {
          this.state = "cooldown";
          this.cooldownCount = 1;
        }
        return null;
      }

      case "cooldown": {
        if (hasMotion) {
          this.state = "in_motion";
          this.cooldownCount = 0;
          return null;
        }
        this.cooldownCount++;
        if (this.cooldownCount >= this.cooldownFrames) {
          const elapsed = now - this.motionStartTime;

          if (elapsed < this.minDurationMs) {
            // Too short — don't cut, go back to in_motion and keep accumulating
            this.state = "in_motion";
            this.cooldownCount = 0;
            return null;
          }

          const signal: CutSignal = {
            endIndex: index,
            reason: `motion_stop(${Math.round(elapsed)}ms)`,
          };
          this.reset();
          return signal;
        }
        return null;
      }
    }
  }

  reset(): void {
    this.state = "idle";
    this.cooldownCount = 0;
    this.motionStartIndex = -1;
    this.motionStartTime = 0;
  }
}
