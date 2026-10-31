import { describe, it, expect, vi } from "vitest";
import { monitorBus } from "@reflectworld/shared";
import jpeg from "jpeg-js";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeCamAction,
  loadPersistedWatchStates,
  setWatchPersistDir,
  updateWatchState,
  _resetActiveWatches,
  _resetSourceSecurityWarningsForTests,
  type CamToolDeps,
} from "../tool.js";
import type { SourceManager } from "../source-manager.js";
import type { Go2rtcManager } from "../go2rtc-manager.js";
import type { RecordManager } from "../record-manager.js";
import type { FrameExtractor } from "../frame-extractor.js";
import type { SileroVad } from "../silero-vad.js";

const CAM = { id: "cam1", name: "cam1", input: "rtsp://x", protocol: "ffmpeg" as const, created_at: 1 };

const mockSourceManager = {
  addSource: vi.fn().mockReturnValue(CAM),
  listSources: vi.fn().mockReturnValue([]),
  removeSource: vi.fn().mockReturnValue(true),
  getSource: vi.fn().mockReturnValue(null),
  resolveId: vi.fn().mockReturnValue(null),
} as unknown as SourceManager;

const mockGo2rtc = {
  addStream: vi.fn().mockResolvedValue(undefined),
  removeStream: vi.fn().mockResolvedValue(undefined),
  captureFrame: vi.fn().mockResolvedValue(Buffer.from([0xff, 0xd8])),
  isRunning: true,
} as unknown as Go2rtcManager;

const mockRecordManager = {
  startRecording: vi.fn(),
  stopRecording: vi.fn().mockReturnValue(true),
  listRecordings: vi.fn().mockReturnValue([]),
  isRecording: vi.fn().mockReturnValue(false),
} as unknown as RecordManager;

const mockFrameExtractor = {
  startExtraction: vi.fn(),
  stopExtraction: vi.fn().mockReturnValue(true),
  updateExtraction: vi.fn(),
  updateExtractionFpsOnly: vi.fn(),
  isExtracting: vi.fn().mockReturnValue(false),
  getExtractionOptions: vi.fn().mockReturnValue(null),
} as unknown as FrameExtractor;

const REAL_JPEG_BASE64 = jpeg.encode({
  data: Buffer.from([255, 255, 255, 255]),
  width: 1,
  height: 1,
}, 80).data.toString("base64");

function makeDeps(overrides?: Partial<CamToolDeps>): CamToolDeps {
  return {
    sourceManager: mockSourceManager,
    go2rtc: mockGo2rtc,
    recordManager: mockRecordManager,
    frameExtractor: mockFrameExtractor,
    createLiveMediaSource: vi.fn(() => ({
      start: vi.fn(() => new Promise<void>(() => {})),
      close: vi.fn(),
    })),
    ...overrides,
  };
}

/** Create deps where getSource and resolveId return a valid source. */
function makeSourceDeps(overrides?: Partial<CamToolDeps>): CamToolDeps {
  return makeDeps({
    sourceManager: {
      ...mockSourceManager,
      getSource: vi.fn().mockReturnValue(CAM),
      resolveId: vi.fn().mockReturnValue("cam1"),
    } as unknown as SourceManager,
    ...overrides,
  });
}

const LIVE_UNIFIED_RESTART_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

async function exhaustLiveUnifiedRestartBudget(): Promise<void> {
  for (const delay of LIVE_UNIFIED_RESTART_DELAYS_MS) {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(delay);
  }
  await Promise.resolve();
}

describe("executeCamAction v3", () => {
  it("add_source registers and calls go2rtc addStream", async () => {
    const result = await executeCamAction("add_source", { source: "rtsp://x" }, makeDeps());
    expect(JSON.parse(result).success).toBe(true);
    expect(mockGo2rtc.addStream).toHaveBeenCalled();
  });

  it("add_source rejects unsafe sources in strict source mode before registering", async () => {
    vi.clearAllMocks();
    const result = await executeCamAction("add_source", {
      source: "http://169.254.169.254/latest/meta-data",
      _sourceSecurityMode: "strict",
    }, makeDeps());
    expect(JSON.parse(result)).toMatchObject({
      success: false,
      code: "http_not_allowed",
    });
    expect(mockSourceManager.addSource).not.toHaveBeenCalled();
    expect(mockGo2rtc.addStream).not.toHaveBeenCalled();
  });

  it("add_source allows internal local files when explicitly marked", async () => {
    vi.clearAllMocks();
    const result = await executeCamAction("add_source", {
      source: "/tmp/upload.mp4",
      _dashboardUserId: "user-a",
      _dashboardSessionId: "session-a",
      _allowLocalFileSource: true,
    }, makeDeps());
    expect(JSON.parse(result).success).toBe(true);
    expect(mockSourceManager.addSource).toHaveBeenCalledWith(
      "/tmp/upload.mp4",
      undefined,
      expect.objectContaining({ dashboard_user_id: "user-a", dashboard_session_id: "session-a" }),
    );
  });

  it("warns once when public mode allows private source targets", async () => {
    vi.clearAllMocks();
    _resetSourceSecurityWarningsForTests();
    const previousPublicMode = process.env.REFLECTWORLD_PUBLIC_MODE;
    const previousPrivateSource = process.env.REFLECTWORLD_ALLOW_PRIVATE_SOURCE;
    try {
      process.env.REFLECTWORLD_PUBLIC_MODE = "true";
      process.env.REFLECTWORLD_ALLOW_PRIVATE_SOURCE = "true";
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const deps = makeDeps({ logger });

      const first = await executeCamAction("add_source", { source: "rtsp://8.8.8.8/stream" }, deps);
      const second = await executeCamAction("add_source", { source: "rtsp://8.8.8.8/stream" }, deps);

      expect(JSON.parse(first).success).toBe(true);
      expect(JSON.parse(second).success).toBe(true);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("REFLECTWORLD_ALLOW_PRIVATE_SOURCE=true"));
    } finally {
      if (previousPublicMode == null) delete process.env.REFLECTWORLD_PUBLIC_MODE;
      else process.env.REFLECTWORLD_PUBLIC_MODE = previousPublicMode;
      if (previousPrivateSource == null) delete process.env.REFLECTWORLD_ALLOW_PRIVATE_SOURCE;
      else process.env.REFLECTWORLD_ALLOW_PRIVATE_SOURCE = previousPrivateSource;
      _resetSourceSecurityWarningsForTests();
    }
  });

  it("list_sources returns array", async () => {
    const result = await executeCamAction("list_sources", {}, makeDeps());
    expect(JSON.parse(result).sources).toEqual([]);
  });

  it("caches persisted watch state after the initial directory load", () => {
    const dir = mkdtempSync(join(tmpdir(), "reflectworld-watch-state-"));
    try {
      setWatchPersistDir(dir);
      writeFileSync(join(dir, "cam1.json"), JSON.stringify({
        id: "cam1",
        mode: "stream",
        fps: 1,
      }));

      expect(loadPersistedWatchStates()).toEqual([
        expect.objectContaining({ id: "cam1", fps: 1 }),
      ]);

      unlinkSync(join(dir, "cam1.json"));
      expect(updateWatchState("cam1", { fps: 3 })).toBe(true);
      expect(loadPersistedWatchStates()).toEqual([
        expect.objectContaining({ id: "cam1", fps: 3 }),
      ]);
      expect(existsSync(join(dir, "cam1.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      const resetDir = mkdtempSync(join(tmpdir(), "reflectworld-watch-state-reset-"));
      setWatchPersistDir(resetDir);
      rmSync(resetDir, { recursive: true, force: true });
    }
  });

  it("preserves existing persisted watch states when saving before the first load", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reflectworld-watch-state-save-"));
    try {
      _resetActiveWatches();
      vi.clearAllMocks();
      setWatchPersistDir(dir);
      writeFileSync(join(dir, "cam-existing.json"), JSON.stringify({
        id: "cam-existing",
        mode: "stream",
        fps: 2,
      }));
      const deps = makeSourceDeps();

      await executeCamAction("watch", { name: "cam1", mode: "stream" }, deps);

      expect(loadPersistedWatchStates().map((state) => state.id).sort()).toEqual([
        "cam-existing",
        "cam1",
      ]);
      await executeCamAction("stop_watch", { name: "cam1" }, deps);
    } finally {
      _resetActiveWatches();
      rmSync(dir, { recursive: true, force: true });
      const resetDir = mkdtempSync(join(tmpdir(), "reflectworld-watch-state-reset-"));
      setWatchPersistDir(resetDir);
      rmSync(resetDir, { recursive: true, force: true });
    }
  });

  it("remove_source calls go2rtc removeStream", async () => {
    const deps = makeSourceDeps();
    const result = await executeCamAction("remove_source", { name: "cam1" }, deps);
    expect(JSON.parse(result).success).toBe(true);
    expect(mockGo2rtc.removeStream).toHaveBeenCalledWith("cam1");
  });

  it("remove_source drains active watch cleanup before removing source", async () => {
    _resetActiveWatches();
    vi.clearAllMocks();
    const liveSource = {
      start: vi.fn(() => new Promise<void>(() => {})),
      close: vi.fn(),
    };
    const vadSession = {
      isAvailable: true,
      feedChunk: vi.fn(() => ({ isSpeaking: false, segments: [] })),
      flush: vi.fn(() => []),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    const waitForCameraIdle = vi.fn().mockResolvedValue(undefined);
    const deps = makeSourceDeps({
      createLiveMediaSource: vi.fn(() => liveSource),
      sileroVad: {
        isAvailable: true,
        createSession: vi.fn().mockResolvedValue(vadSession),
      } as any,
      waitForCameraIdle,
    });

    await executeCamAction("watch", { name: "cam1", mode: "stream" }, deps);
    const result = await executeCamAction("remove_source", { name: "cam1" }, deps);

    expect(JSON.parse(result).success).toBe(true);
    expect(liveSource.close).toHaveBeenCalledTimes(1);
    expect(vadSession.flush).toHaveBeenCalledTimes(1);
    expect(vadSession.dispose).toHaveBeenCalledTimes(1);
    expect(waitForCameraIdle).toHaveBeenCalledWith("cam1");
    expect(mockGo2rtc.removeStream).toHaveBeenCalledWith("cam1");
  });

  it("snapshot uses go2rtc captureFrame and sends through perception", async () => {
    _resetActiveWatches();
    const onSegment = vi.fn().mockResolvedValue({ segment_id: "s1", summary: "test" });
    const deps = makeSourceDeps({ onSegment });
    const result = await executeCamAction("snapshot", { name: "cam1" }, deps);
    const parsed = JSON.parse(result);
    expect(parsed.source_name).toBe("cam1");
    expect(parsed.perception).toBeDefined();
    expect(onSegment).toHaveBeenCalledWith(expect.objectContaining({ camera_id: "cam1", mode: "snapshot" }));
  });

  it("snapshot without onSegment returns raw frame", async () => {
    _resetActiveWatches();
    const deps = makeSourceDeps();
    const result = await executeCamAction("snapshot", { name: "cam1" }, deps);
    expect(JSON.parse(result).data).toBeDefined();
    expect(mockGo2rtc.captureFrame).toHaveBeenCalledWith("cam1", undefined, undefined);
  });

  it("snapshot returns error for unknown source", async () => {
    const result = await executeCamAction("snapshot", { name: "nope" }, makeDeps());
    expect(JSON.parse(result).error).toContain("not found");
  });

  it("list_recordings delegates to RecordManager", async () => {
    const deps = makeSourceDeps();
    const result = await executeCamAction("list_recordings", { name: "cam1" }, deps);
    expect(JSON.parse(result).recordings).toEqual([]);
  });

  it("watch starts recording and live unified media source", async () => {
    _resetActiveWatches();
    const deps = makeSourceDeps();
    const result = await executeCamAction("watch", { name: "cam1", mode: "stream" }, deps);
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("watching");
    expect(parsed.recording).toBe(true);
    expect(mockRecordManager.startRecording).toHaveBeenCalledWith("cam1", expect.any(Object));
    expect(deps.createLiveMediaSource).toHaveBeenCalledWith(expect.objectContaining({
      inputUrl: expect.stringContaining("/cam1"),
      fps: expect.any(Number),
      onVideoFrame: expect.any(Function),
      onAudioChunk: expect.any(Function),
    }));
    expect(mockFrameExtractor.startExtraction).not.toHaveBeenCalled();

    // Clean up
    await executeCamAction("stop_watch", { name: "cam1" }, deps);
  });

  it("watch supports per-call full-rate override", async () => {
    _resetActiveWatches();
    const deps = makeSourceDeps({
      config: { extraction_full_rate: false } as CamToolDeps["config"],
    });

    await executeCamAction("watch", { name: "cam1", mode: "stream", _fullRate: true }, deps);

    expect(deps.createLiveMediaSource).toHaveBeenCalledWith(expect.objectContaining({ fullRate: true }));

    await executeCamAction("stop_watch", { name: "cam1" }, deps);
  });

  it("watch enables full-rate when deps require it for the camera", async () => {
    _resetActiveWatches();
    const deps = makeSourceDeps({
      config: { extraction_full_rate: false } as CamToolDeps["config"],
      shouldUseFullRate: vi.fn((cameraId: string) => cameraId === "cam1"),
    });

    await executeCamAction("watch", { name: "cam1", mode: "stream" }, deps);

    expect(deps.createLiveMediaSource).toHaveBeenCalledWith(expect.objectContaining({ fullRate: true }));

    await executeCamAction("stop_watch", { name: "cam1" }, deps);
  });

  it("watch keeps full-rate when deps require it even if override is false", async () => {
    _resetActiveWatches();
    const deps = makeSourceDeps({
      config: { extraction_full_rate: false } as CamToolDeps["config"],
      shouldUseFullRate: vi.fn(() => true),
    });

    await executeCamAction("watch", { name: "cam1", mode: "stream", _fullRate: false }, deps);

    expect(deps.createLiveMediaSource).toHaveBeenCalledWith(expect.objectContaining({ fullRate: true }));

    await executeCamAction("stop_watch", { name: "cam1" }, deps);
  });

  it("restarts live unified media source if it fails", async () => {
    vi.useFakeTimers();
    try {
      _resetActiveWatches();
      vi.clearAllMocks();
      const liveSources: Array<{ start: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
      const deps = makeSourceDeps({
        createLiveMediaSource: vi.fn(() => {
          const source = {
            start: vi.fn(liveSources.length === 0
              ? () => Promise.reject(new Error("ffmpeg failed"))
              : () => new Promise<void>(() => {})),
            close: vi.fn(),
          };
          liveSources.push(source);
          return source;
        }),
      });

      await executeCamAction("watch", { name: "cam1", mode: "stream" }, deps);
      await Promise.resolve();

      expect(deps.frameExtractor.startExtraction).not.toHaveBeenCalled();
      expect(deps.createLiveMediaSource).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);

      expect(deps.createLiveMediaSource).toHaveBeenCalledTimes(2);
      expect(liveSources[0]?.close).toHaveBeenCalled();
      expect(deps.frameExtractor.startExtraction).not.toHaveBeenCalled();

      await executeCamAction("stop_watch", { name: "cam1" }, deps);
    } finally {
      _resetActiveWatches();
      vi.useRealTimers();
    }
  });

  it("falls back to legacy extraction after live unified restart budget is exhausted", async () => {
    vi.useFakeTimers();
    try {
      _resetActiveWatches();
      vi.clearAllMocks();
      const deps = makeSourceDeps({
        createLiveMediaSource: vi.fn(() => ({
          start: vi.fn().mockRejectedValue(new Error("ffmpeg failed")),
          close: vi.fn(),
        })),
      });

      await executeCamAction("watch", { name: "cam1", mode: "stream" }, deps);
      await exhaustLiveUnifiedRestartBudget();

      expect(deps.createLiveMediaSource).toHaveBeenCalledTimes(6);
      expect(deps.frameExtractor.startExtraction).toHaveBeenCalledWith(
        "cam1",
        expect.objectContaining({ timestampMode: "wall_clock" }),
      );

      await executeCamAction("stop_watch", { name: "cam1" }, deps);
    } finally {
      _resetActiveWatches();
      vi.useRealTimers();
    }
  });

  it("does not fallback when explicit stop closes the live unified media source", async () => {
    _resetActiveWatches();
    vi.clearAllMocks();
    let resolveStart!: () => void;
    const liveSource = {
      start: vi.fn(() => new Promise<void>((resolve) => {
        resolveStart = resolve;
      })),
      close: vi.fn(() => resolveStart()),
    };
    const deps = makeSourceDeps({
      createLiveMediaSource: vi.fn(() => liveSource),
    });

    await executeCamAction("watch", { name: "cam1", mode: "stream" }, deps);
    await executeCamAction("stop_watch", { name: "cam1" }, deps);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(liveSource.close).toHaveBeenCalled();
    expect(deps.frameExtractor.startExtraction).not.toHaveBeenCalled();
  });

  it("clears pending live unified restart timers on explicit stop", async () => {
    vi.useFakeTimers();
    try {
      _resetActiveWatches();
      vi.clearAllMocks();
      const deps = makeSourceDeps({
        createLiveMediaSource: vi.fn(() => ({
          start: vi.fn().mockRejectedValue(new Error("ffmpeg failed")),
          close: vi.fn(),
        })),
      });

      await executeCamAction("watch", { name: "cam1", mode: "stream" }, deps);
      await Promise.resolve();
      expect(deps.createLiveMediaSource).toHaveBeenCalledTimes(1);

      await executeCamAction("stop_watch", { name: "cam1" }, deps);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(deps.createLiveMediaSource).toHaveBeenCalledTimes(1);
      expect(deps.frameExtractor.startExtraction).not.toHaveBeenCalled();
    } finally {
      _resetActiveWatches();
      vi.useRealTimers();
    }
  });

  it("clears duration auto-stop timers on explicit stop", async () => {
    vi.useFakeTimers();
    try {
      _resetActiveWatches();
      vi.clearAllMocks();
      const deps = makeSourceDeps();

      await executeCamAction("watch", { name: "cam1", mode: "stream", duration: 60 }, deps);
      expect(vi.getTimerCount()).toBe(1);

      await executeCamAction("stop_watch", { name: "cam1" }, deps);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      _resetActiveWatches();
      vi.useRealTimers();
    }
  });

  it("local-file EOF watch uses unified media source without full-rate fallback", async () => {
    _resetActiveWatches();
    vi.clearAllMocks();
    const localSource = { ...CAM, input: "/tmp/e2e.mp4" };
    const localFileSource = {
      start: vi.fn(() => new Promise<void>(() => {})),
      close: vi.fn(),
    };
    const createLocalFileMediaSource = vi.fn(() => localFileSource);
    const deps = makeSourceDeps({
      sourceManager: {
        ...mockSourceManager,
        getSource: vi.fn().mockReturnValue(localSource),
        resolveId: vi.fn().mockReturnValue("cam1"),
      } as unknown as SourceManager,
      createLocalFileMediaSource,
    });

    await executeCamAction("watch", {
      name: "cam1",
      mode: "stream",
      fps: 1,
      _stopOnInputEnd: true,
    }, deps);

    expect(deps.frameExtractor.startExtraction).not.toHaveBeenCalled();
    expect(createLocalFileMediaSource).toHaveBeenCalledWith(
      expect.objectContaining({
        videoPath: "/tmp/e2e.mp4",
        fullRate: false,
        pacing: "realtime",
      }),
    );
    expect(localFileSource.start).toHaveBeenCalled();

    const result = await executeCamAction("set_sampling", { name: "cam1", fps: 3 }, deps);
    expect(JSON.parse(result).error).toContain("not supported for local-file unified media source");
    expect(deps.frameExtractor.updateExtractionFpsOnly).not.toHaveBeenCalled();
    expect(deps.frameExtractor.updateExtraction).not.toHaveBeenCalled();

    await executeCamAction("stop_watch", { name: "cam1" }, deps);
  });

  it("does not re-enter stop when local-file source resolves during explicit stop", async () => {
    _resetActiveWatches();
    vi.clearAllMocks();
    const localSource = { ...CAM, input: "/tmp/e2e.mp4" };
    let resolveStart!: () => void;
    let releaseIdle!: () => void;
    const startPromise = new Promise<void>((resolve) => { resolveStart = resolve; });
    const idlePromise = new Promise<void>((resolve) => { releaseIdle = resolve; });
    const localFileSource = {
      start: vi.fn(() => startPromise),
      close: vi.fn(() => resolveStart()),
    };
    const recordManager = {
      ...mockRecordManager,
      stopRecording: vi.fn().mockReturnValue(true),
      listRecordings: vi.fn().mockReturnValue([]),
    } as unknown as RecordManager;
    const deps = makeSourceDeps({
      sourceManager: {
        ...mockSourceManager,
        getSource: vi.fn().mockReturnValue(localSource),
        resolveId: vi.fn().mockReturnValue("cam1"),
      } as unknown as SourceManager,
      createLocalFileMediaSource: vi.fn(() => localFileSource),
      recordManager,
      waitForCameraIdle: vi.fn(() => idlePromise),
    });

    await executeCamAction("watch", {
      name: "cam1",
      mode: "stream",
      _stopOnInputEnd: true,
    }, deps);

    const stopped = executeCamAction("stop_watch", { name: "cam1" }, deps);
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseIdle();
    await stopped;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(localFileSource.close).toHaveBeenCalledTimes(1);
    expect(recordManager.stopRecording).toHaveBeenCalledTimes(1);
  });

  it("trims local-file audio that starts before the video timeline", async () => {
    _resetActiveWatches();
    vi.clearAllMocks();
    const localSource = { ...CAM, input: "/tmp/e2e.mp4" };
    let mediaOptions: any;
    const localFileSource = {
      start: vi.fn(() => new Promise<void>(() => {})),
      close: vi.fn(),
    };
    const onSegment = vi.fn().mockResolvedValue(null);
    const deps = makeSourceDeps({
      sourceManager: {
        ...mockSourceManager,
        getSource: vi.fn().mockReturnValue(localSource),
        resolveId: vi.fn().mockReturnValue("cam1"),
      } as unknown as SourceManager,
      createLocalFileMediaSource: vi.fn((opts) => {
        mediaOptions = opts;
        return localFileSource;
      }),
      sileroVad: {
        isAvailable: true,
        createSession: vi.fn().mockResolvedValue({
          isAvailable: true,
          feedChunk: vi.fn(() => ({ isSpeaking: false, segments: [] })),
          flush: vi.fn(() => []),
          dispose: vi.fn(),
        }),
        feedChunk: vi.fn(() => ({ isSpeaking: false, segments: [] })),
        flush: vi.fn(() => []),
      } as any,
      onSegment,
      waitForCameraIdle: vi.fn().mockResolvedValue(undefined),
    });

    await executeCamAction("watch", {
      name: "cam1",
      mode: "stream",
      _stopOnInputEnd: true,
    }, deps);

    mediaOptions.onAudioChunk({ pcm: Buffer.alloc(16_000 * 2), ptsMs: -500 });
    mediaOptions.onVideoFrame({ jpeg: Buffer.from(REAL_JPEG_BASE64, "base64"), ptsMs: 0 });
    mediaOptions.onVideoFrame({ jpeg: Buffer.from(REAL_JPEG_BASE64, "base64"), ptsMs: 1000 });
    await executeCamAction("stop_watch", { name: "cam1" }, deps);

    expect(onSegment).toHaveBeenCalledTimes(1);
    const segment = onSegment.mock.calls[0]?.[0] as { audio_data?: { pcm: Buffer } };
    expect(segment.audio_data?.pcm.length).toBe(8_000 * 2);
  });

  it("local-file audio callback waits for queued pipeline work", async () => {
    _resetActiveWatches();
    vi.clearAllMocks();
    const localSource = { ...CAM, input: "/tmp/e2e.mp4" };
    let mediaOptions: any;
    let releaseSegment!: () => void;
    const onSegment = vi.fn(() => new Promise<null>((resolve) => {
      releaseSegment = () => resolve(null);
    }));
    const deps = makeSourceDeps({
      sourceManager: {
        ...mockSourceManager,
        getSource: vi.fn().mockReturnValue(localSource),
        resolveId: vi.fn().mockReturnValue("cam1"),
      } as unknown as SourceManager,
      createLocalFileMediaSource: vi.fn((opts) => {
        mediaOptions = opts;
        return {
          start: vi.fn(() => new Promise<void>(() => {})),
          close: vi.fn(),
        };
      }),
      sileroVad: {
        isAvailable: true,
        createSession: vi.fn().mockResolvedValue({
          isAvailable: true,
          feedChunk: vi.fn(() => ({ isSpeaking: false, segments: [] })),
          flush: vi.fn(() => []),
          dispose: vi.fn(),
        }),
        feedChunk: vi.fn(() => ({ isSpeaking: false, segments: [] })),
        flush: vi.fn(() => []),
      } as any,
      onSegment,
      waitForCameraIdle: vi.fn().mockResolvedValue(undefined),
    });

    await executeCamAction("watch", {
      name: "cam1",
      mode: "stream",
      _stopOnInputEnd: true,
    }, deps);

    for (let i = 0; i < 9; i++) {
      await mediaOptions.onVideoFrame({ jpeg: Buffer.from(REAL_JPEG_BASE64, "base64"), ptsMs: i * 1000 });
    }
    const blockedFrame = mediaOptions.onVideoFrame({ jpeg: Buffer.from(REAL_JPEG_BASE64, "base64"), ptsMs: 9000 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onSegment).toHaveBeenCalledTimes(1);

    let audioSettled = false;
    const audioPromise = mediaOptions.onAudioChunk({ pcm: Buffer.alloc(512 * 2), ptsMs: 9000 }).then(() => {
      audioSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(audioSettled).toBe(false);

    releaseSegment();
    await blockedFrame;
    await audioPromise;
    expect(audioSettled).toBe(true);

    await executeCamAction("stop_watch", { name: "cam1" }, deps);
  });

  it("live unified video callback waits for queued pipeline work", async () => {
    _resetActiveWatches();
    vi.clearAllMocks();
    let mediaOptions: any;
    let releaseSegment!: () => void;
    const onSegment = vi.fn(() => new Promise<null>((resolve) => {
      releaseSegment = () => resolve(null);
    }));
    const deps = makeSourceDeps({
      createLiveMediaSource: vi.fn((opts) => {
        mediaOptions = opts;
        return {
          start: vi.fn(() => new Promise<void>(() => {})),
          close: vi.fn(),
        };
      }),
      onSegment,
    });

    await executeCamAction("watch", { name: "cam1", mode: "stream" }, deps);

    for (let i = 0; i < 9; i++) {
      await mediaOptions.onVideoFrame({ jpeg: Buffer.from(REAL_JPEG_BASE64, "base64"), ptsMs: i * 1000 });
    }
    const blockedFrame = mediaOptions.onVideoFrame({ jpeg: Buffer.from(REAL_JPEG_BASE64, "base64"), ptsMs: 9000 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onSegment).toHaveBeenCalledTimes(1);

    let settled = false;
    blockedFrame.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    releaseSegment();
    await blockedFrame;
    expect(settled).toBe(true);

    await executeCamAction("stop_watch", { name: "cam1" }, deps);
  });

  it("watch publishes cam:first_frame once on the first delivered frame", async () => {
    _resetActiveWatches();
    const deps = makeSourceDeps();
    const publishSpy = vi.spyOn(monitorBus, "publish");

    await executeCamAction("watch", { name: "cam1", mode: "stream" }, deps);

    const mediaArgs = vi.mocked(deps.createLiveMediaSource!).mock.calls[0]?.[0] as {
      onVideoFrame: (frame: { jpeg: Buffer; ptsMs: number }) => void;
    };
    expect(mediaArgs).toBeDefined();

    mediaArgs.onVideoFrame({ jpeg: Buffer.from(REAL_JPEG_BASE64, "base64"), ptsMs: 0 });
    mediaArgs.onVideoFrame({ jpeg: Buffer.from(REAL_JPEG_BASE64, "base64"), ptsMs: 1000 });

    const firstFrameEvents = publishSpy.mock.calls.filter((call) => call[0] === "cam:first_frame");
    expect(firstFrameEvents).toHaveLength(1);
    expect(firstFrameEvents[0]?.[1]).toMatchObject({ camera_id: "cam1" });
    expect(typeof (firstFrameEvents[0]?.[1] as any).media_ts).toBe("number");
    expect((firstFrameEvents[0]?.[1] as any).media_ts).toBeGreaterThan(0);

    publishSpy.mockRestore();
    await executeCamAction("stop_watch", { name: "cam1" }, deps);
  });

  it("watch returns error for unknown source", async () => {
    const result = await executeCamAction("watch", { name: "nope", mode: "stream" }, makeDeps());
    expect(JSON.parse(result).error).toContain("not found");
  });

  it("stop_watch returns error if not watching", async () => {
    _resetActiveWatches();
    const deps = makeSourceDeps();
    const result = await executeCamAction("stop_watch", { name: "cam1" }, deps);
    expect(JSON.parse(result).error).toContain("Not watching");
  });

  it("set_sampling returns error if not watching", async () => {
    _resetActiveWatches();
    const deps = makeSourceDeps();
    const result = await executeCamAction("set_sampling", { name: "cam1", fps: 5 }, deps);
    expect(JSON.parse(result).error).toContain("Not watching");
  });

  it("set_sampling updates live unified media source sampling", async () => {
    _resetActiveWatches();
    const liveSources: Array<{ start: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
    const processedFrames: number[] = [];
    const deps = makeSourceDeps({
      createLiveMediaSource: vi.fn(() => {
        const source = {
          start: vi.fn(() => new Promise<void>(() => {})),
          close: vi.fn(),
        };
        liveSources.push(source);
        return source;
      }),
      onFrameProcessed: vi.fn((frame) => {
        processedFrames.push(frame.timestamp);
      }),
    });
    await executeCamAction("watch", { name: "cam1", mode: "stream" }, deps);
    const firstMediaArgs = vi.mocked(deps.createLiveMediaSource!).mock.calls[0]?.[0] as {
      onVideoFrame: (frame: { jpeg: Buffer; ptsMs: number }) => void;
    };
    firstMediaArgs.onVideoFrame({ jpeg: Buffer.from(REAL_JPEG_BASE64, "base64"), ptsMs: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const result = await executeCamAction("set_sampling", { name: "cam1", fps: 5, width: 1280 }, deps);
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.fps).toBe(5);
    expect(parsed.width).toBe(1280);
    expect(deps.createLiveMediaSource).toHaveBeenCalledTimes(2);
    expect(deps.createLiveMediaSource).toHaveBeenLastCalledWith(expect.objectContaining({
      fps: 5,
      width: 1280,
      height: 540,
    }));
    expect(liveSources[0]?.close).toHaveBeenCalled();
    firstMediaArgs.onVideoFrame({ jpeg: Buffer.from(REAL_JPEG_BASE64, "base64"), ptsMs: 2000 });
    const secondMediaArgs = vi.mocked(deps.createLiveMediaSource!).mock.calls[1]?.[0] as {
      onVideoFrame: (frame: { jpeg: Buffer; ptsMs: number }) => void;
    };
    secondMediaArgs.onVideoFrame({ jpeg: Buffer.from(REAL_JPEG_BASE64, "base64"), ptsMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(processedFrames).toHaveLength(2);
    expect(processedFrames[1]! - processedFrames[0]!).toBe(200);
    expect(deps.frameExtractor.updateExtraction).not.toHaveBeenCalled();

    await executeCamAction("stop_watch", { name: "cam1" }, deps);
  });

  it("set_sampling keeps live unified audio on the same shifted timeline", async () => {
    _resetActiveWatches();
    const liveSources: Array<{ start: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
    const onSegment = vi.fn().mockResolvedValue(null);
    const deps = makeSourceDeps({
      createLiveMediaSource: vi.fn(() => {
        const source = {
          start: vi.fn(() => new Promise<void>(() => {})),
          close: vi.fn(),
        };
        liveSources.push(source);
        return source;
      }),
      sileroVad: {
        isAvailable: true,
        createSession: vi.fn().mockResolvedValue({
          isAvailable: true,
          feedChunk: vi.fn(() => ({ isSpeaking: false, segments: [] })),
          flush: vi.fn(() => []),
          dispose: vi.fn(),
        }),
        feedChunk: vi.fn(() => ({ isSpeaking: false, segments: [] })),
        flush: vi.fn(() => []),
      } as any,
      onSegment,
      waitForCameraIdle: vi.fn().mockResolvedValue(undefined),
    });

    await executeCamAction("watch", { name: "cam1", mode: "stream" }, deps);
    const firstMediaArgs = vi.mocked(deps.createLiveMediaSource!).mock.calls[0]?.[0] as {
      onVideoFrame: (frame: { jpeg: Buffer; ptsMs: number }) => void | Promise<void>;
    };
    await firstMediaArgs.onVideoFrame({ jpeg: Buffer.from(REAL_JPEG_BASE64, "base64"), ptsMs: 1000 });

    await executeCamAction("set_sampling", { name: "cam1", fps: 5, width: 1280 }, deps);
    const secondMediaArgs = vi.mocked(deps.createLiveMediaSource!).mock.calls[1]?.[0] as {
      onVideoFrame: (frame: { jpeg: Buffer; ptsMs: number }) => void | Promise<void>;
      onAudioChunk: (chunk: { pcm: Buffer; ptsMs: number }) => void | Promise<void>;
    };
    await secondMediaArgs.onAudioChunk({ pcm: Buffer.alloc(16_000 * 2), ptsMs: 0 });
    await secondMediaArgs.onVideoFrame({ jpeg: Buffer.from(REAL_JPEG_BASE64, "base64"), ptsMs: 0 });
    await secondMediaArgs.onVideoFrame({ jpeg: Buffer.from(REAL_JPEG_BASE64, "base64"), ptsMs: 1000 });

    await executeCamAction("stop_watch", { name: "cam1" }, deps);

    expect(liveSources[0]?.close).toHaveBeenCalled();
    expect(onSegment).toHaveBeenCalledTimes(1);
    const segment = onSegment.mock.calls[0]?.[0] as { audio_data?: { pcm: Buffer } };
    expect(segment.audio_data?.pcm.length).toBe(16_000 * 2);
  });

  it("set_sampling uses live audio PTS to keep restarted video timestamps monotonic", async () => {
    _resetActiveWatches();
    const processedFrames: number[] = [];
    const deps = makeSourceDeps({
      createLiveMediaSource: vi.fn(() => ({
        start: vi.fn(() => new Promise<void>(() => {})),
        close: vi.fn(),
      })),
      onFrameProcessed: vi.fn((frame) => {
        processedFrames.push(frame.timestamp);
      }),
    });

    await executeCamAction("watch", { name: "cam1", mode: "stream" }, deps);
    const firstMediaArgs = vi.mocked(deps.createLiveMediaSource!).mock.calls[0]?.[0] as {
      onAudioChunk: (chunk: { pcm: Buffer; ptsMs: number }) => void | Promise<void>;
    };
    await firstMediaArgs.onAudioChunk({ pcm: Buffer.alloc(512 * 2), ptsMs: 1000 });

    await executeCamAction("set_sampling", { name: "cam1", fps: 5, width: 1280 }, deps);
    const secondMediaArgs = vi.mocked(deps.createLiveMediaSource!).mock.calls[1]?.[0] as {
      onVideoFrame: (frame: { jpeg: Buffer; ptsMs: number }) => void | Promise<void>;
    };
    await secondMediaArgs.onVideoFrame({ jpeg: Buffer.from(REAL_JPEG_BASE64, "base64"), ptsMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(processedFrames).toHaveLength(1);
    expect(processedFrames[0]).toBeGreaterThan(0);

    await executeCamAction("stop_watch", { name: "cam1" }, deps);
  });

  it("set_sampling keeps live unified timestamps monotonic across rapid restarts", async () => {
    _resetActiveWatches();
    const processedFrames: number[] = [];
    const deps = makeSourceDeps({
      createLiveMediaSource: vi.fn(() => ({
        start: vi.fn(() => new Promise<void>(() => {})),
        close: vi.fn(),
      })),
      onFrameProcessed: vi.fn((frame) => {
        processedFrames.push(frame.timestamp);
      }),
    });

    await executeCamAction("watch", { name: "cam1", mode: "stream" }, deps);
    const firstMediaArgs = vi.mocked(deps.createLiveMediaSource!).mock.calls[0]?.[0] as {
      onVideoFrame: (frame: { jpeg: Buffer; ptsMs: number }) => void | Promise<void>;
    };
    await firstMediaArgs.onVideoFrame({ jpeg: Buffer.from(REAL_JPEG_BASE64, "base64"), ptsMs: 1000 });

    await executeCamAction("set_sampling", { name: "cam1", fps: 5, width: 1280 }, deps);
    await executeCamAction("set_sampling", { name: "cam1", fps: 10, width: 640 }, deps);

    const thirdMediaArgs = vi.mocked(deps.createLiveMediaSource!).mock.calls[2]?.[0] as {
      onVideoFrame: (frame: { jpeg: Buffer; ptsMs: number }) => void | Promise<void>;
    };
    await thirdMediaArgs.onVideoFrame({ jpeg: Buffer.from(REAL_JPEG_BASE64, "base64"), ptsMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deps.createLiveMediaSource).toHaveBeenCalledTimes(3);
    expect(processedFrames).toHaveLength(2);
    expect(processedFrames[1]! - processedFrames[0]!).toBe(300);

    await executeCamAction("stop_watch", { name: "cam1" }, deps);
  });

  it("set_sampling updates live unified full-rate fps without restarting ffmpeg", async () => {
    _resetActiveWatches();
    const deps = makeSourceDeps();
    await executeCamAction("watch", { name: "cam1", mode: "stream", _fullRate: true }, deps);

    const result = await executeCamAction("set_sampling", { name: "cam1", fps: 3, _fullRate: true }, deps);
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.fps).toBe(3);
    expect(parsed.fullRate).toBe(true);
    expect(deps.createLiveMediaSource).toHaveBeenCalledTimes(1);

    await executeCamAction("stop_watch", { name: "cam1" }, deps);
  });

  it("set_sampling switches live unified processing into full-rate mode", async () => {
    _resetActiveWatches();
    const processedFrames: number[] = [];
    const deps = makeSourceDeps({
      createLiveMediaSource: vi.fn(() => ({
        start: vi.fn(() => new Promise<void>(() => {})),
        close: vi.fn(),
      })),
      onFrameProcessed: vi.fn((frame) => {
        processedFrames.push(frame.timestamp);
      }),
    });

    await executeCamAction("watch", { name: "cam1", mode: "stream" }, deps);
    await executeCamAction("set_sampling", { name: "cam1", fps: 3, _fullRate: true }, deps);

    const secondMediaArgs = vi.mocked(deps.createLiveMediaSource!).mock.calls[1]?.[0] as {
      onVideoFrame: (frame: { jpeg: Buffer; ptsMs: number }) => void;
    };
    secondMediaArgs.onVideoFrame({ jpeg: Buffer.from(REAL_JPEG_BASE64, "base64"), ptsMs: 0 });
    secondMediaArgs.onVideoFrame({ jpeg: Buffer.from(REAL_JPEG_BASE64, "base64"), ptsMs: 100 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(processedFrames).toHaveLength(1);
    expect(Number.isFinite(processedFrames[0])).toBe(true);

    await executeCamAction("stop_watch", { name: "cam1" }, deps);
  });

  it("set_sampling switches live unified processing out of full-rate mode", async () => {
    _resetActiveWatches();
    const processedFrames: number[] = [];
    const deps = makeSourceDeps({
      createLiveMediaSource: vi.fn(() => ({
        start: vi.fn(() => new Promise<void>(() => {})),
        close: vi.fn(),
      })),
      onFrameProcessed: vi.fn((frame) => {
        processedFrames.push(frame.timestamp);
      }),
    });

    await executeCamAction("watch", { name: "cam1", mode: "stream", _fullRate: true }, deps);
    await executeCamAction("set_sampling", { name: "cam1", _fullRate: false }, deps);

    const secondMediaArgs = vi.mocked(deps.createLiveMediaSource!).mock.calls[1]?.[0] as {
      onVideoFrame: (frame: { jpeg: Buffer; ptsMs: number }) => void;
    };
    secondMediaArgs.onVideoFrame({ jpeg: Buffer.from(REAL_JPEG_BASE64, "base64"), ptsMs: 0 });
    secondMediaArgs.onVideoFrame({ jpeg: Buffer.from(REAL_JPEG_BASE64, "base64"), ptsMs: 100 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(processedFrames).toHaveLength(2);
    expect(processedFrames[1]! - processedFrames[0]!).toBe(100);

    await executeCamAction("stop_watch", { name: "cam1" }, deps);
  });

  it("switch_mode updates live unified media source fps like the legacy extractor", async () => {
    _resetActiveWatches();
    const liveSources: Array<{ start: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
    const deps = makeSourceDeps({
      createLiveMediaSource: vi.fn(() => {
        const source = {
          start: vi.fn(() => new Promise<void>(() => {})),
          close: vi.fn(),
        };
        liveSources.push(source);
        return source;
      }),
    });

    await executeCamAction("watch", { name: "cam1", mode: "stream", fps: 10 }, deps);
    const result = await executeCamAction("switch_mode", { name: "cam1", mode: "event" }, deps);
    const parsed = JSON.parse(result);

    expect(parsed.status).toBe("switched");
    expect(parsed.fps).toBe(5);
    expect(deps.createLiveMediaSource).toHaveBeenCalledTimes(2);
    expect(deps.createLiveMediaSource).toHaveBeenLastCalledWith(expect.objectContaining({ fps: 5 }));
    expect(liveSources[0]?.close).toHaveBeenCalled();

    await executeCamAction("stop_watch", { name: "cam1" }, deps);
  });

  it("switch_mode enables VAD when switching an event watch to stream", async () => {
    _resetActiveWatches();
    const vadSession = {
      isAvailable: true,
      feedChunk: vi.fn(() => ({ isSpeaking: false, segments: [] })),
      flush: vi.fn(() => []),
      dispose: vi.fn(),
    };
    const sileroVad = {
      isAvailable: true,
      createSession: vi.fn().mockResolvedValue(vadSession),
    };
    const deps = makeSourceDeps({
      sileroVad: sileroVad as unknown as SileroVad,
      createLiveMediaSource: vi.fn(() => ({
        start: vi.fn(() => new Promise<void>(() => {})),
        close: vi.fn(),
      })),
    });

    await executeCamAction("watch", { name: "cam1", mode: "event", fps: 5 }, deps);
    expect(sileroVad.createSession).not.toHaveBeenCalled();

    const result = await executeCamAction("switch_mode", { name: "cam1", mode: "stream" }, deps);
    expect(JSON.parse(result)).toMatchObject({ status: "switched", mode: "stream", fps: 5 });
    expect(sileroVad.createSession).toHaveBeenCalledTimes(1);

    await executeCamAction("stop_watch", { name: "cam1" }, deps);
  });

  it("set_sampling can switch legacy fallback watch into full-rate mode", async () => {
    vi.useFakeTimers();
    try {
      _resetActiveWatches();
      let extractionOptions: any;
      const processedFrames: number[] = [];
      const frameExtractor = {
        ...mockFrameExtractor,
        startExtraction: vi.fn((_id: string, opts: any) => {
          extractionOptions = opts;
        }),
        updateExtraction: vi.fn((_id: string, opts: any) => {
          extractionOptions = { ...extractionOptions, ...opts };
        }),
        getExtractionOptions: vi.fn(() => extractionOptions
          ? { ...extractionOptions, fps: 1, width: 960, height: 540, fullRate: false }
          : null),
      } as unknown as FrameExtractor;
      const deps = makeSourceDeps({
        frameExtractor,
        createLiveMediaSource: vi.fn(() => ({
          start: vi.fn().mockRejectedValue(new Error("ffmpeg failed")),
          close: vi.fn(),
        })),
        onFrameProcessed: vi.fn((frame) => {
          processedFrames.push(frame.timestamp);
        }),
      });

      await executeCamAction("watch", { name: "cam1", mode: "stream" }, deps);
      await exhaustLiveUnifiedRestartBudget();
      const result = await executeCamAction("set_sampling", { name: "cam1", _fullRate: true }, deps);

      expect(JSON.parse(result).fullRate).toBe(true);
      expect(frameExtractor.updateExtraction).toHaveBeenCalledWith(
        "cam1",
        expect.objectContaining({ fullRate: true }),
      );
      await extractionOptions.onFrame({ data: REAL_JPEG_BASE64, timestamp: 0, source_name: "cam1" });
      await extractionOptions.onFrame({ data: REAL_JPEG_BASE64, timestamp: 100, source_name: "cam1" });
      expect(processedFrames).toEqual([0]);

      await executeCamAction("stop_watch", { name: "cam1" }, deps);
    } finally {
      _resetActiveWatches();
      vi.useRealTimers();
    }
  });

  it("legacy fallback full-rate decimation uses legacy fps after set_sampling", async () => {
    vi.useFakeTimers();
    try {
      _resetActiveWatches();
      let extractionFps = 1;
      let extractionOptions: any;
      const processedFrames: number[] = [];
      const frameExtractor = {
        ...mockFrameExtractor,
        startExtraction: vi.fn((_id: string, opts: any) => {
          extractionOptions = opts;
          extractionFps = opts.fps;
        }),
        updateExtractionFpsOnly: vi.fn((_id: string, fps: number) => {
          extractionFps = fps;
        }),
        updateExtraction: vi.fn(),
        getExtractionOptions: vi.fn(() => extractionOptions
          ? { ...extractionOptions, fps: extractionFps, width: 960, height: 540, fullRate: true }
          : null),
      } as unknown as FrameExtractor;
      const deps = makeSourceDeps({
        frameExtractor,
        createLiveMediaSource: vi.fn(() => ({
          start: vi.fn().mockRejectedValue(new Error("ffmpeg failed")),
          close: vi.fn(),
        })),
        onFrameProcessed: vi.fn((frame) => {
          processedFrames.push(frame.timestamp);
        }),
      });

      await executeCamAction("watch", { name: "cam1", mode: "stream", _fullRate: true }, deps);
      await exhaustLiveUnifiedRestartBudget();
      await executeCamAction("set_sampling", { name: "cam1", fps: 5, _fullRate: true }, deps);

      await extractionOptions.onFrame({ data: REAL_JPEG_BASE64, timestamp: 0, source_name: "cam1" });
      await extractionOptions.onFrame({ data: REAL_JPEG_BASE64, timestamp: 250, source_name: "cam1" });

      expect(frameExtractor.updateExtractionFpsOnly).toHaveBeenCalledWith("cam1", 5);
      expect(processedFrames).toEqual([0, 250]);

      await executeCamAction("stop_watch", { name: "cam1" }, deps);
    } finally {
      _resetActiveWatches();
      vi.useRealTimers();
    }
  });

  it("set_sampling can switch legacy fallback watch out of full-rate mode", async () => {
    vi.useFakeTimers();
    try {
      _resetActiveWatches();
      const frameExtractor = {
        ...mockFrameExtractor,
        startExtraction: vi.fn(),
        updateExtraction: vi.fn(),
        updateExtractionFpsOnly: vi.fn(),
        getExtractionOptions: vi.fn().mockReturnValue({ fps: 1, width: 960, height: 540, fullRate: true, onFrame: () => {} }),
      } as unknown as FrameExtractor;
      const deps = makeSourceDeps({
        frameExtractor,
        createLiveMediaSource: vi.fn(() => ({
          start: vi.fn().mockRejectedValue(new Error("ffmpeg failed")),
          close: vi.fn(),
        })),
      });

      await executeCamAction("watch", { name: "cam1", mode: "stream", _fullRate: true }, deps);
      await exhaustLiveUnifiedRestartBudget();
      const result = await executeCamAction("set_sampling", { name: "cam1", _fullRate: false }, deps);

      expect(JSON.parse(result).fullRate).toBe(false);
      expect(frameExtractor.updateExtractionFpsOnly).not.toHaveBeenCalled();
      expect(frameExtractor.updateExtraction).toHaveBeenCalledWith(
        "cam1",
        expect.objectContaining({ fullRate: false }),
      );

      await executeCamAction("stop_watch", { name: "cam1" }, deps);
    } finally {
      _resetActiveWatches();
      vi.useRealTimers();
    }
  });

  it("live_view returns streaming URL with LAN IP", async () => {
    const deps = makeSourceDeps();
    const result = await executeCamAction("live_view", { name: "cam1" }, deps);
    const parsed = JSON.parse(result);
    expect(parsed.source_id).toBe("cam1");
    expect(parsed.live_url).toContain("/stream.html?src=cam1");
    expect(parsed.live_url).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\//);
    expect(parsed.message).toContain(parsed.live_url);
  });

  it("live_view returns error for unknown source", async () => {
    const result = await executeCamAction("live_view", { name: "nope" }, makeDeps());
    expect(JSON.parse(result).error).toContain("not found");
  });

  it("live_view uses configured go2rtc port", async () => {
    const deps = makeSourceDeps({ config: { go2rtc_api_port: 9999 } as any });
    const result = await executeCamAction("live_view", { name: "cam1" }, deps);
    expect(JSON.parse(result).live_url).toContain(":9999/");
  });

  it("live_view returns error for phone source without active watch", async () => {
    _resetActiveWatches();
    const phoneCam = { ...CAM, protocol: "phone" as const, input: "phone" };
    const deps = makeDeps({
      sourceManager: {
        ...mockSourceManager,
        getSource: vi.fn().mockReturnValue(phoneCam),
        resolveId: vi.fn().mockReturnValue("cam1"),
      } as unknown as SourceManager,
    });
    const result = await executeCamAction("live_view", { name: "cam1" }, deps);
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("start a watch first");
  });

  it("live_view returns error for webcam source without active watch", async () => {
    _resetActiveWatches();
    const webcamCam = { ...CAM, protocol: "ffmpeg" as const, input: "webcam" };
    const deps = makeDeps({
      sourceManager: {
        ...mockSourceManager,
        getSource: vi.fn().mockReturnValue(webcamCam),
        resolveId: vi.fn().mockReturnValue("cam1"),
      } as unknown as SourceManager,
    });
    const result = await executeCamAction("live_view", { name: "cam1" }, deps);
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("start a watch first");
  });

  it("QRCode.toDataURL generates valid data URL", async () => {
    // Unit test the QR generation directly — phone add_source depends on clawcam
    // which can't be mocked in ESM. Verify the QR library works correctly.
    const QRCode = await import("qrcode");
    const url = "https://rtc.reflect.world/node/abc123";
    const dataUrl = await QRCode.toDataURL(url, { width: 256, margin: 2 });
    expect(dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(dataUrl.length).toBeGreaterThan(100);
  });

  it("unknown action returns error", async () => {
    const result = await executeCamAction("bad_action" as any, {}, makeDeps());
    expect(JSON.parse(result).error).toContain("Unknown action");
  });
});
