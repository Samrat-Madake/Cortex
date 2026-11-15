# Development Setup

> This page is for contributors. It explains how to run Cortex locally for
> development. Architectural rationale lives under [architecture/](../architecture/overview.md);
> this page focuses on the workflow.

Cortex is a TypeScript monorepo using npm workspaces, plus one Python
subservice. Most code is TypeScript. The memory service is Python. The
orchestrator imports the TypeScript packages as same-process libraries; only
cross-language or external runtime dependencies such as Python mem, Rust
Qdrant, and Go go2rtc are started as subprocesses.

---

## 1. Prerequisites

| Dependency | Version | Purpose | Notes |
|---|---|---|---|
| **Node.js** | `>=22` | TypeScript packages, orchestrator, Dashboard | Enforced by `package.json` engines. |
| **npm** | bundled with Node | Workspace management | Use npm workspaces. Do not mix pnpm or yarn. |
| **Python** | `>=3.11` | `services/mem` | Required by `services/mem/pyproject.toml`. |
| **uv** | current | Python dependency management and execution | The memory service uses `uv`; do not manage it with raw `pip` or ad-hoc virtualenvs. |

Optional runtime assets are installed or placed by CLI setup, not by npm or uv:

- **Qdrant** for persistent vector storage.
- **go2rtc** for RTSP/WebRTC live sources.
- **Local perception models** for Level 1 detection and ReID.

Start with Level 0 for development, then enable Level 1 only when needed.

---

## 2. Install

### TypeScript

```bash
npm install
npm run build
```

`npm install` installs all workspace dependencies and links local
`@cortex/*` packages.

`npm run build` runs:

1. `tsc --build` for all project references.
2. `node scripts/bundle-assets.js` to prepare `bundled-dashboard/` and
   `bundled-services/` for runtime packaging.

`packages/dashboard` is a Vite app with its own development flow. Use its own
`npm run dev` when working on the frontend.

### Python Memory Service

```bash
cd services/mem
uv sync
uv sync --extra dev
```

`uv sync` creates and maintains `services/mem/.venv`. Run Python commands with
`uv run <cmd>`; do not manually activate the venv and install packages with
`pip`. `uv.lock` is the source of truth.

Spatial/SLAM services are not part of the first public release. The public tree
only includes `services/mem`.

### `.env`

```bash
cp .env.example .env
```

For a minimal Level 0 run, fill the `VLM_*` block. Infrastructure settings such
as Qdrant ports and memory endpoints have defaults. OpenClaw plugin users should
use `npx @cortex/cortex configure` instead of editing `.env`.

See [reference/configuration.md](../reference/configuration.md) and the
[architecture overview](../architecture/overview.md).

---

## 3. Monorepo Layout

```text
cortex/
├── packages/
│   ├── shared/        shared types and event contracts
│   ├── cam/           capture: sources -> VAD/STT -> segments
│   ├── percept/       perception: detection -> ReID -> VLM
│   ├── mem/           TypeScript client and types for the memory service
│   ├── cortex/  orchestrator, process/config/storage, CLI, packaging
│   ├── dashboard/     React frontend
│   ├── host/          standalone host and demo server
│   └── monitor/       deprecated; do not add new functionality here
├── services/
│   └── mem/           Python/FastAPI memory service
├── eval/              reproducible benchmark and video-runner entry points
├── scripts/           build and release scripts
└── docs/              documentation
```

| Module | Path | Language | Responsibility |
|---|---|---|---|
| **shared** | `packages/shared` | TS | Shared types and event contracts |
| **cam** | `packages/cam` | TS | Multi-source capture to `Segment` |
| **percept** | `packages/percept` | TS | Detection, ReID, VLM, identity resolution |
| **mem client** | `packages/mem` | TS | HTTP client and type contract for the memory service |
| **cortex** | `packages/cortex` | TS | Composition root, services, CLI, packaging |
| **dashboard** | `packages/dashboard` | TS | Realtime UI, streaming partials, entity and memory views |
| **host** | `packages/host` | TS | Standalone demo and tool API host |
| **mem service** | `services/mem` | Python | Qdrant-backed memory, retrieval, semantic merge, ReID vector store |

Dependency direction:

- `shared` is the bottom contract layer and depends on no workspace package.
- `cam`, `percept`, and the TS `mem` client depend on `shared`.
- `cortex` depends on `cam`, `percept`, `mem`, and `shared` and wires them
  together in `register()`.
- `dashboard` consumes backend events over HTTP/WebSocket and is not imported by
  backend packages.

Put shared types/contracts in `shared`, package-specific business logic in the
owning package, and orchestration in `cortex`.

---

## 4. Local Run Modes

### Full Stack

```bash
npx @cortex/cortex setup --level 1 --yes --accept-model-licenses
npx @cortex/cortex start --dev
```

`--dev` uses local sources. The orchestrator starts subprocesses such as Python
mem, Qdrant, and go2rtc and coordinates health checks. Configure distinct ports
for concurrent stacks; listeners do not generally auto-increment on conflicts.

Equivalent npm script after build:

```bash
npm run start
```

### Multiple Local Instances

```bash
PORT=3211 QDRANT_PORT=6334 npx @cortex/cortex start --dev
```

### Python Memory Service Only

```bash
cd services/mem
uv run uvicorn src.main:app --host 127.0.0.1 --port 8219
```

When running mem manually, export required variables yourself, such as
`QDRANT_HOST`, `QDRANT_PORT`, `COLLECTION_PREFIX`, `EMBEDDER_*`, and `LLM_*`,
and provide a reachable Qdrant instance. Production startup injects these
through the orchestrator.

### Dashboard Development

```bash
cd packages/dashboard
npm run dev
```

The Vite dev server expects a backend to be running. For an isolated dashboard
demo:

```bash
npm run build
npx @cortex/cortex setup --yes
npm run dashboard:demo
```

For the real orchestrator event stream:

```bash
npm run dashboard:main
```

---

## 5. Checks Before Commit

```bash
npm run typecheck
npx vitest run
```

If you changed `services/mem`:

```bash
cd services/mem && uv run pytest
```

---

## 6. Common Issues

- **`npm run start` cannot find `dist/`**: run `npm run build` first. The script
  uses compiled output.
- **Memory service cannot reach Qdrant**: when running mem manually, export
  `QDRANT_HOST` / `QDRANT_PORT` and ensure Qdrant is running. The orchestrator
  handles this for normal startup.
- **Dashboard is blank or disconnected**: the dashboard dev server needs a
  backend WebSocket/SSE provider. Start the orchestrator or use
  `npm run dashboard:demo`.
- **Where are Python dependencies installed?** `services/mem/.venv`, managed by
  uv. Use `uv run`.
