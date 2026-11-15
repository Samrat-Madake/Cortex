import { describe, expect, it } from "vitest";
import { generateReport, type ReportData } from "../../eval/video-runner/report-generator.js";

function makeReportData(overrides: Partial<ReportData> = {}): ReportData {
  return {
    startTime: new Date("2026-03-31T00:00:00.000Z"),
    endTime: new Date("2026-03-31T00:00:05.000Z"),
    videoFile: "sample.mp4",
    assertions: [
      {
        id: 1,
        category: "Timing",
        name: "example",
        passed: true,
        details: "ok",
        severity: "required",
      },
    ],
    skillTests: [],
    timeline: [
      {
        timeRange: "00:00-00:05",
        segmentId: "seg_1",
        entities: [],
        rulesFired: [],
        fps: 1,
        vlmEnabled: true,
        agentConsulted: false,
      },
    ],
    detailedTimeline: [],
    memoryVerification: {
      episodicCount: 0,
      episodicSearchable: false,
      semanticCount: 0,
      reidUpserted: 0,
      reidSearchMatched: false,
      expireMediaVerified: false,
    },
    vlmStats: {
      totalSegments: 1,
      vlmSkippedSegments: 0,
      geminiApiCalls: { vlm: 0, agent: 0, skill: 0 },
    },
    ...overrides,
  };
}

describe("generateReport", () => {
  it("describes timeline ranges relative to media origin", () => {
    const report = generateReport(makeReportData());
    expect(report).toContain("Time range is relative to the media origin for this run (first frame when available).");
    expect(report).not.toContain("first built segment");
  });
});
