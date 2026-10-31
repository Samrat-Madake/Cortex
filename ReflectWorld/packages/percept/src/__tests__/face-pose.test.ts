import { describe, it, expect } from "vitest";
import { estimateFacePose, poseFactor } from "../analyzers/face-pose.js";

describe("estimateFacePose", () => {
  // Standard frontal face landmarks (InsightFace ARCFACE_DST-like positions)
  const frontal = [
    { x: 38.3, y: 51.7 },  // left eye
    { x: 73.5, y: 51.5 },  // right eye
    { x: 56.0, y: 71.7 },  // nose
    { x: 41.5, y: 92.4 },  // left mouth
    { x: 70.7, y: 92.2 },  // right mouth
  ];

  it("should return near-zero yaw for frontal face", () => {
    const pose = estimateFacePose(frontal);
    expect(pose).toBeDefined();
    expect(Math.abs(pose!.yaw)).toBeLessThan(5);
  });

  it("should detect positive yaw when nose shifts right", () => {
    const rightTurn = frontal.map((p, i) => i === 2 ? { x: 66, y: p.y } : p);
    const pose = estimateFacePose(rightTurn);
    expect(pose).toBeDefined();
    expect(pose!.yaw).toBeGreaterThan(10);
  });

  it("should detect negative yaw when nose shifts left", () => {
    const leftTurn = frontal.map((p, i) => i === 2 ? { x: 46, y: p.y } : p);
    const pose = estimateFacePose(leftTurn);
    expect(pose).toBeDefined();
    expect(pose!.yaw).toBeLessThan(-10);
  });

  it("should detect roll from tilted eye line", () => {
    const tilted = [
      { x: 38, y: 45 },  // left eye higher
      { x: 73, y: 55 },  // right eye lower
      { x: 56, y: 71 },
      { x: 41, y: 92 },
      { x: 70, y: 92 },
    ];
    const pose = estimateFacePose(tilted);
    expect(pose).toBeDefined();
    expect(Math.abs(pose!.roll)).toBeGreaterThan(10);
  });

  it("should return undefined for missing landmarks", () => {
    expect(estimateFacePose(undefined)).toBeUndefined();
    expect(estimateFacePose([])).toBeUndefined();
    expect(estimateFacePose([{ x: 0, y: 0 }])).toBeUndefined();
  });

  it("should return undefined for degenerate landmarks (eyes at same point)", () => {
    const degenerate = [
      { x: 50, y: 50 },
      { x: 50, y: 50 },  // same as left eye
      { x: 50, y: 70 },
      { x: 40, y: 90 },
      { x: 60, y: 90 },
    ];
    expect(estimateFacePose(degenerate)).toBeUndefined();
  });
});

describe("poseFactor", () => {
  it("should return 1.0 for frontal face (yaw only)", () => {
    expect(poseFactor(0)).toBe(1.0);
    expect(poseFactor(10)).toBe(1.0);
    expect(poseFactor(-14)).toBe(1.0);
  });

  it("should return 0.85 for slight yaw turn", () => {
    expect(poseFactor(20)).toBe(0.85);
    expect(poseFactor(-25)).toBe(0.85);
  });

  it("should return 0.6 for moderate yaw profile", () => {
    expect(poseFactor(35)).toBe(0.6);
    expect(poseFactor(-40)).toBe(0.6);
  });

  it("should return 0.3 for strong yaw profile", () => {
    expect(poseFactor(60)).toBe(0.3);
    expect(poseFactor(-90)).toBe(0.3);
  });

  it("should penalize large pitch (looking up/down)", () => {
    // Frontal yaw but extreme pitch → pitch limits the factor
    expect(poseFactor(0, 0)).toBe(1.0);    // both frontal
    expect(poseFactor(0, 15)).toBe(1.0);   // slight pitch, still fine
    expect(poseFactor(0, 25)).toBe(0.85);  // moderate pitch
    expect(poseFactor(0, 40)).toBe(0.6);   // strong pitch
    expect(poseFactor(0, 60)).toBe(0.3);   // extreme pitch (looking way up/down)
  });

  it("should take the worse of yaw and pitch", () => {
    // Both moderate → min(0.85, 0.85) = 0.85
    expect(poseFactor(20, 25)).toBe(0.85);
    // Good yaw, bad pitch → 0.3
    expect(poseFactor(5, 55)).toBe(0.3);
    // Bad yaw, good pitch → 0.6
    expect(poseFactor(35, 10)).toBe(0.6);
  });

  it("should work without pitch (backward compat)", () => {
    expect(poseFactor(10, undefined)).toBe(1.0);
    expect(poseFactor(35)).toBe(0.6);
  });
});
