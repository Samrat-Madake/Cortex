// packages/percept/src/__tests__/strategy-manager.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { StrategyManager } from "../strategy-manager.js";
import type { ModelRouter } from "../providers/model-router.js";
import type { Segment } from "@cortex/shared";

function makeSegment(mode: Segment["mode"], frameCount: number, cameraId = "cam_test"): Segment {
  const frames = Array.from({ length: frameCount }, (_, i) => ({
    data: `base64_frame_${i}`,
    timestamp: Date.now() + i * 1000,
    index: i,
  }));
  return {
    segment_id: `seg_test`,
    camera_id: cameraId,
    mode,
    frames,
    raw_url: "s3://raw-video/cam_test/seg_test.jpg",
    timestamp: Date.now(),
    duration_sec: frameCount === 1 ? 0 : frameCount,
  };
}

describe("StrategyManager", () => {
  let sm: StrategyManager;

  beforeEach(() => {
    sm = new StrategyManager({ stubsOnly: true });
  });

  it("periodic single-frame → level 0, VLM only, flash-lite model", () => {
    const strategy = sm.selectStrategy(makeSegment("snapshot", 1));
    expect(strategy.level).toBe(0);
    expect(strategy.run_vlm).toBe(true);
    expect(strategy.run_detection).toBe(false);
    expect(strategy.vlm_model).toBe("gpt-5-mini");
  });

  it("event with 3 frames → level 0, VLM only", () => {
    const strategy = sm.selectStrategy(makeSegment("event", 3));
    expect(strategy.level).toBe(0);
    expect(strategy.run_vlm).toBe(true);
    expect(strategy.run_detection).toBe(false);
  });

  it("event with 1 frame → level 0", () => {
    const strategy = sm.selectStrategy(makeSegment("event", 1));
    expect(strategy.level).toBe(0);
  });

  it("stream with 8 frames + stubs_only → level 0 (VLM only, full model)", () => {
    const strategy = sm.selectStrategy(makeSegment("stream", 8));
    expect(strategy.level).toBe(0);
    expect(strategy.run_vlm).toBe(true);
    expect(strategy.run_detection).toBe(false);
    expect(strategy.vlm_model).toBe("gpt-5-mini");
  });

  it("event with 10 frames + stubs_only → level 0 with flash model", () => {
    const strategy = sm.selectStrategy(makeSegment("event", 10));
    expect(strategy.level).toBe(0);
    expect(strategy.run_detection).toBe(false);
    expect(strategy.vlm_model).toBe("gpt-5-mini");
  });

  it("can hot-swap model defaults", () => {
    const smOverride = new StrategyManager();
    smOverride.setVlmModels({ modelLite: "small-vlm", modelFull: "full-vlm" });
    expect(smOverride.selectStrategy(makeSegment("snapshot", 1)).vlm_model).toBe("small-vlm");
    expect(smOverride.selectStrategy(makeSegment("stream", 8)).vlm_model).toBe("full-vlm");
  });

  it("respects custom modelLite and modelFull", () => {
    const smCustom = new StrategyManager({
      modelLite: "gpt-5-mini",
      modelFull: "gemini-2.5-pro",
    });
    // Level 0: uses modelLite
    expect(smCustom.selectStrategy(makeSegment("snapshot", 1)).vlm_model).toBe("gpt-5-mini");
    // Level 0 with many frames: uses modelFull
    expect(smCustom.selectStrategy(makeSegment("stream", 8)).vlm_model).toBe("gemini-2.5-pro");
  });

  it("setStubsOnly(false) enables detection + reid for multi-frame event (level 1)", () => {
    sm.setStubsOnly(false);
    const strategy = sm.selectStrategy(makeSegment("event", 10));
    expect(strategy.level).toBe(1);
    expect(strategy.run_detection).toBe(true);
    expect(strategy.run_reid).toBe(true);
  });

  it("setStubsOnly(false) with few frames → L1 (face clustering works at any frame count)", () => {
    sm.setStubsOnly(false);
    const strategy = sm.selectStrategy(makeSegment("event", 3));
    expect(strategy.level).toBe(1);
    expect(strategy.run_detection).toBe(true);
  });
});

function makeMockRouter(maxLevel: number): ModelRouter {
  return { getMaxLevel: () => maxLevel } as unknown as ModelRouter;
}

describe("StrategyManager with ModelRouter", () => {
  it("should cap at level 0 when no providers ready", () => {
    const sm = new StrategyManager({ modelRouter: makeMockRouter(0) });
    const strategy = sm.selectStrategy(makeSegment("event", 10));
    expect(strategy.level).toBe(0);
    expect(strategy.run_detection).toBe(false);
  });

  it("should enable detection + reid at level 1", () => {
    const sm = new StrategyManager({ modelRouter: makeMockRouter(1) });
    const strategy = sm.selectStrategy(makeSegment("event", 10));
    expect(strategy.level).toBe(1);
    expect(strategy.run_detection).toBe(true);
    expect(strategy.run_reid).toBe(true);
  });

  it("should enable detection + reid at level 1 even with few frames", () => {
    const sm = new StrategyManager({ modelRouter: makeMockRouter(1) });
    const strategy = sm.selectStrategy(makeSegment("event", 3));
    expect(strategy.level).toBe(1);
    expect(strategy.run_detection).toBe(true);
  });

  it("future higher local tier still returns L1 until implemented", () => {
    const sm = new StrategyManager({ modelRouter: makeMockRouter(2) });
    const strategy = sm.selectStrategy(makeSegment("event", 10));
    expect(strategy.level).toBe(1); // Future tiers are not implemented yet.
    expect(strategy.run_detection).toBe(true);
    expect(strategy.run_reid).toBe(true);
  });

  it("should still use level 0 for snapshots regardless of router", () => {
    const sm = new StrategyManager({ modelRouter: makeMockRouter(2) });
    const strategy = sm.selectStrategy(makeSegment("snapshot", 1));
    expect(strategy.level).toBe(0);
    expect(strategy.run_detection).toBe(false);
  });
});

describe("StrategyManager per-camera overrides", () => {
  it("applies per-camera skipVlm override", () => {
    const sm = new StrategyManager({ stubsOnly: true });
    sm.setCameraOverride("cam1", { skipVlm: true });

    const strategy = sm.selectStrategy(makeSegment("snapshot", 1, "cam1"));
    expect(strategy.run_vlm).toBe(false);

    // Other camera unaffected
    const strategy2 = sm.selectStrategy(makeSegment("snapshot", 1, "cam2"));
    expect(strategy2.run_vlm).toBe(true);
  });

  it("applies per-camera maxLevel override", () => {
    const sm = new StrategyManager({ modelRouter: makeMockRouter(1) });
    sm.setCameraOverride("cam1", { maxLevel: 0 });

    const strategy = sm.selectStrategy(makeSegment("event", 5, "cam1"));
    expect(strategy.level).toBe(0);
  });

  it("applies per-camera vlmModel override", () => {
    const sm = new StrategyManager({ stubsOnly: true });
    sm.setCameraOverride("cam1", { vlmModel: "gemini-2.5-pro" });

    const strategy = sm.selectStrategy(makeSegment("snapshot", 1, "cam1"));
    expect(strategy.vlm_model).toBe("gemini-2.5-pro");
  });

  it("clears per-camera override", () => {
    const sm = new StrategyManager({ stubsOnly: true });
    sm.setCameraOverride("cam1", { skipVlm: true });
    sm.clearCameraOverride("cam1");

    const strategy = sm.selectStrategy(makeSegment("snapshot", 1, "cam1"));
    expect(strategy.run_vlm).toBe(true);
  });
});

describe("StrategyManager dual-slot override (segment policy > frame policy > baseline)", () => {
  it("segment policy skipVlm:false overrides frame policy skipVlm:true", () => {
    const sm = new StrategyManager({ stubsOnly: false });
    sm.setFramePolicyOverride("cam1", { skipVlm: true, maxLevel: 1 });
    sm.setSegmentPolicyOverride("cam1", { skipVlm: false });

    const strategy = sm.selectStrategy(makeSegment("stream", 1, "cam1"));
    expect(strategy.run_vlm).toBe(true);
  });

  it("frame policy skipVlm applies when no segment policy override exists", () => {
    const sm = new StrategyManager({ stubsOnly: false });
    sm.setFramePolicyOverride("cam1", { skipVlm: true });

    const strategy = sm.selectStrategy(makeSegment("stream", 1, "cam1"));
    expect(strategy.run_vlm).toBe(false);
  });

  it("clearSegmentPolicyOverride removes segment policy but keeps frame policy active", () => {
    const sm = new StrategyManager({ stubsOnly: false });
    sm.setFramePolicyOverride("cam1", { skipVlm: true });
    sm.setSegmentPolicyOverride("cam1", { skipVlm: false });
    sm.clearSegmentPolicyOverride("cam1");

    const strategy = sm.selectStrategy(makeSegment("stream", 1, "cam1"));
    expect(strategy.run_vlm).toBe(false);
  });

  it("clearFramePolicyOverride removes frame policy", () => {
    const sm = new StrategyManager({ stubsOnly: false });
    sm.setFramePolicyOverride("cam1", { skipVlm: true });
    sm.clearFramePolicyOverride("cam1");

    const strategy = sm.selectStrategy(makeSegment("stream", 1, "cam1"));
    expect(strategy.run_vlm).toBe(true);
  });

  it("no overrides returns baseline strategy with run_vlm true", () => {
    const sm = new StrategyManager({ stubsOnly: false });
    const strategy = sm.selectStrategy(makeSegment("stream", 10, "cam1"));
    expect(strategy.run_vlm).toBe(true);
  });

  it("segment policy maxLevel overrides frame policy maxLevel", () => {
    const sm = new StrategyManager({ modelRouter: makeMockRouter(1) });
    sm.setFramePolicyOverride("cam1", { maxLevel: 1 });
    sm.setSegmentPolicyOverride("cam1", { maxLevel: 0 });

    const strategy = sm.selectStrategy(makeSegment("event", 5, "cam1"));
    expect(strategy.level).toBe(0);
  });

  it("segment policy vlmModel overrides frame policy vlmModel", () => {
    const sm = new StrategyManager({ stubsOnly: false });
    sm.setFramePolicyOverride("cam1", { vlmModel: "model-l1" });
    sm.setSegmentPolicyOverride("cam1", { vlmModel: "model-l2" });

    const strategy = sm.selectStrategy(makeSegment("stream", 1, "cam1"));
    expect(strategy.vlm_model).toBe("model-l2");
  });

  it("camera overrides are isolated per camera_id", () => {
    const sm = new StrategyManager({ stubsOnly: false });
    sm.setFramePolicyOverride("cam1", { skipVlm: true });

    const strategy = sm.selectStrategy(makeSegment("stream", 1, "cam2"));
    expect(strategy.run_vlm).toBe(true);
  });

  it("setCameraOverride compat shim writes to frame policy slot", () => {
    const sm = new StrategyManager({ stubsOnly: false });
    sm.setCameraOverride("cam1", { skipVlm: true });

    const strategy = sm.selectStrategy(makeSegment("stream", 1, "cam1"));
    expect(strategy.run_vlm).toBe(false);
  });

  it("clearCameraOverride compat shim clears frame policy slot", () => {
    const sm = new StrategyManager({ stubsOnly: false });
    sm.setCameraOverride("cam1", { skipVlm: true });
    sm.clearCameraOverride("cam1");

    const strategy = sm.selectStrategy(makeSegment("stream", 1, "cam1"));
    expect(strategy.run_vlm).toBe(true);
  });

  it("segment policy skipVlm:false wins even when frame policy has skipVlm:true (nullish, not falsy)", () => {
    // Specifically tests that ?? is used, not ||
    const sm = new StrategyManager({ stubsOnly: false });
    sm.setFramePolicyOverride("cam1", { skipVlm: true });
    sm.setSegmentPolicyOverride("cam1", { skipVlm: false });

    const strategy = sm.selectStrategy(makeSegment("stream", 1, "cam1"));
    // segment policy explicitly sets skipVlm=false, so VLM should run
    expect(strategy.run_vlm).toBe(true);
  });
});
