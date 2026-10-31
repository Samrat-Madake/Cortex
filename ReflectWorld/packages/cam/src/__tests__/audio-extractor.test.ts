import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { AudioExtractor, buildAudioExtractionArgs } from "../audio-extractor.js";
import { spawn } from "node:child_process";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const mockSpawn = vi.mocked(spawn);

function makeFakeProcess() {
  const proc = new EventEmitter() as any;
  proc.kill = vi.fn(() => {
    proc.emit("exit", 0);
    return true;
  });
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  return proc;
}

describe("AudioExtractor", () => {
  it("stopExtraction returns false for unknown stream", () => {
    const ae = new AudioExtractor({ ffmpegBin: "ffmpeg", rtspBase: "rtsp://localhost:8554" });
    expect(ae.stopExtraction("nonexistent")).toBe(false);
  });

  it("isExtracting returns correct state", () => {
    const ae = new AudioExtractor({ ffmpegBin: "ffmpeg", rtspBase: "rtsp://localhost:8554" });
    expect(ae.isExtracting("cam1")).toBe(false);
  });

  it("pauses and resumes stdout for an active extraction", () => {
    const proc = makeFakeProcess();
    mockSpawn.mockReturnValue(proc as never);
    const ae = new AudioExtractor({ ffmpegBin: "ffmpeg", rtspBase: "rtsp://localhost:8554" });

    ae.startExtraction("cam1", { onAudio: vi.fn() });
    expect(ae.pauseExtraction("cam1")).toBe(true);
    expect(proc.stdout.isPaused()).toBe(true);
    expect(ae.pauseExtraction("cam1")).toBe(false);

    expect(ae.resumeExtraction("cam1")).toBe(true);
    expect(proc.stdout.isPaused()).toBe(false);
    expect(ae.resumeExtraction("cam1")).toBe(false);
  });

  it("stopAll does not throw when empty", () => {
    const ae = new AudioExtractor({ ffmpegBin: "ffmpeg", rtspBase: "rtsp://localhost:8554" });
    expect(() => ae.stopAll()).not.toThrow();
  });

  it("uses realtime input pacing for local media files", () => {
    const args = buildAudioExtractionArgs("/tmp/video.mp4", 16000, []);
    expect(args.slice(0, 3)).toEqual(["-re", "-i", "/tmp/video.mp4"]);
  });

  it("can disable realtime pacing for local media files", () => {
    const args = buildAudioExtractionArgs("/tmp/video.mp4", 16000, [], "fast");
    expect(args.slice(0, 2)).toEqual(["-i", "/tmp/video.mp4"]);
    expect(args).not.toContain("-re");
  });

  it("does not force realtime input pacing for RTSP streams", () => {
    const args = buildAudioExtractionArgs("rtsp://localhost:8554/cam1", 16000, ["-rtsp_transport", "tcp"]);
    expect(args.slice(0, 4)).toEqual(["-rtsp_transport", "tcp", "-i", "rtsp://localhost:8554/cam1"]);
  });
});
