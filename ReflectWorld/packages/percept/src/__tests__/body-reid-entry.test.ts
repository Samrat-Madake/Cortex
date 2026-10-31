import { describe, it, expect, vi } from "vitest";
import { runPerBodyReId } from "../analyzers/body-reid-entry.js";

function makeMockPoseProvider(shouldExtract: boolean) {
  return {
    estimatePose: vi.fn().mockResolvedValue({
      keypoints: Array.from({ length: 17 }, (_, i) => ({
        x: 0, y: 0,
        confidence: shouldExtract ? 0.9 : 0.1,
        name: `kp${i}`,
      })),
    }),
  };
}

function makeMockBodyReidProvider(embedding: number[]) {
  return {
    extractEmbedding: vi.fn().mockResolvedValue({
      embedding,
      embedding_dim: embedding.length,
    }),
  };
}

function makeMockMemory(matchEntityId?: string) {
  return {
    reidSearch: vi.fn().mockResolvedValue(
      matchEntityId
        ? [{ entity_id: matchEntityId, score: 0.96, type: "body" as const }]
        : [],
    ),
  };
}

describe("runPerBodyReId", () => {
  const dummyFrame = { data: "", width: 640, height: 480, timestamp: 0 };
  const dummyBbox = { x: 10, y: 10, width: 200, height: 400 };

  it("skips when pose shows incomplete body", async () => {
    const results = await runPerBodyReId(
      [{ frameIndex: 0, personBbox: dummyBbox, personConfidence: 0.9 }],
      [dummyFrame] as any,
      makeMockPoseProvider(false) as any,
      makeMockBodyReidProvider([0.1]) as any,
      makeMockMemory() as any,
    );
    expect(results[0]!.skipped).toBe(true);
    expect(results[0]!.skipReason).toBe("incomplete_body");
  });

  it("extracts embedding and returns body match (query-only, no writes)", async () => {
    const memory = makeMockMemory("existing-entity");
    const results = await runPerBodyReId(
      [{ frameIndex: 0, personBbox: dummyBbox, personConfidence: 0.9 }],
      [dummyFrame] as any,
      makeMockPoseProvider(true) as any,
      makeMockBodyReidProvider(Array(768).fill(0.1)) as any,
      memory as any,
    );
    expect(results[0]!.skipped).toBe(false);
    expect(results[0]!.bodyEntityId).toBe("existing-entity");
    expect(results[0]!.bodyEmbedding).toBeDefined();
    expect(memory.reidSearch).toHaveBeenCalledTimes(1);
  });

  it("returns no entity_id when no body match found (does NOT upsert)", async () => {
    const memory = makeMockMemory(undefined);
    const results = await runPerBodyReId(
      [{ frameIndex: 0, personBbox: dummyBbox, personConfidence: 0.9 }],
      [dummyFrame] as any,
      makeMockPoseProvider(true) as any,
      makeMockBodyReidProvider(Array(768).fill(0.1)) as any,
      memory as any,
    );
    expect(results[0]!.skipped).toBe(false);
    expect(results[0]!.bodyEntityId).toBeUndefined();
    expect(results[0]!.bodyEmbedding).toBeDefined();
  });

  it("proceeds without pose check when pose provider unavailable (fail-open)", async () => {
    const memory = makeMockMemory("match");
    const results = await runPerBodyReId(
      [{ frameIndex: 0, personBbox: dummyBbox, personConfidence: 0.9 }],
      [dummyFrame] as any,
      undefined,
      makeMockBodyReidProvider(Array(768).fill(0.1)) as any,
      memory as any,
    );
    expect(results[0]!.skipped).toBe(false);
    expect(results[0]!.bodyEntityId).toBe("match");
  });

  it("includes personConfidence in bodyQuality", async () => {
    const results = await runPerBodyReId(
      [{ frameIndex: 0, personBbox: { x: 0, y: 0, width: 100, height: 200 }, personConfidence: 0.8 }],
      [dummyFrame] as any,
      makeMockPoseProvider(true) as any,
      makeMockBodyReidProvider(Array(768).fill(0.1)) as any,
      makeMockMemory() as any,
    );
    expect(results[0]!.bodyQuality).toBe(16000);
  });
});
