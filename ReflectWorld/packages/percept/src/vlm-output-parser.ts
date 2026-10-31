// packages/percept/src/vlm-output-parser.ts
//
// Parses subject-proposal VLM JSON and validates structural references.
// Identity ownership, WM claim arbitration, and ReID write planning are delegated
// to identity-resolver.ts.

import type { VlmEventContextUpdate, VlmOutput, VlmSubjectProposalTarget, VlmSubjectProposalTargetDetail, VlmTargetIdentity, WorkingMemoryTarget } from "./types.js";
import type { DetectionRegistry } from "./did-registry.js";
import type { GalleryCandidate, ParsedSubjectProposalTarget } from "./identity-resolver.js";
import { resolveIdentityClaimHints, resolveTargetIdentities } from "./identity-resolver.js";

function coerceTextField(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value
      .map((item) => coerceTextField(item))
      .filter(Boolean)
      .join(", ");
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function coerceTid(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeTargetIdentity(value: unknown): VlmTargetIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name) return undefined;
  const evidence = typeof record.evidence === "string" ? record.evidence.trim() : undefined;
  const rawSource = typeof record.source === "string" ? record.source.trim() : undefined;
  const source = rawSource === "visible_nameplate"
    || rawSource === "visible_text"
    || rawSource === "spoken"
    || rawSource === "direct_address"
    || rawSource === "self_introduction"
    || rawSource === "direct_address_response"
    || rawSource === "third_person_reference"
    || rawSource === "dialogue_about_person"
    || rawSource === "dialogue_about_visible_person"
    || rawSource === "other"
    ? rawSource
    : undefined;
  return {
    name,
    ...(evidence ? { evidence } : {}),
    ...(source ? { source } : {}),
  };
}

function normalizeSpeakerIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = [...new Set(
    value
      .map((item) => typeof item === "string" ? item.trim() : "")
      .filter(Boolean),
  )];
  return ids.length > 0 ? ids : undefined;
}

export { isReidWritableFace } from "./face-reid-policy.js";
export type { GalleryCandidate, ParsedSubjectProposalTarget } from "./identity-resolver.js";

export interface ParsedSubjectProposalOutput {
  targets: ParsedSubjectProposalTarget[];
  errors: string[];
  title?: string;
  summary?: string;
  detailed_summary?: string;
  retrieval_compact?: string[];
  security_risk?: boolean;
  security_reason?: string;
  notify_user?: boolean;
  matched_rule_ids?: string[];
  content_type?: VlmOutput["content_type"];
  key_modality?: VlmOutput["key_modality"];
  is_static_scene?: boolean;
  event_boundary?: boolean;
  event_summary?: string;
  event_context_update?: VlmEventContextUpdate;
  custom_fields?: Record<string, string | number | boolean>;
  segment_policy_exit_met?: boolean;
  best_frame_index?: number;
}

type SubjectProposalEnvelope = Record<string, unknown> & {
  targets?: VlmSubjectProposalTarget[];
  target_details?: VlmSubjectProposalTargetDetail[];
};

type PrelimSubjectTarget = {
  raw: VlmSubjectProposalTarget;
  validBboxIds: string[];
  normalizedType: string;
};

export interface ParseSubjectProposalOptions {
  /** Enable body ReID entity fallback. Default false preserves the legacy face/WM-only parser path. */
  bodyReIdEnabled?: boolean;
  /** Optional hard allow-list for D{id}s shown to the VLM as selectable evidence. */
  allowedDidIds?: ReadonlySet<string>;
  /** Require temporary live-latency target ids for critical/final target correlation. */
  requireTid?: boolean;
}

// ── Normalization ──

/** Normalize a detection class_name to a canonical type. */
function normalizeClass(label: string): string {
  const lower = label.toLowerCase();
  if (lower === "person") return "person";
  if (["car", "truck", "bus", "motorcycle", "bicycle", "boat", "train"].includes(lower))
    return "vehicle";
  if (["dog", "cat", "bird", "horse", "cow", "sheep"].includes(lower))
    return "animal";
  return lower;
}

function mergeSubjectProposalTargetDetails(
  targets: VlmSubjectProposalTarget[],
  details: VlmSubjectProposalTargetDetail[] | undefined,
  requireTid = false,
): VlmSubjectProposalTarget[] {
  if (!Array.isArray(details) || details.length === 0) return targets;
  const targetTidCounts = new Map<string, number>();
  if (requireTid) {
    for (const target of targets) {
      const tid = coerceTid(target.tid);
      if (!tid) continue;
      targetTidCounts.set(tid, (targetTidCounts.get(tid) ?? 0) + 1);
    }
  }
  const detailByRef = new Map<string, VlmSubjectProposalTargetDetail>();
  for (const detail of details) {
    if (!detail || typeof detail !== "object") continue;
    const refs = [
      ...(requireTid ? [detail.tid] : []),
      detail.target_ref,
      detail.track_id,
      detail.bbox_id,
      ...(Array.isArray(detail.bbox_ids) ? detail.bbox_ids : []),
    ];
    for (const ref of refs) {
      const key = typeof ref === "string" ? ref.trim() : "";
      if (key) detailByRef.set(key, detail);
    }
  }

  return targets.map((target, index) => {
    if (requireTid) {
      const tid = coerceTid(target.tid);
      if (!tid || targetTidCounts.get(tid) !== 1) return target;
      const detail = tid ? detailByRef.get(tid) : undefined;
      if (!detail) return target;
      return {
        ...target,
        appearance: target.appearance ?? detail.appearance,
        behavior: target.behavior ?? detail.behavior,
      };
    }
    const refs = [
      target.bbox_ids?.[0],
      ...(Array.isArray(target.bbox_ids) ? target.bbox_ids : []),
    ];
    let detail: VlmSubjectProposalTargetDetail | undefined;
    for (const ref of refs) {
      const key = typeof ref === "string" ? ref.trim() : "";
      if (key && detailByRef.has(key)) {
        detail = detailByRef.get(key);
        break;
      }
    }
    detail ??= details[index];
    if (!detail) return target;
    return {
      ...target,
      appearance: target.appearance ?? detail.appearance,
      behavior: target.behavior ?? detail.behavior,
    };
  });
}

// ── Main parser ──

/**
 * Validate subject-proposal VLM raw JSON output against DetectionRegistry.
 *
 * Parser-owned structural validation:
 * 1. D{id} existence
 * 2. D{id} selectable allow-list
 * 3. D{id} type consistency
 * 4. same-frame cannot-link for person targets
 *
 * IdentityResolver-owned normalization:
 * - D{id} duplicate ownership
 * - matched_wm_target existence/class/one-to-one
 * - current ReID / pending-face WM inference
 * - entity_id, gallery candidates, and unsafe reasons
 */
export function parseSubjectProposalOutput(
  rawJson: string,
  registry: DetectionRegistry,
  wmTargets: WorkingMemoryTarget[],
  options: ParseSubjectProposalOptions = {},
): ParsedSubjectProposalOutput {
  const errors: string[] = [];

  // ── Parse raw JSON ──
  let rawTargets: VlmSubjectProposalTarget[];
  let envelope: SubjectProposalEnvelope | undefined;
  try {
    const parsed: unknown = JSON.parse(rawJson);
    // Accept both {"targets": [...]} wrapper and bare [...] array
    if (Array.isArray(parsed)) {
      rawTargets = parsed as VlmSubjectProposalTarget[];
    } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).targets)) {
      envelope = parsed as SubjectProposalEnvelope;
      rawTargets = mergeSubjectProposalTargetDetails(envelope.targets ?? [], envelope.target_details, options.requireTid === true);
    } else {
      return { targets: [], errors: ["VLM output has no targets array"] };
    }
  } catch (e) {
    return {
      targets: [],
      errors: [`JSON parse error: ${(e as Error).message}`],
    };
  }

  // First pass: apply Rules 1-4 to each target, collect preliminary results
  const prelimTargets: PrelimSubjectTarget[] = [];
  const seenTids = new Set<string>();
  const validTidsByTargetIndex = new Map<number, string>();

  for (let i = 0; i < rawTargets.length; i++) {
    const raw = rawTargets[i]!;
    const normalizedType = normalizeClass(raw.type ?? "");
    let validBboxIds: string[] = [];
    const tid = coerceTid(raw.tid);
    if (options.requireTid) {
      if (!tid) {
        errors.push(`target[${i}]: missing required temporary tid`);
      } else if (seenTids.has(tid)) {
        errors.push(`target[${i}]: duplicate temporary tid "${tid}"`);
        for (let priorIdx = 0; priorIdx < i; priorIdx++) {
          if (validTidsByTargetIndex.get(priorIdx) === tid) validTidsByTargetIndex.delete(priorIdx);
        }
      } else {
        seenTids.add(tid);
        validTidsByTargetIndex.set(i, tid);
      }
    }

    for (const did of raw.bbox_ids ?? []) {
      if (options.allowedDidIds && !options.allowedDidIds.has(did)) {
        errors.push(`target[${i}]: D{id} "${did}" is not selectable for VLM target output`);
        continue;
      }

      // Rule 1: D{id} existence
      const entry = registry.get(did);
      if (!entry) {
        errors.push(`target[${i}]: D{id} "${did}" not found in registry`);
        continue;
      }

      // Rule 3: Type consistency
      const entryNorm = normalizeClass(entry.class_name);
      if (entryNorm !== normalizedType) {
        errors.push(
          `target[${i}]: D{id} "${did}" class "${entry.class_name}" (→${entryNorm}) mismatches target type "${raw.type}" (→${normalizedType})`,
        );
        continue;
      }

      validBboxIds.push(did);
    }

    // Rule 4: Same-frame cannot-link for person targets
    if (normalizedType === "person") {
      validBboxIds = applySameFrameCannotLink(validBboxIds, registry, errors, i);
    }

    prelimTargets.push({ raw, validBboxIds, normalizedType });
  }

  const identityClaims = resolveIdentityClaimHints({
    registry,
    wmTargets,
    bodyReIdEnabled: options.bodyReIdEnabled === true,
    targets: prelimTargets.map(({ raw, validBboxIds, normalizedType }, i) => ({
      targetIdx: i,
      type: normalizedType,
      bbox_ids: validBboxIds,
      matched_wm_target: raw.matched_wm_target ?? null,
    })),
  });
  errors.push(...identityClaims.errors);
  const claimByTargetIdx = new Map(identityClaims.targets.map((target) => [target.targetIdx, target]));

  // ── Identity resolution: stable entity, WM inheritance, and ReID write plan ──

  const resolvedIdentities = resolveTargetIdentities({
    registry,
    wmTargets,
    bodyReIdEnabled: options.bodyReIdEnabled === true,
    targets: prelimTargets.map(({ raw, validBboxIds, normalizedType }, i) => {
      const claim = claimByTargetIdx.get(i);
      const identity = normalizeTargetIdentity(raw.identity);
      const speakerIds = normalizeSpeakerIds(raw.speaker_ids);
      return {
        bbox_ids: claim?.bbox_ids ?? validBboxIds,
        matched_wm_target: claim?.matched_wm_target ?? null,
        ...(claim?.matched_wm_target_source ? { matched_wm_target_source: claim.matched_wm_target_source } : {}),
        ...(claim?.reid_unsafe_reason ? { reid_unsafe_reason: claim.reid_unsafe_reason } : {}),
        ...(claim?.matched_wm_target_rejected_reason
          ? { matched_wm_target_rejected_reason: claim.matched_wm_target_rejected_reason }
          : {}),
        ...(claim?.visual_identity_only ? { visual_identity_only: true } : {}),
        targetIdx: i,
        ...(validTidsByTargetIndex.has(i) ? { tid: validTidsByTargetIndex.get(i)! } : {}),
        type: normalizedType,
        appearance: coerceTextField(raw.appearance),
        ...(raw.behavior !== undefined ? { behavior: coerceTextField(raw.behavior) } : {}),
        ...(identity ? { identity } : {}),
        ...(speakerIds ? { speaker_ids: speakerIds } : {}),
      };
    }),
  });
  errors.push(...resolvedIdentities.errors);
  const results = resolvedIdentities.targets;

  // Drop targets with no valid bbox_ids remaining (all stripped by validation)
  const finalTargets = results.filter((t) => {
    if (t.bbox_ids.length === 0) {
      errors.push(`target dropped: type=${t.type} had all bbox_ids removed by validation`);
      return false;
    }
    return true;
  });
  return {
    targets: finalTargets,
    errors,
    ...extractSubjectProposalEnvelope(envelope),
  };
}

/** Parse only the natural-language envelope fields; ignore target entries entirely. */
export function parseSubjectProposalEnvelopeOnly(rawJson: string): ParsedSubjectProposalOutput {
  try {
    const parsed: unknown = JSON.parse(rawJson);
    const envelope = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
    return {
      targets: [],
      errors: [],
      ...extractSubjectProposalEnvelope(envelope),
    };
  } catch (e) {
    return {
      targets: [],
      errors: [`JSON parse error: ${(e as Error).message}`],
    };
  }
}

function extractSubjectProposalEnvelope(
  envelope: Record<string, unknown> | undefined,
): Omit<ParsedSubjectProposalOutput, "targets" | "errors"> {
  if (!envelope) return {};
  const out: Omit<ParsedSubjectProposalOutput, "targets" | "errors"> = {};
  const title = normalizeOneLine(envelope.title);
  const summary = normalizeOneLine(envelope.summary);
  const detailedSummary = normalizeOneLine(envelope.detailed_summary);
  const retrievalCompact = normalizeRetrievalCompact(envelope.retrieval_compact);
  const securityReason = normalizeOneLine(envelope.security_reason);
  const eventSummary = normalizeOneLine(envelope.event_summary);
  const eventContextUpdate = normalizeEventContextUpdate(envelope.event_context_update);
  if (title) out.title = title;
  if (summary) out.summary = summary;
  if (detailedSummary) out.detailed_summary = detailedSummary;
  if (retrievalCompact) out.retrieval_compact = retrievalCompact;
  if (typeof envelope.security_risk === "boolean") out.security_risk = envelope.security_risk;
  if (securityReason) out.security_reason = securityReason;
  if (typeof envelope.notify_user === "boolean") out.notify_user = envelope.notify_user;
  if (Array.isArray(envelope.matched_rule_ids)) {
    out.matched_rule_ids = envelope.matched_rule_ids
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map((id) => id.trim());
  }
  if (isContentType(envelope.content_type)) out.content_type = envelope.content_type;
  if (isKeyModality(envelope.key_modality)) out.key_modality = envelope.key_modality;
  if (typeof envelope.is_static_scene === "boolean") out.is_static_scene = envelope.is_static_scene;
  if (typeof envelope.event_boundary === "boolean") out.event_boundary = envelope.event_boundary;
  if (eventSummary) out.event_summary = eventSummary;
  if (eventContextUpdate) out.event_context_update = eventContextUpdate;
  if (typeof envelope.segment_policy_exit_met === "boolean") {
    out.segment_policy_exit_met = envelope.segment_policy_exit_met;
  }
  const customFields = normalizeCustomFields(envelope.custom_fields);
  if (customFields) out.custom_fields = customFields;
  if (typeof envelope.best_frame_index === "number" && Number.isFinite(envelope.best_frame_index) && envelope.best_frame_index >= 0) {
    out.best_frame_index = Math.floor(envelope.best_frame_index);
  }
  return out;
}

function normalizeEventContextUpdate(value: unknown): VlmEventContextUpdate | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const setting = normalizeOneLine(record.setting);
  const participantUpdates = Array.isArray(record.participant_updates)
    ? record.participant_updates
      .map((item): NonNullable<VlmEventContextUpdate["participant_updates"]>[number] | undefined => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
        const participant = item as Record<string, unknown>;
        const role = normalizeOneLine(participant.role);
        const visualHints = normalizeOneLine(participant.visual_hints);
        if (!role && !visualHints) return undefined;
        return {
          ...(role ? { role } : {}),
          ...(visualHints ? { visual_hints: visualHints } : {}),
        };
      })
      .filter((item): item is NonNullable<VlmEventContextUpdate["participant_updates"]>[number] => Boolean(item))
    : undefined;
  if (!setting && !participantUpdates?.length) return undefined;
  return {
    ...(setting ? { setting } : {}),
    ...(participantUpdates?.length ? { participant_updates: participantUpdates } : {}),
  };
}

function normalizeOneLine(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function normalizeRetrievalCompact(value: unknown): string[] | undefined {
  const rawItems = Array.isArray(value) ? value : (typeof value === "string" ? value.split(/[;\n]/) : []);
  const items = rawItems
    .map((item) => typeof item === "string" ? item.replace(/\s+/g, " ").trim() : "")
    .filter(Boolean)
    .slice(0, 8)
    .map((item) => item.split(/\s+/).slice(0, 8).join(" "));
  return items.length > 0 ? items : undefined;
}

function isContentType(value: unknown): value is VlmOutput["content_type"] {
  return value === "surveillance" || value === "lecture" || value === "conversation"
    || value === "activity" || value === "sports" || value === "other";
}

function isKeyModality(value: unknown): value is VlmOutput["key_modality"] {
  return value === "visual" || value === "audio" || value === "both";
}

function normalizeCustomFields(value: unknown): Record<string, string | number | boolean> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (typeof fieldValue === "string" || typeof fieldValue === "number" || typeof fieldValue === "boolean") {
      out[key] = fieldValue;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ── Rule 4: Same-frame cannot-link ──

/**
 * For person targets, at most 1 D{id} per frame_idx. Keep highest confidence.
 */
function applySameFrameCannotLink(
  bboxIds: string[],
  registry: DetectionRegistry,
  errors: string[],
  targetIdx: number,
): string[] {
  // Group by frame_idx
  const byFrame = new Map<number, Array<{ did: string; confidence: number }>>();
  for (const did of bboxIds) {
    const entry = registry.get(did)!;
    const group = byFrame.get(entry.frame_idx) ?? [];
    group.push({ did, confidence: entry.confidence });
    byFrame.set(entry.frame_idx, group);
  }

  const surviving: string[] = [];
  for (const [frameIdx, group] of byFrame) {
    if (group.length === 1) {
      surviving.push(group[0]!.did);
      continue;
    }

    // Keep highest confidence
    group.sort((a, b) => b.confidence - a.confidence);
    surviving.push(group[0]!.did);

    for (let k = 1; k < group.length; k++) {
      errors.push(
        `target[${targetIdx}]: same-frame cannot-link — dropped "${group[k]!.did}" on frame ${frameIdx} (kept "${group[0]!.did}")`,
      );
    }
  }

  return surviving;
}
