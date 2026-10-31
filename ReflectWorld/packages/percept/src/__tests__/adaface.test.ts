// packages/percept/src/__tests__/adaface.test.ts
import { describe, it, expect } from "vitest";
import { normalizeEmbedding } from "../analyzers/adaface.js";

describe("AdaFace", () => {
  it("normalizeEmbedding should L2-normalize a vector", () => {
    const vec = new Float32Array([3, 4]); // L2 norm = 5
    const norm = normalizeEmbedding(vec);
    expect(norm[0]).toBeCloseTo(0.6, 5);
    expect(norm[1]).toBeCloseTo(0.8, 5);
  });

  it("normalizeEmbedding should handle zero vector", () => {
    const vec = new Float32Array([0, 0, 0]);
    const norm = normalizeEmbedding(vec);
    expect(norm.every((v) => v === 0)).toBe(true);
  });

  it("normalizeEmbedding should produce unit-length vector", () => {
    const vec = new Float32Array(512);
    for (let i = 0; i < 512; i++) vec[i] = Math.random() - 0.5;
    const norm = normalizeEmbedding(vec);
    let magnitude = 0;
    for (let i = 0; i < norm.length; i++) magnitude += norm[i]! * norm[i]!;
    expect(Math.sqrt(magnitude)).toBeCloseTo(1.0, 5);
  });
});
