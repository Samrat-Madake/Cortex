import { describe, it, expect } from "vitest";
import { getGo2rtcDownload, getGo2rtcUrl, getFfmpegUrl, getFfmpegStrategy } from "../binary-installer.js";

describe("getGo2rtcUrl", () => {
  it("returns arm64 URL for darwin arm64", () => {
    const url = getGo2rtcUrl("darwin", "arm64");
    expect(url).toContain("go2rtc_mac_arm64.zip");
    expect(url).toContain("github.com/AlexxIT/go2rtc/releases");
  });

  it("returns direct binary URL for linux x64", () => {
    const url = getGo2rtcUrl("linux", "x64");
    expect(url).toContain("go2rtc_linux_amd64");
    expect(url).not.toContain(".zip");
  });

  it("reports linux go2rtc downloads as raw binaries", () => {
    const result = getGo2rtcDownload("linux", "x64");
    expect(result.format).toBe("binary");
  });

  it("throws for unsupported platform", () => {
    expect(() => getGo2rtcUrl("win32", "x64")).toThrow("Unsupported");
  });
});

describe("getFfmpegUrl", () => {
  it("returns evermeet zip for darwin", () => {
    const result = getFfmpegUrl("darwin", "arm64");
    expect(result.url).toContain("evermeet.cx/ffmpeg");
    expect(result.format).toBe("zip");
  });

  it("returns johnvansickle tar.xz for linux amd64", () => {
    const result = getFfmpegUrl("linux", "x64");
    expect(result.url).toContain("johnvansickle.com/ffmpeg/old-releases");
    expect(result.url).toContain("ffmpeg-6.0.1-amd64-static.tar.xz");
    expect(result.format).toBe("tar.xz");
  });

  it("returns johnvansickle tar.xz for linux arm64", () => {
    const result = getFfmpegUrl("linux", "arm64");
    expect(result.url).toContain("ffmpeg-6.0.1-arm64-static.tar.xz");
    expect(result.format).toBe("tar.xz");
  });

  it("throws for unsupported platform", () => {
    expect(() => getFfmpegUrl("win32", "x64")).toThrow("Unsupported");
  });

  it("throws for unsupported arch", () => {
    expect(() => getFfmpegUrl("darwin", "ia32")).toThrow("Unsupported arch");
  });
});

describe("getFfmpegStrategy", () => {
  it("returns object with type property", () => {
    const strategy = getFfmpegStrategy();
    expect(strategy).toHaveProperty("type");
    expect(["prepared", "download"]).toContain(strategy.type);
  });
});
