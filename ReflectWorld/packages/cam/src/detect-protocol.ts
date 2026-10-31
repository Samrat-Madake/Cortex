import type { SourceProtocol } from "./types.js";


interface DetectionResult {
  protocol: SourceProtocol;
  input: string;
}

const IMAGE_EXTENSIONS = /\.(jpg|jpeg|png|bmp)$/i;
const VIDEO_EXTENSIONS = /\.(mp4|avi|mkv|mov|webm|flv|m3u8)$/i;

/** Auto-detect the protocol for a raw video source input string. */
export function detectProtocol(raw: string): DetectionResult {
  const input = raw.trim();

  // Keywords
  // Devices requiring browser permission → ClawCam WebRTC
  if (input === "phone") return { protocol: "phone", input };
  if (input === "webcam") return { protocol: "phone", input };
  // Platform-specific USB capture (no browser needed) → ffmpeg
  if (input === "usb") return { protocol: "ffmpeg", input: "webcam" };
  if (input.startsWith("usb:")) return { protocol: "ffmpeg", input };

  // Platform-specific capture devices
  if (input.startsWith("avfoundation://") || input.startsWith("v4l2://")) {
    return { protocol: "ffmpeg", input };
  }

  // RTSP
  if (input.startsWith("rtsp://") || input.startsWith("rtsps://")) {
    return { protocol: "ffmpeg", input };
  }

  // Local file path
  if (input.startsWith("/") || input.startsWith("./") || input.match(/^[A-Z]:\\/)) {
    return { protocol: "ffmpeg", input };
  }

  // HTTP(S) URLs
  if (input.startsWith("http://") || input.startsWith("https://")) {
    const url = new URL(input);
    const path = url.pathname.toLowerCase();

    // HLS stream
    if (path.endsWith(".m3u8")) return { protocol: "ffmpeg", input };

    // Static image
    if (IMAGE_EXTENSIONS.test(path)) return { protocol: "http", input };

    // Video file
    if (VIDEO_EXTENSIONS.test(path)) return { protocol: "ffmpeg", input };

    // Unknown HTTP — generic fallback
    return { protocol: "generic", input };
  }

  return { protocol: "generic", input };
}

/**
 * Convert a user input + detected protocol into a go2rtc source URL.
 * go2rtc understands different source formats:
 * - Direct RTSP: "rtsp://..."
 * - FFmpeg exec: "exec:ffmpeg -f avfoundation ..."
 * - FFmpeg URL: "ffmpeg:http://...#video=copy"
 * - Empty: "" (for WebRTC ingest, phone)
 */
/**
 * Returns true if the input is a local capture device (webcam/USB/avfoundation/v4l2).
 * These are managed by LocalDeviceSource instead of go2rtc exec:.
 */
export function isLocalDevice(input: string): boolean {
  return (
    input === "webcam" ||
    input === "usb" ||
    input.startsWith("usb:") ||
    input.startsWith("avfoundation://") ||
    input.startsWith("v4l2://")
  );
}

export function toGo2rtcSource(input: string, protocol: SourceProtocol): string {
  if (protocol === "phone" || input === "phone") return "";

  if (input.startsWith("rtsp://") || input.startsWith("rtsps://")) return input;

  // Local devices: register as empty placeholder in go2rtc.
  // Actual capture is handled by LocalDeviceSource pushing RTSP to go2rtc.
  if (isLocalDevice(input)) return "";

  if (input.startsWith("http://") || input.startsWith("https://")) {
    const url = new URL(input);
    if (url.pathname.toLowerCase().endsWith(".m3u8")) return `ffmpeg:${input}#video=copy`;
    if (VIDEO_EXTENSIONS.test(url.pathname)) return `ffmpeg:${input}#video=copy`;
    if (IMAGE_EXTENSIONS.test(url.pathname)) return input;
    return `ffmpeg:${input}#video=copy`;
  }

  if (input.startsWith("/") || input.startsWith("./") || input.match(/^[A-Z]:\\/)) {
    return `ffmpeg:${input}#video=copy#input=file`;
  }

  return input;
}
