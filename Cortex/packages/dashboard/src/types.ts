export type { MonitorEvent, MonitorEventType } from "@cortex/shared";

/** A stable display alias for a face-matched entity. */
export interface EntityAlias {
  /** Canonical entity id from Cortex (never shown to user). */
  entity_id: string;
  /** Human-readable name: "Person A", "Person B", ... (or user-edited). */
  display_name: string;
  /** Unix ms timestamp of first observation. Used for deterministic ordering. */
  first_seen: number;
}

/** A semantic memory record surfaced in an entity card. */
export interface SemanticMemory {
  memory_id: string;
  entity_id: string;
  summary: string;
  importance: number | null;
  timestamp: number;
  update_count: number;
}

export type DashboardMemoryKind = "semantic_context" | "episodic_schema" | "episodic_trace" | "episodic";

export interface DashboardMemoryRecord {
  memory_id: string;
  memory_type: DashboardMemoryKind;
  camera_id: string;
  metadata?: Record<string, unknown>;
  event_id?: string;
  event_ids?: string[];
  segment_id?: string;
  summary: string;
  timestamp: number;
  start_ms?: number;
  end_ms?: number;
  source_time_label?: string;
  title?: string;
}

export interface DashboardMemoryEventGroup {
  event_id: string;
  camera_id: string;
  title: string;
  start_ms?: number;
  end_ms?: number;
  schemas: DashboardMemoryRecord[];
  traces: DashboardMemoryRecord[];
}

/** A procedural rule — parsed from procedural-type memory events. */
export interface ProceduralRule {
  rule_id: string;
  description: string;
  /** Qdrant memory UUID — present when the event carried a `memory_id` field. */
  memory_id: string | null;
  /** Segment ids (seg_xxx) that have triggered this rule during the session. */
  triggered_segments: string[];
}

/** Selection state broadcast across the dashboard. */
export type Selection =
  | { kind: "none" }
  | { kind: "entity"; entity_id: string }
  | { kind: "segment"; segment_id: string }
  | { kind: "rule"; rule_id: string };
