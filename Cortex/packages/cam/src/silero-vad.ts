/**
 * SileroVad — voice activity detection using Silero VAD v5 via sherpa-onnx-node.
 *
 * Requires: sherpa-onnx-node (optional dependency).
 * If not available, isAvailable returns false and feedChunk() returns empty segments.
 *
 * The model expects 16kHz mono audio. Feed 512-sample Float32Array chunks.
 */

import { createRequire } from "node:module";
import { platform, arch } from "node:os";
import { dirname } from "node:path";
import { existsSync } from "node:fs";
import { writeStderr } from "@cortex/shared";

/**
 * Ensure the native library path is set before loading sherpa-onnx-node.
 * On macOS, the .node addon dynamically links to .dylib files in the
 * platform-specific package directory. DYLD_LIBRARY_PATH must include
 * that directory for dlopen to find them.
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

export interface SileroVadOptions {
  /** Path to silero_vad.onnx model file. */
  modelPath: string;
  /** Detection threshold (0-1). Default 0.5. */
  threshold?: number;
  /** Sample rate. Must be 16000. */
  sampleRate?: number;
  /** Minimum silence duration in seconds to split segments. Default 0.5. */
  minSilenceDuration?: number;
  /** Minimum speech duration in seconds. Default 0.25. */
  minSpeechDuration?: number;
  /** Window size in samples. Default 512. */
  windowSize?: number;
  /** Circular buffer size in seconds. Default 120. */
  bufferSizeSec?: number;
}

export interface SpeechSegment {
  /** Start sample index in the audio stream. */
  start: number;
  /** PCM Float32 audio samples (16kHz mono). */
  samples: Float32Array;
}

export interface VadFeedResult {
  /** Completed speech segments (may be empty). */
  segments: SpeechSegment[];
  /** Whether speech is currently being detected (real-time, per-chunk). */
  isSpeaking: boolean;
}

/** Chunk size for 16kHz Silero VAD v5. */
export const VAD_CHUNK_SIZE = 512;

export class SileroVad {
  private vad: any = null;
  private readonly options: Required<SileroVadOptions>;
  private _available = false;
  private _initialized = false;

  constructor(options: SileroVadOptions) {
    this.options = {
      modelPath: options.modelPath,
      threshold: options.threshold ?? 0.5,
      sampleRate: options.sampleRate ?? 16000,
      minSilenceDuration: options.minSilenceDuration ?? 0.05,
      minSpeechDuration: options.minSpeechDuration ?? 0.25,
      windowSize: options.windowSize ?? 512,
      bufferSizeSec: options.bufferSizeSec ?? 120,
    };
  }

  /** Try to load sherpa-onnx-node and create Vad. Returns true if successful. */
  async init(): Promise<boolean> {
    if (!existsSync(this.options.modelPath)) {
      writeStderr(`[MODEL WARNING] Silero VAD model is missing: ${this.options.modelPath}. VAD disabled.`);
      this._available = false;
      this._initialized = true;
      return false;
    }
    try {
      const require = createRequire(import.meta.url);
      ensureSherpaLibraryPath(require);
      const sherpa = require("sherpa-onnx-node");
      this.vad = new sherpa.Vad({
        sileroVad: {
          model: this.options.modelPath,
          threshold: this.options.threshold,
          minSilenceDuration: this.options.minSilenceDuration,
          minSpeechDuration: this.options.minSpeechDuration,
          windowSize: this.options.windowSize,
        },
        sampleRate: this.options.sampleRate,
      }, this.options.bufferSizeSec);
      this._available = true;
      this._initialized = true;
      return true;
    } catch (err) {
      writeStderr(
        `[MODEL WARNING] Silero VAD failed to load from ${this.options.modelPath}. VAD disabled. Reason: ` +
        `${err instanceof Error ? err.message : err}`,
      );
      this._available = false;
      this._initialized = true;
      return false;
    }
  }

  get isAvailable(): boolean { return this._available; }
  get isInitialized(): boolean { return this._initialized; }

  /** Create an independent VAD state machine using the same model/config. */
  async createSession(): Promise<SileroVad> {
    const session = new SileroVad(this.options);
    await session.init();
    return session;
  }

  /** Reset VAD state. Call between independent audio streams. */
  reset(): void {
    if (this.vad) this.vad.reset();
  }

  /**
   * Feed a Float32Array chunk (must be exactly windowSize=512 samples).
   * Returns any completed speech segments and real-time speaking status.
   */
  feedChunk(float32Chunk: Float32Array): VadFeedResult {
    if (!this._available || !this.vad) return { segments: [], isSpeaking: false };
    this.vad.acceptWaveform(float32Chunk);
    const isSpeaking: boolean = this.vad.isDetected();
    const segments: SpeechSegment[] = [];
    while (!this.vad.isEmpty()) {
      const seg = this.vad.front();
      segments.push({ start: seg.start, samples: seg.samples });
      this.vad.pop();
    }
    return { segments, isSpeaking };
  }

  /** Flush remaining audio. Call when stream ends. */
  flush(): SpeechSegment[] {
    if (!this._available || !this.vad) return [];
    this.vad.flush();
    const segments: SpeechSegment[] = [];
    while (!this.vad.isEmpty()) {
      const seg = this.vad.front();
      segments.push({ start: seg.start, samples: seg.samples });
      this.vad.pop();
    }
    return segments;
  }

  async dispose(): Promise<void> {
    this.vad = null;
    this._available = false;
  }
}
