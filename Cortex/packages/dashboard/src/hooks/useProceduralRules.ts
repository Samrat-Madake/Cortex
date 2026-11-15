import { useCallback, useMemo, useState } from "react";
import type { MonitorEvent, ProceduralRule } from "../types";
import type { Segment } from "./useSegments";

/** Result shape returned by {@link useProceduralRules}. */
export interface ProceduralRulesResult {
  /** All procedural rules observed in the event stream, each with triggered segments. */
  rules: ProceduralRule[];
  /**
   * Reverse lookup: segment_id → rule_ids triggered on that segment.
   * Empty map entries are omitted; callers should default to `[]` on miss.
   */
  segmentRuleMap: Map<string, string[]>;
  /**
   * Reverse lookup: segment_id -> rule descriptions triggered on that segment.
   * This is display-only; rule ids remain the stable selection keys.
   */
  segmentRuleLabelMap: Map<string, string[]>;
  /** Mark a rule as locally deleted (filters it from the displayed list). */
  markDeleted: (ruleId: string) => void;
}

/**
 * Parse `memory:memory_added` events of type `procedural` and build
 * rule-to-segment linkage using backend-provided `segment.triggered_rules`.
 *
 * Dedup key preference: `memory_id` when present, otherwise the first 40 chars
 * of the description. When the same rule appears in multiple events we keep the
 * latest description (matches newest-first event order).
 */
export function useProceduralRules(
  events: MonitorEvent[],
  segments: Segment[],
): ProceduralRulesResult {
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());

  const markDeleted = useCallback((ruleId: string) => {
    setDeletedIds(prev => {
      const next = new Set(prev);
      next.add(ruleId);
      return next;
    });
  }, []);

  const result = useMemo(() => {
    // Aggregate rules by id. Event stream is newest-first, so the first
    // occurrence carries the latest description.
    const ruleById = new Map<string, { rule_id: string; memory_id: string | null; description: string }>();
    const deletedEventIds = new Set<string>();

    for (const e of events) {
      if (
        e.type === "memory:memory_deleted" &&
        e.data.memory_type === "procedural" &&
        typeof e.data.memory_id === "string"
      ) {
        deletedEventIds.add(e.data.memory_id);
        continue;
      }
      if (e.type !== "memory:memory_added") continue;
      if (e.data.memory_type !== "procedural") continue;

      const description = String(e.data.summary_preview ?? e.data.summary ?? "").trim();
      if (!description) continue;

      const rawMemoryId = typeof e.data.memory_id === "string" ? e.data.memory_id : "";
      const rule_id = rawMemoryId || description.slice(0, 40);
      if (!rule_id) continue;

      // Skip locally-deleted rules.
      if (deletedIds.has(rule_id) || (rawMemoryId && deletedEventIds.has(rawMemoryId))) continue;

      if (!ruleById.has(rule_id)) {
        ruleById.set(rule_id, { rule_id, memory_id: rawMemoryId || null, description });
      }
    }

    // Build the final rules array + reverse segmentRuleMap.
    const rules: ProceduralRule[] = [];
    const segmentRuleMap = new Map<string, string[]>();
    const segmentRuleLabelMap = new Map<string, string[]>();

    for (const { rule_id, memory_id, description } of ruleById.values()) {
      const triggered_segments: string[] = [];

      for (const seg of segments) {
        if (!seg.segment_id) continue;
        if (!seg.triggered_rules.includes(rule_id)) continue;
        triggered_segments.push(seg.segment_id);
        const existing = segmentRuleMap.get(seg.segment_id);
        if (existing) {
          existing.push(rule_id);
        } else {
          segmentRuleMap.set(seg.segment_id, [rule_id]);
        }
        const existingLabels = segmentRuleLabelMap.get(seg.segment_id);
        if (existingLabels) {
          existingLabels.push(description);
        } else {
          segmentRuleLabelMap.set(seg.segment_id, [description]);
        }
      }
      rules.push({ rule_id, memory_id, description, triggered_segments });
    }

    return { rules, segmentRuleMap, segmentRuleLabelMap };
  }, [events, segments, deletedIds]);

  return { ...result, markDeleted };
}
