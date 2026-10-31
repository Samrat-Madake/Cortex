# @reflectworld/shared

> Core types, constants, and utilities shared across all ReflectWorld packages.

## Overview

This package defines the shared data contracts that flow through the ReflectWorld pipeline — from video capture through perception to memory storage. It also provides the `monitorBus` event bus for real-time dashboard communication.

## Installation

```bash
npm install @reflectworld/shared
```

## API

### Types

| Type | Description |
|------|-------------|
| `Segment` | Video segment produced by Eye (frames, camera_id, mode) |
| `Frame` | Single JPEG frame with timestamp and index |
| `PerceptionResult` | Full analysis output from the perception pipeline |
| `PerceptionMemory` | Structured VLM output (summary, entities, security_risk) |
| `EntityRecord` | Detected entity with bbox, appearance, ReID identity |
| `MediaUrls` | File paths for raw video, keyframes, GIFs, crops |
| `PipelineTrace` | End-to-end profiling timestamps and latencies |
| `SpeechSegment` | VAD-detected speech audio segment |

### OpenClaw SDK Types

| Type | Description |
|------|-------------|
| `OpenClawPluginApi` | Plugin registration interface |
| `AnyAgentTool` | Tool definition with execute function |
| `PluginService` | Managed service (start/stop lifecycle) |
| `PluginRuntime` | Runtime context (state dir, config, channels) |

### Event Bus

```typescript
import { monitorBus } from "@reflectworld/shared";
import type { MonitorEvent, MonitorEventType } from "@reflectworld/shared";

// Publish events (22 event types across cam/perception/memory/system)
monitorBus.publish("cam:segment_built", { frames: 5 }, "camera_1");

// Subscribe
monitorBus.on("monitor", (event: MonitorEvent) => { /* ... */ });
```

## See Also

- [Architecture Overview](../../docs/architecture/overview.md)
- [HTTP API Reference](../../docs/reference/http-api.md)
