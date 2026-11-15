import { describe, it, expect } from "vitest";
import { scoreBodyCompleteness } from "../analyzers/body-completeness.js";

function makeKps(overrides: Record<number, number> = {}): Array<{ x: number; y: number; confidence: number }> {
  return Array.from({ length: 17 }, (_, i) => ({
    x: i * 10,
    y: i * 10,
    confidence: overrides[i] ?? 0.9,
  }));
}

describe("scoreBodyCompleteness", () => {
  it("returns 1.0 for full body (all keypoints visible)", () => {
    const result = scoreBodyCompleteness(makeKps());
    expect(result.score).toBe(1.0);
    expect(result.shouldExtractBody).toBe(true);
  });

  it("returns 1.0 when shoulders + hips visible but ankles missing", () => {
    const result = scoreBodyCompleteness(makeKps({ 15: 0.1, 16: 0.1 }));
    expect(result.score).toBe(1.0);
    expect(result.shouldExtractBody).toBe(true);
  });

  it("returns 0.5 when shoulders visible but hips missing", () => {
    const result = scoreBodyCompleteness(makeKps({ 11: 0.1, 12: 0.1 }));
    expect(result.score).toBe(0.5);
    expect(result.shouldExtractBody).toBe(true);
  });

  it("returns 0 when left shoulder missing", () => {
    const result = scoreBodyCompleteness(makeKps({ 5: 0.1 }));
    expect(result.score).toBe(0);
    expect(result.shouldExtractBody).toBe(false);
  });

  it("returns 0 when right shoulder missing", () => {
    const result = scoreBodyCompleteness(makeKps({ 6: 0.1 }));
    expect(result.score).toBe(0);
    expect(result.shouldExtractBody).toBe(false);
  });

  it("returns 0 when both shoulders missing (only legs visible)", () => {
    const kps = makeKps({ 0: 0.1, 1: 0.1, 2: 0.1, 3: 0.1, 4: 0.1, 5: 0.1, 6: 0.1, 7: 0.1, 8: 0.1, 9: 0.1, 10: 0.1 });
    const result = scoreBodyCompleteness(kps);
    expect(result.score).toBe(0);
    expect(result.shouldExtractBody).toBe(false);
  });

  it("uses custom threshold when provided", () => {
    const kps = makeKps({ 5: 0.4 });
    const result = scoreBodyCompleteness(kps, 0.5);
    expect(result.score).toBe(0);
    expect(result.shouldExtractBody).toBe(false);
  });
});
