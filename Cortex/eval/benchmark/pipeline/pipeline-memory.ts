import type { PipelineDeps } from "@cortex/percept";
import type { CortexClient } from "@cortex/mem";
import { createMemoryReidAdapter } from "../../../packages/cortex/src/memory-adapter.js";

export interface BenchmarkReidMemoryOptions {
  pipelineDeps: PipelineDeps;
  memClient: Pick<CortexClient, "reidSearch" | "reidUpsert" | "reidGalleryUpdate"> & Partial<Pick<CortexClient, "reidBatchInit">>;
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
