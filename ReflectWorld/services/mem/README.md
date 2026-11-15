# @cortex mem service

The mem service is Cortex's multimodal memory service. It is a Python / FastAPI service backed by Qdrant for visual memory storage, semantic search, and ReID vector galleries.

The orchestrator package, `@cortex/cortex`, normally starts this
service as a child process. TypeScript callers use the `@cortex/mem` HTTP
client. See the [architecture overview](https://github.com/addxai/Cortex/blob/main/docs/architecture/overview.md)
for the high-level runtime shape.

## Responsibilities

- **Memory storage:** writes perception results, summaries, entities, and dialogue into Qdrant collections organized by time scale and abstraction level.
- **Semantic search:** searches episodic, semantic, and procedural memories with 1536-dimensional text embeddings.
- **ReID vector gallery:** stores face vectors, 512-dimensional ArcFace, and body vectors, 768-dimensional, for cross-segment re-identification.
- **Semantic merge:** every N observations, runs an LLM entity-memory merge with ADD/UPDATE/DELETE decisions and identity-memory protection.

## Start

Production starts the service through the orchestrator. For manual development:

```bash
cd services/mem
uv run uvicorn src.main:app --host 127.0.0.1 --port 8219
```

Key environment variables. In production, the orchestrator injects these through `config-env-bridge`; manual runs must export them directly.

| Variable | Description |
|---|---|
| `QDRANT_HOST` | Qdrant HTTP host. Default: `localhost`. |
| `QDRANT_PORT` | Qdrant HTTP port. Default: `6333`. |
| `COLLECTION_PREFIX` | Collection prefix for isolation. |
| `EMBEDDER_PROVIDER` / `EMBEDDER_*` | Text embedding provider settings. |
| `LLM_PROVIDER` / `LLM_*` | LLM settings for semantic merge. |

## Memory Types And Collections

| Collection | Dimension | Purpose |
|---|---:|---|
| `episodic_trace` | 1536d | Segment-level event summary. |
| `episodic_entity` | 1536d | Entity observation inside one segment. |
| `episodic_schema` | 1536d | Cross-segment event aggregation / chapter memory. |
| `episodic_visual` | 1024d | Reserved visual embedding collection. |
| `semantic_entity` | 1536d | Long-term entity semantic profile. |
| `semantic_context` | 1536d | Camera scene context. |
| `procedural` | 1536d | Procedural/user-rule memory. |
| `reid_face` | 512d | Face ReID gallery. |
| `reid_entity` | 768d | Body ReID gallery. |

## Main HTTP API

| Endpoint | Purpose |
|---|---|
| `POST /memories` | Write memory. |
| `POST /search` | Semantic search. |
| `GET /memories` | List memories by filters. |
| `POST /reid/search`, `/reid/upsert`, `/reid/batch-init`, `/reid/gallery-update` | ReID vector operations. |
| `POST /identity/set` | Set entity identity. |
| `GET /health`, `/status` | Health checks. |

The full HTTP contract is documented in the
[HTTP API reference](https://github.com/addxai/Cortex/blob/main/docs/reference/http-api.md).
