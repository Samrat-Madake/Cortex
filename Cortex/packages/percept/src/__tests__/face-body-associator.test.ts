// packages/percept/src/__tests__/face-body-associator.test.ts
import { describe, it, expect } from "vitest";
import { FaceBodyAssociator } from "../analyzers/face-body-associator.js";
import type { BoundingBox } from "@cortex/shared";
import type { FaceDetection } from "../types.js";

describe("FaceBodyAssociator", () => {
  const associator = new FaceBodyAssociator();

  it("should associate face inside person bbox", () => {
    const bodies: Array<{ label: string; bbox: BoundingBox }> = [
      { label: "person", bbox: { x: 100, y: 50, width: 100, height: 300 } },
    ];
    const faces: FaceDetection[] = [
      { bbox: { x: 120, y: 60, width: 60, height: 70 }, confidence: 0.95 },
    ];

    const associations = associator.associate(bodies, faces);
    expect(associations.length).toBe(1);
    expect(associations[0]!.body_index).toBe(0);
    expect(associations[0]!.face_index).toBe(0);
    expect(associations[0]!.score).toBeGreaterThan(0.5);
  });

  it("should not associate face outside person bbox", () => {
    const bodies: Array<{ label: string; bbox: BoundingBox }> = [
      { label: "person", bbox: { x: 100, y: 50, width: 100, height: 300 } },
    ];
    const faces: FaceDetection[] = [
      { bbox: { x: 500, y: 500, width: 60, height: 70 }, confidence: 0.95 },
    ];

    const associations = associator.associate(bodies, faces);
    expect(associations.length).toBe(0);
  });

  it("should handle multiple persons and faces (greedy assignment)", () => {
    const bodies: Array<{ label: string; bbox: BoundingBox }> = [
      { label: "person", bbox: { x: 50, y: 50, width: 100, height: 300 } },
      { label: "person", bbox: { x: 300, y: 50, width: 100, height: 300 } },
    ];
    const faces: FaceDetection[] = [
      { bbox: { x: 70, y: 60, width: 50, height: 60 }, confidence: 0.9 },
      { bbox: { x: 320, y: 60, width: 50, height: 60 }, confidence: 0.85 },
    ];

    const associations = associator.associate(bodies, faces);
    expect(associations.length).toBe(2);
    const sorted = associations.sort((a, b) => a.body_index - b.body_index);
    expect(sorted[0]!.body_index).toBe(0);
    expect(sorted[0]!.face_index).toBe(0);
    expect(sorted[1]!.body_index).toBe(1);
    expect(sorted[1]!.face_index).toBe(1);
  });

  it("should return empty for non-person detections", () => {
    const bodies: Array<{ label: string; bbox: BoundingBox }> = [
      { label: "car", bbox: { x: 100, y: 50, width: 200, height: 100 } },
    ];
    const faces: FaceDetection[] = [
      { bbox: { x: 120, y: 60, width: 60, height: 70 }, confidence: 0.95 },
    ];

    const associations = associator.associate(bodies, faces);
    expect(associations.length).toBe(0);
  });

  it("should return empty when no faces provided", () => {
    const bodies: Array<{ label: string; bbox: BoundingBox }> = [
      { label: "person", bbox: { x: 100, y: 50, width: 100, height: 300 } },
    ];
    const associations = associator.associate(bodies, []);
    expect(associations.length).toBe(0);
  });

  it("should return empty when no bodies provided", () => {
    const faces: FaceDetection[] = [
      { bbox: { x: 120, y: 60, width: 60, height: 70 }, confidence: 0.95 },
    ];
    const associations = associator.associate([], faces);
    expect(associations.length).toBe(0);
  });
});
