# CLI Reference

> Reference for the `@cortex/cortex` CLI. This page is intended for
> integrators and contributors.
>
> Entry point: `packages/cortex/src/cli/index.ts`, dispatching to
> `start`, `setup`, `configure`, and `enable-level1`.

```text
Usage: npx @cortex/cortex <command>

Commands:
  setup [--yes] [--level 0|1] [--home-dir DIR] [--accept-model-licenses]   download binaries and models
  enable-level1 [--gpu] [--with-stt]              install Level 1 native peer dependencies
  start [--dev] [--port N] [--home-dir DIR]       start Cortex
  configure                                       configure OpenClaw plugin model providers
```

`-h`, `--help`, and no arguments print the help text. Unknown commands print
help and exit with code 1.

---

## `start` - Start Cortex

```bash
npx @cortex/cortex start
```

Starts the local all-in-one stack. The HTTP UI becomes visible first, while
Qdrant, the memory service, go2rtc, and other services continue to start in the
background. Source: `cli/start.ts`.

Startup order:

1. Load `.env` before reading `process.env`.
2. Resolve configuration with precedence: CLI args, environment variables,
   `.env`, defaults. Canonical values are written back to `process.env` for
   shared resolvers.
3. Run automatic setup if this is the first run, versions changed, or required
   binaries/models are missing. Critical setup failure exits with code 1.
4. Start the Dashboard service first so the UI is reachable immediately.
5. Attach WebSockets and call `server.listen(port)`.
6. Start the remaining services in the background with best-effort semantics.
   Non-critical service failures put the system in degraded mode instead of
   crashing the Dashboard.
7. Handle `SIGINT` and `SIGTERM` with graceful service shutdown.

Flags:

| Flag | Meaning | Default |
|---|---|---|
| `--dev` | Development mode. The Python memory service source comes from `./services/mem` instead of the copied home directory. | off |
| `--port N` | Dashboard / HTTP port. Equivalent to `PORT`. | 3210 |
| `--home-dir DIR` | Binary and model installation directory. Equivalent to `CORTEX_HOME`. | see directory resolution |
| `--state-dir DIR` | Runtime state directory. Equivalent to `CORTEX_STATE_DIR`. | `./.cortex-state/` |

Related environment variables: `QDRANT_PORT` (6333), `QDRANT_GRPC_PORT`
(`QDRANT_PORT + 1`), `CORTEX_MEM_PORT` (8219), `GO2RTC_API_PORT` (1984),
`GO2RTC_RTSP_PORT` (8554), `GO2RTC_WEBRTC_PORT` (8555),
`GO2RTC_LISTEN_ADDR` (`127.0.0.1`), and `GO2RTC_REUSE_EXTERNAL` (true).

Directory resolution: `--home-dir` and `--state-dir` are canonicalized. When
not passed explicitly, the CLI uses `CORTEX_HOME` and
`CORTEX_STATE_DIR`, then falls back to `~/.cortex` and
`./.cortex-state/`. Public documentation treats these Cortex paths
as the runtime contract.

See [http-api.md](./http-api.md) for runtime endpoints.

---

## `setup` - Download Binaries and Models

```bash
npx @cortex/cortex setup [--yes] [--level 0|1] [--home-dir DIR] [--accept-model-licenses]
```

Downloads and verifies runtime binaries and model files, then writes the
`.setup.json` manifest. Source: `cli/setup.ts`; asset list:
`cli/manifest.ts`. `start` calls setup automatically when required, so manual
setup is usually unnecessary.

Phases:

1. **Binaries**: always download Qdrant, go2rtc, ffmpeg, ffprobe, and uv for the
   current OS/architecture, and copy the bundled Python memory service.
2. **Perception level and models**: download models for the selected level.
3. **Verify**: required binaries must exist. The achieved level is computed from
   model files that are actually present.

Levels:

| Level | Name | Models | Meaning |
|---|---|---|---|
| **0** | Scene Understanding | Silero VAD, about 2 MB | Cloud VLM scene description and safety decisions. Requires a VLM API key. |
| **1** | Scene Understanding + Local Recognition | L0 plus YOLO26m, RetinaFace ResNet50, and ArcFace MBF, about 200 MB+ | Adds local detection, coordinates, and face ReID. Identity evidence stays local. |

RTMPose and CLIP-ReID ViT-B are optional Body ReID models. Set
`CORTEX_BODY_REID_ENABLED=true` before `setup --level 1` to include them;
otherwise setup skips them.

Flags:

| Flag | Meaning |
|---|---|
| `--yes` / `-y` | Non-interactive mode; skip level selection prompts. |
| `--level 0|1` | Select perception level. In non-TTY or `--yes` mode, the default is 0. |
| `--home-dir DIR` | Installation directory; default `~/.cortex`. |
| `--accept-model-licenses` | Accept the upstream licenses required to download or locally convert restricted Level 1 models. |

Setup is idempotent. Existing binaries and models are skipped. Missing required
L0 files fail setup; missing higher-level files degrade to the highest achievable
level with a warning. `checkSetupNeeded` uses manifest version, binary
existence, and recorded model existence to decide whether setup must rerun.

---

## `enable-level1` - Install Level 1 Native Peers

```bash
npx @cortex/cortex enable-level1 [--gpu] [--with-stt]
```

Installs native npm peer dependencies required for Level 1 inference. These are
C++ addons and are separate from model files downloaded by `setup`. Source:
`cli/enable-level1.ts`.

Installed packages are resolved from peer dependency ranges in
`@cortex/percept` and `@cortex/cam`:

- `onnxruntime-node`, required inference runtime,
- `sharp`, required image processing,
- `sherpa-onnx-node`, only with `--with-stt`.

Linux GPU also uses `onnxruntime-node`; CUDA EP is detected at runtime. Ensure
the NVIDIA driver, CUDA 12 runtime, and cuDNN 9 are visible to Node.

The command adds an `onnxruntime-node > adm-zip=0.6.0` security override to the
npm project root, saves the native packages in the target package, and runs
`npm install` from the npm project root. For an npm workspace, the root also
declares `onnxruntime-node` so npm can apply the transitive override correctly;
the selected workspace package still declares all Level 1 dependencies. These
settings survive later `npm install` runs. Existing unrelated overrides are
preserved; a conflicting override is never replaced automatically.

Flags:

| Flag | Meaning |
|---|---|
| `--gpu` | Compatibility flag for old scripts. It does not install extra packages. |
| `--with-stt` | Also install `sherpa-onnx-node` for speech transcription. |
| `--dry-run` | Print the command without installing. |
| `--package-dir DIR` | Explicit target project or installed plugin directory. Defaults to the nearest project from the current directory. |
| `--yes` / `-y` | Accepted for script symmetry; the command is already non-interactive. |

After completion, ensure Level 1 model files are present, run
`cortex setup --level 1 --yes --accept-model-licenses`, and restart the gateway.

---

## `configure` - Configure OpenClaw Plugin Providers

```bash
npx @cortex/cortex configure
```

Interactively configures VLM, LLM, embedder, and STT providers for the
Cortex OpenClaw plugin, writes OpenClaw config, validates it, and restarts
the gateway. Source: `cli/configure.ts`; write plan:
`cli/configure-plan.ts`. In non-interactive mode, answers are read line by line
from stdin.

Prerequisite: an OpenClaw config file must be available.

Prompts:

| Prompt | Meaning | Written path prefix |
|---|---|---|
| VLM provider | `openai` or `gemini`; default `openai` | `...config.perception.vlm_provider` |
| VLM model | Vision-capable model; required | `...vlm_model` |
| VLM lite model | Snapshot/single-frame model. Gemini defaults to main model; OpenAI defaults to `gpt-5-mini`. | `...vlm_model_lite` |
| VLM API key | Required | `...vlm_api_key` |
| VLM base URL | OpenAI defaults to `https://api.openai.com/v1`; Gemini optional | `...vlm_base_url` |
| LLM model | Text compression and narrative model | `...llm_model` |
| Embedder gateway sharing | Gemini forces a separate embedder because it has no OpenAI-compatible embeddings endpoint | memory config |
| Embedder provider/model/key/base_url/dims/collection_name | Asked only when the embedder is independent. Provider must be `openai` or compatible. Non-default model or dims require a new collection name. | `...config.memory.embedder_*`, `embedding_dims`, `collection_name` |
| Speech-to-text | `off`, `moonshine`, or `elevenlabs`; default off | `...stt_provider` and provider-specific fields |

Flow: collect answers, run `openclaw config set <path> <value>` for each field,
run `openclaw config validate`, then `openclaw gateway restart`. If the gateway
was started manually and cannot be restarted, the command reports this as a
manual follow-up rather than a fatal config failure.

Constraints: Gemini VLM requires an independent OpenAI-compatible embedder;
embedder provider must be `openai`; `moonshine` requires an existing
`stt_model_dir`; embedding dimensions must be a positive integer.

`configure` configures runtime providers. It does not download binaries or
models and does not install native peer dependencies.
