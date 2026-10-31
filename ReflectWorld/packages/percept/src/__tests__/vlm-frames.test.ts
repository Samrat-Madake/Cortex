import { describe, expect, it } from "vitest";
import { DetectionRegistry } from "../did-registry.js";
import { resolveVlmSelectableDIds } from "../pipeline/vlm-frames.js";

describe("resolveVlmSelectableDIds", () => {
  it("keeps close-up person detections selectable for VLM grounding", () => {
    const registry = new DetectionRegistry();
    registry.addFrame(0, [
      {
        class_name: "person",
        confidence: 0.95,
        bbox: { x: 0, y: 40, width: 950, height: 550 },
      },
      {
        class_name: "person",
        confidence: 0.9,
        bbox: { x: 1060, y: 100, width: 100, height: 180 },
      },
    ]);

    const selection = resolveVlmSelectableDIds({
      registry,
      frameDimensions: new Map([[0, { width: 1280, height: 720 }]]),
    });

    expect(selection.rejected).toEqual([]);
    expect([...selection.selectableDidIds]).toEqual(["D0", "D1"]);
  });
});
