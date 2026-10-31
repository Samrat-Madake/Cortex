# Quickstart

Run ReflectWorld for the first time, from configuration to a working Dashboard
with video analysis, memory, and chat.

Expected time is about 10 minutes after Node.js is installed. First startup can
take longer because ReflectWorld prepares local runtime binaries and the Python
memory service environment.

For the full install model, see [installation.md](./installation.md).

---

## What You Will Run

The fastest path is the standalone Dashboard:

```text
video source -> segmentation -> perception -> memory -> Dashboard + chat
```

Standalone mode starts the ReflectWorld runtime and serves the Dashboard from
one local process. It reads configuration from `.env`.

Use this quickstart if you want to:

- upload a local video and inspect what ReflectWorld remembers,
- connect an RTSP/phone/webcam source,
- test entity and memory behavior locally,
- ask chat questions over stored visual memory.

OpenClaw plugin mode, benchmark runs, and local model upgrades are covered near
the end.

---

## Prerequisites

Required:

- Node.js `>=22`
- macOS or Linux
- one vision-capable API key from an OpenAI-compatible provider or Gemini

Optional:

- an OpenAI-compatible embedding endpoint for semantic memory retrieval
- Level 1 local perception models for detection and ReID
- ElevenLabs or local STT if you want speech transcription

ReflectWorld manages Qdrant, go2rtc, ffmpeg, and the Python memory service
environment during setup. You do not need to install those manually.

---

## 1. Create `.env`

From a source checkout:

```bash
cp .env.example .env
```

For an npm-installed package, create `.env` in the directory where you run the
CLI.

Minimal OpenAI-compatible configuration:

```bash
VLM_PROVIDER=openai
VLM_MODEL=gpt-5-mini
VLM_MODEL_LITE=gpt-5-mini
VLM_API_KEY=your-vlm-api-key
VLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-5-mini
```

Recommended if you want semantic memory search:

```bash
EMBEDDER_PROVIDER=openai
EMBEDDER_MODEL=text-embedding-3-small
EMBEDDER_API_KEY=your-embedder-api-key
EMBEDDER_BASE_URL=https://api.openai.com/v1
EMBEDDING_DIMS=1536
```

Optional speech transcription:

```bash
# Cloud STT with speaker diarization.
STT_PROVIDER=elevenlabs
ELEVENLABS_API_KEY=<your-elevenlabs-key>
ELEVENLABS_MODEL_ID=scribe_v1
ELEVENLABS_LANGUAGE_CODE=en  # optional; leave empty for auto-detect

# Or local STT after `enable-level1 --with-stt`.
# STT_PROVIDER=moonshine
# STT_MODEL_DIR=~/.reflectworld/models/sherpa-onnx-moonshine-tiny-en-int8
# STT_NUM_THREADS=1
```

Gemini example:

```bash
VLM_PROVIDER=gemini
VLM_MODEL=<gemini-vision-model>
VLM_MODEL_LITE=<gemini-vision-model>
VLM_API_KEY=<your-gemini-key>
LLM_MODEL=<gemini-text-model>
```

Gemini does not expose an OpenAI-compatible embedding endpoint, so configure a
separate OpenAI-compatible embedder if you want semantic search.

Standalone mode reads `.env`. OpenClaw plugin mode does not; use
`npx @reflectworld/reflectworld configure` instead.

---

## 2. Start ReflectWorld

From an npm package:

```bash
npx @reflectworld/reflectworld start
```

From a source checkout:

```bash
npm install
npm run build
npx @reflectworld/reflectworld start --dev
```

Open:

```text
http://localhost:3210
```

First startup may show the Dashboard before every backend service is ready. This
is expected. You can check health with:

```bash
curl http://localhost:3210/api/health
```

Memory features may show `starting` or `degraded` until Qdrant and the Python
memory service finish initialization.

---

## 3. Add a Source

### Upload A Local Video

1. Open the Dashboard.
2. Add a source.
3. Upload an `.mp4`.
4. Start analysis.

Local files use media timestamps and drain at EOF, which makes them a good first
test. The default sampling rate is enough for a quick run.

### Add A Live Stream

Use an RTSP or compatible stream URL, for example:

```text
rtsp://user:pass@192.168.1.10:554/stream
```

Live preview is routed through go2rtc. Perception and memory run separately from
preview, so a source can stay viewable even while analysis is catching up.

See [dashboard.md](./dashboard.md) for source management, live view, stopping,
removing, and clearing data.

---

## 4. Watch Memory Build

As the source is analyzed, the Dashboard should begin to show:

- **segments** with summaries, timestamps, keyframes, and risk labels,
- **targets/entities** seen in the scene,
- **semantic memory** about the scene and recurring subjects,
- **service health** for runtime components.

With Level 0, ReflectWorld relies on VLM analysis. With Level 1, local detection
and ReID add stronger subject and identity continuity.

If segment cards appear but descriptions do not, check:

- `VLM_API_KEY`
- `VLM_BASE_URL`
- whether your model supports vision input
- the terminal logs for provider errors

---

## 5. Ask Questions

Open the chat button in the lower-right corner and ask questions such as:

- "What happened in the last few minutes?"
- "Who appeared near the door?"
- "Have we seen this person before?"
- "Was anything unusual in this video?"

Chat uses Dashboard context and stored memory. It is not just a single-frame
caption call; it can retrieve prior segments, semantic context, entity memory,
speech snippets, and visual evidence when available.

Dashboard chat uses `LLM_MODEL`. Benchmark Agent-QA uses `QA_MODEL` and is
configured separately.

---

## Optional: Enable Level 1 Local Perception

Level 1 adds local detection and ReID before VLM analysis. It is useful when you
want recurring entities, identity continuity, and local evidence grounding.

```bash
npx @reflectworld/reflectworld enable-level1
npx @reflectworld/reflectworld setup --level 1 --yes --accept-model-licenses
```

`--accept-model-licenses` acknowledges the AGPL / non-commercial licenses of the
Level 1 models; without it (or an interactive confirmation) those models are
skipped and setup stays at Level 0.

No further configuration is needed. ReflectWorld auto-detects the models and
enables local inference on the next `start`; you do not need to set
`STUBS_ONLY` manually. (The `STUBS_ONLY` env var still exists as an override,
but an empty models directory simply keeps Level 0 and degrades gracefully.)

**Local speech-to-text (optional):** run `enable-level1 --with-stt` (this
installs `sherpa-onnx-node`) and set `STT_PROVIDER=moonshine` in `.env` *before*
running setup, so setup fetches the Moonshine model:

```bash
npx @reflectworld/reflectworld enable-level1 --with-stt
npx @reflectworld/reflectworld setup --level 1 --yes --accept-model-licenses
```

If you enable local STT later, run those two commands again after setting
`STT_PROVIDER=moonshine`; they are idempotent.

Level 1 populates `~/.reflectworld/models` per each model's license: license-clean
models (Silero/Moonshine, MIT) download directly; restricted models with a ready
upstream ONNX (ArcFace, RTMPose — non-commercial) download directly but require
accepting their license; restricted models shipped only as training weights
(YOLO26m, RetinaFace, CLIP-ReID) are downloaded and converted to ONNX locally (in
a throwaway Python env via the bundled `uv`). Model weights are never committed to
the source tree or redistributed by ReflectWorld.

See [installation.md#level-0-vs-level-1](./installation.md#level-0-vs-level-1).

---

## Optional: Use OpenClaw Plugin Mode

Use this path when OpenClaw is your agent runtime and ReflectWorld should be
loaded as a plugin:

```bash
openclaw plugins install @reflectworld/reflectworld
npx @reflectworld/reflectworld configure
openclaw gateway restart
```

Plugin mode writes OpenClaw `pluginConfig` and does not read `.env`.

---

## Optional: Run Benchmarks

From a repository checkout:

```bash
npm install
cp .env.example .env
# Fill VLM_*, LLM_MODEL, QA_MODEL, and optionally QA_API_KEY / QA_BASE_URL.
npm run build
npx @reflectworld/reflectworld setup --level 1 --yes --accept-model-licenses
npm run benchmark:setup
npm run benchmark:run -- --dataset ~/benchmark-data/dataset.json --smoke
```

Benchmark runners are development tools, not production runtime dependencies.
See [eval/benchmark/README.md](../../eval/benchmark/README.md).

---

## Quick Troubleshooting

| Symptom | Check |
|---|---|
| Dashboard opens but memory is `starting` | Wait for first-run setup, then check `/api/health`. |
| VLM summaries are missing | Verify `VLM_API_KEY`, `VLM_BASE_URL`, provider, and model name. |
| Semantic search is weak or unavailable | Configure `EMBEDDER_*` and keep `EMBEDDING_DIMS` consistent with the collection. |
| Uploaded video does not analyze | Check source permissions and the bundled ffmpeg/ffprobe setup logs. |
| Live source does not preview | Check stream URL, go2rtc health, and source security settings. |
| Plugin mode ignores `.env` | Expected; use `reflectworld configure`. |

---

## Next Steps

| Goal | Go to |
|---|---|
| Learn the Dashboard panels | [dashboard.md](./dashboard.md) |
| Install details and local model levels | [installation.md](./installation.md) |
| Configure providers, embedder, STT, and security | [configuration.md](./configuration.md) |
| Understand the runtime architecture | [architecture/overview.md](../architecture/overview.md) |
| Integrate through HTTP APIs | [reference/http-api.md](../reference/http-api.md) |
