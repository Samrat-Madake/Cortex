import { mkdirSync } from "node:fs";
import { join } from "node:path";

export function qaRunDirForVideo(videoDir: string, qaRunVersion: string): string {
  const path = join(videoDir, "qa_runs", qaRunVersion);
  mkdirSync(path, { recursive: true });
  return path;
}

export function qaArtifactDirForCheckpoint(baseQaArtifactDir: string, checkpointId: string): string {
  return join(baseQaArtifactDir, "checkpoints", checkpointId);
}
