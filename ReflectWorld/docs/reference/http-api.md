# HTTP API Reference

This reference is for integrators and contributors. It covers two HTTP surfaces:

1. The **mem service**: a Python FastAPI service under `services/mem`, responsible for memory storage, retrieval, and ReID vector management.
2. The **dashboard / host HTTP API**: the unified TypeScript HTTP server started by `npx @reflectworld/reflectworld start`, defaulting to `http://localhost:3210`. It serves the UI, tool calls, source management, memory proxying, media, and WebSockets.

This page documents the current interface contract. Mutation, proxy, chat, and webhook endpoints require a session or token in multi-user mode; single-user local mode remains open by default.

Type notation: `?` means optional. `string`, `number`, `boolean`, `object`, and `array` are JSON types.

The Dashboard also uses realtime WebSocket events internally. Those events are
not treated as a stable public integration API in the first open-source release;
prefer the HTTP endpoints unless you are contributing to the Dashboard itself.

## Mem Service HTTP API

- Process: Python FastAPI, source in `services/mem/src/main.py`; request models in `services/mem/src/models.py`.
- Default listen address: `127.0.0.1:8219`, with the port injected by the host through `REFLECTWORLD_MEM_PORT`.
- Authentication assumption: the mem service binds to loopback and is called internally by the TypeScript host over `127.0.0.1`. Public or multi-machine deployments should add shared-token middleware. Current source has no auth middleware, so this document assumes deployment on a trusted local network.
- Multimodal memory model: 9 Qdrant collections organized by time scale and abstraction level: `episodic_trace`, `episodic_entity`, `episodic_schema`, `episodic_visual`, `semantic_entity`, `semantic_context`, `procedural`, plus ReID collections `reid_entity` and `reid_face`.
- Scope identifiers: most reads and writes filter by `user_id`, the memory isolation key, with optional `camera_id`, `entity_id`, `video_id`, and similar identifiers.

### Memory CRUD

#### `POST /memories` - Create Memory

Writes memory from video analysis, entity data, or raw messages. Episodic trace/entity routing is inferred from the data.

Request body, `MemoryCreateRequest`:

| Field | Type | Description |
|---|---|---|
| `video_data` | object? | Structured video analysis payload, including summary and targets. |
| `entity_data` | array? | Per-entity data that drives episodic and semantic memory generation. |
| `messages` | any? | Raw input: string, object, or list of objects. |
| `user_id` | string? | User scope, the primary memory isolation key. |
| `agent_id` / `run_id` / `video_id` / `camera_id` | string? | Additional scope identifiers. |
| `metadata` | object? | Additional metadata. |
| `infer` | boolean? | Whether to run LLM inference on the input. Defaults to `true`. |
| `memory_type` | string? | `semantic_entity` or `procedural`. Trace/entity are inferred from data; schema/context use dedicated endpoints. |
| `prompt` | string? | Custom LLM prompt. |
| `mode` | string? | Capture mode: `snapshot`, `event`, or `stream`. |
| `event_id` | string? | Event id when `mode='event'`. |

Perception writes include timeline metadata inside `metadata`:

- `media_start_ms` and `media_duration_ms` contain the numeric source interval;
- `source_time_label` is its human-readable interval;
- `time_basis` explains how to interpret the interval, normally
  `video_relative`, `wall_clock`, or a dataset-specific basis such as
  `dataset_day_time`.

Older or direct API writes may omit the two source-time fields. Readers must
continue to use `media_start_ms` as the fallback rather than assuming wall-clock
time.

Response: `{ results: [{ id, collection, memory, event, entity_id?, importance? }, ...] }`. Semantic and procedural writes trigger the `memory:memory_added` Monitor webhook.

Errors: `memory_type` equal to `episodic_schema` or `semantic_context` returns 400 and must use the dedicated endpoint. `ValueError` maps to 400; other exceptions map to 500.

#### `GET /memories` - List Memories

Lists stored memories by identifiers.

Query parameters: `user_id`, `agent_id`, `run_id`, `video_id`, `entity_id`, `camera_id`, `memory_type`; `limit` defaults to 100; `sort_order` is `asc` for oldest first or `desc` for newest first. At least one identifier is required, otherwise the service returns 400.

Response: a list of memory objects. Shape depends on `memory_type`.

#### `GET /memories/{memory_id}` - Get One Memory

Path parameter: `memory_id`.

Query parameters: `memory_type`?, `return_all_matches`? defaulting to false.

Response: one memory object. Missing memory returns 404.

#### `GET /memories/{memory_id}/history` - Memory History

Response: change history for the memory. Missing history returns 404.

#### `PUT /memories/{memory_id}` - Update Memory

Path parameter: `memory_id`. Query parameter: `memory_type`?.

Request body, `UpdateMemoryRequest`: `data` is the new content or base64 embedding; `data_type`? defaults to `"txt"`.

Response: update result. `ValueError` maps to 404.

#### `DELETE /memories/{memory_id}` - Delete One Memory

Path parameter: `memory_id`. Query parameters: `memory_type`?, `data_type`? defaulting to `"txt"`.

Response: delete result. `ValueError` maps to 404.

#### `DELETE /memories` - Bulk Delete Memories

Query parameters: `user_id`, `agent_id`, `run_id`, `video_id`, `entity_id`, `camera_id`, `memory_type`, `data_type`. At least one identifier is required, otherwise the service returns 400.

Response: delete result.

#### `POST /search` - Semantic Search

Request body, `SearchRequest`:

| Field | Type | Description |
|---|---|---|
| `query` | string | Required search text or base64-encoded embedding. |
| `user_id` / `agent_id` / `run_id` / `entity_id` / `camera_id` / `video_id` | string? | Filter identifiers. |
| `mode` | string? | Capture mode filter: `snapshot`, `event`, or `stream`. |
| `memory_type` | string? | Collection name or group alias, such as `episodic`, `semantic`, or `all`. |
| `limit` | number? | Maximum result count. Defaults to 100. |
| `threshold` | number? | Minimum similarity score. |
| `filters` | object? | Additional key-value filters passed to the vector store. |

Response: matching memory list with similarity scores. `ValueError` maps to 400.

### Dedicated Memory Writes

#### `POST /memories/schema` - Add Episodic Schema

Aggregates multiple events into one schema-level summary.

Request body, `AddSchemaRequest`: `summary` string required, `event_ids` array of strings required, `time_range` object with `start_ms` and `end_ms` required, `camera_id` string required, and `user_id`? defaulting to `"default"`.

Response: creation result.

#### `PUT /memories/context` - Upsert Semantic Context

Creates or updates Semantic Context for one camera, including scene, known entities, routine, and anomaly baseline.

Request body, `UpsertContextRequest`:

| Field | Type | Description |
|---|---|---|
| `camera_id` | string | Required camera being described. |
| `scene_description` | string | Required scene description. |
| `known_entities` | string | Required known entities. |
| `daily_routine` | string | Required daily routine. |
| `anomaly_baseline` | string | Required anomaly baseline. |
| `user_notes` | string? | User notes preserved across LLM profile updates. |
| `user_id` | string? | Defaults to `"default"`. |
| `last_llm_update` | string? | ISO timestamp of the last LLM update, used for cold-start recovery. |
| `last_update_segment_count` | number? | Segment count at the last LLM update. |
| `last_agent_consult` | string? | ISO timestamp of the last agent consultation. |
| `last_consult_segment_count` | number? | Segment count at the last consultation. |
| `consecutive_no_updates` | number? | Consecutive LLM cycles without updates. |

Response: upsert result.

#### `POST /identity/set` - Set Entity Identity

Creates or updates an identity memory with `category=identity` and `importance=1.0`. Identity memories are protected from LLM merge rewrites.

Request body, `SetIdentityRequest`: `entity_id` required, for example `person_5`; `identity` required, for example `Neighbor Zhang, familiar`; `status`? defaults to `familiar` and may be `familiar`, `unfamiliar`, or `admin`; `user_id`?; `camera_id`?.

Response: creation or update result.

#### `PATCH /memories/expire_media` - Expire Media URLs

Marks episodic memory `media_urls` for a segment as expired by setting them to null. This supports graceful degradation after media retention expires.

Request body, `ExpireMediaRequest`: `segment_id` required, equal to the video id; `camera_id`? narrows the filter.

Response: expiration result.

### ReID Vector Management

ReID is an evidence system. It stores detection-produced face and body embedding vectors, but does not make identity decisions. Collections are limited to `reid_face` and `reid_entity`; other values return 400. `subject_index` is assigned and persisted by the host TypeScript side. The mem service does not allocate it and only echoes the value passed by TS. See the [architecture overview](../architecture/overview.md).

#### `POST /reid/search` - Search Similar Vectors

Request body, `ReidSearchRequest`: `vector` array of floats required, `collection` required as `reid_entity` or `reid_face`, `limit`? defaulting to 10, `threshold`? as minimum cosine similarity, `user_id`?, and `include_history`? defaulting to false. When `include_history` is true, the top hit includes semantic and episodic memories for the matched entity.

Response: `{ results: [{ entity_id, score, ...payload }] }`.

#### `POST /reid/upsert` - Upsert One Vector

Request body, `ReidUpsertRequest`:

| Field | Type | Description |
|---|---|---|
| `entity_id` | string | Required entity identifier. |
| `vector` | array[float] | Required feature vector. |
| `collection` | string | Required, `reid_entity` or `reid_face`. |
| `quality` | number | Detection quality score. Defaults to 0.5. Higher is more reliable. |
| `yaw` / `pitch` | number? | Face yaw and pitch stored in slot 0 payload. |
| `user_id` | string? | User that observed the feature. |
| `camera_id` | string? | Observation source; only used for cleanup, not default retrieval filtering. |
| `category` | string? | Subject category for display numbering. |
| `subject_index` | number? | Stable display number assigned by the host runtime. |
| `name` | string? | Resolved real-world identity name. |
| `first_seen` | any? | Host-assigned first-seen timestamp. |
| `metadata` | object? | Additional metadata. |

Response: upsert result.

#### `POST /reid/batch-init` - Batch Initialize Entity Gallery

Writes multiple embedding slots in one request. Face vectors are written first, then body vectors. Partial success, such as face success and body failure, still returns 200 with `body_slots_written:0`.

Request body, `ReidBatchInitRequest`: `entity_id` required; `face_vectors`? array of `{vector, quality?, yaw?, pitch?, body_yaw_ratio?, visibility?}`; `body_vectors`? with the same shape; `user_id`?; `camera_id`?; `category`?; `subject_index`?; `name`?; `first_seen`?. At least one of `face_vectors` or `body_vectors` must be non-empty, otherwise the service returns 400.

Response: batch write result with slot counts.

#### `POST /reid/gallery-update` - Diversity-Aware Gallery Update

Adds a new viewpoint for a matched entity, refreshes a higher-quality version, or skips when the existing version is better.

Request body, `ReidGalleryUpdateRequest`: `entity_id` required, `vector` required, `collection` required, `quality`? defaulting to 0.5, `yaw`?, `pitch`?, `body_yaw_ratio`? where >0.7 is front, 0.15-0.7 is side, and <0.15 is back, `visibility`? such as `full`, `upper`, or `partial`, `user_id`?, `camera_id`?.

Response: update result indicating add, refresh, or skip.

#### `PATCH /reid/identity` - Update ReID Identity Metadata

Writes a resolved real identity name into every gallery slot for an entity.

Request body, `ReidUpdateIdentityRequest`:

| Field | Type | Description |
|---|---|---|
| `entity_id` | string | Required ReID entity identifier. |
| `name` | string | Required resolved real identity name. |
| `user_id` | string? | User scope. |
| `subject_index` | number? | Stable display number assigned by host-side TypeScript. It is echoed to all gallery slots together with `name`, keeping the name rewrite and numbering snapshot synchronized. |

Response: update result including affected slot count.

#### `DELETE /reid` - Delete ReID Vectors By Camera/Source

Used for source lifecycle cleanup. ReID retrieval is scoped by `user_id`, not by `camera_id`.

Query parameters: `camera_id` required, `user_id`?.

Response: delete result.

#### `POST /reid/reset` - Reset Only ReID Collections

Deletes and recreates `reid_face` and `reid_entity`. It does not touch episodic, semantic, or procedural memory.

Response: reset result.

### Service Management

#### `POST /reset` - Reset All Memory

Clears every stored memory collection.

Response: `{ "message": "All memories reset successfully" }`.

Expected auth: dangerous operation. Public or multi-machine deployment should require an admin token; trusted local mode remains open.

#### `POST /ensure-collections` - Ensure Collections Exist

Re-runs collection creation for the current prefix. The operation is idempotent and does not modify existing collections. It is used when the managed mem process is alive but collections were externally removed, for example by E2E cleanup.

Response: `{ status, prefix, collections: [...] }`.

#### `GET /health` - Health Check

Response: `{ status:"healthy", version, service, collection_prefix, memory_types:[...], reid_collections:[...], vector_store:"qdrant", llm_provider, embedder_provider }`. This endpoint is not part of the OpenAPI schema.

#### `GET /status` - Manager Status

Response: the same fields as `/health`, plus `initialized` boolean. When not initialized, `status` is `"not_initialized"`.

## Dashboard / Host HTTP API

- Process topology: `npx @reflectworld/reflectworld start` creates one Node.js HTTP server in `packages/reflectworld/src/cli/start.ts`, defaulting to `http://localhost:3210`.
  - The top-level server directly handles `/api/health`, `/api/tools`, and `/api/tool/:name`.
  - All other paths are delegated to `DashboardServer` in `packages/reflectworld/src/services/dashboard-server.ts` through its `registerHandler` callback. This includes UI, source management, memory proxying, media, and WebSockets.
- CORS: both top-level and dashboard paths set `Access-Control-Allow-Origin: *` for local usability. Public deployments should tighten this.
- Auth model: the dashboard server has a dashboard session mechanism using `session_id` and `user_id`, passed by cookie or `x-dashboard-session-id` / `x-dashboard-user-id` header, query, or body.
  - Single-user local mode, with `sessionConfig.enabled=false`, is the default. `requireDashboardSession` allows requests without a session for the trusted local experience.
  - Multi-user mode, used by public demos or shared deployments, requires a valid session for mutation, proxy, and chat endpoints. `user_id` becomes the memory isolation key, and sources/memories are visible by session scope.
- Auth column notation: `public` means no session is required. `session in multi-user` means a session is required in multi-user mode and single-user mode remains open. `loopback-only` means only local loopback callers are accepted.

### Top-Level Host Endpoints

| Endpoint | Method | Purpose | Auth |
|---|---|---|---|
| `/api/health` | GET | Startup health state, including `starting`, `ready`, or `degraded`, registered tool count, and child service status. `ready` returns 200; `starting` returns 503. | public |
| `/api/tools` | GET | Lists all registered tools as `{ tools: [...] }`. | public |
| `/api/tool/:toolName` | POST | Invokes a registered tool with the request body as tool arguments. This is a local agent convenience surface for cam, percept, memory, and broad tools. | Trusted local open. When `REFLECTWORLD_PUBLIC_MODE=true` or `REFLECTWORLD_TOOL_API_RESTRICTED=true`, it requires an admin token. POST body default limit is 1 MB. |

### Dashboard Sessions

| Endpoint | Method | Request body | Response | Purpose |
|---|---|---|---|---|
| `/api/dashboard/session/start` | POST | `session_id`, `user_id` required; `is_admin`?, `admin_token`? | `{ ok, multi_user, session_id, user_id, max_active_sessions, max_sources_per_session, heartbeat_interval_ms, stale_ttl_ms }`; single-user mode returns `{ ok:true, multi_user:false }` | Creates or resumes a dashboard session and sets `vm_dashboard_session` and `vm_dashboard_user` HttpOnly cookies. Full capacity returns 429; invalid admin token returns 403; conflicting session binding returns 409. |
| `/api/dashboard/session/heartbeat` | POST | `session_id` required | `{ ok, multi_user }`; missing session returns 404 | Refreshes `lastSeen`. |
| `/api/dashboard/session/end` | POST | `session_id` | `{ ok, multi_user }` | Ends a session by marking it stale for cleanup. |
| `/api/dashboard/runtime` | GET | none | `{ go2rtc_api_port, multi_user, max_active_sessions, max_sources_per_session }` | Small set of public runtime facts needed by the UI. |

In single-user mode, all session endpoints return `multi_user:false` and act as no-ops.

### Dashboard State And Projection Reads

| Endpoint | Method | Parameters | Response | Auth |
|---|---|---|---|---|
| `/api/dashboard/state` | GET | none | `{ cursor, server_time, sources:[...], segments:[...] }`, canonical snapshot/hydration | public, filtered by session visibility |
| `/api/sources` | GET | none | `{ sources:[...] }`, all dashboard-managed live sources | public, filtered by session |
| `/api/sources/active` | GET | none | `{ sources:[...] }`, only `status==="active"` sources | public, filtered by session |
| `/api/segments/recent` | GET | `limit`? default 30 max 200, `camera_id`? | `{ events:[...] }`, hydrated active video analysis events | public; invisible camera returns empty |
| `/api/traces` | GET | `limit`? default 50 max 500, `camera_id`? | `{ traces:[...], count }`, recent pipeline traces | public, filtered by session |
| `/api/traces/stats` | GET | `minutes`? default 60, `camera_id`? | P50/P95 aggregate statistics | public, filtered by session |
| `/api/semantic-context` | GET | `camera_id` required | Current Semantic Context for the source; missing `camera_id` returns 400, invisible source returns 404 | public, filtered by session visibility |
| `/api/analysis/status` | GET | none | `{ active:[...], recent:[...] }`, active and recently completed video analysis | public, filtered by session |
| `/api/videos` | GET | none | `{ videos:[...] }`, uploaded and built-in demo videos | public, uploaded videos filtered by session |

### Video Files And Media Reads

| Endpoint | Method | Parameters | Purpose | Auth |
|---|---|---|---|---|
| `/api/videos/file` | GET/HEAD | `video_id`, for example `upload/foo.mp4` | Browser preview of the selected original file, with Range support | public; `upload/` visibility filtered by session, otherwise 404 |
| `/api/videos/preview` | GET/HEAD | `video_id` | Browser-safe H.264 transcoded preview, generated and cached on demand | public, same visibility rules |
| `/api/videos/thumbnail` | GET/HEAD | `video_id` | Still-image thumbnail for a video, generated and cached on demand | public, same visibility rules |
| `/media/*` | GET | media relative path | Static serving for generated media such as keyframes, GIFs, and crops. Segment responses use URLs like `/media/...`. | public |
| `/api/segment/:segmentId/clip` | GET | Range header | Video clip for one segment | public, filtered by session visibility |
| `/` and other static paths | GET | none | Dashboard SPA static assets from `distDir`; misses fall back to `index.html` | public |

The task-list endpoint `/api/keyframe/:id` does not exist in current implementation. Keyframe images are served through `/media/*`.

### Live Stream Proxy Reads

These endpoints proxy go2rtc through the same origin to avoid browser cross-origin issues. All check source visibility by session and return 404 for invisible sources.

| Endpoint | Method | Parameters | Purpose |
|---|---|---|---|
| `/api/live/stream.mp4` | GET | `src`, camera id | Same-origin proxy for go2rtc fragmented MP4. |
| `/api/live/stream.mjpeg` | GET | `src` | Same-origin proxy for go2rtc MJPEG. |
| `/api/live/status` | GET | `src` | Lightweight stream health check that does not open a frame consumer. |
| `/api/live/frame.jpeg` | GET | `src` | Same-origin proxy for a single frame preview. |

### Source And Analysis Management

The following endpoints are mutations. Multi-user mode requires a session and returns 401 without one; single-user mode remains open. The `source` field on `/api/streams/analyze` and `/api/sources` is an SSRF and arbitrary-file-read boundary. Source security validation runs before `cam add_source`. Trusted single-user local mode stays easy by default; dashboard session requests, `REFLECTWORLD_SOURCE_SECURITY_STRICT=true`, or `REFLECTWORLD_PUBLIC_MODE=true` enable strict mode with scheme allowlist, DNS private/loopback rejection, and local file path rejection by default. See [configuration](./configuration.md) for the full environment variable list.

| Endpoint | Method | Request body | Response | Purpose |
|---|---|---|---|---|
| `/api/analyze` | POST | `video_id`, `fps`? default 1 max 30, `local_file_pacing`? as `fast` or `realtime`, `source_context`? up to 4000 characters | Analysis instance result including `camera_id` | Adds a source for the selected video file and starts watch. |
| `/api/streams/analyze` | POST | `source`?, `name` required, `mode`? as `stream` or `event`, `fps`?, `width`?, `height`?, `duration`?, `defer_watch`?, `source_context`? | Result including `source_id`/`camera_id` | Dashboard wrapper around add_source + watch for live, RTSP, USB, phone, and similar sources. |
| `/api/sources` | POST | `source` URL required, `name`? | Raw cam `add_source` result, `{success,...}` or 400 on failure | Registers a new camera source through the cam tool. |
| `/api/sources/remove` | POST | `name` or `source_id` required, `video_id`? | Removal result | Stops watch, then removes the source instance and source-scoped state. It does not delete uploaded files; uploads are deleted through `/api/videos/delete`. |
| `/api/sources/stop` | POST | `name` or `source_id` required | Stop result | Stops watch while preserving source data/history. |
| `/api/videos/upload` | POST | multipart upload with one video file | Upload result | Uploads a local video, subject to the per-session source limit. |
| `/api/videos/delete` | POST | `video_id` | Delete result | Deletes an uploaded video and its preview cache. |
| `/api/dashboard/clear` | POST | optional body | `{ ok:true }` | Clears uploaded videos and dashboard-visible analysis data. In multi-user mode, non-admin users only clear their own session sources. |
| `/api/config` | GET | none | Current `runtimeConfig` | Reads runtime config. |
| `/api/config` | POST | `{ key, value }`, with key in `VALID_CONFIG_KEYS` and value as string | `{ ok, key, value, previous }`, invalid request returns 400 | Updates one runtime config key for the running Dashboard process. |

### Chat

Chat endpoints call an LLM and are cost-bearing DoS surfaces. In multi-user or public mode, they require a session and apply session/IP rate limiting through `DASHBOARD_CHAT_RATE_LIMIT_PER_MIN`. Trusted single-user local mode has no rate limit by default.

| Endpoint | Method | Request body | Response | Purpose |
|---|---|---|---|---|
| `/api/dashboard/chat` | POST | `prompt` required up to 2000 characters, `camera_id`?, `history`? up to 8 `{role,text}` entries, `stream`? true for SSE | Non-streaming `{ answer, ... }`; streaming `text/event-stream` with `status`, `delta`, `error`, and `done` events | Lightweight Q&A against current dashboard context. |
| `/api/dashboard/live-agent/config` | GET | none | Live-agent browser config, or `enabled:false` when disabled | Experimental realtime dashboard agent configuration for clients that open `/ws/live-agent`. |
| `/v1/chat/completions`, `/api/openai/v1/chat/completions` | POST | OpenAI-style `{ messages, model?, ... }` | OpenAI-compatible completion | OpenAI-compatible wrapper. Public deployments should validate or restrict client-provided `model`. |

### Proxy

Expected auth direction: proxy endpoints must require a dashboard session in multi-user mode. `user_id` should be derived by the server from the session, not accepted from the client. Dangerous methods such as `/reset` and `DELETE` should be denied by default or admin-gated. In current single-user mode, delete forwarding strips `user_id` to avoid hiding default-user memories; multi-user mode preserves `user_id` as the isolation key.

| Endpoint | Method | Target | Purpose | Auth |
|---|---|---|---|---|
| `/api/reflectworld/*` | any | mem service endpoints from the first section, with the `/api/reflectworld` prefix removed | Browser-side memory and ReID reads/writes. The proxy strips `session_id`, strips `user_id` in single-user mode, and rewrites responses through `rewriteReflectWorldProxyResponse`, such as `entity_id` to display `ref`. | session in multi-user |

### Webhook

| Endpoint | Method | Request body | Purpose | Auth |
|---|---|---|---|---|
| `/api/memory-event` | POST | `{ type?, data:{ camera_id?, ... } }`; `type` must be in the `MEMORY_WEBHOOK_EVENT_TYPES` allowlist | The mem service calls this when memory changes; the dashboard converts it into `monitorBus` events for the UI. | loopback-only. Non-loopback requests return 403 through `isLoopbackRequest`. |

### WebSocket

| Endpoint | Protocol | Purpose | Auth |
|---|---|---|---|
| `/ws/dashboard` | WS | Canonical product state stream. On connect, sends a `__connected__` envelope, replays by `cursor`, sends initial source/segment projection, then streams versioned envelopes with `domain`, `id`, `version`, `op`, and `scope`. | Filters visible envelopes by session through `scopeFromRequest`. |
| `/ws/monitor` | WS | Raw realtime monitor event stream for diagnostics and compatibility. Product state should migrate to `/ws/dashboard`. | Filters by session. |
| `/ws/live-agent` | WS | Experimental realtime dashboard agent relay. | Session-gated in multi-user/public mode; disabled unless live-agent config is enabled. |

WS has `maxPayload=64KB`. In multi-user or public mode it validates Origin, allowing the same host by default and extra origins from `DASHBOARD_WS_ALLOWED_ORIGINS`, and limits total connections through `DASHBOARD_MAX_WS_CONNECTIONS` to reduce CSWSH and connection-flood risk.

## Auth Requirements Quick Reference

| Category | Single-user local | Multi-user / public |
|---|---|---|
| Read-only projection: state, sources, traces, videos, semantic-context, live, media | Open | Open, but visibility is filtered by session. |
| Mutations: analyze, sources, config, upload, clear | Open | Session required, otherwise 401. |
| Chat: dashboard chat and OpenAI-compatible wrapper | Open | Session required plus rate limit. |
| Proxy: `/api/reflectworld/*` | Open | Session required; `user_id` derived server-side. |
| Webhook: memory-event | loopback-only | loopback-only |
| Host tools: `/api/tool/:name` | Open | Disabled by default or admin-token gated. |
| Mem service endpoints | loopback, internal calls only | Shared token plus loopback binding. |
