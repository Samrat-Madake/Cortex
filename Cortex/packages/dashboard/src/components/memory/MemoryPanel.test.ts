import { describe, expect, it } from "vitest";
import { formatMemoryRange } from "./MemoryPanel";

describe("formatMemoryRange", () => {
  it("formats uploaded video ranges on the media timeline", () => {
    expect(formatMemoryRange({
      timestamp: 0,
      start_ms: 42_750,
      end_ms: 52_250,
    })).toBe("00:42 - 00:52");
  });

  it("formats live ranges as wall-clock time instead of media duration", () => {
    const start = Date.UTC(2026, 5, 4, 10, 0, 0);
    const expectedStart = new Date(start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const expectedEnd = new Date(start + 10_000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

    expect(formatMemoryRange({
      timestamp: start,
      start_ms: start,
      end_ms: start + 10_000,
    })).toBe(`${expectedStart} - ${expectedEnd}`);
  });

  it("removes fractional seconds from legacy source labels", () => {
    expect(formatMemoryRange({
      timestamp: 0,
      source_time_label: "00:00:42.750-00:00:52.250",
    })).toBe("00:42 - 00:52");
  });
});
