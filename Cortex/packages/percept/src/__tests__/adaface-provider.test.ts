// packages/percept/src/__tests__/adaface-provider.test.ts
import { describe, it, expect, vi } from "vitest";
import { AdaFaceBuiltinProvider } from "../providers/builtin/adaface-provider.js";
import type { ModelManager } from "../models/model-manager.js";

function makeMockModelManager(installed = true): ModelManager {
  return {
    isInstalled: () => installed,
    ensureLoaded: vi.fn().mockResolvedValue(undefined),
    engine: { run: vi.fn() },
    hasCapability: () => installed,
  } as unknown as ModelManager;
}

describe("AdaFaceBuiltinProvider", () => {
  it("should have type 'reid' and name 'adaface-builtin'", () => {
    const provider = new AdaFaceBuiltinProvider(makeMockModelManager());
    expect(provider.type).toBe("reid");
    expect(provider.runtime).toBe("onnx-builtin");
    expect(provider.name).toBe("adaface-builtin");
  });

  it("should be ready after initialize when model is installed", async () => {
    const provider = new AdaFaceBuiltinProvider(makeMockModelManager(true));
    await provider.initialize();
    expect(provider.isReady()).toBe(true);
  });

  it("should stay not-ready when model is not installed", async () => {
    const provider = new AdaFaceBuiltinProvider(makeMockModelManager(false));
    await provider.initialize();
    expect(provider.isReady()).toBe(false);
  });

  it("should throw when extractEmbedding called without bbox", async () => {
    const provider = new AdaFaceBuiltinProvider(makeMockModelManager(true));
    await provider.initialize();
    await expect(
      provider.extractEmbedding({ imageBuffer: Buffer.from("test") }),
    ).rejects.toThrow("options.bbox");
  });
});
