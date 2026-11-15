// packages/percept/src/__tests__/model-manager.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ModelManager } from "../models/model-manager.js";
import * as fs from "node:fs";
import * as path from "node:path";
import os from "node:os";

describe("ModelManager", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-models-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should report no capabilities when models dir is empty", () => {
    const mgr = new ModelManager(tmpDir);
    expect(mgr.getAvailableCapabilities()).toEqual([]);
    expect(mgr.getMaxLevel()).toBe(0);
  });

  it("should detect installed model files", () => {
    fs.writeFileSync(path.join(tmpDir, "yolo26m.onnx"), "fake");
    fs.writeFileSync(path.join(tmpDir, "retinaface-resnet50.onnx"), "fake");
    fs.writeFileSync(path.join(tmpDir, "w600k_mbf.onnx"), "fake");

    const mgr = new ModelManager(tmpDir);
    const caps = mgr.getAvailableCapabilities();
    expect(caps).toContain("general-detection");
    expect(caps).toContain("face-detection");
    expect(caps).toContain("face-reid");
    expect(caps).not.toContain("body-reid");
  });

  it("should compute max level based on installed models", () => {
    // Current local model tier is L1.
    fs.writeFileSync(path.join(tmpDir, "yolo26m.onnx"), "fake");
    fs.writeFileSync(path.join(tmpDir, "retinaface-resnet50.onnx"), "fake");
    fs.writeFileSync(path.join(tmpDir, "w600k_mbf.onnx"), "fake");

    const mgr = new ModelManager(tmpDir);
    expect(mgr.getMaxLevel()).toBe(1);
  });

  it("should return level 1 with L1 models", () => {
    fs.writeFileSync(path.join(tmpDir, "yolo26m.onnx"), "fake");
    fs.writeFileSync(path.join(tmpDir, "retinaface-resnet50.onnx"), "fake");
    fs.writeFileSync(path.join(tmpDir, "w600k_mbf.onnx"), "fake");

    const mgr = new ModelManager(tmpDir);
    expect(mgr.getMaxLevel()).toBe(1);
  });

  it("should detect body-reid as optional capability when clip-reid installed", () => {
    fs.writeFileSync(path.join(tmpDir, "clip-reid-vitb.onnx"), "fake");
    const mgr = new ModelManager(tmpDir);
    expect(mgr.hasCapability("body-reid")).toBe(true);
    expect(mgr.getMaxLevel()).toBe(0); // body-reid alone doesn't unlock any level
  });

  it("hasCapability should return correct booleans", () => {
    fs.writeFileSync(path.join(tmpDir, "yolo26m.onnx"), "fake");
    const mgr = new ModelManager(tmpDir);
    expect(mgr.hasCapability("general-detection")).toBe(true);
    expect(mgr.hasCapability("face-detection")).toBe(false);
  });

  it("getModelPath should return path for installed model", () => {
    fs.writeFileSync(path.join(tmpDir, "yolo26m.onnx"), "fake");
    const mgr = new ModelManager(tmpDir);
    expect(mgr.getModelPath("yolo26m")).toBe(path.join(tmpDir, "yolo26m.onnx"));
  });

  it("getModelPath should return undefined for missing model", () => {
    const mgr = new ModelManager(tmpDir);
    expect(mgr.getModelPath("yolo26m")).toBeUndefined();
  });

  it("rescan should pick up newly installed models", () => {
    const mgr = new ModelManager(tmpDir);
    expect(mgr.isInstalled("yolo26m")).toBe(false);

    fs.writeFileSync(path.join(tmpDir, "yolo26m.onnx"), "fake");
    mgr.rescan();
    expect(mgr.isInstalled("yolo26m")).toBe(true);
  });

  it("ensureLoaded should throw for uninstalled model", async () => {
    const mgr = new ModelManager(tmpDir);
    await expect(mgr.ensureLoaded("yolo26m")).rejects.toThrow(/not installed/i);
  });

  it("dispose should be safe when no models loaded", async () => {
    const mgr = new ModelManager(tmpDir);
    await mgr.dispose();
  });
});
