export interface LlmTokenUsage {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  reasoning_tokens?: number | null;
  total_tokens?: number | null;
}

export interface LlmCallRequestMeta {
  response_format?: "json" | "text";
  max_tokens?: number;
  max_completion_tokens?: number;
  max_output_tokens?: number;
  request_timeout_ms?: number;
  max_retries?: number;
  reasoning_effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  provider_options?: Record<string, unknown>;
  temperature?: number | null;
  image_count?: number;
  frame_count?: number;
  extra_image_count?: number;
  has_detection_context?: boolean;
  has_working_memory_images?: boolean;
  fallback_layer?: string;
  target_aggregation?: string;
  prompt_hash?: string;
}

export interface LlmCallAttemptRecord {
  attempt: number;
  status: "ok" | "error";
  latency_ms: number;
  retryable?: boolean;
  next_delay_ms?: number;
  http_status?: number;
  retry_after_ms?: number | null;
  error_type?: string;
  error_message?: string;
}

export interface LlmCallRecord {
  schema_version: 1;
  call_id: string;
  run_id?: string;
  snapshot_version?: string;
  video_id?: string;
  camera_id?: string;
  segment_id?: string;
  stage: string;
  provider: "openai" | "gemini" | string;
  model: string;
  prompt_version?: string;
  request?: LlmCallRequestMeta;
  usage?: LlmTokenUsage | null;
  latency_ms: number;
  status: "ok" | "error";
  retry_count?: number;
  attempts?: LlmCallAttemptRecord[];
  error?: string | null;
  error_details?: Record<string, unknown>;
  created_at: string;
}

export interface SegmentArchiveWarning {
  stage: string;
  message: string;
}

export interface SegmentArchive {
  schema_version: 1;
  input?: Record<string, unknown>;
  analyzers?: Record<string, unknown>;
  vlm?: Record<string, unknown>;
  postprocess?: Record<string, unknown>;
  memory_write?: Record<string, unknown>;
  event_narrative?: Record<string, unknown>;
  warnings?: SegmentArchiveWarning[];
}
