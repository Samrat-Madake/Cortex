# Reference - Complete Configuration Contract

> This is the key-by-key ReflectWorld configuration reference. Each entry lists
> the name, type, default, purpose, and channel.
>
> ReflectWorld supports both standalone `.env` configuration and OpenClaw plugin
> configuration. The channel model is:
>
> - **Channel A, env bridge**: `bridgePluginConfigToEnv` writes fields into
>   `process.env` for spawned Python memory subprocesses or existing env
>   fallback readers.
> - **Channel B, direct pluginConfig**: same-process TypeScript consumers read
>   the `pluginConfig` object directly.
> - **A+B**: both pluginConfig and env fallback are connected.
> - **Service bridge**: service objects such as `ReflectWorldService` or
>   `QdrantService` consume values first, then translate them into child-process
>   environment variables. These fields bypass `bridgePluginConfigToEnv`.
>
> Current contract: the bridge only covers real env or subprocess consumers, code
> defaults match schema defaults, and `working_memory_event_timeout_sec` has a
> canonical default of **30 seconds**.

---

## 1. Perception

Declared in `packages/reflectworld/openclaw.plugin.json` under `perception` and
in `packages/percept/openclaw.plugin.json` for the standalone percept package.
Validation and defaults live in `packages/percept/src/config.ts`.

### Model APIs

| Name | Type | Default | Purpose | Channel |
|---|---|---|---|---|
| `vlm_provider` | `openai` or `gemini` | `openai` | VLM provider | **A+B**, `VLM_PROVIDER` |
| `vlm_model` | string | `gpt-5-mini` | Main multi-frame VLM model | **A+B**, `VLM_MODEL` |
| `vlm_model_lite` | string | `gpt-5-mini` | Smaller single-frame or snapshot model | **A+B**, `VLM_MODEL_LITE` |
| `vlm_api_key` | secretInput | `""` | VLM API key | **A+B**, `VLM_API_KEY` |
| `vlm_base_url` | string | none | OpenAI-compatible base URL | **A+B**, `VLM_BASE_URL` |
| `llm_model` | string | `gpt-5-mini` | Text-only model for compression and narrative summaries | **A+B**, `LLM_MODEL` |

Dashboard chat uses `llm_model` / `LLM_MODEL`. Offline Agent-QA benchmark code
can use `QA_MODEL` to override the QA agent model separately; if unset, it
falls back to `LLM_MODEL` and then the benchmark default. `QA_MODEL` is an
eval/benchmark environment variable, not an OpenClaw plugin field.

Agent-QA also accepts endpoint overrides such as `QA_API_KEY` and
`QA_BASE_URL` in benchmark scripts. See
[`eval/benchmark/README.md`](../../eval/benchmark/README.md) for the benchmark
environment contract.

### VLM Request Reliability

| Name | Type | Default | Purpose | Channel |
|---|---|---|---|---|
| `vlm_request_timeout_ms` | number >= 1000 | `120000` | Timeout per VLM/LLM request | **A+B**, `VLM_REQUEST_TIMEOUT_MS` |
| `vlm_max_retries` | number >= 0 | `2` | Maximum retries after the first attempt | **A+B**, `VLM_MAX_RETRIES` |
| `vlm_retry_base_delay_ms` | number >= 0 | `600` | Retry backoff base delay | **A+B**, `VLM_RETRY_BASE_DELAY_MS` |
| `vlm_retry_max_delay_ms` | number >= 0 | `4000` | Maximum retry backoff delay | **A+B**, `VLM_RETRY_MAX_DELAY_MS` |

Runtime-only fields that exist in zod schema or env but are not exposed in
plugin JSON:

- `vlm_frame_resize_enabled`, default `false`
- `vlm_frame_resize_short_edge`, default `432`
- `vlm_frame_resize_jpeg_quality`, default `75`
- `source_concurrency`, schema default `1`, Dashboard runtime default `2`,
  env `REFLECTWORLD_PERCEPTION_SOURCE_CONCURRENCY`
- `max_queued_per_source`, default `6`, env
  `REFLECTWORLD_PERCEPTION_MAX_QUEUED_PER_SOURCE`
- `live_backlog_skip_after_ms`, default `180000`, env
  `REFLECTWORLD_PERCEPTION_LIVE_BACKLOG_SKIP_AFTER_MS`
- `local_file_pacing`, `realtime` or `fast`, default `fast`, env
  `REFLECTWORLD_LOCAL_FILE_PACING`
- `runtime_mode`, `offline_quality` or `live_latency`, default
  `offline_quality`, env `REFLECTWORLD_PERCEPTION_RUNTIME_MODE`
- `animated_segment_previews`, default `false`
- `body_reid_enabled`, default `false`, env-only
  `REFLECTWORLD_BODY_REID_ENABLED`

These runner fields with env entries are allowlisted in the bridge, but ordinary
OpenClaw configuration does not expose them.

### Prompt Customization

| Name | Type | Default | Purpose | Channel |
|---|---|---|---|---|
| `scene_description` | string | none | Describes the camera scene to the VLM | **A+B**, `SCENE_DESCRIPTION` fallback |
| `focus_targets` | string | none | Additional targets to pay attention to | **B** |
| `security_rules` | string | none | Custom safety criteria | **B** |

### Memory Client and Working Memory

| Name | Type | Default | Purpose | Channel |
|---|---|---|---|---|
| `reflectworld_endpoint` | URL string | `http://localhost:8219` | ReflectWorld memory API base URL | **B**, env fallback `REFLECTWORLD_ENDPOINT` |
| `working_memory_event_timeout_sec` | number >= 1 | `30` | Close an event after this many inactive seconds | **A+B**, `WORKING_MEMORY_EVENT_TIMEOUT_SEC` |
| `working_memory_max_event_segments` | number >= 1 | `18` | Force event rotation after this many segments | **A+B**, `WORKING_MEMORY_MAX_EVENT_SEGMENTS` |

`WorkingMemoryConfig.DEFAULT_CONFIG.event_timeout_sec`, both plugin schemas, and
`PerceptionConfigSchema` are aligned to 30 seconds. `entity_ttl_sec` remains an
internal working-memory parameter and is not exposed in schema.

### Strategy, Models, STT, and Profiling

| Name | Type | Default | Purpose | Channel |
|---|---|---|---|---|
| `stubs_only` | boolean | `true` | Keep local detection/ReID analyzers as stubs when true | **A+B**, `STUBS_ONLY` |
| `required_level` | number 0-2 | `0` | Minimum required perception level; 1+ makes missing local models fatal | **A+B**, `REFLECTWORLD_PERCEPTION_REQUIRED_LEVEL` |
| `models_dir` | string | `~/.reflectworld/models` fallback | ONNX model directory | **A+B**, `REFLECTWORLD_MODELS_DIR` |
| `stt_provider` | `moonshine`, `elevenlabs`, or `""` | `""` | STT provider; empty string explicitly disables STT | **A+B**, `STT_PROVIDER` |
| `stt_model_dir` | string | `""` | Moonshine Tiny model directory | **A+B**, `STT_MODEL_DIR` |
| `stt_num_threads` | number >= 1 | `1` | STT CPU thread count | **A+B**, `STT_NUM_THREADS` |
| `elevenlabs_api_key` | secretInput | `""` | ElevenLabs API key | **A+B**, `ELEVENLABS_API_KEY` |
| `elevenlabs_model_id` | string | `scribe_v1` | ElevenLabs model id | **A+B**, `ELEVENLABS_MODEL_ID` |
| `elevenlabs_language_code` | string | `""` | ElevenLabs language code; empty means auto-detect | **A+B**, `ELEVENLABS_LANGUAGE_CODE` |
| `profiling_enabled` | boolean | `true` | Enable profiling traces | **B** |

---

## 2. Memory

Declared in `packages/reflectworld/openclaw.plugin.json` under `memory`. This
block mixes two categories:

1. TypeScript memory-client local options, parsed by
   `packages/mem/src/config.ts`.
2. Python memory subprocess model and storage credentials, bridged through env
   and read by `services/mem/src/config.py`.

### TypeScript Memory Client Options

| Name | Type | Default | Purpose | Channel |
|---|---|---|---|---|
| `baseUrl` | URL string | `http://localhost:8219` | Memory service base URL | **B** |
| `timeoutMs` | number > 0 | `60000` | Memory-client HTTP timeout | **B** |
| `defaultCameraId` | string | none | Default `camera_id` for tool requests | **B** |
| `defaultUserId` | string | none | Default `user_id` for tool requests | **B** |
| `defaultSearchMemoryType` | `episodic`, `semantic`, `procedural`, or `all` | `all` | Default search memory type | **B** |
| `defaultSearchLimit` | number > 0 | `20` | Default search result limit | **B** |
| `user_id` | string | none | Alias for `defaultUserId` in all-in-one mode | **B** |

### Python Subprocess: Embedder and Text LLM

| Name | Type | Default | Purpose | Channel |
|---|---|---|---|---|
| `embedder_provider` | `openai` | Python default `openai` | Embedder provider | **A**, `EMBEDDER_PROVIDER` |
| `embedder_model` | string | `text-embedding-3-small` | Embedder model | **A**, `EMBEDDER_MODEL` |
| `embedder_api_key` | secretInput | falls back to `VLM_API_KEY` | Embedder API key | **A**, `EMBEDDER_API_KEY` |
| `embedder_base_url` | string | falls back to `VLM_BASE_URL` | OpenAI-compatible embedder base URL | **A**, `EMBEDDER_BASE_URL` |
| `embedding_dims` | number | `1536` | Embedding vector dimensions | **A**, `EMBEDDING_DIMS` |
| `llm_provider` | string | falls back to `VLM_PROVIDER` | Python memory text LLM provider | **A**, `LLM_PROVIDER` |
| `llm_api_key` | secretInput | falls back to `VLM_API_KEY` | Python memory LLM key | **A**, `LLM_API_KEY` |
| `llm_base_url` | string | falls back to `VLM_BASE_URL` | Python memory LLM base URL | **A**, `LLM_BASE_URL` |

Python defaults in `config.py` also include `llm_model=gpt-5-mini`,
`llm_temperature=0.1`, and `llm_max_tokens=2048`. Temperature and max tokens are
env-only through `LLM_TEMPERATURE` and `LLM_MAX_TOKENS`.

Gemini does not provide an OpenAI-compatible embeddings endpoint, so the
configure CLI requires an independent embedder when Gemini is selected.

### Python Subprocess: Service and Storage

| Name | Type | Default | Purpose | Channel |
|---|---|---|---|---|
| `collection_name` | string | Python default `visionmem_me_production` | Qdrant collection prefix. This is a historical stable storage namespace, not product branding. | **Service bridge**: TS service consumes it and injects `COLLECTION_PREFIX` |
| `port` | number | `8219` | Python memory service port | **Service bridge** |
| `qdrant_port` | number | `6333` | Qdrant HTTP port | **Service bridge**; Python reads `QDRANT_PORT` |
| `qdrant_grpc_port` | number | follows `QdrantService` | Qdrant gRPC port | **Service bridge** |
| `source_dir` | string | none | Python memory service source directory | **B / service bridge** |
| `storage_path` | string | `<homeDir>/memory-state`; bare Python default `~/.reflectworld/memory-state` | Local Python memory state, mainly history/counter SQLite | **Service bridge**, injected as `STORAGE_PATH` |

Public configuration should use only ReflectWorld directory names and
`REFLECTWORLD_*` variables.

---

## 3. Cam

Declared in `packages/cam/openclaw.plugin.json`, with the full zod schema in
`packages/cam/src/config.ts`. Cam is TypeScript-only in-process orchestration, so
these are Channel B values.

| Name | Type | Default | Purpose |
|---|---|---|---|
| `sources_dir` | string | `<stateDir>/sources` | Persisted source config |
| `recordings_dir` | string | `<stateDir>/recordings` | Recorded segment directory |
| `go2rtc_bin` | string | `<home>/bin/go2rtc` | go2rtc binary path |
| `go2rtc_api_port` | number | `1984` | go2rtc HTTP API port |
| `go2rtc_rtsp_port` | number | `8554` | go2rtc RTSP port |
| `go2rtc_webrtc_port` | number | `8555` | go2rtc WebRTC port |
| `go2rtc_listen_addr` | string | `127.0.0.1` | go2rtc listen address |
| `go2rtc_reuse_external` | boolean | `true` | Reuse an already-running go2rtc |
| `ffmpeg_bin` | string | `<home>/bin/ffmpeg` | ffmpeg binary path |
| `ffprobe_bin` | string | `<home>/bin/ffprobe` | ffprobe binary path used for local-file stream metadata |
| `default_segment_sec` | number >= 5 | `30` | Default recording segment length |
| `recording_quota_mb` | number >= 0 | `2048` | Per-camera recording quota; 0 disables FIFO quota |
| `default_extraction_fps` | number 0.1-30 | `1` | Default frame extraction fps |
| `default_extraction_width` | number >= 160 | `1280` | Default extraction width |
| `default_extraction_height` | number >= 120 | `720` | Default extraction height |
| `motion_threshold` | number 0-1 | `0.02` | Motion detection threshold |
| `motion_pixel_threshold` | number 0-1 | `0.1` | Motion pixel ratio threshold |
| `default_snapshot_quality` | number 1-100 | `85` | Snapshot JPEG quality |
| `reflectworld_endpoint` | string | `http://localhost:8219` | Downstream ReflectWorld API |
| `auto_analyze` | boolean | `true` | Send segments to perception automatically |
| `restore_watches` | boolean | `true` | Restore persisted watch sessions on startup |
| `silero_vad_model` | string | `<home>/models/silero_vad.onnx` | Silero VAD model path |
| `vad_enabled` | boolean | `true` | Enable VAD |
| `vad_threshold` | number 0-1 | `0.5` | VAD speech threshold |
| `vad_min_silence_duration` | number >= 0 | `0.05` | Minimum silence duration |
| `vad_min_speech_duration` | number >= 0 | `0.25` | Minimum speech duration |
| `vad_window_size` | number | `512` | VAD window size |
| `vad_buffer_size_sec` | number >= 1 | `120` | VAD buffer duration |
| `segment_window_size` | number >= 1 | `10` | Pipeline segmentation window |
| `extraction_full_rate` | boolean | `false` | Emit all frames from FrameExtractor and let Perception downsample |

### Local Retention Policy

The orchestrator runs retention for long-running local stability. It does not
delete semantic or ReID vector memories, and it does not automatically delete
uploaded original videos. Uploaded file deletion uses the Dashboard video delete
API.

| Name | Type | Default | Purpose |
|---|---|---|---|
| `REFLECTWORLD_MEDIA_RETENTION_DAYS` / `retention.media_days` | number >= 0 | `30` | Generated media retention for `media_files`, recordings, previews, segment clip cache, and debug archives. `0` disables. |
| `REFLECTWORLD_TEXT_RETENTION_DAYS` / `retention.text_days` | number >= 0 | `90` | Local text/diagnostic retention for `pipeline_log`, `notification_log`, `pipeline_errors`, `traces`, `llm_calls`, and `memory_write_failures`. `0` disables. |
| `REFLECTWORLD_RETENTION_INTERVAL_HOURS` / `retention.interval_hours` | number > 0 | `24` | Retention interval; startup also schedules one async run. |

### Source Security Validation

`add_source` remains easy to use in local single-user mode. It switches to
strict validation when called from a Dashboard session or when strict/public env
flags are enabled.

| Name | Type | Default | Purpose |
|---|---|---|---|
| `REFLECTWORLD_SOURCE_SECURITY_STRICT` | bool flag | `false` | Force strict validation for all `add_source` requests |
| `REFLECTWORLD_PUBLIC_MODE` | bool flag | `false` | Public/shared deployment switch; also enables strict source validation |
| `REFLECTWORLD_ALLOW_INSECURE_HTTP_SOURCE` | bool flag | `false` | Allow `http://` in strict mode |
| `REFLECTWORLD_ALLOW_PRIVATE_SOURCE` | bool flag | `false` | Allow private, loopback, link-local, and reserved targets in strict mode |
| `REFLECTWORLD_ALLOW_LOCAL_SOURCE` | bool flag | `false` | Allow local files and local capture devices in strict mode |

Strict mode allows `phone`, `webcam`, `https`, `rtsp`, and `rtsps`. It rejects
local files, `file://`, unapproved `http://`, and DNS/IP targets resolving to
loopback, private, link-local, reserved, or multicast ranges. Uploaded video
analysis uses an internal `_allowLocalFileSource` marker and does not require
users to enable `REFLECTWORLD_ALLOW_LOCAL_SOURCE`.

If public mode is combined with private or local source escape hatches,
all-in-one startup prints a warning but does not block the request. Use that
combination only in trusted LAN or local deployments.

---

## 4. Dashboard

Dashboard has no independent plugin JSON schema. The orchestrator constructs
`DashboardServerOptions`, and most values are read from env by the TypeScript
backend.

| Name | Type | Default | Purpose |
|---|---|---|---|
| `config.dashboard.port` / `config.monitor.port` | number | `3210` in standalone CLI | Dashboard HTTP/WS port; fallback also checks `DASHBOARD_PORT` and `MONITOR_PORT` |
| `DASHBOARD_MULTI_USER` | bool flag | `false` | Multi-user ACL switch |
| `DASHBOARD_MAX_ACTIVE_SESSIONS` | number | `5` | Maximum active sessions |
| `DASHBOARD_MAX_SOURCES_PER_SESSION` | number | `2` | Maximum sources per session |
| `DASHBOARD_SESSION_TTL_MIN` | number | `15` | Stale-session TTL in minutes |
| `DASHBOARD_SESSION_STOP_GRACE_MIN` | number | `5` | Stop grace period in minutes |
| `DASHBOARD_SESSION_HARD_CLEANUP_MIN` | number | `60` | Hard cleanup period in minutes |
| `DASHBOARD_ADMIN_TOKEN` | string | none | Admin token for all-data access |
| `DASHBOARD_WS_ALLOWED_ORIGINS` | comma list | none | Extra allowed WebSocket Origins in strict mode |
| `DASHBOARD_MAX_WS_CONNECTIONS` | number | `100` | Total WebSocket connection limit; 0 disables |
| `DASHBOARD_CHAT_RATE_LIMIT_PER_MIN` | number | `20` | Chat rate limit per session/IP in strict mode; 0 disables |
| `DASHBOARD_MAX_FFMPEG_JOBS` | number | `4` | Concurrent Dashboard on-demand ffmpeg jobs for previews/clips |
| `DASHBOARD_MAX_FFMPEG_QUEUE` | number | `32` | Waiting queue length for on-demand ffmpeg jobs |
| `DASHBOARD_LIVE_AGENT_ENABLED` | bool flag | `false` | Enable the experimental realtime dashboard voice/live agent |
| `DASHBOARD_LIVE_AGENT_PROVIDER` | `google` or `gemini` | `google` | Live-agent provider; both values use the Google realtime API path |
| `DASHBOARD_LIVE_AGENT_API_KEY` | string | falls back to `GEMINI_API_KEY` or `GOOGLE_API_KEY` | API key for the live agent |
| `DASHBOARD_LIVE_AGENT_MODEL` | string | `gemini-3.1-flash-live-preview` | Live-agent model |
| `DASHBOARD_LIVE_AGENT_HOTKEY` | string | `F8` | Browser hotkey hint returned to the UI |
| `DASHBOARD_LIVE_AGENT_VOICE` | string | `Vega` | Voice name sent to the provider |
| `DASHBOARD_LIVE_AGENT_LANGUAGE` | string | `zh` | Live-agent language hint |
| `DASHBOARD_LIVE_AGENT_DEBUG` | bool flag | `false` | Print live-agent debug events to stderr |
| `REFLECTWORLD_TOOL_API_RESTRICTED` | bool flag | `false` | Force CLI `/api/tools` and `/api/tool/:name` to require admin token |
| `REFLECTWORLD_TOOL_API_TOKEN` | string | falls back to `DASHBOARD_ADMIN_TOKEN` | CLI tool API token |
| `REFLECTWORLD_TOOL_API_MAX_BODY_BYTES` | number | `1048576` | CLI tool API POST body limit |
| `GO2RTC_API_PORT` | number | `1984` | go2rtc API port proxied by Dashboard |
| `public_videos_dir` / `fixture_videos_dir` | string | `""` | Fixed public demo video directory |

`REFLECTWORLD_PUBLIC_MODE=true` is the general public deployment switch. It
enables strict source validation, Dashboard session gates, WebSocket origin and
connection limits, chat rate limiting, and CLI tool API admin-token gates.

---

## 5. Qdrant

Qdrant has no independent declared schema block. Ports can be configured under
`memory.*` or `qdrant.*` for compatibility. The TypeScript `QdrantService`
manages lifecycle, and Python memory connects through env.

| Name | Type | Default | Purpose | Channel |
|---|---|---|---|---|
| `qdrant.port` / `memory.qdrant_port` | number | `6333` | Qdrant HTTP port | **Service bridge**, Python reads `QDRANT_PORT` |
| `qdrant.grpc_port` / `memory.qdrant_grpc_port` | number | follows `QdrantService` | Qdrant gRPC port | **Service bridge** |
| `QDRANT_HOST` | string | `localhost` | Qdrant host for Python | **A / service bridge** |

---

## 6. Configuration Sources

This page summarizes the supported contract but does not maintain a manual field
count. The executable sources of truth are the package plugin schemas, zod
schemas, service bridge, Dashboard config schema, and environment resolvers
linked below.

---

## 7. Related Files

| File | Purpose |
|---|---|
| `packages/reflectworld/src/config-env-bridge.ts` | Only env bridge: maps, secret fields, `bridgePluginConfigToEnv` |
| `packages/reflectworld/openclaw.plugin.json` | All-in-one config schema |
| `packages/percept/openclaw.plugin.json` | Percept package config schema |
| `packages/cam/openclaw.plugin.json` | Cam package config schema |
| `packages/mem/openclaw.plugin.json` | Memory client package config schema |
| `packages/percept/src/config.ts` | `PerceptionConfigSchema` and `resolvePerceptionConfig` |
| `packages/mem/src/config.ts` | `MemoryConfigSchema` and `parseMemoryConfig` |
| `packages/cam/src/config.ts` | `CamConfigSchema` and `resolveCamConfig` |
| `services/mem/src/config.py` | Python memory service config entry point |
| `packages/reflectworld/index.ts` | Bridge call, fallback resolution, Dashboard options |
| `packages/reflectworld/src/services/reflectworld-service.ts` | Python spawn env and service bridge |
