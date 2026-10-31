# @reflectworld/reflectworld

> All-in-one OpenClaw plugin — video capture, perception, memory, and notifications.

## Overview

The orchestrator plugin wires together all ReflectWorld sub-packages into a single install. It auto-starts prepared infrastructure (Qdrant, ReflectWorld Python service, go2rtc), manages a local SQLite pipeline store, provides dual-path notifications (direct alerts + subagent summaries), and exposes the Dashboard web UI. One plugin gives AI agents full visual perception and persistent memory.

Works in two forms: as an **OpenClaw plugin** (configured via `npx @reflectworld/reflectworld configure`) or as a **standalone service** (configured via `.env`).

## Install & Configure

### As an OpenClaw plugin (recommended)

```bash
# 1. Install the plugin (the command self-exits; takes ~15s)
openclaw plugins install @reflectworld/reflectworld
#    Not published to npm yet? Install the packed tarball instead:
#    openclaw plugins install ./reflectworld-reflectworld-0.1.0.tgz

# 2. Configure providers — interactive wizard (also accepts piped/non-interactive stdin)
npx @reflectworld/reflectworld configure
#    Prompts for: VLM provider/model/key, optional independent embedder, STT mode.
#    Writes pluginConfig into openclaw.json, validates, and restarts the gateway.
#    Before this package is published to npm, run the CLI from the installed extension:
#      node ~/.openclaw/extensions/reflectworld/bundle/src/cli/index.js configure

# 3. (optional) Enable Level 1 in the installed plugin
node ~/.openclaw/extensions/reflectworld/bundle/src/cli/index.js enable-level1 \
  --package-dir ~/.openclaw/extensions/reflectworld
# Add --with-stt for the local VAD/STT runtime.

# 4. Restart the gateway to apply
openclaw gateway restart           # managed service; otherwise restart your gateway process
```

**Out of the box you get Level 0** (VLM-only) — it needs nothing but a VLM provider and starts cleanly. If Level 1 model files are present but the native runtime isn't installed, the self-check warns (with the `enable-level1` hint) instead of failing.

### As a standalone service

```bash
npm install @reflectworld/reflectworld

npx @reflectworld/reflectworld setup --level 0   # download go2rtc/ffmpeg/qdrant binaries + Level 0 assets
                                           # use --level 1 to also fetch local perception models

# Create a .env (a sample .env.example ships in the package) — minimal Level 0:
cat > .env <<'EOF'
VLM_PROVIDER=openai
VLM_MODEL=gpt-5-mini
VLM_API_KEY=your-vlm-api-key
VLM_BASE_URL=https://api.openai.com/v1
# Optional independent OpenAI-compatible embedder:
# EMBEDDER_PROVIDER=openai
# EMBEDDER_MODEL=text-embedding-3-small
# EMBEDDER_API_KEY=your-embedder-api-key
# EMBEDDER_BASE_URL=https://api.openai.com/v1
EOF

npx @reflectworld/reflectworld start             # starts Qdrant + ReflectWorld + go2rtc + dashboard
                                           # options: --port N, --dev, --home-dir DIR
```

## Configuration

The two forms read configuration from different sources — they don't mix:

| Form | Config source |
|------|---------------|
| OpenClaw plugin | `npx @reflectworld/reflectworld configure` → `pluginConfig` in `openclaw.json` |
| Standalone | `.env` (loaded by `npx @reflectworld/reflectworld start`) |

`npx @reflectworld/reflectworld configure` collects:

- **VLM** — provider (`openai`/`gemini`), vision model, lite model, API key, base URL (OpenAI-compatible endpoints like a LiteLLM gateway are supported)
- **Embedder** — same gateway + `text-embedding-3-small` by default, or an independent OpenAI-compatible embedder
- **STT** — `off` (default), `elevenlabs`, or `moonshine`

### Perception levels

| Level | Needs | Adds |
|-------|-------|------|
| **0** (default) | a VLM provider only | scene description + safety via the VLM |
| **1** | `enable-level1` (persistently installs `onnxruntime-node` + `sharp` in the target project) | local detection, identity continuity, face ReID (ONNX, CoreML on Apple Silicon) |

Level 1 model files come from `npx @reflectworld/reflectworld setup --level 1 --yes --accept-model-licenses` (standalone) or `~/.reflectworld/models`. Set `perception.required_level = 1` (or `REFLECTWORLD_PERCEPTION_REQUIRED_LEVEL=1`) to make a missing Level 1 capability a **fatal** startup check instead of a warning.

Runtime directories use the ReflectWorld names directly: `REFLECTWORLD_HOME` (default `~/.reflectworld`) and `REFLECTWORLD_STATE_DIR` (default `./.reflectworld-state`). Public configuration should use only `REFLECTWORLD_*` variables and ReflectWorld directory names.

Linux GPU hosts use the CUDA execution provider bundled with `onnxruntime-node`; `onnxruntime-node-gpu` is not required. Make sure the NVIDIA driver, CUDA 12 runtime, and cuDNN 9 are visible to Node, for example through the system linker path, `LD_LIBRARY_PATH`, or `REFLECTWORLD_CUDNN_LIB_DIR`.

## CLI

Run via `npx @reflectworld/reflectworld <command>` (standalone), or the installed extension's bundled CLI in plugin mode (`node ~/.openclaw/extensions/reflectworld/bundle/src/cli/index.js <command>`).

```
  setup [--yes] [--level 0|1] [--home-dir DIR]   Download binaries + models (standalone)
  enable-level1 [--gpu] [--with-stt]              Install native Level 1 peer deps (--gpu is compatibility-only)
  start [--dev] [--port N] [--home-dir DIR]       Start ReflectWorld (standalone)
  configure                                       Configure OpenClaw plugin providers
```

## API

### Plugin Services (auto-managed)

| Service | Description |
|---------|-------------|
| `qdrant` | Vector database (setup-prepared Qdrant binary + auto-start) |
| `reflectworld` | Python FastAPI memory service |
| `dashboard` | Web UI + WebSocket server |
| `go2rtc` | Video proxy (registered by the cam sub-plugin) |

### Registered Tools

| Tool | Description |
|------|-------------|
| `reflectworld_cam` | Camera control (add, snapshot, watch, stop) |
| `reflectworld_perception` | Scene configuration and analysis |
| `reflectworld_memory` | Memory search, get, delete, add_note |
| `reflectworld_notify` | Per-camera notification policy (always/smart/security_only) |

### Key Internal Classes

| Export | Description |
|--------|-------------|
| `PipelineStore` | SQLite store for pipeline logs, errors, media files, traces |
| `Notifier` | Dual-path push: direct channel send (alerts) + subagent (summaries) |
| `QdrantService` | Qdrant subprocess lifecycle management |
| `ReflectWorldService` | Python service lifecycle management |
| `DashboardServer` | Static file server + ReflectWorld API proxy for the Dashboard UI |

## See Also

- [ReflectWorld Architecture](https://github.com/addxai/ReflectWorld/blob/main/docs/architecture/overview.md)
- [Installation Guide](https://github.com/addxai/ReflectWorld/blob/main/docs/user-guide/installation.md)
- [Configuration Guide](https://github.com/addxai/ReflectWorld/blob/main/docs/user-guide/configuration.md)
- [Privacy & Responsible Use](https://github.com/addxai/ReflectWorld#privacy--responsible-use)
