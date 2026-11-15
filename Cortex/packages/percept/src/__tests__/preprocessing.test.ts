// packages/percept/src/__tests__/preprocessing.test.ts
import { describe, it, expect } from "vitest";
import { normalizeImageToTensor } from "../models/preprocessing.js";

describe("preprocessing", () => {
  it("normalizeImageToTensor should produce correct shape", () => {
    // 3x2 image, RGB, values 0-255
    const pixels = new Uint8Array([
      255, 0, 0, 0, 255, 0,     // row 0: red, green
      0, 0, 255, 128, 128, 128, // row 1: blue, gray
      255, 255, 0, 0, 255, 255, // row 2: yellow, cyan
    ]);
    const result = normalizeImageToTensor(pixels, 2, 3, [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]);
    // Shape: [1, 3, 3, 2] = batch=1, channels=3, height=3, width=2
    expect(result.dims).toEqual([1, 3, 3, 2]);
    expect(result.data.length).toBe(1 * 3 * 3 * 2);
  });

  it("normalizeImageToTensor should normalize correctly with identity mean/std", () => {
    const pixels = new Uint8Array([0, 0, 0, 255, 255, 255]); // 1x2 black, white
    const result = normalizeImageToTensor(pixels, 2, 1, [0, 0, 0], [1, 1, 1]);
    const data = result.data as Float32Array;
    // Channel R, pixel 0: 0/255 = 0, pixel 1: 255/255 = 1
    expect(data[0]).toBeCloseTo(0, 3);
    expect(data[1]).toBeCloseTo(1, 3);
  });

  it("normalizeImageToTensor should apply ImageNet normalization", () => {
    // Pure white pixel: (255/255 - mean) / std
    const pixels = new Uint8Array([255, 255, 255]);
    const result = normalizeImageToTensor(pixels, 1, 1, [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]);
    const data = result.data as Float32Array;
    // R channel: (1.0 - 0.485) / 0.229 = 2.2489
    expect(data[0]).toBeCloseTo((1.0 - 0.485) / 0.229, 2);
  });
});
