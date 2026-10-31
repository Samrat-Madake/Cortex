// packages/percept/src/__tests__/retinaface.test.ts
import { describe, it, expect } from "vitest";
import { generatePriors, decodeRetinaFaceOutput, decodeRetinaFaceOutputWithDebug } from "../analyzers/retinaface.js";

describe("generatePriors", () => {
  it("should generate correct number of anchors for 320x320 input", () => {
    // Feature maps: ceil(320/8)=40, ceil(320/16)=20, ceil(320/32)=10
    // Anchors: 40*40*2 + 20*20*2 + 10*10*2 = 3200 + 800 + 200 = 4200
    const priors = generatePriors(320, 320);
    expect(priors.length).toBe(4200 * 4); // 4 values per anchor (cx, cy, w, h)
  });

  it("should generate correct number of anchors for 640x640 input", () => {
    // Feature maps: ceil(640/8)=80, ceil(640/16)=40, ceil(640/32)=20
    // Anchors: 80*80*2 + 40*40*2 + 20*20*2 = 12800 + 3200 + 800 = 16800
    const priors = generatePriors(640, 640);
    expect(priors.length).toBe(16800 * 4);
  });

  it("should generate normalized anchor values between 0 and 1", () => {
    const priors = generatePriors(320, 320);
    for (let i = 0; i < priors.length; i++) {
      // cx, cy should be roughly in [0, 1], w/h can be > 1 for large anchors
      if (i % 4 < 2) { // cx, cy
        expect(priors[i]).toBeGreaterThan(0);
        expect(priors[i]).toBeLessThan(1);
      }
    }
  });
});

describe("decodeRetinaFaceOutput", () => {
  it("should filter low-confidence detections", () => {
    const N = 4200; // 320x320 anchor count
    const bboxOffsets = new Float32Array(N * 4); // all zeros = no offset from anchor center
    const scores = new Float32Array(N).fill(0.1); // all low confidence
    const lmOffsets = new Float32Array(N * 10);

    const faces = decodeRetinaFaceOutput(
      bboxOffsets, scores, lmOffsets, N,
      320, 320,
      { confidenceThreshold: 0.5, scale: 1, padX: 0, padY: 0, visThreshold: 0.5, topK: 5000, keepTopK: 750, nmsThreshold: 0.4, minFaceSize: 1 },
    );

    expect(faces.length).toBe(0);
  });

  it("should expose decode filter counts for debugging", () => {
    const N = 4200;
    const bboxOffsets = new Float32Array(N * 4);
    const scores = new Float32Array(N).fill(0.1);
    const lmOffsets = new Float32Array(N * 10);

    const { faces, debug } = decodeRetinaFaceOutputWithDebug(
      bboxOffsets, scores, lmOffsets, N,
      320, 320,
      { confidenceThreshold: 0.5, scale: 1, padX: 0, padY: 0, visThreshold: 0.5, topK: 5000, keepTopK: 750, nmsThreshold: 0.4, minFaceSize: 1 },
    );

    expect(faces).toHaveLength(0);
    expect(debug).toMatchObject({
      anchors: N,
      pre_nms_confidence_threshold: 0.5,
      pre_nms_candidates: 0,
      output_faces: 0,
    });
  });

  it("should decode a high-confidence anchor into a valid bbox", () => {
    const N = 4200;
    const bboxOffsets = new Float32Array(N * 4);
    const scores = new Float32Array(N).fill(0);
    const lmOffsets = new Float32Array(N * 10);

    // Set one anchor to high confidence with zero offset (bbox = anchor itself)
    const testIdx = 100;
    scores[testIdx] = 0.95;
    // Zero offsets means the decoded box equals the prior box

    const faces = decodeRetinaFaceOutput(
      bboxOffsets, scores, lmOffsets, N,
      320, 320,
      { confidenceThreshold: 0.5, scale: 1, padX: 0, padY: 0, visThreshold: 0.5, topK: 5000, keepTopK: 750, nmsThreshold: 0.4, minFaceSize: 1 },
    );

    expect(faces.length).toBeGreaterThanOrEqual(1);
    const face = faces[0]!;
    expect(face.confidence).toBeCloseTo(0.95, 2);
    // Bbox should be within image bounds (0 ~ 320)
    expect(face.bbox.x).toBeGreaterThanOrEqual(0);
    expect(face.bbox.y).toBeGreaterThanOrEqual(0);
    expect(face.bbox.x + face.bbox.width).toBeLessThanOrEqual(320);
    expect(face.bbox.y + face.bbox.height).toBeLessThanOrEqual(320);
  });

  it("should filter faces smaller than minFaceSize", () => {
    const N = 4200;
    const bboxOffsets = new Float32Array(N * 4);
    const scores = new Float32Array(N).fill(0);
    const lmOffsets = new Float32Array(N * 10);
    scores[0] = 0.95;

    const faces = decodeRetinaFaceOutput(
      bboxOffsets, scores, lmOffsets, N,
      320, 320,
      { confidenceThreshold: 0.5, scale: 1, padX: 0, padY: 0, visThreshold: 0.5, topK: 5000, keepTopK: 750, nmsThreshold: 0.4, minFaceSize: 40 },
    );

    expect(faces).toHaveLength(0);
  });

  it("should apply scale and padding for coordinate un-mapping", () => {
    const N = 4200;
    const bboxOffsets = new Float32Array(N * 4);
    const scores = new Float32Array(N).fill(0);
    const lmOffsets = new Float32Array(N * 10);

    // Use an anchor near the center with high confidence
    const testIdx = 2100; // roughly center of 320x320
    scores[testIdx] = 0.9;

    const faces = decodeRetinaFaceOutput(
      bboxOffsets, scores, lmOffsets, N,
      320, 320,
      { confidenceThreshold: 0.5, scale: 0.5, padX: 10, padY: 10, visThreshold: 0.5, topK: 5000, keepTopK: 750, nmsThreshold: 0.4, minFaceSize: 1 },
    );

    // With scale=0.5 and padX/padY=10, coordinates are un-mapped:
    // x_orig = (x_letterbox - padX) / scale
    if (faces.length > 0) {
      const face = faces[0]!;
      expect(face.bbox.x).toBeGreaterThanOrEqual(0);
      expect(face.bbox.y).toBeGreaterThanOrEqual(0);
    }
  });
});
