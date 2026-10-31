// packages/percept/src/schema.ts
import { Type } from "@sinclair/typebox";

/**
 * Flat object schema for the reflectworld_perception OpenClaw tool.
 * OpenClaw does not support anyOf/oneOf/allOf in tool schemas.
 */
export const PerceptionToolSchema = Type.Object({
  action: Type.Unsafe<string>(
    Type.String({
      description: "Action to perform. 'configure' is the primary user-facing action. 'analyze' and 'get_status' are normally called automatically by the pipeline, but can be used manually if the user explicitly requests.",
      enum: ["analyze", "get_status", "configure"],
    }),
  ),
  segment_id: Type.Optional(
    Type.String({ description: "Internal. Segment identifier from Eye pipeline (analyze)." }),
  ),
  camera_id: Type.Optional(
    Type.String({ description: "Camera name (get_status, analyze)." }),
  ),
  mode: Type.Optional(
    Type.Unsafe<string>(
      Type.String({
        description: "Internal. Capture mode set by Eye pipeline (analyze).",
        enum: ["snapshot", "event", "stream"],
      }),
    ),
  ),
  frames: Type.Optional(
    Type.Array(
      Type.Object({
        data: Type.String({ description: "Base64 JPEG image data" }),
        timestamp: Type.Number({ description: "Unix timestamp in ms" }),
        index: Type.Number({ description: "Zero-based frame index" }),
      }),
      { description: "Internal. Ordered frames from Eye pipeline (analyze)." },
    ),
  ),
  raw_url: Type.Optional(
    Type.String({ description: "Internal. For snapshot: saved JPEG file path. For watch: recordings directory path. Use with timestamp/duration_sec to locate video." }),
  ),
  timestamp: Type.Optional(
    Type.Number({ description: "Internal. Unix timestamp of the first frame (analyze)." }),
  ),
  duration_sec: Type.Optional(
    Type.Number({ description: "Internal. Duration in seconds (analyze)." }),
  ),
  event_hint: Type.Optional(
    Type.String({ description: "Internal. Human-readable hint about segment trigger (analyze)." }),
  ),
  config: Type.Optional(
    Type.Object(
      {
        vlm_model: Type.Optional(Type.String({ description: "Primary VLM model for multi-frame analysis" })),
        vlm_model_lite: Type.Optional(Type.String({ description: "Smaller VLM model for snapshot/single-frame analysis" })),
        scene_description: Type.Optional(Type.String({ description: "Camera scene description for VLM context" })),
        focus_targets: Type.Optional(Type.String({ description: "Comma-separated targets to focus on" })),
        security_rules: Type.Optional(Type.String({ description: "Custom security criteria" })),
        vc_enabled: Type.Optional(Type.Boolean({ description: "Enable/disable VisionController" })),
        vc_rules_json: Type.Optional(Type.String({ description: "JSON array of Rule[] to set for VisionController" })),
        vc_segment_policy_json: Type.Optional(Type.String({ description: "JSON SegmentPolicy object to set for VisionController" })),
        camera_id: Type.Optional(Type.String({ description: "Camera ID for semantic context updates" })),
        semantic_context_notes: Type.Optional(Type.String({ description: "User notes about the camera scene (written to User Notes section of semantic context)" })),
        semantic_context_background: Type.Optional(Type.String({ description: "User-provided background context for this camera/source" })),
        source_context: Type.Optional(Type.String({ description: "Alias for semantic_context_background" })),
        track_states: Type.Optional(Type.Array(Type.String(), { description: "Object states to track, e.g. ['door: open/closed', 'light: on/off']. VLM reports in custom_fields." })),
        track_activities: Type.Optional(Type.Array(Type.String(), { description: "Activity labels to recognize, e.g. ['cooking', 'resting', 'exercising']. VLM reports as custom_fields.current_activity." })),
        explain_decisions: Type.Optional(Type.Boolean({ description: "When true, notifications include VisionController decision reasoning." })),
      },
      { additionalProperties: false, description: "Partial PerceptionConfig overrides (configure)" },
    ),
  ),
});
