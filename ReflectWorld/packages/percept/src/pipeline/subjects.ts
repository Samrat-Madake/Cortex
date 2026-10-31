import type { Segment } from "@reflectworld/shared";
import type { FaceReIdResult } from "../analyzers/reid-entry.js";
import { extractCrop } from "../crop-utils.js";
import type { DetectionRegistry } from "../did-registry.js";
import { canAppendFaceGallery } from "../face-reid-policy.js";
import type { MediaUploader } from "../media-uploader.js";
import type {
  DIdEntry,
  WorkingMemoryTarget,
  WorkingMemoryTargetContinuityStrength,
  WorkingMemoryTargetStableCrop,
} from "../types.js";
import { BODY_REID_MATCH_THRESHOLD, FACE_REID_MATCH_THRESHOLD } from "../thresholds.js";
import type { WorkingMemoryManager } from "../working-memory.js";
import type { ParsedSubjectProposalTarget } from "../vlm-output-parser.js";

const VEHICLE_LABELS = new Set(["vehicle", "car", "motorcycle", "bus", "train", "truck", "bicycle", "boat"]);
const ANIMAL_LABELS = new Set(["animal", "dog", "cat", "bird", "horse", "cow", "sheep"]);

const SUBJECT_CONTEXT_MAX_DIDS_PER_GROUP = 6;

const STABLE_CROP_MIN_FACE_QUALITY = 0.5;
const STABLE_CROP_MIN_FACE_SHARPNESS = 30;
const STABLE_CROP_MAX_FACE_YAW = 90;
const STABLE_CROP_MAX_FACE_PITCH = 45;

type StableWmCropSource = WorkingMemoryTargetStableCrop["source"];

interface StableWmCropCandidate {
  entry: DIdEntry;
  score: number;
  source: StableWmCropSource;
}

export function normalizeEntityType(label: string | undefined): string {
  const type = (label ?? "object").toLowerCase();
  if (type === "person") return "person";
  if (VEHICLE_LABELS.has(type)) return "vehicle";
  if (ANIMAL_LABELS.has(type)) return "animal";
  return type;
}

export function selectedTargetAvatarScore(entry: DIdEntry | undefined): number | undefined {
  if (!entry) return undefined;
  if (entry.face) {
    const quality = entry.face.quality ?? 0;
    const sharpnessBonus = Math.min(0.2, (entry.face.sharpness ?? 0) / 1_000);
    const yawPenalty = Math.min(0.3, Math.abs(entry.face.pose?.yaw ?? 0) / 300);
    const pitchPenalty = Math.min(0.3, Math.abs(entry.face.pose?.pitch ?? 0) / 240);
    return Number(Math.max(0, quality + sharpnessBonus - yawPenalty - pitchPenalty).toFixed(4));
  }
  if (entry.body?.quality != null) return Number(Math.max(0, entry.body.quality * 0.6).toFixed(4));
  return undefined;
}

function stableWmCropSourceRank(source: StableWmCropSource): number {
  if (source === "face") return 0;
  if (source === "body") return 1;
  return 2;
}

function continuityStrengthRank(value: WorkingMemoryTargetContinuityStrength | undefined): number {
  if (value === "identity") return 3;
  if (value === "stable_visual") return 2;
  return 1;
}

function strongestContinuityStrength(
  a: WorkingMemoryTargetContinuityStrength | undefined,
  b: WorkingMemoryTargetContinuityStrength | undefined,
): WorkingMemoryTargetContinuityStrength | undefined {
  return continuityStrengthRank(a) >= continuityStrengthRank(b) ? a : b;
}

function hasStableCropFace(face: DIdEntry["face"] | undefined): boolean {
  if (!face) return false;
  if ((face.quality ?? 0) < STABLE_CROP_MIN_FACE_QUALITY) return false;
  if (face.sharpness != null && face.sharpness < STABLE_CROP_MIN_FACE_SHARPNESS) return false;
  if (!face.landmarks || face.landmarks.length < 5) return false;
  if (!face.pose) return false;
  if (Math.abs(face.pose.yaw) > STABLE_CROP_MAX_FACE_YAW) return false;
  if (Math.abs(face.pose.pitch) > STABLE_CROP_MAX_FACE_PITCH) return false;
  return true;
}

function hasStableFaceEvidence(target: ParsedSubjectProposalTarget, registry: DetectionRegistry): boolean {
  return target.bbox_ids.some((did) => hasStableCropFace(registry.get(did)?.face));
}

export function resolveTargetContinuityStrength(input: {
  target: ParsedSubjectProposalTarget;
  registry: DetectionRegistry;
  existingTarget?: WorkingMemoryTarget;
  currentSegmentId?: string;
}): WorkingMemoryTargetContinuityStrength {
  if (input.target.entity_id || input.existingTarget?.entity_id) return "identity";
  const existing = input.existingTarget?.continuity_strength;
  const hasIdentityCue = Boolean(input.target.name?.trim() || input.target.identity?.name?.trim());
  const hasSpeakerCue = (input.target.speaker_ids?.length ?? 0) > 0;
  if (hasIdentityCue || hasSpeakerCue || hasStableFaceEvidence(input.target, input.registry)) {
    return strongestContinuityStrength("stable_visual", existing) ?? "stable_visual";
  }

  const hasPriorAppearance = Boolean(
    input.existingTarget
    && (input.existingTarget.segments_seen ?? 0) >= 1
    && (!input.currentSegmentId || input.existingTarget.last_seen_segment_id !== input.currentSegmentId),
  );
  if (hasPriorAppearance) {
    return strongestContinuityStrength("stable_visual", existing) ?? "stable_visual";
  }

  return strongestContinuityStrength("weak_visual", existing) ?? "weak_visual";
}

export function shouldAttachWmTargetCropImages(target: WorkingMemoryTarget): boolean {
  if ((target.stable_crops?.length ?? 0) > 0) return true;
  if (target.entity_id) return true;
  if (target.identity?.name && !target.identity.conflict) return true;
  return target.continuity_strength === "stable_visual" || target.continuity_strength === "identity";
}

function stableWmCropCandidate(
  entry: DIdEntry,
  targetType: string,
): StableWmCropCandidate | undefined {
  const normalizedType = normalizeEntityType(targetType);
  const avatarScore = selectedTargetAvatarScore(entry);
  if (normalizedType === "person") {
    if (hasStableCropFace(entry.face)) {
      return {
        entry,
        score: avatarScore ?? 0.01,
        source: "face",
      };
    }
    return {
      entry,
      score: Number(Math.max(0.01, entry.body?.quality ?? entry.confidence ?? avatarScore ?? 0.01).toFixed(4)),
      source: "body",
    };
  }
  const score = avatarScore ?? entry.confidence;
  if (score == null || score <= 0) return undefined;
  return {
    entry,
    score: Number(Math.max(0.01, score).toFixed(4)),
    source: normalizedType === "animal" ? "body" : "fallback",
  };
}

export function mergeStableWmCrops(
  existing: WorkingMemoryTargetStableCrop[] | undefined,
  next: WorkingMemoryTargetStableCrop | undefined,
): WorkingMemoryTargetStableCrop[] | undefined {
  if (!next) return existing;
  const byKey = new Map<string, WorkingMemoryTargetStableCrop>();
  for (const crop of existing ?? []) {
    byKey.set(crop.crop_path || `${crop.segment_id}:${crop.did}`, crop);
  }
  byKey.set(next.crop_path || `${next.segment_id}:${next.did}`, next);
  const merged = Array.from(byKey.values()).filter((crop) => crop.crop_path && Number.isFinite(crop.score));
  const faceCrops = merged.filter((crop) => crop.source === "face");
  const bodyCrops = merged.filter((crop) => crop.source === "body");
  const fallback = merged
    .filter((crop) => crop.source === "fallback")
    .sort((a, b) => b.timestamp - a.timestamp || b.score - a.score)
    .slice(0, 1);
  const sortedFaces = faceCrops
    .sort((a, b) => b.score - a.score || b.timestamp - a.timestamp)
    .slice(0, 2);
  const sortedBodies = bodyCrops
    .sort((a, b) => b.timestamp - a.timestamp || b.score - a.score)
    .slice(0, 2);
  const selected: WorkingMemoryTargetStableCrop[] = [];
  if (sortedFaces[0]) selected.push(sortedFaces[0]);
  if (sortedBodies[0]) selected.push(sortedBodies[0]);
  if (sortedFaces[1]) selected.push(sortedFaces[1]);
  if (sortedBodies[1]) selected.push(sortedBodies[1]);
  if (selected.length === 0 && fallback[0]) selected.push(fallback[0]);
  return selected.length > 0 ? selected : undefined;
}

export function findCurrentWmTarget(
  workingMemory: WorkingMemoryManager,
  cameraId: string,
  targetId: string | null | undefined,
): WorkingMemoryTarget | undefined {
  if (!targetId) return undefined;
  return workingMemory.getTargets(cameraId).find((target) => target.target_id === targetId);
}

export function bestStableCropPath(stableCrops: WorkingMemoryTargetStableCrop[] | undefined, fallback: string): string {
  return stableCrops?.[0]?.crop_path || fallback;
}

export function currentSegmentStableCropPath(
  stableCrops: WorkingMemoryTargetStableCrop[] | undefined,
  segmentId: string,
): string | undefined {
  return stableCrops
    ?.filter((crop) => crop.segment_id === segmentId && crop.crop_path)
    .sort((a, b) => b.score - a.score || b.timestamp - a.timestamp)[0]
    ?.crop_path;
}

export function selectReliableTargetCropEntry(input: {
  target: ParsedSubjectProposalTarget;
  registry: DetectionRegistry;
  selectableDidIds?: Set<string>;
  requiredEntityEvidenceId?: string;
  /**
   * D{id} that directly produced the current stable entity assignment. If a
   * detector/ReID result is strong enough to create the entity, the same visual
   * evidence is allowed to seed the first display crop.
   */
  preferredDid?: string;
}): { did: string; entry: DIdEntry; candidate: StableWmCropCandidate } | undefined {
  if (input.target.reid_unsafe_reason && !input.target.entity_id) return undefined;
  const candidates: Array<{ did: string; entry: DIdEntry; candidate: StableWmCropCandidate }> = [];
  const resolverDisplayDids = input.target.display_crop_dids;
  const candidateDids = resolverDisplayDids !== undefined ? resolverDisplayDids : input.target.bbox_ids;
  const dids = input.preferredDid && candidateDids.includes(input.preferredDid)
    ? [input.preferredDid, ...candidateDids.filter((did) => did !== input.preferredDid)]
    : candidateDids;
  for (const did of dids) {
    if (input.selectableDidIds && !input.selectableDidIds.has(did) && did !== input.preferredDid) continue;
    const entry = input.registry.get(did);
    if (!entry) continue;
    if (input.target.entity_id && didConflictsWithTargetEntity(entry, input.target.entity_id)) continue;
    const isPreferredEntityEvidence = did === input.preferredDid && input.target.entity_id === input.requiredEntityEvidenceId;
    if (
      input.requiredEntityEvidenceId
      && !didMatchesTargetEntity(entry, input.requiredEntityEvidenceId)
      && !isPreferredEntityEvidence
    ) continue;
    const candidate = stableWmCropCandidate(entry, input.target.type);
    if (!candidate) continue;
    if (did === input.preferredDid) return { did, entry, candidate };
    candidates.push({ did, entry, candidate });
  }
  candidates.sort((a, b) => {
    const sourceDelta = stableWmCropSourceRank(a.candidate.source) - stableWmCropSourceRank(b.candidate.source);
    if (sourceDelta !== 0) return sourceDelta;
    if (a.candidate.source === "body") return b.entry.frame_idx - a.entry.frame_idx || b.candidate.score - a.candidate.score;
    return b.candidate.score - a.candidate.score || b.entry.frame_idx - a.entry.frame_idx;
  });
  const best = candidates[0];
  return best ? { did: best.did, entry: best.entry, candidate: best.candidate } : undefined;
}

function selectDisplayOnlyBodyCropEntry(input: {
  target: ParsedSubjectProposalTarget;
  registry: DetectionRegistry;
  selectableDidIds?: Set<string>;
  preferredDid?: string;
}): { did: string; entry: DIdEntry; candidate: StableWmCropCandidate } | undefined {
  if (normalizeEntityType(input.target.type) !== "person") return undefined;
  if (input.target.reid_unsafe_reason && !input.target.entity_id) return undefined;
  const candidateDids = input.target.display_crop_dids ?? input.target.bbox_ids;
  const dids = input.preferredDid && candidateDids.includes(input.preferredDid)
    ? [input.preferredDid, ...candidateDids.filter((did) => did !== input.preferredDid)]
    : candidateDids;
  for (const did of dids) {
    if (input.selectableDidIds && !input.selectableDidIds.has(did) && did !== input.preferredDid) continue;
    const entry = input.registry.get(did);
    if (!entry || normalizeEntityType(entry.class_name) !== "person") continue;
    if (input.target.entity_id && didConflictsWithTargetEntity(entry, input.target.entity_id)) continue;
    return {
      did,
      entry,
      candidate: {
        entry,
        score: Number(Math.max(0.01, entry.confidence ?? 0.01).toFixed(4)),
        source: "body",
      },
    };
  }
  return undefined;
}

function didConflictsWithTargetEntity(entry: DIdEntry, entityId: string): boolean {
  const faceEntityId = entry.face?.entity_id;
  if (faceEntityId && faceEntityId !== entityId) return true;
  const bodyEntityId = entry.body?.entity_id;
  if (bodyEntityId && bodyEntityId !== entityId) return true;
  return false;
}

function didMatchesTargetEntity(entry: DIdEntry, entityId: string): boolean {
  return entry.face?.entity_id === entityId || entry.body?.entity_id === entityId;
}

export async function saveReliableTargetCrop(input: {
  cameraId: string;
  segmentId: string;
  targetId: string;
  target: ParsedSubjectProposalTarget;
  registry: DetectionRegistry;
  frames: Segment["frames"];
  selectableDidIds?: Set<string>;
  requiredEntityEvidenceId?: string;
  preferredDid?: string;
  mediaUploader: MediaUploader;
}): Promise<{
  cropPath: string;
  selectedDid: string;
  canonicalDid?: string;
  stableCrop?: WorkingMemoryTargetStableCrop;
  displayOnly?: boolean;
} | undefined> {
  let cropSelection = selectReliableTargetCropEntry({
    target: input.target,
    registry: input.registry,
    selectableDidIds: input.selectableDidIds,
    requiredEntityEvidenceId: input.requiredEntityEvidenceId,
    preferredDid: input.preferredDid,
  });
  let displayOnly = false;
  if (!cropSelection) {
    cropSelection = selectDisplayOnlyBodyCropEntry({
      target: input.target,
      registry: input.registry,
      selectableDidIds: input.selectableDidIds,
      preferredDid: input.preferredDid,
    });
    displayOnly = Boolean(cropSelection);
  }
  if (!cropSelection) return undefined;
  const frame = input.frames[cropSelection.entry.frame_idx];
  if (!frame?.data) return undefined;
  const frameBuf = Buffer.from(frame.data, "base64");
  const cropBuf = await extractCrop(frameBuf, cropSelection.entry.bbox);
  const facePose = cropSelection.entry.face?.pose;
  const cropPath = input.mediaUploader.saveCrop(input.cameraId, input.segmentId, input.targetId, cropBuf);
  return {
    cropPath,
    selectedDid: cropSelection.did,
    canonicalDid: input.target.bbox_ids[0],
    ...(displayOnly
      ? { displayOnly: true }
      : {
          stableCrop: {
            crop_path: cropPath,
            segment_id: input.segmentId,
            did: cropSelection.did,
            score: cropSelection.candidate.score,
            source: cropSelection.candidate.source,
            timestamp: frame.timestamp ?? Date.now(),
            ...(cropSelection.entry.face?.quality != null ? { face_quality: cropSelection.entry.face.quality } : {}),
            ...(facePose?.yaw != null ? { face_yaw: facePose.yaw } : {}),
            ...(facePose?.pitch != null ? { face_pitch: facePose.pitch } : {}),
          },
        }),
  };
}

function formatDidList(entries: DIdEntry[]): string {
  const dids = entries
    .slice(0, SUBJECT_CONTEXT_MAX_DIDS_PER_GROUP)
    .map((entry) => entry.did);
  const suffix = entries.length > dids.length ? ` +${entries.length - dids.length} more` : "";
  return `[${dids.join(",")}${suffix}]`;
}

function formatEntityGroupType(entries: DIdEntry[]): string {
  const firstClass = entries[0]?.class_name?.toLowerCase();
  if (!firstClass) return "unknown";
  const normalized = normalizeEntityType(firstClass);
  return normalized === "animal" ? firstClass : normalized;
}

function compactSubjectContextText(value: string | undefined, maxChars: number): string | undefined {
  const compact = value?.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > maxChars ? `${compact.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…` : compact;
}

function compactSubjectHistory(input: {
  name?: string | null;
  appearance?: string;
  behaviors?: Array<string | undefined>;
}): string {
  const parts: string[] = [];
  const name = input.name?.trim();
  if (name) parts.push(`known_name=${name}`);
  const appearance = compactSubjectContextText(input.appearance, 120);
  if (appearance) parts.push(`appearance=${appearance}`);
  const behavior = input.behaviors
    ?.map((value) => compactSubjectContextText(value, 140))
    .filter((value): value is string => Boolean(value))
    .join(" | ");
  if (behavior) parts.push(`recent_behavior=${behavior}`);
  return parts.join("; ");
}

function reidMatchScore(entry: DIdEntry): number {
  return entry.face?.match_score ?? entry.body?.match_score ?? -1;
}

function didQualityScore(entry: DIdEntry): number {
  const faceWritable = canAppendFaceGallery(entry.face);
  const faceQuality = entry.face?.quality ?? -1;
  const avatarScore = selectedTargetAvatarScore(entry) ?? -1;
  const faceSharpness = entry.face?.sharpness != null
    ? Math.min(1, entry.face.sharpness / 200)
    : -1;
  const bodyQuality = entry.body?.quality ?? -1;
  if (faceWritable) return 10 + faceQuality + Math.max(0, avatarScore) + Math.max(0, faceSharpness) * 0.1;
  if (entry.face?.embedding?.length) return 5 + Math.max(0, faceQuality) + Math.max(0, avatarScore) * 0.1;
  if (entry.body?.entity_id) return 3 + Math.max(0, bodyQuality);
  return Math.max(0, entry.confidence ?? 0);
}

function sortByReidSimilarity(entries: DIdEntry[]): DIdEntry[] {
  return [...entries].sort((a, b) => {
    const qualityDelta = didQualityScore(b) - didQualityScore(a);
    if (qualityDelta !== 0) return qualityDelta;
    const scoreDelta = reidMatchScore(b) - reidMatchScore(a);
    if (scoreDelta !== 0) return scoreDelta;
    if (a.frame_idx !== b.frame_idx) return a.frame_idx - b.frame_idx;
    return a.did.localeCompare(b.did, undefined, { numeric: true });
  });
}

function promptHintSubjectContextEntityId(entry: DIdEntry): string | undefined {
  if (
    entry.face?.entity_id
    && entry.face.match_score != null
    && entry.face.match_score >= FACE_REID_MATCH_THRESHOLD
  ) {
    return entry.face.entity_id;
  }
  if (
    entry.body?.entity_id
    && (entry.body.match_score ?? 0) >= BODY_REID_MATCH_THRESHOLD
  ) {
    return entry.body.entity_id;
  }
  return undefined;
}

function bestStableCropScore(target: WorkingMemoryTarget): number {
  return Math.max(0, ...(target.stable_crops ?? []).map((crop) => crop.score));
}

function hasUsableIdentity(target: WorkingMemoryTarget): boolean {
  return Boolean(target.identity?.name && !target.identity.conflict);
}

function compareCanonicalWmTarget(a: WorkingMemoryTarget, b: WorkingMemoryTarget): number {
  const strengthDelta = continuityStrengthRank(b.continuity_strength) - continuityStrengthRank(a.continuity_strength);
  if (strengthDelta !== 0) return strengthDelta;
  const seenDelta = (b.segments_seen ?? 0) - (a.segments_seen ?? 0);
  if (seenDelta !== 0) return seenDelta;
  const recentDelta = (b.last_seen_timestamp ?? 0) - (a.last_seen_timestamp ?? 0);
  if (recentDelta !== 0) return recentDelta;
  const cropDelta = bestStableCropScore(b) - bestStableCropScore(a);
  if (cropDelta !== 0) return cropDelta;
  const identityDelta = Number(hasUsableIdentity(b)) - Number(hasUsableIdentity(a));
  if (identityDelta !== 0) return identityDelta;
  return a.target_id.localeCompare(b.target_id, undefined, { numeric: true });
}

function compareWmTargetForPrompt(a: WorkingMemoryTarget, b: WorkingMemoryTarget): number {
  const entityDelta = Number(Boolean(b.entity_id)) - Number(Boolean(a.entity_id));
  if (entityDelta !== 0) return entityDelta;
  const identityDelta = Number(hasUsableIdentity(b)) - Number(hasUsableIdentity(a));
  if (identityDelta !== 0) return identityDelta;
  const strengthDelta = continuityStrengthRank(b.continuity_strength) - continuityStrengthRank(a.continuity_strength);
  if (strengthDelta !== 0) return strengthDelta;
  const seenDelta = (b.segments_seen ?? 0) - (a.segments_seen ?? 0);
  if (seenDelta !== 0) return seenDelta;
  const cropDelta = bestStableCropScore(b) - bestStableCropScore(a);
  if (cropDelta !== 0) return cropDelta;
  const recentDelta = (b.last_seen_timestamp ?? 0) - (a.last_seen_timestamp ?? 0);
  if (recentDelta !== 0) return recentDelta;
  return a.target_id.localeCompare(b.target_id, undefined, { numeric: true });
}

export function prepareWmTargetsForSubjectProposal(wmTargets: WorkingMemoryTarget[]): WorkingMemoryTarget[] {
  const byEntity = new Map<string, WorkingMemoryTarget>();
  const anonymous: WorkingMemoryTarget[] = [];

  for (const target of wmTargets) {
    if (!target.entity_id) {
      anonymous.push(target);
      continue;
    }
    const existing = byEntity.get(target.entity_id);
    if (!existing || compareCanonicalWmTarget(target, existing) < 0) {
      byEntity.set(target.entity_id, target);
    }
  }

  return [...byEntity.values(), ...anonymous]
    .sort(compareWmTargetForPrompt);
}

export function buildCompactSubjectEvidenceContext(input: {
  registry: { all(): DIdEntry[] };
  wmTargets: WorkingMemoryTarget[];
  faceEntityHistory: Map<string, string>;
  faceResults: FaceReIdResult[];
  selectableDidIds?: Set<string>;
}): string {
  const entries = input.registry.all().filter((entry) =>
    !input.selectableDidIds || input.selectableDidIds.has(entry.did)
  );
  const lines: string[] = [
    "Current segment visual evidence (D{id} labels are drawn on frames):",
  ];

  const entityGroups = new Map<string, DIdEntry[]>();
  for (const entry of entries) {
    const entityId = promptHintSubjectContextEntityId(entry);
    if (entityId) {
      const group = entityGroups.get(entityId) ?? [];
      group.push(entry);
      entityGroups.set(entityId, group);
      continue;
    }
  }

  const usedEntityIds = new Set<string>();
  const wmTargetLines: string[] = [];
  for (const target of input.wmTargets.slice(0, 8)) {
    const entityId = target.entity_id;
    const group = entityId ? entityGroups.get(entityId) : undefined;
    if (entityId) usedEntityIds.add(entityId);
    if (!group?.length) continue;
    const faceResult = entityId ? input.faceResults.find((result) => result.entity_id === entityId) : undefined;
    const history = compactSubjectHistory({
      name: faceResult?.name ?? target.identity?.name,
      appearance: target.appearance,
      behaviors: [
        entityId ? input.faceEntityHistory.get(entityId) : undefined,
        target.behavior,
        target.identity?.evidence,
      ],
    });
    const parts = [
      `candidate [${target.target_id}] ${normalizeEntityType(target.class_name)}`,
      entityId ? `entity=${entityId}` : undefined,
      history || undefined,
      `possible D{id}s=${formatDidList(sortByReidSimilarity(group))}`,
    ].filter((part): part is string => Boolean(part));
    wmTargetLines.push(`- ${parts.join("; ")}`);
  }
  if (wmTargetLines.length > 0) {
    lines.push("Machine candidate links from ReID / working memory:");
    lines.push(...wmTargetLines);
  }

  const entityOnlyLines: string[] = [];
  for (const [entityId, group] of entityGroups.entries()) {
    if (usedEntityIds.has(entityId)) continue;
    const faceResult = input.faceResults.find((result) => result.entity_id === entityId);
    const history = compactSubjectHistory({
      name: faceResult?.name,
      behaviors: [input.faceEntityHistory.get(entityId)],
    });
    const parts = [
      `candidate entity=${entityId}`,
      `type=${formatEntityGroupType(group)}`,
      history || undefined,
      `possible D{id}s=${formatDidList(sortByReidSimilarity(group))}`,
    ].filter((part): part is string => Boolean(part));
    entityOnlyLines.push(`- ${parts.join("; ")}`);
  }
  if (entityOnlyLines.length > 0) {
    lines.push("Machine candidate links from ReID without a working-memory participant:");
    lines.push(...entityOnlyLines);
  }

  lines.push("Other visible D{id}s are available on the annotated frames. Select them only if they are key subjects in this segment.");

  return lines.join("\n");
}

export function shouldAttachWmTargetCrops(wmTargets: WorkingMemoryTarget[], detections: DIdEntry[]): boolean {
  if (wmTargets.length === 0 || detections.length === 0) return false;

  const wmByClass = countBy(wmTargets.map((target) => normalizeEntityType(target.class_name)));
  const maxDetectionsPerFrameByClass = maxSameClassDetectionsPerFrame(detections);

  for (const [className, wmCount] of wmByClass) {
    if (wmCount >= 1 && (maxDetectionsPerFrameByClass.get(className) ?? 0) >= 1) return true;
  }

  return false;
}

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function maxSameClassDetectionsPerFrame(detections: DIdEntry[]): Map<string, number> {
  const byFrameAndClass = new Map<string, number>();
  const maxByClass = new Map<string, number>();
  for (const det of detections) {
    const className = normalizeEntityType(det.class_name);
    const key = `${det.frame_idx}:${className}`;
    const count = (byFrameAndClass.get(key) ?? 0) + 1;
    byFrameAndClass.set(key, count);
    maxByClass.set(className, Math.max(maxByClass.get(className) ?? 0, count));
  }
  return maxByClass;
}
