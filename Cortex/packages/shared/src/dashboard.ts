export type DashboardStateDomain = "source" | "segment" | "memory" | "service" | "trace" | "system";

export type DashboardStateOperation = "upsert" | "remove";

export interface DashboardEnvelopeScope {
  user_id?: string;
  session_id?: string;
}

export interface DashboardStateEnvelope {
  domain: DashboardStateDomain;
  id: string;
  version: number;
  op: DashboardStateOperation;
  timestamp: number;
  scope?: DashboardEnvelopeScope;
  data?: Record<string, unknown>;
}

export interface ActiveSourceStatus {
  source_id: string;
  source_name?: string;
  user_id?: string;
  session_id?: string;
  input?: string;
  protocol?: string;
  mode?: "event" | "stream";
  fps?: number;
  width?: number;
  height?: number;
  created_at?: number;
  status: "active" | "waiting" | "reconnecting" | "unavailable" | "stopped";
  display_status?: "preparing" | "active" | "waiting" | "stopped" | "reconnecting" | "unavailable" | "completed";
  input_kind?: "url" | "web" | "qr" | "unknown";
  kind?: "upload" | "stream_url" | "phone" | "local_device";
  label?: string;
  summary?: string;
  video_id?: string;
  preview_url?: string;
  watch_status?: "idle" | "starting" | "running" | "stopping" | "stopped" | "failed";
  media_status?: "preview_ready" | "live_ready" | "waiting" | "unavailable" | "stopped";
  analysis_status?: "none" | "starting" | "active" | "completed" | "failed";
  segments_count?: number;
  updated_at?: number;
  last_error?: string;
  can_start?: boolean;
  can_stop?: boolean;
  can_delete?: boolean;
  config?: {
    mode?: "event" | "stream";
    fps?: number;
  };
}

export type DashboardEntityRefMap = Record<string, string>;
export type DashboardRefEntityMap = Record<string, string>;

export interface DashboardBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DashboardSegmentTarget {
  entity_id?: string;
  target_id?: string;
  type: string;
  name?: string;
  subject_index?: number;
  ref?: number | string;
  label?: string;
  has_name?: boolean;
  first_seen?: string | number;
  person_name?: string;
  identity?: string;
  is_new?: boolean;
  appearance: string;
  behavior: string;
  bbox?: DashboardBoundingBox;
  face_bbox?: DashboardBoundingBox;
  face_quality?: number;
  face_yaw?: number;
  face_pitch?: number;
  avatar_score?: number;
  keyframe_path?: string;
  crop_path?: string;
}

export interface DashboardSegmentDialogueLine {
  text_start?: number;
  speaker?: string;
  track_id?: string;
  entity_id?: string;
  confidence?: string;
  text?: string;
}

export interface DashboardSegmentState {
  timeline_type: "segment" | "static_gap";
  segment_id: string;
  event_id: string;
  camera_id: string;
  source_label: string;
  is_media_source: boolean;
  mode: string;
  vlm_model?: string;
  start_time: number;
  end_time: number;
  sort_time?: number;
  display_start_time?: number;
  display_end_time?: number;
  display_time_mode?: "media" | "wall_clock";
  duration_sec: number;
  title?: string;
  summary: string;
  detailed_summary: string;
  gif_url: string | null;
  keyframe_url: string | null;
  is_static: boolean;
  merged_count: number;
  targets: DashboardSegmentTarget[];
  entity_refs: string[];
  entity_ids: string[];
  triggered_rules: string[];
  triggered_rule_labels: string[];
  notification_fired: boolean;
  security_risk: boolean;
  notification_reasons: string[];
  segment_policy_prompt: string | null;
  transcript: string | null;
  dialogue: DashboardSegmentDialogueLine[];
  clip_url: string | null;
  analysis_status?: "partial" | "final" | "skipped";
  is_partial?: boolean;
  partial_received_at?: number;
  analysis_started_at?: number;
  partial_refresh_ms?: number;
  summary_refresh_ms?: number;
  vlm_ttft_ms?: number;
  vlm_first_content_ms?: number;
}
