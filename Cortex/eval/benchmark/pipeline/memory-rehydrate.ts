import { existsSync, readFileSync } from "node:fs";
import { CortexClient, type AddMemoryRequest, type CaptureMode, type MemoryItem, type AddSchemaRequest, type UpsertContextRequest } from "@cortex/mem";
import { countEpisodicMemories, countSemanticMemories, dumpMemories, type MemoryDump } from "./memory-dump.js";

type DumpMemoryItem = MemoryItem & {
  user_id?: string;
  agent_id?: string;
  run_id?: string;
  video_id?: string;
  video_ids?: Array<string | null>;
  entity_id?: string;
  entity_class?: string;
  category?: string;
  importance?: number;
};

export interface RehydrateResult {
  skipped: boolean;
  restored: {
    episodic: number;
    semantic: number;
    procedural: number;
    episodic_trace: number;
    episodic_entity: number;
    episodic_schema: number;
    semantic_entity: number;
    semantic_context: number;
  };
  failed: number;
  reason?: string;
}

/**
 * Restore memory_dump.json into the current Qdrant collections for --reuse-run.
 *
 * The dump does not contain vectors, so this recreates text memories through the
 * Mem service. Episodic records are restored sequentially in source timestamp
 * order so get_history(position="earliest") remains useful.
 */
export async function rehydrateMemoriesFromDump(
  client: CortexClient,
  cameraId: string,
  userId: string,
  dumpPath: string,
  onProgress?: (message: string) => void,
): Promise<RehydrateResult> {
  const zeroRestored = (): RehydrateResult["restored"] => ({
    episodic: 0, semantic: 0, procedural: 0,
    episodic_trace: 0, episodic_entity: 0, episodic_schema: 0,
    semantic_entity: 0, semantic_context: 0,
  });

  if (!existsSync(dumpPath)) {
    return {
      skipped: true,
      restored: zeroRestored(),
      failed: 0,
      reason: `memory dump not found: ${dumpPath}`,
    };
  }

  const existing = await dumpMemories(client, cameraId, userId);
  const existingEpisodic = countEpisodicMemories(existing);
  const existingSemantic = countSemanticMemories(existing);
  if (existingEpisodic > 0 || existingSemantic > 0) {
    return {
      skipped: true,
      restored: zeroRestored(),
      failed: 0,
      reason: `existing memories found (${existingEpisodic} episodic, ${existingSemantic} semantic)`,
    };
  }

  const dump = JSON.parse(readFileSync(dumpPath, "utf-8")) as MemoryDump;
  const restored = zeroRestored();
  let failed = 0;

  // Episodic trace
  const episodicTraceSource = (dump as any).episodic_trace ?? [];
  const episodic = [...(episodicTraceSource as DumpMemoryItem[])]
    .filter(item => typeof item.memory === "string" && item.memory.trim())
    .sort(compareDumpItemsBySourceTime);

  for (let i = 0; i < episodic.length; i++) {
    const item = episodic[i]!;
    try {
      await client.add(toEpisodicRequest(item, cameraId, userId));
      restored.episodic_trace++;
      restored.episodic++;
      if (restored.episodic_trace % 100 === 0) {
        onProgress?.(`restored ${restored.episodic_trace}/${episodic.length} episodic_trace memories`);
      }
    } catch (err) {
      failed++;
      onProgress?.(`episodic_trace restore failed (${item.id}): ${String(err).slice(0, 180)}`);
    }
  }

  // Episodic entity
  const episodicEntitySource = (dump as any).episodic_entity ?? [];
  const episodicEntity = [...(episodicEntitySource as DumpMemoryItem[])]
    .filter(item => typeof item.memory === "string" && item.memory.trim())
    .sort(compareDumpItemsBySourceTime);

  for (const item of episodicEntity) {
    try {
      await client.add(toEpisodicEntityRequest(item, cameraId, userId));
      restored.episodic_entity++;
      restored.episodic++;
    } catch (err) {
      failed++;
      onProgress?.(`episodic_entity restore failed (${item.id}): ${String(err).slice(0, 180)}`);
    }
  }

  // Episodic schema — route through dedicated addEpisodicSchema endpoint
  const episodicSchemaSource = (dump as any).episodic_schema ?? [];
  const episodicSchema = [...(episodicSchemaSource as DumpMemoryItem[])]
    .filter(item => typeof item.memory === "string" && item.memory.trim());
  const schemaResults = await runWithConcurrency(episodicSchema, 4, async (item) => {
    await client.addEpisodicSchema(toSchemaRequest(item, cameraId, userId));
  });
  restored.episodic_schema = schemaResults.ok;
  restored.episodic += schemaResults.ok;
  failed += schemaResults.failed;

  // Semantic entity
  const semanticEntitySource = (dump as any).semantic_entity ?? [];
  const semantic = [...(semanticEntitySource as DumpMemoryItem[])]
    .filter(item => typeof item.memory === "string" && item.memory.trim());
  const semanticResults = await runWithConcurrency(semantic, 4, async (item) => {
    await client.add(toSemanticRequest(item, cameraId, userId));
  });
  restored.semantic_entity = semanticResults.ok;
  restored.semantic = semanticResults.ok;
  failed += semanticResults.failed;

  // Semantic context — route through dedicated upsertSemanticContext endpoint
  const semanticContextSource = (dump as any).semantic_context ?? [];
  const semanticContext = [...(semanticContextSource as DumpMemoryItem[])]
    .filter(item => typeof item.memory === "string" && item.memory.trim());
  const semanticContextResults = await runWithConcurrency(semanticContext, 4, async (item) => {
    await client.upsertSemanticContext(toContextRequest(item, cameraId, userId));
  });
  restored.semantic_context = semanticContextResults.ok;
  restored.semantic += semanticContextResults.ok;
  failed += semanticContextResults.failed;

  // Procedural
  const procedural = [...(dump.procedural as DumpMemoryItem[])]
    .filter(item => typeof item.memory === "string" && item.memory.trim());
  const proceduralResults = await runWithConcurrency(procedural, 4, async (item) => {
    await client.add(toProceduralRequest(item, cameraId, userId));
  });
  restored.procedural = proceduralResults.ok;
  failed += proceduralResults.failed;

  return { skipped: false, restored, failed };
}

function toEpisodicRequest(item: DumpMemoryItem, cameraId: string, userId: string): AddMemoryRequest {
  const mediaUrls = Array.isArray(item.metadata?.media_urls)
    ? item.metadata?.media_urls as string[]
    : undefined;
  const meta = item.metadata ?? {};
  const entityIds = toStringList(item.entity_ids, item.metadata?.entity_ids);
  const videoId = item.video_id
    ?? (typeof meta.video_id === "string" ? meta.video_id : undefined)
    ?? (typeof meta.segment_id === "string" ? meta.segment_id : undefined);
  return {
    video_data: {
      summary: item.memory,
      ...(mediaUrls ? { media_urls: mediaUrls } : {}),
    },
    user_id: userId,
    agent_id: item.agent_id,
    run_id: item.run_id,
    camera_id: cameraId,
    video_id: videoId,
    metadata: {
      ...restoreMetadata(item),
      ...(entityIds.length ? { entity_ids: entityIds } : {}),
    },
    infer: false,
  };
}

function toEpisodicEntityRequest(item: DumpMemoryItem, cameraId: string, userId: string): AddMemoryRequest {
  const meta = item.metadata ?? {};
  const videoIds = toStringList(item.video_ids, meta.video_ids);
  const videoId = videoIds[0] ?? undefined;
  return {
    entity_data: [{
      entity_id: item.entity_id ?? item.metadata?.entity_id as string ?? "unknown",
      message: item.memory,
      class_name: (item.entity_class ?? item.metadata?.class_name as string) ?? "",
    }],
    camera_id: cameraId,
    user_id: userId,
    video_id: videoId,
    event_id: item.metadata?.event_id as string | undefined,
    mode: toCaptureMode(item.metadata?.mode),
    metadata: {
      segment_id: item.metadata?.segment_id,
      ...(videoIds.length ? { video_ids: videoIds } : {}),
      media_start_ms: item.metadata?.media_start_ms,
      media_duration_ms: item.metadata?.media_duration_ms,
      source_time_label: item.metadata?.source_time_label,
      time_basis: item.metadata?.time_basis,
      media_urls: item.metadata?.media_urls,
      restored_from_memory_dump: true,
      original_memory_id: item.id,
      original_created_at: item.created_at,
      original_updated_at: item.updated_at,
      original_hash: item.hash,
    },
    infer: false,
  };
}

function toSemanticRequest(item: DumpMemoryItem, cameraId: string, userId: string): AddMemoryRequest {
  const meta = item.metadata ?? {};
  const entityId = item.entity_id
    ?? (typeof meta.entity_id === "string" ? meta.entity_id : undefined)
    ?? "unknown_speaker";
  const videoIds = toStringList(item.video_ids, meta.video_ids);
  const videoId = videoIds[0] ?? undefined;
  return {
    memory_type: "semantic_entity",
    entity_data: [{
      entity_id: entityId,
      class_name: item.entity_class ?? "",
      category: item.category ?? "restored",
      importance: item.importance ?? item.metadata?.importance ?? 0.5,
      message: item.memory,
      ...(videoIds.length ? { video_ids: videoIds } : {}),
    }],
    user_id: userId,
    agent_id: item.agent_id,
    run_id: item.run_id,
    video_id: videoId,
    camera_id: cameraId,
    metadata: {
      ...restoreMetadata(item),
      ...(videoIds.length ? { video_ids: videoIds } : {}),
    },
    infer: false,
  };
}

// Narrow an arbitrary dump value to a valid CaptureMode, defaulting to "event"
// to preserve the prior runtime fallback behaviour.
function toCaptureMode(value: unknown): CaptureMode {
  return value === "snapshot" || value === "event" || value === "stream" ? value : "event";
}

function toStringList(...values: unknown[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const candidates = Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      if (candidate == null) continue;
      const text = String(candidate).trim();
      if (text && !result.includes(text)) result.push(text);
    }
  }
  return result;
}

function toSchemaRequest(item: DumpMemoryItem, cameraId: string, userId: string): AddSchemaRequest {
  const meta = item.metadata ?? {};
  const eventIds = (meta.event_ids as string[] | undefined) ?? [];
  // Try flat fields first (from Qdrant payload), then nested time_range.
  const rawTimeRange = meta.time_range as { start_ms?: number; end_ms?: number } | undefined;
  const startMs = (meta.time_range_start_ms as number | undefined) ?? rawTimeRange?.start_ms ?? 0;
  const endMs = (meta.time_range_end_ms as number | undefined) ?? rawTimeRange?.end_ms ?? 0;
  return {
    summary: item.memory,
    event_ids: eventIds,
    time_range: { start_ms: startMs, end_ms: endMs },
    camera_id: cameraId,
    user_id: userId,
  };
}

function toContextRequest(item: DumpMemoryItem, cameraId: string, userId: string): UpsertContextRequest {
  // Semantic context dumps store structured fields in metadata.
  const meta = item.metadata ?? {};
  return {
    camera_id: cameraId,
    scene_description: (meta.scene_description as string) ?? item.memory,
    known_entities: (meta.known_entities as string) ?? "",
    daily_routine: (meta.daily_routine as string) ?? "",
    anomaly_baseline: (meta.anomaly_baseline as string) ?? "",
    user_notes: (meta.user_notes as string) ?? undefined,
    user_id: userId,
    // SemanticContext state fields — required for cold-start hydration
    last_llm_update: meta.last_llm_update as string | undefined,
    last_update_segment_count: meta.last_update_segment_count as number | undefined,
    last_agent_consult: meta.last_agent_consult as string | undefined,
    last_consult_segment_count: meta.last_consult_segment_count as number | undefined,
    consecutive_no_updates: meta.consecutive_no_updates as number | undefined,
  };
}

function toProceduralRequest(item: DumpMemoryItem, cameraId: string, userId: string): AddMemoryRequest {
  return {
    memory_type: "procedural",
    messages: item.memory,
    user_id: userId,
    agent_id: item.agent_id,
    run_id: item.run_id,
    camera_id: cameraId,
    metadata: restoreMetadata(item),
    infer: false,
  };
}

function restoreMetadata(item: DumpMemoryItem): Record<string, unknown> {
  return {
    ...(item.metadata ?? {}),
    restored_from_memory_dump: true,
    original_memory_id: item.id,
    original_created_at: item.created_at,
    original_updated_at: item.updated_at,
    original_hash: item.hash,
  };
}

function compareDumpItemsBySourceTime(a: DumpMemoryItem, b: DumpMemoryItem): number {
  return sourceTime(a) - sourceTime(b);
}

function sourceTime(item: DumpMemoryItem): number {
  const mediaStart = item.metadata?.media_start_ms;
  if (typeof mediaStart === "number" && Number.isFinite(mediaStart)) return mediaStart;
  if (typeof mediaStart === "string" && mediaStart.trim()) {
    const parsed = Number(mediaStart);
    if (Number.isFinite(parsed)) return parsed;
  }

  const text = item.memory ?? "";
  const segmentTimestamp = text.match(/segment_timestamp:\s*([0-9.]+)/)?.[1];
  if (segmentTimestamp) return Number(segmentTimestamp);

  const runOrder = item.run_id?.match(/_([0-9a-z]+)$/)?.[1];
  if (runOrder) return parseInt(runOrder, 36);

  const created = item.created_at ? Date.parse(item.created_at) : NaN;
  return Number.isFinite(created) ? created : Number.MAX_SAFE_INTEGER;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<{ ok: number; failed: number }> {
  let next = 0;
  let ok = 0;
  let failed = 0;

  async function worker() {
    while (next < items.length) {
      const item = items[next++]!;
      try {
        await fn(item);
        ok++;
      } catch {
        failed++;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return { ok, failed };
}
