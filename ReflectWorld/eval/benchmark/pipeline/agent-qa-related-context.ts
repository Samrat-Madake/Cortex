type MemoryLike = {
  id?: string;
  memory?: string;
  data?: string;
  score?: number;
  memory_type?: string;
  video_id?: string;
  metadata?: Record<string, unknown> | null;
};

export type RelatedTraceContext = {
  reason: string;
  source: "schema_time_range" | "schema_event_id" | "trace_time_neighbor" | "entity_video_id";
  primary_memory_id?: string;
  primary_memory_type: "episodic_schema" | "episodic_trace" | "episodic_entity" | "semantic_entity";
  memory_id?: string;
  segment_id?: string;
  timestamp_ms?: number;
  timestamp_sec?: number;
  source_time_label?: string;
  time_basis?: string;
  memory_type: "episodic_trace";
  summary: string;
  detail?: string;
  transcript?: string;
  speech_events_text?: string;
  visual_evidence?: Record<string, unknown>;
};

function firstString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function memoryText(item: MemoryLike): string {
  const metadata = metadataOf(item);
  return [
    String(item.memory ?? item.data ?? "").trim(),
    firstString(metadata.speech_events_text),
    firstString(metadata.transcript),
    firstString(metadata.detailed_summary),
  ].filter(Boolean).join("\n");
}

function metadataOf(item: MemoryLike): Record<string, unknown> {
  return item.metadata && typeof item.metadata === "object" ? item.metadata : {};
}

function memoryTimestampMs(item: MemoryLike): number | undefined {
  const metadata = metadataOf(item);
  return numeric(metadata.media_start_ms)
    ?? numeric(metadata.timestamp_ms)
    ?? numeric(metadata.timestamp)
    ?? numeric(metadata.time_range_start_ms)
    ?? numeric((metadata.time_range as { start_ms?: unknown } | undefined)?.start_ms);
}

function sourceTimeMetadataFromItem(item: MemoryLike): Pick<RelatedTraceContext, "source_time_label" | "time_basis"> {
  const metadata = metadataOf(item);
  const sourceTimeLabel = firstString(metadata.source_time_label);
  const timeBasis = firstString(metadata.time_basis);
  return {
    ...(sourceTimeLabel ? { source_time_label: sourceTimeLabel } : {}),
    ...(timeBasis ? { time_basis: timeBasis } : {}),
  };
}

function schemaTimeRange(item: MemoryLike): { startMs: number; endMs: number } | undefined {
  const metadata = metadataOf(item);
  const rawRange = metadata.time_range as { start_ms?: unknown; end_ms?: unknown } | undefined;
  const startMs = numeric(metadata.time_range_start_ms) ?? numeric(rawRange?.start_ms);
  const endMs = numeric(metadata.time_range_end_ms) ?? numeric(rawRange?.end_ms);
  if (startMs === undefined || endMs === undefined || endMs < startMs) return undefined;
  return { startMs, endMs };
}

function schemaEventIds(item: MemoryLike): Set<string> {
  const metadata = metadataOf(item);
  const raw = metadata.event_ids;
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.map(value => firstString(value)).filter(Boolean) as string[]);
}

function segmentIdFromItem(item: MemoryLike): string | undefined {
  const metadata = metadataOf(item);
  return firstString(item.video_id)
    ?? firstString(metadata.video_id)
    ?? firstString(metadata.segment_id)
    ?? firstString(metadata.event_id);
}

function mediaUrlsFromItem(item: MemoryLike): string[] {
  const metadata = metadataOf(item);
  const raw = metadata.media_urls;
  const urls: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? Object.values(raw).flat()
      : [];
  return urls.filter((url): url is string => typeof url === "string" && url.length > 0);
}

function stringList(...values: unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const candidates = Array.isArray(value) ? value : value == null ? [] : [value];
    for (const candidate of candidates) {
      const text = firstString(candidate);
      if (text && !out.includes(text)) out.push(text);
    }
  }
  return out;
}

function videoIdsFromItem(item: MemoryLike): string[] {
  const metadata = metadataOf(item);
  return stringList(
    (item as Record<string, unknown>).video_ids,
    metadata.video_ids,
    item.video_id,
    metadata.video_id,
  );
}

function visualEvidenceFromMediaUrls(mediaUrls: string[]): Record<string, unknown> | undefined {
  const keyframes = mediaUrls.filter(url => /\.(jpe?g|png|webp)$/i.test(url));
  const videoSegments = mediaUrls.filter(url => /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(url));
  if (!keyframes.length && !videoSegments.length) return undefined;
  return {
    ...(keyframes.length ? { keyframes: keyframes.slice(0, 2) } : {}),
    ...(videoSegments.length ? { video_segments: videoSegments.slice(0, 1) } : {}),
  };
}

function extractMemorySection(text: string, label: string, maxChars: number): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`${escaped}:\\s*([\\s\\S]*?)(?=\\n(?:summary|detailed_summary|transcript|speech_events_text|main_targets|media_urls):|$)`, "i"));
  return match?.[1]?.replace(/\s+/g, " ").trim().slice(0, maxChars) || undefined;
}

function compactTraceItem(
  primary: MemoryLike,
  trace: MemoryLike,
  reason: RelatedTraceContext["reason"],
  source: RelatedTraceContext["source"],
  primaryMemoryType: RelatedTraceContext["primary_memory_type"] = "episodic_schema",
): RelatedTraceContext {
  const text = memoryText(trace);
  const timestampMs = memoryTimestampMs(trace);
  const mediaUrls = mediaUrlsFromItem(trace);
  const visualEvidence = visualEvidenceFromMediaUrls(mediaUrls);
  const detail = extractMemorySection(text, "detailed_summary", 700);
  const transcript = extractMemorySection(text, "transcript", 400);
  const metadata = metadataOf(trace);
  const speechEvents = extractMemorySection(text, "speech_events_text", 500)
    ?? firstString(metadata.speech_events_text);
  return {
    reason,
    source,
    primary_memory_id: firstString(primary.id),
    primary_memory_type: primaryMemoryType,
    memory_id: firstString(trace.id),
    segment_id: segmentIdFromItem(trace),
    timestamp_ms: timestampMs,
    timestamp_sec: timestampMs !== undefined ? Number((timestampMs / 1000).toFixed(1)) : undefined,
    ...sourceTimeMetadataFromItem(trace),
    memory_type: "episodic_trace",
    summary: extractMemorySection(text, "summary", 400) ?? text.replace(/\s+/g, " ").slice(0, 400),
    ...(detail ? { detail } : {}),
    ...(transcript ? { transcript } : {}),
    ...(speechEvents ? { speech_events_text: speechEvents } : {}),
    ...(visualEvidence ? { visual_evidence: visualEvidence } : {}),
  };
}

function selectBoundedTraceItems(items: MemoryLike[], maxItems: number): MemoryLike[] {
  if (items.length <= maxItems) return items;
  if (maxItems <= 1) return [items[0]];
  const selected = new Map<string, MemoryLike>();
  const positions = [0, Math.floor((items.length - 1) / 2), items.length - 1];
  for (const pos of positions) {
    const item = items[pos];
    const key = firstString(item.id) ?? segmentIdFromItem(item) ?? String(pos);
    selected.set(key, item);
    if (selected.size >= maxItems) return [...selected.values()];
  }
  for (const item of items) {
    const key = firstString(item.id) ?? segmentIdFromItem(item) ?? String(selected.size);
    selected.set(key, item);
    if (selected.size >= maxItems) break;
  }
  return [...selected.values()];
}

export function isEpisodicSchemaMemory(item: MemoryLike): boolean {
  const metadata = metadataOf(item);
  return firstString(item.memory_type) === "episodic_schema"
    || firstString(metadata.memory_type) === "episodic_schema"
    || Boolean(schemaTimeRange(item));
}

export function isEpisodicTraceMemory(item: MemoryLike): boolean {
  const metadata = metadataOf(item);
  return firstString(item.memory_type) === "episodic_trace"
    || firstString(metadata.memory_type) === "episodic_trace"
    || Boolean(segmentIdFromItem(item) && memoryTimestampMs(item) !== undefined && !schemaTimeRange(item));
}

export function isEpisodicEntityMemory(item: MemoryLike): boolean {
  const metadata = metadataOf(item);
  return firstString(item.memory_type) === "episodic_entity"
    || firstString(metadata.memory_type) === "episodic_entity";
}

export function isSemanticEntityMemory(item: MemoryLike): boolean {
  const metadata = metadataOf(item);
  return firstString(item.memory_type) === "semantic_entity"
    || firstString(metadata.memory_type) === "semantic_entity";
}

function entityPrimaryMemoryType(item: MemoryLike): "episodic_entity" | "semantic_entity" {
  return isSemanticEntityMemory(item) ? "semantic_entity" : "episodic_entity";
}

function sameTraceMemory(a: MemoryLike, b: MemoryLike): boolean {
  const aId = firstString(a.id);
  const bId = firstString(b.id);
  if (aId && bId && aId === bId) return true;
  const aSegmentId = segmentIdFromItem(a);
  const bSegmentId = segmentIdFromItem(b);
  return Boolean(aSegmentId && bSegmentId && aSegmentId === bSegmentId);
}

function selectAdjacentTraceItems(primary: MemoryLike, sortedTraceItems: MemoryLike[], maxItems: number): MemoryLike[] {
  if (maxItems <= 0) return [];
  const primaryIndex = sortedTraceItems.findIndex(item => sameTraceMemory(primary, item));
  if (primaryIndex < 0) return [];
  const candidates: MemoryLike[] = [];
  for (let offset = 1; candidates.length < maxItems && offset <= 3; offset += 1) {
    const before = sortedTraceItems[primaryIndex - offset];
    const after = sortedTraceItems[primaryIndex + offset];
    if (before) candidates.push(before);
    if (after && candidates.length < maxItems) candidates.push(after);
  }
  return candidates;
}

export function buildRelatedTraceContext(
  primaryItems: MemoryLike[],
  traceItems: MemoryLike[],
  maxExpanded = 5,
): RelatedTraceContext[] {
  const expanded: RelatedTraceContext[] = [];
  const seen = new Set<string>();
  const sortedTraceItems = [...traceItems].sort((a, b) => (memoryTimestampMs(a) ?? 0) - (memoryTimestampMs(b) ?? 0));

  for (const primary of primaryItems.filter(isEpisodicSchemaMemory)) {
    if (expanded.length >= maxExpanded) break;
    const eventIds = schemaEventIds(primary);
    const range = schemaTimeRange(primary);
    const eventMatches = sortedTraceItems.filter((item) => {
      const eventId = firstString(metadataOf(item).event_id);
      return Boolean(eventId && eventIds.has(eventId));
    });
    const rangeMatches = range
      ? sortedTraceItems.filter((item) => {
        const timestampMs = memoryTimestampMs(item);
        return timestampMs !== undefined && timestampMs >= range.startMs && timestampMs <= range.endMs;
      })
      : [];

    const candidates = eventMatches.length > 0
      ? selectBoundedTraceItems(eventMatches, Math.min(3, maxExpanded - expanded.length))
      : selectBoundedTraceItems(rangeMatches, Math.min(3, maxExpanded - expanded.length));
    const source: RelatedTraceContext["source"] = eventMatches.length > 0 ? "schema_event_id" : "schema_time_range";
    const reason = eventMatches.length > 0
      ? "episodic_trace shares event_id with an episodic_schema primary hit"
      : "episodic_trace timestamp falls inside an episodic_schema primary hit time range";

    for (const trace of candidates) {
      const key = firstString(trace.id) ?? segmentIdFromItem(trace);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      expanded.push(compactTraceItem(primary, trace, reason, source));
      if (expanded.length >= maxExpanded) break;
    }
  }

  for (const primary of primaryItems.filter(item => isEpisodicEntityMemory(item) || isSemanticEntityMemory(item))) {
    if (expanded.length >= maxExpanded) break;
    const videoIds = new Set(videoIdsFromItem(primary));
    if (videoIds.size === 0) continue;
    const matches = sortedTraceItems.filter((item) => {
      const segmentId = segmentIdFromItem(item);
      return Boolean(segmentId && videoIds.has(segmentId));
    });
    const candidates = selectBoundedTraceItems(matches, Math.min(3, maxExpanded - expanded.length));
    for (const trace of candidates) {
      const key = firstString(trace.id) ?? segmentIdFromItem(trace);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      expanded.push(compactTraceItem(
        primary,
        trace,
        "episodic_trace segment_id is listed in an entity-level memory's video_ids provenance",
        "entity_video_id",
        entityPrimaryMemoryType(primary),
      ));
      if (expanded.length >= maxExpanded) break;
    }
  }

  for (const primary of primaryItems.filter(isEpisodicTraceMemory)) {
    if (expanded.length >= maxExpanded) break;
    const candidates = selectAdjacentTraceItems(primary, sortedTraceItems, Math.min(2, maxExpanded - expanded.length));
    for (const trace of candidates) {
      const key = firstString(trace.id) ?? segmentIdFromItem(trace);
      if (!key || seen.has(key) || sameTraceMemory(primary, trace)) continue;
      seen.add(key);
      expanded.push(compactTraceItem(
        primary,
        trace,
        "episodic_trace is adjacent in time to an episodic_trace primary hit",
        "trace_time_neighbor",
        "episodic_trace",
      ));
      if (expanded.length >= maxExpanded) break;
    }
  }

  return expanded;
}
