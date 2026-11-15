import { useCallback, useEffect, useMemo, useState } from "react";
import type { MonitorEvent, EntityAlias } from "../types";

const STORAGE_KEY = "cortex.entity.aliases.v1";

type AliasMap = Record<string, { display_name: string; first_seen: number }>;

function normalizeAliasMap(raw: unknown): AliasMap {
  if (!raw || typeof raw !== "object") return {};
  const out: AliasMap = {};
  for (const [entityId, value] of Object.entries(raw)) {
    if (!entityId) continue;
    if (!value || typeof value !== "object") continue;
    const entry = value as { display_name?: unknown; first_seen?: unknown };
    const displayName = typeof entry.display_name === "string" ? entry.display_name.trim() : "";
    const firstSeen = typeof entry.first_seen === "number" && Number.isFinite(entry.first_seen)
      ? entry.first_seen
      : undefined;
    if (!displayName || firstSeen === undefined) continue;
    out[entityId] = { display_name: displayName, first_seen: firstSeen };
  }
  return out;
}

function loadStored(): AliasMap {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeAliasMap(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

function persist(map: AliasMap): void {
  if (typeof localStorage === "undefined") return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); } catch { /* quota */ }
}

/**
 * Merge two alias maps. For overlapping ids, the entry with the earlier
 * `first_seen` wins (prefer the tab that saw the entity first). Display names
 * from the winning side are kept.
 */
function mergeAliasMaps(a: AliasMap, b: AliasMap): AliasMap {
  const out: AliasMap = { ...a };
  for (const [id, entry] of Object.entries(b)) {
    const existing = out[id];
    if (!existing) {
      out[id] = entry;
    } else if (entry.first_seen < existing.first_seen) {
      out[id] = entry;
    }
  }
  return out;
}

/**
 * Shallow compare two alias maps for equality (same keys, same values).
 * Used to skip no-op state updates.
 */
function aliasMapsEqual(a: AliasMap, b: AliasMap): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const va = a[k];
    const vb = b[k];
    if (!vb) return false;
    if (va.display_name !== vb.display_name || va.first_seen !== vb.first_seen) return false;
  }
  return true;
}

/**
 * Derive entity display names from stable ReID entity ids.
 * - Dashboard canonical events must carry `target.entity_id` to enter the Entity panel.
 * - Event-local refs such as `person:7` are target handles only, not entities.
 * - Legacy VLM events can still contribute an entity_id fallback.
 * - Does not mint local Person N labels; numbering belongs to the backend.
 * - Persists the mapping in localStorage so labels survive reloads.
 * - Syncs across browser tabs via the `storage` DOM event
 * - Returns a lookup fn and the full alias list.
 */
export function useEntityAliases(events: MonitorEvent[]) {
  // Lazy-init from localStorage. Holding the map in state (not a ref) so
  // updates trigger re-renders and downstream memos recompute correctly.
  const [aliasMap, setAliasMap] = useState<AliasMap>(() => loadStored());

  // Pure derivation: collect every unique entity_id seen in VLM result events
  // along with the earliest timestamp observed. We intentionally ignore
  // memory-only entities here so hidden/stale ids don't consume Person A/B/C
  // labels in the visible Targets panel.
  const discovered = useMemo(() => {
    const out: Record<string, { first_seen: number; display_name?: string }> = {};
    const canonicalSegmentIds = new Set<string>();
    for (const e of events) {
      if (e.type !== "dashboard:segment_state") continue;
      const segmentId = typeof e.data.segment_id === "string" ? e.data.segment_id : "";
      if (segmentId) canonicalSegmentIds.add(segmentId);
    }
    for (const e of events) {
      const segmentId = typeof e.data.segment_id === "string" ? e.data.segment_id : "";
      if (e.type === "perception:vlm_result" && segmentId && canonicalSegmentIds.has(segmentId)) continue;
      const ts = readEntityTimestamp(e);
      for (const entity of readVisibleEntities(e)) {
        const existing = out[entity.entity_id];
        if (!existing || ts < existing.first_seen) {
          out[entity.entity_id] = {
            first_seen: ts,
            ...(bestDisplayName(entity.display_name, existing?.display_name) ? { display_name: bestDisplayName(entity.display_name, existing?.display_name) } : {}),
          };
        } else {
          const displayName = bestDisplayName(entity.display_name, existing.display_name);
          if (displayName !== existing.display_name) {
            out[entity.entity_id] = { ...existing, display_name: displayName };
          }
        }
      }
    }
    return out;
  }, [events]);

  // Reconcile discovered entities into the persistent alias map. Runs as an
  // effect (not during render) and merges with the latest stored value so
  // concurrent writes from other tabs don't get clobbered.
  useEffect(() => {
    setAliasMap(current => {
      // Merge current in-memory state with the freshest localStorage snapshot
      // before assigning new labels. This protects against races where another
      // tab wrote between our last sync and this reconciliation.
      const freshStored = loadStored();
      const merged = mergeAliasMaps(current, freshStored);
      const discoveredEntries = Object.entries(discovered).sort((a, b) => a[1].first_seen - b[1].first_seen);
      const discoveredIds = new Set(discoveredEntries.map(([id]) => id));

      // Keep only aliases for entities still present in the current VLM event
      // stream. This prevents stale/local-only entities from keeping the
      // visible list stuck at Person C/D/E.
      const retained: AliasMap = {};
      for (const [id, entry] of Object.entries(merged)) {
        if (discoveredIds.has(id)) retained[id] = entry;
      }

      // Rebuild from backend-projected labels. Dashboard must not invent local
      // Person N labels because those drift across refreshes/sources.
      const next: AliasMap = {};
      for (const [id, info] of discoveredEntries) {
        const existing = retained[id];
        const displayName = info.display_name
          ?? (existing && !isAutoPersonLabel(existing.display_name) ? existing.display_name : undefined)
          ?? "Unknown";
        next[id] = {
          display_name: displayName,
          first_seen: existing?.first_seen ?? info.first_seen,
        };
      }

      if (aliasMapsEqual(current, next)) return current;
      persist(next);
      return next;
    });
  }, [discovered]);

  // Cross-tab sync: when another tab writes to localStorage, merge its view
  // into ours. `storage` events fire only in *other* tabs, so this won't
  // re-enter our own writes.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (ev: StorageEvent) => {
      if (ev.key !== STORAGE_KEY) return;
      const incoming = ev.newValue ? safeParse(ev.newValue) : {};
      setAliasMap(current => {
        const merged = mergeAliasMaps(current, incoming);
        return aliasMapsEqual(current, merged) ? current : merged;
      });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const { aliasByEntityId, ordered } = useMemo(() => {
    const list: EntityAlias[] = Object.entries(aliasMap)
      .map(([entity_id, { display_name, first_seen }]) => ({ entity_id, display_name, first_seen }))
      .sort((a, b) => a.first_seen - b.first_seen);
    const byId: Record<string, EntityAlias> = {};
    for (const a of list) byId[a.entity_id] = a;
    return { aliasByEntityId: byId, ordered: list };
  }, [aliasMap]);

  const nameOf = useCallback(
    (entity_id: string | undefined) =>
      entity_id ? (aliasByEntityId[entity_id]?.display_name ?? "Unknown") : "Unknown",
    [aliasByEntityId],
  );

  return {
    aliasByEntityId,
    /** Resolve an entity_id to its display name, fallback to an explicit unknown label. */
    nameOf,
    /** List of aliases ordered by first_seen. */
    ordered,
  };
}

function safeParse(raw: string): AliasMap {
  try {
    return normalizeAliasMap(JSON.parse(raw));
  } catch {
    return {};
  }
}

function isAutoPersonLabel(displayName: string): boolean {
  return /^Person (?:[A-Z]+|\d+)$/.test(displayName);
}

export function bestDisplayName(next: string | undefined, current: string | undefined): string | undefined {
  const a = normalizeDisplayName(next);
  const b = normalizeDisplayName(current);
  if (!a) return b;
  if (!b) return a;
  if (isAutoPersonLabel(a) && !isAutoPersonLabel(b)) return b;
  if (isAutoPersonLabel(b)) return a;
  if (a.toLocaleLowerCase() === b.toLocaleLowerCase()) return a.length >= b.length ? a : b;
  if (a.toLocaleLowerCase().includes(b.toLocaleLowerCase())) return a;
  if (b.toLocaleLowerCase().includes(a.toLocaleLowerCase())) return b;
  return a;
}

function normalizeDisplayName(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text || /^unknown$/i.test(text)) return undefined;
  return text;
}

/**
 * Yield display ids from visible perception results. Canonical dashboard
 * targets expose `ref`/`label`; if `ref` is missing, do not promote ephemeral
 * target ids into the Entity panel. Legacy perception events may still expose
 * `entity_id`.
 */
function* readVisibleEntities(e: MonitorEvent): Generator<{ entity_id: string; display_name?: string }> {
  if (e.type === "perception:vlm_result" || e.type === "dashboard:segment_state") {
    const raw = e.type === "dashboard:segment_state" ? e.data.targets : e.data.main_targets;
    if (!Array.isArray(raw)) return;
    const seen = new Set<string>();
    for (const t of raw) {
      if (t && typeof t === "object") {
        const target = t as Record<string, unknown>;
        const id = typeof target.entity_id === "string" && target.entity_id ? target.entity_id : "";
        if (typeof id === "string" && id && !seen.has(id)) {
          seen.add(id);
          yield { entity_id: id, ...readDisplayName(target) };
        }
      }
    }
  }
}

function readDisplayName(target: Record<string, unknown>): { display_name?: string } {
  for (const key of ["label", "display_name", "name", "person_name", "identity"]) {
    const value = target[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed && !/^unknown$/i.test(trimmed)) return { display_name: trimmed };
    }
  }
  const displayIndex = target.subject_index;
  if (typeof displayIndex === "number" && Number.isFinite(displayIndex) && displayIndex > 0) {
    return { display_name: `Person ${Math.floor(displayIndex)}` };
  }
  return {};
}

function readEntityTimestamp(e: MonitorEvent): number {
  // Explicit type check: `0` is a legitimate segment_start, and a string value
  // must not be silently coerced to a number via `as number`.
  const raw = e.type === "dashboard:segment_state" ? e.data.start_time : e.data.segment_start;
  return typeof raw === "number" ? raw : e.timestamp;
}
