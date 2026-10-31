/**
 * Cam Pipeline — orchestrates capture -> upload -> segment -> perception.
 *
 * Per-session pipeline for a single camera watch.
 */

import { monitorBus } from "@reflectworld/shared";
import type { Segment, PerceptionResult, SpeechSegment, AudioData, VoiceRange } from "@reflectworld/shared";
import type { FrameResult } from "./types.js";
import { buildSegment, generateSegmentId, type BuildSegmentOptions } from "./segment-builder.js";
import type { Segmenter, SegmenterHints } from "./segmenter/types.js";
import { AsyncQueue } from "./async-queue.js";
import { writeStderr } from "@reflectworld/shared";

export interface PipelineConfig {
  cameraId: string;
  mode: "snapshot" | "event" | "stream";
  inputMode?: "local_file" | "live_stream";
  /** Called after Segment is built + raw uploaded. Returns PerceptionResult (snapshot) or void (stream/event). */
  onSegment: (segment: Segment) => Promise<PerceptionResult | null> | void;
  /** Starts async per-frame analysis after segment ids are assigned. Awaited only before segment dispatch. */
  onFramePrepared?: (frame: FrameResult, hints?: SegmenterHints) => Promise<void> | void;
  /** Called after perception result is available. */
  onResult?: (result: PerceptionResult) => void;
  /** Recordings directory for this camera. Combined with segment timestamp/duration to locate video. */
  rawUrl?: string;
  /** Optional per-watch floor. Ordinary cuts before this duration keep buffering. */
  minSegmentDurationMs?: number;
  /** Optional per-watch first-segment cut. Bypasses minSegmentDurationMs once. */
  initialSegmentDurationMs?: number;
  /** When true, audio is consumed by media PTS instead of "all bytes seen so far". */
  audioUsesPtsClock?: boolean;
  /** When true, audio chunks carry timestamps that can be mapped to segment cut timestamps. */
  audioUsesTimestampClock?: boolean;
  /** When true, synthesize voice_ranges from speaking/silent transitions in addition to VAD-completed segments. */
  recordSpeechEndVoiceRanges?: boolean;
}

export interface PipelineDeps {
  storageManager?: null;                   // reserved, currently unused (all storage is local)
  segmenters: Segmenter[];                 // empty = no auto-cut (manual only)
}

export interface ForceFlushOptions {
  /** Flush trailing buffered frames even if they are shorter than minSegmentDurationMs. */
  ignoreMinDuration?: boolean;
}

interface PendingCut {
  reason: string;
  timestampMs: number;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * CamPipeline — manages frame accumulation, segmentation, upload, and perception dispatch.
 */
export class CamPipeline {
  private frameBuffer: FrameResult[] = [];
  private speechSegments: SpeechSegment[] = [];
  private frameIndex = 0;
  private firstFrameTime = 0;
  private currentSegmentId: string | null = null;
  private currentSegmentStartTimestamp: number | null = null;
  private nextSegmentStartTimestamp: number | null = null;
  private pendingCut: PendingCut | null = null;
  private lastHints: SegmenterHints | undefined;
  private initialSegmentFlushed = false;
  private config: PipelineConfig;
  private deps: PipelineDeps;
  private queue = new AsyncQueue();
  private readonly pendingCutFrameWaitMs = 1000;

  // Audio ring buffer state
  private pcmBuffer: Buffer[] = [];
  private voiceRanges: Array<{ start_sample: number; end_sample: number }> = [];
  private segmentAudioStartSample = 0;
  private totalAudioSamples = 0;
  private audioClockBaseTimestampMs: number | null = null;
  // Track in-progress speech for trailing voice_range on flush
  private currentSpeechStartSample: number | null = null;

  constructor(config: PipelineConfig, deps: PipelineDeps) {
    this.config = config;
    this.deps = deps;
  }

  /**
   * Feed a captured frame into the pipeline (serialized via async queue).
   * For snapshot mode: immediately flushes as single-frame segment.
   * For stream/event: accumulates frames, checks segmenters for cut signals.
   */
  async feedFrame(frame: FrameResult, hints?: SegmenterHints): Promise<void> {
    return this.queue.enqueue(() => this._feedFrame(frame, hints));
  }

  private async _feedFrame(frame: FrameResult, hints?: SegmenterHints): Promise<void> {
    this.lastHints = hints;

    if (this.pendingCut) {
      const pending = this.pendingCut;
      if (this.usesTimestampAudioClock() && frame.timestamp <= pending.timestampMs) {
        if (!this.appendFrameToBuffer(frame)) return;
        this.frameIndex++;
        return;
      }
      this.clearPendingCut();
      await this.flushAtCut(pending.timestampMs, pending.reason);
    }

    const segmentStart = this.currentSegmentStartTimestamp ?? this.nextSegmentStartTimestamp;
    if (this.usesTimestampAudioClock() && segmentStart !== null && frame.timestamp < segmentStart) {
      // VAD/audio can run ahead of low-fps frame extraction. Frames older than
      // the committed boundary belong to the already-flushed segment.
      return;
    }

    if (this.config.mode === "snapshot") {
      // Each frame is its own segment
      this.firstFrameTime = Date.now();
      this.currentSegmentId = generateSegmentId();
      this.currentSegmentStartTimestamp = frame.timestamp;
      frame._segment_id = this.currentSegmentId;
      frame._segment_start_timestamp = this.currentSegmentStartTimestamp;
      this.prepareFrame(frame);
      await this.flush([frame]);
      return;
    }

    if (!this.appendFrameToBuffer(frame)) return;

    if (this.canFlushInitialSegment()) {
      const frames = this.frameBuffer.splice(0);
      const audioSegs = this.speechSegments.splice(0);
      for (const s of this.deps.segmenters) s.reset();
      this.frameIndex = 0;
      await this.flush(frames, audioSegs, `initial_window(${this.config.initialSegmentDurationMs}ms)`);
      return;
    }

    // Check segmenters for cut signal
    for (const seg of this.deps.segmenters) {
      const signal = seg.feed(frame, this.frameIndex, hints);
      if (signal) {
        const cutTimestampMs = signal.timestampMs ?? frame.timestamp;
        if (!this.canFlushBuffered(cutTimestampMs)) {
          this.frameIndex++;
          return;
        }
        await this.flushAtCut(cutTimestampMs, signal.reason);
        return;
      }
    }

    this.frameIndex++;
  }

  private appendFrameToBuffer(frame: FrameResult): boolean {
    const segmentStart = this.currentSegmentStartTimestamp ?? this.nextSegmentStartTimestamp;
    if (this.usesTimestampAudioClock() && segmentStart !== null && frame.timestamp < segmentStart) {
      return false;
    }
    if (this.frameBuffer.length === 0 && this.firstFrameTime === 0) {
      this.firstFrameTime = Date.now();
      this.currentSegmentId = generateSegmentId();
      this.currentSegmentStartTimestamp = this.nextSegmentStartTimestamp ?? frame.timestamp;
      this.nextSegmentStartTimestamp = null;
    }
    if (this.currentSegmentId) frame._segment_id = this.currentSegmentId;
    if (this.currentSegmentStartTimestamp !== null) frame._segment_start_timestamp = this.currentSegmentStartTimestamp;
    this.prepareFrame(frame);
    this.frameBuffer.push(frame);
    return true;
  }

  private prepareFrame(frame: FrameResult): void {
    if (!this.config.onFramePrepared || frame._frame_analysis_promise) return;
    const promise = Promise.resolve(this.config.onFramePrepared(frame, this.lastHints))
      .catch((err) => {
        writeStderr("[cam:pipeline] Frame analysis failed:", err);
      });
    frame._frame_analysis_promise = promise;
  }

  private async waitForFrameAnalysis(frames: FrameResult[]): Promise<void> {
    const promises = frames
      .map((frame) => frame._frame_analysis_promise)
      .filter((promise): promise is Promise<void> => promise != null);
    if (promises.length === 0) return;
    await Promise.all(promises);
  }

  /** Add speech segments from VAD for attachment to next flushed Segment. */
  addSpeechSegments(segments: SpeechSegment[]): void {
    this.speechSegments.push(...segments);
  }

  /**
   * Ingest a VAD-processed audio chunk: write raw PCM + record voice ranges + compat speech segments.
   * Goes through the async queue to prevent racing with flush operations.
   */
  ingestAudio(
    chunk: Buffer,
    voiceSegments: Array<{ start: number; length: number }>,
    speechSegments?: SpeechSegment[],
    isSpeaking?: boolean,
    chunkTimestampMs?: number,
  ): Promise<void> {
    return this.queue.enqueue(() => {
      if (chunkTimestampMs !== undefined) {
        this.ensureAudioClockBase(chunkTimestampMs);
      }
      // Track speech start BEFORE incrementing totalAudioSamples — so the
      // trailing voice_range on mid-sentence flush starts at the right position.
      if (isSpeaking !== undefined) {
        if (isSpeaking && this.currentSpeechStartSample === null) {
          this.currentSpeechStartSample = this.totalAudioSamples;
        } else if (!isSpeaking && this.currentSpeechStartSample !== null) {
          if (this.currentSpeechStartSample < this.totalAudioSamples) {
            if (this.config.recordSpeechEndVoiceRanges) {
              this.voiceRanges.push({
                start_sample: this.currentSpeechStartSample,
                end_sample: this.totalAudioSamples,
              });
            }
          }
          this.currentSpeechStartSample = null;
        }
      }

      this.pcmBuffer.push(chunk);
      this.totalAudioSamples += chunk.length / 2; // s16le = 2 bytes per sample
      for (const seg of voiceSegments) {
        this.voiceRanges.push({ start_sample: seg.start, end_sample: seg.start + seg.length });
      }
      if (speechSegments?.length) {
        this.speechSegments.push(...speechSegments);
      }
    });
  }

  /**
   * Update voice state at VAD chunk granularity (32ms).
   * Serialized via async queue — flushes directly when segmenter signals a cut.
   */
  async updateVoiceState(isSpeaking: boolean, timestampMs: number): Promise<void> {
    return this.queue.enqueue(() => this._updateVoiceState(isSpeaking, timestampMs));
  }

  private async _updateVoiceState(isSpeaking: boolean, timestampMs: number): Promise<void> {
    if (this.config.mode === "snapshot" || this.frameBuffer.length === 0) return;
    if (this.pendingCut) return;

    for (const seg of this.deps.segmenters) {
      if (seg.feedVoice) {
        const signal = seg.feedVoice(isSpeaking, timestampMs);
        if (signal) {
          const cutTimestampMs = signal.timestampMs ?? timestampMs;
          if (!this.canFlushBuffered(cutTimestampMs)) return;
          if (this.frameBuffer.some(frame => frame.timestamp > cutTimestampMs)) {
            await this.flushAtCut(cutTimestampMs, signal.reason);
            return;
          }
          this.beginPendingCut(cutTimestampMs, signal.reason);
          return;
        }
      }
    }
  }

  /** Force flush accumulated frames (e.g., on stop or event end). Serialized via async queue.
   *  @param rawUrlOverride — if provided, overrides `config.rawUrl` for this flush only (event video path). */
  async forceFlush(rawUrlOverride?: string, options?: ForceFlushOptions): Promise<void> {
    return this.queue.enqueue(() => this._forceFlush(rawUrlOverride, options));
  }

  private async _forceFlush(rawUrlOverride?: string, options?: ForceFlushOptions): Promise<void> {
    if (this.pendingCut) {
      const pending = this.pendingCut;
      this.clearPendingCut();
      await this.flushAtCut(pending.timestampMs, pending.reason, rawUrlOverride);
    }
    if (this.frameBuffer.length > 0) {
      if (!options?.ignoreMinDuration && !this.canFlushBuffered()) return;
      const lastFrame = this.frameBuffer[this.frameBuffer.length - 1];
      await this.flushAtCut(lastFrame?.timestamp, undefined, rawUrlOverride);
    }
  }

  private canFlushBuffered(nowMs?: number): boolean {
    const minMs = this.config.minSegmentDurationMs;
    if (!minMs || minMs <= 0 || this.config.mode === "snapshot") return true;
    if (this.frameBuffer.length <= 0) return false;
    const startTimestamp = this.currentSegmentStartTimestamp ?? this.frameBuffer[0]!.timestamp;
    const last = this.frameBuffer[this.frameBuffer.length - 1]!;
    const elapsed = Math.max(0, (nowMs ?? last.timestamp) - startTimestamp);
    return elapsed >= minMs;
  }

  private canFlushInitialSegment(): boolean {
    const initialMs = this.config.initialSegmentDurationMs;
    if (!initialMs || initialMs <= 0 || this.initialSegmentFlushed || this.config.mode === "snapshot") return false;
    if (this.frameBuffer.length <= 0) return false;
    const first = this.frameBuffer[0]!;
    const last = this.frameBuffer[this.frameBuffer.length - 1]!;
    const elapsed = Math.max(0, last.timestamp - first.timestamp);
    return elapsed >= initialMs;
  }

  private usesTimestampAudioClock(): boolean {
    return this.config.audioUsesTimestampClock ?? this.config.audioUsesPtsClock ?? false;
  }

  private ensureAudioClockBase(chunkTimestampMs: number): void {
    if (!this.usesTimestampAudioClock() || this.audioClockBaseTimestampMs !== null) return;
    this.audioClockBaseTimestampMs = chunkTimestampMs - (this.totalAudioSamples / 16000) * 1000;
  }

  private timestampToSample(timestampMs: number, sampleRate: number): number {
    if (this.audioClockBaseTimestampMs === null) {
      return Math.round(Math.max(0, timestampMs) / 1000 * sampleRate);
    }
    return Math.round(((timestampMs - this.audioClockBaseTimestampMs) / 1000) * sampleRate);
  }

  private takeBufferedFramesThrough(cutTimestampMs: number): FrameResult[] {
    const splitIndex = this.frameBuffer.findIndex(frame => frame.timestamp > cutTimestampMs);
    if (splitIndex < 0) {
      return this.frameBuffer.splice(0);
    }
    return this.frameBuffer.splice(0, splitIndex);
  }

  private beginPendingCut(cutTimestampMs: number, reason: string): void {
    this.clearPendingCut();
    const timer = setTimeout(() => {
      void this.queue.enqueue(async () => {
        if (!this.pendingCut || this.pendingCut.timestampMs !== cutTimestampMs) return;
        const pending = this.pendingCut;
        this.clearPendingCut();
        await this.flushAtCut(pending.timestampMs, pending.reason);
      }).catch(err => {
        writeStderr("[cam:pipeline] Pending cut flush failed:", err);
      });
    }, this.pendingCutFrameWaitMs);
    this.pendingCut = { reason, timestampMs: cutTimestampMs, timer };
  }

  private clearPendingCut(): void {
    if (!this.pendingCut) return;
    clearTimeout(this.pendingCut.timer);
    this.pendingCut = null;
  }

  private async flushAtCut(cutTimestampMs?: number, reason?: string, rawUrlOverride?: string): Promise<void> {
    const frames = cutTimestampMs === undefined
      ? this.frameBuffer.splice(0)
      : this.takeBufferedFramesThrough(cutTimestampMs);
    if (frames.length === 0) {
      if (cutTimestampMs !== undefined) {
        this.reseedBufferedSegment(cutTimestampMs);
      }
      return;
    }
    const audioSegs = this.speechSegments.splice(0);
    for (const s of this.deps.segmenters) s.reset();
    await this.flush(frames, audioSegs, reason, rawUrlOverride, cutTimestampMs);
    this.reseedBufferedSegment(cutTimestampMs);
  }

  private reseedBufferedSegment(segmentStartTimestampMs?: number): void {
    this.frameIndex = this.frameBuffer.length;
    if (this.frameBuffer.length === 0) {
      this.firstFrameTime = 0;
      this.currentSegmentId = null;
      this.currentSegmentStartTimestamp = null;
      this.nextSegmentStartTimestamp = segmentStartTimestampMs ?? null;
      return;
    }

    this.firstFrameTime = Date.now();
    this.currentSegmentId = generateSegmentId();
    this.currentSegmentStartTimestamp = segmentStartTimestampMs ?? this.frameBuffer[0]!.timestamp;
    this.nextSegmentStartTimestamp = null;
    for (const frame of this.frameBuffer) {
      frame._segment_id = this.currentSegmentId;
      frame._segment_start_timestamp = this.currentSegmentStartTimestamp;
    }
  }

  /** Internal: build segment, call perception. */
  private async flush(
    frames: FrameResult[],
    audioSegments?: SpeechSegment[],
    cutReason?: string,
    rawUrlOverride?: string,
    audioEndTimestampMs?: number,
  ): Promise<void> {
    if (frames.length === 0) return;
    if (this.config.mode !== "snapshot" && this.config.initialSegmentDurationMs) {
      this.initialSegmentFlushed = true;
    }
    await this.waitForFrameAnalysis(frames);

    // Build audio_data from ring buffer
    const MERGE_THRESHOLD_MS = 500;
    const SAMPLE_RATE = 16000;
    let audioData: AudioData | undefined;

    if (this.pcmBuffer.length > 0) {
      const allPcm = Buffer.concat(this.pcmBuffer);
      const bufferStartSample = this.segmentAudioStartSample;
      const firstFrame = frames[0];
      const lastFrame = frames[frames.length - 1];
      const startTimestampMs = this.currentSegmentStartTimestamp ?? firstFrame?.timestamp;
      const frameStartSample = startTimestampMs !== undefined
        ? this.timestampToSample(startTimestampMs, SAMPLE_RATE)
        : bufferStartSample;
      const endTimestampMs = audioEndTimestampMs ?? lastFrame?.timestamp;
      const ptsEndSample = endTimestampMs !== undefined
        ? this.timestampToSample(endTimestampMs, SAMPLE_RATE)
        : this.totalAudioSamples;
      const useTimestampAudioClock = this.usesTimestampAudioClock();
      const segStart = useTimestampAudioClock
        ? Math.min(this.totalAudioSamples, Math.max(bufferStartSample, frameStartSample))
        : bufferStartSample;
      const segEnd = useTimestampAudioClock
        ? Math.min(this.totalAudioSamples, Math.max(segStart, ptsEndSample))
        : this.totalAudioSamples;
      const audioStartOffsetSamples = Math.max(0, segStart - bufferStartSample);
      const audioEndOffsetSamples = Math.max(audioStartOffsetSamples, segEnd - bufferStartSample);
      const audioStartByte = Math.min(allPcm.length, audioStartOffsetSamples * 2);
      const audioEndByte = Math.min(allPcm.length, audioEndOffsetSamples * 2);
      const consumedBytes = audioEndByte;

      // Add trailing voice_range for in-progress speech (cut happened mid-sentence)
      if (this.currentSpeechStartSample !== null && this.currentSpeechStartSample < segEnd) {
        this.voiceRanges.push({
          start_sample: this.currentSpeechStartSample,
          end_sample: segEnd,
        });
        // Keep speech state open for next segment
        this.currentSpeechStartSample = segEnd;
      }

      // Convert absolute sample ranges to segment-local ms
      const localRanges: VoiceRange[] = this.voiceRanges
        .filter(r => r.end_sample > segStart)
        .filter(r => r.start_sample < segEnd)
        .map(r => ({
          start_ms: Math.max(0, (r.start_sample - segStart) / SAMPLE_RATE * 1000),
          end_ms: (Math.min(r.end_sample, segEnd) - segStart) / SAMPLE_RATE * 1000,
        }));

      // Merge ranges with gap < 500ms
      const merged: VoiceRange[] = [];
      for (const r of localRanges) {
        const last = merged[merged.length - 1];
        if (last && (r.start_ms - last.end_ms) < MERGE_THRESHOLD_MS) {
          last.end_ms = r.end_ms;
        } else {
          merged.push({ ...r });
        }
      }

      if (audioEndByte > audioStartByte) {
        audioData = { pcm: allPcm.subarray(audioStartByte, audioEndByte), voice_ranges: merged };
      }

      if (useTimestampAudioClock && consumedBytes < allPcm.length) {
        this.pcmBuffer = [Buffer.from(allPcm.subarray(consumedBytes))];
        this.voiceRanges = this.voiceRanges
          .filter(r => r.end_sample > segEnd)
          .map(r => ({ start_sample: Math.max(r.start_sample, segEnd), end_sample: r.end_sample }));
        this.segmentAudioStartSample = segEnd;
      } else {
        this.pcmBuffer = [];
        this.voiceRanges = [];
        this.segmentAudioStartSample = this.totalAudioSamples;
      }
    } else {
      this.segmentAudioStartSample = this.totalAudioSamples;
    }

    const buildOpts: BuildSegmentOptions = {
      cameraId: this.config.cameraId,
      mode: this.config.mode,
      rawUrl: rawUrlOverride ?? this.config.rawUrl ?? "",
      audioSegments: !this.usesTimestampAudioClock() && audioSegments?.length ? audioSegments : undefined,
      audioData,
      eventHint: cutReason,
      ...(this.currentSegmentStartTimestamp === null ? {} : { segmentStartTimestampMs: this.currentSegmentStartTimestamp }),
      ...(audioEndTimestampMs === undefined ? {} : { segmentEndTimestampMs: audioEndTimestampMs }),
      ...(this.currentSegmentId ? { segmentId: this.currentSegmentId } : {}),
    };

    const segment = buildSegment(frames, buildOpts);
    if (this.config.inputMode) {
      segment._input_mode = this.config.inputMode;
    }

    segment._trace = {
      first_frame_at: this.firstFrameTime,
      segment_built_at: Date.now(),
    };
    this.firstFrameTime = 0;
    this.currentSegmentId = null;
    this.currentSegmentStartTimestamp = null;

    monitorBus.publish("cam:segment_built", {
      camera_id: segment.camera_id,
      segment_id: segment.segment_id,
      mode: segment.mode,
      frame_count: segment.frames.length,
      first_frame_at: segment._trace?.first_frame_at,
      segment_built_at: segment._trace?.segment_built_at,
      timestamp: segment.timestamp,
      duration_sec: segment.duration_sec,
      end_timestamp: segment.timestamp + Math.round(segment.duration_sec * 1000),
      cut_reason: cutReason ?? segment.event_hint,
      has_motion: this.lastHints?.hasMotion ?? false,
      motion_ratio: this.lastHints?.motionRatio ?? 0,
      has_voice: this.lastHints?.hasVoice ?? false,
      audio_segment_count: audioSegments?.length ?? 0,
    }, segment.camera_id);

    // Dispatch to perception.
    // snapshot mode: onSegment returns a Promise — await and forward result to onResult.
    // stream/event mode: onSegment returns void — fire-and-forget, no blocking.
    const maybeResult = this.config.onSegment(segment);
    if (maybeResult instanceof Promise) {
      try {
        const result = await maybeResult;
        if (result && this.config.onResult) {
          this.config.onResult(result);
        }
      } catch (err) {
        writeStderr("[cam:pipeline] Perception dispatch failed:", err);
      }
    }
  }

  /** Current pipeline mode. */
  get currentMode(): PipelineConfig["mode"] {
    return this.config.mode;
  }

  /**
   * Hot-swap mode and segmenters atomically (serialized via async queue).
   * Caller MUST forceFlush() before calling this.
   */
  async switchMode(mode: PipelineConfig["mode"], segmenters: Segmenter[]): Promise<void> {
    return this.queue.enqueue(() => {
      this.config.mode = mode;
      this.deps.segmenters = segmenters;
      this.frameIndex = 0;
      this.clearPendingCut();
      // Reset audio state on mode switch
      this.pcmBuffer = [];
      this.voiceRanges = [];
      this.segmentAudioStartSample = this.totalAudioSamples;
      this.audioClockBaseTimestampMs = null;
      this.nextSegmentStartTimestamp = null;
    });
  }

  /** Get current buffer size. */
  get bufferedFrameCount(): number {
    return this.frameBuffer.length;
  }
}
