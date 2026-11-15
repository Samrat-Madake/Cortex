// packages/percept/src/__tests__/retinaface-provider.test.ts
import { describe, it, expect, vi } from "vitest";
import { RetinaFaceBuiltinProvider } from "../providers/builtin/retinaface-provider.js";
import type { ModelManager } from "../models/model-manager.js";

function makeMockModelManager(installed = true): ModelManager {
  return {
    isInstalled: () => installed,
    ensureLoaded: vi.fn().mockResolvedValue(undefined),
    engine: { run: vi.fn() },
    hasCapability: () => installed,
  } as unknown as ModelManager;
}

describe("RetinaFaceBuiltinProvider", () => {
  it("should have type 'detector' and name 'retinaface-builtin'", () => {
    const provider = new RetinaFaceBuiltinProvider(makeMockModelManager());
    expect(provider.type).toBe("detector");
    expect(provider.runtime).toBe("onnx-builtin");
    expect(provider.name).toBe("retinaface-builtin");
  });

  it("should be ready after initialize when model is installed", async () => {
    const provider = new RetinaFaceBuiltinProvider(makeMockModelManager(true));
    await provider.initialize();
    expect(provider.isReady()).toBe(true);
  });

  it("should stay not-ready when model is not installed", async () => {
    const provider = new RetinaFaceBuiltinProvider(makeMockModelManager(false));
    await provider.initialize();
    expect(provider.isReady()).toBe(false);
  });
});
