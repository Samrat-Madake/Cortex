import type { PipelineDeps } from "@reflectworld/percept";
import type { ReflectWorldClient } from "@reflectworld/mem";
import { createMemoryReidAdapter } from "../../../packages/reflectworld/src/memory-adapter.js";

export interface BenchmarkReidMemoryOptions {
  pipelineDeps: PipelineDeps;
  memClient: Pick<ReflectWorldClient, "reidSearch" | "reidUpsert" | "reidGalleryUpdate"> & Partial<Pick<ReflectWorldClient, "reidBatchInit">>;
  userId: string;
  enabled: boolean;
}

export function wireBenchmarkReidMemory(options: BenchmarkReidMemoryOptions): void {
  const { pipelineDeps, memClient, userId, enabled } = options;
  if (!enabled) return;

  pipelineDeps.memory = {
    ...pipelineDeps.memory,
    ...createMemoryReidAdapter({ memClient, userId }),
  };
}
