// tests/srt-integration.test.ts
// Verify SRT → SttOutput → precomputedStt end-to-end contract.
import { describe, it, expect } from "vitest";
import { parseSrt, sliceSrtToSttOutput } from "../eval/benchmark/pipeline/srt-provider.js";

const FIXTURE_SRT = [
  "1",
  "00:00:01,000 --> 00:00:04,500",
  '<font color="white" size=".72c">Welcome to the show</font>',
  "",
  "2",
  "00:00:05,000 --> 00:00:09,000",
  '<font color="white" size=".72c">[Music]</font>',
  "",
  "3",
  "00:00:10,000 --> 00:00:13,000",
  '<font color="white" size=".72c">Today we will discuss</font>',
  '<font color="white" size=".72c">the latest findings</font>',
  "",
  "4",
  "00:00:16,000 --> 00:00:20,000",
  "in machine learning &amp; AI",
  "",
].join("\n");

describe("SRT → SttOutput integration", () => {
  const entries = parseSrt(FIXTURE_SRT);

  it("parses fixture correctly (filters noise, decodes entities, joins multi-line)", () => {
    expect(entries).toHaveLength(3);
    expect(entries[0]!.text).toBe("Welcome to the show");
    expect(entries[1]!.text).toBe("Today we will discuss the latest findings");
    expect(entries[2]!.text).toBe("in machine learning & AI");
  });

  it("segment [0,15s] owns entries starting in [0,15000)", () => {
    const output = sliceSrtToSttOutput(entries, 0, 15000);
    expect(output.transcript).toBe("Welcome to the show Today we will discuss the latest findings");
    expect(output.segments).toHaveLength(2);
  });

  it("segment [15s,30s] owns entries starting in [15000,30000)", () => {
    const output = sliceSrtToSttOutput(entries, 15000, 30000);
    expect(output.transcript).toBe("in machine learning & AI");
    expect(output.segments).toHaveLength(1);
    expect(output.segments[0]!.start).toBe(16000);
    expect(output.segments[0]!.end).toBe(80000);
  });

  it("segment timing is compatible with formatSttForVlm (start/16000 = seconds)", () => {
    const output = sliceSrtToSttOutput(entries, 0, 15000);
    const firstStartSec = output.segments[0]!.start / 16000;
    expect(firstStartSec).toBeCloseTo(1.0, 1);
  });

  it("empty subtitle gap returns empty SttOutput (available, not failure)", () => {
    const output = sliceSrtToSttOutput(entries, 5000, 9000);
    expect(output.transcript).toBe("");
    expect(output.segments).toHaveLength(0);
  });

  it("precomputedStt callback contract: always returns SttOutput", () => {
    const precomputedStt = (segment: { timestamp: number; duration_sec: number }) => {
      const segStartMs = segment.timestamp;
      const segEndMs = segStartMs + Math.round(segment.duration_sec * 1000);
      return sliceSrtToSttOutput(entries, segStartMs, segEndMs);
    };
    const withSpeech = precomputedStt({ timestamp: 0, duration_sec: 15 });
    expect(withSpeech.transcript.length).toBeGreaterThan(0);
    const noSpeech = precomputedStt({ timestamp: 50000, duration_sec: 15 });
    expect(noSpeech.transcript).toBe("");
    expect(noSpeech.segments).toHaveLength(0);
  });
});
