import { afterEach, describe, it, expect, vi } from "vitest";
import { CamPipeline } from "../pipeline.js";
import { FixedWindowSegmenter } from "../segmenter/fixed-window.js";
import type { FrameResult } from "../types.js";
import type { Segment } from "@cortex/shared";
import type { CutSignal, Segmenter } from "../segmenter/types.js";

function makeFrame(ts = Date.now()): FrameResult {
  return { data: "base64", timestamp: ts, source_name: "test" };
}

class VoiceCutSegmenter implements Segmenter {
  readonly name = "voice-cut";

  feed(): CutSignal | null {
    return null;
  }

  feedVoice(isSpeaking: boolean, timestampMs: number): CutSignal | null {
    if (isSpeaking) return null;
    return { endIndex: 0, reason: "voice_pause_adaptive", timestampMs };
  }

  reset(): void {
    // no-op
  }
}

describe("CamPipeline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("periodic mode: flushes each frame immediately", async () => {
    const onSegment = vi.fn().mockResolvedValue(null);

    const pipeline = new CamPipeline(
      { cameraId: "cam", mode: "snapshot", onSegment },
      { storageManager: null, segmenters: [] },
    );

    await pipeline.feedFrame(makeFrame());
    await pipeline.feedFrame(makeFrame());

    expect(onSegment).toHaveBeenCalledTimes(2);
    const seg: Segment = onSegment.mock.calls[0][0];
    expect(seg.mode).toBe("snapshot");
    expect(seg.frames).toHaveLength(1);
  });

  it("stream mode: accumulates until segmenter fires", async () => {
    const onSegment = vi.fn().mockResolvedValue(null);

    const pipeline = new CamPipeline(
      { cameraId: "cam", mode: "stream", onSegment },
      { storageManager: null, segmenters: [new FixedWindowSegmenter(3)] },
    );

    await pipeline.feedFrame(makeFrame(1000));
    await pipeline.feedFrame(makeFrame(2000));
    expect(onSegment).not.toHaveBeenCalled();
    expect(pipeline.bufferedFrameCount).toBe(2);

    await pipeline.feedFrame(makeFrame(3000)); // triggers cut
    expect(onSegment).toHaveBeenCalledTimes(1);
    const seg: Segment = onSegment.mock.calls[0][0];
    expect(seg.frames).toHaveLength(3);
    expect(seg.mode).toBe("stream");
  });

  it("waits for prepared frame analysis before dispatching a segment", async () => {
    const onSegment = vi.fn().mockResolvedValue(null);
    let resolveAnalysis!: () => void;
    const analysisDone = new Promise<void>((resolve) => {
      resolveAnalysis = resolve;
    });
    const onFramePrepared = vi.fn((frame: FrameResult) => {
      frame.detections = [{
        label: "person",
        confidence: 0.9,
        bbox: { x1: 1, y1: 2, x2: 3, y2: 4 },
      }];
      return analysisDone;
    });

    const pipeline = new CamPipeline(
      { cameraId: "cam", mode: "stream", onSegment, onFramePrepared },
      { storageManager: null, segmenters: [new FixedWindowSegmenter(1)] },
    );

    const feedPromise = pipeline.feedFrame(makeFrame(1000));
    await Promise.resolve();

    expect(onFramePrepared).toHaveBeenCalledTimes(1);
    expect(onSegment).not.toHaveBeenCalled();

    resolveAnalysis();
    await feedPromise;

    expect(onSegment).toHaveBeenCalledTimes(1);
    const seg: Segment = onSegment.mock.calls[0][0];
    expect(seg.frames[0]?.detections).toEqual([{
      label: "person",
      confidence: 0.9,
      bbox: { x1: 1, y1: 2, x2: 3, y2: 4 },
    }]);
  });

  it("assigns the accumulating segment id to frames before the segment is cut", async () => {
    const onSegment = vi.fn().mockResolvedValue(null);
    const pipeline = new CamPipeline(
      { cameraId: "cam", mode: "stream", onSegment },
      { storageManager: null, segmenters: [new FixedWindowSegmenter(2)] },
    );
    const first = makeFrame(1000);
    const second = makeFrame(2000);

    await pipeline.feedFrame(first);
    expect(first._segment_id).toMatch(/^seg_/);
    expect(first._segment_start_timestamp).toBe(1000);

    await pipeline.feedFrame(second);
    expect(second._segment_id).toBe(first._segment_id);
    expect(second._segment_start_timestamp).toBe(1000);
    expect(onSegment).toHaveBeenCalledTimes(1);
    const seg: Segment = onSegment.mock.calls[0][0];
    expect(seg.segment_id).toBe(first._segment_id);
  });

  it("stream mode: per-watch min duration keeps buffering before flush", async () => {
    const onSegment = vi.fn().mockResolvedValue(null);

    const pipeline = new CamPipeline(
      { cameraId: "cam", mode: "stream", onSegment, minSegmentDurationMs: 3000 },
      { storageManager: null, segmenters: [new FixedWindowSegmenter(2)] },
    );

    await pipeline.feedFrame(makeFrame(1000));
    await pipeline.feedFrame(makeFrame(2000)); // segmenter fires, but duration is only 1s
    expect(onSegment).not.toHaveBeenCalled();
    expect(pipeline.bufferedFrameCount).toBe(2);

    await pipeline.feedFrame(makeFrame(3000));
    expect(onSegment).not.toHaveBeenCalled();

    await pipeline.feedFrame(makeFrame(4000)); // segmenter fires again, buffered duration is 3s
    expect(onSegment).toHaveBeenCalledTimes(1);
    const seg: Segment = onSegment.mock.calls[0][0];
    expect(seg.frames).toHaveLength(4);
  });

  it("stream mode: initial segment cut bypasses per-watch min duration once", async () => {
    const onSegment = vi.fn().mockResolvedValue(null);

    const pipeline = new CamPipeline(
      {
        cameraId: "cam",
        mode: "stream",
        onSegment,
        minSegmentDurationMs: 10000,
        initialSegmentDurationMs: 2000,
      },
      { storageManager: null, segmenters: [new FixedWindowSegmenter(2)] },
    );

    await pipeline.feedFrame(makeFrame(1000));
    await pipeline.feedFrame(makeFrame(2000));
    expect(onSegment).not.toHaveBeenCalled();

    await pipeline.feedFrame(makeFrame(3000));
    expect(onSegment).toHaveBeenCalledTimes(1);
    let seg: Segment = onSegment.mock.calls[0][0];
    expect(seg.frames).toHaveLength(3);
    expect(seg.event_hint).toBe("initial_window(2000ms)");

    await pipeline.feedFrame(makeFrame(4000));
    await pipeline.feedFrame(makeFrame(5000));
    await pipeline.forceFlush();
    expect(onSegment).toHaveBeenCalledTimes(1);
    expect(pipeline.bufferedFrameCount).toBe(2);

    await pipeline.feedFrame(makeFrame(14000));
    await pipeline.forceFlush();
    expect(onSegment).toHaveBeenCalledTimes(2);
    seg = onSegment.mock.calls[1][0];
    expect(seg.frames).toHaveLength(3);
  });

  it("forceFlush sends buffered frames", async () => {
    const onSegment = vi.fn().mockResolvedValue(null);

    const pipeline = new CamPipeline(
      { cameraId: "cam", mode: "stream", onSegment },
      { storageManager: null, segmenters: [new FixedWindowSegmenter(10)] },
    );

    await pipeline.feedFrame(makeFrame());
    await pipeline.feedFrame(makeFrame());
    await pipeline.forceFlush();

    expect(onSegment).toHaveBeenCalledTimes(1);
    expect(pipeline.bufferedFrameCount).toBe(0);
  });

  it("forceFlush respects per-watch min duration", async () => {
    const onSegment = vi.fn().mockResolvedValue(null);

    const pipeline = new CamPipeline(
      { cameraId: "cam", mode: "stream", onSegment, minSegmentDurationMs: 3000 },
      { storageManager: null, segmenters: [new FixedWindowSegmenter(10)] },
    );

    await pipeline.feedFrame(makeFrame(1000));
    await pipeline.feedFrame(makeFrame(2000));
    await pipeline.forceFlush();
    expect(onSegment).not.toHaveBeenCalled();
    expect(pipeline.bufferedFrameCount).toBe(2);

    await pipeline.feedFrame(makeFrame(4000));
    await pipeline.forceFlush();
    expect(onSegment).toHaveBeenCalledTimes(1);
    expect(pipeline.bufferedFrameCount).toBe(0);
  });

  it("forceFlush can bypass per-watch min duration for final EOF tails", async () => {
    const onSegment = vi.fn().mockResolvedValue(null);

    const pipeline = new CamPipeline(
      { cameraId: "cam", mode: "stream", onSegment, minSegmentDurationMs: 3000 },
      { storageManager: null, segmenters: [new FixedWindowSegmenter(10)] },
    );

    await pipeline.feedFrame(makeFrame(1000));
    await pipeline.feedFrame(makeFrame(2000));
    await pipeline.forceFlush(undefined, { ignoreMinDuration: true });

    expect(onSegment).toHaveBeenCalledTimes(1);
    expect(pipeline.bufferedFrameCount).toBe(0);
    const seg: Segment = onSegment.mock.calls[0][0];
    expect(seg.frames).toHaveLength(2);
  });

  it("forceFlush is no-op when buffer empty", async () => {
    const onSegment = vi.fn().mockResolvedValue(null);

    const pipeline = new CamPipeline(
      { cameraId: "cam", mode: "event", onSegment },
      { storageManager: null, segmenters: [] },
    );

    await pipeline.forceFlush();
    expect(onSegment).not.toHaveBeenCalled();
  });

  it("calls onResult when perception returns result", async () => {
    const mockResult = { segment_id: "seg_1", camera_id: "cam" };
    const onSegment = vi.fn().mockResolvedValue(mockResult);
    const onResult = vi.fn();

    const pipeline = new CamPipeline(
      { cameraId: "cam", mode: "snapshot", onSegment, onResult },
      { storageManager: null, segmenters: [] },
    );

    await pipeline.feedFrame(makeFrame());
    expect(onResult).toHaveBeenCalledWith(mockResult);
  });

  it("survives perception failure gracefully", async () => {
    const onSegment = vi.fn().mockRejectedValue(new Error("perception down"));

    const pipeline = new CamPipeline(
      { cameraId: "cam", mode: "snapshot", onSegment },
      { storageManager: null, segmenters: [] },
    );

    // Should not throw
    await pipeline.feedFrame(makeFrame());
    expect(onSegment).toHaveBeenCalled();
  });

  it("segment has raw_url field (may be empty before local storage saves)", async () => {
    const onSegment = vi.fn().mockResolvedValue(null);

    const pipeline = new CamPipeline(
      { cameraId: "cam", mode: "snapshot", onSegment },
      { storageManager: null, segmenters: [] },
    );

    await pipeline.feedFrame(makeFrame());
    expect(onSegment).toHaveBeenCalled();

    const seg: Segment = onSegment.mock.calls[0][0];
    expect(typeof seg.raw_url).toBe("string");
  });

  it("void onSegment (stream/event) does not block feedFrame and skips onResult", async () => {
    // Simulates the orchestrator pattern: fire-and-forget, returns void
    let segmentReceived: Segment | null = null;
    const onSegment = vi.fn((seg: Segment): void => {
      segmentReceived = seg;
      // no return value — void path
    });
    const onResult = vi.fn();

    const pipeline = new CamPipeline(
      { cameraId: "cam", mode: "stream", onSegment, onResult },
      { storageManager: null, segmenters: [new FixedWindowSegmenter(2)] },
    );

    await pipeline.feedFrame(makeFrame(1000));
    await pipeline.feedFrame(makeFrame(2000)); // triggers cut at window=2

    // onSegment was called synchronously (no await)
    expect(onSegment).toHaveBeenCalledTimes(1);
    expect(segmentReceived).not.toBeNull();
    expect((segmentReceived as unknown as Segment).mode).toBe("stream");

    // onResult must NOT be called because onSegment returned void (not a Promise)
    expect(onResult).not.toHaveBeenCalled();
  });

  it("records voice_ranges from live VAD speaking state even without completed speech segments", async () => {
    const onSegment = vi.fn().mockResolvedValue(null);

    const pipeline = new CamPipeline(
      { cameraId: "cam", mode: "stream", onSegment, recordSpeechEndVoiceRanges: true },
      { storageManager: null, segmenters: [new FixedWindowSegmenter(2)] },
    );

    await pipeline.feedFrame(makeFrame(0));
    await pipeline.ingestAudio(Buffer.alloc(1600), [], [], true);
    await pipeline.ingestAudio(Buffer.alloc(1600), [], [], false);
    await pipeline.feedFrame(makeFrame(1000));

    expect(onSegment).toHaveBeenCalledTimes(1);
    const seg: Segment = onSegment.mock.calls[0][0];
    expect(seg.audio_data?.voice_ranges).toEqual([{ start_ms: 0, end_ms: 50 }]);
  });

  it("clips PTS-clock audio_data to the flushed video frame range", async () => {
    const onSegment = vi.fn().mockResolvedValue(null);
    const pipeline = new CamPipeline(
      { cameraId: "cam", mode: "stream", onSegment, audioUsesPtsClock: true },
      { storageManager: null, segmenters: [new FixedWindowSegmenter(2)] },
    );

    await pipeline.ingestAudio(Buffer.alloc(15_000 * 16 * 2), [], [], false);
    await pipeline.feedFrame(makeFrame(3000));
    await pipeline.feedFrame(makeFrame(10000));

    expect(onSegment).toHaveBeenCalledTimes(1);
    const seg: Segment = onSegment.mock.calls[0][0];
    expect(seg.duration_sec).toBe(7);
    expect(seg.audio_data?.pcm.length).toBe(7_000 * 16 * 2);
  });

  it("uses VAD cut timestamp for PTS-clock audio end when voice cuts between low-fps frames", async () => {
    vi.useFakeTimers();
    const onSegment = vi.fn().mockResolvedValue(null);
    const pipeline = new CamPipeline(
      { cameraId: "cam", mode: "stream", onSegment, audioUsesPtsClock: true },
      { storageManager: null, segmenters: [new VoiceCutSegmenter()] },
    );

    await pipeline.ingestAudio(Buffer.alloc(17_000 * 16 * 2), [], [], false);
    await pipeline.feedFrame(makeFrame(3000));
    await pipeline.feedFrame(makeFrame(15015));
    await pipeline.updateVoiceState(false, 16_300);
    expect(onSegment).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);

    expect(onSegment).toHaveBeenCalledTimes(1);
    const seg: Segment = onSegment.mock.calls[0][0];
    expect(seg.duration_sec).toBeCloseTo(13.3, 3);
    expect(seg.audio_data?.pcm.length).toBe(13_300 * 16 * 2);
    vi.useRealTimers();
  });

  it("uses cut timestamps to clip wall-clock live audio", async () => {
    vi.useFakeTimers();
    const onSegment = vi.fn().mockResolvedValue(null);
    const pipeline = new CamPipeline(
      { cameraId: "cam", mode: "stream", onSegment, audioUsesTimestampClock: true },
      { storageManager: null, segmenters: [new VoiceCutSegmenter()] },
    );
    const baseTs = 1_700_000_000_000;

    await pipeline.ingestAudio(Buffer.alloc(17_000 * 16 * 2), [], [], false, baseTs);
    await pipeline.feedFrame(makeFrame(baseTs + 3_000));
    await pipeline.feedFrame(makeFrame(baseTs + 15_015));
    await pipeline.updateVoiceState(false, baseTs + 16_300);
    await vi.advanceTimersByTimeAsync(1000);

    expect(onSegment).toHaveBeenCalledTimes(1);
    const seg: Segment = onSegment.mock.calls[0][0];
    expect(seg.timestamp).toBe(baseTs + 3_000);
    expect(seg.duration_sec).toBeCloseTo(13.3, 3);
    expect(seg.audio_data?.pcm.length).toBe(13_300 * 16 * 2);
    vi.useRealTimers();
  });

  it("keeps frames after a VAD cut timestamp for the next segment", async () => {
    const onSegment = vi.fn().mockResolvedValue(null);
    const pipeline = new CamPipeline(
      { cameraId: "cam", mode: "stream", onSegment, audioUsesPtsClock: true },
      { storageManager: null, segmenters: [new VoiceCutSegmenter()] },
    );

    await pipeline.ingestAudio(Buffer.alloc(20_000 * 16 * 2), [], [], false);
    await pipeline.feedFrame(makeFrame(3000));
    await pipeline.feedFrame(makeFrame(15015));
    await pipeline.feedFrame(makeFrame(17000));
    await pipeline.updateVoiceState(false, 16_300);

    expect(onSegment).toHaveBeenCalledTimes(1);
    const first: Segment = onSegment.mock.calls[0][0];
    expect(first.frames.map(frame => frame.timestamp)).toEqual([3000, 15015]);
    expect(first.duration_sec).toBeCloseTo(13.3, 3);
    expect(first.audio_data?.pcm.length).toBe(13_300 * 16 * 2);
    expect(pipeline.bufferedFrameCount).toBe(1);

    await pipeline.forceFlush(undefined, { ignoreMinDuration: true });
    expect(onSegment).toHaveBeenCalledTimes(2);
    const second: Segment = onSegment.mock.calls[1][0];
    expect(second.frames.map(frame => frame.timestamp)).toEqual([17000]);
    expect(second.segment_id).not.toBe(first.segment_id);
    expect(second.frames[0]?._segment_start_timestamp).toBeUndefined();
  });

  it("keeps late frames before the VAD cut in the previous segment and starts the next segment at the cut", async () => {
    const onSegment = vi.fn().mockResolvedValue(null);
    const pipeline = new CamPipeline(
      { cameraId: "cam", mode: "stream", onSegment, audioUsesPtsClock: true },
      { storageManager: null, segmenters: [new VoiceCutSegmenter()] },
    );

    await pipeline.ingestAudio(Buffer.alloc(20_000 * 16 * 2), [], [], false);
    await pipeline.feedFrame(makeFrame(3000));
    await pipeline.feedFrame(makeFrame(15015));
    await pipeline.updateVoiceState(false, 16_300);
    await pipeline.feedFrame(makeFrame(16016)); // late frame still belongs to the previous segment
    await pipeline.feedFrame(makeFrame(17017));
    await pipeline.forceFlush(undefined, { ignoreMinDuration: true });

    expect(onSegment).toHaveBeenCalledTimes(2);
    const first: Segment = onSegment.mock.calls[0][0];
    const second: Segment = onSegment.mock.calls[1][0];
    expect(first.timestamp).toBe(3000);
    expect(first.duration_sec).toBeCloseTo(13.3, 3);
    expect(first.frames.map(frame => frame.timestamp)).toEqual([3000, 15015, 16016]);
    expect(second.timestamp).toBe(16_300);
    expect(second.frames.map(frame => frame.timestamp)).toEqual([17017]);
    expect(second.audio_data?.pcm.length).toBe(717 * 16 * 2);
    expect(second.duration_sec).toBeCloseTo(0.717, 3);
  });

  it("drops stale frames that arrive after the VAD cut timeout", async () => {
    vi.useFakeTimers();
    const onSegment = vi.fn().mockResolvedValue(null);
    const pipeline = new CamPipeline(
      { cameraId: "cam", mode: "stream", onSegment, audioUsesPtsClock: true },
      { storageManager: null, segmenters: [new VoiceCutSegmenter()] },
    );

    await pipeline.ingestAudio(Buffer.alloc(20_000 * 16 * 2), [], [], false);
    await pipeline.feedFrame(makeFrame(3000));
    await pipeline.feedFrame(makeFrame(15015));
    await pipeline.updateVoiceState(false, 16_300);
    await vi.advanceTimersByTimeAsync(1000);
    await pipeline.feedFrame(makeFrame(16016)); // too late; already flushed by timeout
    await pipeline.feedFrame(makeFrame(17017));
    await pipeline.forceFlush(undefined, { ignoreMinDuration: true });

    expect(onSegment).toHaveBeenCalledTimes(2);
    const first: Segment = onSegment.mock.calls[0][0];
    const second: Segment = onSegment.mock.calls[1][0];
    expect(first.frames.map(frame => frame.timestamp)).toEqual([3000, 15015]);
    expect(second.timestamp).toBe(16_300);
    expect(second.frames.map(frame => frame.timestamp)).toEqual([17017]);
    vi.useRealTimers();
  });

  it("does not let repeated VAD silence events move a pending cut timestamp", async () => {
    vi.useFakeTimers();
    const onSegment = vi.fn().mockResolvedValue(null);
    const pipeline = new CamPipeline(
      { cameraId: "cam", mode: "stream", onSegment, audioUsesPtsClock: true },
      { storageManager: null, segmenters: [new VoiceCutSegmenter()] },
    );

    await pipeline.ingestAudio(Buffer.alloc(20_000 * 16 * 2), [], [], false);
    await pipeline.feedFrame(makeFrame(3000));
    await pipeline.feedFrame(makeFrame(15015));
    await pipeline.updateVoiceState(false, 16_300);
    await pipeline.updateVoiceState(false, 16_800);
    await vi.advanceTimersByTimeAsync(1000);

    expect(onSegment).toHaveBeenCalledTimes(1);
    const first: Segment = onSegment.mock.calls[0][0];
    expect(first.duration_sec).toBeCloseTo(13.3, 3);
    expect(first.audio_data?.pcm.length).toBe(13_300 * 16 * 2);
    vi.useRealTimers();
  });

  it("snapshot mode: void onSegment path never triggered — Promise onSegment calls onResult", async () => {
    // Confirms the snapshot path still awaits and forwards result
    const mockResult = { segment_id: "seg_snap", camera_id: "cam" };
    const onSegment = vi.fn().mockResolvedValue(mockResult);
    const onResult = vi.fn();

    const pipeline = new CamPipeline(
      { cameraId: "cam", mode: "snapshot", onSegment, onResult },
      { storageManager: null, segmenters: [] },
    );

    await pipeline.feedFrame(makeFrame());
    expect(onResult).toHaveBeenCalledWith(mockResult);
  });
});
