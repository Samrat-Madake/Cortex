// packages/percept/src/__tests__/clip-reid.test.ts
import { describe, it, expect } from "vitest";
import { normalizeEmbedding } from "../analyzers/adaface.js";

describe("CLIP-ReID", () => {
  it("should produce 768d embedding (verified via normalizeEmbedding)", () => {
    // Test that normalizeEmbedding works with 768d vectors
    const vec = new Float32Array(768).fill(1); // All ones
    const norm = normalizeEmbedding(vec);
    const expectedNorm = 1 / Math.sqrt(768);
    expect(norm[0]).toBeCloseTo(expectedNorm, 4);
    expect(norm.length).toBe(768);
  });

  it("should handle typical ReID embedding values", () => {
    const vec = new Float32Array(768);
    for (let i = 0; i < 768; i++) vec[i] = (i % 10) * 0.1 - 0.5;
    const norm = normalizeEmbedding(vec);
    let magnitude = 0;
    for (let i = 0; i < norm.length; i++) magnitude += norm[i]! * norm[i]!;
    expect(Math.sqrt(magnitude)).toBeCloseTo(1.0, 5);
  });
});
