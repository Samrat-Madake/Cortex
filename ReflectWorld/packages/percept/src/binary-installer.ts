/**
 * Binary installer for STT models used by the Perception pipeline.
 * Downloads and extracts Moonshine Tiny int8 model (~50MB) from GitHub releases.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, createWriteStream, unlinkSync } from "node:fs";
import { join } from "node:path";
import { get as httpsGet } from "node:https";
import { writeStderr } from "@cortex/shared";

const MOONSHINE_TINY_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-moonshine-tiny-en-int8.tar.bz2";
const MOONSHINE_TINY_DIR = "sherpa-onnx-moonshine-tiny-en-int8";

/** Required model files that must exist for the model to be considered valid. */
const REQUIRED_FILES = [
  "preprocess.onnx",
  "encode.int8.onnx",
  "uncached_decode.int8.onnx",
  "cached_decode.int8.onnx",
  "tokens.txt",
];

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    httpsGet(url, (response) => {
      if (
        response.statusCode &&
        [301, 302, 307, 308].includes(response.statusCode) &&
        response.headers.location
      ) {
        return downloadFile(response.headers.location, dest)
          .then(resolve)
          .catch(reject);
      }
      if (response.statusCode !== 200) {
        return reject(new Error(`HTTP ${response.statusCode} for ${url}`));
      }
      const file = createWriteStream(dest);
      response.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve();
      });
      file.on("error", (err) => reject(err));
    }).on("error", reject);
  });
}

/**
 * Checks if a valid Moonshine Tiny model directory exists.
 */
export function isMoonshineModelPresent(modelDir: string): boolean {
  if (!existsSync(modelDir)) return false;
  return REQUIRED_FILES.every((f) => existsSync(join(modelDir, f)));
}

/**
 * Downloads and extracts the Moonshine Tiny int8 model if not already present.
 *
 * @param binDir - Parent directory where the model directory will be created.
 * @returns Path to the extracted model directory.
 */
export async function setupSttModels(binDir: string): Promise<{ moonshine: string }> {
  if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true });

  const modelDir = join(binDir, MOONSHINE_TINY_DIR);
  if (isMoonshineModelPresent(modelDir)) {
    return { moonshine: modelDir };
  }

  const tarball = join(binDir, `${MOONSHINE_TINY_DIR}.tar.bz2`);
  writeStderr("[perception] Downloading Moonshine Tiny int8 model...");
  await downloadFile(MOONSHINE_TINY_URL, tarball);

  writeStderr("[perception] Extracting model...");
  execFileSync("tar", ["xjf", tarball, "-C", binDir], {
    timeout: 120_000,
    stdio: "ignore",
  });

  // Clean up tarball
  if (existsSync(tarball)) unlinkSync(tarball);

  if (!isMoonshineModelPresent(modelDir)) {
    throw new Error(`Model extraction failed: required files missing in ${modelDir}`);
  }

  writeStderr("[perception] Moonshine Tiny model ready.");
  return { moonshine: modelDir };
}

/**
 * Best-effort structural validation: the ONNX at `modelPath` must be loadable by the
 * runtime (onnxruntime-node) and expose at least one input and output. Returns `true`
 * when validated, `false` when skipped (onnxruntime-node not installed, e.g. a Level 0
 * host). Throws when the file is present but not a loadable ONNX model.
 */
export async function verifyOnnxLoadable(modelPath: string): Promise<boolean> {
  let ort: typeof import("onnxruntime-node");
  try {
    ort = await import("onnxruntime-node");
  } catch {
    return false; // not installed — caller relies on size/sha checks
  }
  const session = await ort.InferenceSession.create(modelPath);
  if (session.inputNames.length === 0 || session.outputNames.length === 0) {
    throw new Error("ONNX model exposes no inputs/outputs");
  }
  return true;
}
