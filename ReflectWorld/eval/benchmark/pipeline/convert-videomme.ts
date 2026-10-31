// eval/benchmark/pipeline/convert-videomme.ts
// Convert Video-MME v2 JSONL to benchmark runner dataset JSON format.
//
// Usage: npx tsx eval/benchmark/pipeline/convert-videomme.ts <jsonl_path> <video_dir> [--output dataset.json]

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import type { BenchmarkDataset, BenchmarkVideo, BenchmarkQuestion } from "./types.js";

const args = process.argv.slice(2);
const jsonlPath = args[0];
const videoDir = args[1];
const outputIdx = args.indexOf("--output");
const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : undefined;

if (!jsonlPath || !videoDir) {
  console.error("Usage: npx tsx eval/benchmark/pipeline/convert-videomme.ts <jsonl_path> <video_dir> [--output dataset.json]");
  process.exit(1);
}

interface VideoMMEQuestion {
  video_id: string;
  question_id: string;
  question: string;
  options: string;
  answer: string;
  level?: string;
  second_head?: string;
  third_head?: string;
  group_type?: string;
}

const lines = readFileSync(resolve(jsonlPath), "utf-8").trim().split("\n");
const videoMap = new Map<string, { questions: BenchmarkQuestion[]; metadata: Record<string, unknown> }>();

for (const line of lines) {
  const row = JSON.parse(line) as VideoMMEQuestion;

  if (!videoMap.has(row.video_id)) {
    videoMap.set(row.video_id, { questions: [], metadata: { group_type: row.group_type } });
  }

  // Parse options: "A. xxx\nB. yyy\n..." → ["xxx", "yyy", ...]
  const optionLines = row.options.split("\n").filter(l => l.trim());
  const options = optionLines.map(l => l.replace(/^[A-Z]\.\s*/, "").trim());

  videoMap.get(row.video_id)!.questions.push({
    id: row.question_id,
    question: row.question,
    type: "mcq",
    options,
    ground_truth: row.answer,
  });
}

const resolvedVideoDir = resolve(videoDir);
const videos: BenchmarkVideo[] = [];

for (const [videoId, data] of videoMap) {
  const videoFile = `${videoId}.mp4`;
  const videoPath = join(resolvedVideoDir, videoFile);
  if (!existsSync(videoPath)) {
    console.error(`Warning: video not found: ${videoPath}`);
  }

  videos.push({
    id: videoId,
    path: videoFile,
    metadata: data.metadata,
    questions: data.questions,
  });
}

const dataset: BenchmarkDataset = {
  dataset: "videomme_v2",
  version: "sample_5videos",
  videos,
};

const output = outputPath
  ? resolve(outputPath)
  : resolve(resolvedVideoDir, "dataset.json");

writeFileSync(output, JSON.stringify(dataset, null, 2));
console.log(`Converted ${lines.length} questions across ${videos.length} videos → ${output}`);
