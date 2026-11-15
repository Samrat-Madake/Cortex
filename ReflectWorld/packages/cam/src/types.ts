export type SourceProtocol = "ffmpeg" | "http" | "phone" | "generic";

export interface SourceConfig {
  /** Internal ASCII-safe identifier for paths, URLs, and database keys. */
  id: string;
  /** User-facing display name (may contain unicode, spaces). */
  name: string;
  input: string;
  protocol: SourceProtocol;
  /** Dashboard-only owner scope for shared demo deployments. */
  dashboard_user_id?: string;
  /** Dashboard-only browser session scope for shared demo deployments. */
  dashboard_session_id?: string;
  go2rtcSources?: string[];
  options?: {
    resolution?: { width: number; height: number };
    fps?: number;
  };
  created_at: number;
}

export interface SnapshotOptions {
  resolution?: { width: number; height: number };
  quality?: number;
}

export interface WatchMode {
  mode: "event" | "stream";
  fps?: number;
}

// Import + re-export canonical FrameDetection from shared
import type { FrameDetection as _FrameDetection } from "@cortex/shared";
export type { FrameDetection } from "@cortex/shared";

export interface FrameResult {
  data: string;
  /** Canonical frame time in milliseconds.
   *  Live/go2rtc streams use wall-clock time; file/video runners use media PTS. */
  timestamp: number;
  source_name: string;
  width?: number;
  height?: number;
  detections?: _FrameDetection[];
  /** Internal Dashboard hint: id of the segment currently accumulating. */
  _segment_id?: string;
  /** Internal Dashboard hint: timestamp of the first frame in the accumulating segment. */
  _segment_start_timestamp?: number;
  /** Internal: async per-frame analysis that must finish before segment dispatch. */
  _frame_analysis_promise?: Promise<void>;
}

export type CamAction =
  | "add_source"
  | "list_sources"
  | "remove_source"
  | "snapshot"
  | "watch"
  | "stop_watch"
  | "set_sampling"
  | "live_view"
  | "list_recordings"
  | "switch_mode"
  | "save_reference";
