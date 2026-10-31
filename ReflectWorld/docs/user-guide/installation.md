# Installation

> What ReflectWorld needs and how to install it. After this page you should
> have a local environment that can start.
>
> For the first end-to-end run, see [quickstart.md](./quickstart.md). For CLI
> details, see [reference/cli.md](../reference/cli.md).

---

## TL;DR

- **Fastest path**: install Node.js >= 22, then run
  `npx @reflectworld/reflectworld start`. First startup downloads the binaries
  and models required at runtime.
- ReflectWorld **manages its own runtime dependencies**. `setup` downloads
  pinned versions of ffmpeg, Qdrant, go2rtc, and `uv` into
  `~/.reflectworld/bin`. You do not need to install them yourself.
- **Level 0** needs Node.js and one VLM API key. **Level 1** adds local
  detection and face recognition, so it needs additional models and native
  inference dependencies.
- Supported platforms are **macOS and Linux**. Windows is not currently
  supported.

---

## 1. Prerequisites

| Dependency | Required? | Installed by | Notes |
|---|---|---|---|
| **Node.js >= 22** | Yes | You | The only hard prerequisite. |
| A VLM API key | Yes for Level 0 | You | OpenAI-compatible endpoint or Gemini. |
| ffmpeg / Qdrant / go2rtc / uv | No manual install | `setup` | Downloaded as pinned binaries into `~/.reflectworld/bin`. |
| Python | No manual install | `uv` | The memory service is Python FastAPI and runs in an isolated uv environment. |
| onnxruntime-node / sharp / local models | Level 1 only | `enable-level1` and `setup --level 1 --accept-model-licenses` | Required for local detection and ReID. |

Platforms outside macOS and Linux, especially Windows, are currently outside
the supported path.

---

## 2. One-Command Install and Start

ReflectWorld treats first-time setup as part of `start`. If setup is missing,
stale, or incomplete, `start` runs it automatically.

```bash
# After npm publication
npm install @reflectworld/reflectworld

# Create a .env with your Level 0 VLM key.
$EDITOR .env

# Start the whole stack.
npx @reflectworld/reflectworld start
# -> http://localhost:3210
```

Open `http://localhost:3210` after startup.

For source checkout development:

```bash
git clone <repo> reflectworld
cd reflectworld
npm install
npm run build
cp .env.example .env
npx @reflectworld/reflectworld start --dev
```

`--dev` runs the memory service from the local source tree.

### What `setup` Downloads

`setup` has three phases:

1. **Binaries**, always downloaded into `~/.reflectworld/bin`:

   | Binary | Version | Purpose |
   |---|---|---|
   | `qdrant` | 1.17.1 | Vector database for memory |
   | `go2rtc` | 1.9.14 | Live stream gateway for RTSP, cameras, and phones |
   | `ffmpeg` | 6.0.1 | Frame extraction and transcoding |
   | `ffprobe` | 6.0.1 | Local-file stream metadata and timestamp inspection |
   | `uv` | 0.7.12 | Python runner for the memory service |

   The packaged Python memory service source is copied to
   `~/.reflectworld/services/mem`.

2. **Perception models**, downloaded into `~/.reflectworld/models` according to
   the selected level.

3. **Validation**, which verifies that required binaries exist, records the
   achieved level, and writes `~/.reflectworld/.setup.json`.

`setup` is idempotent. Existing binaries and models are skipped, so it is safe
to run repeatedly.

---

## 3. Level 0 vs Level 1

Choose the level before downloading extra models.

| | Level 0 - Scene Understanding | Level 1 - Scene Understanding + Local Recognition |
|---|---|---|
| **Capabilities** | Cloud VLM scene summaries and safety decisions | Everything in Level 0 plus local detection, target coordinates, and face ReID |
| **Privacy** | Frames are sent to the VLM provider | Identity and detection evidence stay local; VLM still receives selected frames for scene reasoning |
| **Extra downloads** | Silero VAD only, about 2 MB | YOLO26m, RetinaFace ResNet50, ArcFace MBF, about 200 MB+ |
| **Native dependencies** | None required | `onnxruntime-node` and `sharp` |
| **Requirements** | Node.js and a VLM key | Level 0 plus native dependencies and model files |

### Level 0

The default automatic setup path is Level 0. Configure a VLM key and start.

### Upgrade to Level 1

Level 1 requires both native peer dependencies and model files:

```bash
# Install native peer dependencies.
npx @reflectworld/reflectworld enable-level1
# --gpu       accepted for old scripts; CUDA is detected by onnxruntime-node
# --with-stt  also installs sherpa-onnx-node for speech transcription

# Download + build Level 1 model files (accepts the models' AGPL / non-commercial licenses).
npx @reflectworld/reflectworld setup --level 1 --yes --accept-model-licenses
```

If model files are present, ReflectWorld enables the local analysis path
automatically. If models or engines are missing, the system warns and degrades
to Level 0 instead of crashing. To make missing Level 1 support fatal for a
deployment, set `perception.required_level=1` or
`REFLECTWORLD_PERCEPTION_REQUIRED_LEVEL=1`.

For Linux GPU deployments, use `onnxruntime-node`; do not install
`onnxruntime-node-gpu`. Ensure the NVIDIA driver, CUDA 12 runtime, and cuDNN 9
are visible to the Node dynamic linker. Use system linker paths, `LD_LIBRARY_PATH`,
or `REFLECTWORLD_CUDNN_LIB_DIR` when necessary.

`setup --level 1` acquires each Level 1 model the way its license allows, in three
categories: (1) **license-clean** models (Silero/Moonshine, MIT) download directly;
(2) **restricted models with a ready upstream ONNX** (ArcFace via InsightFace,
RTMPose via MMPose — non-commercial) download directly but require accepting their
license; (3) **restricted models shipped only as training weights** (YOLO26m,
RetinaFace, CLIP-ReID) have their open-source weights downloaded and converted to
ONNX locally (in a throwaway Python env managed by the bundled `uv`). ReflectWorld
never redistributes weights. The runtime uses the highest level supported by the
models that are actually present.

RTMPose and CLIP-ReID are installed only when Body ReID is requested. Set
`REFLECTWORLD_BODY_REID_ENABLED=true` before running `setup --level 1` to include
those two models.

Level 1 models are governed by their upstream licenses. Check license terms
before redistributing or using them commercially.

---

## 4. Directory Layout

ReflectWorld separates shared assets from per-instance state:

| Purpose | Default path | Environment variable | Contents |
|---|---|---|---|
| **Shared assets** | `~/.reflectworld/` | `REFLECTWORLD_HOME` | `bin/`, `models/`, copied Python service source, `.setup.json` |
| **Instance state** | `./.reflectworld-state/` | `REFLECTWORLD_STATE_DIR` | Qdrant storage, recordings, media, source config, SQLite |

Multiple clones or instances can share binaries and models while keeping runtime
state separate.

```bash
PORT=3211 QDRANT_PORT=6334 npx @reflectworld/reflectworld start
```

For a clean setup, keep shared assets in `REFLECTWORLD_HOME` and runtime data
in `REFLECTWORLD_STATE_DIR`. This documentation uses only ReflectWorld directory
names.

---

## 5. Platform Notes

### macOS and Apple Silicon

- macOS currently downloads a fixed x86_64 ffmpeg build. On Apple Silicon this
  runs through Rosetta, which is functionally correct but slower under heavy
  load.
- If Level 1 native inference fails to load dynamic libraries, make sure the
  native library directory is visible to the dynamic linker. For debugging:

  ```bash
  export DYLD_LIBRARY_PATH="$(node -p "require('path').dirname(require.resolve('onnxruntime-node'))")":$DYLD_LIBRARY_PATH
  ```

- Apple Silicon uses the CoreML execution provider through onnxruntime-node.

### Binary Download Sources

ffmpeg comes from third-party static-build hosts: evermeet.cx on macOS and
johnvansickle.com on Linux. Qdrant, go2rtc, and uv come from their upstream
GitHub releases. If your network blocks these hosts, pre-place the binaries in
`~/.reflectworld/bin`; `setup` skips files that already exist.

---

## 6. First Startup Can Be Slow

The Dashboard appears before all background services finish initializing:

```text
start
  -> optional setup downloads binaries and models
  -> Dashboard service starts
  -> server.listen(3210)
  -> Qdrant, memory service, and go2rtc start in the background
       -> first uv run may download Python dependencies
```

Seeing `starting` or `degraded` on the first Dashboard load is normal:

- The first `uv run` for the memory service can take several minutes.
- `curl http://localhost:3210/api/health` shows `starting` with HTTP 503 until
  the stack becomes `ready` with HTTP 200.
- Non-critical service failures do not crash the UI. ReflectWorld keeps the
  usable subset available in degraded mode.

Later startups are faster because binaries, models, and Python dependencies are
cached.

---

## Next Steps

- [quickstart.md](./quickstart.md) - configure a key, add a video source, see memories, and ask questions
- [configuration.md](./configuration.md) - VLM, LLM, embedder, single-user vs multi-user
- [dashboard.md](./dashboard.md) - how to use the Dashboard panels
