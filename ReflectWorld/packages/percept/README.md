# @reflectworld/percept

> Perception pipeline: local model inference + VLM analysis with explicit L0/L1 capability tiers.

## Overview

The Perception package analyzes video segments through a two-tier pipeline. Level 0 uses VLM only. Level 1 consumes upstream frame detections, adds face detection (RetinaFace), and queries ReID evidence (ArcFace face ReID, with optional body ReID) before VLM analysis. Local model evidence is injected through subject-proposal context rather than tracker state.

## Installation

```bash
npm install @reflectworld/percept

# Level 0 (VLM only) — no extra dependencies needed

# Level 1 (local models) — install inference engine + download models
npm install onnxruntime-node
npx -p @reflectworld/percept install-models
```

On Linux GPU hosts, `onnxruntime-node` is still the package to install. CUDA is selected automatically when the NVIDIA driver, CUDA 12 runtime, and cuDNN 9 libraries are visible to Node.

## Quick Start

```typescript
import { analyze, createPipelineDeps, resolvePerceptionConfig } from "@reflectworld/percept";

const config = resolvePerceptionConfig({ vlm_provider: "openai", vlm_api_key: "...", vlm_base_url: "..." });
const deps = await createPipelineDeps(config, mediaSaver);
const result = await analyze(segment, deps);
// result.perception_memory.summary → "A person approached the front door..."
```

## Architecture

```
Segment
  ↓
WorkingMemoryManager → event lifecycle (open/close/timeout per camera)
  ↓
StrategyManager → picks Level 0/1 by mode + capabilities
  ↓
Pipeline (serial execution):
  Stage 1: External frame detections + RetinaFace face association
  Stage 2: ReID evidence query (ArcFace face ReID → ReflectWorld)
  Stage 3: Subject proposal + VLM analysis
  ↓
MediaUploader → keyframes to filesystem
NotificationResolver → VLM-driven smart gating
  ↓
PerceptionResult
```

## API

### Pipeline

| Export | Description |
|--------|-------------|
| `analyze` | Run the full perception pipeline on a Segment |
| `createPipelineDeps` | Initialize pipeline dependencies (router, VLM, strategy) |
| `resolvePerceptionConfig` | Resolve config from env vars + overrides |

### Analyzers

| Export | Description |
|--------|-------------|
| `VlmAnalyzer` | OpenAI-compatible or Gemini API-key VLM analysis |
| `SttAnalyzer` | Speech-to-text via Moonshine Tiny (sherpa-onnx-node) |
| `WorkingMemoryManager` | Event lifecycle management per camera |
| `StrategyManager` | Capability-based level selection |

### Supporting

| Export | Description |
|--------|-------------|
| `MediaUploader` | Save keyframes and GIFs to local filesystem |
| `resolveNotifications` | VLM-driven notification gating |

### Performance

Level 0 latency is dominated by the configured remote VLM. Level 1 adds local
detection/ReID work before the VLM call; exact latency depends on model files,
hardware, frame count, image size, and provider response time.

## See Also

- [Architecture overview](../../docs/architecture/overview.md)
- [Configuration guide](../../docs/user-guide/configuration.md)
