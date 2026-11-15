import { useCallback, useState } from "react";
import type { Selection } from "../types";

/**
 * Central selection for linked filtering. At most one of entity/segment/rule is active.
 * Toggling the same target clears the selection.
 */
export function useSelectionState() {
  const [selection, setSelection] = useState<Selection>({ kind: "none" });

  const selectEntity = useCallback((entity_id: string) => {
    setSelection(s => (s.kind === "entity" && s.entity_id === entity_id ? { kind: "none" } : { kind: "entity", entity_id }));
  }, []);
  const selectSegment = useCallback((segment_id: string) => {
    setSelection(s => (s.kind === "segment" && s.segment_id === segment_id ? { kind: "none" } : { kind: "segment", segment_id }));
  }, []);
  const selectRule = useCallback((rule_id: string) => {
    setSelection(s => (s.kind === "rule" && s.rule_id === rule_id ? { kind: "none" } : { kind: "rule", rule_id }));
  }, []);
  const clear = useCallback(() => setSelection({ kind: "none" }), []);

  return { selection, selectEntity, selectSegment, selectRule, clear };
}
