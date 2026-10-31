import { useMemo } from "react";
import type { MonitorEvent, SemanticMemory } from "../types";

/**
 * Aggregate `memory:memory_added` events of type `semantic` per stable ReID entity id.
 * Merges by memory_id: updates keep latest summary and bump update_count.
 * Returns a Map<entity_id, SemanticMemory[]> sorted newest-first.
 */
export function useSemanticMemories(events: MonitorEvent[]): Map<string, SemanticMemory[]> {
  return useMemo(() => deriveSemanticMemories(events), [events]);
}

export function deriveSemanticMemories(events: MonitorEvent[]): Map<string, SemanticMemory[]> {
  type Key = string; // `${entity_id}::${memory_id}`
  const byKey = new Map<Key, SemanticMemory>();

  for (const e of events) {
    if (e.type !== "memory:memory_added" && e.type !== "memory:memory_updated") continue;
    if (e.data.memory_type !== "semantic") continue;
    const rawEntityId = typeof e.data.entity_id === "string" ? e.data.entity_id : "";
    const entityId = rawEntityId;
    const memoryId = typeof e.data.memory_id === "string" ? e.data.memory_id : "";
    if (!entityId || !memoryId) continue;

    const summary = String(e.data.summary_preview ?? e.data.summary ?? "");
    const importance = typeof e.data.importance === "number" ? e.data.importance : null;

    const key: Key = `${entityId}::${memoryId}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.summary = summary || existing.summary;
      existing.timestamp = Math.max(existing.timestamp, e.timestamp);
      existing.importance = importance ?? existing.importance;
      existing.update_count += 1;
    } else {
      byKey.set(key, { memory_id: memoryId, entity_id: entityId, summary, importance, timestamp: e.timestamp, update_count: 1 });
    }
  }

  const byEntity = new Map<string, SemanticMemory[]>();
  for (const mem of byKey.values()) {
    if (!byEntity.has(mem.entity_id)) byEntity.set(mem.entity_id, []);
    byEntity.get(mem.entity_id)!.push(mem);
  }
  for (const list of byEntity.values()) list.sort((a, b) => b.timestamp - a.timestamp);
  return byEntity;
}
