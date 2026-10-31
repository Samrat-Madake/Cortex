// packages/cam/src/segmenter/vad-stub.ts

import type { FrameResult } from "../types.js";
import type { Segmenter, CutSignal, SegmenterHints } from "./types.js";

type VadState = "idle" | "speaking" | "silence_cooldown";

export interface VADSegmenterOptions {
  /** Number of consecutive no-voice frames before cutting. Default 3. */
  cooldownFrames?: number;
  /** Max segment duration in ms. Force cut even if voice continues. Default 60000 (60s). */
  maxDurationMs?: number;
  /** Min segment duration in ms. Won't cut until at least this long. Default 3000 (3s). */
  minDurationMs?: number;
}

/**
 * VADSegmenter — cut when voice activity ends.
 *
 * Does NOT do VAD itself. Reads `hints.hasVoice` from the upstream
 * SileroVad (computed in the audio pipeline, bridged via onFrame).
 *
 * State machine (mirrors MotionSegmenter):
 *   IDLE ──(hasVoice)──> SPEAKING
 *   SPEAKING ──(!hasVoice)──> SILENCE_COOLDOWN (start counting)
 *   SPEAKING ──(elapsed >= max)──> CUT (force)
 *   SILENCE_COOLDOWN ──(hasVoice)──> SPEAKING (reset counter)
 *   SILENCE_COOLDOWN ──(count >= cooldownFrames && elapsed >= min)──> CUT → IDLE
 *   SILENCE_COOLDOWN ──(count >= cooldownFrames && elapsed < min)──> SPEAKING (keep accumulating)
 */
export class VADSegmenter implements Segmenter {
  readonly name = "vad";

  private state: VadState = "idle";
  private cooldownCount = 0;
  private voiceStartTime = 0;
  private readonly cooldownFrames: number;
  private readonly maxDurationMs: number;
  private readonly minDurationMs: number;

  constructor(options?: VADSegmenterOptions) {
    this.cooldownFrames = options?.cooldownFrames ?? 3;
    this.maxDurationMs = options?.maxDurationMs ?? 60_000;
    this.minDurationMs = options?.minDurationMs ?? 3_000;
  }

  feed(frame: FrameResult, index: number, hints?: SegmenterHints): CutSignal | null {
    const hasVoice = hints?.hasVoice ?? false;
    const now = frame.timestamp;

    switch (this.state) {
      case "idle":
        if (hasVoice) {
          this.state = "speaking";
          this.voiceStartTime = now;
        }
        return null;

      case "speaking": {
        const elapsed = now - this.voiceStartTime;

        // Max duration: force cut even if voice continues
        if (elapsed >= this.maxDurationMs) {
          const signal: CutSignal = {
            endIndex: index,
            reason: `vad_max(${Math.round(elapsed)}ms)`,
          };
          this.reset();
          return signal;
        }

        if (!hasVoice) {
          this.state = "silence_cooldown";
          this.cooldownCount = 1;
        }
        return null;
      }

      case "silence_cooldown": {
        if (hasVoice) {
          this.state = "speaking";
          this.cooldownCount = 0;
          return null;
        }
        this.cooldownCount++;
        if (this.cooldownCount >= this.cooldownFrames) {
          const elapsed = now - this.voiceStartTime;

          if (elapsed < this.minDurationMs) {
            // Too short — don't cut, go back to speaking and keep accumulating
            this.state = "speaking";
            this.cooldownCount = 0;
            return null;
          }

          const signal: CutSignal = {
            endIndex: index,
            reason: `vad_silence(${Math.round(elapsed)}ms)`,
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
    this.voiceStartTime = 0;
  }
}
