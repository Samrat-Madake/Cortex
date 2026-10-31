// packages/mem/src/types.ts

/**
 * Capture mode indicating how the video segment was triggered.
 * - snapshot: single-frame capture
 * - event: motion/alarm triggered capture
 * - stream: continuous analysis
 */
export type CaptureMode = "snapshot" | "event" | "stream";
export type SemanticMode = "inline" | "background";

/**
 * Memory collection types supported by ReflectWorld.
 *
 * The new taxonomy has 7 collections in 3 groups:
 *   episodic:  trace, entity, schema, visual
 *   semantic:  entity, context
 *   procedural
 *
 * Client names now match server names — no translation needed.
 */

// Text-searchable collections (POST /search, GET /memories)
export type TextCollection =
  | "episodic_trace"
  | "episodic_entity"
  | "episodic_schema"
  | "semantic_entity"
  | "semantic_context"
  | "procedural";

// Non-text collections (GET /memories only, NOT POST /search)
export type VisualCollection = "episodic_visual";

export type MemoryCollection = TextCollection | VisualCollection;

export type MemoryGroup = "episodic" | "semantic" | "all";

// For POST /search — only text collections + group aliases (compile-time safety)
export type SearchMemoryType = TextCollection | MemoryGroup;

// For GET /memories — all collections + group aliases
export type GetMemoryType = MemoryCollection | MemoryGroup;

// For POST /memories (add) — only collections that go through the generic add endpoint
export type WriteMemoryType = "semantic_entity" | "procedural";

// Union for general use
export type MemoryType = MemoryCollection | MemoryGroup;

/**
 * ReID vector collection names.
 */
export type ReidCollection = "reid_entity" | "reid_face";

// -- Add memory ---------------------------------------------------------------

/** video_data payload sent to POST /memories */
export interface VideoData {
  summary?: string;
  security_risk?: boolean;
  is_static_scene?: boolean;
  main_targets?: MainTarget[];
  scene_change?: Record<string, unknown>;
  media_urls?: string[];
  [key: string]: unknown;
}

export interface MainTarget {
  track_id?: string;
  entity_id?: string;
  behavior?: string;
  appearance?: string;
  interaction?: string;
  [key: string]: unknown;
}

/** Entity data for per-entity episodic + semantic memory creation */
export interface EntityDataItem {
  entity_id: string;
  class_name?: string;
  appearance?: string;
  behavior?: string;
  interaction?: string;
  [key: string]: unknown;
}

/** Request body for POST /memories */
export interface AddMemoryRequest {
  video_data?: VideoData;
  /** Per-entity data — drives entity episodic memories + semantic extraction. */
  entity_data?: EntityDataItem[];
  messages?: string | Record<string, unknown> | Array<Record<string, unknown>>;
  user_id?: string;
  agent_id?: string;
  run_id?: string;
  video_id?: string;
  camera_id?: string;
  metadata?: Record<string, unknown>;
  infer?: boolean;
  semantic_mode?: SemanticMode;
  memory_type?: WriteMemoryType;
  prompt?: string;
  mode?: CaptureMode;
  event_id?: string;
}

/** Single result item returned by add() */
export interface AddMemoryResultItem {
  id: string;
  memory: unknown;
  event: "ADD" | "UPDATE" | "DELETE" | "NONE";
  memory_type: MemoryCollection;
  actor_id?: string | null;
  role?: string;
  entity_id?: string;
  entity_class?: string;
  categories?: string;
  run_ids?: string[];
}

/** Response from POST /memories */
export interface AddMemoryResponse {
  results: AddMemoryResultItem[];
  relations?: unknown[];
  profile?: {
    name?: string;
    total_ms?: number;
    stages?: Record<string, {
      count?: number;
      total_ms?: number;
      max_ms?: number;
      avg_ms?: number;
    }>;
    counters?: Record<string, number>;
    metadata?: Record<string, unknown>;
  };
}

// -- Search -------------------------------------------------------------------

/** Request body for POST /search */
export interface SearchRequest {
  query: string;
  user_id?: string;
  agent_id?: string;
  run_id?: string;
  entity_id?: string;
  camera_id?: string;
  mode?: CaptureMode;
  memory_type?: SearchMemoryType;
  limit?: number;
  threshold?: number;
  filters?: Record<string, unknown>;
}

/** Single search hit */
export interface SearchResultItem {
  id: string;
  memory: string;
  score: number;
  memory_type?: MemoryCollection;
  hash?: string;
  created_at?: string;
  updated_at?: string;
  camera_id?: string;
  entity_id?: string;
  entity_ids?: string[];
  run_id?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Response from POST /search.
 *
 * ReflectWorld returns collection-keyed results, e.g.:
 *   { "visionmem_me_production_episodic": [...], ... }
 *
 * Use `flattenSearchResults()` to get a flat array.
 */
export interface SearchResponse {
  results?: SearchResultItem[];
  episodic?: SearchResultItem[];
  semantic?: SearchResultItem[];
  procedural?: SearchResultItem[];
  /** Dynamic collection keys from ReflectWorld (e.g. "visionmem_me_production_episodic") */
  [collection: string]: SearchResultItem[] | undefined;
}

/** Flatten all search results from a SearchResponse into a single array. */
export function flattenSearchResults(response: SearchResponse): SearchResultItem[] {
  const all: SearchResultItem[] = [];
  for (const [, value] of Object.entries(response)) {
    if (Array.isArray(value)) {
      all.push(...value);
    }
  }
  return all;
}

// -- Get memories (list) ------------------------------------------------------

/** Query params for GET /memories */
export interface GetMemoriesRequest {
  user_id?: string;
  agent_id?: string;
  run_id?: string;
  video_id?: string;
  entity_id?: string;
  camera_id?: string;
  memory_type?: GetMemoryType;
  limit?: number;
  /** Sort order: 'asc' for oldest-first, 'desc' (default) for newest-first. */
  sort_order?: "asc" | "desc";
}

/** Single memory item returned by GET /memories */
export interface MemoryItem {
  id: string;
  memory: string;
  hash?: string;
  metadata?: Record<string, unknown> | null;
  created_at?: string;
  updated_at?: string;
  role?: string;
  entity_ids?: string[];
  camera_id?: string;
}

/**
 * Response from GET /memories.
 *
 * ReflectWorld returns either:
 * - a flat array of memory items, or
 * - a collection-keyed object like
 *   { "reflectworld_test_episodic_trace": [...], "reflectworld_test_semantic_entity": [...] }
 */
export type GetMemoriesResponse =
  | MemoryItem[]
  | Record<string, MemoryItem[] | undefined>;

/** Flatten GET /memories responses into a single array. */
export function flattenMemoriesResponse(response: GetMemoriesResponse): MemoryItem[] {
  if (Array.isArray(response)) return response;
  const all: MemoryItem[] = [];
  for (const value of Object.values(response)) {
    if (Array.isArray(value)) {
      all.push(...value);
    }
  }
  return all;
}

// -- Specialized write endpoints ----------------------------------------------

/** Request body for POST /memories/schema (episodic_schema creation) */
export interface AddSchemaRequest {
  summary: string;
  event_ids: string[];
  time_range: { start_ms: number; end_ms: number };
  camera_id: string;
  user_id?: string;
}

/** Request body for PUT /memories/context (semantic_context upsert) */
export interface UpsertContextRequest {
  camera_id: string;
  scene_description: string;
  known_entities: string;
  daily_routine: string;
  anomaly_baseline: string;
  user_notes?: string;
  user_id?: string;
  /** SemanticContext state fields — persisted to Qdrant so cold-start hydration restores them. */
  last_llm_update?: string;
  last_update_segment_count?: number;
  last_agent_consult?: string;
  last_consult_segment_count?: number;
  consecutive_no_updates?: number;
}

// -- Delete memories ----------------------------------------------------------

/** Query params for DELETE /memories (batch) */
export interface DeleteMemoriesRequest {
  user_id?: string;
  agent_id?: string;
  run_id?: string;
  video_id?: string;
  entity_id?: string;
  camera_id?: string;
  memory_type?: MemoryType;
  data_type?: string;
}

/** Query params for DELETE /memories/{memory_id} */
export interface DeleteMemoryByIdRequest {
  memory_id: string;
  memory_type?: MemoryType;
  data_type?: string;
}

/** Response from DELETE endpoints */
export interface DeleteMemoryResponse {
  message: string;
}

// -- expire_media -------------------------------------------------------------

/** Request body for PATCH /memories/expire_media */
export interface ExpireMediaRequest {
  segment_id: string;
  camera_id?: string;
}

/** Response from PATCH /memories/expire_media */
export interface ExpireMediaResponse {
  segment_id: string;
  updated_count: number;
  status: "ok" | "error";
}

// -- set_identity --------------------------------------------------------------

/** Request body for POST /identity/set */
export interface SetIdentityRequest {
  entity_id: string;
  identity: string;
  status?: string;
  user_id?: string;
  camera_id?: string;
}

/** Response from POST /identity/set */
export interface SetIdentityResponse {
  entity_id: string;
  user_id?: string | null;
  memory_id: string;
  event: "ADD" | "UPDATE";
  identity: string;
}

// -- ReID ---------------------------------------------------------------------

/** Request body for POST /reid/search */
export interface ReidSearchRequest {
  vector: number[];
  collection: ReidCollection;
  limit?: number;
  threshold?: number;
  user_id?: string;
  /** If true, return semantic memories for matched entities. */
  include_history?: boolean;
}

/** Single ReID search hit */
export interface ReidSearchHit {
  entity_id: string | null;
  score: number;
  /** Stable per-user subject number assigned by the ReID service. */
  subject_index?: number | null;
  /** Real identity name when identity resolution has promoted one. */
  name?: string | null;
  /** First-seen timestamp for this ReID entity, if available. */
  first_seen?: string | number | null;
  user_id?: string | null;
  updated_at?: string | null;
  metadata?: Record<string, unknown>;
  /** Semantic memories sorted by importance (only when include_history=true). */
  semantic_memories?: string[];
  /** Recent episodic memories sorted by time desc (only when include_history=true). */
  episodic_memories?: string[];
}

/** Response from POST /reid/search */
export interface ReidSearchResponse {
  collection: ReidCollection;
  results: ReidSearchHit[];
}

/** Request body for POST /reid/upsert */
export interface ReidUpsertRequest {
  entity_id: string;
  vector: number[];
  collection: ReidCollection;
  quality?: number;
  /** Estimated face yaw in degrees (stored in slot 0 payload). */
  yaw?: number;
  /** Estimated face pitch in degrees (stored in slot 0 payload). */
  pitch?: number;
  user_id?: string;
  /** Source camera/video where this feature was observed. Stored for cleanup, not used for default ReID search. */
  camera_id?: string;
  category?: string;
  subject_index?: number;
  name?: string;
  first_seen?: string | number;
  metadata?: Record<string, unknown>;
}

/** Response from POST /reid/upsert */
export interface ReidUpsertResponse {
  id: string;
  entity_id: string;
  collection: ReidCollection;
  event: "INSERT" | "UPDATE";
  subject_index?: number | null;
  name?: string | null;
  first_seen?: string | number | null;
}

/** Request body for PATCH /reid/identity */
export interface ReidUpdateIdentityRequest {
  entity_id: string;
  user_id?: string;
  name: string;
  subject_index?: number;
}

/** Response from PATCH /reid/identity */
export interface ReidUpdateIdentityResponse {
  entity_id: string;
  user_id?: string | null;
  name: string;
  subject_index?: number | null;
  first_seen?: string | number | null;
  updated: number;
}

/** Request body for POST /reid/gallery-update */
export interface ReidGalleryUpdateRequest {
  entity_id: string;
  vector: number[];
  collection: ReidCollection;
  quality?: number;
  /** Estimated face yaw in degrees (for pose-aware gallery diversity). */
  yaw?: number;
  /** Estimated face pitch in degrees (for pose-aware gallery diversity). */
  pitch?: number;
  /** Body yaw ratio for pose-aware gallery diversity. */
  body_yaw_ratio?: number;
  /** Body visibility descriptor (e.g. "full", "upper", "lower"). */
  visibility?: string;
  user_id?: string;
  /** Source camera/video where this feature was observed. Stored for cleanup, not used for default ReID search. */
  camera_id?: string;
}

/** Response from POST /reid/gallery-update */
export interface ReidGalleryUpdateResponse {
  entity_id: string;
  collection: ReidCollection;
  action: "ADD" | "REPLACE" | "SKIP";
  slot_idx: number;
}

// -- Batch Init ---------------------------------------------------------------

/** Single vector entry for batch gallery initialization. */
export interface BatchInitVectorEntry {
  vector: number[];
  quality: number;
  yaw?: number;
  pitch?: number;
  body_yaw_ratio?: number;
  visibility?: string;
}

/** Request body for POST /reid/batch-init */
export interface BatchInitRequest {
  entity_id: string;
  face_vectors?: BatchInitVectorEntry[];
  body_vectors?: BatchInitVectorEntry[];
  user_id?: string;
  /** Source camera/video where these features were observed. Stored for cleanup, not used for default ReID search. */
  camera_id?: string;
  category?: string;
  subject_index?: number;
  name?: string;
  first_seen?: string | number;
}

/** Response from POST /reid/batch-init */
export interface BatchInitResponse {
  entity_id: string;
  face_slots_written: number;
  body_slots_written: number;
  event: "BATCH_INIT";
  subject_index?: number | null;
  name?: string | null;
  first_seen?: string | number | null;
}

/** Query params for DELETE /reid */
export interface ReidDeleteRequest {
  user_id?: string;
  camera_id: string;
}

/** Response from DELETE /reid */
export interface ReidDeleteResponse {
  deleted: Record<ReidCollection, number>;
  total_deleted: number;
}

// -- Health -------------------------------------------------------------------

export interface HealthResponse {
  status: "healthy";
  version: string;
  service: string;
  collection_prefix?: string;
  memory_types: string[];
  reid_collections: ReidCollection[];
  vector_store: string;
  llm_provider: string;
  embedder_provider: string;
}

export interface StatusResponse {
  status: "healthy" | "not_initialized";
  version: string;
  service: string;
  memory_types: string[];
  reid_collections: ReidCollection[];
  vector_store: string;
  llm_provider: string;
  embedder_provider: string;
  initialized: boolean;
}
