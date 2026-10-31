// packages/percept/src/__tests__/clip-reid-provider.test.ts
import { describe, it, expect, vi } from "vitest";
import { ClipReidBuiltinProvider } from "../providers/builtin/clip-reid-provider.js";
import type { ModelManager } from "../models/model-manager.js";

function makeMockModelManager(installed = true): ModelManager {
  return {
    isInstalled: () => installed,
    ensureLoaded: vi.fn().mockResolvedValue(undefined),
    engine: { run: vi.fn() },
    hasCapability: () => installed,
  } as unknown as ModelManager;
}

describe("ClipReidBuiltinProvider", () => {
  it("should have type 'reid' and name 'clip-reid-builtin'", () => {
    const provider = new ClipReidBuiltinProvider(makeMockModelManager());
    expect(provider.type).toBe("reid");
    expect(provider.runtime).toBe("onnx-builtin");
    expect(provider.name).toBe("clip-reid-builtin");
  });

  it("should be ready after initialize when model is installed", async () => {
    const provider = new ClipReidBuiltinProvider(makeMockModelManager(true));
    await provider.initialize();
    expect(provider.isReady()).toBe(true);
  });

  it("should stay not-ready when model is not installed", async () => {
    const provider = new ClipReidBuiltinProvider(makeMockModelManager(false));
    await provider.initialize();
    expect(provider.isReady()).toBe(false);
  });

  it("should throw when extractEmbedding called without bbox", async () => {
    const provider = new ClipReidBuiltinProvider(makeMockModelManager(true));
    await provider.initialize();
    await expect(
      provider.extractEmbedding({ imageBuffer: Buffer.from("test") }),
    ).rejects.toThrow("options.bbox");
  });
});
