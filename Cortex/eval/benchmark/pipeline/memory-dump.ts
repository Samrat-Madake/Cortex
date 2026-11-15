// eval/benchmark/pipeline/memory-dump.ts
import {
  CortexClient,
  flattenMemoriesResponse,
  type MemoryItem,
} from "@cortex/mem";

export interface MemoryDump {
  episodic_trace: MemoryItem[];
  episodic_entity: MemoryItem[];
  episodic_schema: MemoryItem[];
  semantic_entity: MemoryItem[];
  semantic_context: MemoryItem[];
  procedural: MemoryItem[];
}

const MEMORY_TYPES = [
  "episodic_trace",
  "episodic_entity",
  "episodic_schema",
  "semantic_entity",
  "semantic_context",
  "procedural",
] as const;

type DumpCollectionKey = typeof MEMORY_TYPES[number];

/**
 * Export all memories for a camera_id from Qdrant (text + metadata, no embeddings).
 * Queries each collection separately so results are cleanly bucketed.
 */
export async function dumpMemories(
  client: CortexClient,
  cameraId: string,
  userId?: string,
): Promise<MemoryDump> {
  const buckets: Record<DumpCollectionKey, MemoryItem[]> = {
    episodic_trace: [],
    episodic_entity: [],
    episodic_schema: [],
    semantic_entity: [],
    semantic_context: [],
    procedural: [],
  };

  for (const memType of MEMORY_TYPES) {
    try {
      const response = await client.getMemories({
        camera_id: cameraId,
        ...(userId ? { user_id: userId } : {}),
        memory_type: memType as any,
        limit: 100000,
      });
      buckets[memType] = flattenMemoriesResponse(response);
    } catch (err) {
      // Log but do not throw -- partial dumps are still useful for scoring.
      console.error(`[benchmark] Memory dump failed for ${memType}: ${err}`);
    }
  }

  return {
    ...buckets,
  };
}

export function countEpisodicMemories(dump: MemoryDump): number {
  return dump.episodic_trace.length + dump.episodic_entity.length + dump.episodic_schema.length;
}

export function countSemanticMemories(dump: MemoryDump): number {
  return dump.semantic_entity.length + dump.semantic_context.length;
}
