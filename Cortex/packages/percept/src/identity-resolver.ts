import type { DetectionRegistry } from "./did-registry.js";
import type { DIdEntry, VlmTargetIdentity, WorkingMemoryTarget } from "./types.js";
import { cosineSimilarity } from "./analyzers/clique.js";
import {
  canAppendFaceGallery,
  canInitFaceEntity,
  canUseFaceEntityMatch,
} from "./face-reid-policy.js";
import {
  ACCUMULATOR_FACE_CONSISTENCY,
  WM_PENDING_FACE_MATCH_MARGIN,
} from "./thresholds.js";

export interface GalleryCandidate {
  did: string;
  entity_id: string;
  embedding: number[];
  quality: number;
  yaw?: number;
  pitch?: number;
  /** "confirmed" = face ReID matched this entity. "unmatched" = face had no match, needs sim check. */
  trust: "confirmed" | "unmatched";
}

export type IdentityResolutionOutcome = "keep" | "filter_dids" | "display_only" | "reject_wm" | "drop_target";

export interface IdentityDroppedDid {
  did: string;
  reason: string;
}

export interface ParsedSubjectProposalTarget {
  /** Temporary VLM correlation id used only to reconcile live-latency critical/final targets. */
  tid?: string;
  /**
   * Pipeline-internal WM target already written during live-latency critical
   * release. This is not a VLM continuity claim; final completion reuses it so
   * one segment does not allocate a second WM target for the same tid.
   */
  committed_wm_target_id?: string;
  type: string;
  bbox_ids: string[];
  matched_wm_target: string | null;
  /**
   * Provenance for matched_wm_target. VLM-supplied matches are stronger than
   * parser-inferred continuity. Pipeline uses this to avoid turning weak
   * inferred anonymous continuity into a new stable entity too early.
   */
  matched_wm_target_source?: "vlm" | "current_reid" | "pending_face";
  appearance: string;
  behavior?: string;
  identity?: VlmTargetIdentity;
  speaker_ids?: string[];
  entity_id?: string;
  subject_index?: number | null;
  name?: string | null;
  first_seen?: string | number | null;
  entity_id_source?: "current_reid" | "wm_inherited" | null;
  /**
   * Internal write-safety gate. The target may still be valid for display and
   * event-local continuity, but current D{id} evidence must not create/update
   * stable ReID when VLM grouping is ambiguous.
   */
  reid_unsafe_reason?: string;
  /**
   * VLM claimed this target matched a WM target, but resolver rejected that
   * semantic continuity claim. Current visual evidence may still be safe for a
   * ReID-only seed; it must not create/update WM, subject_index, memory, or UI.
   */
  matched_wm_target_rejected_reason?: string;
  visual_identity_only?: boolean;
  gallery_candidates: GalleryCandidate[];
  /**
   * Resolver-owned execution contract. Pipeline should consume these fields
   * instead of reinterpreting bbox_ids for write/display safety.
   */
  resolution_outcome?: IdentityResolutionOutcome;
  identity_write_safe?: boolean;
  gallery_write_dids?: string[];
  display_crop_dids?: string[];
  dropped_dids?: IdentityDroppedDid[];
  /** Stable target crop selected by pipeline post-processing, not emitted by the VLM. */
  crop_path?: string;
  upsert_candidate?: {
    did: string;
    embedding: number[];
    quality: number;
    yaw?: number;
    pitch?: number;
  };
}

export interface IdentityResolverTargetInput {
  targetIdx: number;
  tid?: string;
  type: string;
  bbox_ids: string[];
  matched_wm_target: string | null;
  matched_wm_target_source?: ParsedSubjectProposalTarget["matched_wm_target_source"];
  appearance: string;
  behavior?: string;
  identity?: VlmTargetIdentity;
  speaker_ids?: string[];
  reid_unsafe_reason?: string;
  matched_wm_target_rejected_reason?: string;
  visual_identity_only?: boolean;
  dropped_dids?: IdentityDroppedDid[];
}

export interface IdentityResolverInput {
  registry: DetectionRegistry;
  wmTargets: WorkingMemoryTarget[];
  targets: IdentityResolverTargetInput[];
  bodyReIdEnabled?: boolean;
}

export interface IdentityResolverOutput {
  targets: ParsedSubjectProposalTarget[];
  errors: string[];
}

export interface IdentityClaimTargetInput {
  targetIdx: number;
  type: string;
  bbox_ids: string[];
  matched_wm_target: string | null;
}

export interface IdentityClaimTargetOutput {
  targetIdx: number;
  bbox_ids: string[];
  matched_wm_target: string | null;
  matched_wm_target_source?: ParsedSubjectProposalTarget["matched_wm_target_source"];
  reid_unsafe_reason?: string;
  matched_wm_target_rejected_reason?: string;
  visual_identity_only?: boolean;
  dropped_dids?: IdentityDroppedDid[];
}

export interface IdentityClaimResolutionInput {
  registry: DetectionRegistry;
  wmTargets: WorkingMemoryTarget[];
  targets: IdentityClaimTargetInput[];
  bodyReIdEnabled?: boolean;
}

export interface IdentityClaimResolutionOutput {
  targets: IdentityClaimTargetOutput[];
  errors: string[];
}

export interface NameIdentityBindingCandidate {
  candidate_id: string;
  name: string;
  /** Stable identity scopes this name would bind to, e.g. target:wm_t1, entity:entity_x, track:D7. */
  binding_keys: string[];
  /** Existing stable name already attached to the same target/entity, if any. */
  existing_name?: string;
}

export interface NameIdentityBindingDecision {
  candidate_id: string;
  allowed: boolean;
  reason?: "missing_binding" | "same_binding_multiple_names" | "same_name_multiple_bindings";
}

const VISIBLE_TEXT_IDENTITY_EVIDENCE_PATTERNS = [
  /\blower[-\s]?third\b/i,
  /\bname\s*plate\b/i,
  /\bnameplate\b/i,
  /\bon[-\s]?screen\s+(?:text|label|caption|graphic|lower[-\s]?third)\b/i,
  /\bvisible\s+(?:text|label|caption|graphic|name)\b/i,
  /\bcaption\b/i,
  /\bid\s*badge\b/i,
  /\blabel\b/i,
];

export function isVisibleTextIdentityEvidence(evidence: string | undefined): boolean {
  if (!evidence?.trim()) return false;
  return VISIBLE_TEXT_IDENTITY_EVIDENCE_PATTERNS.some((pattern) => pattern.test(evidence));
}

export type TargetIdentityNamePersistence = "confirmed" | "hint" | "reject";

export function classifyTargetIdentityNamePersistence(input: {
  source?: VlmTargetIdentity["source"];
  evidence?: string;
  hasVisibleNameAnchor: boolean;
  bindsStableEntity: boolean;
  hasCurrentEntityAnchor: boolean;
}): TargetIdentityNamePersistence {
  const usesVisibleText = input.source === "visible_nameplate"
    || input.source === "visible_text"
    || isVisibleTextIdentityEvidence(input.evidence);
  const usesNameplateSource = input.source === "visible_nameplate";
  let persistence: TargetIdentityNamePersistence;

  switch (input.source) {
    case "visible_nameplate":
    case "visible_text":
    case "self_introduction":
    case "direct_address_response":
    case "dialogue_about_visible_person":
      persistence = "confirmed";
      break;
    case "spoken":
    case "direct_address":
    case "third_person_reference":
    case "dialogue_about_person":
      persistence = "hint";
      break;
    case "other":
      persistence = "reject";
      break;
    default:
      persistence = usesVisibleText ? "confirmed" : "hint";
      break;
  }

  if (persistence === "confirmed") {
    if (usesVisibleText && !usesNameplateSource && !input.hasVisibleNameAnchor) return "reject";

    // Stable entity names must be anchored by current-segment identity evidence.
    // Otherwise an inherited WM match can turn a VLM continuity/nameplate mistake
    // into a long-lived ReID/entity name.
    if (input.bindsStableEntity && !input.hasCurrentEntityAnchor) return "reject";
  }

  return persistence;
}

export function canPersistTargetIdentityName(input: {
  source?: VlmTargetIdentity["source"];
  evidence?: string;
  hasVisibleNameAnchor: boolean;
  bindsStableEntity: boolean;
  hasCurrentEntityAnchor: boolean;
}): boolean {
  return classifyTargetIdentityNamePersistence(input) === "confirmed";
}

export function normalizeIdentityNameKey(name: string | undefined): string {
  return (name ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function identityBindingKeys(input: {
  targetId?: string;
  entityId?: string;
  trackId?: string;
}): string[] {
  const keys: string[] = [];
  if (input.targetId) keys.push(`target:${input.targetId}`);
  if (input.entityId) keys.push(`entity:${input.entityId}`);
  if (input.trackId) keys.push(`track:${input.trackId}`);
  return keys;
}

export interface NameIdentityScope {
  canonicalTrackId: string;
  targetId?: string;
  entityId?: string;
  existingTargetName?: string;
  bindingKeys: string[];
}

/**
 * Resolve the identity scope a name is allowed to bind to.
 *
 * Policy:
 * - A stable entity may bind even when the VLM referenced a non-canonical D{id};
 *   the entity is the stable anchor.
 * - Event-local WM target names may bind only when the referenced D{id} is the
 *   canonical target D{id}. This avoids naming the wrong target when VLM points
 *   at a secondary/ambiguous bbox inside a grouped subject.
 */
export function resolveNameIdentityScope(input: {
  rawTrackId: string;
  normalizedTrackId: string;
  canonicalTrackId?: string;
  entityId?: string;
  targetIdForTrack: (trackId: string) => string | undefined;
  existingNameForTarget?: (targetId: string) => string | undefined;
}): NameIdentityScope | undefined {
  const canonicalTrackId = input.canonicalTrackId;
  if (!canonicalTrackId) return undefined;

  const canBindTarget = Boolean(input.entityId) || input.rawTrackId === input.normalizedTrackId;
  const targetId = canBindTarget
    ? input.targetIdForTrack(canonicalTrackId) ?? input.targetIdForTrack(input.rawTrackId)
    : undefined;
  const existingTargetName = targetId ? input.existingNameForTarget?.(targetId) : undefined;
  return {
    canonicalTrackId,
    entityId: input.entityId,
    targetId,
    existingTargetName,
    bindingKeys: identityBindingKeys({
      targetId,
      entityId: input.entityId,
      trackId: canonicalTrackId,
    }),
  };
}

/**
 * Resolves whether VLM-proposed name bindings are safe to persist.
 *
 * This is intentionally a consistency gate, not a name classifier:
 * - one target/entity scope cannot receive multiple different names;
 * - one name cannot be assigned to multiple target/entity/track scopes in
 *   the same segment.
 *
 * Callers may still keep non-name speaker attribution; rejected candidates
 * must not update WM, ReID, subject display names, or semantic identity cues.
 */
export function resolveNameIdentityBindings(
  candidates: NameIdentityBindingCandidate[],
): Map<string, NameIdentityBindingDecision> {
  const namesByBindingKey = new Map<string, Set<string>>();
  const candidateBindingsByName = new Map<string, Array<{ candidateId: string; bindingKeys: Set<string> }>>();
  const candidateKeys = new Map<string, { name: string; bindingKeys: string[] }>();

  const addName = (bindingKey: string, name: string): void => {
    const names = namesByBindingKey.get(bindingKey) ?? new Set<string>();
    names.add(name);
    namesByBindingKey.set(bindingKey, names);
  };

  for (const candidate of candidates) {
    const name = normalizeIdentityNameKey(candidate.name);
    if (!name) continue;
    const bindingKeys = [...new Set(candidate.binding_keys.filter(Boolean))];
    if (bindingKeys.length === 0) continue;
    candidateKeys.set(candidate.candidate_id, { name, bindingKeys });
    const byName = candidateBindingsByName.get(name) ?? [];
    byName.push({ candidateId: candidate.candidate_id, bindingKeys: new Set(bindingKeys) });
    candidateBindingsByName.set(name, byName);
    for (const bindingKey of bindingKeys) {
      addName(bindingKey, name);
      const existingName = normalizeIdentityNameKey(candidate.existing_name);
      if (existingName) addName(bindingKey, existingName);
    }
  }

  const conflictedBindingKeys = new Map<string, NameIdentityBindingDecision["reason"]>();
  for (const [bindingKey, names] of namesByBindingKey.entries()) {
    if (names.size > 1) conflictedBindingKeys.set(bindingKey, "same_binding_multiple_names");
  }

  for (const [, candidatesForName] of candidateBindingsByName.entries()) {
    if (candidatesForName.length <= 1) continue;
    const components: Array<Set<string>> = [];
    for (const candidate of candidatesForName) {
      const overlapping: number[] = [];
      for (let i = 0; i < components.length; i++) {
        const component = components[i]!;
        if ([...candidate.bindingKeys].some((key) => component.has(key))) overlapping.push(i);
      }
      if (overlapping.length === 0) {
        components.push(new Set(candidate.bindingKeys));
        continue;
      }
      const merged = components[overlapping[0]!]!;
      for (const key of candidate.bindingKeys) merged.add(key);
      for (let i = overlapping.length - 1; i >= 1; i--) {
        const idx = overlapping[i]!;
        for (const key of components[idx]!) merged.add(key);
        components.splice(idx, 1);
      }
    }

    if (components.length <= 1) continue;
    for (const component of components) {
      for (const bindingKey of component) {
        if (!conflictedBindingKeys.has(bindingKey)) {
          conflictedBindingKeys.set(bindingKey, "same_name_multiple_bindings");
        }
      }
    }
  }

  const decisions = new Map<string, NameIdentityBindingDecision>();
  for (const candidate of candidates) {
    const resolved = candidateKeys.get(candidate.candidate_id);
    if (!resolved) {
      decisions.set(candidate.candidate_id, {
        candidate_id: candidate.candidate_id,
        allowed: false,
        reason: "missing_binding",
      });
      continue;
    }
    const reason = resolved?.bindingKeys
      .map((bindingKey) => conflictedBindingKeys.get(bindingKey))
      .find((value): value is NonNullable<typeof value> => Boolean(value));
    decisions.set(candidate.candidate_id, {
      candidate_id: candidate.candidate_id,
      allowed: !reason,
      ...(reason ? { reason } : {}),
    });
  }
  return decisions;
}

export function clearAmbiguousResolvedSubjectNames(
  subjects: Array<{ entity_id?: string; subject_index?: number; name?: string; identity_evidence?: string }>,
): void {
  const subjectKeysByName = new Map<string, Set<string>>();
  for (const subject of subjects) {
    const name = normalizeIdentityNameKey(subject.name);
    if (!name) continue;
    const key = subject.entity_id
      ? `entity:${subject.entity_id}`
      : subject.subject_index != null
        ? `subject:${subject.subject_index}`
        : undefined;
    if (!key) continue;
    const keys = subjectKeysByName.get(name) ?? new Set<string>();
    keys.add(key);
    subjectKeysByName.set(name, keys);
  }

  const ambiguousNames = new Set<string>();
  for (const [name, keys] of subjectKeysByName.entries()) {
    if (keys.size > 1) ambiguousNames.add(name);
  }
  if (ambiguousNames.size === 0) return;
  for (const subject of subjects) {
    if (!ambiguousNames.has(normalizeIdentityNameKey(subject.name))) continue;
    delete subject.name;
    delete subject.identity_evidence;
  }
}

export function directSafeEntityForDid(
  registry: DetectionRegistry,
  did: string,
  expectedEntityId?: string,
): string | undefined {
  const entry = registry.get(did);
  const faceEntityId = entry?.face?.entity_id;
  if (faceEntityId && (!expectedEntityId || faceEntityId === expectedEntityId) && canUseFaceEntityMatch(entry.face)) {
    return faceEntityId;
  }
  return undefined;
}

export function isSafeTrackForTarget(
  registry: DetectionRegistry,
  target: ParsedSubjectProposalTarget,
  did: string,
): boolean {
  if (target.display_crop_dids) {
    return target.display_crop_dids.includes(did) && target.bbox_ids.includes(did) && Boolean(registry.get(did));
  }
  return isSafeTrackEvidenceForTarget(registry, target, did);
}

function isSafeTrackEvidenceForTarget(
  registry: DetectionRegistry,
  target: ParsedSubjectProposalTarget,
  did: string,
): boolean {
  const entry = registry.get(did);
  if (!entry) return false;
  if (target.reid_unsafe_reason && !target.entity_id) return false;
  if (target.entity_id) {
    const faceEntityId = entry.face?.entity_id;
    if (faceEntityId && faceEntityId !== target.entity_id) return false;
    const bodyEntityId = entry.body?.entity_id;
    if (bodyEntityId && bodyEntityId !== target.entity_id) return false;
  }
  return true;
}

export function safeTrackIdsForTarget(
  registry: DetectionRegistry,
  target: ParsedSubjectProposalTarget,
): string[] {
  if (target.display_crop_dids) {
    return target.display_crop_dids.filter((did) => target.bbox_ids.includes(did) && Boolean(registry.get(did)));
  }
  return target.bbox_ids.filter((did) => isSafeTrackForTarget(registry, target, did));
}

export function currentEntityEvidenceDidForCrop(
  registry: DetectionRegistry,
  target: ParsedSubjectProposalTarget,
): string | undefined {
  if (!target.entity_id || target.reid_unsafe_reason) return undefined;
  if (target.upsert_candidate?.did && target.bbox_ids.includes(target.upsert_candidate.did)) {
    return target.upsert_candidate.did;
  }
  return target.bbox_ids.find((did) => {
    const entry = registry.get(did);
    if (!entry) return false;
    if (entry.face?.entity_id === target.entity_id && canUseFaceEntityMatch(entry.face)) return true;
    if (entry.body?.entity_id === target.entity_id) return true;
    return false;
  });
}

export function clearResolvedTargetIdentity(
  target: ParsedSubjectProposalTarget,
  reason: string,
): void {
  target.matched_wm_target = null;
  delete target.entity_id;
  target.entity_id_source = null;
  target.subject_index = null;
  target.name = null;
  target.first_seen = null;
  target.reid_unsafe_reason = target.reid_unsafe_reason ?? reason;
  target.gallery_candidates = [];
  target.gallery_write_dids = [];
  target.display_crop_dids = [];
  target.identity_write_safe = false;
  target.resolution_outcome = "display_only";
  delete target.upsert_candidate;
}

export function resolveIdentityClaimHints(input: IdentityClaimResolutionInput): IdentityClaimResolutionOutput {
  const errors: string[] = [];
  const wmTargetMap = new Map<string, WorkingMemoryTarget>();
  for (const wm of input.wmTargets) wmTargetMap.set(wm.target_id, wm);

  const targets = input.targets.map((target) => ({
    targetIdx: target.targetIdx,
    type: normalizeIdentityClass(target.type),
    bbox_ids: [...target.bbox_ids],
    matched_wm_target: target.matched_wm_target,
    dropped_dids: [],
  }));
  const sources: Array<ParsedSubjectProposalTarget["matched_wm_target_source"] | undefined> = [];
  const unsafeReasons = new Map<number, string>();
  const wmClaimRejectedReasons = new Map<number, string>();
  const markReidUnsafe = (targetIdx: number, reason: string): void => {
    if (!unsafeReasons.has(targetIdx)) unsafeReasons.set(targetIdx, reason);
  };
  const rejectWmClaim = (targetIdx: number, reason: string): void => {
    if (!wmClaimRejectedReasons.has(targetIdx)) wmClaimRejectedReasons.set(targetIdx, reason);
  };

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]!;
    const wmId = validateMatchedWmTarget({
      targetIdx: target.targetIdx,
      targetType: target.type,
      matchedWmTarget: target.matched_wm_target,
      wmTargetMap,
      errors,
    });
    target.matched_wm_target = wmId;
    sources[i] = wmId ? "vlm" : undefined;
  }

  applyDuplicateDidOwnership({
    targets,
    sources,
    wmTargetMap,
    registry: input.registry,
    bodyReIdEnabled: input.bodyReIdEnabled === true,
    errors,
    markReidUnsafe,
  });

  validateVlmWmClaimsByPendingFaceContinuity({
    targets,
    sources,
    wmTargetMap,
    registry: input.registry,
    errors,
    rejectWmClaim,
  });

  const entityEvidenceByTarget = alignWmClaimsByCurrentEntity({
    targets,
    sources,
    wmTargetMap,
    registry: input.registry,
    errors,
    skipTargetIndexes: new Set(wmClaimRejectedReasons.keys()),
  });

  alignWmClaimsByPendingFaceContinuity({
    targets,
    sources,
    wmTargetMap,
    registry: input.registry,
    errors,
    skipTargetIndexes: new Set(wmClaimRejectedReasons.keys()),
  });

  applyDuplicateWmClaimOwnership({
    targets,
    sources,
    entityEvidenceByTarget,
    wmTargetMap,
    errors,
    markReidUnsafe,
  });

  return {
    targets: targets.map((target, index) => ({
      targetIdx: target.targetIdx,
      bbox_ids: target.bbox_ids,
      matched_wm_target: target.matched_wm_target,
      ...(sources[index] ? { matched_wm_target_source: sources[index] } : {}),
      ...(unsafeReasons.has(target.targetIdx) ? { reid_unsafe_reason: unsafeReasons.get(target.targetIdx)! } : {}),
      ...(wmClaimRejectedReasons.has(target.targetIdx)
        ? {
            matched_wm_target_rejected_reason: wmClaimRejectedReasons.get(target.targetIdx)!,
            visual_identity_only: true,
          }
        : {}),
      ...(target.dropped_dids.length > 0 ? { dropped_dids: target.dropped_dids } : {}),
    })),
    errors,
  };
}

type IdentityClaimWorkingTarget = {
  targetIdx: number;
  type: string;
  bbox_ids: string[];
  matched_wm_target: string | null;
  dropped_dids: IdentityDroppedDid[];
};

type CurrentEntityEvidence = {
  entityId: string;
  score: number;
};

function normalizeIdentityClass(label: string): string {
  const lower = label.toLowerCase();
  if (lower === "person") return "person";
  if (["car", "truck", "bus", "motorcycle", "bicycle", "boat", "train"].includes(lower)) return "vehicle";
  if (["dog", "cat", "bird", "horse", "cow", "sheep"].includes(lower)) return "animal";
  return lower;
}

function validateMatchedWmTarget(input: {
  targetIdx: number;
  targetType: string;
  matchedWmTarget: string | null;
  wmTargetMap: Map<string, WorkingMemoryTarget>;
  errors: string[];
}): string | null {
  const wmId = input.matchedWmTarget;
  if (wmId === null) return null;
  const wm = input.wmTargetMap.get(wmId);
  if (!wm) {
    input.errors.push(`target[${input.targetIdx}]: matched_wm_target "${wmId}" not found in wmTargets`);
    return null;
  }
  const wmType = normalizeIdentityClass(wm.class_name);
  if (wmType !== input.targetType) {
    input.errors.push(
      `target[${input.targetIdx}]: matched_wm_target "${wmId}" class "${wm.class_name}" (→${wmType}) mismatches target type (→${input.targetType})`,
    );
    return null;
  }
  return wmId;
}

function getWeakSearchEntityId(
  registry: DetectionRegistry,
  did: string,
  bodyReIdEnabled: boolean,
): string | undefined {
  const entry = registry.get(did);
  return entry?.face?.entity_id
    ?? (bodyReIdEnabled ? entry?.body?.entity_id : undefined);
}

function getCurrentEntityEvidence(
  target: IdentityClaimWorkingTarget,
  registry: DetectionRegistry,
): CurrentEntityEvidence | undefined {
  const scoresByEntity = new Map<string, number>();
  for (const did of target.bbox_ids) {
    const entry = registry.get(did);
    const faceEntity = entry?.face?.entity_id;
    if (faceEntity && canUseFaceEntityMatch(entry?.face)) {
      scoresByEntity.set(faceEntity, Math.max(
        scoresByEntity.get(faceEntity) ?? 0,
        entry.face?.match_score ?? entry.face?.quality ?? 0,
      ));
    }
  }

  if (scoresByEntity.size !== 1) return undefined;
  const [entityId, score] = [...scoresByEntity.entries()][0]!;
  return { entityId, score };
}

function removeDidFromClaimTarget(target: IdentityClaimWorkingTarget, did: string, reason: string): void {
  const before = target.bbox_ids.length;
  target.bbox_ids = target.bbox_ids.filter((value) => value !== did);
  if (target.bbox_ids.length !== before) {
    target.dropped_dids.push({ did, reason });
  }
}

function buildWmTargetByEntity(
  wmTargets: Iterable<WorkingMemoryTarget>,
): Map<string, WorkingMemoryTarget> {
  const byEntity = new Map<string, WorkingMemoryTarget>();
  for (const wm of wmTargets) {
    if (!wm.entity_id) continue;
    const key = entityWmKey(wm.class_name, wm.entity_id);
    const existing = byEntity.get(key);
    if (!existing || compareCanonicalWmTarget(wm, existing) < 0) {
      byEntity.set(key, wm);
    }
  }
  return byEntity;
}

function compareCanonicalWmTarget(a: WorkingMemoryTarget, b: WorkingMemoryTarget): number {
  const aOrdinal = parseWmTargetOrdinal(a.target_id);
  const bOrdinal = parseWmTargetOrdinal(b.target_id);
  if (aOrdinal !== bOrdinal) return aOrdinal - bOrdinal;
  if (b.segments_seen !== a.segments_seen) return b.segments_seen - a.segments_seen;
  return (b.last_seen_timestamp ?? 0) - (a.last_seen_timestamp ?? 0);
}

function parseWmTargetOrdinal(targetId: string): number {
  const match = /^wm_t(\d+)$/.exec(targetId);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function entityWmKey(className: string, entityId: string): string {
  return `${normalizeIdentityClass(className)}\u0000${entityId}`;
}

function splitDidsForMatchedEntity(
  bboxIds: string[],
  entityId: string,
  registry: DetectionRegistry,
): {
  matching: string[];
  conflicting: Array<{ did: string; entityId: string; quality: number }>;
  unknown: string[];
} {
  const matching: string[] = [];
  const conflicting: Array<{ did: string; entityId: string; quality: number }> = [];
  const unknown: string[] = [];

  for (const did of bboxIds) {
    const entry = registry.get(did);
    const faceEntityId = entry?.face?.entity_id;
    if (faceEntityId && canUseFaceEntityMatch(entry?.face)) {
      if (faceEntityId === entityId) {
        matching.push(did);
      } else {
        conflicting.push({ did, entityId: faceEntityId, quality: entry?.face?.quality ?? 0 });
      }
      continue;
    }
    unknown.push(did);
  }

  return { matching, conflicting, unknown };
}

function findUnclaimedEntityDids(input: {
  entityId: string;
  targetType: string;
  registry: DetectionRegistry;
  didsClaimedByOtherTargets: Set<string>;
}): string[] {
  return input.registry
    .all()
    .filter((entry) =>
      normalizeIdentityClass(entry.class_name) === input.targetType
      && !input.didsClaimedByOtherTargets.has(entry.did)
      && entry.face?.entity_id === input.entityId
      && canUseFaceEntityMatch(entry.face)
    )
    .sort((a, b) => {
      const aFace = a.face!;
      const bFace = b.face!;
      const scoreDiff = (bFace.match_score ?? bFace.quality ?? 0) - (aFace.match_score ?? aFace.quality ?? 0);
      if (scoreDiff !== 0) return scoreDiff;
      const qualityDiff = (bFace.quality ?? 0) - (aFace.quality ?? 0);
      if (qualityDiff !== 0) return qualityDiff;
      return a.frame_idx - b.frame_idx;
    })
    .map((entry) => entry.did);
}

function alignWmClaimsByCurrentEntity(input: {
  targets: IdentityClaimWorkingTarget[];
  sources: Array<ParsedSubjectProposalTarget["matched_wm_target_source"] | undefined>;
  wmTargetMap: Map<string, WorkingMemoryTarget>;
  registry: DetectionRegistry;
  errors: string[];
  skipTargetIndexes?: Set<number>;
}): Array<CurrentEntityEvidence | undefined> {
  const entityEvidenceByTarget: Array<CurrentEntityEvidence | undefined> = [];

  for (let index = 0; index < input.targets.length; index++) {
    const target = input.targets[index]!;
    if (input.skipTargetIndexes?.has(target.targetIdx)) continue;
    const evidence = getCurrentEntityEvidence(target, input.registry);
    entityEvidenceByTarget[index] = evidence;
  }

  return entityEvidenceByTarget;
}

function alignWmClaimsByPendingFaceContinuity(input: {
  targets: IdentityClaimWorkingTarget[];
  sources: Array<ParsedSubjectProposalTarget["matched_wm_target_source"] | undefined>;
  wmTargetMap: Map<string, WorkingMemoryTarget>;
  registry: DetectionRegistry;
  errors: string[];
  skipTargetIndexes?: Set<number>;
}): void {
  for (let index = 0; index < input.targets.length; index++) {
    const target = input.targets[index]!;
    if (input.skipTargetIndexes?.has(target.targetIdx)) continue;
    if (target.matched_wm_target || target.type !== "person") continue;

    const candidates = pendingFaceContinuityCandidates(target, input.wmTargetMap, input.registry);
    if (candidates.length === 0) continue;

    const best = candidates[0]!;
    const second = candidates[1];
    if (second && best.score - second.score < WM_PENDING_FACE_MATCH_MARGIN) {
      input.errors.push(
        `target[${target.targetIdx}]: pending face continuity ambiguous between "${best.wm.target_id}" and "${second.wm.target_id}" (cosine ${best.score.toFixed(4)} vs ${second.score.toFixed(4)})`,
      );
      continue;
    }
    target.matched_wm_target = best.wm.target_id;
    input.sources[index] = "pending_face";
    input.errors.push(
      `target[${target.targetIdx}]: matched_wm_target inferred as "${best.wm.target_id}" from pending face continuity on "${best.did}" (cosine ${best.score.toFixed(4)})`,
    );
  }
}

function validateVlmWmClaimsByPendingFaceContinuity(input: {
  targets: IdentityClaimWorkingTarget[];
  sources: Array<ParsedSubjectProposalTarget["matched_wm_target_source"] | undefined>;
  wmTargetMap: Map<string, WorkingMemoryTarget>;
  registry: DetectionRegistry;
  errors: string[];
  rejectWmClaim: (targetIdx: number, reason: string) => void;
}): void {
  for (let index = 0; index < input.targets.length; index++) {
    const target = input.targets[index]!;
    if (input.sources[index] !== "vlm" || target.type !== "person" || !target.matched_wm_target) continue;
    const matchedWm = input.wmTargetMap.get(target.matched_wm_target);
    if (!matchedWm || matchedWm.entity_id || !(matchedWm.pending_face_embeddings?.length)) continue;

    const candidates = pendingFaceContinuityCandidates(target, input.wmTargetMap, input.registry);
    if (candidates.length === 0) continue;

    const best = candidates[0]!;
    const second = candidates[1];
    const matched = candidates.find((candidate) => candidate.wm.target_id === target.matched_wm_target);
    if (matched && matched.wm.target_id === best.wm.target_id) continue;

    const ambiguous = Boolean(second && best.score - second.score < WM_PENDING_FACE_MATCH_MARGIN);
    const reason = ambiguous
      ? `pending_face_continuity_ambiguous:${best.wm.target_id}:${second!.wm.target_id}`
      : `pending_face_continuity_vetoes_vlm_wm:${target.matched_wm_target}:best:${best.wm.target_id}:score:${best.score.toFixed(4)}`;
    input.rejectWmClaim(target.targetIdx, reason);
    input.errors.push(
      ambiguous
        ? `target[${target.targetIdx}]: VLM matched_wm_target "${target.matched_wm_target}" rejected; pending face continuity ambiguous between "${best.wm.target_id}" and "${second!.wm.target_id}" (cosine ${best.score.toFixed(4)} vs ${second!.score.toFixed(4)})`
        : `target[${target.targetIdx}]: VLM matched_wm_target "${target.matched_wm_target}" rejected; pending face continuity preferred "${best.wm.target_id}" (cosine ${best.score.toFixed(4)})`,
    );
    target.matched_wm_target = null;
    input.sources[index] = undefined;
  }
}

function pendingFaceContinuityCandidates(
  target: IdentityClaimWorkingTarget,
  wmTargetMap: Map<string, WorkingMemoryTarget>,
  registry: DetectionRegistry,
): Array<{ wm: WorkingMemoryTarget; score: number; did: string }> {
  const currentFaces = target.bbox_ids.flatMap((did) => {
    const face = registry.get(did)?.face;
    return isUsableForPendingFaceContinuity(face) && face?.embedding
      ? [{ did, embedding: face.embedding, quality: face.quality ?? 0 }]
      : [];
  });
  if (currentFaces.length === 0) return [];

  const candidates: Array<{ wm: WorkingMemoryTarget; score: number; did: string }> = [];
  for (const wm of wmTargetMap.values()) {
    if (normalizeIdentityClass(wm.class_name) !== target.type) continue;
    const pendingFaces = wm.pending_face_embeddings ?? [];
    if (pendingFaces.length === 0) continue;

    let bestScore = -Infinity;
    let bestDid = "";
    for (const current of currentFaces) {
      for (const historical of pendingFaces) {
        const score = cosineSimilarity(current.embedding, historical.embedding);
        if (score > bestScore) {
          bestScore = score;
          bestDid = current.did;
        }
      }
    }
    if (bestScore >= ACCUMULATOR_FACE_CONSISTENCY) {
      candidates.push({ wm, score: bestScore, did: bestDid });
    }
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aStable = Boolean(a.wm.entity_id);
    const bStable = Boolean(b.wm.entity_id);
    if (aStable !== bStable) return aStable ? -1 : 1;
    return (b.wm.last_seen_timestamp ?? 0) - (a.wm.last_seen_timestamp ?? 0);
  });
  return candidates;
}

function isUsableForPendingFaceContinuity(face: DIdEntry["face"] | undefined): boolean {
  if (!face?.embedding?.length) return false;
  if (!face.landmarks || face.landmarks.length < 5) return false;
  if (face.sharpness != null && face.sharpness < 30) return false;
  if (!face.pose) return false;
  if (Math.abs(face.pose.pitch) > 45) return false;
  // Continuity search is weaker than gallery writes. A low-quality side face
  // may reject a bad VLM WM match, but it still cannot write gallery.
  if ((face.quality ?? 0) < 0.25) return false;
  return true;
}

type WmEntityVisualConfirmation =
  | { status: "confirmed"; maxSimilarity: number; did: string }
  | { status: "unconfirmed"; maxSimilarity: number; did: string; historicalFaceCount: number }
  | { status: "no_current_face"; historicalFaceCount: number }
  | { status: "no_historical_anchor"; currentFaceCount: number };

function verifyWmEntityVisualContinuity(
  bboxIds: string[],
  wm: WorkingMemoryTarget,
  registry: DetectionRegistry,
): WmEntityVisualConfirmation {
  const currentFaces = bboxIds.flatMap((did) => {
    const face = registry.get(did)?.face;
    return canAppendFaceGallery(face) && face?.embedding
      ? [{ did, embedding: face.embedding }]
      : [];
  });
  const historicalFaces = dedupePendingEmbeddings([
    ...(wm.stable_face_embeddings ?? []),
    ...(wm.pending_face_embeddings ?? []),
  ]);

  if (currentFaces.length === 0) {
    return { status: "no_current_face", historicalFaceCount: historicalFaces.length };
  }
  if (historicalFaces.length === 0) {
    return { status: "no_historical_anchor", currentFaceCount: currentFaces.length };
  }

  let best = { did: currentFaces[0]!.did, score: -Infinity };
  for (const current of currentFaces) {
    for (const historical of historicalFaces) {
      const score = cosineSimilarity(current.embedding, historical.embedding);
      if (score > best.score) best = { did: current.did, score };
    }
  }

  const maxSimilarity = Number(best.score.toFixed(4));
  if (best.score >= ACCUMULATOR_FACE_CONSISTENCY) {
    return { status: "confirmed", maxSimilarity, did: best.did };
  }
  return {
    status: "unconfirmed",
    maxSimilarity,
    did: best.did,
    historicalFaceCount: historicalFaces.length,
  };
}

function dedupePendingEmbeddings(embeddings: PendingFaceAnchor[]): PendingFaceAnchor[] {
  const bestByKey = new Map<string, PendingFaceAnchor>();
  for (const embedding of embeddings) {
    if (!embedding.embedding?.length) continue;
    const key = `${embedding.segment_id}\u0000${embedding.did}`;
    const existing = bestByKey.get(key);
    if (!existing || embedding.quality > existing.quality) bestByKey.set(key, embedding);
  }
  return [...bestByKey.values()];
}

type PendingFaceAnchor = NonNullable<WorkingMemoryTarget["pending_face_embeddings"]>[number];

function applyDuplicateDidOwnership(input: {
  targets: IdentityClaimWorkingTarget[];
  sources: Array<ParsedSubjectProposalTarget["matched_wm_target_source"] | undefined>;
  wmTargetMap: Map<string, WorkingMemoryTarget>;
  registry: DetectionRegistry;
  bodyReIdEnabled: boolean;
  errors: string[];
  markReidUnsafe: (targetIdx: number, reason: string) => void;
}): void {
  const claimsByDid = new Map<string, number[]>();
  for (let index = 0; index < input.targets.length; index++) {
    for (const did of input.targets[index]!.bbox_ids) {
      const claims = claimsByDid.get(did) ?? [];
      claims.push(index);
      claimsByDid.set(did, claims);
    }
  }

  for (const [did, claimIndexes] of claimsByDid.entries()) {
    if (claimIndexes.length <= 1) continue;

    const searchEntityId = getWeakSearchEntityId(input.registry, did, input.bodyReIdEnabled);
    if (!searchEntityId) {
      for (const index of claimIndexes) {
        const target = input.targets[index]!;
        removeDidFromClaimTarget(target, did, "duplicate_did_no_search_entity");
        input.markReidUnsafe(target.targetIdx, `duplicate_did:${did}`);
        input.errors.push(
          `target[${target.targetIdx}]: D{id} "${did}" duplicate removed from all targets; no search entity available to choose ownership`,
        );
      }
      continue;
    }

    const wmMatchingClaimIndexes = claimIndexes.filter((index) => {
      const wmId = input.targets[index]!.matched_wm_target;
      return wmId != null && input.wmTargetMap.get(wmId)?.entity_id === searchEntityId;
    });

    if (wmMatchingClaimIndexes.length > 0) {
      const winner = [...wmMatchingClaimIndexes].sort((a, b) => {
        const bboxDiff = input.targets[b]!.bbox_ids.length - input.targets[a]!.bbox_ids.length;
        return bboxDiff !== 0 ? bboxDiff : a - b;
      })[0]!;
      for (const index of claimIndexes) {
        if (index === winner) continue;
        const target = input.targets[index]!;
        removeDidFromClaimTarget(target, did, `duplicate_did_owned_by:${searchEntityId}`);
        input.errors.push(
          `target[${target.targetIdx}]: D{id} "${did}" duplicate removed; search entity "${searchEntityId}" belongs to target[${input.targets[winner]!.targetIdx}] wm_target "${input.targets[winner]!.matched_wm_target}"`,
        );
      }
      continue;
    }

    for (const index of claimIndexes) {
      const target = input.targets[index]!;
      removeDidFromClaimTarget(target, did, `duplicate_did_unclaimed_search_entity:${searchEntityId}`);
      input.errors.push(
        `target[${target.targetIdx}]: D{id} "${did}" duplicate removed from all targets; search entity "${searchEntityId}" matched no claimed wm_target entity`,
      );
    }
  }
}

function applyDuplicateWmClaimOwnership(input: {
  targets: IdentityClaimWorkingTarget[];
  sources: Array<ParsedSubjectProposalTarget["matched_wm_target_source"] | undefined>;
  entityEvidenceByTarget: Array<CurrentEntityEvidence | undefined>;
  wmTargetMap: Map<string, WorkingMemoryTarget>;
  errors: string[];
  markReidUnsafe: (targetIdx: number, reason: string) => void;
}): void {
  const wmClaims = new Map<string, number[]>();
  for (let index = 0; index < input.targets.length; index++) {
    const wmId = input.targets[index]!.matched_wm_target;
    if (!wmId) continue;
    const claims = wmClaims.get(wmId) ?? [];
    claims.push(index);
    wmClaims.set(wmId, claims);
  }

  for (const [wmId, claimIndexes] of wmClaims.entries()) {
    if (claimIndexes.length <= 1) continue;

    const wmEntityId = input.wmTargetMap.get(wmId)?.entity_id;
    const entityMatchedClaimIndexes = wmEntityId
      ? claimIndexes.filter((index) => input.entityEvidenceByTarget[index]?.entityId === wmEntityId)
      : [];

    if (entityMatchedClaimIndexes.length === 1) {
      const winner = entityMatchedClaimIndexes[0]!;
      for (const index of claimIndexes) {
        if (index === winner) continue;
        clearDuplicateWmClaim(input, index, winner, wmId, "entity match");
      }
      continue;
    }

    if (entityMatchedClaimIndexes.length > 1) {
      entityMatchedClaimIndexes.sort((a, b) => compareDuplicateWmClaimPriority(input, a, b));
      const winner = entityMatchedClaimIndexes[0]!;
      for (const index of claimIndexes) {
        if (index === winner) continue;
        clearDuplicateWmClaim(input, index, winner, wmId, "explicit/stable entity match");
      }
      continue;
    }

    for (const index of claimIndexes) {
      const target = input.targets[index]!;
      input.errors.push(
        `target[${target.targetIdx}]: matched_wm_target "${wmId}" duplicate claim cleared; no matching current entity evidence`,
      );
      input.markReidUnsafe(target.targetIdx, `duplicate_wm_target:${wmId}`);
      target.matched_wm_target = null;
      input.sources[index] = undefined;
    }
  }
}

function compareDuplicateWmClaimPriority(
  input: {
    sources: Array<ParsedSubjectProposalTarget["matched_wm_target_source"] | undefined>;
    entityEvidenceByTarget: Array<CurrentEntityEvidence | undefined>;
  },
  a: number,
  b: number,
): number {
  const sourceDiff = duplicateWmClaimSourcePriority(input.sources[b]) - duplicateWmClaimSourcePriority(input.sources[a]);
  if (sourceDiff !== 0) return sourceDiff;
  const aScore = input.entityEvidenceByTarget[a]?.score ?? 0;
  const bScore = input.entityEvidenceByTarget[b]?.score ?? 0;
  if (bScore !== aScore) return bScore - aScore;
  return a - b;
}

function duplicateWmClaimSourcePriority(source: ParsedSubjectProposalTarget["matched_wm_target_source"] | undefined): number {
  if (source === "vlm") return 3;
  if (source === "current_reid") return 2;
  if (source === "pending_face") return 1;
  return 0;
}

function clearDuplicateWmClaim(
  input: {
    targets: IdentityClaimWorkingTarget[];
    sources: Array<ParsedSubjectProposalTarget["matched_wm_target_source"] | undefined>;
    errors: string[];
    markReidUnsafe: (targetIdx: number, reason: string) => void;
  },
  index: number,
  winnerIndex: number,
  wmId: string,
  reason: string,
): void {
  const target = input.targets[index]!;
  input.errors.push(
    `target[${target.targetIdx}]: matched_wm_target "${wmId}" already claimed by target[${input.targets[winnerIndex]!.targetIdx}] (${reason})`,
  );
  input.markReidUnsafe(target.targetIdx, `duplicate_wm_target:${wmId}`);
  target.matched_wm_target = null;
  input.sources[index] = undefined;
}

/**
 * IdentityResolver centralizes stable identity decisions after VLM target
 * schema validation. It does not write memory; it produces the same fields the
 * existing pipeline consumes: entity_id, entity_id_source, gallery candidates,
 * upsert candidate, matched WM target, and reid_unsafe_reason.
 */
export function resolveTargetIdentities(input: IdentityResolverInput): IdentityResolverOutput {
  const errors: string[] = [];
  const wmTargetMap = new Map<string, WorkingMemoryTarget>();
  for (const wm of input.wmTargets) wmTargetMap.set(wm.target_id, wm);
  const wmTargetByEntity = buildWmTargetByEntity(input.wmTargets);
  const didsByTarget = input.targets.map((target) => new Set(target.bbox_ids));

  const results: ParsedSubjectProposalTarget[] = input.targets.map((target, targetInputIndex) => {
    let matchedWm = target.matched_wm_target;
    const didsClaimedByOtherTargets = new Set<string>();
    for (let i = 0; i < didsByTarget.length; i++) {
      if (i === targetInputIndex) continue;
      for (const did of didsByTarget[i]!) didsClaimedByOtherTargets.add(did);
    }

    const derivation = deriveEntityId(
      target.bbox_ids,
      matchedWm,
      wmTargetMap,
      input.registry,
      errors,
      target.targetIdx,
      {
        bodyReIdEnabled: input.bodyReIdEnabled === true,
        targetType: target.type,
        wmTargetByEntity,
        didsClaimedByOtherTargets,
      },
    );
    if (derivation.matchedWmTarget !== undefined) {
      matchedWm = derivation.matchedWmTarget;
    }
    let { entityId, entityIdSource, finalBboxIds } = derivation;
    let unsafeReason = target.reid_unsafe_reason ?? derivation.unsafeReason;
    const droppedDids = [
      ...(target.dropped_dids ?? []),
      ...derivation.droppedDids,
    ];

    if (isStableIdentityBlockingReason(target.reid_unsafe_reason) && entityIdSource === "current_reid") {
      const wmEntityId = matchedWm ? wmTargetMap.get(matchedWm)?.entity_id : undefined;
      entityId = wmEntityId;
      entityIdSource = wmEntityId ? "wm_inherited" : null;
    }

    const { galleryCandidates, upsertCandidate } = buildGalleryCandidates(
      finalBboxIds,
      entityId,
      entityIdSource,
      input.registry,
    );

    const parsed: ParsedSubjectProposalTarget = {
      ...(target.tid ? { tid: target.tid } : {}),
      type: target.type,
      bbox_ids: finalBboxIds,
      matched_wm_target: matchedWm,
      ...(matchedWm && target.matched_wm_target_source ? { matched_wm_target_source: target.matched_wm_target_source } : {}),
      ...(derivation.matchedWmRejectedReason || target.matched_wm_target_rejected_reason
        ? { matched_wm_target_rejected_reason: derivation.matchedWmRejectedReason ?? target.matched_wm_target_rejected_reason! }
        : {}),
      ...(target.visual_identity_only ? { visual_identity_only: true } : {}),
      appearance: target.appearance,
      gallery_candidates: unsafeReason || target.visual_identity_only ? [] : galleryCandidates,
    };
    if (target.behavior !== undefined) parsed.behavior = target.behavior;
    if (target.identity) parsed.identity = { ...target.identity };
    if (target.speaker_ids?.length) parsed.speaker_ids = [...target.speaker_ids];
    if (unsafeReason) parsed.reid_unsafe_reason = unsafeReason;
    parsed.entity_id = entityId;
    parsed.entity_id_source = entityIdSource;
    parsed.dropped_dids = droppedDids;
    if (upsertCandidate && !unsafeReason) parsed.upsert_candidate = upsertCandidate;
    refreshResolvedTargetExecutionFields(parsed, input.registry);
    return parsed;
  });

  mergeParsedTargetsByEntity(results, input.registry, input.wmTargets, errors);
  if (input.bodyReIdEnabled === true) {
    enforceBodyReIdEntityExclusivity(
      results,
      input.registry,
      wmTargetMap,
      input.targets.map((target) => target.matched_wm_target),
      errors,
    );
  }

  return { targets: results, errors };
}

interface EntityTargetClaim {
  targetIdx: number;
  entityId: string;
  score: number;
  bboxCount: number;
  hasCurrentReid: boolean;
  wmEntityMatchesClaim: boolean;
}

export function mergeParsedTargetsByEntity(
  targets: ParsedSubjectProposalTarget[],
  registry: DetectionRegistry,
  wmTargets: WorkingMemoryTarget[],
  errors: string[],
): void {
  const wmTargetMap = new Map(wmTargets.map((target) => [target.target_id, target]));
  const claimsByEntity = new Map<string, EntityTargetClaim[]>();
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]!;
    if (target.visual_identity_only) continue;
    if (!target.entity_id) continue;
    const wmTarget = target.matched_wm_target ? wmTargetMap.get(target.matched_wm_target) : undefined;
    const entityKey = `${target.type}\u0000${target.entity_id}`;
    const claims = claimsByEntity.get(entityKey) ?? [];
    claims.push({
      targetIdx: i,
      entityId: target.entity_id,
      score: scoreEntityTargetClaim(target, registry),
      bboxCount: target.bbox_ids.length,
      hasCurrentReid: target.entity_id_source === "current_reid",
      wmEntityMatchesClaim: wmTarget?.entity_id === target.entity_id,
    });
    claimsByEntity.set(entityKey, claims);
  }

  const mergedByWinner = new Map<number, ParsedSubjectProposalTarget>();
  const loserIndexes = new Set<number>();

  for (const claims of claimsByEntity.values()) {
    if (claims.length <= 1) continue;
    claims.sort((a, b) => {
      if (a.wmEntityMatchesClaim !== b.wmEntityMatchesClaim) return a.wmEntityMatchesClaim ? -1 : 1;
      if (a.hasCurrentReid !== b.hasCurrentReid) return a.hasCurrentReid ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      if (b.bboxCount !== a.bboxCount) return b.bboxCount - a.bboxCount;
      return a.targetIdx - b.targetIdx;
    });
    const winner = claims[0]!;
    const mergeIndexes = [winner.targetIdx];
    for (let i = 1; i < claims.length; i++) {
      const loser = claims[i]!;
      const conflict = stableEntityMergeConflict(
        targets[winner.targetIdx]!,
        targets[loser.targetIdx]!,
        registry,
        wmTargetMap,
      );
      if (conflict) {
        clearDuplicateEntityClaim({
          target: targets[loser.targetIdx]!,
          targetIdx: loser.targetIdx,
          winnerIdx: winner.targetIdx,
          entityId: loser.entityId,
          reason: conflict.reason,
          message: conflict.message,
          errors,
          registry,
        });
      } else {
        mergeIndexes.push(loser.targetIdx);
      }
    }

    if (mergeIndexes.length <= 1) continue;
    const groupIndexes = [...mergeIndexes].sort((a, b) => a - b);
    const outputIndex = Math.min(...groupIndexes);
    const merged = mergeEntityTargetGroup(
      groupIndexes.map((idx) => targets[idx]!),
      registry,
      wmTargetMap,
      winner.entityId,
    );
    mergedByWinner.set(outputIndex, merged);
    for (const idx of groupIndexes) {
      if (idx !== outputIndex) loserIndexes.add(idx);
    }
    errors.push(
      `targets merged: entity "${winner.entityId}" appeared in ${mergeIndexes.length} compatible target entries (${groupIndexes.map((idx) => `target[${idx}]`).join(", ")})`,
    );
  }

  if (mergedByWinner.size === 0) return;
  const next: ParsedSubjectProposalTarget[] = [];
  for (let i = 0; i < targets.length; i++) {
    if (loserIndexes.has(i)) continue;
    next.push(mergedByWinner.get(i) ?? targets[i]!);
  }
  targets.splice(0, targets.length, ...next);
}

function stableEntityMergeConflict(
  winner: ParsedSubjectProposalTarget,
  candidate: ParsedSubjectProposalTarget,
  registry: DetectionRegistry,
  wmTargetMap: Map<string, WorkingMemoryTarget>,
): { reason: string; message: string } | undefined {
  if (hasSameFrameConflict([winner, candidate], registry)) {
    return {
      reason: `duplicate_entity_target:${candidate.entity_id}`,
      message: "same-frame conflict",
    };
  }
  if (hasDistinctWmIdentityClaims([winner, candidate], wmTargetMap)) {
    return {
      reason: `duplicate_entity_across_wm_targets:${candidate.entity_id}`,
      message: "conflicting identity context",
    };
  }
  return undefined;
}

function clearDuplicateEntityClaim(input: {
  target: ParsedSubjectProposalTarget;
  targetIdx: number;
  winnerIdx: number;
  entityId: string;
  reason: string;
  message: string;
  errors: string[];
  registry: DetectionRegistry;
}): void {
  input.errors.push(
    `target[${input.targetIdx}]: entity "${input.entityId}" already claimed by target[${input.winnerIdx}] with ${input.message} — cleared stable entity for duplicate target`,
  );
  input.target.entity_id = undefined;
  input.target.entity_id_source = null;
  input.target.gallery_candidates = [];
  delete input.target.upsert_candidate;
  input.target.reid_unsafe_reason = input.target.reid_unsafe_reason ?? input.reason;
  refreshResolvedTargetExecutionFields(input.target, input.registry);
}

function hasSameFrameConflict(targets: ParsedSubjectProposalTarget[], registry: DetectionRegistry): boolean {
  const seenFrames = new Set<number>();
  for (const target of targets) {
    const framesForTarget = new Set<number>();
    for (const did of target.bbox_ids) {
      const frameIdx = registry.get(did)?.frame_idx;
      if (frameIdx == null) continue;
      framesForTarget.add(frameIdx);
    }
    for (const frameIdx of framesForTarget) {
      if (seenFrames.has(frameIdx)) return true;
      seenFrames.add(frameIdx);
    }
  }
  return false;
}

function hasDistinctWmIdentityClaims(
  targets: ParsedSubjectProposalTarget[],
  wmTargetMap: Map<string, WorkingMemoryTarget>,
): boolean {
  const identityKeys = new Set<string>();
  for (const target of targets) {
    if (!target.matched_wm_target) continue;
    const wmTarget = wmTargetMap.get(target.matched_wm_target);
    if (!wmTarget) continue;
    identityKeys.add(wmTarget.entity_id ? `entity:${wmTarget.entity_id}` : `wm:${wmTarget.target_id}`);
  }
  return identityKeys.size > 1;
}

function mergeEntityTargetGroup(
  group: ParsedSubjectProposalTarget[],
  registry: DetectionRegistry,
  wmTargetMap: Map<string, WorkingMemoryTarget>,
  entityId: string,
): ParsedSubjectProposalTarget {
  const sortedTargets = [...group].sort((a, b) => {
    const aCurrent = a.entity_id_source === "current_reid";
    const bCurrent = b.entity_id_source === "current_reid";
    if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
    const scoreDiff = scoreEntityTargetClaim(b, registry) - scoreEntityTargetClaim(a, registry);
    if (scoreDiff !== 0) return scoreDiff;
    return b.bbox_ids.length - a.bbox_ids.length;
  });
  const base = sortedTargets[0]!;
  const merged = cloneIdentityTarget(base);
  merged.bbox_ids = sortMergedBboxIds(
    uniqueStrings(group.flatMap((target) => target.bbox_ids)),
    registry,
    entityId,
  );

  merged.matched_wm_target = resolveMergedWmTarget(group, wmTargetMap, entityId);
  merged.matched_wm_target_source = resolveMergedWmTargetSource(group, merged.matched_wm_target);
  merged.appearance = firstNonEmpty([base.appearance, ...group.map((target) => target.appearance)]) ?? "";
  const behavior = firstNonEmpty([base.behavior, ...group.map((target) => target.behavior)]);
  if (behavior) {
    merged.behavior = behavior;
  } else {
    delete merged.behavior;
  }

  const source = group.find((target) => target.entity_id_source === "current_reid") ?? base;
  merged.entity_id = entityId;
  merged.entity_id_source = source.entity_id_source ?? base.entity_id_source;
  merged.subject_index = firstDefined([base.subject_index, ...group.map((target) => target.subject_index)]);
  const name = firstNonEmpty([base.name ?? undefined, ...group.map((target) => target.name ?? undefined)]);
  if (name) {
    merged.name = name;
  } else {
    delete merged.name;
  }
  merged.first_seen = firstDefined([base.first_seen, ...group.map((target) => target.first_seen)]);

  const blockingUnsafeReasons = group
    .map((target) => target.reid_unsafe_reason)
    .filter((value): value is string => isStableIdentityBlockingReason(value));
  if (blockingUnsafeReasons.length === group.length && blockingUnsafeReasons[0]) {
    merged.reid_unsafe_reason = blockingUnsafeReasons[0];
    merged.gallery_candidates = [];
    delete merged.upsert_candidate;
  } else {
    delete merged.reid_unsafe_reason;
    const rebuilt = buildGalleryCandidates(
      merged.bbox_ids,
      merged.entity_id,
      merged.entity_id_source ?? null,
      registry,
    );
    const mergedGalleryCandidates = mergeGalleryCandidates(group);
    merged.gallery_candidates = mergeGalleryCandidateLists(
      mergedGalleryCandidates,
      rebuilt.galleryCandidates,
    );
    const upsertCandidate = bestUpsertCandidate(group) ?? rebuilt.upsertCandidate;
    if (upsertCandidate) {
      merged.upsert_candidate = upsertCandidate;
    } else {
      delete merged.upsert_candidate;
    }
  }
  merged.dropped_dids = group.flatMap((target) => target.dropped_dids ?? []);
  refreshResolvedTargetExecutionFields(merged, registry);
  return merged;
}

function cloneIdentityTarget(target: ParsedSubjectProposalTarget): ParsedSubjectProposalTarget {
  return {
    ...target,
    bbox_ids: [...target.bbox_ids],
    gallery_write_dids: target.gallery_write_dids ? [...target.gallery_write_dids] : undefined,
    display_crop_dids: target.display_crop_dids ? [...target.display_crop_dids] : undefined,
    dropped_dids: target.dropped_dids?.map((dropped) => ({ ...dropped })),
    gallery_candidates: target.gallery_candidates.map((candidate) => ({
      ...candidate,
      embedding: [...candidate.embedding],
    })),
    upsert_candidate: target.upsert_candidate
      ? {
          ...target.upsert_candidate,
          embedding: [...target.upsert_candidate.embedding],
        }
      : undefined,
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function firstNonEmpty(values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value));
}

function firstDefined<T>(values: Array<T | undefined | null>): T | undefined {
  return values.find((value): value is T => value !== undefined && value !== null);
}

function sortMergedBboxIds(
  bboxIds: string[],
  registry: DetectionRegistry,
  entityId: string,
): string[] {
  return [...bboxIds].sort((a, b) => scoreDidForEntity(b, entityId, registry) - scoreDidForEntity(a, entityId, registry));
}

function scoreDidForEntity(did: string, entityId: string, registry: DetectionRegistry): number {
  const entry = registry.get(did);
  if (!entry) return 0;
  let score = entry.confidence ?? 0;
  if (entry.face?.entity_id === entityId) {
    score += 10 + (entry.face.quality ?? 0) + (entry.face.match_score ?? 0);
  }
  if (entry.body?.entity_id === entityId) {
    score += 5 + (entry.body.match_score ?? 0) + (entry.body.quality ?? 0);
  }
  return score;
}

function mergeGalleryCandidates(targets: ParsedSubjectProposalTarget[]): ParsedSubjectProposalTarget["gallery_candidates"] {
  const bestByKey = new Map<string, ParsedSubjectProposalTarget["gallery_candidates"][number]>();
  for (const target of targets) {
    if (isStableIdentityBlockingReason(target.reid_unsafe_reason)) continue;
    for (const candidate of target.gallery_candidates) {
      const key = `${candidate.entity_id}\u0000${candidate.did}\u0000${candidate.trust}`;
      const existing = bestByKey.get(key);
      if (!existing || candidate.quality > existing.quality) {
        bestByKey.set(key, {
          ...candidate,
          embedding: [...candidate.embedding],
        });
      }
    }
  }
  return [...bestByKey.values()];
}

function mergeGalleryCandidateLists(
  ...lists: ParsedSubjectProposalTarget["gallery_candidates"][]
): ParsedSubjectProposalTarget["gallery_candidates"] {
  const bestByKey = new Map<string, ParsedSubjectProposalTarget["gallery_candidates"][number]>();
  for (const list of lists) {
    for (const candidate of list) {
      const key = `${candidate.entity_id}\u0000${candidate.did}\u0000${candidate.trust}`;
      const existing = bestByKey.get(key);
      if (!existing || candidate.quality > existing.quality) {
        bestByKey.set(key, {
          ...candidate,
          embedding: [...candidate.embedding],
        });
      }
    }
  }
  return [...bestByKey.values()];
}

function bestUpsertCandidate(targets: ParsedSubjectProposalTarget[]): ParsedSubjectProposalTarget["upsert_candidate"] | undefined {
  let best: ParsedSubjectProposalTarget["upsert_candidate"] | undefined;
  for (const target of targets) {
    if (isStableIdentityBlockingReason(target.reid_unsafe_reason) || !target.upsert_candidate) continue;
    if (!best || target.upsert_candidate.quality > best.quality) {
      best = {
        ...target.upsert_candidate,
        embedding: [...target.upsert_candidate.embedding],
      };
    }
  }
  return best;
}

function isStableIdentityBlockingReason(reason: string | undefined): boolean {
  if (!reason) return false;
  // This is a parser ordering artifact: split targets can both point to the
  // same WM target before stable-entity merge has collapsed them.
  return !reason.startsWith("duplicate_wm_target:");
}

function refreshResolvedTargetExecutionFields(
  target: ParsedSubjectProposalTarget,
  registry: DetectionRegistry,
): void {
  if (target.visual_identity_only) {
    target.gallery_write_dids = [];
    target.display_crop_dids = [];
    target.identity_write_safe = false;
    target.resolution_outcome = "display_only";
    return;
  }
  target.gallery_write_dids = target.gallery_candidates.map((candidate) => candidate.did);
  target.display_crop_dids = target.bbox_ids.filter((did) => isSafeTrackEvidenceForTarget(registry, target, did));
  target.identity_write_safe = !isStableIdentityBlockingReason(target.reid_unsafe_reason)
    && (target.entity_id_source === "current_reid" || Boolean(target.upsert_candidate));

  if (target.bbox_ids.length === 0) {
    target.resolution_outcome = "drop_target";
  } else if (isStableIdentityBlockingReason(target.reid_unsafe_reason)) {
    target.resolution_outcome = "display_only";
  } else if (target.entity_id_source === "wm_inherited" && !target.identity_write_safe) {
    target.resolution_outcome = "display_only";
  } else if ((target.dropped_dids?.length ?? 0) > 0) {
    target.resolution_outcome = "filter_dids";
  } else {
    target.resolution_outcome = "keep";
  }
}

function resolveMergedWmTarget(
  targets: ParsedSubjectProposalTarget[],
  wmTargetMap: Map<string, WorkingMemoryTarget>,
  entityId: string,
): string | null {
  const entityMatched = targets
    .map((target) => target.matched_wm_target)
    .find((targetId): targetId is string => Boolean(targetId && wmTargetMap.get(targetId)?.entity_id === entityId));
  if (entityMatched) return entityMatched;
  const current = targets.find((target) => target.entity_id_source === "current_reid" && target.matched_wm_target)?.matched_wm_target;
  if (current) return current;
  return targets.find((target) => target.matched_wm_target)?.matched_wm_target ?? null;
}

function resolveMergedWmTargetSource(
  targets: ParsedSubjectProposalTarget[],
  targetId: string | null,
): ParsedSubjectProposalTarget["matched_wm_target_source"] {
  if (!targetId) return undefined;
  return targets.find((target) => target.matched_wm_target === targetId)?.matched_wm_target_source;
}

function scoreEntityTargetClaim(target: ParsedSubjectProposalTarget, registry: DetectionRegistry): number {
  if (!target.entity_id) return 0;
  let score = 0;
  for (const did of target.bbox_ids) {
    const entry = registry.get(did);
    if (!entry) continue;
    if (entry.face?.entity_id === target.entity_id) {
      score = Math.max(score, entry.face.quality ?? entry.face.match_score ?? 0);
    }
    if (entry.body?.entity_id === target.entity_id) {
      score = Math.max(score, entry.body.match_score ?? entry.body.quality ?? 0);
    }
  }
  return score;
}

interface BodyReIdEntityClaim {
  targetIdx: number;
  entityId: string;
  score: number;
  bboxCount: number;
  hasFaceClaim: boolean;
  hasBodyClaim: boolean;
}

function enforceBodyReIdEntityExclusivity(
  targets: ParsedSubjectProposalTarget[],
  registry: DetectionRegistry,
  wmTargetMap: Map<string, WorkingMemoryTarget>,
  resolvedWmTargets: Array<string | null>,
  errors: string[],
): void {
  const claimsByEntity = new Map<string, BodyReIdEntityClaim[]>();

  for (let i = 0; i < targets.length; i++) {
    const claim = getBodyReIdEntityClaim(targets[i]!, i, registry);
    if (!claim) continue;
    const claims = claimsByEntity.get(claim.entityId) ?? [];
    claims.push(claim);
    claimsByEntity.set(claim.entityId, claims);
  }

  for (const [entityId, claims] of claimsByEntity) {
    if (claims.length <= 1 || !claims.some((claim) => claim.hasBodyClaim)) continue;

    claims.sort((a, b) => {
      if (a.hasFaceClaim !== b.hasFaceClaim) return a.hasFaceClaim ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      if (b.bboxCount !== a.bboxCount) return b.bboxCount - a.bboxCount;
      return a.targetIdx - b.targetIdx;
    });

    const winner = claims[0]!;
    for (let i = 1; i < claims.length; i++) {
      const loser = claims[i]!;
      if (!loser.hasBodyClaim || loser.hasFaceClaim) continue;

      clearBodyReIdEntityClaim(
        targets[loser.targetIdx]!,
        entityId,
        registry,
        wmTargetMap,
        resolvedWmTargets[loser.targetIdx] ?? null,
      );
      errors.push(
        `target[${loser.targetIdx}]: body ReID entity "${entityId}" already claimed by target[${winner.targetIdx}] — cleared for accumulator`,
      );
    }
  }
}

function getBodyReIdEntityClaim(
  target: ParsedSubjectProposalTarget,
  targetIdx: number,
  registry: DetectionRegistry,
): BodyReIdEntityClaim | undefined {
  if (target.entity_id_source !== "current_reid" || !target.entity_id) return undefined;

  let score = 0;
  let hasFaceClaim = false;
  let hasBodyClaim = false;
  for (const did of target.bbox_ids) {
    const entry = registry.get(did);
    if (!entry) continue;
    if (entry.face?.entity_id === target.entity_id) {
      hasFaceClaim = true;
      score = Math.max(score, entry.face.quality ?? 0);
    }
    if (entry.body?.entity_id === target.entity_id) {
      hasBodyClaim = true;
      score = Math.max(score, entry.body.match_score ?? entry.body.quality ?? 0);
    }
  }

  if (!hasFaceClaim && !hasBodyClaim) return undefined;
  return {
    targetIdx,
    entityId: target.entity_id,
    score,
    bboxCount: target.bbox_ids.length,
    hasFaceClaim,
    hasBodyClaim,
  };
}

function clearBodyReIdEntityClaim(
  target: ParsedSubjectProposalTarget,
  entityId: string,
  registry: DetectionRegistry,
  wmTargetMap: Map<string, WorkingMemoryTarget>,
  fallbackWmTarget: string | null,
): void {
  for (const did of target.bbox_ids) {
    const entry = registry.get(did);
    if (entry?.body?.entity_id === entityId) {
      entry.body.entity_id = undefined;
      entry.body.match_score = undefined;
    }
  }

  target.matched_wm_target = fallbackWmTarget;
  const wmEntityId = fallbackWmTarget ? wmTargetMap.get(fallbackWmTarget)?.entity_id : undefined;
  target.entity_id = wmEntityId;
  target.entity_id_source = wmEntityId ? "wm_inherited" : null;
  const { galleryCandidates, upsertCandidate } = buildGalleryCandidates(
    target.bbox_ids,
    target.entity_id,
    target.entity_id_source,
    registry,
  );
  target.gallery_candidates = galleryCandidates;
  if (upsertCandidate) {
    target.upsert_candidate = upsertCandidate;
  } else {
    delete target.upsert_candidate;
  }
  refreshResolvedTargetExecutionFields(target, registry);
}

interface EntityDerivation {
  entityId: string | undefined;
  entityIdSource: "current_reid" | "wm_inherited" | null;
  finalBboxIds: string[];
  droppedDids: IdentityDroppedDid[];
  unsafeReason?: string;
  matchedWmTarget?: string | null;
  matchedWmRejectedReason?: string;
}

interface EntityDerivationContext {
  bodyReIdEnabled: boolean;
  targetType: string;
  wmTargetByEntity: Map<string, WorkingMemoryTarget>;
  didsClaimedByOtherTargets: Set<string>;
}

function deriveEntityId(
  bboxIds: string[],
  matchedWm: string | null,
  wmTargetMap: Map<string, WorkingMemoryTarget>,
  registry: DetectionRegistry,
  errors: string[],
  targetIdx: number,
  context: EntityDerivationContext,
): EntityDerivation {
  const faceEntities: Array<{ did: string; entityId: string; quality: number }> = [];

  for (const did of bboxIds) {
    const entry = registry.get(did)!;
    if (entry.face?.entity_id && canUseFaceEntityMatch(entry.face)) {
      faceEntities.push({
        did,
        entityId: entry.face.entity_id,
        quality: entry.face.quality ?? 0,
      });
    }
  }

  const uniqueEntities = new Set(faceEntities.map((f) => f.entityId));
  const wm = matchedWm !== null ? wmTargetMap.get(matchedWm) : undefined;
  const targetType = normalizeIdentityClass(context.targetType);

  if (wm?.entity_id && uniqueEntities.size > 0) {
    const split = splitDidsForMatchedEntity(bboxIds, wm.entity_id, registry);
    for (const c of split.conflicting) {
      errors.push(
        `target[${targetIdx}]: entity conflict — dropped "${c.did}" (entity "${c.entityId}") in favor of matched wm_target "${matchedWm}" entity "${wm.entity_id}"`,
      );
    }

    if (split.matching.length > 0) {
      return {
        entityId: wm.entity_id,
        entityIdSource: "current_reid",
        finalBboxIds: split.matching,
        droppedDids: [
          ...split.conflicting.map((item) => ({ did: item.did, reason: `conflicts_with_wm_entity:${wm.entity_id}` })),
          ...split.unknown.map((did) => ({ did, reason: `unverified_for_wm_entity:${wm.entity_id}` })),
        ],
      };
    }

    const supplemental = findUnclaimedEntityDids({
      entityId: wm.entity_id,
      targetType,
      registry,
      didsClaimedByOtherTargets: context.didsClaimedByOtherTargets,
    });
    if (supplemental.length > 0) {
      errors.push(
        `target[${targetIdx}]: matched wm_target "${matchedWm}" entity "${wm.entity_id}" had no matching D{id}; supplemented visual evidence from unclaimed D{id}s [${supplemental.join(",")}]`,
      );
      return {
        entityId: wm.entity_id,
        entityIdSource: "current_reid",
        finalBboxIds: supplemental,
        droppedDids: [
          ...split.conflicting.map((item) => ({ did: item.did, reason: `replaced_by_unclaimed_wm_entity_evidence:${wm.entity_id}` })),
          ...split.unknown.map((did) => ({ did, reason: `replaced_by_unclaimed_wm_entity_evidence:${wm.entity_id}` })),
        ],
      };
    }

    if (split.unknown.length > 0) {
      return {
        entityId: wm.entity_id,
        entityIdSource: "wm_inherited",
        finalBboxIds: split.unknown,
        droppedDids: split.conflicting.map((item) => ({ did: item.did, reason: `conflicts_with_wm_entity:${wm.entity_id}` })),
        unsafeReason: split.conflicting.length > 0 ? `current_reid_conflicts_with_wm:${wm.entity_id}` : undefined,
      };
    }

    for (const c of split.conflicting) {
      errors.push(
        `target[${targetIdx}]: all current D{id}s conflicted with matched wm_target "${matchedWm}" entity "${wm.entity_id}" and no replacement evidence was available`,
      );
    }
    return {
      entityId: wm.entity_id,
      entityIdSource: "wm_inherited",
      finalBboxIds: bboxIds,
      droppedDids: split.conflicting.map((item) => ({ did: item.did, reason: `conflicts_with_wm_entity:${wm.entity_id}` })),
      unsafeReason: `current_reid_conflicts_with_wm:${wm.entity_id}`,
    };
  }

  if (uniqueEntities.size === 1) {
    const currentEntityId = faceEntities[0]!.entityId;
    const canonicalWmForEntity = context.wmTargetByEntity.get(entityWmKey(targetType, currentEntityId));
    const primaryDid = bboxIds[0];
    const primaryDidHasCurrentEntity = faceEntities.some((face) => face.did === primaryDid && face.entityId === currentEntityId);

    if (matchedWm === null && canonicalWmForEntity) {
      errors.push(
        `target[${targetIdx}]: matched_wm_target inferred as "${canonicalWmForEntity.target_id}" from clean current ReID entity "${currentEntityId}"`,
      );
      return {
        entityId: currentEntityId,
        entityIdSource: "current_reid",
        finalBboxIds: bboxIds,
        droppedDids: [],
        matchedWmTarget: canonicalWmForEntity.target_id,
      };
    }

    if (matchedWm !== null && wm && !wm.entity_id && !primaryDidHasCurrentEntity) {
      const currentEntityDids = new Set(faceEntities.map((face) => face.did));
      const filtered = bboxIds.filter((did) => !currentEntityDids.has(did));
      for (const c of faceEntities) {
        errors.push(
          `target[${targetIdx}]: ReID entity "${c.entityId}" on non-primary "${c.did}" is not enough to upgrade anonymous wm_target "${matchedWm}"`,
        );
      }
      return {
        entityId: undefined,
        entityIdSource: null,
        finalBboxIds: filtered.length > 0 ? filtered : bboxIds,
        droppedDids: filtered.length > 0
          ? faceEntities.map((item) => ({ did: item.did, reason: `non_primary_reid_for_anonymous_wm:${currentEntityId}` }))
          : [],
        unsafeReason: `current_reid_non_primary_conflicts_with_wm:${currentEntityId}`,
      };
    }

    if (matchedWm !== null && wm && !wm.entity_id && canonicalWmForEntity && canonicalWmForEntity.target_id !== matchedWm) {
      errors.push(
        `target[${targetIdx}]: matched anonymous wm_target "${matchedWm}" not upgraded because current ReID entity "${currentEntityId}" already belongs to "${canonicalWmForEntity.target_id}"`,
      );
      return {
        entityId: undefined,
        entityIdSource: null,
        finalBboxIds: bboxIds,
        droppedDids: [],
        unsafeReason: `current_reid_belongs_to_existing_wm:${currentEntityId}:${canonicalWmForEntity.target_id}`,
      };
    }

    return {
      entityId: currentEntityId,
      entityIdSource: "current_reid",
      finalBboxIds: bboxIds,
      droppedDids: [],
    };
  }

  if (uniqueEntities.size > 1) {
    faceEntities.sort((a, b) => b.quality - a.quality);
    const winner = faceEntities[0]!;
    const conflicting = faceEntities.filter((f) => f.entityId !== winner.entityId);
    const conflictingDids = new Set(conflicting.map((f) => f.did));
    const filtered = bboxIds.filter((did) => !conflictingDids.has(did));

    for (const c of conflicting) {
      errors.push(
        `target[${targetIdx}]: entity conflict — dropped "${c.did}" (entity "${c.entityId}") in favor of "${winner.entityId}" (quality ${winner.quality})`,
      );
    }

    return {
      entityId: winner.entityId,
      entityIdSource: "current_reid",
      finalBboxIds: filtered,
      droppedDids: conflicting.map((item) => ({ did: item.did, reason: `mixed_entity_conflicts_with_current_reid:${winner.entityId}` })),
      unsafeReason: conflicting.length > 0 ? `mixed_entity_ids:preferred_current_reid:${winner.entityId}` : undefined,
    };
  }

  if (context.bodyReIdEnabled) {
    const bodyEntities: Array<{ did: string; entityId: string; score: number; quality: number }> = [];
    for (const did of bboxIds) {
      const entry = registry.get(did)!;
      if (entry.body?.entity_id) {
        bodyEntities.push({
          did,
          entityId: entry.body.entity_id,
          score: entry.body.match_score ?? entry.body.quality ?? 0,
          quality: entry.body.quality ?? 0,
        });
      }
    }
    const uniqueBodyEntities = new Set(bodyEntities.map((b) => b.entityId));

    if (wm?.entity_id && uniqueBodyEntities.size > 0) {
      if (uniqueBodyEntities.has(wm.entity_id)) {
        const conflicting = bodyEntities.filter((b) => b.entityId !== wm.entity_id);
        for (const c of conflicting) {
          const entry = registry.get(c.did);
          if (entry?.body?.entity_id === c.entityId) {
            entry.body.entity_id = undefined;
            entry.body.match_score = undefined;
          }
          errors.push(
            `target[${targetIdx}]: body entity conflict — cleared "${c.did}" (entity "${c.entityId}") in favor of wm_target "${matchedWm}" entity "${wm.entity_id}"`,
          );
        }

        return {
          entityId: wm.entity_id,
          entityIdSource: "current_reid",
          finalBboxIds: bboxIds,
          droppedDids: [],
          unsafeReason: conflicting.length > 0 ? `mixed_body_entity_ids:preferred_wm_entity:${wm.entity_id}` : undefined,
        };
      }

      for (const b of bodyEntities) {
        const entry = registry.get(b.did);
        if (entry?.body?.entity_id === b.entityId) {
          entry.body.entity_id = undefined;
          entry.body.match_score = undefined;
        }
      }
      errors.push(
        `target[${targetIdx}]: body ReID entity "${[...uniqueBodyEntities].join(",")}" conflicts with wm_target "${matchedWm}" entity "${wm.entity_id}" — WM wins`,
      );

      return {
        entityId: wm.entity_id,
        entityIdSource: "wm_inherited",
        finalBboxIds: bboxIds,
        droppedDids: [],
      };
    }

    if (uniqueBodyEntities.size === 1) {
      return {
        entityId: bodyEntities[0]!.entityId,
        entityIdSource: "current_reid",
        finalBboxIds: bboxIds,
        droppedDids: [],
      };
    }

    if (uniqueBodyEntities.size > 1) {
      bodyEntities.sort((a, b) => b.score - a.score || b.quality - a.quality);
      const winner = bodyEntities[0]!;
      const conflicting = bodyEntities.filter((b) => b.entityId !== winner.entityId);

      for (const c of conflicting) {
        const entry = registry.get(c.did);
        if (entry?.body?.entity_id === c.entityId) {
          entry.body.entity_id = undefined;
          entry.body.match_score = undefined;
        }
        errors.push(
          `target[${targetIdx}]: body entity conflict — cleared "${c.did}" (entity "${c.entityId}") in favor of "${winner.entityId}" (score ${winner.score})`,
        );
      }

      return {
        entityId: winner.entityId,
        entityIdSource: "current_reid",
        finalBboxIds: bboxIds,
        droppedDids: [],
      };
    }
  }

  if (matchedWm !== null) {
    const wm = wmTargetMap.get(matchedWm);
    if (wm?.entity_id) {
      const visualConfirmation = verifyWmEntityVisualContinuity(bboxIds, wm, registry);
      if (visualConfirmation.status === "confirmed") {
        errors.push(
          `target[${targetIdx}]: matched wm_target "${matchedWm}" entity "${wm.entity_id}" visually confirmed by historical face anchor on "${visualConfirmation.did}" (cosine ${visualConfirmation.maxSimilarity.toFixed(4)})`,
        );
        return {
          entityId: wm.entity_id,
          entityIdSource: "current_reid",
          finalBboxIds: bboxIds,
          droppedDids: [],
        };
      }
      if (visualConfirmation.status === "unconfirmed") {
        errors.push(
          `target[${targetIdx}]: matched wm_target "${matchedWm}" entity "${wm.entity_id}" rejected; current face "${visualConfirmation.did}" did not match historical anchors (max cosine ${visualConfirmation.maxSimilarity.toFixed(4)})`,
        );
        return {
          entityId: undefined,
          entityIdSource: null,
          finalBboxIds: bboxIds,
          droppedDids: [],
          matchedWmTarget: null,
          matchedWmRejectedReason: `wm_entity_visual_unconfirmed:${wm.entity_id}:max_similarity:${visualConfirmation.maxSimilarity}`,
        };
      }
      const unsafeReason = visualConfirmation.status === "no_current_face"
        ? `wm_inherited_no_current_face:${wm.entity_id}`
        : `wm_inherited_no_face_anchor:${wm.entity_id}`;
      errors.push(
        visualConfirmation.status === "no_current_face"
          ? `target[${targetIdx}]: matched wm_target "${matchedWm}" entity "${wm.entity_id}" kept for display only; no current comparable face`
          : `target[${targetIdx}]: matched wm_target "${matchedWm}" entity "${wm.entity_id}" kept for display only; no historical face anchor available`,
      );
      return {
        entityId: wm.entity_id,
        entityIdSource: "wm_inherited",
        finalBboxIds: bboxIds,
        droppedDids: [],
        unsafeReason,
      };
    }
  }

  return {
    entityId: undefined,
    entityIdSource: null,
    finalBboxIds: bboxIds,
    droppedDids: [],
  };
}

function buildGalleryCandidates(
  bboxIds: string[],
  entityId: string | undefined,
  entityIdSource: "current_reid" | "wm_inherited" | null,
  registry: DetectionRegistry,
): {
  galleryCandidates: GalleryCandidate[];
  upsertCandidate?: ParsedSubjectProposalTarget["upsert_candidate"];
} {
  if (entityIdSource === "current_reid" && entityId) {
    const candidates: GalleryCandidate[] = [];

    for (const did of bboxIds) {
      const entry = registry.get(did)!;
      if (!canAppendFaceGallery(entry.face)) continue;

      if (entry.face!.entity_id === entityId) {
        candidates.push({
          did,
          entity_id: entityId,
          embedding: entry.face!.embedding!,
          quality: entry.face!.quality ?? 0,
          yaw: entry.face!.pose?.yaw,
          pitch: entry.face!.pose?.pitch,
          trust: "confirmed",
        });
      } else if (!entry.face!.entity_id) {
        candidates.push({
          did,
          entity_id: entityId,
          embedding: entry.face!.embedding!,
          quality: entry.face!.quality ?? 0,
          yaw: entry.face!.pose?.yaw,
          pitch: entry.face!.pose?.pitch,
          trust: "unmatched",
        });
      }
    }

    return { galleryCandidates: candidates };
  }

  if (!entityId || entityIdSource === null) {
    let bestFace: ParsedSubjectProposalTarget["upsert_candidate"] | undefined;

    for (const did of bboxIds) {
      const entry = registry.get(did)!;
      if (!canInitFaceEntity(entry.face)) continue;

      const quality = entry.face!.quality ?? 0;
      if (!bestFace || quality > bestFace.quality) {
        bestFace = {
          did,
          embedding: entry.face!.embedding!,
          quality,
          yaw: entry.face!.pose?.yaw,
          pitch: entry.face!.pose?.pitch,
        };
      }
    }

    return {
      galleryCandidates: [],
      upsertCandidate: bestFace,
    };
  }

  if (entityIdSource === "wm_inherited" && entityId) {
    return { galleryCandidates: [] };
  }

  return { galleryCandidates: [] };
}
