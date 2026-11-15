import { afterEach, describe, expect, it, vi } from "vitest";
import { ElevenLabsStt } from "../analyzers/elevenlabs-stt.js";
import type { AudioData } from "@cortex/shared";

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;

function makeAudioData(durationMs: number, voiceRanges: AudioData["voice_ranges"]): AudioData {
  return {
    pcm: Buffer.alloc(Math.ceil(durationMs / 1000 * SAMPLE_RATE) * BYTES_PER_SAMPLE),
    voice_ranges: voiceRanges,
  };
}

function mockFetchJson(payload: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function multipartBody(fetchMock: ReturnType<typeof mockFetchJson>): Buffer {
  return fetchMock.mock.calls[0]?.[1]?.body as Buffer;
}

function multipartBodyText(fetchMock: ReturnType<typeof mockFetchJson>): string {
  return multipartBody(fetchMock).toString("utf8");
}

function wavDataSize(body: Buffer): number {
  const riffOffset = body.indexOf(Buffer.from("RIFF"));
  expect(riffOffset).toBeGreaterThanOrEqual(0);
  return body.readUInt32LE(riffOffset + 40);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ElevenLabsStt", () => {
  it("merges voice ranges into one continuous audio window and remaps segment timestamps", async () => {
    const fetchMock = mockFetchJson({
      text: "hello world",
      segments: [
        { text: "hello", start: 0.2, end: 0.7, speaker_id: "speaker_0" },
        { text: "world", start: 1.8, end: 2.2, speaker_id: "speaker_1" },
      ],
    });
    const stt = new ElevenLabsStt({ apiKey: "test-key" });

    const result = await stt.transcribeAudioData(makeAudioData(5000, [
      { start_ms: 1000, end_ms: 1800 },
      { start_ms: 3000, end_ms: 3600 },
    ]));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(wavDataSize(multipartBody(fetchMock))).toBe(2600 / 1000 * SAMPLE_RATE * BYTES_PER_SAMPLE);
    expect(multipartBodyText(fetchMock)).toMatch(/name="timestamps_granularity"[\s\S]*?\r\n\r\nword\r\n/);
    expect(multipartBodyText(fetchMock)).toMatch(/name="diarize"[\s\S]*?\r\n\r\ntrue\r\n/);
    expect(result.transcript).toBe("hello world");
    expect(result.segments).toEqual([
      {
        start: Math.round(1.2 * SAMPLE_RATE),
        end: Math.round(1.7 * SAMPLE_RATE),
        text: "hello",
        speaker: "speaker_0",
        latency_ms: 0,
      },
      {
        start: Math.round(2.8 * SAMPLE_RATE),
        end: Math.round(3.2 * SAMPLE_RATE),
        text: "world",
        speaker: "speaker_1",
        latency_ms: 0,
      },
    ]);
  });

  it("falls back to the merged voice window when no timestamp details are returned", async () => {
    const fetchMock = mockFetchJson({ text: "plain transcript" });
    const stt = new ElevenLabsStt({ apiKey: "test-key" });

    const result = await stt.transcribeAudioData(makeAudioData(4000, [
      { start_ms: 500, end_ms: 2500 },
    ]));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      transcript: "plain transcript",
      segments: [{ start: 8000, end: 40000, text: "plain transcript", latency_ms: 0 }],
    });
  });

  it("does not call the API when no voice range exists", async () => {
    const fetchMock = mockFetchJson({ text: "" });
    const stt = new ElevenLabsStt({ apiKey: "test-key" });

    const result = await stt.transcribeAudioData(makeAudioData(2000, []));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ transcript: "", segments: [] });
  });
});
