import { describe, it, expect } from "vitest";
import { computeBodyDiversity } from "../analyzers/body-pose-diversity.js";

type Kp = { x: number; y: number; confidence: number };

/**
 * Build a COCO-17 keypoint array. Defaults to all-visible at high confidence.
 * Override specific indices via `overrides` map (partial: any subset of x/y/confidence).
 */
function makeKps(overrides: Record<number, Partial<Kp>> = {}): Kp[] {
  // Anatomically reasonable front-facing keypoints (pixel coords).
  // Symmetric layout: head at top-center, shoulders ~100px apart, hips ~90px apart.
  const defaults: Kp[] = [
    /* 0  NOSE        */ { x: 200, y: 100, confidence: 0.9 },
    /* 1  L_EYE       */ { x: 210, y: 90,  confidence: 0.9 },
    /* 2  R_EYE       */ { x: 190, y: 90,  confidence: 0.9 },
    /* 3  L_EAR       */ { x: 220, y: 95,  confidence: 0.9 },
    /* 4  R_EAR       */ { x: 180, y: 95,  confidence: 0.9 },
    /* 5  L_SHOULDER  */ { x: 250, y: 150, confidence: 0.9 },
    /* 6  R_SHOULDER  */ { x: 150, y: 150, confidence: 0.9 },
    /* 7  L_ELBOW     */ { x: 270, y: 200, confidence: 0.9 },
    /* 8  R_ELBOW     */ { x: 130, y: 200, confidence: 0.9 },
    /* 9  L_WRIST     */ { x: 280, y: 250, confidence: 0.9 },
    /* 10 R_WRIST     */ { x: 120, y: 250, confidence: 0.9 },
    /* 11 L_HIP       */ { x: 240, y: 300, confidence: 0.9 },
    /* 12 R_HIP       */ { x: 160, y: 300, confidence: 0.9 },
    /* 13 L_KNEE      */ { x: 245, y: 400, confidence: 0.9 },
    /* 14 R_KNEE      */ { x: 155, y: 400, confidence: 0.9 },
    /* 15 L_ANKLE     */ { x: 248, y: 500, confidence: 0.9 },
    /* 16 R_ANKLE     */ { x: 152, y: 500, confidence: 0.9 },
  ];

  return defaults.map((kp, i) => {
    const ovr = overrides[i];
    if (!ovr) return kp;
    return { ...kp, ...ovr };
  });
}

describe("computeBodyDiversity", () => {
  it("front-facing full body → yaw_bin=front, visibility=full, shoulder_ratio close to 1.0", () => {
    const result = computeBodyDiversity(makeKps());
    expect(result.yaw_bin).toBe("front");
    expect(result.visibility).toBe("full");
    expect(result.shoulder_ratio).toBeDefined();
    // Shoulder width (100) vs hip width (80) → ref = max(80, 100) = 100 → ratio = 1.0
    expect(result.shoulder_ratio!).toBeCloseTo(1.0, 1);
  });

  it("side-facing (shoulders compressed) → yaw_bin=side", () => {
    // Compress shoulders to ~30px apart (side view), keep nose visible
    const kps = makeKps({
      5: { x: 215, y: 150 }, // L_SHOULDER close to center
      6: { x: 185, y: 150 }, // R_SHOULDER close to center
    });
    const result = computeBodyDiversity(kps);
    expect(result.yaw_bin).toBe("side");
    expect(result.shoulder_ratio).toBeDefined();
    expect(result.shoulder_ratio!).toBeLessThan(0.5);
  });

  it("upper body only (hips/knees invisible) → visibility=upper", () => {
    const kps = makeKps({
      11: { confidence: 0.1 }, // L_HIP invisible
      12: { confidence: 0.1 }, // R_HIP invisible
      13: { confidence: 0.1 }, // L_KNEE invisible
      14: { confidence: 0.1 }, // R_KNEE invisible
      15: { confidence: 0.1 }, // L_ANKLE invisible
      16: { confidence: 0.1 }, // R_ANKLE invisible
    });
    const result = computeBodyDiversity(kps);
    expect(result.visibility).toBe("upper");
    expect(result.yaw_bin).toBe("front");
  });

  it("one-sided visible (only one hip) → visibility=partial", () => {
    const kps = makeKps({
      12: { confidence: 0.1 }, // R_HIP invisible
      14: { confidence: 0.1 }, // R_KNEE invisible
    });
    const result = computeBodyDiversity(kps);
    expect(result.visibility).toBe("partial");
  });

  it("nose invisible + shoulders compressed → yaw_bin=back", () => {
    const kps = makeKps({
      0:  { confidence: 0.1 },   // NOSE invisible
      5:  { x: 210, y: 150 },    // L_SHOULDER compressed
      6:  { x: 190, y: 150 },    // R_SHOULDER compressed (20px apart)
    });
    const result = computeBodyDiversity(kps);
    expect(result.yaw_bin).toBe("back");
    expect(result.shoulder_ratio).toBeDefined();
    expect(result.shoulder_ratio!).toBeLessThan(0.5);
  });

  it("both shoulders invisible → fallback defaults", () => {
    const kps = makeKps({
      5: { confidence: 0.1 }, // L_SHOULDER invisible
      6: { confidence: 0.1 }, // R_SHOULDER invisible
    });
    const result = computeBodyDiversity(kps);
    expect(result.yaw_bin).toBe("front");
    expect(result.visibility).toBe("partial");
    expect(result.shoulder_ratio).toBeUndefined();
  });

  it("custom threshold respected", () => {
    // Shoulders at 0.4 — above default 0.3, below custom 0.5
    const kps = makeKps({
      5: { confidence: 0.4 },
      6: { confidence: 0.4 },
    });
    const result = computeBodyDiversity(kps, 0.5);
    // Both shoulders below custom threshold → fallback
    expect(result.yaw_bin).toBe("front");
    expect(result.shoulder_ratio).toBeUndefined();
  });

  it("both hips + no knees → visibility=full (complete torso)", () => {
    const kps = makeKps({
      13: { confidence: 0.1 }, // L_KNEE invisible
      14: { confidence: 0.1 }, // R_KNEE invisible
      15: { confidence: 0.1 }, // L_ANKLE invisible
      16: { confidence: 0.1 }, // R_ANKLE invisible
    });
    const result = computeBodyDiversity(kps);
    expect(result.visibility).toBe("full");
  });
});
