// packages/percept/src/__tests__/yolo26-provider.test.ts
import { describe, it, expect, vi } from "vitest";
import { Yolo26BuiltinProvider } from "../providers/builtin/yolo26-provider.js";
import type { ModelManager } from "../models/model-manager.js";

function makeMockModelManager(installed = true): ModelManager {
  return {
    isInstalled: () => installed,
    ensureLoaded: vi.fn().mockResolvedValue(undefined),
    engine: { run: vi.fn() },
    hasCapability: () => installed,
  } as unknown as ModelManager;
}

describe("Yolo26BuiltinProvider", () => {
  it("should have type 'detector' and runtime 'onnx-builtin'", () => {
    const provider = new Yolo26BuiltinProvider(makeMockModelManager());
    expect(provider.type).toBe("detector");
    expect(provider.runtime).toBe("onnx-builtin");
    expect(provider.name).toBe("yolo26m-builtin");
  });

  it("should be not-ready before initialize", () => {
    const provider = new Yolo26BuiltinProvider(makeMockModelManager());
    expect(provider.isReady()).toBe(false);
  });

  it("should be ready after initialize when model is installed", async () => {
    const provider = new Yolo26BuiltinProvider(makeMockModelManager(true));
    await provider.initialize();
    expect(provider.isReady()).toBe(true);
  });

  it("should stay not-ready after initialize when model is not installed", async () => {
    const provider = new Yolo26BuiltinProvider(makeMockModelManager(false));
    await provider.initialize();
    expect(provider.isReady()).toBe(false);
  });

  it("should become not-ready after dispose", async () => {
    const provider = new Yolo26BuiltinProvider(makeMockModelManager(true));
    await provider.initialize();
    expect(provider.isReady()).toBe(true);
    await provider.dispose();
    expect(provider.isReady()).toBe(false);
  });
});
