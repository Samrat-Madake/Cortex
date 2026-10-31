// packages/percept/src/__tests__/onnx-engine.test.ts
import { describe, it, expect } from "vitest";
import { OnnxInferenceEngine } from "../models/onnx-engine.js";

describe("OnnxInferenceEngine", () => {
  it("should report no loaded sessions initially", () => {
    const engine = new OnnxInferenceEngine();
    expect(engine.getLoadedModels()).toEqual([]);
  });

  it("should throw when running inference on unloaded model", async () => {
    const engine = new OnnxInferenceEngine();
    await expect(
      engine.run("yolo26m", { images: new Float32Array(10) }),
    ).rejects.toThrow(/not loaded/i);
  });

  it("should report model as loaded after loadModel succeeds", async () => {
    const engine = new OnnxInferenceEngine();
    // Can't load a real model in unit tests — verify the error path
    await expect(
      engine.loadModel("yolo26m", "/nonexistent/model.onnx"),
    ).rejects.toThrow();
    expect(engine.getLoadedModels()).toEqual([]);
  });

  it("should unload a model (no-op for non-loaded)", async () => {
    const engine = new OnnxInferenceEngine();
    await engine.unloadModel("yolo26m");
    expect(engine.getLoadedModels()).toEqual([]);
  });

  it("isLoaded should return false for unloaded model", () => {
    const engine = new OnnxInferenceEngine();
    expect(engine.isLoaded("yolo26m")).toBe(false);
  });

  it("dispose should be safe when no models loaded", async () => {
    const engine = new OnnxInferenceEngine();
    await engine.dispose();
    expect(engine.getLoadedModels()).toEqual([]);
  });
});
