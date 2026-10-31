/**
 * SttAnalyzer — speech-to-text using sherpa-onnx-node OfflineRecognizer + Moonshine Tiny.
 *
 * Requires: sherpa-onnx-node (optional dependency).
 * If not available, isAvailable returns false and transcribe() returns empty results.
 */

import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { platform, arch } from "node:os";
import { existsSync } from "node:fs";
import type { SpeechSegment, AudioData } from "@reflectworld/shared";
import { writeStderr } from "@reflectworld/shared";

/**
 * Ensure the native library path is set before loading sherpa-onnx-node.
 * On macOS, the .node addon dynamically links to .dylib files in the
 * platform-specific package directory.
 */
function ensureSherpaLibraryPath(require: NodeRequire): void {
  const plat = platform() === "win32" ? "win" : platform();
  const platformPkg = `sherpa-onnx-${plat}-${arch()}`;
  try {
    const pkgDir = dirname(require.resolve(`${platformPkg}/package.json`));
    const envVar = plat === "darwin" ? "DYLD_LIBRARY_PATH" : "LD_LIBRARY_PATH";
    const current = process.env[envVar] ?? "";
    if (!current.includes(platformPkg)) {
      process.env[envVar] = pkgDir + (current ? `:${current}` : "");
    }
  } catch {
    // Platform package not installed — sherpa-onnx-node will fail gracefully
  }
}

export interface SttAnalyzerOptions {
  /** Path to Moonshine Tiny model directory. */
  modelDir: string;
  /** Number of CPU threads for inference. Default 1. */
  numThreads?: number;
}

export interface SttResult {
  /** Full transcript from all speech segments. */
  transcript: string;
  /** Per-segment transcripts with timing. */
  segments: Array<{
    start: number;
    end?: number;
    text: string;
    latency_ms: number;
  }>;
  /** Total STT processing time in ms. */
  latency_ms: number;
}

export class SttAnalyzer {
  private recognizer: any = null;
  private _available = false;

  constructor(private readonly options: SttAnalyzerOptions) {}

  /** Try to load sherpa-onnx-node and create OfflineRecognizer. Returns true if successful. */
  async init(): Promise<boolean> {
    const dir = this.options.modelDir;
    const requiredFiles = [
      "preprocess.onnx",
      "encode.int8.onnx",
      "uncached_decode.int8.onnx",
      "cached_decode.int8.onnx",
      "tokens.txt",
    ];
    const missing = requiredFiles.filter((file) => !existsSync(resolve(dir, file)));
    if (missing.length > 0) {
      writeStderr(
        `[MODEL WARNING] STT model directory is incomplete: ${dir}. Missing: ${missing.join(", ")}. STT disabled.`,
      );
      this._available = false;
      return false;
    }

    try {
      const require = createRequire(import.meta.url);
      ensureSherpaLibraryPath(require);
      const sherpa = require("sherpa-onnx-node");

      this.recognizer = new sherpa.OfflineRecognizer({
        modelConfig: {
          moonshine: {
            preprocessor: resolve(dir, "preprocess.onnx"),
            encoder: resolve(dir, "encode.int8.onnx"),
            uncachedDecoder: resolve(dir, "uncached_decode.int8.onnx"),
            cachedDecoder: resolve(dir, "cached_decode.int8.onnx"),
          },
          tokens: resolve(dir, "tokens.txt"),
          numThreads: this.options.numThreads ?? 1,
          debug: 0,
        },
      });
      this._available = true;
      return true;
    } catch (err) {
      writeStderr(
        `[MODEL WARNING] STT model failed to load from ${this.options.modelDir}. STT disabled. Reason: ` +
        `${err instanceof Error ? err.message : err}`,
      );
      this._available = false;
      return false;
    }
  }

  get isAvailable(): boolean {
    return this._available;
  }

  /**
   * Transcribe speech segments (synchronous, CPU-bound).
   * @param segments - Speech segments from VAD (Float32Array audio at 16kHz)
   */
  transcribe(segments: SpeechSegment[]): SttResult {
    if (!this._available || !this.recognizer || segments.length === 0) {
      return { transcript: "", segments: [], latency_ms: 0 };
    }

    const start = performance.now();
    const results: SttResult["segments"] = [];

    for (const seg of segments) {
      const segStart = performance.now();
      const stream = this.recognizer.createStream();
      stream.acceptWaveform({ sampleRate: 16000, samples: seg.samples });
      this.recognizer.decode(stream);
      const result = this.recognizer.getResult(stream);
      results.push({
        start: seg.start,
        end: seg.start + seg.samples.length,
        text: result.text.trim(),
        latency_ms: performance.now() - segStart,
      });
    }

    const transcript = results
      .map((r) => r.text)
      .filter(Boolean)
      .join(" ");

    return {
      transcript,
      segments: results,
      latency_ms: performance.now() - start,
    };
  }

  /**
   * Transcribe from continuous audio + voice ranges (new path).
   * For each merged voice range, slices the PCM and transcribes.
   */
  transcribeAudioData(audioData: AudioData): SttResult {
    if (!this._available || !this.recognizer || audioData.voice_ranges.length === 0) {
      return { transcript: "", segments: [], latency_ms: 0 };
    }

    const SAMPLE_RATE = 16000;
    const BYTES_PER_SAMPLE = 2; // s16le
    const start = performance.now();
    const results: SttResult["segments"] = [];

    for (const range of audioData.voice_ranges) {
      const segStart = performance.now();
      const startByte = Math.floor(range.start_ms / 1000 * SAMPLE_RATE) * BYTES_PER_SAMPLE;
      const endByte = Math.floor(range.end_ms / 1000 * SAMPLE_RATE) * BYTES_PER_SAMPLE;
      const slice = audioData.pcm.subarray(startByte, endByte);

      const numSamples = slice.length / BYTES_PER_SAMPLE;
      const float32 = new Float32Array(numSamples);
      for (let i = 0; i < numSamples; i++) {
        float32[i] = slice.readInt16LE(i * BYTES_PER_SAMPLE) / 32768.0;
      }

      const stream = this.recognizer.createStream();
      stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: float32 });
      this.recognizer.decode(stream);
      const result = this.recognizer.getResult(stream);

      const startSample = Math.floor(range.start_ms / 1000 * SAMPLE_RATE);
      const endSample = Math.floor(range.end_ms / 1000 * SAMPLE_RATE);
      results.push({
        start: startSample,
        end: endSample,
        text: result.text.trim(),
        latency_ms: performance.now() - segStart,
      });
    }

    const transcript = results.map(r => r.text).filter(Boolean).join(" ");
    return { transcript, segments: results, latency_ms: performance.now() - start };
  }

  dispose(): void {
    this.recognizer = null;
    this._available = false;
  }
}
