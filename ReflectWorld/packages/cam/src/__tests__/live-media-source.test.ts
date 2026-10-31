import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildLiveMediaArgs, LiveMediaSource, parseLiveShowinfo } from "../live-media-source.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

const mockSpawn = vi.mocked(spawn);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeFakeProcess(options?: { audio?: boolean }) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const audio = new PassThrough();
  const proc = new EventEmitter() as any;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.stdio = options?.audio === false
    ? ["ignore", stdout, stderr]
    : ["ignore", stdout, stderr, audio];
  proc.exitCode = null;
  proc.signalCode = null;
  proc.kill = vi.fn((signal?: NodeJS.Signals) => {
    proc.signalCode = signal ?? "SIGTERM";
    stdout.end();
    stderr.end();
    audio.end();
    proc.emit("exit", null, proc.signalCode);
    return true;
  });
  return { proc, stdout, stderr, audio };
}

describe("LiveMediaSource", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it("builds a single ffmpeg demux command for video and audio", () => {
    const args = buildLiveMediaArgs({
      inputUrl: "rtsp://127.0.0.1:8554/cam1",
      fps: 2,
      width: 960,
      height: 540,
    });

    expect(args).toContain("-rtsp_transport");
    expect(args.filter((arg) => arg === "-i")).toHaveLength(1);
    expect(args).toContain("rtsp://127.0.0.1:8554/cam1");
    expect(args).toContain("pipe:1");
    expect(args).toContain("pipe:3");
    expect(args).toContain("0:a?");
    expect(args).toContain("-fps_mode");
    expect(args).toContain("drop");
    const vf = args[args.indexOf("-vf") + 1];
    expect(vf).toContain("setpts=PTS-STARTPTS");
    expect(vf).toContain("select=");
    expect(vf).toContain("showinfo");
    const af = args[args.indexOf("-af") + 1];
    expect(af).toContain("aresample=async=1:first_pts=0");
    expect(af).toContain("ashowinfo");
  });

  it("uses full-rate video when requested", () => {
    const args = buildLiveMediaArgs({
      inputUrl: "http://example.com/live.m3u8",
      fps: 2,
      width: 960,
      height: 540,
      fullRate: true,
    });

    expect(args).not.toContain("-rtsp_transport");
    const vf = args[args.indexOf("-vf") + 1];
    expect(vf).toContain("setpts=PTS-STARTPTS");
    expect(vf).not.toContain("select=");
  });

  it("supports UDP RTSP transport for phone-style sources", () => {
    const args = buildLiveMediaArgs({
      inputUrl: "rtsp://127.0.0.1:19052/cam",
      fps: 1,
      width: 640,
      height: 360,
      rtspTransport: "udp",
    });

    expect(args.slice(0, 2)).toEqual(["-rtsp_transport", "udp"]);
  });

  it("can build a video-only command for streams without audio", () => {
    const args = buildLiveMediaArgs({
      inputUrl: "rtsp://127.0.0.1:8554/noaudio",
      fps: 1,
      width: 640,
      height: 360,
      audio: false,
    });

    expect(args).toContain("pipe:1");
    expect(args).not.toContain("pipe:3");
    expect(args).not.toContain("0:a?");
    expect(args).not.toContain("-af");
  });

  it("parses video and audio showinfo lines independently", () => {
    const parsed = parseLiveShowinfo([
      "[Parsed_showinfo_1 @ x] n:0 pts:0 pts_time:0.000000 pos:0",
      "[Parsed_ashowinfo_2 @ x] n:0 pts:0 pts_time:0.032000 pos:0",
      "[Parsed_showinfo_1 @ x] n:1 pts:1000 pts_time:1.000000 pos:1",
      "[Parsed_ashowinfo_2 @ x] n:1 pts:512 pts_time:0.064000",
      "partial pts_time:2.000",
    ].join("\n"));

    expect(parsed.videoPtsMs).toEqual([0, 1000]);
    expect(parsed.audioPtsMs).toEqual([32, 64]);
    expect(parsed.remaining).toBe("partial pts_time:2.000");
  });

  it("pauses video stdout while downstream frame processing is pending", async () => {
    const fake = makeFakeProcess();
    mockSpawn.mockReturnValue(fake.proc);
    let releaseFrame!: () => void;
    const frames: number[] = [];
    const source = new LiveMediaSource({
      inputUrl: "rtsp://127.0.0.1:8554/cam1",
      fps: 1,
      width: 160,
      height: 90,
      onVideoFrame: (frame) => new Promise<void>((resolve) => {
        frames.push(frame.ptsMs);
        releaseFrame = resolve;
      }),
    });

    const running = source.start();
    fake.stderr.write("[Parsed_showinfo_0 @ x] n:0 pts:0 pts_time:0.000000 pos:0\n");
    fake.stdout.write(JPEG);
    await nextTick();

    expect(frames).toEqual([0]);
    expect(fake.stdout.isPaused()).toBe(true);

    releaseFrame();
    await nextTick();
    expect(fake.stdout.isPaused()).toBe(false);

    source.close();
    await running;
  });

  it("pauses audio stdout while downstream audio processing is pending", async () => {
    const fake = makeFakeProcess();
    mockSpawn.mockReturnValue(fake.proc);
    let releaseAudio!: () => void;
    let audioChunks = 0;
    const source = new LiveMediaSource({
      inputUrl: "rtsp://127.0.0.1:8554/cam1",
      fps: 1,
      width: 160,
      height: 90,
      onVideoFrame: () => {},
      onAudioChunk: () => new Promise<void>((resolve) => {
        audioChunks += 1;
        releaseAudio = resolve;
      }),
    });

    const running = source.start();
    fake.audio.write(Buffer.alloc(512 * 2));
    await nextTick();

    expect(audioChunks).toBe(1);
    expect(fake.audio.isPaused()).toBe(true);

    releaseAudio();
    await nextTick();
    expect(fake.audio.isPaused()).toBe(false);

    source.close();
    await running;
  });

  it("normalizes non-monotonic live video PTS before emitting frames", async () => {
    const fake = makeFakeProcess();
    mockSpawn.mockReturnValue(fake.proc);
    const frames: number[] = [];
    const source = new LiveMediaSource({
      inputUrl: "rtsp://127.0.0.1:8554/cam1",
      fps: 1,
      width: 160,
      height: 90,
      onVideoFrame: (frame) => {
        frames.push(frame.ptsMs);
      },
    });

    const running = source.start();
    fake.stderr.write([
      "[Parsed_showinfo_0 @ x] n:0 pts:1000 pts_time:1.000000 pos:0",
      "[Parsed_showinfo_0 @ x] n:1 pts:500 pts_time:0.500000 pos:1",
      "",
    ].join("\n"));
    fake.stdout.write(Buffer.concat([JPEG, JPEG]));
    await nextTick();

    expect(frames).toEqual([0, 1000]);

    source.close();
    await running;
  });

  it("synthesizes bounded fallback PTS when JPEG frames outrun showinfo lines", async () => {
    const fake = makeFakeProcess();
    mockSpawn.mockReturnValue(fake.proc);
    const frames: number[] = [];
    const source = new LiveMediaSource({
      inputUrl: "rtsp://127.0.0.1:8554/cam1",
      fps: 1,
      width: 160,
      height: 90,
      onVideoFrame: (frame) => {
        frames.push(frame.ptsMs);
      },
    });

    const running = source.start();
    fake.stdout.write(Buffer.concat(Array.from({ length: 31 }, () => JPEG)));
    await nextTick();

    expect(frames).toEqual([0]);
    expect(fake.stdout.isPaused()).toBe(false);

    source.close();
    await running;
  });
});
