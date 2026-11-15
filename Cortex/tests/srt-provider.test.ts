import { describe, it, expect } from "vitest";
import { parseSrt, sliceSrtToSttOutput, type SrtEntry } from "../eval/benchmark/pipeline/srt-provider.js";
import type { SttOutput } from "@cortex/percept";

describe("parseSrt", () => {
  it("parses standard SRT with HTML font tags", () => {
    const srt = [
      "1",
      "00:00:03,680 --> 00:00:07,100",
      '<font color="white" size=".72c">Walsh to daily</font>',
      "",
      "2",
      "00:00:07,140 --> 00:00:12,300",
      '<font color="white" size=".72c">now Lauren James</font>',
      "",
    ].join("\n");
    const entries = parseSrt(srt);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ startMs: 3680, endMs: 7100, text: "Walsh to daily" });
    expect(entries[1]).toEqual({ startMs: 7140, endMs: 12300, text: "now Lauren James" });
  });

  it("filters noise-only entries but keeps mixed text", () => {
    const srt = [
      "1", "00:00:00,000 --> 00:00:05,000", "[Music]", "",
      "2", "00:00:05,000 --> 00:00:10,000", "(applause)", "",
      "3", "00:00:10,000 --> 00:00:15,000", "♪ la la la ♪", "",
      "4", "00:00:15,000 --> 00:00:20,000", "[John] hello there", "",
      "5", "00:00:20,000 --> 00:00:25,000", "actual speech", "",
    ].join("\n");
    const entries = parseSrt(srt);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.text).toBe("[John] hello there");
    expect(entries[1]!.text).toBe("actual speech");
  });

  it("handles multi-line subtitle text", () => {
    const srt = ["1", "00:01:00,000 --> 00:01:05,000", "first line", "second line", ""].join("\n");
    const entries = parseSrt(srt);
    expect(entries[0]!.text).toBe("first line second line");
  });

  it("handles UTF-8 BOM", () => {
    const srt = "\uFEFF1\n00:00:01,000 --> 00:00:02,000\nhello\n";
    expect(parseSrt(srt)).toHaveLength(1);
    expect(parseSrt(srt)[0]!.text).toBe("hello");
  });

  it("handles CRLF line endings", () => {
    const srt = "1\r\n00:00:01,000 --> 00:00:02,000\r\nhello\r\n\r\n";
    expect(parseSrt(srt)).toHaveLength(1);
  });

  it("handles dot-millisecond timestamps (00:00:01.234)", () => {
    const srt = "1\n00:00:01.234 --> 00:00:02.567\nhello\n";
    expect(parseSrt(srt)[0]).toEqual({ startMs: 1234, endMs: 2567, text: "hello" });
  });

  it("ignores position settings after timestamp", () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,000 position:10% line:90%\nhello\n";
    expect(parseSrt(srt)[0]).toEqual({ startMs: 1000, endMs: 2000, text: "hello" });
  });

  it("skips entries with invalid timestamps (no NaN)", () => {
    const srt = "1\ngarbage --> also_garbage\nhello\n\n2\n00:00:01,000 --> 00:00:02,000\nworld\n";
    const entries = parseSrt(srt);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toBe("world");
  });

  it("skips entries where endMs <= startMs", () => {
    const srt = [
      "1", "00:00:05,000 --> 00:00:03,000", "reversed", "",
      "2", "00:00:01,000 --> 00:00:01,000", "zero duration", "",
      "3", "00:00:02,000 --> 00:00:04,000", "valid", "",
    ].join("\n");
    const entries = parseSrt(srt);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toBe("valid");
  });

  it("decodes HTML entities", () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nTom &amp; Jerry\n";
    expect(parseSrt(srt)[0]!.text).toBe("Tom & Jerry");
  });

  it("returns empty array for empty or whitespace input", () => {
    expect(parseSrt("")).toEqual([]);
    expect(parseSrt("  \n\n  ")).toEqual([]);
  });
});

describe("sliceSrtToSttOutput", () => {
  const entries: SrtEntry[] = [
    { startMs: 0, endMs: 5000, text: "first entry" },
    { startMs: 4000, endMs: 10000, text: "second entry" },
    { startMs: 14000, endMs: 20000, text: "cross boundary" },
    { startMs: 15000, endMs: 18000, text: "next segment" },
    { startMs: 25000, endMs: 30000, text: "much later" },
  ];

  it("assigns entries by startMs ownership (no duplicates)", () => {
    const seg1 = sliceSrtToSttOutput(entries, 0, 15000);
    const seg2 = sliceSrtToSttOutput(entries, 15000, 30000);
    expect(seg1.transcript).toBe("first entry second entry cross boundary");
    expect(seg1.segments).toHaveLength(3);
    expect(seg2.transcript).toBe("next segment much later");
    expect(seg2.segments).toHaveLength(2);
  });

  it("clamps end time to segment boundary", () => {
    const seg1 = sliceSrtToSttOutput(entries, 0, 15000);
    const crossEntry = seg1.segments[2]!;
    expect(crossEntry.start).toBe(224000);
    expect(crossEntry.end).toBe(240000);
  });

  it("clamps start time to 0 for entries starting before segment", () => {
    const result = sliceSrtToSttOutput(entries, 5000, 15000);
    expect(result.transcript).toBe("cross boundary");
    expect(result.segments).toHaveLength(1);
  });

  it("returns empty SttOutput when no entries in range (always available, not failure)", () => {
    const result = sliceSrtToSttOutput(entries, 35000, 50000);
    expect(result.transcript).toBe("");
    expect(result.segments).toHaveLength(0);
  });

  it("produces correct sample indices for formatSttForVlm compatibility", () => {
    const result = sliceSrtToSttOutput(entries, 0, 15000);
    const firstStartSec = result.segments[0]!.start / 16000;
    expect(firstStartSec).toBeCloseTo(0.0, 1);
  });

  it("handles empty entries array", () => {
    const result = sliceSrtToSttOutput([], 0, 10000);
    expect(result.transcript).toBe("");
    expect(result.segments).toHaveLength(0);
  });
});
