# @cortex/dashboard

> React real-time dashboard for Cortex sources, perception, memory, and chat.

## Overview

The Dashboard is a single-page web application for operating Cortex locally.
It connects to the Host server through HTTP APIs and WebSocket streams, renders
source state, live previews, segments, entities, semantic memory, rules, and chat,
and supports multiple camera or uploaded-video sources.

## Installation

```bash
cd packages/dashboard
npm install
```

## Development

```bash
npm run dev      # Vite dev server with HMR
npm run build    # Production build → dist/
npm run preview  # Preview production build
```

The built `dist/` directory is served by `@cortex/host` and by the
all-in-one `@cortex/cortex` CLI.

## Dashboard Components

| Area | Description |
|---|---|
| Sources | Add streams or uploaded videos, inspect live previews, and switch active sources. |
| Segments | Follow analyzed moments, segment thumbnails, target rows, and details. |
| Entities | Inspect detected entities, aliases, sightings, and per-entity context. |
| Memory | Browse semantic memory and related context from the memory service. |
| Rules | Manage procedural rules exposed by the host runtime. |
| Chat | Ask questions against the current dashboard context. |

## Event Types

The dashboard consumes the shared `MonitorEventType` contract from
`@cortex/shared`. Canonical UI state is delivered through
`dashboard:source_state` and `dashboard:segment_state`; raw
cam/perception/memory/system events remain available for diagnostics and
compatibility.

`memory:memory_updated` is reserved for future semantic-memory edits. Search results are API
responses, so there is no `memory:search_performed` realtime event.

The public HTTP and WebSocket surfaces are summarized in the
[HTTP API reference](../../docs/reference/http-api.md).

## Tech Stack

- React 19 + TypeScript
- Motion for UI animation
- Three.js for richer visual surfaces where needed
- Vite 6 for local development and production builds
- HTTP + WebSocket for runtime state

## See Also

- [Architecture overview](../../docs/architecture/overview.md)
- [HTTP API Reference](../../docs/reference/http-api.md)
- [Host Server](../../packages/host)
