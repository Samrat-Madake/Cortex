// Monitor event type definitions for real-time WebSocket broadcast.

export type MonitorEventType =
  // Cam events
  | "cam:source_added"
  | "cam:source_removed"
  | "cam:watch_started"
  | "cam:watch_stopped"
  | "cam:first_frame"
  | "cam:segment_built"
  | "cam:motion_detected"
  | "cam:hot_swap_timeout"
  | "cam:source_waiting"
  | "cam:source_reconnecting"
  | "cam:source_unavailable"
  // Perception events
  | "perception:analysis_started"
  | "perception:analysis_completed"
  | "perception:segment_partial"
  | "perception:segment_skipped"
  | "perception:vlm_result"
  | "perception:notification_resolved"
  | "perception:working_memory_updated"
  | "perception:event_boundary"
  | "perception:frame_detections"
  | "perception:frame_detection_dropped"
  // Memory events
  | "memory:memory_added"
  // Reserved for future semantic-memory edits; Dashboard accepts it but there is
  // no active producer today.
  | "memory:memory_updated"
  | "memory:memory_deleted"
  | "memory:identity_set"
  // Semantic context events
  | "semantic_context:user_background_updated"
  // System events
  | "system:service_health"
  | "system:service_origins"
  | "system:pipeline_metrics"
  | "system:active_models"
  | "system:pipeline_trace"
  | "system:capture_hint"
  | "system:tool_invoked"
  | "system:queue_overflow"
  | "system:component_status"
  | "system:operation_error"
  | "system:connected"
  // Dashboard state projection events
  | "dashboard:source_state"
  | "dashboard:segment_state"
  // VisionController events
  | "vision_controller:rule_fired"
  | "vision_controller:state_changed"
  | "vision_controller:action_applied"
  | "vision_controller:agent_consulted"
  | "vision_controller:consultation_effect_observed"
  // Runtime config events
  | "system:config_changed";

export interface MonitorEvent {
  type: MonitorEventType;
  timestamp: number;
  camera_id?: string;
  data: Record<string, unknown>;
}
