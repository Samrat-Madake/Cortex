import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type QaSample = {
  questionId: string;
  prediction: string;
  answer: string;
  correct: boolean;
  status?: string;
  answerMode?: string;
  failureReason?: string;
  datasetMetadata?: Record<string, unknown>;
  traceDiagnostics?: Record<string, unknown>;
  datasetName?: string;
  snapshotVersion?: string;
  qaRunVersion?: string;
  runId?: string;
  sourcePath?: string;
};

export type QaComparisonRow = {
  questionId: string;
  status: "improved" | "regressed" | "unchanged" | "missing_baseline";
  current: QaSample;
  baseline?: QaSample;
};

export type QaComparisonSummary = {
  currentCorrect: number;
  currentTotal: number;
  baselineCorrect: number;
  baselineOverlap: number;
  improved: number;
  regressed: number;
  unchanged: number;
  missingBaseline: number;
};

export type QaComparisonGroupSummary = QaComparisonSummary & {
  group: string;
};

export type QaComparison = {
  rows: QaComparisonRow[];
  summary: QaComparisonSummary;
  metadata: {
    current: QaRunMetadata;
    baseline: QaRunMetadata;
  };
};

export type QaComparisonDetailMode = "all" | "changed" | "none";
export type QaComparisonStatusFilter = QaComparisonRow["status"] | "changed" | "all";

type RawRecord = Record<string, unknown>;

export type QaRunMetadata = {
  datasetNames: string[];
  snapshotVersions: string[];
  qaRunVersions: string[];
  runIds: string[];
};

function asRecord(value: unknown): RawRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RawRecord : {};
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function boolFromScore(value: unknown): boolean {
  if (typeof value === "number") return value === 1;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value === "1" || value.toLowerCase() === "true";
  return false;
}

function normalizedDatasetMetadata(record: RawRecord, metric: RawRecord): Record<string, unknown> | undefined {
  const submission = asRecord(record.submission);
  const metadata = {
    ...asRecord(metric.dataset_metadata),
    ...asRecord(record.dataset_metadata),
  };
  for (const key of ["task_type", "task_category", "domain", "category", "sub_category", "duration", "videoID", "url"]) {
    if (metadata[key] === undefined && record[key] !== undefined) metadata[key] = record[key];
    if (metadata[key] === undefined && metric[key] !== undefined) metadata[key] = metric[key];
  }
  if (metadata.task_type === undefined && metadata.task_category !== undefined) {
    metadata.task_type = metadata.task_category;
  }
  if (metadata.domain === undefined && metadata.category !== undefined) {
    metadata.domain = metadata.category;
  }
  if (metadata.task_type === undefined && submission.type !== undefined) {
    metadata.task_type = Array.isArray(submission.type)
      ? submission.type.map(value => firstString(value)).filter(Boolean).join(",")
      : firstString(submission.type);
  }
  if (metadata.videoID === undefined && submission.video_id !== undefined) {
    metadata.videoID = submission.video_id;
  }
  if (metadata.timestamp === undefined && submission.timestamp !== undefined) {
    metadata.timestamp = submission.timestamp;
  }
  return Object.keys(metadata).length ? metadata : undefined;
}

export function parseQaSample(raw: unknown, sourcePath?: string): QaSample | null {
  const record = asRecord(raw);
  const metric = asRecord(record.videomme_perception_score);
  const submission = asRecord(record.submission);
  const questionId = firstString(metric.question_id, record.question_id, submission.question_id, record.doc_id);
  if (!questionId) return null;
  const prediction = firstString(metric.pred_answer, record.filtered_resps, record.pred_answer, record.prediction, submission.prediction);
  const answer = firstString(metric.answer, record.target, record.gt_answer, record.answer, submission.answer);
  return {
    questionId,
    prediction,
    answer,
    correct: boolFromScore(metric.score ?? record.score ?? record.correct ?? record.m3_bench_contains ?? record.m3_bench_exact_match),
    status: firstString(record.status, metric.status) || undefined,
    answerMode: firstString(record.answer_mode, metric.answer_mode) || undefined,
    failureReason: firstString(record.failure_reason, metric.failure_reason) || undefined,
    datasetMetadata: normalizedDatasetMetadata(record, metric),
    traceDiagnostics: Object.keys(asRecord(record.trace_diagnostics)).length
      ? asRecord(record.trace_diagnostics)
      : Object.keys(asRecord(metric.trace_diagnostics)).length
        ? asRecord(metric.trace_diagnostics)
        : undefined,
    datasetName: firstString(record.dataset_name, record.dataset, metric.dataset_name),
    snapshotVersion: firstString(record.snapshot_version, metric.snapshot_version),
    qaRunVersion: firstString(record.qa_run_version, metric.qa_run_version),
    runId: firstString(record.run_id, metric.run_id),
    sourcePath,
  };
}

export function readQaSamplesJsonl(path: string): QaSample[] {
  const samples: QaSample[] = [];
  const content = readFileSync(path, "utf8");
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const sample = parseQaSample(JSON.parse(line), path);
      if (sample) samples.push(sample);
    } catch (error) {
      throw new Error(`Failed to parse JSONL ${path}:${index + 1}: ${String(error)}`);
    }
  }
  return samples;
}

export function findQaSampleFiles(path: string, qaRunVersion?: string): string[] {
  if (!existsSync(path)) throw new Error(`Path not found: ${path}`);
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) return [];

  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.isFile() && isQaSampleFile(child) && matchesQaRunVersion(child, qaRunVersion)) {
        out.push(child);
      }
    }
  };
  walk(path);
  return out.sort();
}

function matchesQaRunVersion(path: string, qaRunVersion?: string): boolean {
  if (!qaRunVersion) return true;
  if (path.includes(`/qa_runs/${qaRunVersion}/`) || path.includes(`\\qa_runs\\${qaRunVersion}\\`)) {
    return true;
  }
  let dir = dirname(path);
  for (let depth = 0; depth < 8; depth++) {
    const workerMeta = join(dir, "worker_meta.json");
    if (metadataFileMatchesQaRunVersion(workerMeta, qaRunVersion)) return true;
    const runtimeManifest = join(dir, "runtime_manifest.json");
    if (metadataFileMatchesQaRunVersion(runtimeManifest, qaRunVersion)) return true;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

function metadataFileMatchesQaRunVersion(path: string, qaRunVersion: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const metadata = asRecord(JSON.parse(readFileSync(path, "utf8")));
    return firstString(metadata.qa_run_version) === qaRunVersion;
  } catch {
    return false;
  }
}

function isQaSampleFile(path: string): boolean {
  const name = basename(path);
  return name.endsWith(".jsonl") && (name.includes("_samples_") || name === "qa_results.jsonl");
}

export function readQaSamples(paths: string[], qaRunVersion?: string): QaSample[] {
  const files = paths.flatMap((path) => findQaSampleFiles(path, qaRunVersion));
  return files.flatMap(readQaSamplesJsonl);
}

function samplesByQuestion(samples: QaSample[]): Map<string, QaSample> {
  const byId = new Map<string, QaSample>();
  for (const sample of samples) {
    const existing = byId.get(sample.questionId);
    byId.set(sample.questionId, existing ? mergeQaSample(existing, sample) : sample);
  }
  return byId;
}

function mergeRecords(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const merged = { ...asRecord(left), ...asRecord(right) };
  return Object.keys(merged).length ? merged : undefined;
}

function mergeQaSample(left: QaSample, right: QaSample): QaSample {
  return {
    ...left,
    ...right,
    datasetMetadata: mergeRecords(left.datasetMetadata, right.datasetMetadata),
    traceDiagnostics: mergeRecords(left.traceDiagnostics, right.traceDiagnostics),
    status: right.status || left.status,
    answerMode: right.answerMode || left.answerMode,
    failureReason: right.failureReason || left.failureReason,
    datasetName: right.datasetName || left.datasetName,
    snapshotVersion: right.snapshotVersion || left.snapshotVersion,
    qaRunVersion: right.qaRunVersion || left.qaRunVersion,
    runId: right.runId || left.runId,
    sourcePath: right.traceDiagnostics ? right.sourcePath : left.sourcePath ?? right.sourcePath,
  };
}

function uniqueSorted(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
}

export function summarizeQaRunMetadata(samples: QaSample[]): QaRunMetadata {
  return {
    datasetNames: uniqueSorted(samples.map(sample => sample.datasetName)),
    snapshotVersions: uniqueSorted(samples.map(sample => sample.snapshotVersion)),
    qaRunVersions: uniqueSorted(samples.map(sample => sample.qaRunVersion)),
    runIds: uniqueSorted(samples.map(sample => sample.runId)),
  };
}

function addRowToSummary(summary: QaComparisonSummary, row: QaComparisonRow): void {
  summary.currentTotal++;
  if (row.current.correct) summary.currentCorrect++;
  if (row.baseline) {
    summary.baselineOverlap++;
    if (row.baseline.correct) summary.baselineCorrect++;
  }
  if (row.status === "improved") summary.improved++;
  if (row.status === "regressed") summary.regressed++;
  if (row.status === "unchanged") summary.unchanged++;
  if (row.status === "missing_baseline") summary.missingBaseline++;
}

function emptySummary(): QaComparisonSummary {
  return {
    currentCorrect: 0,
    currentTotal: 0,
    baselineCorrect: 0,
    baselineOverlap: 0,
    improved: 0,
    regressed: 0,
    unchanged: 0,
    missingBaseline: 0,
  };
}

function rowsForDetailMode(comparison: QaComparison, detailMode: QaComparisonDetailMode): QaComparisonRow[] {
  if (detailMode === "none") return [];
  if (detailMode === "changed") return comparison.rows.filter((row) => row.status !== "unchanged");
  return comparison.rows;
}

export function applyQaComparisonDetailMode(
  comparison: QaComparison,
  detailMode: QaComparisonDetailMode,
): QaComparison {
  return detailMode === "all" ? comparison : { ...comparison, rows: rowsForDetailMode(comparison, detailMode) };
}

function summaryForRows(rows: QaComparisonRow[]): QaComparisonSummary {
  return rows.reduce((summary, row) => {
    addRowToSummary(summary, row);
    return summary;
  }, emptySummary());
}

export function applyQaComparisonStatusFilter(
  comparison: QaComparison,
  statusFilter: QaComparisonStatusFilter,
): QaComparison {
  if (statusFilter === "all") return comparison;
  const rows = comparison.rows.filter((row) => (
    statusFilter === "changed" ? row.status !== "unchanged" : row.status === statusFilter
  ));
  return {
    ...comparison,
    rows,
    summary: summaryForRows(rows),
  };
}

export function compareQaSamples(current: QaSample[], baseline: QaSample[], questionIds?: string[]): QaComparison {
  const currentById = samplesByQuestion(current);
  const baselineById = samplesByQuestion(baseline);
  const ids = (questionIds?.length ? questionIds : [...currentById.keys()]).filter((id) => currentById.has(id)).sort();
  const rows: QaComparisonRow[] = [];
  for (const questionId of ids) {
    const currentSample = currentById.get(questionId);
    if (!currentSample) continue;
    const baselineSample = baselineById.get(questionId);
    if (!baselineSample) {
      rows.push({ questionId, status: "missing_baseline", current: currentSample });
      continue;
    }
    const status = currentSample.correct === baselineSample.correct
      ? "unchanged"
      : currentSample.correct ? "improved" : "regressed";
    rows.push({ questionId, status, current: currentSample, baseline: baselineSample });
  }

  return {
    rows,
    summary: summaryForRows(rows),
    metadata: {
      current: summarizeQaRunMetadata(current),
      baseline: summarizeQaRunMetadata(baseline),
    },
  };
}

function fieldValueFromSample(sample: QaSample | undefined, fieldPath: string): string {
  if (!sample) return "";
  const normalizedPath = fieldPath
    .replace(/^dataset_metadata\./, "datasetMetadata.")
    .replace(/^dataset_name$/, "datasetName")
    .replace(/^snapshot_version$/, "snapshotVersion")
    .replace(/^qa_run_version$/, "qaRunVersion")
    .replace(/^run_id$/, "runId")
    .replace(/^trace_diagnostics\./, "traceDiagnostics.");
  const parts = normalizedPath.split(".").filter(Boolean);
  let value: unknown = sample;
  for (const part of parts) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return "";
    value = (value as Record<string, unknown>)[part];
  }
  if (Array.isArray(value)) {
    return value
      .map(item => firstString(item))
      .filter(Boolean)
      .sort()
      .join(",");
  }
  return firstString(value);
}

export function summarizeQaComparisonByField(
  comparison: QaComparison,
  fieldPath: string,
  unknownLabel = "(unknown)",
): QaComparisonGroupSummary[] {
  const byGroup = new Map<string, QaComparisonSummary>();
  for (const row of comparison.rows) {
    const group = fieldValueFromSample(row.current, fieldPath)
      || fieldValueFromSample(row.baseline, fieldPath)
      || unknownLabel;
    const summary = byGroup.get(group) ?? emptySummary();
    addRowToSummary(summary, row);
    byGroup.set(group, summary);
  }
  return [...byGroup.entries()]
    .map(([group, summary]) => ({ group, ...summary }))
    .sort((a, b) => b.currentTotal - a.currentTotal || a.group.localeCompare(b.group));
}

function formatMetadata(label: string, metadata: QaRunMetadata): string[] {
  const parts = [
    metadata.qaRunVersions.length ? `qa_run=${metadata.qaRunVersions.join(",")}` : "",
    metadata.snapshotVersions.length ? `snapshot=${metadata.snapshotVersions.join(",")}` : "",
    metadata.datasetNames.length ? `dataset=${metadata.datasetNames.join(",")}` : "",
  ].filter(Boolean);
  return parts.length ? [`${label} metadata: ${parts.join(" ")}`] : [];
}

function formatQaComparisonRows(comparison: QaComparison, detailMode: QaComparisonDetailMode): string[] {
  if (detailMode === "none") return [];
  const rows = rowsForDetailMode(comparison, detailMode);
  return [
    "question_id\tstatus\tbaseline\tcurrent",
    ...rows.map((row) => {
      const base = row.baseline
        ? `${row.baseline.correct ? "T" : "F"} pred=${row.baseline.prediction} gt=${row.baseline.answer}`
        : "missing";
      const cur = `${row.current.correct ? "T" : "F"} pred=${row.current.prediction} gt=${row.current.answer}`;
      return `${row.questionId}\t${row.status}\t${base}\t${cur}`;
    }),
    "",
  ];
}

function sampleHasAnswerStatus(sample: QaSample): boolean {
  return Boolean(sample.status || sample.answerMode || sample.failureReason);
}

function isIncompleteSample(sample: QaSample): boolean {
  return sample.status === "incomplete" || sample.answerMode === "unable" || Boolean(sample.failureReason);
}

function formatIncompleteStats(label: string, samples: QaSample[]): string[] {
  if (!samples.some(sampleHasAnswerStatus)) return [];
  const incomplete = samples.filter(isIncompleteSample).length;
  const complete = samples.length - incomplete;
  const completeCorrect = samples.filter(sample => !isIncompleteSample(sample) && sample.correct).length;
  return [
    `${label} incomplete: ${incomplete}/${samples.length}`,
    `${label} excluding incomplete: ${completeCorrect}/${complete}`,
  ];
}

export function formatQaComparisonText(
  comparison: QaComparison,
  detailMode: QaComparisonDetailMode = "all",
): string {
  const currentSamples = comparison.rows.map(row => row.current);
  const baselineSamples = comparison.rows
    .map(row => row.baseline)
    .filter((sample): sample is QaSample => Boolean(sample));
  const lines = [
    ...formatMetadata("current", comparison.metadata.current),
    ...formatMetadata("baseline", comparison.metadata.baseline),
    ...formatQaComparisonRows(comparison, detailMode),
    `current: ${comparison.summary.currentCorrect}/${comparison.summary.currentTotal}`,
    ...formatIncompleteStats("current", currentSamples),
    `baseline overlap: ${comparison.summary.baselineCorrect}/${comparison.summary.baselineOverlap}`,
    ...formatIncompleteStats("baseline overlap", baselineSamples),
    `delta: +${comparison.summary.improved} / -${comparison.summary.regressed} / =${comparison.summary.unchanged}`
      + (comparison.summary.missingBaseline ? ` / missing_baseline=${comparison.summary.missingBaseline}` : ""),
  ];
  return lines.join("\n");
}

export function formatQaComparisonGroupText(groups: QaComparisonGroupSummary[], fieldPath: string): string {
  const lines = [
    `group_by=${fieldPath}`,
    "group\tcurrent\tbaseline_overlap\tdelta",
    ...groups.map((group) => [
      group.group,
      `${group.currentCorrect}/${group.currentTotal}`,
      `${group.baselineCorrect}/${group.baselineOverlap}`,
      `+${group.improved} / -${group.regressed} / =${group.unchanged}`
        + (group.missingBaseline ? ` / missing_baseline=${group.missingBaseline}` : ""),
    ].join("\t")),
  ];
  return lines.join("\n");
}

function getFlagValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== name) continue;
    const value = args[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    values.push(value);
    i++;
  }
  return values;
}

export function runQaCompareCli(args = process.argv.slice(2)): void {
  const currentPaths = getFlagValues(args, "--current");
  const baselinePaths = getFlagValues(args, "--baseline");
  const questionIds = getFlagValues(args, "--question-ids")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const currentQaRunVersion = getFlagValues(args, "--current-qa-run-version")[0];
  const baselineQaRunVersion = getFlagValues(args, "--baseline-qa-run-version")[0];
  const format = getFlagValues(args, "--format")[0] ?? "text";
  const groupBy = getFlagValues(args, "--group-by")[0];
  const detailMode = parseDetailMode(getFlagValues(args, "--details")[0] ?? "all");
  const statusFilter = parseStatusFilter(getFlagValues(args, "--status")[0] ?? "all");
  if (!currentPaths.length || !baselinePaths.length) {
    throw new Error("Usage: qa-run-compare --current PATH [--current PATH...] --baseline PATH [--baseline PATH...] [--current-qa-run-version VERSION] [--baseline-qa-run-version VERSION] [--question-ids 603-3,617-2] [--status all|changed|improved|regressed|unchanged|missing_baseline] [--group-by dataset_metadata.task_type] [--details all|changed|none] [--format text|json]");
  }
  const comparison = applyQaComparisonStatusFilter(compareQaSamples(
    readQaSamples(currentPaths, currentQaRunVersion),
    readQaSamples(baselinePaths, baselineQaRunVersion),
    questionIds,
  ), statusFilter);
  const groupSummary = groupBy ? summarizeQaComparisonByField(comparison, groupBy) : undefined;
  if (format === "json") {
    const outputComparison = applyQaComparisonDetailMode(comparison, detailMode);
    process.stdout.write(`${JSON.stringify(groupSummary ? { ...outputComparison, groupBy, groupSummary } : outputComparison, null, 2)}\n`);
  } else if (format === "text") {
    process.stdout.write(`${formatQaComparisonText(comparison, detailMode)}${groupSummary ? `\n\n${formatQaComparisonGroupText(groupSummary, groupBy!)}` : ""}\n`);
  } else {
    throw new Error(`Unsupported --format: ${format}`);
  }
}

function parseDetailMode(value: string): QaComparisonDetailMode {
  if (value === "all" || value === "changed" || value === "none") return value;
  throw new Error(`Unsupported --details: ${value}`);
}

function parseStatusFilter(value: string): QaComparisonStatusFilter {
  if (
    value === "all"
    || value === "changed"
    || value === "improved"
    || value === "regressed"
    || value === "unchanged"
    || value === "missing_baseline"
  ) {
    return value;
  }
  throw new Error(`Unsupported --status: ${value}`);
}

const isCli = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (isCli) {
  try {
    runQaCompareCli();
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    process.exitCode = 1;
  }
}
