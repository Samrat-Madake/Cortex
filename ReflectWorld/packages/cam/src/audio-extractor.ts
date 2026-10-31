import { spawn, type ChildProcess } from "node:child_process";
import { toRtspSafeName } from "./go2rtc-manager.js";

const LOCAL_MEDIA_FILE_RE = /\.(mp4|avi|mkv|mov|webm|flv|ts|m3u8|mpg|mpeg)$/i;

export interface AudioExtractorOptions {
  ffmpegBin: string;
  rtspBase: string;
}

export interface AudioExtractionOptions {
  /** Sample rate in Hz. Default 16000 (required by Silero VAD). */
  sampleRate?: number;
  /** Callback invoked with raw PCM s16le mono chunks. */
  onAudio: (chunk: Buffer) => void;
  /** Override input URL (e.g. ClawCam RTSP URL that requires UDP transport). */
  inputOverride?: string;
  /** Local-file only: realtime uses -re, fast omits -re. */
  localFilePacing?: "realtime" | "fast";
}

interface AudioEntry {
  process: ChildProcess;
  options: AudioExtractionOptions;
  stdoutPaused?: boolean;
}

export function buildAudioExtractionArgs(
  ffmpegInput: string,
  sampleRate: number,
  transportArgs: string[],
  localFilePacing: "realtime" | "fast" = "realtime",
): string[] {
  const realtimeArgs = LOCAL_MEDIA_FILE_RE.test(ffmpegInput) && localFilePacing === "realtime" ? ["-re"] : [];
  return [
    ...realtimeArgs,
    ...transportArgs,
    "-i", ffmpegInput,
    "-vn",                          // no video
    "-acodec", "pcm_s16le",         // raw PCM signed 16-bit little-endian
    "-ar", String(sampleRate),      // sample rate
    "-ac", "1",                     // mono
    "-f", "s16le",                  // raw output format
    "pipe:1",
  ];
}

/**
 * AudioExtractor — spawns ffmpeg to extract raw PCM audio from an RTSP source.
 *
 * Outputs mono 16-bit signed little-endian PCM at the configured sample rate.
 * Each chunk from stdout is passed directly to onAudio callback.
 */
export class AudioExtractor {
  private entries = new Map<string, AudioEntry>();
  private readonly ffmpegBin: string;
  private readonly rtspBase: string;

  constructor(options: AudioExtractorOptions) {
    this.ffmpegBin = options.ffmpegBin;
    this.rtspBase = options.rtspBase;
  }

  startExtraction(streamName: string, options: AudioExtractionOptions): void {
    if (this.entries.has(streamName)) throw new Error(`"${streamName}" audio is already extracting`);

    const sampleRate = options.sampleRate ?? 16000;
    const inputUrl = options.inputOverride ?? `${this.rtspBase}/${toRtspSafeName(streamName)}`;
    const transportArgs = options.inputOverride ? [] : ["-rtsp_transport", "tcp"];
    const args = buildAudioExtractionArgs(inputUrl, sampleRate, transportArgs, options.localFilePacing);

    const proc = spawn(this.ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    proc.stderr?.on("data", () => {}); // suppress ffmpeg stderr

    proc.stdout?.on("data", (chunk: Buffer) => {
      options.onAudio(chunk);
    });

    proc.on("exit", () => {
      this.entries.delete(streamName);
    });

    this.entries.set(streamName, { process: proc, options });
  }

  pauseExtraction(streamName: string): boolean {
    const entry = this.entries.get(streamName);
    if (!entry || entry.stdoutPaused) return false;
    entry.process.stdout?.pause();
    entry.stdoutPaused = true;
    return true;
  }

  resumeExtraction(streamName: string): boolean {
    const entry = this.entries.get(streamName);
    if (!entry || !entry.stdoutPaused) return false;
    entry.process.stdout?.resume();
    entry.stdoutPaused = false;
    return true;
  }

  stopExtraction(streamName: string): boolean {
    const entry = this.entries.get(streamName);
    if (!entry) return false;
    entry.process.kill("SIGTERM");
    this.entries.delete(streamName);
    return true;
  }

  isExtracting(streamName: string): boolean {
    return this.entries.has(streamName);
  }

  stopAll(): void {
    for (const name of [...this.entries.keys()]) this.stopExtraction(name);
  }
}
