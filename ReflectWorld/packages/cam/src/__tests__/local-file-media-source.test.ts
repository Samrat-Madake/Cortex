import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import {
  buildFfprobeArgs,
  buildLocalFileMediaArgs,
  LocalFileMediaSource,
  parseFfprobeMediaInfo,
} from "../local-file-media-source.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const mockSpawn = vi.mocked(spawn);

function makeFakeProcess(hasAudio = false) {
  const proc = new EventEmitter() as any;
  const originalEmit = proc.emit.bind(proc);
  proc.emit = (event: string | symbol, ...args: any[]) => {
    if (event === "exit") {
      proc.stdout.push(null);
      proc.stderr.push(null);
      if (hasAudio) proc.stdio[3].push(null);
    }
    return originalEmit(event, ...args);
  };
  proc.kill = vi.fn(() => {
    proc.emit("exit", 0);
    return true;
  });
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.stdio = hasAudio
    ? [null, proc.stdout, proc.stderr, new Readable({ read() {} })]
    : [null, proc.stdout, proc.stderr];
  return proc;
}

function makeJpeg(seed = 1): Buffer {
  return Buffer.from([0xff, 0xd8, seed, 0xff, 0xd9]);
}

function ffprobeJson(options: { videoStart?: number; audioStart?: number; hasAudio?: boolean } = {}): string {
  const streams: Array<Record<string, string | number>> = [
    { index: 0, codec_type: "video", start_time: String(options.videoStart ?? 0) },
  ];
  if (options.hasAudio !== false) {
    streams.push({ index: 1, codec_type: "audio", start_time: String(options.audioStart ?? 0) });
  }
  return JSON.stringify({ streams });
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("LocalFileMediaSource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds ffprobe args for stream start times", () => {
    expect(buildFfprobeArgs("/tmp/in.mp4")).toEqual([
      "-v", "error",
      "-show_entries", "stream=index,codec_type,start_time",
      "-of", "json",
      "/tmp/in.mp4",
    ]);
  });

  it("parses media probe info and derives audio offset on video-normalized timeline", () => {
    const info = parseFfprobeMediaInfo(ffprobeJson({ videoStart: 1.25, audioStart: 1.5 }));
    expect(info).toEqual({
      hasAudio: true,
      videoStartTimeMs: 1250,
      audioStartTimeMs: 1500,
      audioStartPtsMs: 250,
    });
  });

  it("builds sampled ffmpeg args with select preserving the first frame", () => {
    const args = buildLocalFileMediaArgs({
      videoPath: "/tmp/in.mp4",
      fps: 2,
      pacing: "fast",
      fullRate: false,
      hasAudio: true,
      sampleRate: 16000,
    });

    expect(args.slice(0, 2)).toEqual(["-i", "/tmp/in.mp4"]);
    expect(args).not.toContain("-re");
    expect(args).toContain("-fps_mode");
    expect(args).not.toContain("-vsync");
    expect(args).toContain("drop");
    expect(args).toContain("pipe:3");
    expect(args.join(" ")).toContain("select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,0.500000)'");
    expect(args.join(" ")).toContain("showinfo");
  });

  it("applies max duration before input so video and audio are bounded together", () => {
    const args = buildLocalFileMediaArgs({
      videoPath: "/tmp/in.mp4",
      fps: 1,
      pacing: "fast",
      fullRate: false,
      hasAudio: true,
      maxDurationSec: 12.5,
    });

    expect(args.slice(0, 4)).toEqual(["-t", "12.5", "-i", "/tmp/in.mp4"]);
  });

  it("can preserve max-short-edge scaling for benchmark auxiliary frame sources", () => {
    const args = buildLocalFileMediaArgs({
      videoPath: "/tmp/in.mp4",
      fps: 1,
      pacing: "fast",
      fullRate: false,
      hasAudio: false,
      maxShortEdge: 512,
    });

    expect(args.join(" ")).toContain("if(gt(iw,ih),if(gt(ih,512),512*iw/ih,-2)");
  });

  it("builds realtime full-rate args without select and omits audio output when hasAudio=false", () => {
    const args = buildLocalFileMediaArgs({
      videoPath: "/tmp/in.mp4",
      fps: 2,
      pacing: "realtime",
      fullRate: true,
      hasAudio: false,
    });

    expect(args.slice(0, 3)).toEqual(["-re", "-i", "/tmp/in.mp4"]);
    expect(args.join(" ")).not.toContain("select=");
    expect(args).not.toContain("pipe:3");
  });

  it("emits video frames on a video-normalized timeline", async () => {
    const probeProc = makeFakeProcess();
    const ffmpegProc = makeFakeProcess(false);
    mockSpawn
      .mockReturnValueOnce(probeProc as never)
      .mockReturnValueOnce(ffmpegProc as never);
    const onVideoFrame = vi.fn();
    const source = new LocalFileMediaSource({
      videoPath: "/tmp/in.mp4",
      fps: 1,
      pacing: "fast",
      ffmpegBin: "ffmpeg",
      ffprobeBin: "ffprobe",
      onVideoFrame,
    });

    const started = source.start();
    probeProc.stdout.emit("data", Buffer.from(ffprobeJson({ videoStart: 10, hasAudio: false })));
    probeProc.emit("exit", 0);
    await settle();

    ffmpegProc.stderr.emit("data", Buffer.from("n:0 pts_time:10.250\n"));
    ffmpegProc.stdout.emit("data", makeJpeg(7));
    ffmpegProc.emit("exit", 0);
    await started;

    expect(onVideoFrame).toHaveBeenCalledTimes(1);
    expect(onVideoFrame.mock.calls[0]?.[0]).toMatchObject({ ptsMs: 250 });
  });

  it("handles showinfo PTS split across stderr chunks", async () => {
    const probeProc = makeFakeProcess();
    const ffmpegProc = makeFakeProcess(false);
    mockSpawn
      .mockReturnValueOnce(probeProc as never)
      .mockReturnValueOnce(ffmpegProc as never);
    const onVideoFrame = vi.fn();
    const source = new LocalFileMediaSource({
      videoPath: "/tmp/in.mp4",
      fps: 1,
      pacing: "fast",
      onVideoFrame,
    });

    const started = source.start();
    probeProc.stdout.emit("data", Buffer.from(ffprobeJson({ videoStart: 10, hasAudio: false })));
    probeProc.emit("exit", 0);
    await settle();

    ffmpegProc.stdout.emit("data", makeJpeg(8));
    ffmpegProc.stderr.emit("data", Buffer.from("n:0 pts_time:10."));
    ffmpegProc.stderr.emit("data", Buffer.from("500\n"));
    ffmpegProc.emit("exit", 0);
    await started;

    expect(onVideoFrame).toHaveBeenCalledTimes(1);
    expect(onVideoFrame.mock.calls[0]?.[0]).toMatchObject({ ptsMs: 500 });
  });

  it("does not pause video stdout while complete frames wait for matching PTS", async () => {
    const probeProc = makeFakeProcess();
    const ffmpegProc = makeFakeProcess(false);
    mockSpawn
      .mockReturnValueOnce(probeProc as never)
      .mockReturnValueOnce(ffmpegProc as never);
    const onVideoFrame = vi.fn();
    const source = new LocalFileMediaSource({
      videoPath: "/tmp/in.mp4",
      fps: 1,
      pacing: "fast",
      onVideoFrame,
    });

    const started = source.start();
    probeProc.stdout.emit("data", Buffer.from(ffprobeJson({ videoStart: 0, hasAudio: false })));
    probeProc.emit("exit", 0);
    await settle();

    ffmpegProc.stdout.emit("data", makeJpeg(9));
    await settle();
    expect(ffmpegProc.stdout.isPaused()).toBe(false);
    expect(onVideoFrame).not.toHaveBeenCalled();

    ffmpegProc.stderr.emit("data", Buffer.from("n:0 pts_time:1\n"));
    await settle();
    expect(onVideoFrame).toHaveBeenCalledTimes(1);
    expect(ffmpegProc.stdout.isPaused()).toBe(false);

    ffmpegProc.emit("exit", 0);
    await started;
  });

  it("keeps video stdout paused until the latest queued callback drains", async () => {
    const probeProc = makeFakeProcess();
    const ffmpegProc = makeFakeProcess(false);
    mockSpawn
      .mockReturnValueOnce(probeProc as never)
      .mockReturnValueOnce(ffmpegProc as never);
    let releaseSecond!: () => void;
    const secondBlocked = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const onVideoFrame = vi.fn((frame) => frame.ptsMs === 1000 ? secondBlocked : undefined);
    const source = new LocalFileMediaSource({
      videoPath: "/tmp/in.mp4",
      fps: 1,
      pacing: "fast",
      onVideoFrame,
    });

    const started = source.start();
    probeProc.stdout.emit("data", Buffer.from(ffprobeJson({ videoStart: 0, hasAudio: false })));
    probeProc.emit("exit", 0);
    await settle();

    ffmpegProc.stdout.emit("data", Buffer.concat([makeJpeg(1), makeJpeg(2)]));
    ffmpegProc.stderr.emit("data", Buffer.from("n:0 pts_time:0\n"));
    ffmpegProc.stderr.emit("data", Buffer.from("n:1 pts_time:1\n"));
    await settle();
    await settle();

    expect(onVideoFrame).toHaveBeenCalledTimes(2);
    expect(ffmpegProc.stdout.isPaused()).toBe(true);

    releaseSecond();
    await settle();
    ffmpegProc.emit("exit", 0);
    await started;

    expect(ffmpegProc.stdout.isPaused()).toBe(false);
  });

  it("drains video stdout buffered while paused before completing", async () => {
    const probeProc = makeFakeProcess();
    const ffmpegProc = makeFakeProcess(false);
    mockSpawn
      .mockReturnValueOnce(probeProc as never)
      .mockReturnValueOnce(ffmpegProc as never);
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const onVideoFrame = vi.fn((frame) => frame.ptsMs === 0 ? firstBlocked : undefined);
    const source = new LocalFileMediaSource({
      videoPath: "/tmp/in.mp4",
      fps: 1,
      pacing: "fast",
      onVideoFrame,
    });

    const started = source.start();
    probeProc.stdout.emit("data", Buffer.from(ffprobeJson({ videoStart: 0, hasAudio: false })));
    probeProc.emit("exit", 0);
    await settle();

    ffmpegProc.stderr.emit("data", Buffer.from("n:0 pts_time:0\n"));
    ffmpegProc.stdout.emit("data", makeJpeg(1));
    await settle();
    expect(onVideoFrame).toHaveBeenCalledTimes(1);
    expect(ffmpegProc.stdout.isPaused()).toBe(true);

    ffmpegProc.stderr.emit("data", Buffer.from("n:1 pts_time:1\n"));
    ffmpegProc.stdout.push(makeJpeg(2));
    ffmpegProc.emit("exit", 0);
    await settle();
    expect(onVideoFrame).toHaveBeenCalledTimes(1);

    releaseFirst();
    await started;

    expect(onVideoFrame).toHaveBeenCalledTimes(2);
    expect(onVideoFrame.mock.calls[1]?.[0]).toMatchObject({ ptsMs: 1000 });
  });

  it("does not run queued video callbacks after close", async () => {
    const probeProc = makeFakeProcess();
    const ffmpegProc = makeFakeProcess(false);
    mockSpawn
      .mockReturnValueOnce(probeProc as never)
      .mockReturnValueOnce(ffmpegProc as never);
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const onVideoFrame = vi.fn((frame) => frame.ptsMs === 0 ? firstBlocked : undefined);
    const source = new LocalFileMediaSource({
      videoPath: "/tmp/in.mp4",
      fps: 1,
      pacing: "fast",
      onVideoFrame,
    });

    const started = source.start();
    probeProc.stdout.emit("data", Buffer.from(ffprobeJson({ videoStart: 0, hasAudio: false })));
    probeProc.emit("exit", 0);
    await settle();

    ffmpegProc.stdout.emit("data", Buffer.concat([makeJpeg(1), makeJpeg(2)]));
    ffmpegProc.stderr.emit("data", Buffer.from("n:0 pts_time:0\nn:1 pts_time:1\n"));
    await settle();
    expect(onVideoFrame).toHaveBeenCalledTimes(1);

    source.close();
    releaseFirst();
    await started;

    expect(onVideoFrame).toHaveBeenCalledTimes(1);
    expect(ffmpegProc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("propagates video callback failures instead of swallowing them with later frames", async () => {
    const probeProc = makeFakeProcess();
    const ffmpegProc = makeFakeProcess(false);
    mockSpawn
      .mockReturnValueOnce(probeProc as never)
      .mockReturnValueOnce(ffmpegProc as never);
    const onVideoFrame = vi.fn((frame) => {
      if (frame.ptsMs === 0) throw new Error("callback failed");
    });
    const source = new LocalFileMediaSource({
      videoPath: "/tmp/in.mp4",
      fps: 1,
      pacing: "fast",
      onVideoFrame,
    });

    const started = source.start();
    const failed = expect(started).rejects.toThrow("callback failed");
    probeProc.stdout.emit("data", Buffer.from(ffprobeJson({ videoStart: 0, hasAudio: false })));
    probeProc.emit("exit", 0);
    await settle();

    ffmpegProc.stderr.emit("data", Buffer.from("n:0 pts_time:0\nn:1 pts_time:1\n"));
    ffmpegProc.stdout.emit("data", Buffer.concat([makeJpeg(1), makeJpeg(2)]));
    await settle();
    ffmpegProc.emit("exit", 0);

    await failed;
    expect(onVideoFrame).toHaveBeenCalledTimes(1);
  });

  it("rejects when ffmpeg exits due to an unexpected signal", async () => {
    const probeProc = makeFakeProcess();
    const ffmpegProc = makeFakeProcess(false);
    mockSpawn
      .mockReturnValueOnce(probeProc as never)
      .mockReturnValueOnce(ffmpegProc as never);
    const source = new LocalFileMediaSource({
      videoPath: "/tmp/in.mp4",
      fps: 1,
      pacing: "fast",
      onVideoFrame: vi.fn(),
    });

    const started = source.start();
    probeProc.stdout.emit("data", Buffer.from(ffprobeJson({ videoStart: 0, hasAudio: false })));
    probeProc.emit("exit", 0);
    await settle();

    ffmpegProc.emit("exit", null, "SIGKILL");
    await expect(started).rejects.toThrow("ffmpeg exited with signal SIGKILL");
  });

  it("propagates audio callback failures and terminates ffmpeg", async () => {
    const probeProc = makeFakeProcess();
    const ffmpegProc = makeFakeProcess(true);
    mockSpawn
      .mockReturnValueOnce(probeProc as never)
      .mockReturnValueOnce(ffmpegProc as never);
    const source = new LocalFileMediaSource({
      videoPath: "/tmp/in.mp4",
      fps: 1,
      pacing: "fast",
      onVideoFrame: vi.fn(),
      onAudioChunk: () => {
        throw new Error("audio callback failed");
      },
    });

    const started = source.start();
    const failed = expect(started).rejects.toThrow("audio callback failed");
    probeProc.stdout.emit("data", Buffer.from(ffprobeJson({ videoStart: 0, hasAudio: true })));
    probeProc.emit("exit", 0);
    await settle();

    ffmpegProc.stdio[3].emit("data", Buffer.alloc(320));
    await settle();
    ffmpegProc.emit("exit", 0);

    await failed;
    expect(ffmpegProc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("emits audio chunks with positive and negative offsets", async () => {
    const probeProc = makeFakeProcess();
    const ffmpegProc = makeFakeProcess(true);
    mockSpawn
      .mockReturnValueOnce(probeProc as never)
      .mockReturnValueOnce(ffmpegProc as never);
    const onVideoFrame = vi.fn();
    const onAudioChunk = vi.fn();
    const source = new LocalFileMediaSource({
      videoPath: "/tmp/in.mp4",
      fps: 1,
      pacing: "fast",
      sampleRate: 16000,
      onVideoFrame,
      onAudioChunk,
    });

    const started = source.start();
    probeProc.stdout.emit("data", Buffer.from(ffprobeJson({ videoStart: 2, audioStart: 1.5 })));
    probeProc.emit("exit", 0);
    await settle();

    ffmpegProc.stdio[3].emit("data", Buffer.alloc(320)); // 160 samples = 10ms
    ffmpegProc.stdio[3].emit("data", Buffer.alloc(320));
    ffmpegProc.emit("exit", 0);
    await started;

    expect(onAudioChunk).toHaveBeenCalledTimes(2);
    expect(onAudioChunk.mock.calls[0]?.[0]).toMatchObject({ ptsMs: -500 });
    expect(onAudioChunk.mock.calls[1]?.[0]).toMatchObject({ ptsMs: -490 });
  });

  it("does not call onAudioChunk for no-audio files and spawns ffmpeg with two output fds", async () => {
    const probeProc = makeFakeProcess();
    const ffmpegProc = makeFakeProcess(false);
    mockSpawn
      .mockReturnValueOnce(probeProc as never)
      .mockReturnValueOnce(ffmpegProc as never);
    const onAudioChunk = vi.fn();
    const source = new LocalFileMediaSource({
      videoPath: "/tmp/no-audio.mp4",
      fps: 1,
      pacing: "fast",
      onVideoFrame: vi.fn(),
      onAudioChunk,
    });

    const started = source.start();
    probeProc.stdout.emit("data", Buffer.from(ffprobeJson({ videoStart: 0, hasAudio: false })));
    probeProc.emit("exit", 0);
    await settle();
    ffmpegProc.emit("exit", 0);
    await started;

    const ffmpegOptions = mockSpawn.mock.calls[1]?.[2] as { stdio?: unknown[] };
    expect(ffmpegOptions.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(onAudioChunk).not.toHaveBeenCalled();
  });
});
