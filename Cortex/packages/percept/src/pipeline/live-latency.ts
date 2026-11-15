import type { SttOutput, VlmOutput } from "../types.js";
import type { ParsedSubjectProposalOutput, ParsedSubjectProposalTarget } from "../vlm-output-parser.js";

const LIVE_LATENCY_CRITICAL_FIELDS = new Set([
  "title",
  "summary",
  "security_risk",
  "is_static_scene",
  "notify_user",
  "matched_rule_ids",
  "best_frame_index",
  "targets",
  "main_targets",
  "event_boundary",
]);

const LIVE_LATENCY_NON_CRITICAL_FIELDS = new Set([
  "security_reason",
  "detailed_summary",
  "retrieval_compact",
  "event_summary",
  "target_details",
  "segment_policy_exit_met",
  "content_type",
  "key_modality",
  "custom_fields",
]);

const LIVE_LATENCY_REQUIRED_BASE_FIELDS = [
  "title",
  "summary",
  "security_risk",
  "is_static_scene",
  "notify_user",
  "matched_rule_ids",
  "best_frame_index",
  "event_boundary",
] as const;

type LiveLatencyCriticalField = typeof LIVE_LATENCY_REQUIRED_BASE_FIELDS[number]
  | "targets"
  | "main_targets";

export function isLiveLatencyCriticalField(field: string): field is LiveLatencyCriticalField {
  return LIVE_LATENCY_CRITICAL_FIELDS.has(field);
}

type LiveLatencyCriticalSchema = "subject_proposal" | "vlm_only";

export function resolveLiveLatencyRequiredFields(
  schema: LiveLatencyCriticalSchema,
  _input: unknown = undefined,
): string[] {
  const targetField = schema === "subject_proposal" ? "targets" : "main_targets";
  return [...LIVE_LATENCY_REQUIRED_BASE_FIELDS, targetField];
}

export function isLiveLatencyNonCriticalField(field: string): boolean {
  return LIVE_LATENCY_NON_CRITICAL_FIELDS.has(field);
}

export function hasSpeakerDiarization(sttData: SttOutput | undefined): boolean {
  return Boolean(sttData?.segments?.some((s) => s.speaker));
}

export type StreamingCriticalSnapshot = Partial<Pick<
  ParsedSubjectProposalOutput,
  | "title"
  | "summary"
  | "security_risk"
  | "is_static_scene"
  | "notify_user"
  | "matched_rule_ids"
  | "best_frame_index"
  | "event_boundary"
>> & {
  main_targets?: VlmOutput["main_targets"];
  targets?: Array<Pick<
    ParsedSubjectProposalTarget,
    | "type"
    | "tid"
    | "committed_wm_target_id"
    | "bbox_ids"
    | "matched_wm_target"
    | "matched_wm_target_source"
    | "entity_id"
    | "entity_id_source"
    | "subject_index"
    | "name"
    | "first_seen"
    | "identity"
    | "speaker_ids"
  >>;
};

function cloneGalleryCandidate(candidate: ParsedSubjectProposalTarget["gallery_candidates"][number]): ParsedSubjectProposalTarget["gallery_candidates"][number] {
  return {
    ...candidate,
    embedding: [...candidate.embedding],
  };
}

export function cloneFullSubjectProposalTarget(target: ParsedSubjectProposalTarget): ParsedSubjectProposalTarget {
  return {
    ...target,
    ...(target.identity ? { identity: { ...target.identity } } : {}),
    ...(target.speaker_ids ? { speaker_ids: [...target.speaker_ids] } : {}),
    bbox_ids: [...target.bbox_ids],
    gallery_write_dids: target.gallery_write_dids ? [...target.gallery_write_dids] : undefined,
    display_crop_dids: target.display_crop_dids ? [...target.display_crop_dids] : undefined,
    dropped_dids: target.dropped_dids?.map((dropped) => ({ ...dropped })),
    matched_wm_target_rejected_reason: target.matched_wm_target_rejected_reason,
    visual_identity_only: target.visual_identity_only,
    gallery_candidates: target.gallery_candidates.map(cloneGalleryCandidate),
    upsert_candidate: target.upsert_candidate
      ? {
          ...target.upsert_candidate,
          embedding: [...target.upsert_candidate.embedding],
        }
      : undefined,
  };
}

export function cloneStreamingCriticalTarget(target: ParsedSubjectProposalTarget): NonNullable<StreamingCriticalSnapshot["targets"]>[number] {
  return {
    ...(target.tid ? { tid: target.tid } : {}),
    ...(target.committed_wm_target_id ? { committed_wm_target_id: target.committed_wm_target_id } : {}),
    type: target.type,
    bbox_ids: [...target.bbox_ids],
    matched_wm_target: target.matched_wm_target,
    matched_wm_target_source: target.matched_wm_target_source,
    ...(target.identity ? { identity: { ...target.identity } } : {}),
    ...(target.speaker_ids ? { speaker_ids: [...target.speaker_ids] } : {}),
    entity_id: target.entity_id,
    entity_id_source: target.entity_id_source,
    subject_index: target.subject_index,
    name: target.name,
    first_seen: target.first_seen,
  };
}

function criticalComparable(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function criticalTargetKey(target: Pick<ParsedSubjectProposalTarget, "tid">): string | undefined {
  if (target.tid && target.tid.trim()) return `tid:${target.tid.trim()}`;
  return undefined;
}

function criticalTargetComparable(targets: ParsedSubjectProposalTarget[]): Array<Record<string, unknown>> {
  return targets
    .filter((target) => criticalTargetKey(target) !== undefined)
    .map((target) => ({
      key: criticalTargetKey(target),
      tid: target.tid,
      committed_wm_target_id: target.committed_wm_target_id,
      subject_index: target.subject_index,
      type: target.type,
      matched_wm_target: target.matched_wm_target,
      entity_id: target.entity_id,
      entity_id_source: target.entity_id_source,
      name: target.name,
      first_seen: target.first_seen,
      identity: target.identity ? { ...target.identity } : undefined,
      speaker_ids: target.speaker_ids ? [...target.speaker_ids] : undefined,
    }))
    .sort((a, b) => String(a.key).localeCompare(String(b.key)));
}

function setIfDifferent(
  parsed: ParsedSubjectProposalOutput,
  snapshot: StreamingCriticalSnapshot,
  field: keyof StreamingCriticalSnapshot,
  conflicts: Set<string>,
): void {
  if (!Object.prototype.hasOwnProperty.call(snapshot, field)) return;
  const parsedRecord = parsed as unknown as Record<string, unknown>;
  const snapshotRecord = snapshot as Record<string, unknown>;
  const snapshotValue = snapshotRecord[field];
  if (criticalComparable(parsedRecord[field]) !== criticalComparable(snapshotValue)) {
    conflicts.add(field);
    parsedRecord[field] = snapshotValue;
  }
}

export function reconcileStreamingCriticalSnapshot(
  parsed: ParsedSubjectProposalOutput,
  snapshot: StreamingCriticalSnapshot | undefined,
  frozenTargets?: ParsedSubjectProposalTarget[],
): string[] {
  if (!snapshot) return [];
  const conflicts = new Set<string>();
  for (const field of [
    "title",
    "summary",
    "security_risk",
    "is_static_scene",
    "notify_user",
    "matched_rule_ids",
    "best_frame_index",
    "event_boundary",
  ] as const) {
    setIfDifferent(parsed, snapshot, field, conflicts);
  }

  if (frozenTargets) {
    const finalTargets = parsed.targets;
    const finalByKey = new Map<string, ParsedSubjectProposalTarget>();
    for (const target of finalTargets) {
      const key = criticalTargetKey(target);
      if (key === undefined || finalByKey.has(key)) continue;
      finalByKey.set(key, target);
    }
    const findFinalDetails = (critical: ParsedSubjectProposalTarget): ParsedSubjectProposalTarget | undefined => {
      const key = criticalTargetKey(critical);
      return key === undefined ? undefined : finalByKey.get(key);
    };
    const frozenComparable = criticalTargetComparable(frozenTargets);
    const finalComparable = criticalTargetComparable(finalTargets);
    if (criticalComparable(frozenComparable) !== criticalComparable(finalComparable)) {
      conflicts.add("targets");
    }
    parsed.targets = frozenTargets.map((critical) => {
      const merged = cloneFullSubjectProposalTarget(critical);
      const final = findFinalDetails(critical);
      if (final?.appearance) merged.appearance = final.appearance;
      if (final?.behavior) merged.behavior = final.behavior;
      // identity/speaker_ids are optional critical subfields. They may be
      // absent, but if absent at critical release time they must not be
      // backfilled by the final pass; otherwise N+1 would have observed a
      // different identity/dialogue context than the committed final state.
      return merged;
    });
  }
  return [...conflicts];
}

export function reconcileStreamingCriticalVlmOutput(
  output: VlmOutput,
  snapshot: StreamingCriticalSnapshot | undefined,
): string[] {
  if (!snapshot) return [];
  const conflicts = new Set<string>();
  const outputRecord = output as unknown as Record<string, unknown>;
  const snapshotRecord = snapshot as Record<string, unknown>;
  for (const field of [
    "title",
    "summary",
    "security_risk",
    "is_static_scene",
    "notify_user",
    "matched_rule_ids",
    "best_frame_index",
    "event_boundary",
    "main_targets",
  ]) {
    if (!Object.prototype.hasOwnProperty.call(snapshotRecord, field)) continue;
    const snapshotValue = snapshotRecord[field];
    if (criticalComparable(outputRecord[field]) !== criticalComparable(snapshotValue)) {
      conflicts.add(field);
      outputRecord[field] = snapshotValue;
    }
  }
  return [...conflicts];
}
