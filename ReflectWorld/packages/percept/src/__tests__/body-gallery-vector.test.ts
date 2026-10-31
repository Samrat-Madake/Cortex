import { describe, expect, it, vi } from "vitest";
import { selectVerifiedBodyGalleryVector } from "../pipeline.js";
import type { DIdEntry } from "../types.js";
import type { ParsedSubjectProposalTarget } from "../vlm-output-parser.js";

function entry(did: string, body: DIdEntry["body"]): DIdEntry {
  return {
    did,
    frame_idx: 0,
    bbox: { x: 0, y: 0, w: 10, h: 20 },
    class_name: "person",
    confidence: 0.9,
    body,
  };
}

function target(overrides: Partial<ParsedSubjectProposalTarget> = {}): ParsedSubjectProposalTarget {
  return {
    type: "person",
    bbox_ids: ["D0"],
    matched_wm_target: null,
    appearance: "person",
    entity_id: "entity_1",
    entity_id_source: "current_reid",
    gallery_candidates: [],
    ...overrides,
  };
}

describe("selectVerifiedBodyGalleryVector", () => {
  it("uses confirmed body match and preserves diversity metadata", async () => {
    const registry = new Map([
      ["D0", entry("D0", {
        embedding: [0.1, 0.2],
        entity_id: "entity_1",
        quality: 0.82,
        body_yaw_ratio: 0.72,
        visibility: "full",
      })],
    ]);
    const reidSearch = vi.fn();

    const selected = await selectVerifiedBodyGalleryVector(target(), registry, { reidSearch });

    expect(selected).toEqual({
      vector: [0.1, 0.2],
      quality: 0.82,
      body_yaw_ratio: 0.72,
      visibility: "full",
    });
    expect(reidSearch).not.toHaveBeenCalled();
  });

  it("does not use unmatched body for an existing entity without body-search verification", async () => {
    const registry = new Map([
      ["D0", entry("D0", {
        embedding: [0.3, 0.4],
        quality: 0.91,
        body_yaw_ratio: 0.2,
        visibility: "upper",
      })],
    ]);

    const selected = await selectVerifiedBodyGalleryVector(target(), registry, {});

    expect(selected).toBeUndefined();
  });

  it("uses unmatched body only when body search verifies the same entity above threshold", async () => {
    const registry = new Map([
      ["D0", entry("D0", {
        embedding: [0.5, 0.6],
        quality: 0.77,
        visibility: "partial",
      })],
    ]);
    const reidSearch = vi.fn().mockResolvedValue([{ entity_id: "entity_1", score: 0.96 }]);

    const selected = await selectVerifiedBodyGalleryVector(target(), registry, { reidSearch });

    expect(reidSearch).toHaveBeenCalledWith([0.5, 0.6], "body");
    expect(selected).toMatchObject({
      vector: [0.5, 0.6],
      quality: 0.77,
      visibility: "partial",
    });
  });

  it("rejects unmatched body when body search points to another entity", async () => {
    const registry = new Map([
      ["D0", entry("D0", {
        embedding: [0.7, 0.8],
        quality: 0.88,
      })],
    ]);
    const reidSearch = vi.fn().mockResolvedValue([{ entity_id: "entity_2", score: 0.99 }]);

    const selected = await selectVerifiedBodyGalleryVector(target(), registry, { reidSearch });

    expect(selected).toBeUndefined();
  });
});
