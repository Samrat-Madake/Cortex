/**
 * CompositeSegmenter — cooperative motion+voice+entity segmentation.
 *
 * Active-state rules:
 *   1. Hard minimum — never cut before minDurationMs
 *   2. Hard maximum — cut unconditionally at hardMaxMs
 *   3. Hard frame maximum — default frame-count strategy cuts at hardMaxFrames
 *   4. Voice active — elapsed-time VAD strategy can defer to feedVoice
 *   5. No-voice window — cut at noVoiceWindowFrames
 *   6. Wait — not enough frames yet
 *
 * Idle state: cut at idleWindowFrames if no motion/voice/entity.
 */

import type { FrameResult } from "../types.js";
import { writeStderr } from "@reflectworld/shared";
import type { Segmenter, CutSignal, SegmenterHints } from "./types.js";

export interface CompositeSegmenterOptions {
  /** Hard minimum segment duration in ms. Default 5000. */
  minDurationMs?: number;
  /** Hard maximum segment duration in ms. Cuts unconditionally. Default 30000. */
  hardMaxMs?: number;
  /** Hard maximum segment frame count. Cuts unconditionally. Default 30. */
  hardMaxFrames?: number;
  /** Min frames for no-voice visual segments. Default 10. */
  noVoiceWindowFrames?: number;
  /** Frame window for idle scenes (no motion, no voice, no entity). Default 10. */
  idleWindowFrames?: number;
  /** Legacy frame-based voice threshold knob; kept for compatibility. */
  maxFrames?: number;
  /** Legacy frame-based voice threshold knob; kept for compatibility. */
  minFrames?: number;
  /**
   * Voice pause strategy. "frame_count" preserves benchmark/main defaults;
   * "elapsed_time" cuts at VAD pauses more aggressively for real-time streams.
   */
  vadPauseStrategy?: "frame_count" | "elapsed_time";
  /** Allow chunk-level speech to promote an idle visual segment to active. */
  promoteIdleOnVoice?: boolean;
}

type State = "idle" | "active";

export class CompositeSegmenter implements Segmenter {
  readonly name = "composite";

  private readonly minDurationMs: number;
  private readonly hardMaxMs: number;
  private readonly hardMaxFrames: number;
  private readonly noVoiceWindowFrames: number;
  private readonly idleWindowFrames: number;
  private readonly maxFrames: number;
  private readonly minFrames: number;
  private readonly vadPauseStrategy: "frame_count" | "elapsed_time";
  private readonly promoteIdleOnVoice: boolean;

  private state: State = "idle";
  private startTime = -1;
  private frameCount = 0;
  private voiceCooldown = 0;
  private voiceObserved = false;

  constructor(options?: CompositeSegmenterOptions) {
    this.minDurationMs = options?.minDurationMs ?? 5000;
    this.hardMaxMs = options?.hardMaxMs ?? 30000;
    this.hardMaxFrames = options?.hardMaxFrames ?? 30;
    this.noVoiceWindowFrames = options?.noVoiceWindowFrames ?? 10;
    this.idleWindowFrames = options?.idleWindowFrames ?? 10;
    this.maxFrames = options?.maxFrames ?? 15;
    this.minFrames = options?.minFrames ?? 10;
    this.vadPauseStrategy = options?.vadPauseStrategy ?? "frame_count";
    this.promoteIdleOnVoice = options?.promoteIdleOnVoice ?? false;
  }

  feed(frame: FrameResult, index: number, hints?: SegmenterHints): CutSignal | null {
    const hasMotion = hints?.hasMotion ?? false;
    const hasVoice = hints?.hasVoice ?? false;
    const hasEntity = hints?.hasEntity ?? false;

    if (this.startTime < 0) this.startTime = frame.timestamp;
    this.frameCount++;

    // IDLE: no activity — cut at fixed window
    if (this.state === "idle") {
      if (hasMotion || hasVoice || hasEntity) {
        this.state = "active";
        return null;
      }
      if (this.frameCount >= this.idleWindowFrames) {
        return this.cut(index, "idle_window");
      }
      return null;
    }

    // ACTIVE rules
    const elapsed = frame.timestamp - this.startTime;
    const useElapsedVoicePause = this.vadPauseStrategy === "elapsed_time";

    // Rule 1: Hard minimum — never cut before minDurationMs
    if (elapsed < this.minDurationMs) {
      // Safety: hard_max still overrides even within min duration
      if (elapsed >= this.hardMaxMs) return this.cut(index, "hard_max");
      return null;
    }

    // Rule 2: Hard maximum — cut unconditionally at hardMaxMs
    if (elapsed >= this.hardMaxMs) {
      return this.cut(index, "hard_max");
    }

    if (this.frameCount >= this.hardMaxFrames && !(useElapsedVoicePause && hasVoice)) {
      return this.cut(index, "hard_max_frames");
    }

    // Rule 3: Voice active — defer to feedVoice (32ms sentence boundary detection).
    // feedVoice's dynamic threshold gets more aggressive as elapsed segment time
    // grows, so long speech is cut at the next detectable pause instead of
    // waiting for the hard frame cap.
    if (hasVoice) {
      return null;
    }

    // Rule 5: No voice — cut at frame window
    if (this.frameCount >= this.noVoiceWindowFrames) {
      return this.cut(index, "no_voice_window");
    }

    // Rule 5: Not enough frames yet, wait
    return null;
  }

  /**
   * VAD chunk-level voice update (32ms granularity).
   * Called between frames — enables sub-frame-rate cut decisions.
   *
   * Dynamic silence threshold: the longer the segment, the shorter the pause
   * needed to trigger a cut. Formula:
   *   - At minDurationMs: require 10 consecutive silent chunks (~320ms)
   *   - Midway to hardMaxMs: require ~5 chunks (~160ms)
   *   - Near hardMaxMs: require 1 chunk (~32ms)
   * Linear interpolation between these points.
   */
  feedVoice(isSpeaking: boolean, timestampMs: number): CutSignal | null {
    // Audio can be the first meaningful signal in a scene. If VAD sees speech
    // while the visual path is still idle, promote the segment to active so the
    // following silence can become the cut boundary.
    if (isSpeaking) this.voiceObserved = true;
    if (this.promoteIdleOnVoice && isSpeaking && this.state === "idle" && this.frameCount > 0) {
      this.state = "active";
    }

    if (this.state !== "active" || this.frameCount <= 0) return null;
    if (!this.voiceObserved) return null;
    if (this.vadPauseStrategy === "frame_count") {
      return this.feedVoiceFrameCount(isSpeaking, timestampMs);
    }

    // Honor the minDurationMs floor — match the main feedFrame path so voice
    // cuts can't produce segments shorter than the configured minimum.
    const elapsed = timestampMs - this.startTime;
    if (elapsed < this.minDurationMs) return null;

    if (isSpeaking) {
      this.voiceCooldown = 0;
      return null;
    }

    this.voiceCooldown++;

    // Dynamic threshold: longer segment → shorter silence required. Use elapsed
    // time rather than frame count because low-fps streams can otherwise wait
    // until hard_max_frames before any pause becomes eligible.
    const dynamicWindowMs = Math.max(1, this.hardMaxMs - this.minDurationMs);
    const progress = Math.min(1, Math.max(0, (elapsed - this.minDurationMs) / dynamicWindowMs));
    const requiredSilentChunks = Math.max(1, Math.round(10 * (1 - progress) + 1 * progress));

    if (this.voiceCooldown >= requiredSilentChunks) {
      return this.cut(this.frameCount - 1, "voice_pause_adaptive", timestampMs);
    }
    return null;
  }

  private feedVoiceFrameCount(isSpeaking: boolean, timestampMs: number): CutSignal | null {
    const voiceCutMinFrames = Math.max(5, Math.floor(this.minFrames / 2));
    if (this.frameCount < voiceCutMinFrames) return null;

    const elapsed = timestampMs - this.startTime;
    if (elapsed < this.minDurationMs) return null;

    if (isSpeaking) {
      this.voiceCooldown = 0;
      return null;
    }

    this.voiceCooldown++;
    const progressWindow = Math.max(1, this.maxFrames - voiceCutMinFrames);
    const progress = Math.min(1, Math.max(0, (this.frameCount - voiceCutMinFrames) / progressWindow));
    const requiredSilentChunks = Math.max(1, Math.round(10 * (1 - progress) + 1 * progress));

    if (this.voiceCooldown >= requiredSilentChunks) {
      return this.cut(this.frameCount - 1, "voice_pause_adaptive", timestampMs);
    }
    return null;
  }

  reset(): void {
    this.state = "idle";
    this.startTime = -1;
    this.frameCount = 0;
    this.voiceCooldown = 0;
    this.voiceObserved = false;
  }

  private cut(endIndex: number, reason: string, timestampMs?: number): CutSignal {
    writeStderr(`[segmenter:composite] CUT at frame=${this.frameCount} reason=${reason}`);
    this.reset();
    return { endIndex, reason, ...(timestampMs === undefined ? {} : { timestampMs }) };
  }
}
