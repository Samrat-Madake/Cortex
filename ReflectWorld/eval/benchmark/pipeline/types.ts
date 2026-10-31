// eval/benchmark/pipeline/types.ts

/** Dataset input format */
export interface BenchmarkDataset {
  dataset: string;
  version?: string;
  videos: BenchmarkVideo[];
}

export interface BenchmarkVideo {
  id: string;
  path: string;
  duration_sec?: number;
  metadata?: Record<string, unknown>;
  questions: BenchmarkQuestion[];
}

export interface BenchmarkQuestion {
  id: string;
  question: string;
  type: "open" | "mcq" | "yesno";
  options?: string[];
  ground_truth?: string;
}

/** QA output per question */
export interface QAResult {
  id: string;
  question: string;
  type: string;
  status: "ok" | "incomplete";
  answer_mode?: "answer_node" | "unable";
  failure_reason?: "llm_api_error_retry_exhausted" | "no_evidence_ledger" | "insufficient_evidence" | "invalid_final_answer" | "answer_node_failed" | "fatal_error" | null;
  fallback_reason?: "empty_answer" | "invalid_mcq_answer" | "unsupported_candidate_answer" | "missing_candidate_coverage" | "ambiguous_global_summary" | "tool_request_in_final" | "internal_failure_answer" | "api_error_answer_node_finalization" | null;
  retryable?: boolean;
  degraded?: boolean;
  degraded_reasons?: string[];
  tool_calls: ToolCallRecord[];
  debug?: Record<string, unknown>;
  trace?: AgentQATrace;
  agent_answer: string;
  ground_truth?: string;
  total_rounds: number;
  total_latency_ms: number;
}

export interface ToolCallRecord {
  round: number;
  source?:
    | "prefetch"
    | "host_candidate_prefetch"
    | "host_candidate_prefetch_context"
    | "host_question_anchor_prefetch"
    | "host_question_anchor_context"
    | "host_person_fact_prefetch"
    | "controller_executor"
    | "retrieve_expand_policy"
  tool: string;
  params: Record<string, unknown>;
  result_count?: number;
  latency_ms: number;
}

export interface AgentQATrace {
  question_id: string;
  question: string;
  type: string;
  options?: string[];
  camera_id: string;
  events: Array<Record<string, unknown>>;
  final_answer?: string;
  answer_payload?: Record<string, unknown>;
  status?: "ok" | "incomplete";
  answer_mode?: "answer_node" | "unable";
  failure_reason?: "llm_api_error_retry_exhausted" | "no_evidence_ledger" | "insufficient_evidence" | "invalid_final_answer" | "answer_node_failed" | "fatal_error" | null;
  fallback_reason?: "empty_answer" | "invalid_mcq_answer" | "unsupported_candidate_answer" | "missing_candidate_coverage" | "ambiguous_global_summary" | "tool_request_in_final" | "internal_failure_answer" | "api_error_answer_node_finalization" | null;
  retryable?: boolean;
  degraded?: boolean;
  degraded_reasons?: string[];
  total_latency_ms?: number;
}

/** Per-video QA output */
export interface VideoQAOutput {
  video_id: string;
  camera_id: string;
  user_id?: string;
  questions: QAResult[];
}

/** run_meta.json structure */
export interface RunMeta {
  run_id: string;
  dataset: string;
  collection_prefix: string;
  created_at: string;
  config: {
    fps: number;
    frames_per_segment: number;
    vlm_model: string;
    agent_model: string;
  };
  videos: Array<{
    id: string;
    camera_id: string;
    user_id?: string;
    path: string;
    segment_count: number;
  }>;
}
