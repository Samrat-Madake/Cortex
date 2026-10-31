import { describe, it, expect } from "vitest";
import type { SourceConfig, FrameResult, CamAction } from "../types.js";

describe("Cam types", () => {
  it("SourceConfig accepts minimal config", () => {
    const cfg: SourceConfig = {
      id: "front_door",
      name: "Front Door",
      input: "rtsp://192.168.1.100:554/stream",
      protocol: "ffmpeg",
      created_at: Date.now(),
    };
    expect(cfg.protocol).toBe("ffmpeg");
  });

  it("FrameResult has base64 data", () => {
    const frame: FrameResult = {
      data: "base64...",
      timestamp: Date.now(),
      source_name: "cam_01",
    };
    expect(frame.data).toBeTruthy();
  });

  it("CamAction includes v3 actions", () => {
    const actions: CamAction[] = [
      "add_source", "list_sources", "remove_source", "snapshot",
      "watch", "stop_watch", "list_recordings",
    ];
    expect(actions).toHaveLength(7);
  });
});
