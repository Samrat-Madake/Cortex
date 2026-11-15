// packages/percept/src/models/onnx-engine.ts
import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelId } from "./model-manifest.js";
import { writeStderr } from "@cortex/shared";

// Without any mitigation, each InferenceSession on CoreML EP writes a fresh
// ~45-95MB `.mlmodelc` directory into $TMPDIR and never cleans it up.
// Over many E2E/benchmark/dev runs this accumulates into 8GB+ of
// /var/folders debris.
//
// Python's onnxruntime has `ModelCacheDirectory` to persist the compiled
// model across process starts, but onnxruntime-node 1.24 only exposes
// `coreMlFlags` — no equivalent persistent-cache option is reachable from
// JS. Mitigation: the TMPDIR filenames include the originating PID, so we
// clean up just *this* process's mlmodelc entries on exit, which keeps
// /var/folders bounded without interfering with other processes.
const CORE_ML_FLAG_CREATE_ML_PROGRAM = 0x010;

let cleanupRegistered = false;
function registerCoreMLCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  const cleanup = () => {
    const pid = String(process.pid);
    try {
      const t = tmpdir();
      for (const name of readdirSync(t)) {
        // Filename shape: onnxruntime-<UUID>-<PID>-<hex>.model.mlmodelc | .mlmodel
        if (!name.startsWith("onnxruntime-")) continue;
        const parts = name.split("-");
        if (parts.length < 7) continue;
        // UUID is 5 dash-separated segments (1..5), PID at index 6.
        if (parts[6] !== pid) continue;
        rmSync(join(t, name), { recursive: true, force: true });
      }
    } catch { /* best effort */ }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });
}

// Dynamic import — onnxruntime-node is optional (Level 0 doesn't need it).
// The official package is used for CPU, CoreML, and CUDA; CUDA availability is
// detected from the runtime's supported backends and dynamic library setup.
let ort: any = null;
let ortLoadPromise: Promise<any> | null = null;
let ortVariant: "gpu" | "standard" | "none" = "none";

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function warnModel(message: string): void {
  writeStderr(`[MODEL WARNING] ${message}`);
}

async function getOrt(): Promise<any> {
  if (ort) return ort;
  if (!ortLoadPromise) {
    ortLoadPromise = (async () => {
      try {
        const m = await import("onnxruntime-node");
        ort = m;
        ortVariant = await hasCudaBackend(m) ? "gpu" : "standard";
        return m;
      } catch { /* not installed */ }
      ortLoadPromise = null;
      return null;
    })();
  }
  const result = await ortLoadPromise;
  if (!result) {
    throw new Error(
      "onnxruntime-node is not installed. Install it for Level 1 perception:\n" +
      "  npm install onnxruntime-node sharp\n" +
      "For Linux CUDA, ensure NVIDIA driver, CUDA 12 runtime, and cuDNN 9 are visible to Node.",
    );
  }
  return result;
}

async function hasCudaBackend(ortModule: any): Promise<boolean> {
  if (process.platform === "darwin") return false;
  if (typeof ortModule.listSupportedBackends !== "function") return false;
  try {
    const backends = await ortModule.listSupportedBackends();
    return Array.isArray(backends) && backends.some((backend) => backend?.name === "cuda");
  } catch {
    return false;
  }
}

/**
 * Detect the best execution providers for the current platform.
 * Priority: CUDA (NVIDIA GPU) > CoreML (Apple Silicon) > CPU.
 */
function detectExecutionProviders(): Array<string | { name: string }> {
  if (process.platform === "darwin") {
    return [{ name: "coreml" }, "cpu"];
  }
  if (ortVariant === "gpu") {
    return [{ name: "cuda" }, "cpu"];
  }
  return ["cpu"];
}

/** Whether the runtime is macOS with CoreML available. */
const isMacOS = process.platform === "darwin";

export interface TensorMap {
  [name: string]: { data: ArrayLike<number>; dims: readonly number[] };
}

/**
 * Unified wrapper around onnxruntime-node InferenceSession.
 * Manages session lifecycle, hardware EP auto-detection, and tensor I/O.
 * Gracefully fails when onnxruntime-node is not installed (Level 0).
 *
 * Hardware acceleration:
 * - macOS (Apple Silicon): CoreML EP → ANE/GPU acceleration
 * - Linux (NVIDIA GPU): CUDA EP via onnxruntime-node when CUDA/cuDNN libraries are visible
 * - Fallback: CPU
 */
export class OnnxInferenceEngine {
  private sessions = new Map<ModelId, any>(); // ort.InferenceSession
  private sessionExecutionProviders = new Map<ModelId, "coreml" | "cuda" | "cpu">();

  /** Check if onnxruntime-node is available. */
  static async isAvailable(): Promise<boolean> {
    try {
      await getOrt();
      return true;
    } catch {
      return false;
    }
  }

  /** Load an ONNX model from disk. Caches the session by modelId.
   *
   * Fallback chain on macOS:
   *   1. CoreML MLProgram (best perf, ANE/GPU) — works for YOLO, ArcFace, CLIP-ReID
   *   2. CoreML standard (ANE/GPU) — fallback for models incompatible with MLProgram (e.g. RetinaFace)
   *   3. CPU
   */
  async loadModel(modelId: ModelId, modelPath: string): Promise<void> {
    if (this.sessions.has(modelId)) return;
    const ortModule = await getOrt();

    if (isMacOS) {
      registerCoreMLCleanup();

      // Try CoreML MLProgram first (best performance)
      try {
        const session = await ortModule.InferenceSession.create(modelPath, {
          executionProviders: [{ name: "coreml", coreMlFlags: CORE_ML_FLAG_CREATE_ML_PROGRAM }],
          graphOptimizationLevel: "all",
        });
        this.sessions.set(modelId, session);
        this.sessionExecutionProviders.set(modelId, "coreml");
        writeStderr(`[onnx-engine] ${modelId}: loaded with coreml EP (${ortVariant})`);
        return;
      } catch (mlpErr) {
        writeStderr(`[onnx-engine] ${modelId}: coreml MLProgram failed (${mlpErr instanceof Error ? mlpErr.message : mlpErr}), trying standard coreml`);
      }

      // Fallback to standard CoreML (no MLProgram flag)
      try {
        const session = await ortModule.InferenceSession.create(modelPath, {
          executionProviders: [{ name: "coreml" }],
          graphOptimizationLevel: "all",
        });
        this.sessions.set(modelId, session);
        this.sessionExecutionProviders.set(modelId, "coreml");
        writeStderr(`[onnx-engine] ${modelId}: loaded with coreml EP (standard)`);
        return;
      } catch (cmlErr) {
        warnModel(`ONNX model ${modelId} CoreML EP failed; falling back to CPU. Reason: ${formatError(cmlErr)}`);
      }
    } else if (ortVariant === "gpu") {
      // Linux/Windows with CUDA backend available: try CUDA
      try {
        const session = await ortModule.InferenceSession.create(modelPath, {
          executionProviders: [{ name: "cuda" }],
          graphOptimizationLevel: "all",
        });
        this.sessions.set(modelId, session);
        this.sessionExecutionProviders.set(modelId, "cuda");
        writeStderr(`[onnx-engine] ${modelId}: loaded with cuda EP`);
        return;
      } catch (cudaErr) {
        warnModel(`ONNX model ${modelId} CUDA EP failed; falling back to CPU. Reason: ${formatError(cudaErr)}`);
      }
    }

    // Final fallback: CPU
    if (!isMacOS) {
      warnModel(`ONNX model ${modelId} is loading on CPU. This is allowed but slow; CUDA GPU was not selected.`);
    }
    try {
      const session = await ortModule.InferenceSession.create(modelPath, {
        executionProviders: ["cpu"],
        graphOptimizationLevel: "all",
      });
      this.sessions.set(modelId, session);
      this.sessionExecutionProviders.set(modelId, "cpu");
      writeStderr(`[onnx-engine] ${modelId}: loaded with cpu EP`);
    } catch (cpuErr) {
      warnModel(`ONNX model ${modelId} failed to load on CPU from ${modelPath}. Reason: ${formatError(cpuErr)}`);
      throw cpuErr;
    }
  }

  /** Unload a model session and free resources. */
  async unloadModel(modelId: ModelId): Promise<void> {
    const session = this.sessions.get(modelId);
    if (session) {
      await session.release();
      this.sessions.delete(modelId);
      this.sessionExecutionProviders.delete(modelId);
    }
  }

  /** Run inference on a loaded model. Returns output tensors.
   * Feeds can be ort.Tensor or { data: Float32Array, dims: number[] } plain objects. */
  async run(
    modelId: ModelId,
    feeds: Record<string, any>,
  ): Promise<TensorMap> {
    const session = this.sessions.get(modelId);
    if (!session) {
      throw new Error(`Model "${modelId}" is not loaded. Call loadModel() first.`);
    }

    // Auto-wrap plain { data, dims } objects into ort.Tensor
    const ortModule = await getOrt();
    const createdTensors: any[] = [];
    const wrappedFeeds: Record<string, any> = {};
    for (const [key, val] of Object.entries(feeds)) {
      if (val && val.data && val.dims && !(val instanceof ortModule.Tensor)) {
        const t = new ortModule.Tensor("float32", val.data, val.dims);
        createdTensors.push(t);
        wrappedFeeds[key] = t;
      } else {
        wrappedFeeds[key] = val;
      }
    }

    let rawResults: Record<string, any>;
    try {
      rawResults = await session.run(wrappedFeeds);
    } finally {
      // Dispose input tensors even when ORT rejects, otherwise native memory can
      // accumulate across long video runs.
      for (const t of createdTensors) {
        if (typeof t.dispose === "function") t.dispose();
      }
      for (const val of Object.values(feeds)) {
        if (val && typeof val.dispose === "function") val.dispose();
      }
    }

    // Copy output tensor data to plain JS objects and dispose native ORT tensors.
    // Without this, each run() leaks native memory that JS GC cannot reclaim.
    const results: TensorMap = {};
    for (const [key, val] of Object.entries(rawResults)) {
      if (val && typeof val === "object" && "data" in val && "dims" in val) {
        const v = val as { data: ArrayLike<number>; dims: readonly number[] };
        // Copy data to a plain typed array (detached from native OrtValue)
        const dataCopy = v.data instanceof Float32Array
          ? new Float32Array(v.data)
          : Array.from(v.data);
        results[key] = { data: dataCopy, dims: [...v.dims] };
        // Dispose native tensor if possible
        if (typeof (val as any).dispose === "function") {
          (val as any).dispose();
        }
      }
    }

    return results;
  }

  /** Create an ORT Tensor. Wraps ort.Tensor for callers that need it. */
  async createTensor(
    type: "float32",
    data: Float32Array,
    dims: number[],
  ): Promise<any> {
    const ortModule = await getOrt();
    return new ortModule.Tensor(type, data, dims);
  }

  /** Check if a specific model is loaded. */
  isLoaded(modelId: ModelId): boolean {
    return this.sessions.has(modelId);
  }

  /** Get list of currently loaded model IDs. */
  getLoadedModels(): ModelId[] {
    return [...this.sessions.keys()];
  }

  /** Get execution provider selected for each loaded model. */
  getLoadedModelExecutionProviders(): Record<string, "coreml" | "cuda" | "cpu"> {
    return Object.fromEntries(this.sessionExecutionProviders.entries());
  }

  /** Get the detected ORT variant and primary EP. */
  static getRuntime(): { variant: string; primaryEp: string } {
    const primaryEp = isMacOS ? "coreml" : ortVariant === "gpu" ? "cuda" : "cpu";
    return { variant: ortVariant, primaryEp };
  }

  /** Release all sessions. Call on shutdown. */
  async dispose(): Promise<void> {
    for (const [id] of this.sessions) {
      await this.unloadModel(id);
    }
  }
}
