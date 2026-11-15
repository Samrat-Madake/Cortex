import { describe, it, expect } from "vitest";
import { detectProtocol, toGo2rtcSource, isLocalDevice } from "../detect-protocol.js";

describe("detectProtocol", () => {
  it("detects phone keyword", () => {
    expect(detectProtocol("phone")).toEqual({ protocol: "phone", input: "phone" });
  });

  it("detects webcam keyword as phone (WebRTC)", () => {
    const r = detectProtocol("webcam");
    expect(r.protocol).toBe("phone");
  });

  it("detects RTSP URL", () => {
    const r = detectProtocol("rtsp://192.168.1.100:554/stream");
    expect(r.protocol).toBe("ffmpeg");
  });

  it("detects HTTP JPEG URL", () => {
    const r = detectProtocol("https://example.com/cam.jpg");
    expect(r.protocol).toBe("http");
  });

  it("detects HLS URL", () => {
    const r = detectProtocol("https://stream.example.com/live.m3u8");
    expect(r.protocol).toBe("ffmpeg");
  });

  it("detects local file path", () => {
    const r = detectProtocol("/path/to/video.mp4");
    expect(r.protocol).toBe("ffmpeg");
  });

  it("detects usb keyword", () => {
    const r = detectProtocol("usb");
    expect(r.protocol).toBe("ffmpeg");
    expect(r.input).toBe("webcam");
  });

  it("detects usb:N device index", () => {
    const r = detectProtocol("usb:1");
    expect(r.protocol).toBe("ffmpeg");
    expect(r.input).toBe("usb:1");
  });

  it("falls back to generic for unknown URLs", () => {
    const r = detectProtocol("https://example.com/feed");
    expect(r.protocol).toBe("generic");
  });
});

describe("toGo2rtcSource", () => {
  it("passes RTSP URL through unchanged", () => {
    expect(toGo2rtcSource("rtsp://192.168.1.100/stream", "ffmpeg"))
      .toBe("rtsp://192.168.1.100/stream");
  });

  it("returns empty string for webcam (managed by LocalDeviceSource)", () => {
    expect(toGo2rtcSource("webcam", "ffmpeg")).toBe("");
  });

  it("returns empty string for usb:1 (managed by LocalDeviceSource)", () => {
    expect(toGo2rtcSource("usb:1", "ffmpeg")).toBe("");
  });

  it("converts HLS URL to ffmpeg source", () => {
    const result = toGo2rtcSource("http://example.com/live.m3u8", "ffmpeg");
    expect(result).toContain("ffmpeg:http://example.com/live.m3u8");
  });

  it("returns empty string for phone protocol", () => {
    expect(toGo2rtcSource("phone", "phone")).toBe("");
  });

  it("converts local file to ffmpeg source", () => {
    const result = toGo2rtcSource("/path/to/video.mp4", "ffmpeg");
    expect(result).toContain("ffmpeg:/path/to/video.mp4");
  });
});

describe("isLocalDevice", () => {
  it("returns true for webcam", () => expect(isLocalDevice("webcam")).toBe(true));
  it("returns true for usb", () => expect(isLocalDevice("usb")).toBe(true));
  it("returns true for usb:1", () => expect(isLocalDevice("usb:1")).toBe(true));
  it("returns true for avfoundation", () => expect(isLocalDevice("avfoundation://0")).toBe(true));
  it("returns true for v4l2", () => expect(isLocalDevice("v4l2:///dev/video0")).toBe(true));
  it("returns false for RTSP", () => expect(isLocalDevice("rtsp://192.168.1.1/stream")).toBe(false));
  it("returns false for phone", () => expect(isLocalDevice("phone")).toBe(false));
  it("returns false for HTTP", () => expect(isLocalDevice("http://example.com/cam.jpg")).toBe(false));
});
