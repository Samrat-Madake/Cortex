// packages/percept/src/models/model-manager.ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MODEL_MANIFEST, LEVEL_REQUIREMENTS, getModelsDir } from "./model-manifest.js";
import { OnnxInferenceEngine } from "./onnx-engine.js";
import type { ModelId, ModelCapability } from "./model-manifest.js";
import { writeStderr } from "@cortex/shared";

/**
 * Manages model discovery, loading, and capability reporting.
 *
 * On construction, scans the models directory to determine which ONNX files
 * are present. Models are loaded into the OnnxInferenceEngine on demand
 * (first inference call), not at startup.
 */
export class ModelManager {
  private modelsDir: string;
  private installedModels: Set<ModelId>;
  readonly engine: OnnxInferenceEngine;

  constructor(modelsDir?: string) {
    this.modelsDir = modelsDir ?? getModelsDir();
    this.engine = new OnnxInferenceEngine();
    this.installedModels = this.scanModels();
  }

  /** Scan models directory and return set of installed model IDs. */
  private scanModels(): Set<ModelId> {
    const installed = new Set<ModelId>();
    for (const [id, def] of Object.entries(MODEL_MANIFEST)) {
      const modelPath = join(this.modelsDir, def.filename);
      if (existsSync(modelPath)) {
        installed.add(id as ModelId);
      }
    }
    return installed;
  }

  /** Re-scan models directory (e.g. after install). */
  rescan(): void {
    this.installedModels = this.scanModels();
  }

  /** Get all capabilities provided by installed models. */
  getAvailableCapabilities(): ModelCapability[] {
    const caps = new Set<ModelCapability>();
    for (const id of this.installedModels) {
      caps.add(MODEL_MANIFEST[id].capability);
    }
    return [...caps];
  }

  /** Check if a specific capability is available. */
  hasCapability(cap: ModelCapability): boolean {
    return this.getAvailableCapabilities().includes(cap);
  }

  /** Compute the maximum perception level achievable with installed models. */
  getMaxLevel(): number {
    let maxLevel = 0; // Level 0 = VLM only (no local models)
    const caps = new Set(this.getAvailableCapabilities());

    for (const [levelStr, required] of Object.entries(LEVEL_REQUIREMENTS)) {
      const level = Number(levelStr);
      if (level === 0) continue;
      if (required.every((c) => caps.has(c))) {
        maxLevel = Math.max(maxLevel, level);
      }
    }
    return maxLevel;
  }

  /** Get the filesystem path for an installed model, or undefined if not installed. */
  getModelPath(modelId: ModelId): string | undefined {
    if (!this.installedModels.has(modelId)) return undefined;
    return join(this.modelsDir, MODEL_MANIFEST[modelId].filename);
  }

  /** Check if a model is installed. */
  isInstalled(modelId: ModelId): boolean {
    return this.installedModels.has(modelId);
  }

  /**
   * Ensure a model is loaded into the ONNX engine.
   * No-op if already loaded. Throws if model is not installed.
   */
  async ensureLoaded(modelId: ModelId): Promise<void> {
    if (this.engine.isLoaded(modelId)) return;
    const modelPath = this.getModelPath(modelId);
    if (!modelPath) {
      const msg = `Model "${modelId}" is not installed in ${this.modelsDir}`;
      writeStderr(`[MODEL WARNING] ${msg}`);
      throw new Error(msg);
    }
    try {
      await this.engine.loadModel(modelId, modelPath);
    } catch (err) {
      writeStderr(
        `[MODEL WARNING] ONNX model "${modelId}" failed to load from ${modelPath}: ` +
        `${err instanceof Error ? err.message : err}`,
      );
      throw err;
    }
  }

  /** Release all loaded model sessions. */
  async dispose(): Promise<void> {
    await this.engine.dispose();
  }
}
