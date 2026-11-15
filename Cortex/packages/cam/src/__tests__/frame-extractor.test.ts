import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter, Readable } from "node:stream";
import { FrameExtractor, splitJpegFrames, splitJpegFramesWithRemainder } from "../frame-extractor.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";

const mockSpawn = vi.mocked(spawn);

function makeFakeProcess() {
  const proc = new EventEmitter() as any;
  proc.pid = 42;
  proc.kill = vi.fn(() => {
    proc.emit("exit", 0);
    return true;
  });
  proc.stdin = new EventEmitter();
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  return proc;
}

function makeJpeg(seed = 1): Buffer {
  return Buffer.from([0xff, 0xd8, seed, 0xff, 0xd9]);
}

describe("splitJpegFrames", () => {
  it("splits buffer with two JPEG frames", () => {
    const combined = Buffer.concat([makeJpeg(1), makeJpeg(2)]);
    expect(splitJpegFrames(combined)).toHaveLength(2);
  });

  it("returns empty for empty buffer", () => {
    expect(splitJpegFrames(Buffer.alloc(0))).toHaveLength(0);
  });

  it("returns a single complete frame", () => {
    expect(splitJpegFrames(makeJpeg(1))).toHaveLength(1);
  });

  it("keeps partial trailing JPEG data for stream parsing", () => {
    const partial = Buffer.from([0xff, 0xd8, 0x03]);
    const result = splitJpegFramesWithRemainder(Buffer.concat([makeJpeg(1), partial]));
    expect(result.frames).toHaveLength(1);
    expect(result.remaining).toEqual(partial);
  });

  it("does not split on embedded SOI bytes before EOI", () => {
    const jpegWithEmbeddedSoi = Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd8, 0x02, 0xff, 0xd9]);
    const result = splitJpegFramesWithRemainder(Buffer.concat([jpegWithEmbeddedSoi, makeJpeg(3)]));
    expect(result.frames).toHaveLength(2);
    expect(result.frames[0]).toEqual(jpegWithEmbeddedSoi);
  });
});

describe("FrameExtractor", () => {
  let extractor: FrameExtractor;

  beforeEach(() => {
    vi.clearAllMocks();
    extractor = new FrameExtractor({
      ffmpegBin: "ffmpeg",
      rtspBase: "rtsp://127.0.0.1:8554",
      healthCheck: {
        initialDelayMs: 10,
        maxDelayMs: 20,
        maxRetries: 2,
      },
    });
  });

  afterEach(() => {
    extractor.stopAll();
    vi.useRealTimers();
  });

  it("startExtraction spawns ffmpeg with -r and -vf scale", () => {
    const proc = makeFakeProcess();
    mockSpawn.mockReturnValue(proc as never);

    extractor.startExtraction("cam1", {
      fps: 2,
      width: 640,
      height: 480,
      onFrame: vi.fn(),
    });

    const args = mockSpawn.mock.calls[0]?.[1] as string[];
    expect(args).toContain("-r");
    expect(args).toContain("2");
    // Aspect-preserving downscale: scale=-2:'min(480,ih)'
    expect(args.some((arg) => arg.includes("scale=") && arg.includes("480"))).toBe(true);
  });

  it("uses image2pipe mjpeg output", () => {
    const proc = makeFakeProcess();
    mockSpawn.mockReturnValue(proc as never);

    extractor.startExtraction("cam1", {
      fps: 1,
      width: 1280,
      height: 720,
      onFrame: vi.fn(),
    });

    const args = mockSpawn.mock.calls[0]?.[1] as string[];
    expect(args).toContain("image2pipe");
    expect(args).toContain("mjpeg");
  });

  it("calls onFrame when stdout receives a complete JPEG", async () => {
    const proc = makeFakeProcess();
    const onFrame = vi.fn();
    mockSpawn.mockReturnValue(proc as never);

    extractor.startExtraction("cam1", {
      fps: 1,
      width: 640,
      height: 480,
      onFrame,
    });

    proc.stdout.push(makeJpeg(1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame.mock.calls[0]?.[0].source_name).toBe("cam1");
  });

  it("awaits async onFrame for local-file backpressure before emitting the next frame", async () => {
    const proc = makeFakeProcess();
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const onFrame = vi.fn((frame) => frame.timestamp === 0 ? firstBlocked : undefined);
    const onBackpressureChange = vi.fn();
    mockSpawn.mockReturnValue(proc as never);

    extractor.startExtraction("cam1", {
      fps: 1,
      width: 640,
      height: 480,
      onFrame,
      inputOverride: "/tmp/input.mp4",
      timestampMode: "pts",
      loopLocalFile: false,
      frameBackpressure: true,
      onBackpressureChange,
    });

    proc.stdout.push(Buffer.concat([makeJpeg(1), makeJpeg(2)]));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(proc.stdout.isPaused()).toBe(true);
    expect(onBackpressureChange).toHaveBeenCalledWith(true);

    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onFrame).toHaveBeenCalledTimes(2);
    expect(proc.stdout.isPaused()).toBe(false);
    expect(onBackpressureChange).toHaveBeenLastCalledWith(false);
  });

  it("fullRate wall_clock media timestamp follows frame time, not Percept fps", async () => {
    const proc = makeFakeProcess();
    const onFrame = vi.fn();
    const nowSpy = vi.spyOn(Date, "now")
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1033);
    mockSpawn.mockReturnValue(proc as never);

    try {
      extractor.startExtraction("cam1", {
        fps: 1,
        width: 640,
        height: 480,
        onFrame,
        timestampMode: "wall_clock",
        fullRate: true,
      });

      proc.stdout.push(makeJpeg(1));
      await new Promise((resolve) => setTimeout(resolve, 0));

      extractor.updateExtractionFpsOnly("cam1", 3);
      proc.stdout.push(makeJpeg(2));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(onFrame).toHaveBeenCalledTimes(2);
      expect(onFrame.mock.calls[0]?.[0].timestamp).toBe(1000);
      expect(onFrame.mock.calls[1]?.[0].timestamp).toBe(1033);
      expect(extractor.getExtractionOptions("cam1")?.fps).toBe(3);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("stopExtraction kills the process", () => {
    const proc = makeFakeProcess();
    mockSpawn.mockReturnValue(proc as never);

    extractor.startExtraction("cam1", {
      fps: 1,
      width: 640,
      height: 480,
      onFrame: vi.fn(),
    });
    extractor.stopExtraction("cam1");

    expect(proc.kill).toHaveBeenCalled();
  });

  it("updateExtraction with width change does full restart", () => {
    const proc1 = makeFakeProcess();
    const proc2 = makeFakeProcess();
    mockSpawn.mockReturnValueOnce(proc1 as never).mockReturnValueOnce(proc2 as never);

    extractor.startExtraction("cam1", {
      fps: 1,
      width: 640,
      height: 480,
      onFrame: vi.fn(),
    });
    extractor.updateExtraction("cam1", {
      fps: 1,
      width: 1920,
      height: 1080,
      onFrame: vi.fn(),
    });

    expect(proc1.kill).toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    const args = mockSpawn.mock.calls[1]?.[1] as string[];
    expect(args.some((arg) => arg.includes("scale=") && arg.includes("1080"))).toBe(true);
  });

  it("updateExtraction with input change and fps change does full restart", () => {
    const proc1 = makeFakeProcess();
    const proc2 = makeFakeProcess();
    mockSpawn.mockReturnValueOnce(proc1 as never).mockReturnValueOnce(proc2 as never);

    extractor.startExtraction("cam1", {
      fps: 1,
      width: 640,
      height: 480,
      onFrame: vi.fn(),
      inputOverride: "/tmp/old.mp4",
      timestampMode: "pts",
    });
    extractor.updateExtraction("cam1", {
      fps: 3,
      width: 640,
      height: 480,
      onFrame: vi.fn(),
      inputOverride: "/tmp/new.mp4",
      timestampMode: "pts",
    });

    expect(proc1.kill).toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    const args = mockSpawn.mock.calls[1]?.[1] as string[];
    expect(args).toContain("/tmp/new.mp4");
  });

  it("updateExtraction with timestamp mode change and fps change does full restart", () => {
    const proc1 = makeFakeProcess();
    const proc2 = makeFakeProcess();
    mockSpawn.mockReturnValueOnce(proc1 as never).mockReturnValueOnce(proc2 as never);

    extractor.startExtraction("cam1", {
      fps: 1,
      width: 640,
      height: 480,
      onFrame: vi.fn(),
    });
    extractor.updateExtraction("cam1", {
      fps: 3,
      width: 640,
      height: 480,
      onFrame: vi.fn(),
      timestampMode: "pts",
    });

    expect(proc1.kill).toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    const args = mockSpawn.mock.calls[1]?.[1] as string[];
    expect(args).toContain("-vf");
    // PTS mode uses select filter instead of fps filter (preserves real PTS).
    // The select filter contains the interval derived from fps=3: 1/3 = 0.333333
    expect(args.some((arg) => arg.includes("select=") && arg.includes("0.333333"))).toBe(true);
  });

  it("isExtracting returns correct state", () => {
    const proc = makeFakeProcess();
    mockSpawn.mockReturnValue(proc as never);

    expect(extractor.isExtracting("cam1")).toBe(false);
    extractor.startExtraction("cam1", {
      fps: 1,
      width: 640,
      height: 480,
      onFrame: vi.fn(),
    });
    expect(extractor.isExtracting("cam1")).toBe(true);
  });

  it("prevents duplicate extraction", () => {
    const proc = makeFakeProcess();
    mockSpawn.mockReturnValue(proc as never);

    extractor.startExtraction("cam1", {
      fps: 1,
      width: 640,
      height: 480,
      onFrame: vi.fn(),
    });

    expect(() => extractor.startExtraction("cam1", {
      fps: 1,
      width: 640,
      height: 480,
      onFrame: vi.fn(),
    })).toThrow("already extracting");
  });

  it("stopAll suppresses reconnects from late exit events", async () => {
    vi.useFakeTimers();
    const proc = makeFakeProcess();
    mockSpawn.mockReturnValue(proc as never);

    extractor.startExtraction("cam1", {
      fps: 1,
      width: 640,
      height: 480,
      onFrame: vi.fn(),
    });
    extractor.stopAll();

    proc.emit("exit", 195);
    await vi.advanceTimersByTimeAsync(100);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("loops local file inputs by default", () => {
    const proc = makeFakeProcess();
    mockSpawn.mockReturnValue(proc as never);

    extractor.startExtraction("cam1", {
      fps: 1,
      width: 640,
      height: 480,
      onFrame: vi.fn(),
      inputOverride: "/tmp/sample.mp4",
    });

    const args = mockSpawn.mock.calls[0]?.[1] as string[];
    expect(args).toContain("-stream_loop");
    expect(args).toContain("-1");
    expect(args).toContain("-re");
  });

  it("treats non-looping local file EOF as completion without reconnecting", async () => {
    vi.useFakeTimers();
    const proc = makeFakeProcess();
    const onEnd = vi.fn();
    mockSpawn.mockReturnValue(proc as never);

    extractor.startExtraction("cam1", {
      fps: 1,
      width: 640,
      height: 480,
      onFrame: vi.fn(),
      inputOverride: "/tmp/sample.mp4",
      loopLocalFile: false,
      onEnd,
    });

    proc.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(0);

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(extractor.isExtracting("cam1")).toBe(false);
  });

  it("local file uses fps-calculated timestamps instead of PTS parsing", async () => {
    const proc = makeFakeProcess();
    const onFrame = vi.fn();
    mockSpawn.mockReturnValue(proc as never);

    extractor.startExtraction("cam1", {
      fps: 2,
      width: 640,
      height: 480,
      onFrame,
      inputOverride: "/tmp/sample.mp4",
      timestampMode: "pts",
    });

    proc.stdout.push(Buffer.concat([makeJpeg(1), makeJpeg(2), makeJpeg(3)]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    proc.emit("exit", 0);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(onFrame).toHaveBeenCalledTimes(3);
    expect(onFrame.mock.calls[0]?.[0].timestamp).toBe(0);
    expect(onFrame.mock.calls[1]?.[0].timestamp).toBe(500);
    expect(onFrame.mock.calls[2]?.[0].timestamp).toBe(1000);
  });

  it("watermark advances with each emitted frame", async () => {
    const proc = makeFakeProcess();
    const onFrame = vi.fn();
    mockSpawn.mockReturnValue(proc as never);

    extractor.startExtraction("cam1", {
      fps: 1,
      width: 640,
      height: 480,
      onFrame,
      inputOverride: "/tmp/sample.mp4",
      timestampMode: "pts",
    });

    proc.stdout.push(Buffer.concat([makeJpeg(1), makeJpeg(2), makeJpeg(3)]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    proc.emit("exit", 0);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(onFrame).toHaveBeenCalledTimes(3);
    expect(onFrame.mock.calls[0]?.[0].timestamp).toBe(0);
    expect(onFrame.mock.calls[1]?.[0].timestamp).toBe(1000);
    expect(onFrame.mock.calls[2]?.[0].timestamp).toBe(2000);
  });

  it("hot swap keeps old process alive until new process emits first frame", async () => {
    const proc1 = makeFakeProcess();
    const proc2 = makeFakeProcess();
    const onFrame = vi.fn();
    mockSpawn.mockReturnValueOnce(proc1 as never).mockReturnValueOnce(proc2 as never);

    extractor.startExtraction("cam1", {
      fps: 1,
      width: 640,
      height: 480,
      onFrame,
      inputOverride: "/tmp/sample.mp4",
      timestampMode: "pts",
    });

    proc1.stdout.push(makeJpeg(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onFrame).toHaveBeenCalledTimes(1);

    extractor.updateExtraction("cam1", {
      fps: 3,
      width: 640,
      height: 480,
      onFrame,
      inputOverride: "/tmp/sample.mp4",
      timestampMode: "pts",
    });

    expect(proc1.kill).not.toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    proc1.stdout.push(makeJpeg(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onFrame).toHaveBeenCalledTimes(2);

    proc2.stdout.push(makeJpeg(3));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(proc1.kill).toHaveBeenCalled();
    expect(onFrame).toHaveBeenCalledTimes(3);
    expect(onFrame.mock.calls[2]?.[0].timestamp).toBeGreaterThan(onFrame.mock.calls[1]?.[0].timestamp);
  });

  it("hot swap forces handoff after 3s timeout", async () => {
    vi.useFakeTimers();
    const proc1 = makeFakeProcess();
    const proc2 = makeFakeProcess();
    mockSpawn.mockReturnValueOnce(proc1 as never).mockReturnValueOnce(proc2 as never);

    extractor.startExtraction("cam1", {
      fps: 1,
      width: 640,
      height: 480,
      onFrame: vi.fn(),
      inputOverride: "/tmp/sample.mp4",
      timestampMode: "pts",
    });

    proc1.stdout.push(Buffer.concat([makeJpeg(1), makeJpeg(2), makeJpeg(3)]));
    await vi.advanceTimersByTimeAsync(0);

    extractor.updateExtraction("cam1", {
      fps: 3,
      width: 640,
      height: 480,
      onFrame: vi.fn(),
      inputOverride: "/tmp/sample.mp4",
      timestampMode: "pts",
    });

    await vi.advanceTimersByTimeAsync(3100);
    expect(proc1.kill).toHaveBeenCalled();
  });

  it("hot swap rapid fps changes kill pending and start a new pending", () => {
    const proc1 = makeFakeProcess();
    const proc2 = makeFakeProcess();
    const proc3 = makeFakeProcess();
    mockSpawn
      .mockReturnValueOnce(proc1 as never)
      .mockReturnValueOnce(proc2 as never)
      .mockReturnValueOnce(proc3 as never);

    extractor.startExtraction("cam1", {
      fps: 1,
      width: 640,
      height: 480,
      onFrame: vi.fn(),
    });
    extractor.updateExtraction("cam1", {
      fps: 3,
      width: 640,
      height: 480,
      onFrame: vi.fn(),
    });

    expect(proc1.kill).not.toHaveBeenCalled();

    extractor.updateExtraction("cam1", {
      fps: 5,
      width: 640,
      height: 480,
      onFrame: vi.fn(),
    });

    expect(proc2.kill).toHaveBeenCalled();
    expect(proc1.kill).not.toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledTimes(3);
  });

  it("hot swap rollback while pending is in flight does not full restart", () => {
    const proc1 = makeFakeProcess();
    const proc2 = makeFakeProcess();
    const proc3 = makeFakeProcess();
    mockSpawn
      .mockReturnValueOnce(proc1 as never)
      .mockReturnValueOnce(proc2 as never)
      .mockReturnValueOnce(proc3 as never);

    extractor.startExtraction("cam1", {
      fps: 1,
      width: 640,
      height: 480,
      onFrame: vi.fn(),
      inputOverride: "/tmp/sample.mp4",
      timestampMode: "pts",
    });

    extractor.updateExtraction("cam1", {
      fps: 3,
      width: 640,
      height: 480,
      onFrame: vi.fn(),
      inputOverride: "/tmp/sample.mp4",
      timestampMode: "pts",
    });

    extractor.updateExtraction("cam1", {
      fps: 1,
      width: 640,
      height: 480,
      onFrame: vi.fn(),
      inputOverride: "/tmp/sample.mp4",
      timestampMode: "pts",
    });

    expect(proc1.kill).not.toHaveBeenCalled();
    expect(proc2.kill).toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledTimes(3);
    expect(extractor.getExtractionOptions("cam1")?.fps).toBe(1);
  });

  it("stopAll kills both active and pending", () => {
    const proc1 = makeFakeProcess();
    const proc2 = makeFakeProcess();
    mockSpawn.mockReturnValueOnce(proc1 as never).mockReturnValueOnce(proc2 as never);

    extractor.startExtraction("cam1", {
      fps: 1,
      width: 640,
      height: 480,
      onFrame: vi.fn(),
    });
    extractor.updateExtraction("cam1", {
      fps: 3,
      width: 640,
      height: 480,
      onFrame: vi.fn(),
    });

    extractor.stopAll();

    expect(proc1.kill).toHaveBeenCalled();
    expect(proc2.kill).toHaveBeenCalled();
    expect(extractor.isExtracting("cam1")).toBe(false);
  });

  it("hot swap unexpected active exit promotes pending immediately", async () => {
    const proc1 = makeFakeProcess();
    proc1.kill = vi.fn(() => true);
    const proc2 = makeFakeProcess();
    mockSpawn.mockReturnValueOnce(proc1 as never).mockReturnValueOnce(proc2 as never);

    extractor.startExtraction("cam1", {
      fps: 1,
      width: 640,
      height: 480,
      onFrame: vi.fn(),
    });
    extractor.updateExtraction("cam1", {
      fps: 3,
      width: 640,
      height: 480,
      onFrame: vi.fn(),
    });

    proc1.emit("exit", 1);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(extractor.isExtracting("cam1")).toBe(true);
    expect(extractor.getExtractionOptions("cam1")?.fps).toBe(3);
  });

  it("hot swap pending crash leaves active unaffected", async () => {
    const proc1 = makeFakeProcess();
    const proc2 = makeFakeProcess();
    mockSpawn.mockReturnValueOnce(proc1 as never).mockReturnValueOnce(proc2 as never);

    extractor.startExtraction("cam1", {
      fps: 1,
      width: 640,
      height: 480,
      onFrame: vi.fn(),
      inputOverride: "/tmp/sample.mp4",
      timestampMode: "pts",
    });
    extractor.updateExtraction("cam1", {
      fps: 3,
      width: 640,
      height: 480,
      onFrame: vi.fn(),
      inputOverride: "/tmp/sample.mp4",
      timestampMode: "pts",
    });

    proc2.emit("exit", 1);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(extractor.isExtracting("cam1")).toBe(true);
    expect(extractor.getExtractionOptions("cam1")?.fps).toBe(1);
    expect(proc1.kill).not.toHaveBeenCalled();
  });
});
