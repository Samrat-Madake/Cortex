import jpeg from "jpeg-js";
import pixelmatch from "pixelmatch";

export interface MotionFilterOptions {
  /** Fraction of pixels that must differ to count as motion (0-1). Default 0.02 */
  threshold?: number;
  /** Per-pixel color distance for pixelmatch (0-1). Default 0.1 */
  pixelThreshold?: number;
  /** Consecutive motion frames required before confirming motion. Default 3 */
  confirmFrames?: number;
  /** Ratio above this = scene-wide change (lighting shift), not motion. Default 0.8 */
  maxChangeRatio?: number;
}

export interface MotionDetectResult {
  motion: boolean;
  ratio: number;
}

export class MotionFilter {
  private previousFrame: Uint8Array | null = null;
  private previousWidth = 0;
  private previousHeight = 0;
  private readonly threshold: number;
  private readonly pixelThreshold: number;
  private readonly confirmFrames: number;
  private readonly maxChangeRatio: number;
  private consecutiveMotionCount = 0;
  /** Timestamp of last detected motion (ms epoch). */
  lastMotionAt = 0;
  /** Timestamp of last still frame (ms epoch). */
  lastStillAt = 0;

  constructor(options?: MotionFilterOptions) {
    this.threshold = options?.threshold ?? 0.02;
    this.pixelThreshold = options?.pixelThreshold ?? 0.1;
    this.confirmFrames = options?.confirmFrames ?? 3;
    this.maxChangeRatio = options?.maxChangeRatio ?? 0.8;
  }

  detect(jpegBuffer: Buffer, timestampMs?: number): boolean {
    return this.detectWithRatio(jpegBuffer, timestampMs).motion;
  }

  detectWithRatio(jpegBuffer: Buffer, timestampMs?: number): MotionDetectResult {
    const { data, width, height } = jpeg.decode(jpegBuffer, { useTArray: true });
    const now = timestampMs ?? Date.now();

    if (!this.previousFrame || width !== this.previousWidth || height !== this.previousHeight) {
      // First frame: initialize reference, do NOT trigger motion
      this.previousFrame = data;
      this.previousWidth = width;
      this.previousHeight = height;
      this.consecutiveMotionCount = 0;
      this.lastStillAt = now;
      return { motion: false, ratio: 0 };
    }

    const diffPixels = pixelmatch(
      this.previousFrame, data, undefined, width, height,
      { threshold: this.pixelThreshold },
    );
    const ratio = diffPixels / (width * height);

    this.previousFrame = data;
    this.previousWidth = width;
    this.previousHeight = height;

    // Scene-wide change (lighting shift, camera adjustment) — not real motion
    if (ratio > this.maxChangeRatio) {
      this.consecutiveMotionCount = 0;
      this.lastStillAt = now;
      return { motion: false, ratio };
    }

    if (ratio > this.threshold) {
      this.consecutiveMotionCount++;
      // Only confirm motion after N consecutive frames
      const confirmed = this.consecutiveMotionCount >= this.confirmFrames;
      if (confirmed) {
        this.lastMotionAt = now;
      }
      return { motion: confirmed, ratio };
    }

    // No motion — reset consecutive count
    this.consecutiveMotionCount = 0;
    this.lastStillAt = now;
    return { motion: false, ratio };
  }

  reset(): void {
    this.previousFrame = null;
    this.previousWidth = 0;
    this.previousHeight = 0;
    this.consecutiveMotionCount = 0;
    this.lastMotionAt = 0;
    this.lastStillAt = 0;
  }
}
