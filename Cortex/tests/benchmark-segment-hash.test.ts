import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Segment } from "@cortex/shared";
import { CamPipeline, CompositeSegmenter } from "@cortex/cam";
import { splitJpegFramesWithRemainder } from "@cortex/cam";
import type { FrameResult } from "@cortex/cam";

function hashValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function makeFrame(timestamp: number): FrameResult {
  return { data: `frame-${timestamp}`, timestamp, source_name: "benchmark-test" };
}

function segmentFingerprint(segment: Segment): Record<string, unknown> {
  return {
    frame_timestamps: segment.frames.map((frame) => frame.timestamp),
    frame_count: segment.frames.length,
    duration_sec: segment.duration_sec,
    event_hint: segment.event_hint,
    audio_pcm_bytes: segment.audio_data?.pcm.length ?? 0,
    voice_ranges: segment.audio_data?.voice_ranges ?? [],
  };
}

describe("benchmark segmentation hash guard", () => {
  it("locks voice-range clipping for the benchmark-style CamPipeline path", async () => {
    const segments: Segment[] = [];
    const pipeline = new CamPipeline(
      { cameraId: "bench", mode: "stream", audioUsesPtsClock: true, onSegment: async (segment) => { segments.push(segment); return null; } },
      { segmenters: [new CompositeSegmenter({ hardMaxFrames: 3, minDurationMs: 0 })] },
    );

    await pipeline.ingestAudio(Buffer.alloc(6_000 * 16 * 2), [], [], false);
    await pipeline.feedFrame(makeFrame(1_000), { hasMotion: true, hasVoice: true });
    await pipeline.ingestAudio(Buffer.alloc(2_000 * 16 * 2), [], [], true);
    await pipeline.updateVoiceState(true, 2_000);
    await pipeline.feedFrame(makeFrame(2_000), { hasMotion: true, hasVoice: true });
    await pipeline.ingestAudio(Buffer.alloc(2_000 * 16 * 2), [], [], false);
    await pipeline.updateVoiceState(false, 4_000);
    await pipeline.feedFrame(makeFrame(4_000), { hasMotion: true, hasVoice: true });

    expect(segments).toHaveLength(1);
    expect(segmentFingerprint(segments[0]!)).toEqual({
      frame_timestamps: [1000, 2000, 4000],
      frame_count: 3,
      duration_sec: 3,
      event_hint: "hard_max_frames",
      audio_pcm_bytes: 96000,
      voice_ranges: [],
    });
    expect(hashValue(segmentFingerprint(segments[0]!))).toBe(
      "14abbb11f76efc91f8dba6191d0c5206d7360a57ea31fff0c9322e4ae72a0af4",
    );
  });

  it("locks default frame-count hard_max_frames behavior before elapsed-time VAD strategy", () => {
    const seg = new CompositeSegmenter({ hardMaxFrames: 3, minDurationMs: 0 });
    const reasons: Array<string | null> = [];
    reasons.push(seg.feed(makeFrame(0), 0, { hasMotion: true, hasVoice: true })?.reason ?? null);
    reasons.push(seg.feed(makeFrame(1000), 1, { hasMotion: true, hasVoice: true })?.reason ?? null);
    reasons.push(seg.feed(makeFrame(2000), 2, { hasMotion: true, hasVoice: true })?.reason ?? null);

    expect(reasons).toEqual([null, null, "hard_max_frames"]);
    expect(hashValue(reasons)).toBe("e1d9a197c225ac9f7f68254fd3623defda78c48b954b177b9239bb4ba6adb7e7");
  });

  it("locks streaming JPEG SOI+EOI framing with embedded SOI bytes", () => {
    const frameA = Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd8, 0x02, 0xff, 0xd9]);
    const frameB = Buffer.from([0xff, 0xd8, 0x03, 0xff, 0xd9]);
    const partial = Buffer.from([0xff, 0xd8, 0x04]);
    const parsed = splitJpegFramesWithRemainder(Buffer.concat([frameA, frameB, partial]));
    const fingerprint = {
      frames: parsed.frames.map((frame) => frame.toString("hex")),
      remaining: parsed.remaining.toString("hex"),
    };

    expect(fingerprint).toEqual({
      frames: ["ffd801ffd802ffd9", "ffd803ffd9"],
      remaining: "ffd804",
    });
    expect(hashValue(fingerprint)).toBe("16b27e3837c229dc180f1dfcf3d305a74a12327fa4961a5d36689bc2ac8372a9");
  });
});
