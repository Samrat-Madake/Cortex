# Third-Party Notices

Cortex is licensed under the Apache License 2.0 (see [LICENSE](LICENSE)). It builds on
third-party software and optional machine-learning models that carry their own
licenses. This document summarizes those components.

> Cortex does **not** redistribute the model weights or prepared binaries listed
> below. They are downloaded or provided by the user at setup time. You are responsible
> for complying with each component's license for your use case — **especially for
> commercial use**. Cortex grants no rights to these third-party components.

## Research and demo media assets

Some README, paper, and project-page figures may include still frames, thumbnails,
or short screen recordings derived from publicly available benchmark or web
videos. These media snippets are used only for academic illustration,
benchmark explanation, and algorithm comparison in the context of this
open-source academic research project.

The original videos, frames, thumbnails, audio, subtitles, identities, and other
media content remain the property of their respective rights holders. They are
**not** covered by Cortex's Apache-2.0 license, and Cortex does not
grant permission to reuse them outside the academic context in which they are
shown.

Known README/demo assets that may contain third-party benchmark or web-video
frames include:

| Asset | Purpose | Source / provenance | Note |
|-------|---------|---------------------|------|
| `docs/assets/readme/dashboard-demo.gif` | Dashboard walkthrough | Public YouTube video, first five minutes: `https://www.youtube.com/watch?v=oE5lNDhz9oo` | Used to demonstrate dashboard memory workflows. |
| `docs/assets/readme/capability-narrative-scene-memory.png` | Narrative scene memory illustration | Public YouTube coffee video: `https://www.youtube.com/watch?v=rJwkFOBdA60` | Used to illustrate scene-level memory continuity. |
| `docs/assets/readme/capability-persistent-entity-memory.png` | Persistent entity memory illustration | Public YouTube weekly vlog video: `https://www.youtube.com/watch?v=d2Q9Dp1JyVM` | Used to illustrate recurring-entity memory over time. |
| `docs/assets/readme/capability-agent-ready-visual-memory.png` | Agent-ready visual memory illustration | Public YouTube cockpit video: `https://www.youtube.com/watch?v=K37YKK9h9pA` | Used to illustrate memory-grounded QA. |
| README linked YouTube thumbnails | Trace-backed examples | External YouTube thumbnail URLs linked to the original videos | Loaded from YouTube and shown as external links to the original videos. |

If you believe any media asset infringes your rights or should be removed,
contact `info@addx.ai` and include the asset path or source URL. We will review
and remove or replace the material where appropriate.

## Runtime dependencies (npm)

| Package | License |
|---------|---------|
| @sinclair/typebox | MIT |
| zod | MIT |
| dotenv | BSD-2-Clause |
| jpeg-js | BSD-3-Clause |
| pixelmatch | ISC |
| qrcode | MIT |
| ws | MIT |
| react, react-dom | MIT |
| three | MIT |
| motion | MIT |
| onnxruntime-node (optional peer) | MIT |
| sharp (optional peer) | Apache-2.0 |
| sharp/libvips platform packages (transitive optional) | LGPL-3.0-or-later |
| sherpa-onnx-node (optional peer) | Apache-2.0 |
| caniuse-lite (transitive build dependency) | CC-BY-4.0; data from caniuse.com |

Most runtime dependencies are permissive and compatible with Apache-2.0. Optional
native/image-processing transitive packages may carry LGPL obligations when they
are distributed with binaries; review package notices when redistributing a
bundled application.

## Runtime dependencies (Python — `services/mem`)

| Package | License |
|---------|---------|
| fastapi | MIT |
| uvicorn | BSD-3-Clause |
| qdrant-client | Apache-2.0 |
| openai | Apache-2.0 |
| google-generativeai | Apache-2.0 |
| pydantic | MIT |
| httpx | BSD-3-Clause |
| numpy | BSD-3-Clause |
| python-dotenv | BSD-3-Clause |

## Prepared binaries (downloaded at setup)

Fetched as standalone executables and invoked as separate subprocesses; not linked
into Cortex.

| Binary | Upstream | License | Notes |
|--------|----------|---------|-------|
| Qdrant | qdrant/qdrant | Apache-2.0 | Vector store |
| go2rtc | AlexxIT/go2rtc | MIT | Stream gateway |
| uv | astral-sh/uv | Apache-2.0 / MIT | Python env manager |
| ffmpeg | static build (e.g. evermeet.cx, johnvansickle.com) | **GPL / LGPL** | External tool invoked as a subprocess. Static builds are typically GPL; Cortex neither links nor modifies ffmpeg. Choose a build whose license fits your distribution. |

## Models (downloaded or user-provided at setup)

Cortex is model-agnostic; the perception stack is configurable. The default
models below are **not bundled** with the repository. Review each model's license
before commercial deployment.

| Model | Purpose | Artifact | Upstream / Source | License / Note |
|-------|---------|----------|-------------------|----------------|
| Silero VAD | Voice activity detection | sherpa-onnx VAD assets | snakers4/silero-vad via sherpa-onnx | MIT |
| YOLO26m | Object detection (Level 1) | `yolo26m.onnx` | user-provided / converted YOLO-family detector | **Verify upstream license.** YOLO-family weights may carry copyleft or commercial restrictions depending on the source distribution. |
| RetinaFace ResNet50 | Face detection + landmarks (Level 1) | `retinaface-resnet50.onnx` | InsightFace / RetinaFace-family pretrained model | InsightFace pretrained models are generally **non-commercial / research-only**. Verify before commercial use. |
| ArcFace MBF (`w600k_mbf`) | Face recognition / ReID (Level 1) | `w600k_mbf.onnx` | InsightFace ArcFace / MobileFaceNet-family pretrained model | **Non-commercial / research-only** per InsightFace terms. |
| CLIP-ReID ViT-B | Body ReID (optional, disabled by default) | `clip-reid-vitb.onnx` | CLIP-ReID | Research use; verify license. |
| RTMPose-s | Body pose estimation, 17 COCO keypoints (optional, disabled by default) | `rtmpose-s.onnx` | RTMPose / OpenMMLab-family pose model | Verify upstream model and dataset license before commercial use. |
| Moonshine Tiny int8 | Local speech recognition (optional) | `sherpa-onnx-moonshine-tiny-en-int8` | Moonshine Tiny via sherpa-onnx model releases | Optional alternative to cloud STT providers such as ElevenLabs. Verify upstream model license before commercial use. |

> **Important:** Default face models (RetinaFace / ArcFace via InsightFace) are commonly
> research-only. For commercial use, substitute models whose licenses permit it or obtain
> the appropriate licenses. This notice is informational and is not legal advice; verify
> obligations for your deployment.

Moonshine English model weights are published under MIT by Useful Sensors.
Non-English Moonshine community models may carry non-commercial terms; verify the
exact model artifact you download.

## Third-party implementation references

Some local-model preprocessing and decoder code follows public model reference
implementations:

| Component | Reference | License / Note |
|-----------|-----------|----------------|
| Procedural memory system prompt | `mem0ai/mem0` | Apache-2.0; the prompt text was adapted from the reference project. Cortex's memory implementation is independently developed and does not depend on Mem0. |
| RetinaFace anchor/decode configuration | `biubug6/Pytorch_Retinaface` | MIT |
| CLIP vision architecture and CLIP-ReID export conventions | `openai/CLIP`, `Syliz517/CLIP-ReID` | MIT |
| ArcFace alignment conventions | InsightFace / ArcFace reference implementations | Code is open source; pretrained model/data terms may be non-commercial or research-only. |
| M3-Bench judge prompt and evaluation logic | `ByteDance-Seed/m3-agent` | Apache-2.0; used only by the optional benchmark evaluation script. |

### Pytorch_Retinaface license

```text
MIT License

Copyright (c) 2019

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### CLIP-ReID license

```text
MIT License

Copyright (c) 2023 Syliz517

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### OpenAI CLIP license

```text
MIT License

Copyright (c) 2021 OpenAI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Optional companion app

The `phone` source type integrates with the **ClawCam** CLI/app (`https://rtc.reflect.world`),
a separate tool that bridges a phone browser (WebRTC) to a local RTSP stream. ClawCam is
an external dependency installed separately; other source types (RTSP, HTTP, file, webcam)
do not require it.
