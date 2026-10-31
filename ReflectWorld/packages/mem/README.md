# @reflectworld/mem

> TypeScript HTTP client for the ReflectWorld Python memory service.

## Overview

This package provides `ReflectWorldClient`, a typed HTTP client wrapping the ReflectWorld FastAPI service. It supports episodic/semantic/procedural memory CRUD, semantic search, media expiration, and ReID (face + body) vector operations against Qdrant collections.

## Installation

```bash
npm install @reflectworld/mem
```

## Quick Start

```typescript
import { ReflectWorldClient } from "@reflectworld/mem";

const client = new ReflectWorldClient({ baseUrl: "http://localhost:8219" });

// Store a memory
await client.add({
  video_data: { summary: "Person arrived at front door with a package" },
  camera_id: "front_door",
  mode: "event",
  infer: true,
});

// Semantic search
const results = await client.search({
  query: "when did someone deliver a package?",
  camera_id: "front_door",
  memory_type: "episodic",
});

// ReID search
const matches = await client.reidSearch({
  vector: faceEmbedding,
  collection: "reid_face",
  limit: 5,
  threshold: 0.68,
});
```

## API

### ReflectWorldClient Methods

| Method | Description |
|--------|-------------|
| `add(request)` | Store a new memory (episodic, semantic, or procedural) |
| `search(request)` | Semantic search across memory collections |
| `getMemories(request)` | List memories by filter (camera, entity, type) |
| `deleteMemories(request)` | Batch delete by filter criteria |
| `deleteMemoryById(request)` | Delete a single memory by ID |
| `expireMedia(request)` | Mark media URLs as expired for a segment |
| `reidSearch(request)` | Search ReID collection by feature vector similarity |
| `reidUpsert(request)` | Insert or update entity feature vector |
| `health()` | Service health check |

### OpenClaw Plugin

The default export registers as an OpenClaw plugin with the `reflectworld_memory` tool, supporting actions: `search`, `get`, `delete`, `add_note`, `get_history`.

## See Also

- [Architecture overview](../../docs/architecture/overview.md)
- [Configuration reference](../../docs/reference/configuration.md)
- [ReflectWorld Python service](../../services/mem/)
