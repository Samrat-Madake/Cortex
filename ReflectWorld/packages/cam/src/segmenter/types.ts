// packages/cam/src/segmenter/types.ts

import type { FrameResult } from "../types.js";

/** A cut point produced by a segmenter. */
export interface CutSignal {
  /** Index of the last frame in this segment (inclusive). */
  endIndex: number;
  /** Reason for the cut. */
  reason: string;
  /** Optional media timestamp for sub-frame cuts, e.g. VAD chunk PTS. */
  timestampMs?: number;
}

/** Hints passed alongside a frame to avoid redundant computation. */
export interface SegmenterHints {
  /** Pre-computed motion detection result from MotionFilter. */
  hasMotion?: boolean;
  /** Motion ratio from MotionFilter. */
  motionRatio?: number;
  /** Pre-computed voice activity detection result from SileroVad. */
  hasVoice?: boolean;
  /** YOLO detected trackable entity in this frame. */
  hasEntity?: boolean;
}

/** Segmenter interface — pluggable stream cutting strategy. */
export interface Segmenter {
  readonly name: string;

  /**
   * Feed a new frame into the segmenter.
   * Returns a CutSignal if a segment boundary is detected, null otherwise.
   */
  feed(frame: FrameResult, index: number, hints?: SegmenterHints): CutSignal | null;

  /**
   * Update voice state at VAD chunk granularity (32ms).
   * Called between frames to allow sub-frame-rate cut decisions.
   * Returns a CutSignal if voice silence triggers a cut, null otherwise.
   * Optional — segmenters that don't use voice can leave unimplemented.
   */
  feedVoice?(isSpeaking: boolean, timestampMs: number): CutSignal | null;

  /** Reset internal state (e.g., after a cut). */
  reset(): void;
}
