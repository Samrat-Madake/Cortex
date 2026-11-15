import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { qaArtifactDirForCheckpoint, qaRunDirForVideo } from "../eval/benchmark/pipeline/qa-artifact-path.js";

describe("QA artifact paths", () => {
  it("stores QA run artifacts under the requested artifact directory", () => {
    const baseDir = join(tmpdir(), `cortex-qa-artifacts-${process.pid}-${Date.now()}`);
    const qaDir = qaRunDirForVideo(baseDir, "qa_run_a");

    expect(qaDir).toBe(join(baseDir, "qa_runs", "qa_run_a"));
    expect(existsSync(qaDir)).toBe(true);
  });

  it("derives checkpoint QA artifacts from the current run directory, not the reused memory directory", () => {
    const currentRunDir = "/tmp/current-run/videos/video_a";
    const reusedMemoryDir = "/tmp/baseline/videos/video_a";
    const checkpointId = "cp_001";

    expect(qaArtifactDirForCheckpoint(currentRunDir, checkpointId)).toBe(
      "/tmp/current-run/videos/video_a/checkpoints/cp_001",
    );
    expect(qaArtifactDirForCheckpoint(currentRunDir, checkpointId)).not.toContain(reusedMemoryDir);
  });
});
