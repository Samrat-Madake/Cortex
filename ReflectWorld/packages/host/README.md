# @reflectworld/host

> Standalone HTTP server exposing ReflectWorld tools and real-time Monitor WebSocket.

## Overview

The Host package runs ReflectWorld as a standalone HTTP server without requiring the full OpenClaw gateway. It loads the all-in-one `@reflectworld/reflectworld` plugin via `MiniHost` (a minimal OpenClaw plugin host), auto-starts all infrastructure services, and exposes a REST API for tool invocation plus a WebSocket endpoint for the Monitor dashboard.

## Installation

```bash
npm install @reflectworld/host
```

## Quick Start

There are two supported Dashboard modes. They are intentionally different:

| Mode | Command | Purpose | Default ports | Runtime isolation |
|------|---------|---------|---------------|-------------------|
| Demo Dashboard | `npm run dashboard:demo` | Product/demo surface for uploads, streams, shared company trials | Dashboard `3213`, host `3214` | Isolated state, Memory, Qdrant collection, go2rtc ports |
| Main Dashboard | `npm run dashboard:main` | Monitor the normal ReflectWorld pipeline and its real runtime state | Dashboard `3211`, host `3210` | Uses the main `~/.reflectworld` runtime |

Use the demo mode when opening ReflectWorld to users or teammates for an isolated Dashboard experience. Use the main mode when you want the Dashboard to observe the real pipeline started from the normal host.

```bash
# Set credentials
export VLM_API_KEY=your_key_here

# Isolated demo Dashboard. Does not share Memory/Qdrant/go2rtc state with the main runtime.
npm run dashboard:demo

# Main runtime Dashboard. Uses ~/.reflectworld and monitors the normal pipeline.
npm run dashboard:main

# Or with custom config
PORT=8080 REFLECTWORLD_STATE_DIR=~/.reflectworld npx tsx packages/host/src/server.ts
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check (returns tool count) |
| `GET` | `/api/tools` | List all registered tools |
| `POST` | `/api/tool/:name` | Call a tool with JSON body as params |
| `POST` | `/api/monitor/inject` | Inject events into EventBus (testing) |
| `GET` | `/ws/monitor` | WebSocket for real-time Monitor events |
| `GET` | `/*` | Monitor UI static files (SPA fallback) |

## Key Exports

| Export | Description |
|--------|-------------|
| `MiniHost` | Minimal OpenClaw plugin host (loadPlugin, startServices, callTool) |
| `attachMonitorWs` | Attach WebSocket server to existing http.Server |
| `serveStatic` | Static file server with SPA fallback |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3210` | HTTP server port |
| `REFLECTWORLD_STATE_DIR` | `~/.reflectworld` | State directory for SQLite, media, binaries |
| `VLM_API_KEY` | — | API key for the configured VLM provider |
| `GO2RTC_API_PORT` | `1984` | go2rtc API port |

## Demo Dashboard Environment

`npm run dashboard:demo` uses isolated defaults:

| Variable | Default | Description |
|----------|---------|-------------|
| `REFLECTWORLD_DEMO_HOME_DIR` | `~/.reflectworld` | Shared demo assets root for binaries/models |
| `REFLECTWORLD_DEMO_STATE_DIR` | `~/.reflectworld-demo` | Isolated demo state root |
| `REFLECTWORLD_DEMO_NAME` | `dashboard-demo` | Demo collection prefix |
| `REFLECTWORLD_DEMO_DASHBOARD_PORT` | `3213` | Dashboard UI port |
| `REFLECTWORLD_DEMO_HOST_PORT` | `3214` | Tool/API host port |
| `REFLECTWORLD_DEMO_MEM_PORT` | `48219` | Isolated Memory service port |
| `REFLECTWORLD_DEMO_QDRANT_PORT` | `46333` | Isolated Qdrant HTTP port |
| `REFLECTWORLD_DEMO_GO2RTC_API_PORT` | `21984` | Isolated go2rtc API port |
| `REFLECTWORLD_DEMO_GO2RTC_RTSP_PORT` | `28554` | Isolated go2rtc RTSP port |
| `REFLECTWORLD_DASHBOARD_PUBLIC_VIDEOS_DIR` | unset | Optional read-only shared demo videos shown to every Dashboard session as fixture videos. |
| `REFLECTWORLD_DASHBOARD_LEGACY_UPLOADS_DIRS` | unset | Optional comma-separated migration-only upload directories to expose as uploaded videos. |

Shared demo videos should use `REFLECTWORLD_DASHBOARD_PUBLIC_VIDEOS_DIR`, not the upload directory. Uploaded videos remain session-scoped when multi-user mode is enabled; public videos are intentionally visible to all sessions and are read-only.

Perception runtime controls are shared with the main server:

| Variable | Default | Description |
|----------|---------|-------------|
| `REFLECTWORLD_PERCEPTION_SOURCE_CONCURRENCY` | `2` | Max sources executing perception concurrently. |
| `REFLECTWORLD_PERCEPTION_MAX_QUEUED_PER_SOURCE` | `6` | Max queued live segments before rejection/degraded signaling. |
| `REFLECTWORLD_PERCEPTION_LIVE_BACKLOG_SKIP_AFTER_MS` | `180000` | Skip stale queued live perception segments after this much unprocessed media time; source recording remains on disk. |
| `REFLECTWORLD_LOCAL_FILE_PACING` | `fast` | Local-file upload pacing; set `realtime` when intentionally simulating live playback. |

## See Also

- [Dashboard Frontend](../../packages/dashboard)
- [ReflectWorld Plugin](../../packages/reflectworld)
