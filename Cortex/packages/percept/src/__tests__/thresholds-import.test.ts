import { describe, it, expect } from "vitest";
import { BODY_REID_MATCH_THRESHOLD, ACCUMULATOR_FACE_MIN_FRAMES } from "../thresholds.js";

describe("thresholds", () => {
  it("exports BODY_REID_MATCH_THRESHOLD as 0.85", () => {
    expect(BODY_REID_MATCH_THRESHOLD).toBe(0.85);
  });
  it("exports accumulator constants", () => {
    expect(ACCUMULATOR_FACE_MIN_FRAMES).toBe(2);
  });
});
