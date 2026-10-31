import { join } from "node:path";
import { z } from "zod";
import { resolveReflectWorldHome, resolveReflectWorldStateDir } from "@reflectworld/shared";

function stableReflectWorldBin(name: string): string {
  return join(resolveReflectWorldHome(), "bin", name);
}

export const CamConfigSchema = z.object({
  // -- source management --
  sources_dir: z.string().default(join(resolveReflectWorldStateDir(), "sources")),

  // -- go2rtc --
  go2rtc_bin: z.string().default(stableReflectWorldBin("go2rtc")),
  go2rtc_api_port: z.number().default(1984),
  go2rtc_rtsp_port: z.number().default(8554),
  go2rtc_webrtc_port: z.number().default(8555),
  /**
   * Address go2rtc binds its api/rtsp/webrtc listeners to. Defaults to loopback
   * because the Dashboard proxies browser access for public-demo safety.
   * Self-hosted deployments that need direct go2rtc WebRTC can set 0.0.0.0.
   */
  go2rtc_listen_addr: z.string().default("127.0.0.1"),
  /** Reuse an already-running go2rtc on the API port. Disable for public demo fail-closed startup. */
  go2rtc_reuse_external: z.boolean().default(true),

  // -- ffmpeg --
  ffmpeg_bin: z.string().default(stableReflectWorldBin("ffmpeg")),
  ffprobe_bin: z.string().default(stableReflectWorldBin("ffprobe")),

  // -- recording --
  recordings_dir: z.string().default(join(resolveReflectWorldStateDir(), "recordings")),
  default_segment_sec: z.number().min(5).default(30),
  /** Per-camera recording quota in MB. Default 2048 (2GB). Set 0 to disable FIFO. */
  recording_quota_mb: z.number().min(0).default(2048),

  // -- frame extraction --
  default_extraction_fps: z.number().min(0.1).max(30).default(1),
  default_extraction_width: z.number().min(160).default(1280),
  default_extraction_height: z.number().min(120).default(720),

  // -- motion detection --
  motion_threshold: z.number().min(0).max(1).default(0.02),
  motion_pixel_threshold: z.number().min(0).max(1).default(0.1),

  // -- snapshot (legacy, still used for periodic mode) --
  default_snapshot_quality: z.number().min(1).max(100).default(85),

  // -- downstream services --
  reflectworld_endpoint: z.string().default("http://localhost:8219"),
  auto_analyze: z.boolean().default(true),
  /** Restore persisted watch sessions when the cam service starts. */
  restore_watches: z.boolean().default(true),

  // -- VAD --
  silero_vad_model: z.string().default(join(resolveReflectWorldHome(), "models", "silero_vad.onnx")),
  vad_enabled: z.boolean().default(true),
  vad_threshold: z.number().min(0).max(1).default(0.5),
  vad_min_silence_duration: z.number().min(0).default(0.05),
  vad_min_speech_duration: z.number().min(0).default(0.25),
  vad_window_size: z.number().default(512),
  vad_buffer_size_sec: z.number().min(1).default(120),

  // -- pipeline --
  segment_window_size: z.number().min(1).default(10),

  // -- full-rate extraction --
  /** When true, FrameExtractor outputs all frames (no decimation filter).
   *  Percept decimation is handled downstream by the orchestrator. */
  extraction_full_rate: z.boolean().default(false),
});

export type CamConfig = z.infer<typeof CamConfigSchema>;

export function resolveCamConfig(raw?: Record<string, unknown>): CamConfig {
  return CamConfigSchema.parse(raw ?? {});
}
