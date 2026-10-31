// packages/percept/src/__tests__/model-router.test.ts
import { describe, it, expect, vi } from "vitest";
import { ModelRouter } from "../providers/model-router.js";
import type { DetectorProvider, ReidProvider, InferInput } from "../providers/types.js";

function makeMockDetector(name: string, ready = true): DetectorProvider {
  return {
    name,
    type: "detector" as const,
    runtime: "onnx-builtin" as const,
    initialize: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    isReady: () => ready,
    detect: vi.fn().mockResolvedValue({ boxes: [] }),
  };
}

function makeMockReid(name: string, ready = true): ReidProvider {
  return {
    name,
    type: "reid" as const,
    runtime: "onnx-builtin" as const,
    initialize: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    isReady: () => ready,
    extractEmbedding: vi.fn().mockResolvedValue({ embedding: [], embedding_dim: 512 }),
  };
}

describe("ModelRouter", () => {
  it("should register and resolve a detector provider", () => {
    const router = new ModelRouter();
    const det = makeMockDetector("yolo26m-builtin");
    router.register(det);
    router.setRouting("general-detection", ["yolo26m-builtin"]);

    const resolved = router.getDetector("general-detection");
    expect(resolved).toBe(det);
  });

  it("should fall back to second provider when first is not ready", () => {
    const router = new ModelRouter();
    const primary = makeMockDetector("rfdetr-python", false);
    const fallback = makeMockDetector("yolo26m-builtin", true);
    router.register(primary);
    router.register(fallback);
    router.setRouting("general-detection", ["rfdetr-python", "yolo26m-builtin"]);

    const resolved = router.getDetector("general-detection");
    expect(resolved).toBe(fallback);
  });

  it("should return undefined when no provider is ready", () => {
    const router = new ModelRouter();
    router.setRouting("general-detection", ["nonexistent"]);
    const resolved = router.getDetector("general-detection");
    expect(resolved).toBeUndefined();
  });

  it("should resolve reid providers", () => {
    const router = new ModelRouter();
    const reid = makeMockReid("adaface-builtin");
    router.register(reid);
    router.setRouting("face-reid", ["adaface-builtin"]);

    const resolved = router.getReidProvider("face-reid");
    expect(resolved).toBe(reid);
  });

  it("should report available capabilities", () => {
    const router = new ModelRouter();
    router.register(makeMockDetector("yolo26m-builtin"));
    router.register(makeMockReid("adaface-builtin"));
    router.setRouting("general-detection", ["yolo26m-builtin"]);
    router.setRouting("face-reid", ["adaface-builtin"]);

    const caps = router.getAvailableCapabilities();
    expect(caps).toContain("general-detection");
    expect(caps).toContain("face-reid");
    expect(caps).not.toContain("body-reid");
  });

  it("should initialize all registered providers", async () => {
    const router = new ModelRouter();
    const det = makeMockDetector("yolo26m-builtin");
    const reid = makeMockReid("adaface-builtin");
    router.register(det);
    router.register(reid);

    await router.initializeAll();
    expect(det.initialize).toHaveBeenCalled();
    expect(reid.initialize).toHaveBeenCalled();
  });

  it("should dispose all registered providers", async () => {
    const router = new ModelRouter();
    const det = makeMockDetector("yolo26m-builtin");
    router.register(det);

    await router.disposeAll();
    expect(det.dispose).toHaveBeenCalled();
  });

  it("should compute max level from available capabilities", () => {
    const router = new ModelRouter();
    expect(router.getMaxLevel()).toBe(0);

    // Add L1 capabilities
    router.register(makeMockDetector("det"));
    router.register(makeMockDetector("face-det"));
    router.register(makeMockReid("face-reid"));
    router.setRouting("general-detection", ["det"]);
    router.setRouting("face-detection", ["face-det"]);
    router.setRouting("face-reid", ["face-reid"]);
    // L1 models unlock the current local model tier.
    expect(router.getMaxLevel()).toBe(1);

    // body-reid is optional — doesn't change level
    router.register(makeMockReid("body-reid-provider"));
    router.setRouting("body-reid", ["body-reid-provider"]);
    expect(router.getMaxLevel()).toBe(1);
  });

  it("hasCapability should return correct booleans", () => {
    const router = new ModelRouter();
    router.register(makeMockDetector("det"));
    router.setRouting("general-detection", ["det"]);
    expect(router.hasCapability("general-detection")).toBe(true);
    expect(router.hasCapability("face-reid")).toBe(false);
  });

  it("getProviderByName should return registered provider", () => {
    const router = new ModelRouter();
    const det = makeMockDetector("my-det");
    router.register(det);
    expect(router.getProviderByName("my-det")).toBe(det);
    expect(router.getProviderByName("nonexistent")).toBeUndefined();
  });

  it("getRegisteredNames should return all names", () => {
    const router = new ModelRouter();
    router.register(makeMockDetector("a"));
    router.register(makeMockReid("b"));
    expect(router.getRegisteredNames()).toEqual(["a", "b"]);
  });
});
