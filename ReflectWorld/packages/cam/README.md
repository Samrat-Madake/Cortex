# @reflectworld/cam

> Video capture, frame extraction, motion detection, and audio VAD via go2rtc.

## Overview

The Cam package manages video sources (RTSP, webcam, phone, HTTP) through go2rtc as a unified proxy. It captures frames, detects motion, segments audio with Silero VAD, and produces `Segment` objects for the perception pipeline. Supports three capture modes: snapshot (single frame), event (motion-triggered), and stream (continuous).

## Installation

```bash
npm install @reflectworld/cam
```

Runtime assets are prepared by `npx @reflectworld/reflectworld setup`: go2rtc,
ffmpeg, ffprobe, Qdrant, and uv are installed under `~/.reflectworld/bin`, while
the Silero VAD model is installed under `~/.reflectworld/models`. Runtime only
resolves prepared assets.

## Quick Start

```typescript
import { Go2rtcManager, FrameExtractor, MotionFilter, SourceManager } from "@reflectworld/cam";

const go2rtc = new Go2rtcManager({ binPath: "/path/to/go2rtc", apiPort: 1984 });
await go2rtc.start();

const extractor = new FrameExtractor({ ffmpegBin: "ffmpeg", rtspBase: go2rtc.rtspBase });
const frames = await extractor.extract("camera_1", { fps: 1, width: 1280, durationSec: 5 });
```

## API

### Core Classes

| Export | Description |
|--------|-------------|
| `Go2rtcManager` | Start/stop go2rtc, add/remove streams via API |
| `SourceManager` | Persist and manage camera source configs on disk |
| `RecordManager` | FFmpeg recording with per-camera FIFO quota |
| `FrameExtractor` | Extract JPEG frames from RTSP streams via FFmpeg |
| `AudioExtractor` | Extract PCM audio from RTSP streams for STT |
| `MotionFilter` | Pixel-diff motion detection between frames |
| `SileroVad` | Voice Activity Detection via sherpa-onnx-node |
| `CamPipeline` | High-level pipeline orchestrating capture + segmentation |

### Segmenters

| Export | Description |
|--------|-------------|
| `FixedWindowSegmenter` | Cut segments at fixed time intervals |
| `MotionSegmenter` | Cut on motion start/stop transitions |
| `VADSegmenter` | Cut on speech activity boundaries |
| `CompositeSegmenter` | Chain multiple segmenters (motion + VAD) |

### OpenClaw Plugin

The default export registers as an OpenClaw plugin with the `reflectworld_cam` tool, supporting actions: `add_source`, `list_sources`, `remove_source`, `snapshot`, `watch`, `stop_watch`, `set_sampling`, `switch_mode`, `live_view`, `list_recordings`.

## See Also

- [Architecture overview](../../docs/architecture/overview.md)
- [Dashboard guide](../../docs/user-guide/dashboard.md)
