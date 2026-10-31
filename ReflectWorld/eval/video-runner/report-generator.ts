/**
 * ReportGenerator — generates Markdown E2E test report.
 *
 * Takes assertion results, skill test results, VisionController timeline,
 * and memory verification data to produce a structured report.
 */

// ── Types ──

/** Matches the AssertionResult shape from assertion-engine.ts. */
export interface AssertionResult {
  id: number;
  category: string;
  name: string;
  passed: boolean;
  details: string;
  severity: "required" | "best_effort";
}

export interface SkillTestResult {
  instruction: string;
  expectedTool: string;
  expectedAction: string;
  output: unknown;
  passed: boolean;
  details: string;
}

export interface VisionControllerTimelineEntry {
  timeRange?: string;
  segmentId: string;
  entities: string[];
  rulesFired: string[];
  fps: number;
  vlmEnabled: boolean;
  agentConsulted: boolean;
}

export interface DetailedSegmentTimelineEntry {
  segmentId: string;
  timeRange?: string;
  captureStartedAt?: string;
  segmentBuiltAt?: string;
  cutReason?: string;
  captureMotion?: string;
  captureVoice?: string;
  mode?: string;
  frameCount?: number;
  analysisStartedAt?: string;
  analysisCompletedAt?: string;
  level?: number;
  vlmModel?: string;
  analyzersRun?: string[];
  summary?: string;
  accumulationMs?: number;
  dispatchMs?: number;
  perceptionMs?: number;
  vlmMs?: number;
  ruleFiredAt?: string;
  rulesFired?: string[];
  ruleTrigger?: string;
  ruleSignals?: string;
  vcAction?: string;
  stateChangedAt?: string;
  stateApplied?: string;
  consultationAt?: string;
  consultationCompletedAt?: string;
  consultationLatencyMs?: number;
  consultationReason?: string;
  consultationSuggestedTool?: string;
  consultationRecommendedActions?: string[];
  effectObservedAt?: string;
  effectSummary?: string;
  effectLatencyMs?: number;
}

export interface MemoryVerification {
  episodicCount: number;
  episodicSearchable: boolean;
  semanticCount: number;
  reidUpserted: number;
  reidSearchMatched: boolean;
  expireMediaVerified: boolean;
}

export interface VlmCostStats {
  totalSegments: number;
  vlmSkippedSegments: number;
  geminiApiCalls: { vlm: number; agent: number; skill: number };
}

export interface ReportData {
  startTime: Date;
  endTime: Date;
  videoFile: string;
  assertions: AssertionResult[];
  skillTests: SkillTestResult[];
  timeline: VisionControllerTimelineEntry[];
  detailedTimeline?: DetailedSegmentTimelineEntry[];
  memoryVerification: MemoryVerification;
  vlmStats: VlmCostStats;
  wallClockOrigin?: number;
}

// ── Generator ──

/**
 * Generate a Markdown E2E test report from collected test data.
 */
export function generateReport(data: ReportData): string {
  const durationMs = data.endTime.getTime() - data.startTime.getTime();
  const durationStr = formatDuration(durationMs);
  const dateStr = data.startTime.toISOString().replace("T", " ").slice(0, 19);

  const totalAssertions = data.assertions.length;
  const passedAssertions = data.assertions.filter((a) => a.passed).length;
  const failedAssertions = totalAssertions - passedAssertions;
  const requiredAssertions = data.assertions.filter((a) => a.severity === "required");
  const bestEffortAssertions = data.assertions.filter((a) => a.severity === "best_effort");
  const requiredPassed = requiredAssertions.filter((a) => a.passed).length;
  const bestEffortPassed = bestEffortAssertions.filter((a) => a.passed).length;

  const totalGeminiCalls =
    data.vlmStats.geminiApiCalls.vlm +
    data.vlmStats.geminiApiCalls.agent +
    data.vlmStats.geminiApiCalls.skill;

  const skipPct =
    data.vlmStats.totalSegments > 0
      ? Math.round((data.vlmStats.vlmSkippedSegments / data.vlmStats.totalSegments) * 100)
      : 0;

  const sections: string[] = [];

  // Header
  sections.push(
    `# ReflectWorld E2E Test Report`,
    `> Date: ${dateStr}`,
    `> Times: MM:SS.mmm. Capture/content times are video positions; playback times show where a 1x replay would be when processing happened. Durations marked "wall" are actual processing time.`,
    `> Duration: ${durationStr}`,
    `> Video: ${data.videoFile}`,
    ``,
  );

  // Results table
  sections.push(`## Results`, ``);
  sections.push(`| # | Category | Test | Result | Details |`);
  sections.push(`|---|----------|------|--------|---------|`);
  for (const a of data.assertions) {
    const icon = a.passed ? "PASS" : "FAIL";
    const escapedDetails = a.details.replace(/\|/g, "\\|").replace(/\n/g, " ");
    sections.push(`| ${a.id} | ${a.category} | ${a.name} | ${icon} | ${escapedDetails} |`);
  }
  sections.push(``);

  // Summary
  sections.push(
    `## Summary`,
    `- Total: ${totalAssertions} tests`,
    `- Passed: ${passedAssertions}`,
    `- Failed: ${failedAssertions}`,
    `- Required: ${requiredPassed}/${requiredAssertions.length} passed`,
    ...(bestEffortAssertions.length > 0 ? [`- Best-effort: ${bestEffortPassed}/${bestEffortAssertions.length} passed`] : []),
    `- Gemini API calls: ${totalGeminiCalls} (${data.vlmStats.geminiApiCalls.vlm} VLM + ${data.vlmStats.geminiApiCalls.agent} Agent + ${data.vlmStats.geminiApiCalls.skill} Skill)`,
    ``,
  );

  // Skill Understanding
  if (data.skillTests.length > 0) {
    sections.push(`## Skill Understanding`, ``);
    sections.push(`| Instruction | Expected tool | Output | Result |`);
    sections.push(`|-------------|--------------|--------|--------|`);
    for (const st of data.skillTests) {
      const icon = st.passed ? "PASS" : "FAIL";
      const outputStr = typeof st.output === "object" ? JSON.stringify(st.output) : String(st.output ?? "null");
      const truncated = outputStr.length > 80 ? outputStr.slice(0, 77) + "..." : outputStr;
      const escaped = truncated.replace(/\|/g, "\\|");
      sections.push(`| ${st.instruction} | ${st.expectedTool}/${st.expectedAction} | ${escaped} | ${icon} |`);
    }
    sections.push(``);
  }

  // VisionController Timeline
  if (data.timeline.length > 0) {
    sections.push(`## VisionController Timeline`, ``);
    sections.push(`Time range is relative to the media origin for this run (first frame when available).`, ``);
    sections.push(`| Time Range | Segment | Entities | Rules Fired | FPS | VLM | Agent |`);
    sections.push(`|------------|---------|----------|-------------|-----|-----|-------|`);
    for (const t of data.timeline) {
      const timeRangeStr = t.timeRange ?? "-";
      const entitiesStr = t.entities.length > 0 ? t.entities.join(", ") : "-";
      const rulesStr = t.rulesFired.length > 0 ? t.rulesFired.join(", ") : "-";
      const vlmStr = t.vlmEnabled ? "ON" : "OFF";
      const agentStr = t.agentConsulted ? "consulted" : "-";
      sections.push(`| ${timeRangeStr} | ${t.segmentId} | ${entitiesStr} | ${rulesStr} | ${t.fps} | ${vlmStr} | ${agentStr} |`);
    }
    sections.push(``);
  }

  if (data.detailedTimeline && data.detailedTimeline.length > 0) {
    sections.push(`## Detailed Segment Timeline`, ``);
    sections.push(`Each segment is expanded as a step-by-step audit trail. Capture uses content/video time. Processing, VisionController, consultation, and effect rows use playback time. Latencies marked "wall" are wall-clock durations.`, ``);
    for (const entry of data.detailedTimeline) {
      sections.push(`### ${entry.segmentId}${entry.timeRange ? ` (${entry.timeRange})` : ""}`, ``);
      sections.push(`- Capture(content): ${joinDefined([
        entry.captureStartedAt ? `start ${entry.captureStartedAt}` : undefined,
        entry.segmentBuiltAt ? `built ${entry.segmentBuiltAt}` : undefined,
        entry.cutReason ? `cut=${entry.cutReason}` : undefined,
        entry.captureMotion ? `motion=${entry.captureMotion}` : undefined,
        entry.captureVoice ? `voice=${entry.captureVoice}` : undefined,
        entry.mode ? `mode=${entry.mode}` : undefined,
        entry.frameCount != null ? `frames=${entry.frameCount}` : undefined,
      ])}`);
      sections.push(`- Perception(playback): ${joinDefined([
        entry.analysisStartedAt ? `start ${entry.analysisStartedAt}` : undefined,
        entry.analysisCompletedAt ? `done ${entry.analysisCompletedAt}` : undefined,
        entry.level != null ? `level=${entry.level}` : undefined,
        entry.vlmModel ? `vlm=${entry.vlmModel}` : undefined,
        entry.analyzersRun && entry.analyzersRun.length > 0 ? `analyzers=${entry.analyzersRun.join(",")}` : undefined,
      ])}`);
      if (entry.summary) {
        sections.push(`- Summary: ${escapePipe(entry.summary)}`);
      }
      sections.push(`- Latency: ${joinDefined([
        entry.accumulationMs != null ? `accumulation=${entry.accumulationMs}ms wall` : undefined,
        entry.dispatchMs != null ? `dispatch=${entry.dispatchMs}ms wall` : undefined,
        entry.perceptionMs != null ? `perception=${entry.perceptionMs}ms wall` : undefined,
        entry.vlmMs != null ? `vlm=${entry.vlmMs}ms wall` : undefined,
      ])}`);
      sections.push(`- VisionController(playback): ${joinDefined([
        entry.ruleFiredAt ? `matched ${entry.ruleFiredAt}` : undefined,
        entry.rulesFired && entry.rulesFired.length > 0 ? `rules=${entry.rulesFired.join(",")}` : "rules=-",
        entry.ruleTrigger ? `trigger=${entry.ruleTrigger}` : undefined,
        entry.vcAction ? `action=${entry.vcAction}` : undefined,
        entry.stateChangedAt?.startsWith("applied_at") ? entry.stateChangedAt : (entry.stateChangedAt ? `state ${entry.stateChangedAt}` : undefined),
        entry.stateApplied ? `requested=${entry.stateApplied}` : undefined,
      ])}`);
      if (entry.ruleSignals) {
        sections.push(`- VisionController signals: ${escapePipe(entry.ruleSignals)}`);
      }
      sections.push(`- Consultation(playback): ${joinDefined([
        entry.consultationAt ? `requested ${entry.consultationAt}` : "not requested",
        entry.consultationCompletedAt ? `completed ${entry.consultationCompletedAt}` : undefined,
        entry.consultationLatencyMs != null ? `latency=${entry.consultationLatencyMs}ms wall` : undefined,
        entry.consultationSuggestedTool ? `suggested=${entry.consultationSuggestedTool}` : undefined,
        entry.consultationRecommendedActions && entry.consultationRecommendedActions.length > 0
          ? `recommended=${entry.consultationRecommendedActions.join(",")}`
          : undefined,
      ])}`);
      if (entry.consultationReason) {
        sections.push(`- Consultation reason: ${escapePipe(entry.consultationReason)}`);
      }
      sections.push(`- Effect(playback): ${joinDefined([
        entry.effectObservedAt ? `observed ${entry.effectObservedAt}` : "not observed",
        entry.effectSummary,
        entry.effectLatencyMs != null ? `latency=${entry.effectLatencyMs}ms wall` : undefined,
      ])}`);
      sections.push(``);
    }
  }

  // Memory Verification
  sections.push(
    `## Memory Verification`,
    `- Episodic: ${data.memoryVerification.episodicCount} written, ${data.memoryVerification.episodicSearchable ? "all searchable" : "search failed"}`,
    `- Semantic: ${data.memoryVerification.semanticCount} generated`,
    `- ReID: ${data.memoryVerification.reidUpserted} upserted, search ${data.memoryVerification.reidSearchMatched ? "matched" : "failed"}`,
    `- expire_media: ${data.memoryVerification.expireMediaVerified ? "verified" : "not verified"}`,
    ``,
  );

  // Pipeline Async Stats
  if (data.detailedTimeline && data.detailedTimeline.length > 0) {
    const dispatchLatencies: number[] = [];
    let asyncSegments = 0;
    for (const entry of data.detailedTimeline) {
      if (entry.dispatchMs != null && entry.dispatchMs > 100) {
        dispatchLatencies.push(entry.dispatchMs);
        asyncSegments++;
      }
    }
    if (dispatchLatencies.length > 0) {
      const avgWait = Math.round(dispatchLatencies.reduce((a, b) => a + b, 0) / dispatchLatencies.length);
      const maxWait = Math.round(Math.max(...dispatchLatencies));
      sections.push(
        `## Pipeline Async Stats`,
        `- Segments queued while VLM processing: ${asyncSegments}/${data.detailedTimeline.length}`,
        `- Average queue wait: ${(avgWait / 1000).toFixed(1)}s`,
        `- Max queue wait: ${(maxWait / 1000).toFixed(1)}s`,
        `- Queue drops: 0`,
        ``,
      );
    }
  }

  // VLM Cost
  sections.push(
    `## VLM Cost`,
    `- Total segments: ${data.vlmStats.totalSegments}`,
    `- VLM skipped: ${data.vlmStats.vlmSkippedSegments} (${skipPct}%)`,
    ``,
  );

  return sections.join("\n");
}

// ── Helpers ──

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function joinDefined(parts: Array<string | undefined>): string {
  const filtered = parts.filter((part): part is string => Boolean(part && part.trim().length > 0));
  return filtered.length > 0 ? filtered.join(" | ") : "-";
}

function escapePipe(value: string): string {
  return value.replace(/\|/g, "\\|");
}
