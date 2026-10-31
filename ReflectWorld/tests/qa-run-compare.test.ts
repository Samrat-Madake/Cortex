import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  applyQaComparisonDetailMode,
  applyQaComparisonStatusFilter,
  compareQaSamples,
  findQaSampleFiles,
  formatQaComparisonGroupText,
  formatQaComparisonText,
  parseQaSample,
  readQaSamples,
  summarizeQaComparisonByField,
  summarizeQaRunMetadata,
} from "../eval/benchmark/pipeline/qa-run-compare.js";

function sample(questionId: string, pred: string, answer: string, score: number): string {
  return JSON.stringify({
    filtered_resps: pred,
    target: answer,
    videomme_perception_score: {
      question_id: questionId,
      pred_answer: pred,
      answer,
      score,
    },
  });
}

describe("QA run comparison helpers", () => {
  it("parses VideoMME lmms-eval sample records", () => {
    const parsed = parseQaSample(JSON.parse(sample("603-3", "D", "B", 0)));

    expect(parsed).toEqual(expect.objectContaining({
      questionId: "603-3",
      prediction: "D",
      answer: "B",
      correct: false,
    }));
  });

  it("parses eval-server QA result records", () => {
    const parsed = parseQaSample({
      dataset_name: "reflectworld_videomme_long_subset",
      snapshot_version: "snapshot_a",
      qa_run_version: "qa_run_a",
      run_id: "run_a",
      question_id: "603-3",
      pred_answer: "D",
      gt_answer: "B",
      correct: false,
    });

    expect(parsed).toEqual(expect.objectContaining({
      questionId: "603-3",
      prediction: "D",
      answer: "B",
      correct: false,
      datasetName: "reflectworld_videomme_long_subset",
      snapshotVersion: "snapshot_a",
      qaRunVersion: "qa_run_a",
      runId: "run_a",
      datasetMetadata: undefined,
    }));
  });

  it("parses M3Bench samples using submission question ids and contains score", () => {
    const parsed = parseQaSample({
      doc_id: 5,
      target: "Yoga gets her relaxed.",
      filtered_resps: "Yoga helps her relax.",
      m3_bench_exact_match: 0,
      m3_bench_contains: 1,
      submission: {
        question_id: "living_room_06_Q06",
        video_id: "living_room_06",
        prediction: "Yoga helps her relax.",
        answer: "Yoga gets her relaxed.",
        type: ["Person Understanding"],
        timestamp: "16:10",
      },
    });

    expect(parsed).toEqual(expect.objectContaining({
      questionId: "living_room_06_Q06",
      prediction: "Yoga helps her relax.",
      answer: "Yoga gets her relaxed.",
      correct: true,
      datasetMetadata: {
        task_type: "Person Understanding",
        videoID: "living_room_06",
        timestamp: "16:10",
      },
    }));
  });

  it("parses dataset metadata from eval-server QA result records", () => {
    const parsed = parseQaSample({
      question_id: "674-2",
      pred_answer: "A",
      gt_answer: "B",
      correct: false,
      dataset_metadata: {
        task_type: "Temporal Reasoning",
        domain: "Daily Life",
      },
    });

    expect(parsed).toEqual(expect.objectContaining({
      questionId: "674-2",
      datasetMetadata: {
        task_type: "Temporal Reasoning",
        domain: "Daily Life",
      },
    }));
  });

  it("parses trace diagnostics from eval-server QA result records", () => {
    const parsed = parseQaSample({
      question_id: "674-2",
      pred_answer: "B",
      gt_answer: "A",
      correct: false,
      trace_diagnostics: {
        selected_candidate_status: "refuted",
        candidate_coverage_bucket: "sup0_ref4_unk0_miss0",
      },
    });

    expect(parsed).toEqual(expect.objectContaining({
      questionId: "674-2",
      traceDiagnostics: {
        selected_candidate_status: "refuted",
        candidate_coverage_bucket: "sup0_ref4_unk0_miss0",
      },
    }));
  });

  it("normalizes VideoMME metric categories into dataset metadata", () => {
    const parsed = parseQaSample({
      filtered_resps: "A",
      target: "B",
      videomme_perception_score: {
        question_id: "770-1",
        pred_answer: "A",
        answer: "B",
        score: 0,
        task_category: "Temporal Reasoning",
        category: "Sports Competition",
        sub_category: "Athletics",
        duration: "long",
        videoID: "abc123",
      },
    });

    expect(parsed).toEqual(expect.objectContaining({
      questionId: "770-1",
      datasetMetadata: {
        task_category: "Temporal Reasoning",
        task_type: "Temporal Reasoning",
        category: "Sports Competition",
        domain: "Sports Competition",
        sub_category: "Athletics",
        duration: "long",
        videoID: "abc123",
      },
    }));
  });

  it("compares current samples against baseline by question id", () => {
    const current = [
      parseQaSample(JSON.parse(sample("1-1", "A", "A", 1)))!,
      parseQaSample(JSON.parse(sample("1-2", "B", "A", 0)))!,
      parseQaSample(JSON.parse(sample("1-3", "C", "C", 1)))!,
      parseQaSample(JSON.parse(sample("1-4", "D", "A", 0)))!,
    ];
    const baseline = [
      parseQaSample(JSON.parse(sample("1-1", "B", "A", 0)))!,
      parseQaSample(JSON.parse(sample("1-2", "A", "A", 1)))!,
      parseQaSample(JSON.parse(sample("1-3", "C", "C", 1)))!,
    ];

    const comparison = compareQaSamples(current, baseline);

    expect(comparison.rows.map((row) => [row.questionId, row.status])).toEqual([
      ["1-1", "improved"],
      ["1-2", "regressed"],
      ["1-3", "unchanged"],
      ["1-4", "missing_baseline"],
    ]);
    expect(comparison.summary).toEqual({
      currentCorrect: 2,
      currentTotal: 4,
      baselineCorrect: 2,
      baselineOverlap: 3,
      improved: 1,
      regressed: 1,
      unchanged: 1,
      missingBaseline: 1,
    });
  });

  it("reads sample JSONL files recursively from run directories", () => {
    const root = join(tmpdir(), `qa-run-compare-${process.pid}-${Date.now()}`);
    const nested = join(root, "out", "results.json", "reflectworld");
    mkdirSync(nested, { recursive: true });
    const file = join(nested, "20260512_samples_reflectworld_videomme_long_subset.jsonl");
    writeFileSync(file, `${sample("2-1", "A", "A", 1)}\n`);

    expect(findQaSampleFiles(root)).toEqual([file]);
    expect(readQaSamples([root])).toHaveLength(1);
  });

  it("can filter eval-server artifacts by QA run version", () => {
    const root = join(tmpdir(), `qa-run-compare-runs-${process.pid}-${Date.now()}`);
    const wanted = join(root, "videos", "603", "qa_runs", "wanted", "qa_results.jsonl");
    const other = join(root, "videos", "603", "qa_runs", "other", "qa_results.jsonl");
    mkdirSync(join(root, "videos", "603", "qa_runs", "wanted"), { recursive: true });
    mkdirSync(join(root, "videos", "603", "qa_runs", "other"), { recursive: true });
    writeFileSync(wanted, `${sample("3-1", "A", "A", 1)}\n`);
    writeFileSync(other, `${sample("3-2", "B", "B", 1)}\n`);

    expect(readQaSamples([root], "wanted").map((row) => row.questionId)).toEqual(["3-1"]);
  });

  it("can filter lmms worker sample artifacts by worker metadata QA run version", () => {
    const root = join(tmpdir(), `qa-run-compare-worker-runs-${process.pid}-${Date.now()}`);
    const wantedWorker = join(root, "workers", "worker_a");
    const wantedOut = join(wantedWorker, "run_a", "out", "results.json", "reflectworld");
    const otherWorker = join(root, "workers", "worker_b");
    const otherOut = join(otherWorker, "run_b", "out", "results.json", "reflectworld");
    mkdirSync(wantedOut, { recursive: true });
    mkdirSync(otherOut, { recursive: true });
    writeFileSync(join(wantedWorker, "worker_meta.json"), JSON.stringify({ qa_run_version: "wanted" }));
    writeFileSync(join(otherWorker, "worker_meta.json"), JSON.stringify({ qa_run_version: "other" }));
    writeFileSync(join(wantedOut, "20260513_samples_reflectworld_videomme_long_subset.jsonl"), `${sample("4-1", "A", "A", 1)}\n`);
    writeFileSync(join(otherOut, "20260513_samples_reflectworld_videomme_long_subset.jsonl"), `${sample("4-2", "B", "B", 1)}\n`);

    expect(readQaSamples([root], "wanted").map((row) => row.questionId)).toEqual(["4-1"]);
  });

  it("formats the summary in improved/regressed/unchanged notation", () => {
    const comparison = compareQaSamples(
      [parseQaSample(JSON.parse(sample("1-1", "A", "A", 1)))!],
      [parseQaSample(JSON.parse(sample("1-1", "B", "A", 0)))!],
    );

    expect(formatQaComparisonText(comparison)).toContain("delta: +1 / -0 / =0");
  });

  it("formats incomplete-excluded accuracy when answer status is present", () => {
    const comparison = compareQaSamples(
      [
        parseQaSample({ question_id: "1-1", pred_answer: "A", gt_answer: "A", correct: true, status: "ok", answer_mode: "answer_node" })!,
        parseQaSample({ question_id: "1-2", pred_answer: "", gt_answer: "B", correct: false, status: "incomplete", answer_mode: "unable", failure_reason: "insufficient_evidence" })!,
      ],
      [
        parseQaSample({ question_id: "1-1", pred_answer: "A", gt_answer: "A", correct: true, status: "ok", answer_mode: "answer_node" })!,
        parseQaSample({ question_id: "1-2", pred_answer: "C", gt_answer: "B", correct: false, status: "ok", answer_mode: "answer_node" })!,
      ],
    );

    const formatted = formatQaComparisonText(comparison, "none");
    expect(formatted).toContain("current incomplete: 1/2");
    expect(formatted).toContain("current excluding incomplete: 1/1");
    expect(formatted).toContain("baseline overlap incomplete: 0/2");
    expect(formatted).toContain("baseline overlap excluding incomplete: 1/2");
  });

  it("can suppress or narrow per-question detail rows", () => {
    const comparison = compareQaSamples(
      [
        parseQaSample(JSON.parse(sample("1-1", "A", "A", 1)))!,
        parseQaSample(JSON.parse(sample("1-2", "B", "B", 1)))!,
      ],
      [
        parseQaSample(JSON.parse(sample("1-1", "B", "A", 0)))!,
        parseQaSample(JSON.parse(sample("1-2", "B", "B", 1)))!,
      ],
    );

    expect(formatQaComparisonText(comparison, "none")).not.toContain("question_id\tstatus");
    const changedOnly = formatQaComparisonText(comparison, "changed");
    expect(changedOnly).toContain("1-1\timproved");
    expect(changedOnly).not.toContain("1-2\tunchanged");

    expect(applyQaComparisonDetailMode(comparison, "changed").rows.map(row => row.questionId)).toEqual(["1-1"]);
    expect(applyQaComparisonDetailMode(comparison, "none").rows).toEqual([]);
  });

  it("filters comparison rows and recomputes summaries by status", () => {
    const comparison = compareQaSamples(
      [
        parseQaSample(JSON.parse(sample("1-1", "A", "A", 1)))!,
        parseQaSample(JSON.parse(sample("1-2", "B", "A", 0)))!,
        parseQaSample(JSON.parse(sample("1-3", "C", "C", 1)))!,
        parseQaSample(JSON.parse(sample("1-4", "D", "D", 1)))!,
      ],
      [
        parseQaSample(JSON.parse(sample("1-1", "B", "A", 0)))!,
        parseQaSample(JSON.parse(sample("1-2", "A", "A", 1)))!,
        parseQaSample(JSON.parse(sample("1-3", "C", "C", 1)))!,
      ],
    );

    const regressed = applyQaComparisonStatusFilter(comparison, "regressed");
    expect(regressed.rows.map(row => row.questionId)).toEqual(["1-2"]);
    expect(regressed.summary).toEqual({
      currentCorrect: 0,
      currentTotal: 1,
      baselineCorrect: 1,
      baselineOverlap: 1,
      improved: 0,
      regressed: 1,
      unchanged: 0,
      missingBaseline: 0,
    });

    expect(applyQaComparisonStatusFilter(comparison, "changed").rows.map(row => row.questionId)).toEqual([
      "1-1",
      "1-2",
      "1-4",
    ]);
  });

  it("summarizes and formats run metadata when available", () => {
    const current = parseQaSample({
      question_id: "1-1",
      pred_answer: "A",
      gt_answer: "A",
      correct: true,
      dataset_name: "dataset_a",
      snapshot_version: "snapshot_current",
      qa_run_version: "qa_current",
      run_id: "run_current",
    })!;
    const baseline = parseQaSample({
      question_id: "1-1",
      pred_answer: "B",
      gt_answer: "A",
      correct: false,
      dataset_name: "dataset_a",
      snapshot_version: "snapshot_baseline",
      qa_run_version: "qa_baseline",
      run_id: "run_baseline",
    })!;

    expect(summarizeQaRunMetadata([current])).toEqual({
      datasetNames: ["dataset_a"],
      snapshotVersions: ["snapshot_current"],
      qaRunVersions: ["qa_current"],
      runIds: ["run_current"],
    });
    const formatted = formatQaComparisonText(compareQaSamples([current], [baseline]));
    expect(formatted).toContain("current metadata: qa_run=qa_current snapshot=snapshot_current dataset=dataset_a");
    expect(formatted).toContain("baseline metadata: qa_run=qa_baseline snapshot=snapshot_baseline dataset=dataset_a");
  });

  it("summarizes comparisons by dataset metadata field", () => {
    const current = [
      parseQaSample({
        question_id: "1-1",
        pred_answer: "A",
        gt_answer: "A",
        correct: true,
        dataset_metadata: { task_type: "Temporal Reasoning" },
      })!,
      parseQaSample({
        question_id: "1-2",
        pred_answer: "B",
        gt_answer: "A",
        correct: false,
        dataset_metadata: { task_type: "Temporal Reasoning" },
      })!,
      parseQaSample({
        question_id: "1-3",
        pred_answer: "C",
        gt_answer: "C",
        correct: true,
        dataset_metadata: { task_type: "Object Reasoning" },
      })!,
    ];
    const baseline = [
      parseQaSample({
        question_id: "1-1",
        pred_answer: "B",
        gt_answer: "A",
        correct: false,
        dataset_metadata: { task_type: "Temporal Reasoning" },
      })!,
      parseQaSample({
        question_id: "1-2",
        pred_answer: "A",
        gt_answer: "A",
        correct: true,
        dataset_metadata: { task_type: "Temporal Reasoning" },
      })!,
      parseQaSample({
        question_id: "1-3",
        pred_answer: "C",
        gt_answer: "C",
        correct: true,
        dataset_metadata: { task_type: "Object Reasoning" },
      })!,
    ];

    const groups = summarizeQaComparisonByField(
      compareQaSamples(current, baseline),
      "dataset_metadata.task_type",
    );

    expect(groups).toEqual([
      {
        group: "Temporal Reasoning",
        currentCorrect: 1,
        currentTotal: 2,
        baselineCorrect: 1,
        baselineOverlap: 2,
        improved: 1,
        regressed: 1,
        unchanged: 0,
        missingBaseline: 0,
      },
      {
        group: "Object Reasoning",
        currentCorrect: 1,
        currentTotal: 1,
        baselineCorrect: 1,
        baselineOverlap: 1,
        improved: 0,
        regressed: 0,
        unchanged: 1,
        missingBaseline: 0,
      },
    ]);
    expect(formatQaComparisonGroupText(groups, "dataset_metadata.task_type")).toContain(
      "Temporal Reasoning\t1/2\t1/2\t+1 / -1 / =0",
    );
  });

  it("summarizes comparisons by trace diagnostics field", () => {
    const current = [
      parseQaSample({
        question_id: "1-1",
        pred_answer: "A",
        gt_answer: "A",
        correct: true,
        trace_diagnostics: { selected_candidate_status: "supported" },
      })!,
      parseQaSample({
        question_id: "1-2",
        pred_answer: "B",
        gt_answer: "A",
        correct: false,
        trace_diagnostics: { selected_candidate_status: "refuted" },
      })!,
    ];
    const baseline = [
      parseQaSample({
        question_id: "1-1",
        pred_answer: "B",
        gt_answer: "A",
        correct: false,
      })!,
      parseQaSample({
        question_id: "1-2",
        pred_answer: "A",
        gt_answer: "A",
        correct: true,
      })!,
    ];

    const groups = summarizeQaComparisonByField(
      compareQaSamples(current, baseline),
      "trace_diagnostics.selected_candidate_status",
    );

    expect(groups).toEqual([
      {
        group: "refuted",
        currentCorrect: 0,
        currentTotal: 1,
        baselineCorrect: 1,
        baselineOverlap: 1,
        improved: 0,
        regressed: 1,
        unchanged: 0,
        missingBaseline: 0,
      },
      {
        group: "supported",
        currentCorrect: 1,
        currentTotal: 1,
        baselineCorrect: 0,
        baselineOverlap: 1,
        improved: 1,
        regressed: 0,
        unchanged: 0,
        missingBaseline: 0,
      },
    ]);
  });

  it("summarizes comparisons by array-valued trace diagnostics fields", () => {
    const current = [
      parseQaSample({
        question_id: "1-1",
        pred_answer: "A",
        gt_answer: "A",
        correct: true,
        trace_diagnostics: { order_issue_types: ["slot_non_canonical", "slot_semantic_boundary_risk"] },
      })!,
      parseQaSample({
        question_id: "1-2",
        pred_answer: "B",
        gt_answer: "A",
        correct: false,
        trace_diagnostics: { order_issue_types: ["slot_semantic_boundary_risk", "slot_non_canonical"] },
      })!,
    ];
    const baseline = [
      parseQaSample({
        question_id: "1-1",
        pred_answer: "B",
        gt_answer: "A",
        correct: false,
      })!,
      parseQaSample({
        question_id: "1-2",
        pred_answer: "A",
        gt_answer: "A",
        correct: true,
      })!,
    ];

    const groups = summarizeQaComparisonByField(
      compareQaSamples(current, baseline),
      "trace_diagnostics.order_issue_types",
    );

    expect(groups).toEqual([
      {
        group: "slot_non_canonical,slot_semantic_boundary_risk",
        currentCorrect: 1,
        currentTotal: 2,
        baselineCorrect: 1,
        baselineOverlap: 2,
        improved: 1,
        regressed: 1,
        unchanged: 0,
        missingBaseline: 0,
      },
    ]);
  });

  it("merges duplicate lmms samples with eval-server trace diagnostics", () => {
    const current = [
      parseQaSample({
        question_id: "1-1",
        pred_answer: "A",
        gt_answer: "A",
        correct: true,
        trace_diagnostics: { selected_candidate_status: "supported" },
      })!,
      parseQaSample({
        filtered_resps: "A",
        target: "A",
        videomme_perception_score: {
          question_id: "1-1",
          pred_answer: "A",
          answer: "A",
          score: 1,
          task_category: "Temporal Reasoning",
        },
      })!,
    ];
    const baseline = [
      parseQaSample({
        question_id: "1-1",
        pred_answer: "B",
        gt_answer: "A",
        correct: false,
      })!,
    ];
    const comparison = compareQaSamples(current, baseline);

    expect(comparison.rows).toHaveLength(1);
    expect(comparison.rows[0].current.datasetMetadata).toEqual(expect.objectContaining({
      task_type: "Temporal Reasoning",
    }));
    expect(comparison.rows[0].current.traceDiagnostics).toEqual({
      selected_candidate_status: "supported",
    });
  });
});
