import type { AddMemoryRequest, AddMemoryResponse, ReflectWorldClient } from "@reflectworld/mem";
import type { PerceptionResult, Segment } from "@reflectworld/shared";
import type { PipelineMemory } from "@reflectworld/percept";
import { randomUUID } from "node:crypto";
import { projectDialogueEvents } from "./dialogue-events.js";

export const REID_MATCH_THRESHOLD = 0.5;

export type ReflectWorldoryClientPort = Pick<
  ReflectWorldClient,
  "add" | "reidSearch" | "reidUpsert" | "reidGalleryUpdate" | "reidBatchInit" | "reidUpdateIdentity" | "reidDelete"
>;

export interface PerceptionMemorySubject {
  entity_id?: string;
  class_name: string;
  appearance?: string;
  behavior?: string;
  interaction?: string;
}

export interface PerceptionEntityObservation {
  entity_id: string;
  class_name: string;
  appearance?: string;
  behavior?: string;
  interaction?: string;
  [key: string]: unknown;
}

export interface PerceptionAddRequestContext {
  segmentAnalysis: PerceptionResult["perception_memory"];
  memorySubjects: PerceptionMemorySubject[];
  entityObservations: PerceptionEntityObservation[];
}

export interface SourceTimeMetadata {
  source_time_label?: string;
  time_basis?: string;
}

export type SourceTimeMetadataFactory = (context: {
  result: PerceptionResult;
  segment: Segment;
  mediaStartMs: number;
  mediaDurationMs: number;
}) => SourceTimeMetadata | undefined;

export interface BuildPerceptionAddRequestOptions {
  result: PerceptionResult;
  segment: Segment;
  userId: string;
  sourceTimeMetadata?: SourceTimeMetadata;
}

export interface CreateMemoryReidAdapterOptions {
  memClient: Pick<ReflectWorldClient, "reidSearch" | "reidUpsert" | "reidGalleryUpdate"> & Partial<Pick<ReflectWorldClient, "reidBatchInit" | "reidUpdateIdentity">>;
  userId: string;
  cameraId?: () => string | undefined;
}

export interface CreateMemoryStorePerceptionOptions {
  memClient: Pick<ReflectWorldClient, "add">;
  userId: string;
  semanticMode?: AddMemoryRequest["semantic_mode"];
  sourceTimeMetadataForSegment?: SourceTimeMetadataFactory;
  onStored?: (
    response: AddMemoryResponse,
    context: PerceptionAddRequestContext & { request: AddMemoryRequest; result: PerceptionResult; segment: Segment },
  ) => void;
}

function defaultEntityId(): string {
  return `entity_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeRetrievalCompact(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => cleanString(item))
    .filter((item): item is string => !!item)
    .slice(0, 8)
    .map((item) => item.split(/\s+/).slice(0, 8).join(" "));
  return items.length > 0 ? items : undefined;
}

function readReidDisplayMetadata(value: unknown): {
  subject_index?: number | null;
  name?: string | null;
  first_seen?: string | number | null;
} | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.subject_index === "number" ? { subject_index: record.subject_index } : {}),
    ...(typeof record.name === "string" ? { name: record.name } : {}),
    ...(typeof record.first_seen === "string" || typeof record.first_seen === "number" ? { first_seen: record.first_seen } : {}),
  };
}

function formatOffsetTime(ms: number): string {
  const safeMs = Math.max(0, Math.round(ms));
  const hours = Math.floor(safeMs / 3_600_000);
  const minutes = Math.floor((safeMs % 3_600_000) / 60_000);
  const seconds = Math.floor((safeMs % 60_000) / 1000);
  const centiseconds = Math.floor((safeMs % 1000) / 10);
  const base = [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    String(seconds).padStart(2, "0"),
  ].join(":");
  return centiseconds > 0 ? `${base}.${String(centiseconds).padStart(2, "0")}` : base;
}

function formatDatasetDayTime(ms: number): string {
  const safeMs = Math.max(0, Math.round(ms));
  const dayIndex = Math.floor(safeMs / 86_400_000) + 1;
  const dayOffsetMs = safeMs % 86_400_000;
  return `DAY${dayIndex} ${formatOffsetTime(dayOffsetMs)}`;
}

function inferDefaultTimeBasis(mediaStartMs: number): string {
  return mediaStartMs >= 946_684_800_000 ? "wall_clock" : "video_relative";
}

function formatSourceTimeLabel(mediaStartMs: number, mediaDurationMs: number, timeBasis: string): string {
  const endMs = mediaDurationMs > 0 ? mediaStartMs + mediaDurationMs : undefined;
  if (timeBasis === "wall_clock") {
    const start = new Date(mediaStartMs).toISOString();
    return endMs !== undefined ? `${start}-${new Date(endMs).toISOString()}` : start;
  }
  const formatter = timeBasis === "dataset_day_time" ? formatDatasetDayTime : formatOffsetTime;
  const start = formatter(mediaStartMs);
  return endMs !== undefined ? `${start}-${formatter(endMs)}` : start;
}

export function buildSourceTimeMetadata(
  mediaStartMs: number,
  mediaDurationMs: number,
  timeBasis?: string,
): SourceTimeMetadata {
  const basis = cleanString(timeBasis) ?? inferDefaultTimeBasis(mediaStartMs);
  return {
    source_time_label: formatSourceTimeLabel(mediaStartMs, mediaDurationMs, basis),
    time_basis: basis,
  };
}

function normalizeSourceTimeMetadata(value: SourceTimeMetadata | undefined): SourceTimeMetadata {
  const sourceTimeLabel = cleanString(value?.source_time_label);
  const timeBasis = cleanString(value?.time_basis);
  return {
    ...(sourceTimeLabel ? { source_time_label: sourceTimeLabel } : {}),
    ...(timeBasis ? { time_basis: timeBasis } : {}),
  };
}

export function buildPerceptionAddRequest(options: BuildPerceptionAddRequestOptions): {
  request: AddMemoryRequest;
  context: PerceptionAddRequestContext;
} {
  const { result, segment, userId } = options;
  const segmentAnalysis = result.perception_memory;
  const mediaStartMs = segment.timestamp;
  const mediaDurationMs = Math.max(0, Math.round((segment.duration_sec ?? 0) * 1000));
  const sourceTimeMetadata = normalizeSourceTimeMetadata(
    options.sourceTimeMetadata ?? buildSourceTimeMetadata(mediaStartMs, mediaDurationMs),
  );
  const memorySubjects = (segmentAnalysis.entities ?? []).map((entity) => ({
    entity_id: entity.entity_id,
    class_name: entity.type,
    appearance: entity.appearance,
    behavior: entity.behavior,
    interaction: entity.interaction,
    name: entity.name,
    identity_evidence: entity.identity_evidence,
  }));

  const entityObservations = memorySubjects.flatMap((subject): PerceptionEntityObservation[] => {
    if (!subject.entity_id) return [];
    return [{
      entity_id: subject.entity_id,
      class_name: subject.class_name,
      appearance: subject.appearance,
      behavior: subject.behavior,
      interaction: subject.interaction,
    }];
  });
  const mediaUrls = [
    result.media_urls?.raw,
    result.media_urls?.gif,
    ...(result.media_urls?.keyframes ?? []),
  ].filter(Boolean) as string[];

  const dialogueTargets = (segmentAnalysis.entities ?? []).map((entity) => {
    const type = entity.type || "object";
    const normalizedType = type.toLowerCase();
    const fallbackPrefix = normalizedType === "person"
      ? "Person"
      : normalizedType === "dog"
        ? "Dog"
        : normalizedType === "cat"
          ? "Cat"
          : normalizedType === "car" || normalizedType === "vehicle"
            ? "Car"
            : normalizedType ? normalizedType[0]!.toUpperCase() + normalizedType.slice(1) : "Object";
    const label = entity.name ?? (entity.subject_index ? `${fallbackPrefix} ${entity.subject_index}` : undefined);
    return {
      entity_id: entity.entity_id,
      target_id: entity.track_id,
      type,
      name: entity.name,
      label,
      appearance: entity.appearance,
    };
  });
  const dialogueProjection = projectDialogueEvents({
    ...(result.transcript ? { transcript: result.transcript } : {}),
    ...(result.dialogue?.length ? { dialogue: result.dialogue } : {}),
  }, dialogueTargets);
  const speechEventsText = dialogueProjection.speech_events_text;
  const retrievalCompact = normalizeRetrievalCompact(segmentAnalysis.retrieval_compact);
  const speechText = cleanString(result.transcript);

  // Add normalized identity bindings as entity observations for semantic inference.
  // Pipeline has already resolved VLM target.identity into EntityRecord.name,
  // so memory does not need to understand raw VLM identity fields.
  const identityObservations = new Map<string, { entity_id: string; name: string; evidence?: string }>();
  for (const entity of segmentAnalysis.entities ?? []) {
    const name = cleanString(entity.name);
    if (!entity.entity_id || !name) continue;
    const evidence = cleanString(entity.identity_evidence);
    const key = `${entity.entity_id}\t${name.toLowerCase()}\t${evidence ?? ""}`;
    if (identityObservations.has(key)) continue;
    identityObservations.set(key, {
      entity_id: entity.entity_id,
      name,
      ...(evidence ? { evidence } : {}),
    });
    entityObservations.push({
      entity_id: entity.entity_id,
      message: `This person is called "${name}".${evidence ? ` ${evidence}` : ""}`,
      class_name: "person",
    });
  }

  return {
    request: {
      video_data: {
        summary: segmentAnalysis.summary,
        detailed_summary: segmentAnalysis.detailed_summary,
        ...(retrievalCompact ? { retrieval_compact: retrievalCompact } : {}),
        security_risk: segmentAnalysis.security_risk,
        main_targets: memorySubjects,
        media_urls: mediaUrls,
        media_assets: result.media_urls,
        ...(result.transcript ? { transcript: result.transcript } : {}),
        ...(speechEventsText ? { speech_events_text: speechEventsText } : {}),
      },
      entity_data: entityObservations.length > 0 ? entityObservations : undefined,
      camera_id: segment.camera_id,
      user_id: userId,
      mode: segment.mode,
      event_id: result.event_id,
      video_id: segment.segment_id,
      metadata: {
        segment_id: segment.segment_id,
        media_urls: mediaUrls,
        media_assets: result.media_urls,
        media_start_ms: mediaStartMs,
        media_duration_ms: mediaDurationMs,
        ...(speechText ? { speech_text: speechText } : {}),
        ...(retrievalCompact ? { retrieval_compact: retrievalCompact } : {}),
        ...(sourceTimeMetadata.source_time_label ? { source_time_label: sourceTimeMetadata.source_time_label } : {}),
        ...(sourceTimeMetadata.time_basis ? { time_basis: sourceTimeMetadata.time_basis } : {}),
        ...(dialogueProjection.dialogue?.length ? { dialogue: dialogueProjection.dialogue } : {}),
        ...(identityObservations.size > 0
          ? { identity_observations: [...identityObservations.values()] }
          : {}),
      },
      infer: true,
    },
    context: {
      segmentAnalysis,
      memorySubjects,
      entityObservations,
    },
  };
}

export function createMemoryStorePerception(
  options: CreateMemoryStorePerceptionOptions,
): NonNullable<PipelineMemory["storePerception"]> {
  const { memClient, userId, semanticMode, sourceTimeMetadataForSegment, onStored } = options;
  return async (result, segment) => {
    const mediaStartMs = segment.timestamp;
    const mediaDurationMs = Math.max(0, Math.round((segment.duration_sec ?? 0) * 1000));
    const { request, context } = buildPerceptionAddRequest({
      result,
      segment,
      userId,
      sourceTimeMetadata: sourceTimeMetadataForSegment?.({ result, segment, mediaStartMs, mediaDurationMs }),
    });
    if (semanticMode) {
      request.semantic_mode = semanticMode;
    }
    const addStartedAt = Date.now();
    const response = await memClient.add(request);
    const addHttpMs = Date.now() - addStartedAt;
    if (result._trace) {
      result._trace.context.decision_context ??= {};
      result._trace.context.decision_context.memory_profile = {
        ...result._trace.context.decision_context.memory_profile,
        add_http_ms: addHttpMs,
        service_profile: response.profile,
      };
    }
    onStored?.(response, { ...context, request, result, segment });
  };
}

export function createMemoryReidAdapter(options: CreateMemoryReidAdapterOptions): PipelineMemory {
  const { memClient, userId, cameraId } = options;
  const sourceCameraId = () => {
    const id = cameraId?.();
    return typeof id === "string" && id.trim() ? id.trim() : undefined;
  };
  const sourceCameraField = () => {
    const id = sourceCameraId();
    return id ? { camera_id: id } : {};
  };
  const adapter: PipelineMemory = {
    async reidSearch(embedding, type) {
      const resp = await memClient.reidSearch({
        vector: embedding,
        collection: type === "face" ? "reid_face" : "reid_entity",
        limit: 5,
        threshold: REID_MATCH_THRESHOLD,
        user_id: userId,
        include_history: true,
      });
      return resp.results.map((result) => ({
        entity_id: result.entity_id ?? "unknown",
        score: result.score,
        type,
        subject_index: result.subject_index,
        name: result.name,
        first_seen: result.first_seen,
        semantic_memories: result.semantic_memories,
        episodic_memories: result.episodic_memories,
      }));
    },
    async reidUpsert(embeddings, identity) {
      const entityId = defaultEntityId();
      const identityFields = {
        ...(identity?.category ? { category: identity.category } : {}),
        ...(identity?.subject_index != null ? { subject_index: identity.subject_index } : {}),
        ...(identity?.name ? { name: identity.name } : {}),
        ...(identity?.first_seen != null ? { first_seen: identity.first_seen } : {}),
      };
      const promises: Promise<unknown>[] = [];
      if (embeddings.face) {
        promises.push(memClient.reidUpsert({
          entity_id: entityId,
          vector: embeddings.face.vector,
          collection: "reid_face",
          quality: embeddings.face.quality,
          yaw: embeddings.face.yaw,
          pitch: embeddings.face.pitch,
          user_id: userId,
          ...sourceCameraField(),
          ...identityFields,
        }));
      }
      if (embeddings.body) {
        promises.push(memClient.reidUpsert({
          entity_id: entityId,
          vector: embeddings.body.vector,
          collection: "reid_entity",
          quality: embeddings.body.quality,
          user_id: userId,
          ...sourceCameraField(),
          ...identityFields,
        }));
      }
      const responses = await Promise.all(promises);
      const display = responses.map(readReidDisplayMetadata).find(Boolean);
      return {
        entity_id: entityId,
        ...display,
      };
    },
    async reidGalleryUpdate(entityId, embeddings) {
      const promises: Promise<unknown>[] = [];
      if (embeddings.face) {
        promises.push(memClient.reidGalleryUpdate({
          entity_id: entityId,
          vector: embeddings.face.vector,
          collection: "reid_face",
          quality: embeddings.face.quality,
          yaw: embeddings.face.yaw,
          pitch: embeddings.face.pitch,
          user_id: userId,
          ...sourceCameraField(),
        }));
      }
      if (embeddings.body) {
        promises.push(memClient.reidGalleryUpdate({
          entity_id: entityId,
          vector: embeddings.body.vector,
          collection: "reid_entity",
          quality: embeddings.body.quality,
          body_yaw_ratio: embeddings.body.body_yaw_ratio,
          visibility: embeddings.body.visibility,
          user_id: userId,
          ...sourceCameraField(),
        }));
      }
      await Promise.all(promises);
    },
  };

  const reidBatchInit = memClient.reidBatchInit;
  if (typeof reidBatchInit === "function") {
    adapter.reserveEntityId = () => defaultEntityId();
    adapter.reidBatchInit = async (request) => {
      const result = await memClient.reidBatchInit!({
        ...request,
        user_id: userId,
        ...sourceCameraField(),
      });
      return result;
    };
  }

  const reidUpdateIdentity = memClient.reidUpdateIdentity;
  if (typeof reidUpdateIdentity === "function") {
    adapter.reidUpdateIdentity = async (entityId, name, identity) => {
      await reidUpdateIdentity.call(memClient, {
        entity_id: entityId,
        name,
        user_id: userId,
        ...(identity?.subject_index != null ? { subject_index: identity.subject_index } : {}),
      });
    };
  }

  return adapter;
}

export function countAddMemoryTypes(response: AddMemoryResponse): Record<string, number> {
  return response.results.reduce<Record<string, number>>((counts, item) => {
    const resultItem: { memory_type?: unknown; collection?: unknown } = item;
    const collection = typeof resultItem.collection === "string" ? resultItem.collection : undefined;
    const memoryType = typeof resultItem.memory_type === "string"
      ? resultItem.memory_type
      : MEMORY_COLLECTION_NAMES
        .find((type) => collection?.endsWith(`_${type}`));
    const key = memoryType ?? "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

/** All collection names the Python service may return in add() results. */
export const MEMORY_COLLECTION_NAMES = [
  "episodic_trace",
  "episodic_entity",
  "episodic_schema",
  "episodic_visual",
  "semantic_entity",
  "semantic_context",
  "procedural",
  "reid_entity",
  "reid_face",
] as const;
