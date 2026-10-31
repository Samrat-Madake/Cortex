import type { OpenClawPluginApi, Segment, PerceptionResult } from "@reflectworld/shared";
import { CamToolSchema } from "./src/schema.js";
import { executeCamAction, setWatchPersistDir, loadPersistedWatchStates, _resetActiveWatches } from "./src/tool.js";
import { SourceManager } from "./src/source-manager.js";
import { resolveCamConfig } from "./src/config.js";
import { Go2rtcManager } from "./src/go2rtc-manager.js";
import { RecordManager } from "./src/record-manager.js";
import { FrameExtractor } from "./src/frame-extractor.js";
import { AudioExtractor } from "./src/audio-extractor.js";
import { SileroVad } from "./src/silero-vad.js";
import { getSileroVadModelPath, resolveFfmpegBin, resolveFfprobeBin, resolveGo2rtcBin } from "./src/binary-installer.js";
import { toGo2rtcSource } from "./src/detect-protocol.js";
import type { CamToolDeps } from "./src/tool.js";
import type { FrameResult } from "./src/types.js";
import { join } from "node:path";

export default {
  id: "reflectworld-cam",
  name: "ReflectWorld Cam v3",
  description: "Video source management via go2rtc — snapshot, watch (event/stream), record",

  register(api: OpenClawPluginApi) {
    // Deferred init: resolved on first tool call or service start
    let deps: CamToolDeps | null = null;
    let initPromise: Promise<CamToolDeps> | null = null;

    const rawConfig = api.pluginConfig as Record<string, unknown> | undefined;
    const configString = (key: string): string | undefined => {
      const value = rawConfig?.[key];
      return typeof value === "string" && value.trim() ? value.trim() : undefined;
    };
    const onSegment = rawConfig?.onSegment as
      | ((segment: Segment) => Promise<PerceptionResult | null> | void)
      | undefined;
    const onFrameProcessed = rawConfig?.onFrameProcessed as
      | ((frame: FrameResult, cameraId: string, motionHint: { has_motion: boolean; last_motion_at: number; last_still_at: number }) => void | Promise<void>)
      | undefined;
    const shouldUseFullRate = rawConfig?.shouldUseFullRate as
      | ((cameraId: string) => boolean)
      | undefined;
    const waitForCameraIdle = rawConfig?.waitForCameraIdle as
      | ((cameraId: string) => Promise<void>)
      | undefined;

    function ensureInit(): Promise<CamToolDeps> {
      if (deps) return Promise.resolve(deps);
      if (initPromise) return initPromise;
      initPromise = (async () => {
        const config = resolveCamConfig({
          go2rtc_bin: configString("go2rtc_bin") ?? resolveGo2rtcBin(),
          ffmpeg_bin: configString("ffmpeg_bin") ?? resolveFfmpegBin(),
          ffprobe_bin: configString("ffprobe_bin") ?? resolveFfprobeBin(undefined, configString("ffmpeg_bin")),
          silero_vad_model: configString("silero_vad_model") ?? getSileroVadModelPath(),
          ...api.pluginConfig,
        });
        const home = process.env.HOME ?? "";
        const sourceManager = new SourceManager(config.sources_dir.replace("~", home));

        const go2rtc = new Go2rtcManager({
          binPath: config.go2rtc_bin,
          apiPort: config.go2rtc_api_port,
          rtspPort: config.go2rtc_rtsp_port,
          webrtcPort: config.go2rtc_webrtc_port,
          listenAddr: config.go2rtc_listen_addr,
          reuseExternal: config.go2rtc_reuse_external,
          onWarning: (message) => api.logger.warn(message),
          configDir: join(api.runtime.state.resolveStateDir(), "go2rtc"),
        });

        const mediaDir = (rawConfig?.mediaDir as string | undefined)?.replace("~", home);
        const recordManager = new RecordManager({
          ffmpegBin: config.ffmpeg_bin,
          rtspBase: go2rtc.rtspBase,
          outputDir: config.recordings_dir.replace("~", home),
          quotaPerCameraMB: config.recording_quota_mb,
          mediaDir,
        });

        const frameExtractor = new FrameExtractor({
          ffmpegBin: config.ffmpeg_bin,
          rtspBase: go2rtc.rtspBase,
        });

        const audioExtractor = new AudioExtractor({
          ffmpegBin: config.ffmpeg_bin,
          rtspBase: go2rtc.rtspBase,
        });

        // Initialize Silero VAD (graceful: if ONNX model or runtime missing, VAD is simply disabled)
        let sileroVad: SileroVad | undefined;
        if (config.vad_enabled && config.silero_vad_model) {
          const vad = new SileroVad({
            modelPath: config.silero_vad_model,
            threshold: config.vad_threshold,
            minSilenceDuration: config.vad_min_silence_duration,
            minSpeechDuration: config.vad_min_speech_duration,
            windowSize: config.vad_window_size,
            bufferSizeSec: config.vad_buffer_size_sec,
          });
          const ok = await vad.init();
          if (ok) {
            sileroVad = vad;
            api.logger.info("[cam] Silero VAD initialized successfully");
          } else {
            api.logger.warn(`[MODEL WARNING] Silero VAD unavailable for ${config.silero_vad_model}; VAD segmenter disabled.`);
          }
        }

        const watchDir = config.sources_dir.replace("~", home).replace(/sources\/?$/, "watches");
        setWatchPersistDir(watchDir);

        deps = {
          sourceManager,
          go2rtc,
          recordManager,
          frameExtractor,
          audioExtractor,
          sileroVad,
          config,
          onSegment,
          onFrameProcessed,
          shouldUseFullRate,
          waitForCameraIdle,
        };

        // Expose cam action executor to orchestrator (for VisionController)
        const onCamReady = rawConfig?.onCamReady as
          | ((executor: (action: string, params: Record<string, unknown>) => Promise<string>) => void)
          | undefined;
        if (onCamReady) {
          onCamReady((action, params) => executeCamAction(action as any, params, deps!));
        }

        return deps;
      })();
      return initPromise;
    }

    // Register go2rtc as a managed service
    api.registerService({
      id: "go2rtc",
      async start() {
        const d = await ensureInit();
        await d.go2rtc.start();
        api.logger.info(`[cam] go2rtc ${d.go2rtc.mode === "external" ? "reused external instance" : "started as managed service"}`);

        // Restore persisted sources into go2rtc (all via API, no config restart)
        for (const source of d.sourceManager.listSources()) {
          if (source.protocol === "phone") continue;
          const go2rtcSource = toGo2rtcSource(source.input, source.protocol);
          const sources = go2rtcSource ? [go2rtcSource] : [];
          d.go2rtc.addStream(source.id, sources).catch(() => {});
        }

        // Auto-restore persisted watch sessions unless the embedding runtime is
        // intentionally ephemeral, such as the isolated Dashboard demo server.
        if (d.config?.restore_watches !== false) {
          const watchStates = loadPersistedWatchStates();
          for (const ws of watchStates) {
            const source = d.sourceManager.getSource(ws.id);
            if (!source) continue;
            api.logger.info(`[cam] Auto-restoring watch: ${source.name} (${ws.id}, mode=${ws.mode})`);
            executeCamAction("watch", {
              name: ws.id,
              mode: ws.mode,
              fps: ws.fps,
              width: ws.width,
              height: ws.height,
              _minSegmentDurationMs: ws.minSegmentDurationMs,
              _initialSegmentDurationMs: ws.initialSegmentDurationMs,
              _sessionKey: ws.sessionKey,
              _notifyPolicy: ws.notifyPolicy,
            }, d).catch((err) => {
              api.logger.error(`[cam] Failed to restore watch ${ws.id}: ${err instanceof Error ? err.message : err}`);
            });
          }
        } else {
          api.logger.info("[cam] Watch auto-restore disabled");
        }
      },
      async stop() {
        if (!deps) return;
        deps.audioExtractor?.stopAll();
        deps.frameExtractor.stopAll();
        deps.recordManager.stopAll();
        _resetActiveWatches();
        await deps.go2rtc.stop();
      },
    });

    // ToolFactory: captures ctx.sessionKey so watch can store the originating channel
    api.registerTool((ctx) => ({
      name: "reflectworld_cam",
      description: `Camera control tool. You MUST call this tool to interact with cameras — never pretend you did.

Actions:
- add_source: Register a new camera. Params: source (required), name (optional). Returns: source config. Source types: 'phone' (mobile phone camera), 'webcam' (computer camera) — both use WebRTC via browser URL; RTSP URL, HTTP URL, or file path — direct ingestion. For phone/webcam sources, returns phone_setup with nodeUrl and qrImagePath — tell the user the link to open in a browser (on phone or computer) and offer the QR code if they want.
- list_sources: List all registered cameras. No params needed.
- remove_source: Remove a camera and stop all its activities. Params: name (required).
- snapshot: Take a photo and analyze it. Params: name (required). Use for "take a look" / "what do you see?"
- watch: Start background monitoring. Params: name (required), mode (set automatically — do NOT ask user). Use for continuous monitoring or motion alerts.
- stop_watch: Stop monitoring. Params: name (required). Returns list of recorded files.
- set_sampling: Change fps or resolution on an active watch without restarting. Params: name (required), fps/width/height (optional, only set what changes).
- switch_mode: Switch between event and stream mode on an active watch without restarting. Params: name (required), mode ("event" or "stream"). Use when the user's activity changes (e.g. from idle monitoring to active observation).
- live_view: Get a browser URL to watch a camera's live stream in real-time. Params: name (required). Use when user says "show me the camera", "let me see the live feed", "I want to watch", etc. Returns a clickable link the user opens in their browser.
- list_recordings: List recorded files. Params: name (required).

CRITICAL — After adding a source, present exactly 3 choices to the user:
1. "Take a quick look" → action: snapshot
2. "Alert me on motion" → action: watch, mode: event
3. "Watch continuously" → action: watch, mode: stream

Do NOT proactively show technical parameters (fps, duration, width, height) to the user. They have sensible defaults. But if the user explicitly asks (e.g. "set fps to 5", "use 4K", "watch for 10 minutes"), honor their request by setting the corresponding parameter.

Common errors:
- Source not found → call list_sources to see available cameras
- Already watching → camera is already being monitored, no action needed
- Watch failed → camera may be offline, suggest checking the connection`,
      parameters: CamToolSchema,
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const d = await ensureInit();
        const action = params.action as string;
        // Inject session key so watch persists the originating channel for notification routing
        return executeCamAction(action as any, { ...params, _sessionKey: ctx?.sessionKey }, d);
      },
    }));
  },
};

// ── v1 exports ──
export { SourceManager, toSlug } from "./src/source-manager.js";
export { FFmpegSource } from "./src/sources/ffmpeg.js";
export { HTTPSource } from "./src/sources/http.js";
export { PhoneSource, checkClawcamInstalled } from "./src/sources/phone.js";
export type { DeviceInfo, PhoneStreamInfo } from "./src/sources/phone.js";
export type { Source } from "./src/sources/types.js";
export { WatchWorkerManager } from "./src/watch-worker.js";
export { resolveCamConfig, CamConfigSchema } from "./src/config.js";
export type { CamConfig } from "./src/config.js";
export { executeCamAction, logSourceSecurityEnvWarningsOnce, updateWatchState, loadActiveWatchStates, loadPersistedWatchStates } from "./src/tool.js";
export type { CamToolDeps, NotifyPolicy, PersistedWatchState } from "./src/tool.js";
export { sourceSecurityEnvWarnings } from "./src/source-security.js";

// ── v2 exports ──
export { CamPipeline } from "./src/pipeline.js";
export type { PipelineConfig, PipelineDeps } from "./src/pipeline.js";
export { buildSegment } from "./src/segment-builder.js";
export type { BuildSegmentOptions } from "./src/segment-builder.js";
export {
  FixedWindowSegmenter,
  MotionSegmenter,
  VADSegmenter,
  CompositeSegmenter,
  createSegmenterChain,
} from "./src/segmenter/index.js";
export type { Segmenter, CutSignal, SegmenterHints } from "./src/segmenter/index.js";
export type { VADSegmenterOptions, CompositeSegmenterOptions } from "./src/segmenter/index.js";

// ── v3 exports ──
export { Go2rtcManager } from "./src/go2rtc-manager.js";
export type { Go2rtcManagerOptions } from "./src/go2rtc-manager.js";
export { RecordManager } from "./src/record-manager.js";
export type { RecordManagerOptions } from "./src/record-manager.js";
export { FrameExtractor, splitJpegFrames, splitJpegFramesWithRemainder } from "./src/frame-extractor.js";
export type { FrameExtractorOptions, ExtractionOptions } from "./src/frame-extractor.js";
export { MotionFilter } from "./src/motion-filter.js";
export type { MotionFilterOptions, MotionDetectResult } from "./src/motion-filter.js";
export { setupBinaries, setupFfmpeg, resolveBinaries, resolveFfmpegBin, resolveFfprobeBin, resolveGo2rtcBin, getSileroVadModelPath, getGo2rtcDownload, getGo2rtcUrl, getFfmpegStrategy } from "./src/binary-installer.js";
export { toGo2rtcSource, isLocalDevice } from "./src/detect-protocol.js";
export { LocalDeviceSource } from "./src/sources/local-device.js";
export { AudioExtractor } from "./src/audio-extractor.js";
export type { AudioExtractorOptions, AudioExtractionOptions } from "./src/audio-extractor.js";
export {
  LocalFileMediaSource,
  buildFfprobeArgs,
  buildLocalFileMediaArgs,
  parseFfprobeMediaInfo,
} from "./src/local-file-media-source.js";
export type {
  AudioChunk,
  LocalFileMediaSourceOptions,
  LocalFilePacing,
  MediaProbeInfo,
  VideoFrame,
} from "./src/local-file-media-source.js";
export { SileroVad, VAD_CHUNK_SIZE } from "./src/silero-vad.js";
export type { SileroVadOptions, SpeechSegment, VadFeedResult } from "./src/silero-vad.js";
export { AsyncQueue } from "./src/async-queue.js";
