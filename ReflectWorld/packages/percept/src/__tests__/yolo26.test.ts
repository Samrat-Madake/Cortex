// packages/percept/src/__tests__/yolo26.test.ts
import { describe, it, expect } from "vitest";
import { decodeYolo26Output } from "../analyzers/yolo26.js";

describe("decodeYolo26Output", () => {
  it("should decode detections from 6-column format", () => {
    // [x1, y1, x2, y2, confidence, class_id]
    const data = new Float32Array([
      100, 50, 300, 400, 0.92, 0,   // person
      400, 200, 600, 350, 0.85, 2,  // car
      10, 10, 50, 50, 0.1, 5,       // below threshold
    ]);

    const dets = decodeYolo26Output(data, 3, {
      confidenceThreshold: 0.5,
      scale: 1, padX: 0, padY: 0,
    });

    expect(dets.length).toBe(2);
    expect(dets[0]!.label).toBe("person");
    expect(dets[0]!.confidence).toBeCloseTo(0.92, 2);
    expect(dets[0]!.bbox.x).toBe(100);
    expect(dets[1]!.label).toBe("car");
  });

  it("should map coordinates back to original image space", () => {
    // 1920x1080 image scaled to 640x360, padded to 640x640
    // scale = 640/1920 = 0.333, padX = 0, padY = (640-360)/2 = 140
    const data = new Float32Array([
      100, 200, 300, 400, 0.9, 0, // person in 640x640 space
    ]);

    const dets = decodeYolo26Output(data, 1, {
      confidenceThreshold: 0.5,
      scale: 0.333, padX: 0, padY: 140,
    });

    expect(dets.length).toBe(1);
    // x1 = (100 - 0) / 0.333 ≈ 300
    expect(dets[0]!.bbox.x).toBeCloseTo(300, -1);
    // y1 = (200 - 140) / 0.333 ≈ 180
    expect(dets[0]!.bbox.y).toBeCloseTo(180, -1);
  });

  it("should return empty array when no detections above threshold", () => {
    const data = new Float32Array([
      100, 50, 200, 150, 0.1, 0,
    ]);
    const dets = decodeYolo26Output(data, 1, {
      confidenceThreshold: 0.5,
      scale: 1, padX: 0, padY: 0,
    });
    expect(dets).toEqual([]);
  });
});
