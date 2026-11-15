import { describe, it, expect, vi } from "vitest";
import { runPerFaceReId } from "../analyzers/reid-entry.js";
import type { QualifiedFace } from "../analyzers/subject-proposal-analyzer.js";
import type { ModelRouter } from "../providers/model-router.js";
import type { MemoryReIdPort } from "../analyzers/unified-reid-matcher.js";
import type { Frame } from "@cortex/shared";

function makeFace(frameIndex = 0): QualifiedFace {
  return {
    frameIndex,
    personBbox: { x: 0, y: 0, width: 200, height: 400 },
    faceBbox: { x: 50, y: 50, width: 80, height: 100 },
    faceConfidence: 0.95,
    faceAreaRatio: 0.01,
  };
}

function makeFrame(): Frame {
  return { data: Buffer.from("fake-jpeg").toString("base64"), timestamp: 0, index: 0 };
}

function makeRouter(embedding: number[] = [0.1, 0.2, 0.3]): ModelRouter {
  return {
    getReidProvider: () => ({
      extractEmbedding: vi.fn().mockResolvedValue({
        embedding: new Float32Array(embedding),
      }),
    }),
  } as unknown as ModelRouter;
}

describe("runPerFaceReId (query-only)", () => {
  it("returns entity_id when reidSearch finds a match", async () => {
    const memory: MemoryReIdPort = {
      reidSearch: vi.fn().mockResolvedValue([
        { entity_id: "entity_abc", score: 0.85, type: "face" },
      ]),
      reidUpsert: vi.fn(),
    };

    const results = await runPerFaceReId([makeFace()], [makeFrame()], makeRouter(), memory);

    expect(results).toHaveLength(1);
    expect(results[0]!.entity_id).toBe("entity_abc");
    expect(results[0]!.confidence).toBe(0.85);
    // CRITICAL: reidUpsert must NOT be called
    expect(memory.reidUpsert).not.toHaveBeenCalled();
  });

  it("returns undefined entity_id when reidSearch finds no match above threshold", async () => {
    const memory: MemoryReIdPort = {
      reidSearch: vi.fn().mockResolvedValue([
        { entity_id: "entity_abc", score: 0.3, type: "face" }, // below 0.5
      ]),
      reidUpsert: vi.fn(),
    };

    const results = await runPerFaceReId([makeFace()], [makeFrame()], makeRouter(), memory);

    expect(results[0]!.entity_id).toBeUndefined();
    // CRITICAL: no upsert for unmatched faces
    expect(memory.reidUpsert).not.toHaveBeenCalled();
  });

  it("never calls reidUpsert even when no match exists", async () => {
    const memory: MemoryReIdPort = {
      reidSearch: vi.fn().mockResolvedValue([]),
      reidUpsert: vi.fn(),
    };

    const results = await runPerFaceReId([makeFace()], [makeFrame()], makeRouter(), memory);

    expect(results[0]!.entity_id).toBeUndefined();
    expect(memory.reidUpsert).not.toHaveBeenCalled();
  });

  it("never calls reidGalleryUpdate", async () => {
    const memory: MemoryReIdPort = {
      reidSearch: vi.fn().mockResolvedValue([
        { entity_id: "entity_abc", score: 0.9, type: "face" },
      ]),
      reidUpsert: vi.fn(),
      reidGalleryUpdate: vi.fn(),
    };

    await runPerFaceReId([makeFace()], [makeFrame()], makeRouter(), memory);

    expect(memory.reidGalleryUpdate).not.toHaveBeenCalled();
  });

  it("returns embedding and quality even without memory", async () => {
    const results = await runPerFaceReId([makeFace()], [makeFrame()], makeRouter());

    expect(results[0]!.embedding).toBeDefined();
    expect(results[0]!.quality).toBeGreaterThan(0);
    expect(results[0]!.entity_id).toBeUndefined();
  });
});
