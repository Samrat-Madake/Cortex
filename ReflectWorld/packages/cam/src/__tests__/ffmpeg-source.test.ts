import { describe, it, expect, vi, beforeEach } from "vitest";
import { FFmpegSource } from "../sources/ffmpeg.js";

// Mock child_process.execFile
vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    // Return a tiny 1x1 JPEG as buffer
    const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    cb(null, jpegHeader, "");
  }),
}));

vi.mock("../binary-installer.js", () => ({
  resolveFfmpegBin: () => "/tmp/cortex-test-ffmpeg",
}));

describe("FFmpegSource", () => {
  let source: FFmpegSource;

  beforeEach(() => {
    source = new FFmpegSource("test_cam", "rtsp://192.168.1.100/stream");
  });

  it("builds correct ffmpeg args for RTSP snapshot", () => {
    const args = source.buildSnapshotArgs();
    expect(args).toContain("-i");
    expect(args).toContain("rtsp://192.168.1.100/stream");
    expect(args).toContain("-frames:v");
    expect(args).toContain("1");
    expect(args).toContain("pipe:1");
  });

  it("builds correct args for webcam", () => {
    const webcam = new FFmpegSource("webcam", "webcam");
    const args = webcam.buildSnapshotArgs();
    // macOS: avfoundation, Linux: v4l2
    expect(args).toContain("-f");
  });

  it("builds correct args for usb:1 device", () => {
    const usb = new FFmpegSource("usb_cam", "usb:1");
    const args = usb.buildSnapshotArgs();
    // Should use device capture format, not raw "-i usb:1"
    expect(args).toContain("-f");
    expect(args).not.toContain("usb:1");
    // macOS: "1:none", Linux: "/dev/video1"
    expect(args.some(a => a === "1:none" || a === "/dev/video1")).toBe(true);
  });

  it("returns base64 JPEG from snapshot", async () => {
    const result = await source.snapshot();
    expect(result.source_name).toBe("test_cam");
    expect(result.data).toBeTruthy();
    expect(result.timestamp).toBeGreaterThan(0);
  });
});
