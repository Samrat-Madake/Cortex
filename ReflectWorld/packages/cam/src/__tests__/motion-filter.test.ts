import { describe, it, expect } from "vitest";
import { MotionFilter } from "../motion-filter.js";
import jpeg from "jpeg-js";

/** Create a solid-color JPEG buffer. */
function makeJpeg(width: number, height: number, r: number, g: number, b: number): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  const raw = { data, width, height };
  return Buffer.from(jpeg.encode(raw, 90).data);
}

describe("MotionFilter", () => {
  it("first frame does NOT trigger motion (only initializes reference)", () => {
    const filter = new MotionFilter();
    const frame = makeJpeg(8, 8, 128, 128, 128);
    expect(filter.detect(frame)).toBe(false);
  });

  it("identical frames do not trigger motion", () => {
    const filter = new MotionFilter();
    const frame = makeJpeg(8, 8, 128, 128, 128);
    filter.detect(frame);
    expect(filter.detect(frame)).toBe(false);
  });

  it("requires confirmFrames consecutive motion frames (default 3)", () => {
    // Disable scene-change filter so we focus on confirm logic
    const filter = new MotionFilter({ maxChangeRatio: 1.0 });
    const a = makeJpeg(8, 8, 0, 0, 0);
    const b = makeJpeg(8, 8, 80, 80, 80);
    const c = makeJpeg(8, 8, 160, 160, 160);
    const d = makeJpeg(8, 8, 240, 240, 240);
    filter.detect(a); // first frame, init ref
    expect(filter.detect(b)).toBe(false); // 1st motion frame
    expect(filter.detect(c)).toBe(false); // 2nd motion frame
    expect(filter.detect(d)).toBe(true);  // 3rd consecutive → confirmed
  });

  it("confirmFrames=1 triggers on first motion frame", () => {
    // Use maxChangeRatio=1.0 to disable scene-change filter for this test
    const filter = new MotionFilter({ confirmFrames: 1, maxChangeRatio: 1.0 });
    const a = makeJpeg(8, 8, 0, 0, 0);
    const b = makeJpeg(8, 8, 200, 200, 200);
    filter.detect(a); // init
    expect(filter.detect(b)).toBe(true);
  });

  it("resets consecutive count when no motion frame appears", () => {
    const filter = new MotionFilter();
    const a = makeJpeg(8, 8, 0, 0, 0);
    const b = makeJpeg(8, 8, 128, 128, 128);
    filter.detect(a); // init
    filter.detect(b); // 1st motion, not confirmed
    filter.detect(b); // identical to previous = no motion, resets count
    expect(filter.detect(a)).toBe(false); // 1st motion again, not confirmed
  });

  it("scene-wide change (>maxChangeRatio) is NOT treated as motion", () => {
    const filter = new MotionFilter({ maxChangeRatio: 0.8, confirmFrames: 1 });
    const dark = makeJpeg(8, 8, 0, 0, 0);
    const bright = makeJpeg(8, 8, 255, 255, 255);
    filter.detect(dark); // init
    // 100% pixel change exceeds maxChangeRatio=0.8
    expect(filter.detect(bright)).toBe(false);
  });

  it("respects custom threshold", () => {
    const filter = new MotionFilter({ threshold: 1.0, confirmFrames: 1 });
    const a = makeJpeg(8, 8, 0, 0, 0);
    const b = makeJpeg(8, 8, 255, 255, 255);
    filter.detect(a);
    // Even 100% different, threshold=1.0 means nothing passes (except >1.0 which is impossible)
    expect(filter.detect(b)).toBe(false);
  });

  it("reset clears previous frame and consecutive count", () => {
    const filter = new MotionFilter();
    const frame = makeJpeg(8, 8, 128, 128, 128);
    filter.detect(frame);
    filter.reset();
    // After reset, next frame is treated as first frame (no motion)
    expect(filter.detect(frame)).toBe(false);
  });

  it("handles resolution change between frames (treated as new first frame)", () => {
    const filter = new MotionFilter();
    const a = makeJpeg(8, 8, 128, 128, 128);
    const b = makeJpeg(16, 16, 128, 128, 128);
    filter.detect(a);
    // Resolution change resets reference — treated as init, no motion
    expect(filter.detect(b)).toBe(false);
  });

  it("returns motion ratio via detectWithRatio", () => {
    const filter = new MotionFilter({ confirmFrames: 1, maxChangeRatio: 1.0 });
    const a = makeJpeg(8, 8, 0, 0, 0);
    const b = makeJpeg(8, 8, 200, 200, 200);
    filter.detect(a);
    const result = filter.detectWithRatio(b);
    expect(result.ratio).toBeGreaterThan(0);
  });

  it("tracks lastMotionAt and lastStillAt timestamps", () => {
    const filter = new MotionFilter({ confirmFrames: 1, maxChangeRatio: 1.0 });
    const stillFrame = makeJpeg(8, 8, 128, 128, 128);
    const motionFrame = makeJpeg(8, 8, 200, 200, 200);
    const before = Date.now();

    // First frame — still (no previous frame to compare)
    filter.detectWithRatio(stillFrame);
    expect(filter.lastStillAt).toBeGreaterThanOrEqual(before);
    expect(filter.lastMotionAt).toBe(0);

    // Same frame again — still
    filter.detectWithRatio(stillFrame);
    expect(filter.lastStillAt).toBeGreaterThanOrEqual(before);
    expect(filter.lastMotionAt).toBe(0);

    // Different frame — motion
    filter.detectWithRatio(motionFrame);
    expect(filter.lastMotionAt).toBeGreaterThanOrEqual(before);
  });

  it("reset clears lastMotionAt and lastStillAt", () => {
    const filter = new MotionFilter({ confirmFrames: 1, maxChangeRatio: 1.0 });
    const a = makeJpeg(8, 8, 0, 0, 0);
    const b = makeJpeg(8, 8, 200, 200, 200);
    filter.detectWithRatio(a);
    filter.detectWithRatio(b);
    expect(filter.lastMotionAt).toBeGreaterThan(0);
    filter.reset();
    expect(filter.lastMotionAt).toBe(0);
    expect(filter.lastStillAt).toBe(0);
  });

  it("tracks motion timestamps using provided frame timestamps", () => {
    const filter = new MotionFilter({ confirmFrames: 1, maxChangeRatio: 1.0 });
    const stillFrame = makeJpeg(8, 8, 0, 0, 0);
    const motionFrame = makeJpeg(8, 8, 255, 255, 255);

    filter.detectWithRatio(stillFrame, 1000);
    filter.detectWithRatio(motionFrame, 2500);

    expect(filter.lastStillAt).toBe(1000);
    expect(filter.lastMotionAt).toBe(2500);
  });

  it("detectWithRatio returns ratio 0 and motion=false for first frame", () => {
    const filter = new MotionFilter();
    const frame = makeJpeg(8, 8, 128, 128, 128);
    const result = filter.detectWithRatio(frame);
    expect(result.motion).toBe(false);
    expect(result.ratio).toBe(0);
  });
});
