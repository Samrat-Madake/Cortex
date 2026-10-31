import { monitorBus } from "@reflectworld/shared";
import type { Segment, PerceptionResult, MotionHint } from "@reflectworld/shared";
import type { CamAction, FrameResult } from "./types.js";
import type { SourceManager } from "./source-manager.js";
import type { CamConfig } from "./config.js";
import type { Go2rtcManager } from "./go2rtc-manager.js";
import { toRtspSafeName } from "./go2rtc-manager.js";
import type { RecordManager, RecordingFile } from "./record-manager.js";
import type { FrameExtractor } from "./frame-extractor.js";
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { resolveReflectWorldStateDir, canonicalize } from "@reflectworld/shared";
import { MotionFilter } from "./motion-filter.js";
import { AudioExtractor } from "./audio-extractor.js";
import { LocalFileMediaSource, type AudioChunk, type VideoFrame } from "./local-file-media-source.js";
import { LiveMediaSource, type LiveAudioChunk, type LiveVideoFrame } from "./live-media-source.js";
import { SileroVad, VAD_CHUNK_SIZE } from "./silero-vad.js";
import { PhoneSource } from "./sources/phone.js";
import { LocalDeviceSource } from "./sources/local-device.js";
import { toGo2rtcSource, isLocalDevice } from "./detect-protocol.js";
import { defaultSourceSecurityOptions, shouldUseStrictSourceValidation, sourceSecurityEnvWarnings, validateSourceInputSecurity } from "./source-security.js";
import { CamPipeline } from "./pipeline.js";
import { buildSegment } from "./segment-builder.js";
import { createSegmenterChain } from "./segmenter/index.js";
import { writeStderr } from "@reflectworld/shared";
import { networkInterfaces } from "node:os";
import QRCode from "qrcode";

export interface CamLogger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

const defaultLogger: CamLogger = {
  info: (msg, ...args) => writeStderr(`[cam] ${msg}`, ...args),
  warn: (msg, ...args) => writeStderr(`[cam:warn] ${msg}`, ...args),
  error: (msg, ...args) => writeStderr(`[cam:error] ${msg}`, ...args),
};

const LOCAL_MEDIA_FILE_RE = /\.(mp4|avi|mkv|mov|webm|flv|ts|m3u8|mpg|mpeg)$/i;
const LIVE_UNIFIED_RESTART_MAX_ATTEMPTS = 5;
const LIVE_UNIFIED_RESTART_INITIAL_DELAY_MS = 1_000;
const LIVE_UNIFIED_RESTART_MAX_DELAY_MS = 30_000;

export interface CamToolDeps {
  sourceManager: SourceManager;
  go2rtc: Go2rtcManager;
  recordManager: RecordManager;
  frameExtractor: FrameExtractor;
  audioExtractor?: AudioExtractor;
  sileroVad?: SileroVad;
  config?: CamConfig;
  logger?: CamLogger;
  /** Injected by @reflectworld/reflectworld to wire Cam → Perception → Memory → Act. */
  onSegment?: (segment: Segment) => Promise<PerceptionResult | null> | void;
  /** Optional runtime drain hook used by local-file EOF and mode switches. */
  waitForCameraIdle?: (cameraId: string) => Promise<void>;
  /** Injected by @reflectworld/reflectworld for per-frame detection + VisionController frame policy. */
  onFrameProcessed?: (
    frame: FrameResult,
    cameraId: string,
    motionHint: { has_motion: boolean; last_motion_at: number; last_still_at: number },
    vadHint?: { has_voice: boolean },
    context?: { input_mode: "local_file" | "live_stream" },
  ) => void | Promise<void>;
  /** Optional per-camera full-rate requirement. */
  shouldUseFullRate?: (cameraId: string) => boolean;
  /** Optional test/embedding hook for local-file unified media input. */
  createLocalFileMediaSource?: (options: ConstructorParameters<typeof LocalFileMediaSource>[0]) => Pick<LocalFileMediaSource, "start" | "close">;
  /** Optional test/embedding hook for live unified media input. */
  createLiveMediaSource?: (options: ConstructorParameters<typeof LiveMediaSource>[0]) => Pick<LiveMediaSource, "start" | "close">;
}

type UnifiedMediaSource = Pick<LocalFileMediaSource | LiveMediaSource, "start" | "close">;

interface WatchEntry {
  pipeline: CamPipeline;
  motionFilter?: MotionFilter;
  phoneSource?: PhoneSource;
  /** Set to true if audio extraction is running for this watch. */
  hasAudio?: boolean;
  /** Mutable ref so onFrame closure can read current mode without re-binding. */
  modeRef: { current: "event" | "stream" };
  /** Original fps before event-mode capping. Used to restore fps on switch to stream. */
  originalFps: number;
  /** Per-watch VAD state. Never feed multiple sources through one VAD instance. */
  vad?: SileroVad;
  /** Accumulated PCM bytes not yet consumed by VAD. Shared with doStopWatch for tail flush. */
  pcmAccum: Buffer;
  vadDebug?: {
    chunks: number;
    speakingChunks: number;
    silentChunks: number;
    completedSegments: number;
    currentSpeakingRun: number;
    currentSilentRun: number;
    maxSpeakingRun: number;
    maxSilentRun: number;
    lastChunkTimestampMs: number;
  };
  /** Unified media input source for local files or live streams. */
  mediaSource?: UnifiedMediaSource;
  /** Current sampling params for unified media sources. */
  mediaSampling?: { fps: number; width: number; height: number; fullRate: boolean };
  /** Live unified media sources can be restarted in-place for dynamic sampling changes. */
  updateMediaSampling?: (next: { fps: number; width: number; height: number; fullRate: boolean }) => void;
  /** Auto-stop timer for duration-limited watches; cleared on explicit stop/remove. */
  autoStopTimer?: ReturnType<typeof setTimeout>;
  /** Pending live unified restart timer after an unexpected ffmpeg exit. */
  liveRestartTimer?: ReturnType<typeof setTimeout>;
  /** Current full-rate processing mode; set_sampling can update it after watch start. */
  fullRateRef?: { current: boolean };
  /** Timestamp for the first byte in pcmAccum on the active media timeline. */
  pcmAccumStartTimestampMs?: number;
  /** Prevent local-file EOF callbacks from re-entering stop while an explicit stop is in progress. */
  stopping?: boolean;
}

// All maps keyed by source id (ASCII-safe)
const activeWatches = new Map<string, WatchEntry>();
const activePhoneSources = new Map<string, PhoneSource>();
const activeLocalDevices = new Map<string, LocalDeviceSource>();
let sourceSecurityWarningsLogged = false;

export function logSourceSecurityEnvWarningsOnce(logger: CamLogger): void {
  if (sourceSecurityWarningsLogged) return;
  const warnings = sourceSecurityEnvWarnings();
  if (warnings.length === 0) return;
  sourceSecurityWarningsLogged = true;
  for (const warning of warnings) {
    logger.warn(`[source-security] ${warning}`);
  }
}

function createVadDebug(): NonNullable<WatchEntry["vadDebug"]> {
  return {
    chunks: 0,
    speakingChunks: 0,
    silentChunks: 0,
    completedSegments: 0,
    currentSpeakingRun: 0,
    currentSilentRun: 0,
    maxSpeakingRun: 0,
    maxSilentRun: 0,
    lastChunkTimestampMs: 0,
  };
}

// ── Watch state persistence ──

export type NotifyPolicy = "always" | "smart" | "security_only";

export interface PersistedWatchState {
  id: string;
  mode: "event" | "stream";
  fps?: number;
  width?: number;
  height?: number;
  /** Optional per-watch segment duration floor, used by Dashboard/demo watches. */
  minSegmentDurationMs?: number;
  /** Optional per-watch first segment cut, used by Dashboard/demo watches. */
  initialSegmentDurationMs?: number;
  /** Session key of the originating channel (for notification routing) */
  sessionKey?: string;
  /** Notification policy: always (every segment), smart (VLM decides), security_only */
  notifyPolicy?: NotifyPolicy;
}

let watchPersistDir: string | null = null;
let watchStateCache = new Map<string, PersistedWatchState>();
let watchStateCacheLoaded = false;

export function setWatchPersistDir(dir: string): void {
  watchPersistDir = dir;
  watchStateCache = new Map<string, PersistedWatchState>();
  watchStateCacheLoaded = false;
}

function saveWatchState(state: PersistedWatchState): void {
  if (!watchPersistDir) return;
  if (!watchStateCacheLoaded) loadWatchStateCache();
  if (!existsSync(watchPersistDir)) mkdirSync(watchPersistDir, { recursive: true });
  watchStateCache.set(state.id, { ...state });
  watchStateCacheLoaded = true;
  writeFileSync(join(watchPersistDir, `${state.id}.json`), JSON.stringify(state, null, 2));
}

function removeWatchState(id: string): void {
  if (!watchPersistDir) return;
  watchStateCache.delete(id);
  const filepath = join(watchPersistDir, `${id}.json`);
  if (existsSync(filepath)) unlinkSync(filepath);
}

function loadWatchStateCache(): void {
  watchStateCache = new Map<string, PersistedWatchState>();
  watchStateCacheLoaded = true;
  if (!watchPersistDir || !existsSync(watchPersistDir)) return;
  for (const file of readdirSync(watchPersistDir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const data = JSON.parse(readFileSync(join(watchPersistDir, file), "utf-8")) as PersistedWatchState;
      if (data.id) watchStateCache.set(data.id, data);
    } catch {
      // Skip corrupt watch state files.
    }
  }
}

function ensureWatchStateCache(): void {
  if (!watchStateCacheLoaded) loadWatchStateCache();
}

export function updateWatchState(id: string, update: Partial<PersistedWatchState>): boolean {
  if (!watchPersistDir) return false;
  ensureWatchStateCache();
  const data = watchStateCache.get(id);
  if (!data) return false;
  saveWatchState({ ...data, ...update, id });
  return true;
}

export function loadPersistedWatchStates(): PersistedWatchState[] {
  if (!watchPersistDir) return [];
  ensureWatchStateCache();
  return Array.from(watchStateCache.values(), (state) => ({ ...state }));
}

export function loadActiveWatchStates(): PersistedWatchState[] {
  return loadPersistedWatchStates().filter((state) => activeWatches.has(state.id));
}

function clearWatchAutoStopTimer(watch: WatchEntry | undefined): void {
  if (!watch?.autoStopTimer) return;
  clearTimeout(watch.autoStopTimer);
  watch.autoStopTimer = undefined;
}

function clearWatchLiveRestartTimer(watch: WatchEntry | undefined): void {
  if (!watch?.liveRestartTimer) return;
  clearTimeout(watch.liveRestartTimer);
  watch.liveRestartTimer = undefined;
}

export async function executeCamAction(
  action: CamAction,
  params: Record<string, unknown>,
  deps: CamToolDeps,
): Promise<string> {
  let result: string;
  switch (action) {
    case "add_source": result = await handleAddSource(params, deps); break;
    case "list_sources": result = handleListSources(deps); break;
    case "remove_source": result = await handleRemoveSource(params, deps); break;
    case "snapshot": result = await handleSnapshot(params, deps); break;
    case "watch": result = await handleWatch(params, deps); break;
    case "stop_watch": result = await handleStopWatch(params, deps); break;
    case "set_sampling": result = handleSetSampling(params, deps); break;
    case "live_view": result = handleLiveView(params, deps); break;
    case "list_recordings": result = handleListRecordings(params, deps); break;
    case "switch_mode": result = await handleSwitchMode(params, deps); break;
    case "save_reference": result = await handleSaveReference(params, deps); break;
    default:
      result = JSON.stringify({ error: `Unknown action: ${action}` });
  }

  const parsed = tryParseJson(result);
  const resolvedCameraId = resolveCameraIdForToolEvent(action, params, deps, parsed);
  const success = !(parsed && typeof parsed === "object" && "error" in parsed);
  monitorBus.publish("system:tool_invoked", {
    tool: "reflectworld_cam",
    action,
    success,
    camera_id: resolvedCameraId,
    ...buildToolEventDetails(action, params),
  }, resolvedCameraId);

  return result;
}

/** Resolve user-provided name/id to source id. Returns error JSON string if not found. */
function resolveSourceId(nameOrId: string, deps: CamToolDeps): string | null {
  return deps.sourceManager.resolveId(nameOrId);
}

function sourceNotFound(nameOrId: string): string {
  return JSON.stringify({ error: `Source "${nameOrId}" not found. Use list_sources to see available cameras.` });
}

function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isLocalMediaFile(input: string): boolean {
  return (
    LOCAL_MEDIA_FILE_RE.test(input) &&
    (input.startsWith("/") || input.startsWith("./") || !!input.match(/^[A-Z]:\\/))
  );
}

function resolveCameraIdForToolEvent(
  action: CamAction,
  params: Record<string, unknown>,
  deps: CamToolDeps,
  parsed: Record<string, unknown> | null,
): string | undefined {
  if (typeof parsed?.source_id === "string") return parsed.source_id;
  if (typeof params.name === "string") {
    return resolveSourceId(params.name, deps) ?? params.name;
  }
  if (action === "add_source" && parsed?.source && typeof parsed.source === "object") {
    const source = parsed.source as Record<string, unknown>;
    if (typeof source.id === "string") return source.id;
  }
  return undefined;
}

function buildToolEventDetails(action: string, params: Record<string, unknown>): Record<string, unknown> {
  switch (action) {
    case "set_sampling":
      return {
        fps: typeof params.fps === "number" ? params.fps : undefined,
        width: typeof params.width === "number" ? params.width : undefined,
        height: typeof params.height === "number" ? params.height : undefined,
      };
    case "switch_mode":
      return {
        mode: typeof params.mode === "string" ? params.mode : undefined,
      };
    case "watch":
      return {
        mode: typeof params.mode === "string" ? params.mode : undefined,
        fps: typeof params.fps === "number" ? params.fps : undefined,
      };
    case "stop_watch":
      return {
        name: typeof params.name === "string" ? params.name : undefined,
      };
    default:
      return {};
  }
}

// ── Source management ──

async function handleAddSource(params: Record<string, unknown>, deps: CamToolDeps): Promise<string> {
  const input = params.source as string;
  const name = params.name as string | undefined;
  logSourceSecurityEnvWarningsOnce(deps.logger ?? defaultLogger);
  const strictSourceValidation = shouldUseStrictSourceValidation(params);
  const validation = await validateSourceInputSecurity(
    input,
    defaultSourceSecurityOptions(strictSourceValidation, params),
  );
  if (!validation.ok) {
    return JSON.stringify({ success: false, error: validation.error, code: validation.code });
  }
  const dashboardUserId = typeof params._dashboardUserId === "string" && params._dashboardUserId.trim()
    ? params._dashboardUserId.trim()
    : undefined;
  const dashboardSessionId = typeof params._dashboardSessionId === "string" && params._dashboardSessionId.trim()
    ? params._dashboardSessionId.trim()
    : undefined;
  const sourceId = typeof params._sourceId === "string" && params._sourceId.trim()
    ? params._sourceId.trim()
    : undefined;
  const config = deps.sourceManager.addSource(input, name, {
    ...(sourceId ? { id: sourceId } : {}),
    ...(dashboardUserId ? { dashboard_user_id: dashboardUserId } : {}),
    ...(dashboardSessionId ? { dashboard_session_id: dashboardSessionId } : {}),
  });

  if (config.protocol === "phone") {
    const phoneSource = new PhoneSource(config.id);
    activePhoneSources.set(config.id, phoneSource);
    try {
      const existingDevice = phoneSource.getDeviceInfo();
      const deviceInfo = existingDevice ?? phoneSource.createDevice();
      // Save QR code as PNG file so agent can attach it in chat
      let qrFilePath: string | undefined;
      try {
        const qrDir = join(deps.config?.recordings_dir ?? resolveReflectWorldStateDir(), "qrcodes");
        if (!existsSync(qrDir)) mkdirSync(qrDir, { recursive: true });
        qrFilePath = join(qrDir, `${config.id}_setup.png`);
        await QRCode.toFile(qrFilePath, deviceInfo.nodeUrl, { width: 256, margin: 2 });
      } catch { /* non-fatal */ }
      return JSON.stringify({
        success: true,
        source: config,
        phone_setup: {
          nodeUrl: deviceInfo.nodeUrl,
          qrImagePath: qrFilePath,
          message: existingDevice
            ? `Device "${config.name}" already exists in clawcam. Reusing the existing web camera link.`
            : "Tell the user: here is the link to open on your phone. Also mention you have a QR code image if they prefer to scan — send it only if they ask.",
        },
      });
    } catch (err) {
      return JSON.stringify({ success: true, source: config, phone_setup: { error: err instanceof Error ? err.message : String(err) } });
    }
  }

  // Register stream in go2rtc using source id
  const go2rtcSource = toGo2rtcSource(config.input, config.protocol);
  const sources = go2rtcSource ? [go2rtcSource] : [];
  deps.go2rtc.addStream(config.id, sources).catch(() => {});

  monitorBus.publish("cam:source_added", {
    name: config.name,
    id: config.id,
    protocol: config.protocol,
    input: config.input,
    ...(config.dashboard_user_id ? { user_id: config.dashboard_user_id } : {}),
    ...(config.dashboard_session_id ? { session_id: config.dashboard_session_id } : {}),
  }, config.id);

  return JSON.stringify({ success: true, source: config });
}

function handleListSources(deps: CamToolDeps): string {
  return JSON.stringify({ sources: deps.sourceManager.listSources() });
}

async function handleRemoveSource(params: Record<string, unknown>, deps: CamToolDeps): Promise<string> {
  const id = resolveSourceId(params.name as string, deps);
  if (!id) return sourceNotFound(params.name as string);
  const log = deps.logger ?? defaultLogger;
  const watch = activeWatches.get(id);
  const source = deps.sourceManager.getSource(id);

  if (watch) {
    try {
      await doStopWatch(id, deps);
    } catch (err) {
      log.error(`[remove_source] watch cleanup failed for "${id}": ${err instanceof Error ? err.message : String(err)}`);
      try { watch.mediaSource?.close(); } catch { /* best-effort */ }
      try { deps.frameExtractor.stopExtraction(id); } catch { /* best-effort */ }
      try { deps.recordManager.stopRecording(id); } catch { /* best-effort */ }
      try { watch.phoneSource?.stopStream(); } catch { /* best-effort */ }
      try { await watch.vad?.dispose(); } catch { /* best-effort */ }
      activeWatches.delete(id);
      removeWatchState(id);
    }
  } else {
    // Stop all active activities for non-watch sources.
    deps.frameExtractor.stopExtraction(id);
    deps.recordManager.stopRecording(id);
    removeWatchState(id);
  }
  const phone = activePhoneSources.get(id);
  if (phone) {
    phone.stopStream();
    phone.removeDevice();
    activePhoneSources.delete(id);
  }
  // Clean up clawcam device even if no active phone source
  if (source?.protocol === "phone" && !phone) {
    new PhoneSource(id).removeDevice();
  }
  // Remove QR code image
  if (source?.protocol === "phone") {
    const qrPath = join(deps.config?.recordings_dir ?? resolveReflectWorldStateDir(), "qrcodes", `${id}_setup.png`);
    try { if (existsSync(qrPath)) unlinkSync(qrPath); } catch { /* best-effort */ }
  }
  const localDev = activeLocalDevices.get(id);
  if (localDev) {
    localDev.stop();
    activeLocalDevices.delete(id);
  }
  deps.go2rtc.removeStream(id).catch(() => {});
  const removed = deps.sourceManager.removeSource(id);

  monitorBus.publish("cam:source_removed", {
    id,
    ...(source?.dashboard_user_id ? { user_id: source.dashboard_user_id } : {}),
    ...(source?.dashboard_session_id ? { session_id: source.dashboard_session_id } : {}),
  }, id);

  return JSON.stringify({ success: removed });
}

// ── Snapshot: single frame → Perception → return result ──

async function handleSnapshot(params: Record<string, unknown>, deps: CamToolDeps): Promise<string> {
  const id = resolveSourceId(params.name as string, deps);
  if (!id) return sourceNotFound(params.name as string);
  const cfg = deps.sourceManager.getSource(id)!;

  const width = params.width as number | undefined;
  const height = params.height as number | undefined;

  try {
    let frame: FrameResult;
    if (cfg.protocol === "phone") {
      const phoneSource = activePhoneSources.get(id) ?? new PhoneSource(id);
      frame = await phoneSource.snapshot({
        quality: 85,
        resolution: { width: width ?? 960, height: height ?? 540 },
      });
    } else {
      // For local devices, ensure ffmpeg is pushing to go2rtc before capturing
      if (isLocalDevice(cfg.input) && !activeLocalDevices.has(id)) {
        const ffmpegBin = deps.config?.ffmpeg_bin ?? "ffmpeg";
        const localDev = new LocalDeviceSource(id, {
          ffmpegBin,
          rtspBase: deps.go2rtc.rtspBase,
          width: width ?? 960,
          height: height ?? 540,
        });
        await localDev.start(cfg.input);
        activeLocalDevices.set(id, localDev);
      }
      const buffer = await deps.go2rtc.captureFrame(id, width, height);
      frame = { data: buffer.toString("base64"), timestamp: Date.now(), source_name: id };
    }

    // Stop local device after snapshot (avoid leaking ffmpeg process)
    const snapshotLocalDev = activeLocalDevices.get(id);
    if (snapshotLocalDev) {
      snapshotLocalDev.stop();
      activeLocalDevices.delete(id);
    }

    // Save snapshot to disk
    const recordingsDir = deps.config?.recordings_dir ? canonicalize(deps.config.recordings_dir) : "";
    let snapshotPath = "";
    if (recordingsDir) {
      const snapDir = join(recordingsDir, id);
      if (!existsSync(snapDir)) mkdirSync(snapDir, { recursive: true });
      snapshotPath = join(snapDir, `${id}_snapshot_${frame.timestamp}.jpg`);
      writeFileSync(snapshotPath, Buffer.from(frame.data, "base64"));
    }

    // Build segment and send through Perception pipeline
    if (deps.onSegment) {
      const segment = buildSegment([frame], {
        cameraId: id,
        mode: "snapshot",
        rawUrl: snapshotPath,
      });
      const result = await deps.onSegment(segment);
      return JSON.stringify({
        source_id: id,
        source_name: cfg.name,
        timestamp: frame.timestamp,
        snapshot_path: snapshotPath,
        perception: result ?? null,
      });
    }

    // No Perception pipeline wired — return raw frame
    return JSON.stringify({ ...frame, source_id: id, source_name: cfg.name, snapshot_path: snapshotPath });
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}

// ── Watch: parallel record-to-disk + sample frames → Perception → Memory → Act ──

/** Ensure a phone source has an active ClawCam RTSP server, return stream info. */
async function ensurePhoneStream(id: string, opts?: { width?: number; height?: number; fps?: number }) {
  let phoneSource = activePhoneSources.get(id);
  if (!phoneSource) {
    phoneSource = new PhoneSource(id);
    activePhoneSources.set(id, phoneSource);
  }
  if (phoneSource.isStreaming) {
    return phoneSource.getStreamInfo()!;
  }
  return phoneSource.startStream(opts);
}

async function handleWatch(params: Record<string, unknown>, deps: CamToolDeps): Promise<string> {
  const id = resolveSourceId(params.name as string, deps);
  if (!id) return sourceNotFound(params.name as string);
  const source = deps.sourceManager.getSource(id)!;

  const mode = (params.mode as "event" | "stream") ?? "stream";
  const fps = params.fps as number | undefined;
  const width = params.width as number | undefined;
  const height = params.height as number | undefined;
  const duration = params.duration as number | undefined;
  const stopOnInputEnd = params._stopOnInputEnd === true;
  const requestedInputMode = params._inputMode === "local_file" || params._inputMode === "live_stream"
    ? params._inputMode
    : undefined;
  if (requestedInputMode === "local_file" && !isLocalMediaFile(source.input)) {
    return JSON.stringify({ error: `inputMode=local_file requires a local media file source: ${source.input}` });
  }
  const minSegmentDurationMs = typeof params._minSegmentDurationMs === "number" && Number.isFinite(params._minSegmentDurationMs)
    ? Math.max(0, params._minSegmentDurationMs)
    : undefined;
  const initialSegmentDurationMs = typeof params._initialSegmentDurationMs === "number" && Number.isFinite(params._initialSegmentDurationMs)
    ? Math.max(0, params._initialSegmentDurationMs)
    : undefined;
  const config = deps.config;
  const log = deps.logger ?? defaultLogger;
  let startedPhoneSource: PhoneSource | undefined;
  let startedLocalDevice = false;
  let watchVad: SileroVad | undefined;
  const inferredInputMode: "local_file" | "live_stream" = stopOnInputEnd && isLocalMediaFile(source.input) ? "local_file" : "live_stream";
  const inputMode: "local_file" | "live_stream" = requestedInputMode ?? inferredInputMode;
  const requestedDispatchInputMode = params._dispatchInputMode === "local_file" || params._dispatchInputMode === "live_stream"
    ? params._dispatchInputMode
    : undefined;
  const dispatchInputMode: "local_file" | "live_stream" = requestedDispatchInputMode ?? inputMode;
  const directFileInput = inputMode === "local_file" && isLocalMediaFile(source.input) ? source.input : undefined;
  const localFilePacing = params._localFilePacing === "fast" ? "fast" : "realtime";

  if (activeWatches.has(id)) return JSON.stringify({ error: `Already watching: ${source.name}` });

  try {
    const windowSize = config?.segment_window_size ?? 10;
    const enableMotion = mode === "stream";
    const vadAvailable = deps.sileroVad?.isAvailable ?? false;
    const enableVad = mode === "stream" && vadAvailable;
    watchVad = enableVad && deps.sileroVad
      ? await deps.sileroVad.createSession()
      : undefined;
    const segmenters = createSegmenterChain(windowSize, enableMotion, enableVad);

    const recordingsDir = config?.recordings_dir ? canonicalize(config.recordings_dir) : "";
    const cameraRecDir = recordingsDir ? join(recordingsDir, id) : "";

    let latestMotionHint: MotionHint = {
      has_motion: false,
      ratio: 0,
      last_motion_at: 0,
      last_still_at: Date.now(),
    };

    const baseOnSegment = deps.onSegment ?? (async () => null);
    const modeRef = { current: mode };
    const pipeline = new CamPipeline(
      {
        cameraId: id,
        mode,
        inputMode: dispatchInputMode,
        onSegment: async (segment) => {
          const watchForDebug = activeWatches.get(id);
          if (watchForDebug?.vadDebug) {
            const d = watchForDebug.vadDebug;
            log.info(
              `[watch:vad] segment=${segment.segment_id} cut=${segment.event_hint ?? ""} chunks=${d.chunks} ` +
              `speaking=${d.speakingChunks} silent=${d.silentChunks} completed=${d.completedSegments} ` +
              `max_speaking_ms=${Math.round(d.maxSpeakingRun * 32)} max_silent_ms=${Math.round(d.maxSilentRun * 32)} ` +
              `last_audio_ts=${Math.round(d.lastChunkTimestampMs)}`,
            );
            watchForDebug.vadDebug = createVadDebug();
          }
          const segmentWithHint = { ...segment, _motion_hint: latestMotionHint };
          await Promise.resolve(baseOnSegment(segmentWithHint));
          return null;
        },
        onFramePrepared: (frame, hints) => {
          return deps.onFrameProcessed?.(frame, id, {
            has_motion: hints?.hasMotion ?? latestMotionHint.has_motion,
            last_motion_at: latestMotionHint.last_motion_at,
            last_still_at: latestMotionHint.last_still_at,
          }, { has_voice: hints?.hasVoice ?? false }, { input_mode: dispatchInputMode });
        },
        rawUrl: cameraRecDir,
        ...(minSegmentDurationMs ? { minSegmentDurationMs } : {}),
        ...(initialSegmentDurationMs ? { initialSegmentDurationMs } : {}),
        audioUsesTimestampClock: true,
        recordSpeechEndVoiceRanges: true,
      },
      { storageManager: null, segmenters },
    );

    const extractFps = fps ?? config?.default_extraction_fps ?? 1;
    const extractWidth = width ?? config?.default_extraction_width ?? 960;
    const extractHeight = height ?? config?.default_extraction_height ?? 540;

    // MotionFilter: event mode uses it for recording control + segmenter hints,
    // stream mode uses it for segmenter hints only.
    const motionFilter = new MotionFilter({
      threshold: config?.motion_threshold,
      pixelThreshold: config?.motion_pixel_threshold,
      // At low fps (<=2), a single frame diff is enough to confirm motion.
      // At higher fps, require 3 consecutive frames to avoid noise.
      confirmFrames: extractFps <= 2 ? 1 : 3,
    });
    let phoneSource: PhoneSource | undefined;
    const isPhone = source.protocol === "phone";
    // ── Ensure source is consumable ──
    const isLocal = isLocalDevice(source.input);
    const fullRateRequired = deps.shouldUseFullRate?.(id) === true;
    const fullRate = fullRateRequired
      || (typeof params._fullRate === "boolean"
        ? params._fullRate
        : deps.config?.extraction_full_rate === true);
    const fullRateRef = { current: fullRate };
    log.info(`[watch] Starting watch for "${source.name}" (id=${id}, protocol=${source.protocol}, local=${isLocal}, mode=${mode})`);
    let phoneRtspUrl: string | undefined;
    if (isPhone) {
      log.info(`[watch] Starting phone RTSP stream for "${id}"...`);
      const info = await ensurePhoneStream(id, { width: extractWidth, height: extractHeight, fps: extractFps });
      phoneSource = activePhoneSources.get(id);
      startedPhoneSource = phoneSource;
      phoneRtspUrl = info.rtspUrl;
      log.info(`[watch] Phone RTSP ready: ${phoneRtspUrl}, waiting for WebRTC stream...`);
      await new Promise((r) => setTimeout(r, 3000));
      // Register phone RTSP in go2rtc so live_view / stream.html can play it.
      // ClawCam RTSP only supports UDP transport — tell go2rtc via URL fragment.
      deps.go2rtc.addStream(id, [`${phoneRtspUrl}#transport=udp`]).catch(() => {});
      log.info(`[watch] Phone stream stabilized, registered in go2rtc`);
    } else if (isLocal) {
      const ffmpegBin = config?.ffmpeg_bin ?? "ffmpeg";
      const localDev = new LocalDeviceSource(id, {
        ffmpegBin,
        rtspBase: deps.go2rtc.rtspBase,
        width: extractWidth,
        height: extractHeight,
        fps: 30,
      });
      await localDev.start(source.input);
      activeLocalDevices.set(id, localDev);
      startedLocalDevice = true;
      log.info(`[watch] Local device ffmpeg started for "${id}"`);
    }

    activeWatches.set(id, {
      pipeline,
      motionFilter,
      phoneSource,
      hasAudio: false,
      modeRef,
      originalFps: extractFps,
      fullRateRef,
      vad: watchVad,
      pcmAccum: Buffer.alloc(0),
      vadDebug: enableVad ? createVadDebug() : undefined,
    });

    // ── Audio pipeline: VAD detection (stream mode only) ──
    let latestHasVoice = false;
    const VOICE_RECENCY_MS = 2_000; // consider voice "active" if detected within 2s
    let lastVoiceDetectTime = -Infinity;
    let hasAudioRunning = false;
    const useAudioPtsClock = true; // unified media sources and legacy fallback both pass timestamps on the frame timeline.
    const normalizeAudioChunkForVideoTimeline = (
      chunk: Buffer,
      chunkStartPtsMs?: number,
    ): { chunk: Buffer; timestampMs?: number } | null => {
      if (!useAudioPtsClock || chunkStartPtsMs === undefined || chunkStartPtsMs >= 0) {
        return { chunk, timestampMs: chunkStartPtsMs };
      }
      const samples = Math.floor(chunk.length / 2);
      const durationMs = (samples / 16000) * 1000;
      const chunkEndPtsMs = chunkStartPtsMs + durationMs;
      if (chunkEndPtsMs <= 0) return null;
      const trimSamples = Math.min(samples, Math.ceil((-chunkStartPtsMs / 1000) * 16000));
      const trimmed = chunk.subarray(trimSamples * 2);
      return trimmed.length > 0 ? { chunk: trimmed, timestampMs: 0 } : null;
    };
    const processAudioChunk = async (rawChunk: Buffer, rawChunkStartPtsMs?: number): Promise<void> => {
      const entry = activeWatches.get(id);
      if (!entry) return;
      const vad = entry.vad;
      if (!vad) return;
      const normalized = normalizeAudioChunkForVideoTimeline(rawChunk, rawChunkStartPtsMs);
      if (!normalized) return;
      const { chunk, timestampMs: normalizedTimestampMs } = normalized;
      hasAudioRunning = true;
      entry.hasAudio = true;
      if (entry.pcmAccum.length === 0) {
        entry.pcmAccumStartTimestampMs = normalizedTimestampMs ?? Date.now();
      }
      entry.pcmAccum = Buffer.concat([entry.pcmAccum, chunk]);
      const chunkBytes = VAD_CHUNK_SIZE * 2;
      const pipelineOps: Array<Promise<void>> = [];
      while (entry.pcmAccum.length >= chunkBytes) {
        const vadChunk = entry.pcmAccum.subarray(0, chunkBytes);
        entry.pcmAccum = entry.pcmAccum.subarray(chunkBytes);
        const numSamples = vadChunk.length / 2;
        const float32 = new Float32Array(numSamples);
        for (let i = 0; i < numSamples; i++) {
          float32[i] = vadChunk.readInt16LE(i * 2) / 32768.0;
        }
        const result = vad.feedChunk(float32);
        const chunkTimestampMs = entry.pcmAccumStartTimestampMs ?? Date.now();
        entry.pcmAccumStartTimestampMs = chunkTimestampMs + (VAD_CHUNK_SIZE / 16000) * 1000;
        if (entry.vadDebug) {
          entry.vadDebug.chunks++;
          entry.vadDebug.completedSegments += result.segments.length;
          entry.vadDebug.lastChunkTimestampMs = chunkTimestampMs;
          if (result.isSpeaking) {
            entry.vadDebug.speakingChunks++;
            entry.vadDebug.currentSpeakingRun++;
            entry.vadDebug.currentSilentRun = 0;
            entry.vadDebug.maxSpeakingRun = Math.max(entry.vadDebug.maxSpeakingRun, entry.vadDebug.currentSpeakingRun);
          } else {
            entry.vadDebug.silentChunks++;
            entry.vadDebug.currentSilentRun++;
            entry.vadDebug.currentSpeakingRun = 0;
            entry.vadDebug.maxSilentRun = Math.max(entry.vadDebug.maxSilentRun, entry.vadDebug.currentSilentRun);
          }
        }
        if (result.isSpeaking) {
          lastVoiceDetectTime = chunkTimestampMs;
        }
        const voiceSegs = result.segments.map(s => ({ start: s.start, length: s.samples.length }));
        pipelineOps.push(pipeline.ingestAudio(vadChunk, voiceSegs, result.segments, result.isSpeaking, chunkTimestampMs));
        pipelineOps.push(pipeline.updateVoiceState(result.isSpeaking, chunkTimestampMs));
      }
      if (pipelineOps.length > 0) await Promise.all(pipelineOps);
    };
    if (enableVad && deps.sileroVad && directFileInput) {
      log.info(`[watch] Local-file unified audio + VAD enabled for "${id}"`);
    }

    // ── Event mode: motion-driven recording ──
    const motionCooldownMs = 3_000;
    const maxEventDurationMs = 30_000;
    let lastMotionTime = 0;
    let eventStartTime = 0;
    let eventVideoPath = "";
    let firstFrameEmitted = false;
    let initialSegmentFirstTs: number | null = null;
    let initialSegmentFrameWindowDone = !initialSegmentDurationMs;
    const processingFps = mode === "event" ? Math.min(extractFps, 5) : extractFps;

    // In fullRate mode: ffmpeg outputs all frames and this loop decimates them
    // before the full pipeline (motion, segmenter, YOLO, VLM).
    let lastFullProcessTs = -Infinity;

    const onFrame = (frame: FrameResult) => {
      if (!firstFrameEmitted) {
        firstFrameEmitted = true;
        monitorBus.publish("cam:first_frame", {
          camera_id: id,
          wall_ts: Date.now(),
          media_ts: frame.timestamp,
        }, id);
      }

      // fullRate mode: check if this source frame should go through the full
      // Percept pipeline.
      if (fullRateRef.current) {
        const now = frame.timestamp;
        const currentExtractorFps = directFileInput
          ? processingFps
          : activeWatches.get(id)?.mediaSampling?.fps ?? deps.frameExtractor.getExtractionOptions(id)?.fps ?? processingFps;
        const intervalMs = 1000 / Math.max(1, currentExtractorFps);
        if (now - lastFullProcessTs < intervalMs * 0.9) return;
        lastFullProcessTs = now;
      }

      // ── Full pipeline (runs at configured fps) ──
      const jpegBuffer = Buffer.from(frame.data, "base64");
      const motionTimestamp = frame.timestamp;
      const motionResult = motionFilter.detectWithRatio(jpegBuffer, motionTimestamp);
      const hasMotion = motionResult.motion;
      latestMotionHint = {
        has_motion: hasMotion,
        ratio: motionResult.ratio,
        last_motion_at: motionFilter.lastMotionAt,
        last_still_at: motionFilter.lastStillAt,
      };
      const voiceClockNow = useAudioPtsClock ? frame.timestamp : Date.now();
      latestHasVoice = hasAudioRunning && (voiceClockNow - lastVoiceDetectTime) < VOICE_RECENCY_MS;
      let feedForInitialSegment = false;
      if (!initialSegmentFrameWindowDone && initialSegmentDurationMs) {
        if (initialSegmentFirstTs === null) initialSegmentFirstTs = frame.timestamp;
        feedForInitialSegment = true;
        if (frame.timestamp - initialSegmentFirstTs >= initialSegmentDurationMs) {
          initialSegmentFrameWindowDone = true;
        }
      }

      let stopEventAfterFrame = false;
      if (modeRef.current === "event") {
        if (hasMotion) {
          monitorBus.publish("cam:motion_detected", { mode }, id);
          lastMotionTime = Date.now();
          if (!deps.recordManager.isRecording(id)) {
            eventStartTime = Date.now();
            eventVideoPath = deps.recordManager.startEventRecording(id, { maxDurationSec: 30, inputOverride: directFileInput ?? phoneRtspUrl });
          }
        }

        if (deps.recordManager.isRecording(id) && lastMotionTime > 0) {
          const elapsed = Date.now() - eventStartTime;
          const sinceMotion = Date.now() - lastMotionTime;
          const reachedMinDuration = !minSegmentDurationMs || elapsed >= minSegmentDurationMs;
          if ((sinceMotion >= motionCooldownMs && reachedMinDuration) || elapsed >= maxEventDurationMs) {
            stopEventAfterFrame = true;
          }
        }

        if (!hasMotion && !deps.recordManager.isRecording(id) && !feedForInitialSegment) return;
        if (!hasMotion && !minSegmentDurationMs && !feedForInitialSegment) {
          if (stopEventAfterFrame) {
            deps.recordManager.stopRecording(id);
            pipeline.forceFlush(eventVideoPath || undefined).catch(() => {});
            eventVideoPath = "";
          }
          return;
        }
      }

      const feedFramePromise = pipeline.feedFrame(frame, {
        hasMotion,
        motionRatio: motionResult.ratio,
        hasVoice: latestHasVoice,
      });

      const afterFeed = () => {
        if (modeRef.current === "event" && stopEventAfterFrame) {
          deps.recordManager.stopRecording(id);
          pipeline.forceFlush(eventVideoPath || undefined).catch(() => {});
          eventVideoPath = "";
        }
      };
      return feedFramePromise.then(afterFeed).catch((err) => {
        log.error(`[watch] Frame processing failed for "${id}": ${err instanceof Error ? err.message : err}`);
      });

    };

    // ── Start frame sampling ──
    // Local-file runner mode must not hot-swap ffmpeg on fps changes: seeking a
    // replacement process resets PTS and conflicts with timestamp de-duplication.
    // Decode continuously and let onFrame decimate for the current fps instead.
    log.info(
      `[watch] Starting media extraction (fps=${processingFps}, fullRate=${fullRate}, input=${directFileInput ?? phoneRtspUrl ?? "go2rtc"})`,
    );
    const startLegacyLiveExtraction = () => {
      deps.frameExtractor.startExtraction(id, {
        fps: processingFps,
        width: extractWidth,
        height: extractHeight,
        onFrame,
        inputOverride: phoneRtspUrl,
        timestampMode: "wall_clock",
        localFilePacing,
        fullRate,
      });
      if (enableVad && deps.sileroVad && deps.audioExtractor) {
        try {
          deps.audioExtractor.startExtraction(id, {
            onAudio: (chunk: Buffer) => {
              void processAudioChunk(chunk).catch((err) => {
                log.error(`[watch] Audio processing failed for "${id}": ${err instanceof Error ? err.message : err}`);
              });
            },
            inputOverride: phoneRtspUrl,
            localFilePacing,
          });
          hasAudioRunning = true;
          const watch = activeWatches.get(id);
          if (watch) watch.hasAudio = true;
          log.info(`[watch] Legacy audio extraction + VAD started for "${id}"`);
        } catch (err) {
          log.warn(`[watch] Audio extraction failed for "${id}", VAD disabled: ${err instanceof Error ? err.message : err}`);
        }
      }
    };
    if (directFileInput) {
      const localFileSource = (deps.createLocalFileMediaSource ?? ((opts) => new LocalFileMediaSource(opts)))({
        videoPath: directFileInput,
        fps: processingFps,
        pacing: localFilePacing,
        fullRate,
        maxLongEdge: Math.max(extractWidth, extractHeight),
        maxShortEdge: extractHeight,
        ffmpegBin: config?.ffmpeg_bin ?? "ffmpeg",
        ffprobeBin: config?.ffprobe_bin ?? "ffprobe",
        onVideoFrame: (frame: VideoFrame) => onFrame({
          data: frame.jpeg.toString("base64"),
          timestamp: frame.ptsMs,
          source_name: id,
        }),
        onAudioChunk: (chunk: AudioChunk) => processAudioChunk(Buffer.from(chunk.pcm), chunk.ptsMs),
      });
      const watch = activeWatches.get(id);
      if (watch) watch.mediaSource = localFileSource;
      void localFileSource.start()
        .then(async () => {
          const current = activeWatches.get(id);
          if (current && !current.stopping) await doStopWatch(id, deps);
        })
        .catch(async (err) => {
          const message = err instanceof Error ? err.message : String(err);
          log.error(`[watch] Local-file media source failed for "${id}": ${message}`);
          monitorBus.publish("cam:source_unavailable", {
            source_id: id,
            source_name: source.name,
            input: directFileInput,
            protocol: source.protocol,
            error: message,
          }, id);
          const current = activeWatches.get(id);
          if (current && !current.stopping) await doStopWatch(id, deps);
        });
    } else {
      const liveInputUrl = phoneRtspUrl ?? `${deps.go2rtc.rtspBase}/${toRtspSafeName(id)}`;
      let liveLastMediaTs = -Infinity;
      let liveTimelineFloorTs = -Infinity;
      let liveRestartAttempt = 0;
      const startLiveUnifiedMediaSource = (
        sampling: { fps: number; width: number; height: number; fullRate: boolean },
        timestampOffsetMs = Date.now(),
      ): void => {
        liveTimelineFloorTs = Math.max(liveTimelineFloorTs, timestampOffsetMs);
        let liveSource!: UnifiedMediaSource;
        const isActiveLiveSource = (): boolean => {
          const current = activeWatches.get(id);
          return Boolean(current && !current.stopping && current.mediaSource === liveSource);
        };
        const noteLiveTimestamp = (timestamp: number): void => {
          liveRestartAttempt = 0;
          liveLastMediaTs = Math.max(liveLastMediaTs, timestamp);
          liveTimelineFloorTs = Math.max(liveTimelineFloorTs, timestamp);
        };
        liveSource = (deps.createLiveMediaSource ?? ((opts) => new LiveMediaSource(opts)))({
          inputUrl: liveInputUrl,
          fps: sampling.fps,
          width: sampling.width,
          height: sampling.height,
          fullRate: sampling.fullRate,
          rtspTransport: phoneRtspUrl ? "udp" : "tcp",
          ffmpegBin: config?.ffmpeg_bin ?? "ffmpeg",
          onVideoFrame: (frame: LiveVideoFrame) => {
            if (!isActiveLiveSource()) return;
            const timestamp = frame.ptsMs + timestampOffsetMs;
            noteLiveTimestamp(timestamp);
            return onFrame({
              data: frame.jpeg.toString("base64"),
              timestamp,
              source_name: id,
            });
          },
          onAudioChunk: (chunk: LiveAudioChunk) => {
            if (!isActiveLiveSource()) return;
            const timestamp = chunk.ptsMs + timestampOffsetMs;
            noteLiveTimestamp(timestamp);
            return processAudioChunk(Buffer.from(chunk.pcm), timestamp);
          },
          onAudioUnavailable: () => {
            if (!isActiveLiveSource()) return;
            hasAudioRunning = false;
            const current = activeWatches.get(id);
            if (current) current.hasAudio = false;
            log.info(`[watch] Live source "${id}" has no audio stream; VAD disabled`);
          },
        });
        const current = activeWatches.get(id);
        if (!current || current.stopping) {
          liveSource.close();
          return;
        }
        clearWatchLiveRestartTimer(current);
        const previous = current.mediaSource;
        current.mediaSource = liveSource;
        current.mediaSampling = sampling;
        current.updateMediaSampling = (next) => {
          if (current.mediaSampling?.fullRate && next.fullRate && current.mediaSampling.width === next.width && current.mediaSampling.height === next.height) {
            current.mediaSampling = next;
            return;
          }
          const intervalMs = 1000 / Math.max(1, next.fps);
          const nextOffset = Math.max(
            Number.isFinite(liveLastMediaTs) ? liveLastMediaTs + intervalMs : Date.now(),
            Number.isFinite(liveTimelineFloorTs) ? liveTimelineFloorTs + intervalMs : -Infinity,
          );
          liveTimelineFloorTs = Math.max(liveTimelineFloorTs, nextOffset);
          startLiveUnifiedMediaSource(next, nextOffset);
        };
        hasAudioRunning = enableVad;
        current.hasAudio = enableVad;
        previous?.close();
        const fallbackToLegacyLiveExtraction = (reason: string): void => {
          const latest = activeWatches.get(id);
          if (!latest || latest.stopping || latest.mediaSource !== liveSource) return;
          log.warn(`[watch] Live unified media source ${reason} for "${id}", falling back to legacy extraction`);
          clearWatchLiveRestartTimer(latest);
          latest.mediaSource = undefined;
          latest.mediaSampling = undefined;
          latest.updateMediaSampling = undefined;
          startLegacyLiveExtraction();
        };
        const restartLiveUnifiedMediaSource = (reason: string): void => {
          const latest = activeWatches.get(id);
          if (!latest || latest.stopping || latest.mediaSource !== liveSource) return;
          if (liveRestartAttempt >= LIVE_UNIFIED_RESTART_MAX_ATTEMPTS) {
            fallbackToLegacyLiveExtraction(`${reason} after ${LIVE_UNIFIED_RESTART_MAX_ATTEMPTS} restart attempts`);
            return;
          }
          liveRestartAttempt += 1;
          const delayMs = Math.min(
            LIVE_UNIFIED_RESTART_MAX_DELAY_MS,
            LIVE_UNIFIED_RESTART_INITIAL_DELAY_MS * 2 ** (liveRestartAttempt - 1),
          );
          const latestSampling = latest.mediaSampling ?? sampling;
          const intervalMs = 1000 / Math.max(1, latestSampling.fps);
          const nextOffset = Math.max(
            Number.isFinite(liveLastMediaTs) ? liveLastMediaTs + intervalMs : Date.now() + delayMs,
            Number.isFinite(liveTimelineFloorTs) ? liveTimelineFloorTs + intervalMs : -Infinity,
          );
          liveTimelineFloorTs = Math.max(liveTimelineFloorTs, nextOffset);
          log.warn(
            `[watch] Live unified media source ${reason} for "${id}", restarting in ${delayMs}ms ` +
            `(attempt ${liveRestartAttempt}/${LIVE_UNIFIED_RESTART_MAX_ATTEMPTS})`,
          );
          monitorBus.publish("cam:source_reconnecting", {
            source_id: id,
            source_name: source.name,
            reason,
            attempt: liveRestartAttempt,
            delay_ms: delayMs,
          }, id);
          const timer = setTimeout(() => {
            const active = activeWatches.get(id);
            if (!active || active.stopping || active.mediaSource !== liveSource) return;
            active.liveRestartTimer = undefined;
            startLiveUnifiedMediaSource(latestSampling, nextOffset);
          }, delayMs);
          timer.unref?.();
          latest.liveRestartTimer = timer;
        };
        void liveSource.start()
          .then(() => {
            restartLiveUnifiedMediaSource("exited");
          })
          .catch((err) => {
            restartLiveUnifiedMediaSource(`failed: ${err instanceof Error ? err.message : err}`);
          });
      };
      startLiveUnifiedMediaSource({ fps: processingFps, width: extractWidth, height: extractHeight, fullRate });
    }

    // ── Start recording (stream mode only; event mode starts on motion) ──
    if (mode !== "event") {
      log.info(`[watch] Starting recording (input=${directFileInput ?? phoneRtspUrl ?? "go2rtc"})`);
      deps.recordManager.startRecording(id, {
        duration,
        inputOverride: directFileInput ?? phoneRtspUrl,
      });
    }

    const watch = activeWatches.get(id);
    if (watch) {
      watch.phoneSource = phoneSource;
      watch.hasAudio = hasAudioRunning;
    }
    // Persist watch state for auto-restore on restart
    const sessionKey = params._sessionKey as string | undefined;
    const notifyPolicy = (params._notifyPolicy as NotifyPolicy | undefined) ?? "smart";
    saveWatchState({
      id,
      mode,
      fps: extractFps,
      width: extractWidth,
      height: extractHeight,
      ...(minSegmentDurationMs ? { minSegmentDurationMs } : {}),
      ...(initialSegmentDurationMs ? { initialSegmentDurationMs } : {}),
      sessionKey,
      notifyPolicy,
    });
    log.info(`[watch] Watch started successfully for "${source.name}" (id=${id})`);

    monitorBus.publish("cam:watch_started", {
      source_id: id,
      source_name: source.name,
      mode,
      fps: extractFps,
      ...(source.dashboard_user_id ? { user_id: source.dashboard_user_id } : {}),
      ...(source.dashboard_session_id ? { session_id: source.dashboard_session_id } : {}),
    }, id);

    // Auto-stop after duration
    if (duration && duration > 0) {
      const autoStopTimer = setTimeout(async () => {
        if (activeWatches.has(id)) {
          await doStopWatch(id, deps);
        }
      }, duration * 1000);
      autoStopTimer.unref?.();
      const current = activeWatches.get(id);
      if (current) current.autoStopTimer = autoStopTimer;
      else clearTimeout(autoStopTimer);
    }

    return JSON.stringify({
      status: "watching",
      source_id: id,
      source_name: source.name,
      mode,
      fps: extractFps,
      recording: true,
      duration: duration ?? "indefinite",
    });
  } catch (err) {
    const failedWatch = activeWatches.get(id);
    clearWatchAutoStopTimer(failedWatch);
    clearWatchLiveRestartTimer(failedWatch);
    failedWatch?.mediaSource?.close();
    deps.audioExtractor?.stopExtraction(id);
    deps.frameExtractor.stopExtraction(id);
    deps.recordManager.stopRecording(id);
    if (startedPhoneSource) {
      startedPhoneSource.stopStream();
      activePhoneSources.delete(id);
    }
    if (startedLocalDevice) {
      const localDev = activeLocalDevices.get(id);
      localDev?.stop();
      activeLocalDevices.delete(id);
    }
    deps.go2rtc.removeStream(id).catch(() => {});
    activeWatches.delete(id);
    await watchVad?.dispose();
    removeWatchState(id);
    log.info(`[watch] FAILED for "${id}": ${err instanceof Error ? err.message : String(err)}`);
    return JSON.stringify({ error: `Watch failed: ${err instanceof Error ? err.message : String(err)}` });
  }
}

async function handleStopWatch(params: Record<string, unknown>, deps: CamToolDeps): Promise<string> {
  const id = resolveSourceId(params.name as string, deps);
  if (!id) return sourceNotFound(params.name as string);

  if (!activeWatches.has(id)) return JSON.stringify({ error: `Not watching: ${params.name}` });

  const recordings = await doStopWatch(id, deps);
  return JSON.stringify({ status: "stopped", source_id: id, recordings });
}

/** Internal: stop both frame extraction and recording for a watch session. */
async function doStopWatch(id: string, deps: CamToolDeps): Promise<RecordingFile[]> {
  const watch = activeWatches.get(id);
  if (watch?.stopping) return deps.recordManager.listRecordings(id);
  if (watch) watch.stopping = true;
  clearWatchAutoStopTimer(watch);
  clearWatchLiveRestartTimer(watch);

  // Stop audio extraction + flush remaining VAD segments
  if (watch?.hasAudio && deps.audioExtractor) {
    deps.audioExtractor.stopExtraction(id);
  }
  if (watch?.vad?.isAvailable) {
    const remaining = watch.vad.flush();
    const voiceSegs = remaining.map(s => ({ start: s.start, length: s.samples.length }));
    const tailPcm = watch.pcmAccum.length > 0 ? watch.pcmAccum : Buffer.alloc(0);
    // Always ingest tail PCM + any remaining speech — even if no remaining segments,
    // the PCM tail belongs to the final segment's audio_data
    if (tailPcm.length > 0 || voiceSegs.length > 0) {
      watch.pipeline.ingestAudio(tailPcm, voiceSegs, remaining);
    }
    watch.pcmAccum = Buffer.alloc(0);
  }

  // Stop frame extraction + flush pipeline (forceFlush runs after queued ingestAudio)
  watch?.mediaSource?.close();
  deps.frameExtractor.stopExtraction(id);
  if (watch) {
    await watch.pipeline.forceFlush(undefined, { ignoreMinDuration: true });
    await deps.waitForCameraIdle?.(id);
  }

  // Stop recording
  deps.recordManager.stopRecording(id);

  // Clean up phone: stop ClawCam RTSP server
  if (watch?.phoneSource) {
    watch.phoneSource.stopStream();
  }

  // Clean up local device: stop ffmpeg capture
  const localDev = activeLocalDevices.get(id);
  if (localDev) {
    localDev.stop();
    activeLocalDevices.delete(id);
  }

  activeWatches.delete(id);
  removeWatchState(id);
  await watch?.vad?.dispose();

  monitorBus.publish("cam:watch_stopped", { source_id: id }, id);

  return deps.recordManager.listRecordings(id);
}

// ── Dynamic mode switching ──

async function handleSwitchMode(
  params: Record<string, unknown>,
  deps: CamToolDeps,
): Promise<string> {
  const id = resolveSourceId(params.name as string, deps);
  if (!id) return sourceNotFound(params.name as string);

  const watch = activeWatches.get(id);
  if (!watch) return JSON.stringify({ error: `Not watching: ${params.name}` });

  const targetMode = params.mode as "event" | "stream";
  if (!targetMode || !["event", "stream"].includes(targetMode)) {
    return JSON.stringify({ error: `Invalid mode: ${targetMode}. Must be "event" or "stream".` });
  }

  const currentMode = watch.modeRef.current;
  if (currentMode === targetMode) {
    return JSON.stringify({ status: "no_change", source_id: id, mode: currentMode });
  }

  const log = deps.logger ?? defaultLogger;
  const config = deps.config;
  log.info(`[switch_mode] ${id}: ${currentMode} → ${targetMode}`);

  // Step 1: Stop any active event recording before switching
  if (currentMode === "event" && deps.recordManager.isRecording(id)) {
    deps.recordManager.stopRecording(id);
  }

  // Step 2: Flush current buffer (no frame loss)
  await watch.pipeline.forceFlush();
  await deps.waitForCameraIdle?.(id);

  // Step 3: Create new segmenter chain + atomic swap
  const windowSize = config?.segment_window_size ?? 10;
  const enableMotion = targetMode === "stream";
  const enableVad = targetMode === "stream" && deps.sileroVad?.isAvailable === true;
  if (enableVad && !watch.vad) {
    watch.vad = await deps.sileroVad!.createSession();
    watch.vadDebug = createVadDebug();
  } else if (!enableVad && watch.vad) {
    await watch.vad.dispose();
    watch.vad = undefined;
    watch.vadDebug = undefined;
    watch.pcmAccum = Buffer.alloc(0);
    watch.pcmAccumStartTimestampMs = undefined;
    watch.hasAudio = false;
  }
  const newSegmenters = createSegmenterChain(windowSize, enableMotion, enableVad);
  watch.pipeline.switchMode(targetMode, newSegmenters);

  // Step 4: Switch recording strategy
  const phoneRtspUrl = watch.phoneSource?.getStreamInfo()?.rtspUrl;
  if (targetMode === "stream") {
    // event→stream: start continuous recording
    deps.recordManager.startRecording(id, { inputOverride: phoneRtspUrl });
  } else {
    // stream→event: stop continuous recording (motion-triggered via onFrame)
    deps.recordManager.stopRecording(id);
  }

  // Step 5: Update FPS (use originalFps to avoid capped-value bug)
  const newFps = targetMode === "event"
    ? Math.min(watch.originalFps, 5)
    : watch.originalFps;
  const currentOpts = deps.frameExtractor.getExtractionOptions(id);
  if (watch.updateMediaSampling && watch.mediaSampling && watch.mediaSampling.fps !== newFps) {
    watch.updateMediaSampling({ ...watch.mediaSampling, fps: newFps });
  } else if (!watch.mediaSource && currentOpts && currentOpts.fps !== newFps) {
    deps.frameExtractor.updateExtraction(id, { ...currentOpts, fps: newFps });
  }

  // Step 6: Update modeRef (onFrame closure sees new mode immediately)
  watch.modeRef.current = targetMode;

  // Step 7: Persist updated state
  updateWatchState(id, { mode: targetMode, fps: newFps });

  log.info(`[switch_mode] ${id}: switched to ${targetMode}`);
  return JSON.stringify({
    status: "switched",
    source_id: id,
    previous_mode: currentMode,
    mode: targetMode,
    fps: newFps,
  });
}

// ── Dynamic sampling control ──

function handleSetSampling(params: Record<string, unknown>, deps: CamToolDeps): string {
  const id = resolveSourceId(params.name as string, deps);
  if (!id) return sourceNotFound(params.name as string);

  const watch = activeWatches.get(id);
  if (!watch) {
    return JSON.stringify({ error: `Not watching "${params.name}". Start watch first.` });
  }

  if (watch.mediaSource && !watch.updateMediaSampling) {
    return JSON.stringify({ error: `set_sampling is not supported for local-file unified media source "${id}". Restart the watch with new parameters.` });
  }
  if (watch.updateMediaSampling) {
    const current = watch.mediaSampling;
    if (!current) {
      return JSON.stringify({ error: `No active extraction for "${id}".` });
    }

    const newFps = (params.fps as number | undefined) ?? current.fps;
    const newWidth = (params.width as number | undefined) ?? current.width;
    const newHeight = (params.height as number | undefined) ?? current.height;
    const fullRateRequired = deps.shouldUseFullRate?.(id) === true;
    const requestedFullRate = typeof params._fullRate === "boolean" ? params._fullRate : undefined;
    const nextFullRate = fullRateRequired
      || (requestedFullRate !== undefined
        ? requestedFullRate
        : current.fullRate ?? deps.config?.extraction_full_rate === true);

    if (current.fps === newFps && current.width === newWidth && current.height === newHeight && current.fullRate === nextFullRate) {
      return JSON.stringify({
        success: true,
        status: "no_change",
        source_id: id,
        fps: current.fps,
        width: current.width,
        height: current.height,
        fullRate: current.fullRate,
      });
    }

    if (watch.fullRateRef) watch.fullRateRef.current = nextFullRate;
    watch.updateMediaSampling({ fps: newFps, width: newWidth, height: newHeight, fullRate: nextFullRate });
    updateWatchState(id, { fps: newFps, width: newWidth, height: newHeight });
    const log = deps.logger ?? defaultLogger;
    log.info(`[set_sampling] ${id}: fps=${newFps}, ${newWidth}x${newHeight}, fullRate=${nextFullRate}`);

    return JSON.stringify({
      success: true,
      source_id: id,
      fps: newFps,
      width: newWidth,
      height: newHeight,
      fullRate: nextFullRate,
      previous: { fps: current.fps, width: current.width, height: current.height, fullRate: current.fullRate },
    });
  }

  const current = deps.frameExtractor.getExtractionOptions(id);
  if (!current) {
    return JSON.stringify({ error: `No active extraction for "${id}".` });
  }

  const newFps = (params.fps as number | undefined) ?? current.fps;
  const newWidth = (params.width as number | undefined) ?? current.width;
  const newHeight = (params.height as number | undefined) ?? current.height;
  const fullRateRequired = deps.shouldUseFullRate?.(id) === true;
  const requestedFullRate = typeof params._fullRate === "boolean" ? params._fullRate : undefined;
  const nextFullRate = fullRateRequired
    || (requestedFullRate !== undefined
      ? requestedFullRate
      : current.fullRate ?? deps.config?.extraction_full_rate === true);

  if (current.fps === newFps && current.width === newWidth && current.height === newHeight && (current.fullRate ?? false) === nextFullRate) {
    return JSON.stringify({
      success: true,
      status: "no_change",
      source_id: id,
      fps: current.fps,
      width: current.width,
      height: current.height,
      fullRate: current.fullRate ?? false,
    });
  }

  if (watch.fullRateRef) watch.fullRateRef.current = nextFullRate;

  if (current.fullRate && nextFullRate && newWidth === current.width && newHeight === current.height) {
    // fullRate mode: ffmpeg outputs all frames, fps only controls Percept decimation.
    // Update the stored fps without restarting ffmpeg.
    deps.frameExtractor.updateExtractionFpsOnly(id, newFps);
  } else {
    deps.frameExtractor.updateExtraction(id, {
      ...current,
      fps: newFps,
      width: newWidth,
      height: newHeight,
      fullRate: nextFullRate,
    });
  }

  // Persist updated params
  updateWatchState(id, { fps: newFps, width: newWidth, height: newHeight });

  const log = deps.logger ?? defaultLogger;
  log.info(`[set_sampling] ${id}: fps=${newFps}, ${newWidth}x${newHeight}, fullRate=${nextFullRate}${current.fullRate && nextFullRate ? " (no ffmpeg restart)" : ""}`);

  return JSON.stringify({
    success: true,
    source_id: id,
    fps: newFps,
    width: newWidth,
    height: newHeight,
    fullRate: nextFullRate,
    previous: { fps: current.fps, width: current.width, height: current.height, fullRate: current.fullRate ?? false },
  });
}

// ── Live view ──

/** Get the first non-internal IPv4 address for LAN access. */
function getLocalIp(): string {
  const nets = networkInterfaces();
  for (const ifaces of Object.values(nets)) {
    if (!ifaces) continue;
    for (const iface of ifaces) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "127.0.0.1";
}

function handleLiveView(params: Record<string, unknown>, deps: CamToolDeps): string {
  const id = resolveSourceId(params.name as string, deps);
  if (!id) return sourceNotFound(params.name as string);

  const source = deps.sourceManager.getSource(id);
  if (!source) return sourceNotFound(params.name as string);

  // Phone and local device streams only exist during active watch
  const needsWatch = source.protocol === "phone" || isLocalDevice(source.input);
  if (needsWatch && !activeWatches.has(id)) {
    return JSON.stringify({
      error: `Camera "${source.name}" is a ${source.protocol === "phone" ? "phone" : "local device"} — start a watch first (watch action) to activate the live stream.`,
    });
  }

  const apiPort = deps.config?.go2rtc_api_port ?? 1984;
  const host = getLocalIp();
  const streamUrl = `http://${host}:${apiPort}/stream.html?src=${encodeURIComponent(id)}`;

  return JSON.stringify({
    source_id: id,
    source_name: source.name,
    live_url: streamUrl,
    message: `Open this link to watch live: ${streamUrl}`,
  });
}

// ── Recordings ──

function handleListRecordings(params: Record<string, unknown>, deps: CamToolDeps): string {
  const id = resolveSourceId(params.name as string, deps);
  if (!id) return sourceNotFound(params.name as string);
  return JSON.stringify({ recordings: deps.recordManager.listRecordings(id) });
}

// ── Save reference frame ──

async function handleSaveReference(params: Record<string, unknown>, deps: CamToolDeps): Promise<string> {
  const id = resolveSourceId(params.name as string, deps);
  if (!id) return sourceNotFound(params.name as string);
  const cfg = deps.sourceManager.getSource(id)!;

  const width = params.width as number | undefined;
  const height = params.height as number | undefined;

  try {
    // Capture a fresh snapshot (reuse snapshot logic)
    let frame: FrameResult;
    if (cfg.protocol === "phone") {
      const phoneSource = activePhoneSources.get(id) ?? new PhoneSource(id);
      frame = await phoneSource.snapshot({
        quality: 85,
        resolution: { width: width ?? 960, height: height ?? 540 },
      });
    } else {
      if (isLocalDevice(cfg.input) && !activeLocalDevices.has(id)) {
        const ffmpegBin = deps.config?.ffmpeg_bin ?? "ffmpeg";
        const localDev = new LocalDeviceSource(id, {
          ffmpegBin,
          rtspBase: deps.go2rtc.rtspBase,
          width: width ?? 960,
          height: height ?? 540,
        });
        await localDev.start(cfg.input);
        activeLocalDevices.set(id, localDev);
      }
      const buffer = await deps.go2rtc.captureFrame(id, width, height);
      frame = { data: buffer.toString("base64"), timestamp: Date.now(), source_name: id };
    }

    // Stop local device after capture (avoid leaking ffmpeg process)
    const localDev = activeLocalDevices.get(id);
    if (localDev && !activeWatches.has(id)) {
      localDev.stop();
      activeLocalDevices.delete(id);
    }

    // Save JPEG to reference path
    const refDir = join(resolveReflectWorldStateDir(), "cameras");
    if (!existsSync(refDir)) mkdirSync(refDir, { recursive: true });
    const refPath = join(refDir, `${id}_ref.jpg`);
    writeFileSync(refPath, Buffer.from(frame.data, "base64"));

    const log = deps.logger ?? defaultLogger;
    log.info(`[save_reference] Saved reference frame for "${id}" → ${refPath}`);

    return JSON.stringify({
      success: true,
      source_id: id,
      source_name: cfg.name,
      path: refPath,
    });
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}

export function _resetActiveWatches(): void {
  for (const watch of activeWatches.values()) {
    clearWatchAutoStopTimer(watch);
    clearWatchLiveRestartTimer(watch);
    watch.mediaSource?.close();
  }
  activeWatches.clear();
  activePhoneSources.clear();
  for (const dev of activeLocalDevices.values()) dev.stop();
  activeLocalDevices.clear();
}

export function _resetSourceSecurityWarningsForTests(): void {
  sourceSecurityWarningsLogged = false;
}
