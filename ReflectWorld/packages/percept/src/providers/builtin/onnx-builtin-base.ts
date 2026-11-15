// packages/percept/src/providers/builtin/onnx-builtin-base.ts
import type { ModelProvider, ModelType, ProviderRuntime } from "../types.js";
import type { ModelManager } from "../../models/model-manager.js";
import { MODEL_MANIFEST, type ModelId } from "../../models/model-manifest.js";
import { writeStderr } from "@cortex/shared";

/**
 * Base class for all ONNX-builtin providers.
 * Handles initialization (model loading) and readiness tracking.
 */
export abstract class OnnxBuiltinBase implements ModelProvider {
  abstract readonly name: string;
  abstract readonly type: ModelType;
  readonly runtime: ProviderRuntime = "onnx-builtin";
  protected ready = false;

  constructor(
    protected readonly modelManager: ModelManager,
    public readonly modelId: ModelId,
  ) {}

  async initialize(): Promise<void> {
    if (!this.modelManager.isInstalled(this.modelId)) {
      const def = MODEL_MANIFEST[this.modelId];
      const requirement = def.min_level > 0 ? `required for perception level ${def.min_level}+` : "optional";
      writeStderr(
        `[MODEL WARNING] Provider "${this.name}" disabled: ONNX model "${this.modelId}" ` +
        `(${def.filename}) is not installed (${requirement}).`,
      );
      return;
    }
    try {
      await this.modelManager.ensureLoaded(this.modelId);
      this.ready = true;
    } catch (err) {
      this.ready = false;
      writeStderr(
        `[MODEL WARNING] Provider "${this.name}" disabled: failed to load ONNX model "${this.modelId}": ` +
        `${err instanceof Error ? err.message : err}`,
      );
      throw err;
    }
  }

  async dispose(): Promise<void> {
    // OnnxEngine lifecycle managed by ModelManager — don't unload individual models
    // as other providers may share the same engine.
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready;
  }
}
