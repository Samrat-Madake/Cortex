// packages/percept/src/strategy-manager.ts
import type { Segment, PerceptionLevel } from "@cortex/shared";
import type { StrategyConfig } from "./types.js";
import type { ModelRouter } from "./providers/model-router.js";

export interface CameraOverride {
  skipVlm?: boolean;
  maxLevel?: PerceptionLevel;
  vlmModel?: string;
}

/**
 * Selects the analyzer combination to run for a given Segment.
 *
 * Level scheme:
 *   L0: VLM only (no local models needed)
 *   L1: VLM + frame detections + face clustering + ReID
 *   Future local tiers are not active yet.
 *
 * When a ModelManager is provided, max level is determined by installed models.
 * Without ModelManager, falls back to stubsOnly behavior (L0 only).
 */
export class StrategyManager {
  private stubsOnly: boolean;
  private modelRouter?: ModelRouter;
  private modelLite: string;
  private modelFull: string;
  private framePolicyOverrides = new Map<string, CameraOverride>();
  private segmentPolicyOverrides = new Map<string, CameraOverride>();

  constructor(options: {
    stubsOnly?: boolean;
    modelRouter?: ModelRouter;
    modelLite?: string;
    modelFull?: string;
  } = {}) {
    this.modelRouter = options.modelRouter;
    this.stubsOnly = options.modelRouter
      ? options.modelRouter.getMaxLevel() === 0
      : (options.stubsOnly ?? true);
    this.modelLite = options.modelLite ?? "gpt-5-mini";
    this.modelFull = options.modelFull ?? "gpt-5-mini";
  }

  /** Returns the StrategyConfig that should be applied when analysing `segment`. */
  selectStrategy(segment: Segment): StrategyConfig {
    const frameCount = segment.frames.length;
    const mode = segment.mode;
    const maxLevel = this.modelRouter?.getMaxLevel() ?? (this.stubsOnly ? 0 : 1);

    let config: StrategyConfig;

    // Snapshot mode → L0, VLM lite (quick analysis, no local models)
    if (mode === "snapshot") {
      config = this.makeConfig(0, false, false, this.modelLite);
    } else if (maxLevel === 0) {
      // No local models available → L0
      const model = frameCount <= 1 ? this.modelLite : this.modelFull;
      config = this.makeConfig(0, false, false, model);
    } else {
      // L1: external frame detections + RetinaFace + face clustering + ReID
      // No frame count gate — face clustering works with any number of frames.
      config = this.makeConfig(1, true, true, this.modelFull);
    }

    // Apply per-camera overrides from VisionController.
    // Segment policy has higher priority than frame policy.
    const framePolicy = this.framePolicyOverrides.get(segment.camera_id);
    const segmentPolicy = this.segmentPolicyOverrides.get(segment.camera_id);

    const effectiveSkipVlm = segmentPolicy?.skipVlm ?? framePolicy?.skipVlm;
    const effectiveMaxLevel = segmentPolicy?.maxLevel ?? framePolicy?.maxLevel;
    const effectiveVlmModel = segmentPolicy?.vlmModel ?? framePolicy?.vlmModel;

    if (effectiveSkipVlm) config.run_vlm = false;
    if (effectiveMaxLevel != null) config.level = Math.min(config.level, effectiveMaxLevel) as PerceptionLevel;
    if (effectiveVlmModel) config.vlm_model = effectiveVlmModel;

    return config;
  }

  /** Frame-level override (lower priority). Written by VisionController rule engine per-frame signals. */
  setFramePolicyOverride(cameraId: string, override: CameraOverride): void {
    this.framePolicyOverrides.set(cameraId, override);
  }

  /** Segment-level override (higher priority). Written by VisionController segment-level decisions. */
  setSegmentPolicyOverride(cameraId: string, override: CameraOverride): void {
    this.segmentPolicyOverrides.set(cameraId, override);
  }

  clearFramePolicyOverride(cameraId: string): void {
    this.framePolicyOverrides.delete(cameraId);
  }

  clearSegmentPolicyOverride(cameraId: string): void {
    this.segmentPolicyOverrides.delete(cameraId);
  }

  /** @deprecated Use setFramePolicyOverride. Kept as compatibility shim — writes to frame policy slot. */
  setCameraOverride(cameraId: string, override: CameraOverride): void {
    this.setFramePolicyOverride(cameraId, override);
  }

  /** @deprecated Use clearFramePolicyOverride. Kept as compatibility shim — clears frame policy slot. */
  clearCameraOverride(cameraId: string): void {
    this.clearFramePolicyOverride(cameraId);
  }

  /** Allows runtime override of the stubsOnly flag (e.g. after model install). */
  setStubsOnly(value: boolean): void {
    this.stubsOnly = value;
  }

  /** Hot-swaps strategy model defaults at runtime. */
  setVlmModels(models: { modelLite?: string; modelFull?: string }): void {
    if (models.modelLite !== undefined) this.modelLite = models.modelLite;
    if (models.modelFull !== undefined) this.modelFull = models.modelFull;
  }

  // ── Private ──

  private makeConfig(
    level: 0 | 1 | 2,
    runDetection: boolean,
    runReid: boolean,
    defaultModel: string,
  ): StrategyConfig {
    return {
      level,
      run_vlm: true,
      run_detection: runDetection,
      run_reid: runReid,
      run_stt: true,
      vlm_model: defaultModel,
    };
  }
}
