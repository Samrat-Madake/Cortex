import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RecordManager } from "../record-manager.js";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn().mockReturnValue(true), mkdirSync: vi.fn(), readdirSync: vi.fn().mockReturnValue([]) };
});

import { spawn } from "node:child_process";
const mockSpawn = vi.mocked(spawn);

function makeFakeProcess() {
  const proc = new EventEmitter() as any;
  proc.pid = 99;
  proc.kill = vi.fn(() => { proc.emit("exit", 0); return true; });
  proc.stdin = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

describe("RecordManager", () => {
  let manager: RecordManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new RecordManager({ ffmpegBin: "ffmpeg", rtspBase: "rtsp://127.0.0.1:8554", outputDir: "/tmp/recordings" });
  });

  afterEach(() => { manager.stopAll(); });

  it("startRecording spawns ffmpeg with -c copy -f segment", () => {
    const proc = makeFakeProcess();
    mockSpawn.mockReturnValue(proc as any);
    manager.startRecording("cam1");
    expect(mockSpawn).toHaveBeenCalledWith("ffmpeg", expect.arrayContaining(["-c", "copy", "-f", "segment"]), expect.any(Object));
  });

  it("startRecording uses RTSP input from go2rtc", () => {
    const proc = makeFakeProcess();
    mockSpawn.mockReturnValue(proc as any);
    manager.startRecording("cam1");
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain("rtsp://127.0.0.1:8554/cam1");
  });

  it("startRecording respects segmentSec option", () => {
    const proc = makeFakeProcess();
    mockSpawn.mockReturnValue(proc as any);
    manager.startRecording("cam1", { segmentSec: 60 });
    const args = mockSpawn.mock.calls[0][1] as string[];
    const idx = args.indexOf("-segment_time");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("60");
  });

  it("stopRecording kills the process", () => {
    const proc = makeFakeProcess();
    mockSpawn.mockReturnValue(proc as any);
    manager.startRecording("cam1");
    manager.stopRecording("cam1");
    expect(proc.kill).toHaveBeenCalledWith("SIGINT");
  });

  it("stopRecording returns false if not recording", () => {
    expect(manager.stopRecording("cam1")).toBe(false);
  });

  it("isRecording returns correct state", () => {
    const proc = makeFakeProcess();
    mockSpawn.mockReturnValue(proc as any);
    expect(manager.isRecording("cam1")).toBe(false);
    manager.startRecording("cam1");
    expect(manager.isRecording("cam1")).toBe(true);
    manager.stopRecording("cam1");
    expect(manager.isRecording("cam1")).toBe(false);
  });

  it("prevents duplicate recording", () => {
    const proc = makeFakeProcess();
    mockSpawn.mockReturnValue(proc as any);
    manager.startRecording("cam1");
    expect(() => manager.startRecording("cam1")).toThrow("already recording");
  });

  it("stopAll stops all active recordings", () => {
    const proc1 = makeFakeProcess();
    const proc2 = makeFakeProcess();
    mockSpawn.mockReturnValueOnce(proc1 as any).mockReturnValueOnce(proc2 as any);
    manager.startRecording("cam1");
    manager.startRecording("cam2");
    manager.stopAll();
    expect(proc1.kill).toHaveBeenCalled();
    expect(proc2.kill).toHaveBeenCalled();
  });

  it("calls onEnd when recording input ends naturally", () => {
    const proc = makeFakeProcess();
    mockSpawn.mockReturnValue(proc as any);
    const onEnd = vi.fn();

    manager.startRecording("cam1", { inputOverride: "/tmp/sample.mp4", onEnd });
    proc.emit("exit", 0);

    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("does not call onEnd when stopped by user", () => {
    const proc = makeFakeProcess();
    mockSpawn.mockReturnValue(proc as any);
    const onEnd = vi.fn();

    manager.startRecording("cam1", { inputOverride: "/tmp/sample.mp4", onEnd });
    manager.stopRecording("cam1");

    expect(onEnd).not.toHaveBeenCalled();
  });
});
