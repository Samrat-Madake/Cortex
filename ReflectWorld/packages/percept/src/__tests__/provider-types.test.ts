// packages/percept/src/__tests__/provider-types.test.ts
import { describe, it, expect } from "vitest";
import type {
  DetectorProvider, ReidProvider, InferInput,
} from "../providers/types.js";

describe("Provider types", () => {
  it("DetectorProvider should have detect method", () => {
    const mockDetector: DetectorProvider = {
      name: "test-detector",
      type: "detector" as const,
      runtime: "onnx-builtin" as const,
      initialize: async () => {},
      dispose: async () => {},
      isReady: () => true,
      detect: async (_input: InferInput) => ({
        boxes: [{ x1: 0, y1: 0, x2: 100, y2: 100, confidence: 0.9, class_id: 0, class_name: "person" }],
      }),
    };
    expect(mockDetector.type).toBe("detector");
    expect(mockDetector.name).toBe("test-detector");
  });

  it("ReidProvider should have extractEmbedding method", () => {
    const mockReid: ReidProvider = {
      name: "test-reid",
      type: "reid" as const,
      runtime: "onnx-builtin" as const,
      initialize: async () => {},
      dispose: async () => {},
      isReady: () => true,
      extractEmbedding: async (_input: InferInput) => ({
        embedding: new Array(512).fill(0),
        embedding_dim: 512,
      }),
    };
    expect(mockReid.type).toBe("reid");
  });

  it("InferInput should carry image buffer, dimensions optional", () => {
    const input: InferInput = { imageBuffer: Buffer.from("test") };
    expect(input.width).toBeUndefined();
    const inputWithDims: InferInput = { imageBuffer: Buffer.from("test"), width: 640, height: 480 };
    expect(inputWithDims.width).toBe(640);
  });
});
