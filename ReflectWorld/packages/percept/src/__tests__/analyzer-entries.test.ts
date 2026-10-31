// packages/percept/src/__tests__/analyzer-entries.test.ts
import { describe, it, expect } from "vitest";
import { runDetection } from "../analyzers/detection-entry.js";
import type { Frame } from "@reflectworld/shared";

const DUMMY_FRAMES: Frame[] = [
  { data: "base64frame", timestamp: Date.now(), index: 0 },
];

describe("Analyzer entries", () => {
  it("detection stub returns available=false with install hint", async () => {
    const result = await runDetection(DUMMY_FRAMES);
    expect(result.available).toBe(false);
    expect(result.analyzer).toBe("detection");
    expect(result.error).toContain("frame.detections");
    expect(result.data).toBeUndefined();
    expect(result.latency_ms).toBe(0);
  });

});
