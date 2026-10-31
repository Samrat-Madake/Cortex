// packages/percept/src/__tests__/clique.test.ts
import { describe, it, expect } from "vitest";
import {
  cosineSimilarity,
  findMaxClique,
  type CliqueCandidate,
} from "../analyzers/clique.js";

// ---------------------------------------------------------------------------
// Helper: build a CliqueCandidate from a plain number[] embedding
// ---------------------------------------------------------------------------
function candidate(
  embedding: number[],
  quality: number,
  index: number,
): CliqueCandidate {
  return { embedding, quality, index };
}

// ---------------------------------------------------------------------------
// 12. cosineSimilarity unit tests
// ---------------------------------------------------------------------------
describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    const v = [0.3, 0.4, 0.5];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 6);
  });

  it("returns 0.0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0, 6);
  });

  it("returns -1.0 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0, 6);
  });
});

// ---------------------------------------------------------------------------
// Face threshold = 0.6
// ---------------------------------------------------------------------------
describe("findMaxClique — face (threshold 0.6)", () => {
  const FACE_THRESH = 0.6;

  // 1. Two consistent faces (sim ≈ 0.85 > 0.6) → clique size 2
  it("returns 2-clique for two consistent faces", () => {
    // Two vectors with known high cosine similarity.
    // cos(A,B) ≈ 0.85
    const A = [1, 0, 0, 0, 0];
    const B = [0.85, 0.527, 0, 0, 0]; // sim(A,B) = 0.85 / sqrt(0.85^2+0.527^2) ≈ 0.85
    // Verify similarity is around 0.85
    expect(cosineSimilarity(A, B)).toBeGreaterThan(0.8);

    const result = findMaxClique(
      [candidate(A, 0.9, 0), candidate(B, 0.8, 1)],
      FACE_THRESH,
      2,
    );
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2);
  });

  // 2. Two inconsistent faces (sim < 0.6) → null
  it("returns null for two inconsistent faces", () => {
    const A = [1, 0, 0];
    const B = [0.5, 0.866, 0]; // sim(A,B) = 0.5 < 0.6
    expect(cosineSimilarity(A, B)).toBeLessThan(0.6);

    const result = findMaxClique(
      [candidate(A, 0.9, 0), candidate(B, 0.8, 1)],
      FACE_THRESH,
      2,
    );
    expect(result).toBeNull();
  });

  // 3. Three faces, two-true-one-fake: A-B ≈ 0.85, A-C ≈ 0.3, B-C ≈ 0.3 → clique {A,B}
  it("returns 2-clique when one face is fake among three", () => {
    const A = [1, 0, 0];
    const B = [0.85, 0.527, 0]; // sim(A,B) ≈ 0.85
    const C = [0, 0, 1]; // sim(A,C) = 0, sim(B,C) = 0
    expect(cosineSimilarity(A, B)).toBeGreaterThan(0.6);
    expect(cosineSimilarity(A, C)).toBeLessThan(0.6);
    expect(cosineSimilarity(B, C)).toBeLessThan(0.6);

    const result = findMaxClique(
      [candidate(A, 0.9, 0), candidate(B, 0.85, 1), candidate(C, 0.7, 2)],
      FACE_THRESH,
      2,
    );
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2);
    // Should contain A and B (indices 0 and 1)
    const indices = result!.map((c) => c.index).sort();
    expect(indices).toEqual([0, 1]);
  });

  // 4. Four faces, three-true-one-fake: A-B-C all mutual > 0.6, D with all < 0.6 → clique {A,B,C}
  it("returns 3-clique from four candidates when one is fake", () => {
    // Use vectors in 4D that are close together for A,B,C but D is far.
    const A = [1, 0.1, 0, 0];
    const B = [0.95, 0.3, 0.05, 0];
    const C = [0.9, 0.2, 0.1, 0];
    const D = [0, 0, 0, 1]; // orthogonal to all
    // Verify mutual sim A-B-C > 0.6
    expect(cosineSimilarity(A, B)).toBeGreaterThan(0.6);
    expect(cosineSimilarity(A, C)).toBeGreaterThan(0.6);
    expect(cosineSimilarity(B, C)).toBeGreaterThan(0.6);
    // D is far from all
    expect(cosineSimilarity(A, D)).toBeLessThan(0.6);
    expect(cosineSimilarity(B, D)).toBeLessThan(0.6);
    expect(cosineSimilarity(C, D)).toBeLessThan(0.6);

    const result = findMaxClique(
      [
        candidate(A, 0.9, 0),
        candidate(B, 0.85, 1),
        candidate(C, 0.8, 2),
        candidate(D, 0.95, 3),
      ],
      FACE_THRESH,
      2,
    );
    expect(result).not.toBeNull();
    expect(result!.length).toBe(3);
    const indices = result!.map((c) => c.index).sort();
    expect(indices).toEqual([0, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// Body threshold = 0.8
// ---------------------------------------------------------------------------
describe("findMaxClique — body (threshold 0.8)", () => {
  const BODY_THRESH = 0.8;

  // 5. Three bodies all consistent (all pair sim > 0.8, minSize=3) → clique size 3
  it("returns 3-clique when all bodies are consistent", () => {
    // Vectors very close in direction — high cosine similarity.
    const A = [1, 0.1, 0, 0];
    const B = [1, 0.12, 0.01, 0];
    const C = [1, 0.09, 0.02, 0];
    expect(cosineSimilarity(A, B)).toBeGreaterThan(0.8);
    expect(cosineSimilarity(A, C)).toBeGreaterThan(0.8);
    expect(cosineSimilarity(B, C)).toBeGreaterThan(0.8);

    const result = findMaxClique(
      [candidate(A, 0.9, 0), candidate(B, 0.85, 1), candidate(C, 0.8, 2)],
      BODY_THRESH,
      3,
    );
    expect(result).not.toBeNull();
    expect(result!.length).toBe(3);
  });

  // 6. Three bodies bridge: A-B=0.81, B-C=0.81, A-C=0.40 → max clique size 2 < minSize 3 → null
  it("returns null for bridge topology below minSize", () => {
    // Construct vectors where A-B ≈ 0.81, B-C ≈ 0.81, A-C ≈ 0.40
    // A = [1, 0, 0], B = [0.81, 0.586, 0], C = [0.4, 0.917, 0]
    // Let's compute more carefully:
    // Use unit vectors with specific angles.
    // cos(θ) = 0.81 → θ ≈ 35.9°, cos(2θ) ≈ 0.31
    // A at angle 0, B at angle 35.9°, C at angle 71.8°
    // sim(A,C) = cos(71.8°) ≈ 0.31 < 0.8 ✓
    const angleAB = Math.acos(0.81);
    const A = [1, 0];
    const B = [Math.cos(angleAB), Math.sin(angleAB)];
    const C = [Math.cos(2 * angleAB), Math.sin(2 * angleAB)];

    expect(cosineSimilarity(A, B)).toBeCloseTo(0.81, 1);
    expect(cosineSimilarity(B, C)).toBeCloseTo(0.81, 1);
    expect(cosineSimilarity(A, C)).toBeLessThan(0.8);

    const result = findMaxClique(
      [candidate(A, 0.9, 0), candidate(B, 0.85, 1), candidate(C, 0.8, 2)],
      BODY_THRESH,
      3,
    );
    expect(result).toBeNull();
  });

  // 7. Three bodies two-true-one-fake: A-B=0.88, A-C=0.7, B-C≈0.62, minSize=3 → null
  it("returns null when three bodies do not all pass threshold", () => {
    // A-B high (0.88), but A-C (0.7) and B-C (≈0.62) both below 0.8.
    // Place B in xy-plane, C in xz-plane so B-C diverges more.
    const A = [1, 0, 0];
    const B = [0.88, 0.4750, 0]; // sim(A,B) ≈ 0.88
    const C = [0.7, 0, 0.7141]; // sim(A,C) ≈ 0.70, sim(B,C) ≈ 0.62

    expect(cosineSimilarity(A, B)).toBeCloseTo(0.88, 1);
    expect(cosineSimilarity(A, C)).toBeCloseTo(0.7, 1);
    expect(cosineSimilarity(B, C)).toBeLessThan(0.8);

    const result = findMaxClique(
      [candidate(A, 0.9, 0), candidate(B, 0.85, 1), candidate(C, 0.8, 2)],
      BODY_THRESH,
      3,
    );
    expect(result).toBeNull();
  });

  // 8. Three bodies similar clothes different people: all pair sim ≈ 0.75 < 0.8 → null
  it("returns null when all body similarities are below threshold", () => {
    // Three unit vectors in 3D, each pair with cosine similarity exactly 0.75.
    // A in x-axis, B in xy-plane, C in xyz space.
    const A = [1, 0, 0];
    const B = [0.75, 0.6614, 0]; // sim(A,B) = 0.75
    const C = [0.75, 0.2835, 0.5976]; // sim(A,C) ≈ 0.75, sim(B,C) ≈ 0.75

    expect(cosineSimilarity(A, B)).toBeCloseTo(0.75, 1);
    expect(cosineSimilarity(A, C)).toBeCloseTo(0.75, 1);
    expect(cosineSimilarity(B, C)).toBeCloseTo(0.75, 1);
    // All below 0.8
    expect(cosineSimilarity(A, B)).toBeLessThan(0.8);
    expect(cosineSimilarity(A, C)).toBeLessThan(0.8);
    expect(cosineSimilarity(B, C)).toBeLessThan(0.8);

    const result = findMaxClique(
      [candidate(A, 0.9, 0), candidate(B, 0.85, 1), candidate(C, 0.8, 2)],
      BODY_THRESH,
      3,
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 9. Tie-break test
// ---------------------------------------------------------------------------
describe("findMaxClique — tie-break", () => {
  it("prefers the 2-clique with higher min pairwise similarity", () => {
    // 3D vectors:
    // A = [1, 0, 0]
    // B2 = [0.7, 0.71, 0] → sim(A, B2) ≈ 0.7
    // C2 = [0.9, -0.1, 0.43] → sim(A, C2) ≈ 0.9, sim(B2, C2) ≈ 0.56 < 0.6
    const A = [1, 0, 0];
    const B2 = [0.7, 0.71, 0];
    const C2 = [0.9, -0.1, 0.43];

    const simAB = cosineSimilarity(A, B2);
    const simAC = cosineSimilarity(A, C2);
    const simBC = cosineSimilarity(B2, C2);

    // Verify preconditions
    expect(simAB).toBeGreaterThan(0.6); // A-B2 is an edge
    expect(simAC).toBeGreaterThan(0.6); // A-C2 is an edge
    expect(simBC).toBeLessThan(0.6); // B2-C2 is NOT an edge

    // Both {A, B2} and {A, C2} are valid 2-cliques.
    // {A, C2} has min_sim ≈ 0.9 > {A, B2} min_sim ≈ 0.7
    // → should prefer {A, C2}
    const result = findMaxClique(
      [
        candidate(A, 0.9, 0),
        candidate(B2, 0.85, 1),
        candidate(C2, 0.8, 2),
      ],
      0.6,
      2,
    );
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2);
    const indices = result!.map((c) => c.index).sort();
    expect(indices).toEqual([0, 2]); // {A, C2}
  });
});

// ---------------------------------------------------------------------------
// 10–11. Edge cases
// ---------------------------------------------------------------------------
describe("findMaxClique — edge cases", () => {
  it("returns null for empty input", () => {
    expect(findMaxClique([], 0.6, 2)).toBeNull();
  });

  it("returns null for single element below minSize", () => {
    const result = findMaxClique(
      [candidate([1, 0, 0], 0.9, 0)],
      0.6,
      2,
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Additional: result ordering (quality descending)
// ---------------------------------------------------------------------------
describe("findMaxClique — result ordering", () => {
  it("returns clique members sorted by quality descending", () => {
    const A = [1, 0.1, 0];
    const B = [1, 0.12, 0.01];
    const C = [1, 0.09, 0.02];
    // All very similar → form a 3-clique

    const result = findMaxClique(
      [
        candidate(A, 0.7, 0),
        candidate(B, 0.95, 1),
        candidate(C, 0.85, 2),
      ],
      0.6,
      2,
    );
    expect(result).not.toBeNull();
    expect(result!.length).toBe(3);
    // quality order: 0.95, 0.85, 0.7
    expect(result![0]!.quality).toBe(0.95);
    expect(result![1]!.quality).toBe(0.85);
    expect(result![2]!.quality).toBe(0.7);
  });
});
