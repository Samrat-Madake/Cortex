// packages/percept/src/analyzers/clique.ts
// Exact max-clique search for multi-frame ReID consistency verification.
// N ≤ 8, so exhaustive enumeration is feasible (C(8,k) max = 70).

/**
 * Cosine similarity between two vectors.
 * Returns 0 if either vector has zero magnitude.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

export interface CliqueCandidate {
  embedding: number[];
  quality: number;
  /** Stable frame order in pool. */
  index: number;
}

/**
 * Find the largest clique (fully-connected subset) among candidates
 * where every pair has cosine similarity >= threshold.
 *
 * Exhaustive search: enumerates combinations from largest k down to minSize,
 * stops at the first k that has a valid clique.
 *
 * Tie-break for same-size cliques (deterministic):
 *   1. Highest min pairwise similarity (desc)
 *   2. Highest avg quality (desc)
 *   3. Lowest sum of indices (asc, stable index order)
 *
 * Returns clique members sorted by quality descending, or null if no clique >= minSize.
 */
export function findMaxClique(
  candidates: CliqueCandidate[],
  threshold: number,
  minSize: number,
): CliqueCandidate[] | null {
  const n = candidates.length;
  if (n < minSize) return null;

  // Pre-compute pairwise similarity matrix (upper triangle).
  const sim: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    sim[i]![i] = 1.0;
    for (let j = i + 1; j < n; j++) {
      const s = cosineSimilarity(candidates[i]!.embedding, candidates[j]!.embedding);
      sim[i]![j] = s;
      sim[j]![i] = s;
    }
  }

  // Pre-compute adjacency: edge exists iff sim >= threshold.
  const adj: boolean[][] = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (sim[i]![j]! >= threshold) {
        adj[i]![j] = true;
        adj[j]![i] = true;
      }
    }
  }

  // Enumerate from largest k down to minSize.
  for (let k = n; k >= minSize; k--) {
    const best = findBestCliqueOfSize(candidates, sim, adj, n, k);
    if (best !== null) {
      // Return sorted by quality descending.
      return best.sort((a, b) => b.quality - a.quality);
    }
  }

  return null;
}

/**
 * Find the best clique of exactly size k, or null if none exists.
 * "Best" is determined by the tie-break rules.
 */
function findBestCliqueOfSize(
  candidates: CliqueCandidate[],
  sim: number[][],
  adj: boolean[][],
  n: number,
  k: number,
): CliqueCandidate[] | null {
  let bestIndices: number[] | null = null;
  let bestMinSim = -Infinity;
  let bestAvgQuality = -Infinity;
  let bestIndexSum = Infinity;

  // Generate all C(n, k) combinations and check each.
  const combo = new Array<number>(k);
  enumerate(0, 0);
  if (bestIndices === null) return null;
  const chosen: number[] = bestIndices;
  return chosen.map((i) => candidates[i]!);

  function enumerate(start: number, depth: number): void {
    if (depth === k) {
      // Check if this combination is a clique.
      if (!isClique(combo, adj, k)) return;

      // Compute tie-break metrics.
      let minSim = Infinity;
      for (let i = 0; i < k; i++) {
        for (let j = i + 1; j < k; j++) {
          const s = sim[combo[i]!]![combo[j]!]!;
          if (s < minSim) minSim = s;
        }
      }

      let sumQuality = 0;
      let sumIndex = 0;
      for (let i = 0; i < k; i++) {
        sumQuality += candidates[combo[i]!]!.quality;
        sumIndex += combo[i]!;
      }
      const avgQuality = sumQuality / k;

      // Compare with current best using tie-break rules.
      if (isBetter(minSim, avgQuality, sumIndex)) {
        bestMinSim = minSim;
        bestAvgQuality = avgQuality;
        bestIndexSum = sumIndex;
        bestIndices = combo.slice();
      }
      return;
    }

    for (let i = start; i < n; i++) {
      combo[depth] = i;
      // Prune: check that this new vertex is adjacent to all previously chosen.
      let valid = true;
      for (let d = 0; d < depth; d++) {
        if (!adj[combo[d]!]![i]!) {
          valid = false;
          break;
        }
      }
      if (valid) {
        enumerate(i + 1, depth + 1);
      }
    }
  }

  function isBetter(
    minSim: number,
    avgQuality: number,
    indexSum: number,
  ): boolean {
    if (bestIndices === null) return true;
    // 1. Higher min_pairwise_sim wins.
    if (minSim > bestMinSim + 1e-12) return true;
    if (minSim < bestMinSim - 1e-12) return false;
    // 2. Higher avg_quality wins.
    if (avgQuality > bestAvgQuality + 1e-12) return true;
    if (avgQuality < bestAvgQuality - 1e-12) return false;
    // 3. Lower sum of indices wins (stable order).
    return indexSum < bestIndexSum;
  }
}

/** Check if the given indices form a clique (all pairs connected). */
function isClique(indices: number[], adj: boolean[][], k: number): boolean {
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      if (!adj[indices[i]!]![indices[j]!]!) return false;
    }
  }
  return true;
}
