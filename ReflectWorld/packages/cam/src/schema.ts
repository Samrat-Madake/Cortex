import { Type } from "@sinclair/typebox";

/** Flat object schema for the reflectworld_cam tool. */
export const CamToolSchema = Type.Object({
  action: Type.Unsafe<string>(
    Type.String({
      description: `Action to perform:
- add_source: Register a new camera (RTSP, phone, webcam, HTTP, file)
- list_sources: List all registered cameras
- remove_source: Remove a camera by name/id
- snapshot: Capture a single frame and analyze it
- watch: Start continuous monitoring (stream or event mode)
- stop_watch: Stop monitoring a camera
- set_sampling: Change fps/resolution of an active watch without restarting
- live_view: Get a browser link for real-time camera livestream. Use when user wants to see what the camera sees right now
- switch_mode: Switch between event and stream mode on an active watch without restarting. Params: name (required), mode ("event" or "stream")
- list_recordings: List recorded video files for a camera
- save_reference: Save current frame as reference state for VLM comparison. Params: name (required)`,
      enum: [
        "add_source",
        "list_sources",
        "remove_source",
        "snapshot",
        "watch",
        "stop_watch",
        "set_sampling",
        "switch_mode",
        "live_view",
        "list_recordings",
        "save_reference",
      ],
    }),
  ),
  source: Type.Optional(
    Type.String({
      description:
        "Video source: 'phone', 'webcam', RTSP URL, HTTP URL, or file path (add_source)",
    }),
  ),
  name: Type.Optional(
    Type.String({ description: "Camera name or id. Accepts either the display name or the source id returned by add_source. Required for snapshot/watch/stop_watch/set_sampling/live_view/remove_source/list_recordings. Optional for add_source (auto-generated if omitted)." }),
  ),
  mode: Type.Optional(
    Type.Unsafe<string>(
      Type.String({
        description: "Auto-set by monitoring choice: 'event' for motion alerts, 'stream' for continuous. Do not ask user to pick mode directly.",
        enum: ["event", "stream"],
      }),
    ),
  ),
  fps: Type.Optional(
    Type.Number({
      description: "Frame sampling rate (default: 1). Do not show by default; only set if user explicitly requests a specific fps.",
    }),
  ),
  duration: Type.Optional(
    Type.Number({
      description: "Auto-stop after N seconds. Do not show by default; only set if user explicitly asks for a time limit.",
    }),
  ),
  width: Type.Optional(
    Type.Number({ description: "Frame width (default: 1280). Do not show by default; only set if user explicitly requests a resolution." }),
  ),
  height: Type.Optional(
    Type.Number({ description: "Frame height (default: 720). Do not show by default; only set if user explicitly requests a resolution." }),
  ),
});
