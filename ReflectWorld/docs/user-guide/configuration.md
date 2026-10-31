# Configuration Guide

> Scenario-oriented configuration examples for ReflectWorld. For the complete
> key-by-key contract, see [reference/configuration.md](../reference/configuration.md).

---

## TL;DR

- ReflectWorld has **two runtime shapes**, and they use different configuration
  entry points:
  - **Standalone** (`reflectworld start`) reads the repository **`.env`**.
  - **OpenClaw plugin mode** does **not** read `.env`; use
    `npx @reflectworld/reflectworld configure`.
- Level 0 only needs one **VLM provider**. Configure an **embedder** if you need
  semantic memory retrieval; Gemini always needs a separate embedder.
- The default mode is local single-user trusted mode. Public or shared
  deployments must enable multi-user authentication and tighten exposed
  surfaces.

---

## 1. Know Which Runtime Shape You Are Using

| | Standalone | OpenClaw plugin |
|---|---|---|
| Startup | `npx @reflectworld/reflectworld start` | Loaded as an OpenClaw plugin |
| Config entry point | Repository **`.env`** through `dotenv` | `configure` writes OpenClaw `pluginConfig` |
| Does `.env` apply? | Yes | No |
| How changes take effect | Restart `start` | `configure` validates and restarts the gateway |

The common mistake is writing `VLM_API_KEY` into `.env` while running plugin
mode. Plugin mode will not read it, so VLM calls return 401. Use `configure` in
plugin mode.

This guide focuses on standalone `.env`. The corresponding plugin-mode path is
noted where relevant. The high-level runtime shape is summarized in the
[architecture overview](../architecture/overview.md).

---

## 2. Configure VLM and LLM Providers

ReflectWorld uses three model categories:

- **VLM** for multi-frame and single-frame visual analysis. This is required.
- **LLM** for text compression and narrative summaries. By default it reuses VLM
  credentials.
- **Embedder** for semantic memory retrieval. See the next section.

### Scenario A: OpenAI or an OpenAI-Compatible Gateway

`.env`:

```bash
VLM_PROVIDER=openai
VLM_MODEL=gpt-5-mini
VLM_MODEL_LITE=gpt-5-mini
VLM_API_KEY=sk-...
VLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-5-mini
```

`VLM_BASE_URL` can point to an OpenAI-compatible endpoint, such as LiteLLM or a
third-party proxy. Native Azure OpenAI and Vertex AI endpoint formats are not
handled directly; put an OpenAI-compatible gateway in front of them and keep
`VLM_PROVIDER=openai`.

### Scenario B: Gemini

```bash
VLM_PROVIDER=gemini
VLM_MODEL=<gemini-vision-model>
VLM_API_KEY=<your-gemini-key>
# VLM_BASE_URL can stay empty.
LLM_MODEL=<gemini-text-model>
```

Gemini does not provide an OpenAI-compatible embeddings endpoint. If semantic
memory retrieval is enabled, configure a separate OpenAI-compatible embedder.

**Plugin mode**: run `npx @reflectworld/reflectworld configure` and fill the VLM
provider, model, lite model, key, base URL, and LLM model. The command writes to
`plugins.entries.reflectworld.config.perception.vlm_*` and restarts the gateway.

---

## 3. Configure the Embedder

The embedder turns memory text into vectors stored in Qdrant.

- Default: the embedder falls back to VLM credentials and uses
  `text-embedding-3-small` with 1536 dimensions.
- Configure it separately when:
  1. you use Gemini,
  2. the embedder should use a different gateway or key,
  3. you change the embedding model or dimensions.

`.env`:

```bash
EMBEDDER_PROVIDER=openai
EMBEDDER_MODEL=text-embedding-3-small
EMBEDDER_API_KEY=sk-...
EMBEDDER_BASE_URL=https://api.openai.com/v1
# EMBEDDING_DIMS=1536
```

If you change the embedding model or dimensions, use a new collection name.
Vectors of different dimensions cannot share one Qdrant collection. The embedder
provider currently only supports `openai` and OpenAI-compatible services.

**Plugin mode**: `configure` asks whether the embedder shares the gateway. Gemini
forces an independent embedder. Independent embedder settings are written under
`config.memory.embedder_*` and bridged into the Python memory subprocess.

---

## 4. Security Boundary: Local Trusted vs Public Deployment

ReflectWorld defaults to local single-user trusted use. This optimizes the
one-command experience, but the defaults should not be exposed directly to the
internet or a shared LAN.

### What Local Single-User Mode Allows

- Dashboard mutation, chat, and proxy endpoints do not require authentication.
- Top-level tool API `/api/tool/:name` can be called directly.
- CORS is `*`.
- Monitor events are broadcast to connected WebSocket clients.

These are acceptable only when the process runs on your own machine for your own
use.

### Required Public Deployment Measures

| Requirement | How |
|---|---|
| Enable multi-user auth | `DASHBOARD_MULTI_USER=true` |
| Bind loopback first and expose intentionally | Keep internal services such as mem bound to `127.0.0.1`; expose through a controlled proxy |
| Validate source URLs | Source input is an SSRF and local-file boundary |
| Protect broad tool API | In public/LAN mode require an admin token or disable the endpoint |
| Rate-limit chat | Chat is a cost-bearing LLM surface |

### Dashboard and Tool Protection in Public Mode

`DASHBOARD_MULTI_USER=true` or `REFLECTWORLD_PUBLIC_MODE=true` enables stricter
Dashboard behavior: WebSocket Origin checks, connection limits, and chat rate
limits. The broad CLI tool API also requires an admin token in public mode.

```bash
DASHBOARD_MULTI_USER=true
REFLECTWORLD_PUBLIC_MODE=true
DASHBOARD_ADMIN_TOKEN=<strong-token>

DASHBOARD_WS_ALLOWED_ORIGINS=https://demo.example.com
DASHBOARD_MAX_WS_CONNECTIONS=100
DASHBOARD_CHAT_RATE_LIMIT_PER_MIN=20

REFLECTWORLD_TOOL_API_RESTRICTED=true
REFLECTWORLD_TOOL_API_TOKEN=<strong-token>
```

Local single-user mode leaves these restrictions off to preserve the simple
local agent experience.

### Source Validation

Sources can be camera URLs, uploaded videos, local files, or local capture
devices. Local single-user mode stays permissive. Multi-user Dashboard source
creation automatically uses strict mode. If non-Dashboard tool entry points are
also exposed, enable global strict validation:

```bash
DASHBOARD_MULTI_USER=true
REFLECTWORLD_SOURCE_SECURITY_STRICT=true
# or
REFLECTWORLD_PUBLIC_MODE=true
```

Strict mode allows `phone`, `webcam`, `https`, `rtsp`, and `rtsps` by default,
and rejects:

- local file paths, `file://`, relative paths, absolute Unix paths, and Windows
  drive paths,
- local capture device URLs such as `usb:`, `avfoundation://`, and `v4l2://`,
- `http://` unless explicitly enabled,
- DNS or IP addresses resolving to loopback, link-local, private, reserved, or
  cloud metadata ranges.

Trusted LAN deployments can opt in to private sources:

```bash
REFLECTWORLD_ALLOW_PRIVATE_SOURCE=true
REFLECTWORLD_ALLOW_INSECURE_HTTP_SOURCE=true
REFLECTWORLD_ALLOW_LOCAL_SOURCE=true
```

Use these only on trusted local machines or trusted LANs. Uploaded video
analysis uses an internal local-file authorization path and does not require
`REFLECTWORLD_ALLOW_LOCAL_SOURCE`.

If `REFLECTWORLD_PUBLIC_MODE=true` is combined with
`REFLECTWORLD_ALLOW_PRIVATE_SOURCE=true` or `REFLECTWORLD_ALLOW_LOCAL_SOURCE=true`,
startup prints a warning but does not block the configuration. A hosted public
demo should not enable these escape hatches. For stronger defense against DNS
rebinding, also block private and metadata ranges at the container or firewall
egress layer.

See the authentication matrix in
[reference/http-api.md](../reference/http-api.md) before public deployment.

---

## 5. Single-User vs Multi-User

`DASHBOARD_MULTI_USER` is the main switch.

### Single-User Mode

Default: `DASHBOARD_MULTI_USER=false`.

- No session concept.
- Visibility checks allow all local data.
- Intended for local personal use and single-developer debugging.

### Multi-User Mode

Set `DASHBOARD_MULTI_USER=true` for public demos or shared deployments.

- Users enter through a Dashboard session with `session_id` and `user_id`.
- Source and memory visibility are session-scoped.
- Mutation, chat, and proxy operations require a valid session.
- Quotas control active sessions and source count:

```bash
DASHBOARD_MULTI_USER=true
DASHBOARD_MAX_ACTIVE_SESSIONS=5
DASHBOARD_MAX_SOURCES_PER_SESSION=2
DASHBOARD_SESSION_TTL_MIN=15
DASHBOARD_ADMIN_TOKEN=<token>
```

Multi-user mode is required for shared deployments, but it is not sufficient by
itself. Pair it with the public-deployment controls above.

---

## 6. Ports and Directories

Common ports:

```bash
PORT=3210
QDRANT_PORT=6333
REFLECTWORLD_MEM_PORT=8219
GO2RTC_API_PORT=1984
```

Directories:

```bash
REFLECTWORLD_HOME=~/.reflectworld
REFLECTWORLD_STATE_DIR=./.reflectworld-state
```

Use the ReflectWorld directory variables for all installs and deployments.
Public configuration should use only `REFLECTWORLD_*` variables and
ReflectWorld directory names.

Run a second instance with isolated state:

```bash
PORT=3211 QDRANT_PORT=6334 npx @reflectworld/reflectworld start
```

Choose distinct ports for concurrent instances. The memory-service launcher can
select another free port in a narrow collection-prefix conflict case, but the
Dashboard and other listeners do not generally auto-increment. See
[reference/cli.md](../reference/cli.md) and
[reference/configuration.md](../reference/configuration.md).

---

## 7. Runtime Settings vs Deployment Configuration

| Category | Where to change | Effect time | Examples |
|---|---|---|---|
| **Runtime settings** | Dashboard Settings | Immediate broadcast | `analysis_level`, `capture_mode`, `sampling_rate` |
| **Deployment configuration** | `.env` or `configure` | Requires restart | VLM provider, `vlm_model`, API key, embedder, ports, `DASHBOARD_MULTI_USER` |

See [dashboard.md#settings](./dashboard.md#settings) for runtime setting values.

---

## Related Docs

- [reference/configuration.md](../reference/configuration.md) - full configuration contract
- [reference/cli.md](../reference/cli.md) - CLI command reference
- [reference/http-api.md](../reference/http-api.md) - endpoint authentication reference
- [installation.md](./installation.md), [quickstart.md](./quickstart.md), and [dashboard.md](./dashboard.md)
