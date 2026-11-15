// packages/cortex/src/cli/model-converter.ts
//
// Local ONNX conversion for models Cortex cannot redistribute (AGPL or
// non-commercial weights). Open-source weights are downloaded and converted to
// ONNX on the user's machine, in a shared throwaway Python env managed by the
// bundled `uv`. Nothing is redistributed by Cortex; the resulting ONNX
// stays local, and its metadata carries the user's path (no upstream leak).
//
// All convert-models reuse a single Python env (torch is fetched once).

import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelAsset, ModelConvertSource } from "./manifest.js";

// Python packages installed into the shared conversion env (CPU-only torch).
const CONVERT_DEPS = ["torch", "torchvision", "ultralytics", "onnx", "onnxruntime", "numpy", "gdown"];

/** Locate the bundled scripts/models directory (walk up to the package root). */
function resolveScriptsDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    const candidate = join(dir, "scripts", "models");
    if (existsSync(join(candidate, "export_yolo26.py"))) return candidate;
    dir = dirname(dir);
  }
  throw new Error("model conversion scripts not found (scripts/models)");
}

/** Prefer the setup-installed uv, fall back to a PATH uv. */
function resolveUvBin(binDir: string): string {
  const local = join(binDir, "uv");
  return existsSync(local) ? local : "uv";
}

function run(cmd: string, args: string[], cwd?: string): void {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`command failed (exit ${r.status}): ${cmd} ${args.join(" ")}`);
}

/**
 * Create (once) the shared conversion Python env with all deps, return the
 * python interpreter path. Idempotent: returns immediately if it already exists.
 */
export function ensureConversionEnv(uvBin: string, envDir: string): string {
  const py = join(envDir, "bin", "python");
  if (existsSync(py)) return py;
  console.log("      Preparing conversion environment (one-time, downloads CPU PyTorch ~200MB)...");
  run(uvBin, ["venv", envDir, "--python", "3.11"]);
  run(uvBin, ["pip", "install", "--python", py, "--torch-backend", "cpu", ...CONVERT_DEPS]);
  return py;
}

/** Acquire the open-source source weight (Ultralytics auto-download or gdown). */
function acquireWeight(py: string, src: ModelConvertSource, workDir: string): string {
  const dest = join(workDir, src.weightFile);
  if (existsSync(dest)) return dest;
  if (src.ultralytics) {
    // Ultralytics downloads the official .pt into the working directory.
    run(py, ["-c", `from ultralytics import YOLO; YOLO(${JSON.stringify(src.ultralytics)})`], workDir);
  } else if (src.gdriveId) {
    run(py, ["-c", `import gdown; gdown.download(id=${JSON.stringify(src.gdriveId)}, output=${JSON.stringify(dest)}, quiet=False)`]);
  } else {
    throw new Error(`no weight source configured for ${src.weightFile}`);
  }
  if (!existsSync(dest)) throw new Error(`weight download did not produce ${dest}`);
  return dest;
}

export interface ConvertContext {
  /** homeDir/bin — where the installed uv lives. */
  binDir: string;
  /** Base dir for the throwaway env + downloaded weights (e.g. homeDir/model-convert). */
  workRoot: string;
}

/**
 * Download open-source weights and convert one model to ONNX at outputPath.
 * The caller must have already obtained the user's license acceptance
 * (the export script is invoked with --accept-license).
 */
export function convertModel(model: ModelAsset, outputPath: string, ctx: ConvertContext): void {
  const src = model.convert;
  if (!src) throw new Error(`${model.name} has no conversion recipe`);

  const uvBin = resolveUvBin(ctx.binDir);
  const scriptsDir = resolveScriptsDir();
  const envDir = join(ctx.workRoot, "venv");
  const workDir = join(ctx.workRoot, "weights");
  mkdirSync(workDir, { recursive: true });

  const py = ensureConversionEnv(uvBin, envDir);
  const weight = acquireWeight(py, src, workDir);
  run(py, [join(scriptsDir, src.script), "--weights", weight, "--output", outputPath, "--accept-license"]);
}
