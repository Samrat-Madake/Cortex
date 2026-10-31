import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { resolveReflectWorldHome, resolveReflectWorldStateDir } from "@reflectworld/shared";
import { resolveCamConfig } from "../config.js";

describe("resolveCamConfig", () => {
  it("returns defaults for empty input", () => {
    const cfg = resolveCamConfig();
    expect(cfg.sources_dir).toBe(join(resolveReflectWorldStateDir(), "sources"));
    expect(cfg.default_snapshot_quality).toBe(85);
  });

  it("overrides with provided values", () => {
    const cfg = resolveCamConfig({ default_segment_sec: 60 });
    expect(cfg.default_segment_sec).toBe(60);
  });

  it("rejects invalid quality", () => {
    expect(() => resolveCamConfig({ default_snapshot_quality: 200 })).toThrow();
  });

  it("applies v3 go2rtc defaults", () => {
    const config = resolveCamConfig({});
    expect(config.go2rtc_bin).toBe(join(resolveReflectWorldHome(), "bin", "go2rtc"));
    expect(config.go2rtc_api_port).toBe(1984);
    expect(config.go2rtc_rtsp_port).toBe(8554);
    expect(config.go2rtc_webrtc_port).toBe(8555);
    expect(config.go2rtc_listen_addr).toBe("127.0.0.1");
    expect(config.go2rtc_reuse_external).toBe(true);
  });

  it("uses prepared local binary defaults", () => {
    const config = resolveCamConfig({});
    expect(config.ffmpeg_bin).toBe(join(resolveReflectWorldHome(), "bin", "ffmpeg"));
    expect(config.ffprobe_bin).toBe(join(resolveReflectWorldHome(), "bin", "ffprobe"));
    expect(config.silero_vad_model).toBe(join(resolveReflectWorldHome(), "models", "silero_vad.onnx"));
  });

  it("applies v3 recording defaults", () => {
    const config = resolveCamConfig({});
    expect(config.recordings_dir).toBe(join(resolveReflectWorldStateDir(), "recordings"));
    expect(config.default_segment_sec).toBe(30);
  });

  it("applies v3 extraction defaults", () => {
    const config = resolveCamConfig({});
    expect(config.default_extraction_fps).toBe(1);
    expect(config.default_extraction_width).toBe(1280);
    expect(config.default_extraction_height).toBe(720);
  });

  it("applies v3 motion defaults", () => {
    const config = resolveCamConfig({});
    expect(config.motion_threshold).toBe(0.02);
  });
});
