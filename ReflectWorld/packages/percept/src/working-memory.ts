// packages/percept/src/working-memory.ts
import type {
  WorkingMemoryState,
  EntityContext,
  AnonymousSubjectContext,
  WorkingMemoryTarget,
  WorkingMemoryTargetUpsert,
  WorkingMemoryTargetIdentity,
  WorkingMemoryTargetIdentityHint,
  WorkingMemoryTargetStableCrop,
  WorkingMemoryEventState,
  PendingEmbedding,
  EventCloseSummary,
  NarrativeCallbacks,
  VlmEventContextUpdate,
} from "./types.js";
import type { PerceptionDialogueLine } from "@reflectworld/shared";
import { writeStderr } from "@reflectworld/shared";

/** Configuration for WorkingMemoryManager. */
export interface WorkingMemoryConfig {
  /**
   * Seconds of inactivity after which an open event is automatically closed.
   * Defaults to 30 seconds.
   */
  event_timeout_sec: number;
  /**
   * Seconds after last observation before a tracked entity is evicted from cache.
   * Applies to entity_context. Defaults to 300 (5 min).
   */
  entity_ttl_sec: number;
  /**
   * Maximum number of segments allowed in a single event. The next segment opens
   * a new event once the current event reaches this count. Defaults to 30.
   */
  max_event_segments: number;
}

const DEFAULT_CONFIG: WorkingMemoryConfig = {
  event_timeout_sec: 30,
  entity_ttl_sec: 300,
  max_event_segments: 18,
};

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

function normalizeMs(value: number | undefined, fallback = 0): number {
  return Number.isFinite(value) ? Math.round(value!) : fallback;
}

function continuityStrengthRank(value: WorkingMemoryTarget["continuity_strength"]): number {
  if (value === "identity") return 3;
  if (value === "stable_visual") return 2;
  return 1;
}

function strongerContinuityStrength(
  a: WorkingMemoryTarget["continuity_strength"],
  b: WorkingMemoryTarget["continuity_strength"],
): WorkingMemoryTarget["continuity_strength"] {
  return continuityStrengthRank(a) >= continuityStrengthRank(b) ? a : b;
}

/**
 * Manages per-camera working memory for the Perception pipeline.
 *
 * Responsibilities:
 * - Opens and closes event groups across segment boundaries
 * - Tracks entity context (appearance/behavior) within an event
 * - Keeps the latest 3 segment summaries for VLM prompt grounding
 * - Stores the VLM-maintained rolling event_summary
 * - Detects event timeout (inactivity)
 */
export class WorkingMemoryManager {
  private states = new Map<string, WorkingMemoryState>();
  private config: WorkingMemoryConfig;

  /** Max characters for scene_context to prevent VLM token overflow. */
  private static readonly MAX_SCENE_CONTEXT_CHARS = 2000;
  private static readonly RECENT_SEGMENT_SUMMARY_COUNT = 3;
  private static readonly MAX_EVENT_SUMMARY_WORDS = 100;
  private static readonly MAX_DIALOGUE_LINES_PER_SEGMENT = 4;
  private static readonly MAX_DIALOGUE_TEXT_CHARS = 180;

  constructor(config: Partial<WorkingMemoryConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  getMaxEventSegments(): number {
    return Math.max(1, Math.floor(this.config.max_event_segments));
  }

  getEventTimeoutMs(): number {
    return Math.max(1, Math.floor(this.config.event_timeout_sec)) * 1000;
  }

  private onEventClosed?: NarrativeCallbacks["onEventClosed"];

  setNarrativeCallbacks(callbacks: NarrativeCallbacks): void {
    // onContextCompressed is intentionally ignored. Event close is the only
    // NarrativeMemory ingestion point in the VLM-maintained summary design.
    this.onEventClosed = callbacks.onEventClosed;
  }

  /**
   * Returns the working memory state for a camera, initialising it if needed.
   */
  getState(cameraId: string): WorkingMemoryState {
    if (!this.states.has(cameraId)) {
      this.states.set(cameraId, this.createFreshState(cameraId));
    }
    return this.states.get(cameraId)!;
  }

  /**
   * Processes a new segment arrival for a camera.
   *
   * - If no event is open: opens a new event and returns the new event_id.
   * - If an event is open but timed out: closes the old event, opens a new one.
   * - If an event is open and reaches max_event_segments: closes it and opens a new one.
   * - If an event is open and not timed out/at limit: extends it and increments segment_count.
   *
   * @returns The event_id to assign to this segment's PerceptionResult.
   */
  onSegmentArrived(cameraId: string, mode?: string, nowMs: number = Date.now()): string {
    const state = this.getState(cameraId);

    // Snapshot mode: every segment is an independent event
    if (mode === "snapshot") {
      if (state.current_event_id !== null) this.closeEvent(state, mode);
      return this.openEvent(state, nowMs);
    }

    const timeoutMs = this.getEventTimeoutMs();

    if (state.current_event_id === null) {
      return this.openEvent(state, nowMs);
    }

    const idleSince = nowMs - state.last_activity_time;
    if (idleSince > timeoutMs) {
      return this.switchEvent(cameraId, mode, nowMs);
    }

    if (state.segment_count >= this.getMaxEventSegments()) {
      return this.switchEvent(cameraId, mode, nowMs, { carryTargets: true });
    }

    state.segment_count += 1;
    state.last_activity_time = nowMs;
    return state.current_event_id;
  }

  /**
   * Updates entity context after VLM analysis produces new observations.
   * Merges with existing context rather than replacing it.
   */
  updateEntityContext(
    cameraId: string,
    entityRef: string,
    update: Partial<EntityContext>,
    nowMs: number = Date.now(),
    segmentTimestamp: number = nowMs,
  ): void {
    const state = this.getState(cameraId);
    const existing = state.entity_context.get(entityRef) ?? {
      appearance: "",
      behavior: "",
      last_seen: nowMs,
    };
    if (existing.segment_timestamp != null && segmentTimestamp < existing.segment_timestamp) return;
    state.entity_context.set(entityRef, {
      appearance: update.appearance ?? existing.appearance,
      behavior: update.behavior ?? existing.behavior,
      last_seen: nowMs,
      entity_id: update.entity_id ?? existing.entity_id,
      segment_timestamp: segmentTimestamp,
    });
  }

  /**
   * Records the current segment summary. This no longer triggers an LLM call;
   * VLM receives the latest 3 segment summaries directly on the next segment.
   */
  appendSceneContext(
    cameraId: string,
    text: string,
    segmentId?: string,
    title?: string,
    fields: { summary?: string; detailedSummary?: string; dialogue?: PerceptionDialogueLine[] } = {},
  ): void {
    const normalized = this.normalizeOneLine(text);
    if (!normalized) return;
    const normalizedTitle = this.normalizeOneLine(title ?? "");
    const state = this.getState(cameraId);
    state.recent_segment_contexts ??= [];
    const normalizedSummary = this.normalizeOneLine(fields.summary ?? text);
    const normalizedDetailedSummary = this.normalizeOneLine(fields.detailedSummary ?? "");
    const dialogue = this.normalizeDialogueLines(fields.dialogue);
    if (segmentId) {
      const existingIndex = state.recent_segment_summary_ids.indexOf(segmentId);
      if (existingIndex >= 0) {
        const existing = state.recent_segment_contexts[existingIndex];
        state.recent_segment_contexts[existingIndex] = {
          segment_id: segmentId,
          title: normalizedTitle || existing?.title,
          summary: normalizedSummary || existing?.summary,
          detailed_summary: normalizedDetailedSummary || existing?.detailed_summary,
          dialogue: dialogue ?? existing?.dialogue,
        };
        this.syncRecentSegmentSummaries(state);
        this.rebuildSceneContext(state);
        return;
      }
    }
    const body = normalizedTitle
      ? `title=${normalizedTitle}; summary=${normalized}`
      : normalized;
    const prefixed = segmentId ? `[${segmentId}] ${body}` : body;
    state.recent_segment_contexts.push({
      segment_id: segmentId ?? "",
      title: normalizedTitle || undefined,
      summary: normalizedSummary || undefined,
      detailed_summary: normalizedDetailedSummary || undefined,
      dialogue,
    });
    state.recent_segment_summaries.push(prefixed);
    // Keep ids aligned with summaries. Legacy callers may omit segmentId, but
    // later late-final dedupe still needs index parity to replace the right row.
    state.recent_segment_summary_ids.push(segmentId ?? "");
    if (state.recent_segment_summaries.length > WorkingMemoryManager.RECENT_SEGMENT_SUMMARY_COUNT) {
      state.recent_segment_summaries = state.recent_segment_summaries.slice(-WorkingMemoryManager.RECENT_SEGMENT_SUMMARY_COUNT);
      state.recent_segment_summary_ids = state.recent_segment_summary_ids.slice(-WorkingMemoryManager.RECENT_SEGMENT_SUMMARY_COUNT);
      state.recent_segment_contexts = state.recent_segment_contexts.slice(-WorkingMemoryManager.RECENT_SEGMENT_SUMMARY_COUNT);
    }
    this.syncRecentSegmentSummaries(state);
    this.rebuildSceneContext(state);
  }

  /** Stores the VLM-maintained rolling summary for the current event. */
  updateEventSummary(cameraId: string, summary: string | undefined, segmentTimestamp: number = Date.now()): void {
    const normalized = this.truncateWords(this.normalizeOneLine(summary ?? ""), WorkingMemoryManager.MAX_EVENT_SUMMARY_WORDS);
    if (!normalized) return;
    const state = this.getState(cameraId);
    if (state.event_summary_segment_timestamp != null && segmentTimestamp < state.event_summary_segment_timestamp) return;
    state.event_summary = normalized;
    state.event_summary_segment_timestamp = segmentTimestamp;
    this.rebuildSceneContext(state);
  }

  /** Returns the VLM-maintained rolling summary for the current event. */
  getCurrentEventSummary(cameraId: string): string {
    return this.getState(cameraId).event_summary;
  }

  /** Returns the latest segment summaries for VLM grounding, newest last. */
  getRecentSegmentSummaries(cameraId: string): string[] {
    return [...this.getState(cameraId).recent_segment_summaries];
  }

  updateEventContext(cameraId: string, update: VlmEventContextUpdate | undefined): void {
    if (!update) return;
    const state = this.getState(cameraId);
    const current = state.event_state ?? { participants: [] };
    const next: WorkingMemoryEventState = {
      participants: current.participants.map((participant) => ({ ...participant })),
    };
    if (current.setting) next.setting = current.setting;
    const setting = this.normalizeOneLine(update.setting ?? "");
    if (setting) next.setting = setting;

    const participantByKey = new Map(next.participants.map((participant) => [this.eventParticipantKey(participant), participant]));
    for (const participantUpdate of update.participant_updates ?? []) {
      const role = this.normalizeOneLine(participantUpdate.role ?? "");
      const visualHints = this.normalizeOneLine(participantUpdate.visual_hints ?? "");
      if (!role && !visualHints) continue;
      const key = this.eventParticipantKey({ role, visual_hints: visualHints });
      const existing = participantByKey.get(key);
      if (existing) {
        if (role) existing.role = role;
        if (visualHints) existing.visual_hints = visualHints;
        participantByKey.set(this.eventParticipantKey(existing), existing);
        continue;
      }
      const participant = {
        ...(role ? { role } : {}),
        ...(visualHints ? { visual_hints: visualHints } : {}),
      };
      next.participants.push(participant);
      participantByKey.set(key, participant);
    }
    next.participants = next.participants.slice(-8);

    if (next.setting || next.participants.length > 0) {
      state.event_state = next;
    }
  }

  getEventContextPrompt(cameraId: string): string | undefined {
    const eventState = this.getState(cameraId).event_state;
    if (!eventState?.setting && !eventState?.participants.length) return undefined;
    const lines: string[] = [];
    if (eventState.setting) lines.push(`Setting: ${eventState.setting}`);
    if (eventState.participants.length > 0) {
      lines.push("Participants:");
      for (const participant of eventState.participants) {
        const parts = [
          participant.role ? `role=${participant.role}` : undefined,
          participant.visual_hints ? `visual_hints=${participant.visual_hints}` : undefined,
        ].filter((part): part is string => Boolean(part));
        if (parts.length > 0) lines.push(`- ${parts.join("; ")}`);
      }
    }
    return lines.join("\n");
  }

  /**
   * Adds an escalation hint for the current event.
   * Hints are surfaced in PerceptionResult for Act to evaluate.
   */
  addEscalationHint(cameraId: string, hint: string): void {
    const state = this.getState(cameraId);
    if (!state.escalation_hints.includes(hint)) {
      state.escalation_hints.push(hint);
    }
  }

  /**
   * Records a notification that was sent, so the VLM can avoid duplicates.
   */
  addRecentNotification(cameraId: string, description: string): void {
    const state = this.getState(cameraId);
    state.recent_notifications.push(description);
    if (state.recent_notifications.length > 10) {
      state.recent_notifications = state.recent_notifications.slice(-10);
    }
  }

  /**
   * Records a segment in its FINAL event (after boundary detection).
   * Must be called from pipeline AFTER VLM boundary decision.
   * Does NOT update lifecycle fields (segment_count, last_activity_time).
   */
  recordSegment(cameraId: string, segmentId: string, timestamp: number): void {
    if (!this.states.has(cameraId)) return;
    const state = this.states.get(cameraId)!;
    if (state.current_event_id === null) {
      writeStderr(`[working-memory] recordSegment called with no active event for ${cameraId}`);
      return;
    }
    if (state.segment_ids.includes(segmentId)) return;
    state.segment_ids.push(segmentId);
    if (state.evidence_start_ms == null) state.evidence_start_ms = timestamp;
    state.evidence_end_ms = timestamp;
  }

  /** Returns recent notification descriptions for VLM dedup context. */
  getRecentNotifications(cameraId: string): string[] {
    return this.getState(cameraId).recent_notifications;
  }

  /** Returns the latest 3 segment summaries as a compact legacy context string. */
  getSceneContext(cameraId: string): string {
    return this.getState(cameraId).scene_context;
  }

  /**
   * Explicitly closes the active event for a camera (e.g. on EOS signal from Eye).
   * Clears event-scoped context and emits one final EventCloseSummary.
   */
  closeCurrentEvent(cameraId: string, mode?: string): void {
    if (!this.states.has(cameraId)) return;
    const state = this.states.get(cameraId)!;
    if (state.current_event_id === null) return;
    if (mode === "snapshot") {
      this.closeEvent(state, mode);
      return;
    }
    const eventSummary = this.buildEventSummary(state, this.snapshotEntities(cameraId));
    this.closeEvent(state, mode);
    this.onEventClosed?.(cameraId, eventSummary);
  }

  /**
   * VLM-driven event boundary: close current event and open a new one.
   * The current segment is the first segment of the new event, so prior-event
   * summaries are closed out through NarrativeMemory rather than carried into
   * the new WorkingMemory scene context.
   */
  switchEvent(
    cameraId: string,
    mode?: string,
    nowMs?: number,
    options: { carryTargets?: boolean } = {},
  ): string {
    const s = this.getState(cameraId);
    const entitySnapshot = this.snapshotEntities(cameraId);
    const eventSummary = this.buildEventSummary(s, entitySnapshot);
    const carryTargets = options.carryTargets
      ? (s.targets ?? []).map(t => ({
          ...t,
          // Max-segment rotation carries targets as a short bootstrap window.
          // If later segments do not rematch them, tickTargetMiss evicts them.
          segments_missed: 0,
          carry_rematch_remaining: WorkingMemoryManager.CARRIED_TARGET_REMATCH_WINDOW_SEGMENTS,
        }))
      : [];
    this.closeEvent(s, mode);
    this.onEventClosed?.(cameraId, eventSummary);
    const newEventId = this.openEvent(s, nowMs ?? Date.now());
    if (carryTargets.length > 0) {
      s.targets = carryTargets;
      s.target_counter = this.nextTargetCounter(carryTargets);
    }
    s.recent_segment_summaries = [];
    s.recent_segment_summary_ids = [];
    s.recent_segment_contexts = [];
    this.rebuildSceneContext(s);
    return newEventId;
  }

  /** Checks whether an event is currently open for a camera. */
  hasActiveEvent(cameraId: string): boolean {
    return this.getState(cameraId).current_event_id !== null;
  }

  /**
   * Evict stale entities that haven't been observed within entity_ttl_sec.
   * Call this once per segment to keep caches bounded.
   */
  evictStaleEntities(cameraId: string, nowMs: number = Date.now()): void {
    const state = this.getState(cameraId);
    const ttlMs = this.config.entity_ttl_sec * 1000;

    for (const [key, ctx] of state.entity_context) {
      if (nowMs - ctx.last_seen > ttlMs) {
        state.entity_context.delete(key);
      }
    }
  }

  // ── Anonymous Subject Context ──

  private static readonly MAX_ANONYMOUS_SUBJECTS = 8;
  private static readonly ANONYMOUS_MAX_MISSED_SEGMENTS = 3;

  /** Returns active anonymous subjects for VLM cross-segment matching context. */
  getAnonymousSubjects(cameraId: string): AnonymousSubjectContext[] {
    return this.getState(cameraId).anonymous_subjects;
  }

  /** Create or update an anonymous subject. Enforces cap with LRU eviction. */
  upsertAnonymousSubject(cameraId: string, context: AnonymousSubjectContext): void {
    const state = this.getState(cameraId);
    const idx = state.anonymous_subjects.findIndex(
      (s) => s.anonymous_subject_id === context.anonymous_subject_id,
    );
    if (idx >= 0) {
      state.anonymous_subjects[idx] = context;
    } else {
      state.anonymous_subjects.push(context);
    }
    // LRU eviction if over cap
    if (state.anonymous_subjects.length > WorkingMemoryManager.MAX_ANONYMOUS_SUBJECTS) {
      state.anonymous_subjects.sort((a, b) => b.last_seen_timestamp - a.last_seen_timestamp);
      state.anonymous_subjects.length = WorkingMemoryManager.MAX_ANONYMOUS_SUBJECTS;
    }
  }

  /**
   * Increment segments_missed for unmatched anonymous subjects and evict stale ones.
   * Call once per segment after VLM output parsing is complete.
   * @param matchedIds Set of anonymous_subject_ids that were matched this segment.
   */
  tickAnonymousMiss(cameraId: string, matchedIds: Set<string>): void {
    const state = this.getState(cameraId);
    state.anonymous_subjects = state.anonymous_subjects.filter((s) => {
      if (matchedIds.has(s.anonymous_subject_id)) return true;
      s.segments_missed += 1;
      return s.segments_missed <= WorkingMemoryManager.ANONYMOUS_MAX_MISSED_SEGMENTS;
    });
  }

  // ── Subject Target Continuity ──

  private static readonly MAX_TARGETS = 8;
  private static readonly CARRIED_TARGET_REMATCH_WINDOW_SEGMENTS = 5;

  /** Returns active subject targets for a camera. */
  getTargets(cameraId: string): WorkingMemoryTarget[] {
    return (this.getState(cameraId).targets ?? []).map((target) => ({
      ...target,
      identity: target.identity ? { ...target.identity } : undefined,
      identity_hints: target.identity_hints?.map((hint) => ({ ...hint })),
      stable_crops: target.stable_crops?.map((crop) => ({ ...crop })),
      pending_face_embeddings: target.pending_face_embeddings?.map((embedding) => ({ ...embedding })),
      stable_face_embeddings: target.stable_face_embeddings?.map((embedding) => ({
        ...embedding,
        embedding: [...embedding.embedding],
      })),
      pending_body_embeddings: target.pending_body_embeddings?.map((embedding) => ({ ...embedding })),
    }));
  }

  /** Allocate a monotonically increasing target ID within the current event. */
  allocateTargetId(cameraId: string): string {
    const state = this.getState(cameraId);
    const counter = state.target_counter ?? 0;
    state.target_counter = counter + 1;
    return `wm_t${counter + 1}`;
  }

  /**
   * Create or update a subject target. Enforces cap with LRU eviction.
   *
   * Pending embedding pool semantics for pending_face_embeddings,
   * pending_body_embeddings, and pending_entity_id:
   *   - `undefined` (field omitted): preserve existing value on the target
   *   - `null`: clear the field (stored as undefined on WorkingMemoryTarget)
   *   - value (array or string): replace the field
   */
  upsertTarget(cameraId: string, input: WorkingMemoryTargetUpsert): string {
    const state = this.getState(cameraId);
    if (!state.targets) state.targets = [];
    const idx = state.targets.findIndex(t => t.target_id === input.target_id);
    const existing = idx >= 0 ? state.targets[idx] : undefined;
    if (
      existing?.last_seen_timestamp != null
      && input.last_seen_timestamp != null
      && input.last_seen_timestamp < existing.last_seen_timestamp
    ) {
      return existing.target_id;
    }
    const appearance = coerceTextField(input.appearance);
    const behavior = coerceTextField(input.behavior);

    const merged: WorkingMemoryTarget = {
      ...(existing ?? {}),
      ...input,
      appearance: appearance || existing?.appearance || "",
      behavior: behavior || existing?.behavior,
      identity: input.identity ?? existing?.identity,
      identity_hints: existing?.identity_hints,
      continuity_strength: strongerContinuityStrength(input.continuity_strength, existing?.continuity_strength),
      stable_crops: input.stable_crops === null
        ? undefined
        : (input.stable_crops?.map((crop) => ({ ...crop })) ?? existing?.stable_crops),
      // Pending fields: null → clear (undefined), array/string → replace, undefined → preserve existing
      pending_face_embeddings: input.pending_face_embeddings === null
        ? undefined
        : (input.pending_face_embeddings ?? existing?.pending_face_embeddings),
      stable_face_embeddings: input.stable_face_embeddings === null
        ? undefined
        : (input.stable_face_embeddings ?? existing?.stable_face_embeddings),
      pending_body_embeddings: input.pending_body_embeddings === null
        ? undefined
        : (input.pending_body_embeddings ?? existing?.pending_body_embeddings),
      pending_entity_id: input.pending_entity_id === null
        ? undefined
        : (input.pending_entity_id ?? existing?.pending_entity_id),
    } as WorkingMemoryTarget;

    if (idx >= 0) {
      state.targets[idx] = merged;
    } else {
      state.targets.push(merged);
    }
    const aliases = this.mergeEntityDuplicateTargets(state, existing ? merged.target_id : undefined);
    const canonicalTargetId = aliases.get(merged.target_id) ?? merged.target_id;
    // LRU eviction
    if (state.targets.length > WorkingMemoryManager.MAX_TARGETS) {
      state.targets.sort((a, b) => b.last_seen_timestamp - a.last_seen_timestamp);
      state.targets.length = WorkingMemoryManager.MAX_TARGETS;
    }
    return canonicalTargetId;
  }

  /** Attach a weak event-local identity hint that must not update stable entities. */
  addTargetIdentityHint(
    cameraId: string,
    targetId: string,
    hint: Pick<WorkingMemoryTargetIdentityHint, "name" | "evidence" | "source_segment_id" | "source">,
  ): boolean {
    const target = this.getState(cameraId).targets?.find(t => t.target_id === targetId);
    const name = this.normalizeOneLine(hint.name);
    const evidence = this.normalizeOneLine(hint.evidence);
    if (!target || !name || !evidence) return false;

    const source = hint.source;
    const existing = target.identity_hints ?? [];
    const duplicate = existing.some((item) =>
      this.identityNamesMatch(item.name, name)
      && item.source === source
      && item.source_segment_id === hint.source_segment_id
    );
    if (duplicate) return true;

    target.identity_hints = [
      ...existing,
      {
        name,
        evidence,
        source_segment_id: hint.source_segment_id,
        ...(source ? { source } : {}),
      },
    ].slice(-6);
    return true;
  }

  /** Attach an event-local name clue to a working-memory target. */
  setTargetIdentity(
    cameraId: string,
    targetId: string,
    identity: Pick<WorkingMemoryTargetIdentity, "name" | "evidence" | "source_segment_id">,
  ): boolean {
    const target = this.getState(cameraId).targets?.find(t => t.target_id === targetId);
    const name = this.normalizeOneLine(identity.name);
    const evidence = this.normalizeOneLine(identity.evidence);
    if (!target || !name || !evidence) return false;

    if (!target.identity) {
      target.identity = { name, evidence, source_segment_id: identity.source_segment_id };
      this.clearTargetIdentityHints(target, name);
      return true;
    }

    if (this.identityNamesMatch(target.identity.name, name)) {
      target.identity = {
        ...target.identity,
        name: target.identity.name || name,
        evidence: target.identity.evidence || evidence,
        source_segment_id: target.identity.source_segment_id || identity.source_segment_id,
      };
      this.clearTargetIdentityHints(target, name);
      return true;
    }

    target.identity = {
      ...target.identity,
      conflict: true,
      evidence: this.truncateWords(
        `${target.identity.evidence}; conflicting identity "${name}": ${evidence}`,
        60,
      ),
    };
    return false;
  }

  private clearTargetIdentityHints(target: WorkingMemoryTarget, confirmedName: string): void {
    if (!target.identity_hints?.length) return;
    const remaining = target.identity_hints.filter((hint) => !this.identityNamesMatch(hint.name, confirmedName));
    target.identity_hints = remaining.length > 0 ? remaining : undefined;
  }

  /** Returns a copy of the target identity clue, if one exists. */
  getTargetIdentity(cameraId: string, targetId: string): WorkingMemoryTargetIdentity | undefined {
    const identity = this.getState(cameraId).targets?.find(t => t.target_id === targetId)?.identity;
    return identity ? { ...identity } : undefined;
  }

  /** Mark that a target-local identity clue has already been written to an entity. */
  markTargetIdentityPromoted(cameraId: string, targetId: string, entityId: string): void {
    const target = this.getState(cameraId).targets?.find(t => t.target_id === targetId);
    if (!target?.identity || target.identity.conflict) return;
    target.identity.promoted_entity_id = entityId;
  }

  /**
   * Increment segments_missed for unmatched subject targets.
   *
   * Within an event, targets are retained until the event ends. Event length is
   * already bounded by max_event_segments, and dropping active-event targets on
   * short camera cuts hurts broadcast/interview continuity. The only eviction
   * here is for max-segment rollover bootstrap targets, which are deliberately
   * carried into the next event near the eviction threshold and get a small
   * rematch window.
   *
   * Call once per segment after VLM output parsing is complete.
   * @param matchedIds Set of target_ids that were matched this segment.
   */
  tickTargetMiss(cameraId: string, matchedIds: Set<string>): void {
    const state = this.getState(cameraId);
    if (!state.targets) return;
    state.targets = state.targets.filter(t => {
      if (matchedIds.has(t.target_id)) {
        t.segments_missed = 0;
        delete t.carry_rematch_remaining;
        return true;
      }
      t.segments_missed += 1;
      if (typeof t.carry_rematch_remaining === "number") {
        t.carry_rematch_remaining -= 1;
        return t.carry_rematch_remaining >= 0;
      }
      return true;
    });
  }

  /** Full reset for a camera — called on watch stop to prevent state bleed. */
  resetCamera(cameraId: string): void {
    this.states.delete(cameraId);
  }

  // -- Private helpers --

  private mergeEntityDuplicateTargets(
    state: WorkingMemoryState,
    preferredTargetId?: string,
  ): Map<string, string> {
    const targets = state.targets ?? [];
    if (targets.length <= 1) return new Map();

    const byEntity = new Map<string, WorkingMemoryTarget[]>();
    for (const target of targets) {
      if (!target.entity_id) continue;
      const key = `${this.normalizeOneLine(target.class_name).toLowerCase()}\u0000${target.entity_id}`;
      const group = byEntity.get(key) ?? [];
      group.push(target);
      byEntity.set(key, group);
    }

    const aliases = new Map<string, string>();
    const removed = new Set<string>();
    for (const group of byEntity.values()) {
      if (group.length <= 1) continue;
      const canonical = this.chooseCanonicalTarget(group, preferredTargetId);
      for (const target of group) {
        if (target.target_id === canonical.target_id) continue;
        this.mergeTargetIntoCanonical(canonical, target);
        aliases.set(target.target_id, canonical.target_id);
        removed.add(target.target_id);
      }
    }

    if (removed.size > 0) {
      state.targets = targets.filter((target) => !removed.has(target.target_id));
    }
    return aliases;
  }

  private chooseCanonicalTarget(
    targets: WorkingMemoryTarget[],
    preferredTargetId?: string,
  ): WorkingMemoryTarget {
    // Same-entity hard merge must preserve the oldest event-local target id.
    // A later anonymous split may receive the entity_id after several segments;
    // keeping that split as canonical would relabel the stable subject.
    return [...targets].sort((a, b) => {
      const aOrder = this.parseTargetOrdinal(a.target_id);
      const bOrder = this.parseTargetOrdinal(b.target_id);
      if (aOrder !== bOrder) return aOrder - bOrder;
      if (b.segments_seen !== a.segments_seen) return b.segments_seen - a.segments_seen;
      const preferredDelta = Number(b.target_id === preferredTargetId) - Number(a.target_id === preferredTargetId);
      if (preferredDelta !== 0) return preferredDelta;
      return b.last_seen_timestamp - a.last_seen_timestamp;
    })[0]!;
  }

  private mergeTargetIntoCanonical(canonical: WorkingMemoryTarget, duplicate: WorkingMemoryTarget): void {
    const duplicateIsNewer = duplicate.last_seen_timestamp > canonical.last_seen_timestamp;
    canonical.entity_id = canonical.entity_id ?? duplicate.entity_id;
    canonical.continuity_strength = strongerContinuityStrength(
      canonical.continuity_strength,
      duplicate.continuity_strength,
    );
    canonical.appearance = duplicateIsNewer
      ? (duplicate.appearance || canonical.appearance)
      : (canonical.appearance || duplicate.appearance);
    canonical.behavior = duplicateIsNewer
      ? (duplicate.behavior || canonical.behavior)
      : (canonical.behavior || duplicate.behavior);
    canonical.last_seen_segment_id = duplicateIsNewer
      ? duplicate.last_seen_segment_id
      : canonical.last_seen_segment_id;
    canonical.last_seen_timestamp = Math.max(canonical.last_seen_timestamp, duplicate.last_seen_timestamp);
    canonical.segments_seen = Math.max(1, canonical.segments_seen + duplicate.segments_seen);
    canonical.segments_missed = Math.min(canonical.segments_missed, duplicate.segments_missed);

    const stableCrops = this.mergeStableTargetCrops(canonical.stable_crops, duplicate.stable_crops);
    if (stableCrops.length > 0) {
      canonical.stable_crops = stableCrops;
      canonical.crop_path = stableCrops[0]!.crop_path;
    } else if (!canonical.crop_path && duplicate.crop_path) {
      canonical.crop_path = duplicate.crop_path;
    }

    canonical.pending_face_embeddings = this.mergePendingEmbeddings(
      canonical.pending_face_embeddings,
      duplicate.pending_face_embeddings,
    );
    canonical.stable_face_embeddings = this.mergePendingEmbeddings(
      canonical.stable_face_embeddings,
      duplicate.stable_face_embeddings,
    );
    canonical.pending_body_embeddings = this.mergePendingEmbeddings(
      canonical.pending_body_embeddings,
      duplicate.pending_body_embeddings,
    );
    canonical.pending_entity_id = canonical.pending_entity_id ?? duplicate.pending_entity_id;
    this.mergeTargetIdentity(canonical, duplicate);
    canonical.identity_hints = this.mergeTargetIdentityHints(canonical.identity_hints, duplicate.identity_hints);
  }

  private mergeStableTargetCrops(
    a: WorkingMemoryTargetStableCrop[] | undefined,
    b: WorkingMemoryTargetStableCrop[] | undefined,
  ): WorkingMemoryTargetStableCrop[] {
    const bestByKey = new Map<string, WorkingMemoryTargetStableCrop>();
    for (const crop of [...(a ?? []), ...(b ?? [])]) {
      const key = `${crop.crop_path}\u0000${crop.segment_id}\u0000${crop.did}`;
      const existing = bestByKey.get(key);
      if (!existing || crop.score > existing.score) bestByKey.set(key, { ...crop });
    }
    const merged = [...bestByKey.values()];
    const faces = merged
      .filter((crop) => crop.source === "face")
      .sort((left, right) => right.score - left.score || right.timestamp - left.timestamp)
      .slice(0, 2);
    const bodies = merged
      .filter((crop) => crop.source === "body")
      .sort((left, right) => right.timestamp - left.timestamp || right.score - left.score)
      .slice(0, 2);
    const fallback = merged
      .filter((crop) => crop.source === "fallback")
      .sort((left, right) => right.timestamp - left.timestamp || right.score - left.score)
      .slice(0, 1);
    return [...faces.slice(0, 1), ...bodies.slice(0, 1), ...faces.slice(1), ...bodies.slice(1), ...fallback]
      .slice(0, 6);
  }

  private mergePendingEmbeddings(
    a: PendingEmbedding[] | undefined,
    b: PendingEmbedding[] | undefined,
  ): PendingEmbedding[] | undefined {
    const bestByKey = new Map<string, PendingEmbedding>();
    for (const embedding of [...(a ?? []), ...(b ?? [])]) {
      const key = `${embedding.segment_id}\u0000${embedding.did}`;
      const existing = bestByKey.get(key);
      if (!existing || embedding.quality > existing.quality) {
        bestByKey.set(key, {
          ...embedding,
          embedding: [...embedding.embedding],
        });
      }
    }
    const merged = [...bestByKey.values()]
      .sort((left, right) => right.quality - left.quality)
      .slice(0, 8);
    return merged.length > 0 ? merged : undefined;
  }

  private mergeTargetIdentity(canonical: WorkingMemoryTarget, duplicate: WorkingMemoryTarget): void {
    const identity = duplicate.identity;
    if (!identity) return;
    if (!canonical.identity) {
      canonical.identity = { ...identity };
      return;
    }
    if (this.identityNamesMatch(canonical.identity.name, identity.name)) {
      canonical.identity = {
        ...canonical.identity,
        name: canonical.identity.name || identity.name,
        evidence: canonical.identity.evidence || identity.evidence,
        source_segment_id: canonical.identity.source_segment_id || identity.source_segment_id,
        promoted_entity_id: canonical.identity.promoted_entity_id ?? identity.promoted_entity_id,
        conflict: canonical.identity.conflict || identity.conflict,
      };
      return;
    }
    canonical.identity = {
      ...canonical.identity,
      conflict: true,
      evidence: this.truncateWords(
        `${canonical.identity.evidence}; conflicting merged identity "${identity.name}": ${identity.evidence}`,
        60,
      ),
    };
  }

  private mergeTargetIdentityHints(
    a: WorkingMemoryTargetIdentityHint[] | undefined,
    b: WorkingMemoryTargetIdentityHint[] | undefined,
  ): WorkingMemoryTargetIdentityHint[] | undefined {
    const bestByKey = new Map<string, WorkingMemoryTargetIdentityHint>();
    for (const hint of [...(a ?? []), ...(b ?? [])]) {
      const name = this.normalizeOneLine(hint.name);
      const evidence = this.normalizeOneLine(hint.evidence);
      if (!name || !evidence) continue;
      const key = `${name.toLocaleLowerCase()}\u0000${hint.source ?? ""}\u0000${hint.source_segment_id}`;
      if (!bestByKey.has(key)) {
        bestByKey.set(key, {
          name,
          evidence,
          source_segment_id: hint.source_segment_id,
          ...(hint.source ? { source: hint.source } : {}),
        });
      }
    }
    const merged = [...bestByKey.values()].slice(-6);
    return merged.length > 0 ? merged : undefined;
  }

  private parseTargetOrdinal(targetId: string): number {
    const match = targetId.match(/^wm_t(\d+)$/);
    return match ? Number.parseInt(match[1]!, 10) || Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
  }

  private eventParticipantKey(participant: { role?: string; visual_hints?: string }): string {
    const visualHints = this.normalizeOneLine(participant.visual_hints ?? "").toLocaleLowerCase();
    if (visualHints) return `visual:${visualHints}`;
    return `role:${this.normalizeOneLine(participant.role ?? "").toLocaleLowerCase()}`;
  }

  private snapshotEntities(cameraId: string): Array<{ key: string; context: EntityContext }> {
    const state = this.getState(cameraId);
    return Array.from(state.entity_context.entries()).map(([key, ctx]) => ({ key, context: { ...ctx } }));
  }

  private buildEventSummary(state: WorkingMemoryState, entitySnapshot: Array<{ key: string; context: EntityContext }>): EventCloseSummary {
    const segmentText = state.recent_segment_summaries.join("\n");
    const eventSummary = this.truncateWords(
      this.normalizeOneLine(state.event_summary || segmentText),
      WorkingMemoryManager.MAX_EVENT_SUMMARY_WORDS,
    );
    return {
      event_id: state.current_event_id!,
      event_summary: eventSummary || undefined,
      compressed_context: eventSummary || segmentText,
      entities: entitySnapshot,
      segment_count: state.segment_ids.length,
      segment_ids: [...state.segment_ids],
      time_range: {
        start_ms: normalizeMs(state.evidence_start_ms),
        end_ms: normalizeMs(state.evidence_end_ms, normalizeMs(state.evidence_start_ms)),
      },
    };
  }

  private rebuildSceneContext(state: WorkingMemoryState): void {
    const text = state.recent_segment_summaries.join("\n");
    state.scene_context = text.length > WorkingMemoryManager.MAX_SCENE_CONTEXT_CHARS
      ? text.slice(-WorkingMemoryManager.MAX_SCENE_CONTEXT_CHARS)
      : text;
  }

  private renderRecentSegmentContext(context: NonNullable<WorkingMemoryState["recent_segment_contexts"]>[number]): string {
    const text = context.detailed_summary || context.summary || "";
    if (!context.segment_id) return text;
    const parts: string[] = [];
    if (context.title) parts.push(`title=${context.title}`);
    if (context.detailed_summary) {
      parts.push(`detailed_summary=${text}`);
    } else if (text) {
      parts.push(`summary=${text}`);
    }
    const body = parts.length > 0 ? parts.join("; ") : text;
    const lines = [context.segment_id ? `[${context.segment_id}] ${body}` : body];
    const dialogueLines = this.renderDialogueLines(context.dialogue);
    if (dialogueLines.length > 0) {
      lines.push("Dialogue:");
      lines.push(...dialogueLines);
    }
    return lines.filter(Boolean).join("\n");
  }

  private syncRecentSegmentSummaries(state: WorkingMemoryState): void {
    if (!state.recent_segment_contexts?.length) return;
    state.recent_segment_summaries = state.recent_segment_contexts.map((context) =>
      this.renderRecentSegmentContext(context)
    );
  }

  private nextTargetCounter(targets: WorkingMemoryTarget[]): number {
    let max = 0;
    for (const target of targets) {
      const match = target.target_id.match(/^wm_t(\d+)$/);
      if (!match) continue;
      max = Math.max(max, Number.parseInt(match[1]!, 10) || 0);
    }
    return max;
  }

  private createFreshState(cameraId: string): WorkingMemoryState {
    return {
      camera_id: cameraId,
      current_event_id: null,
      event_start_time: 0,
      segment_count: 0,
      last_activity_time: 0,
      entity_context: new Map(),
      scene_context: "",
      event_summary: "",
      event_summary_segment_timestamp: undefined,
      recent_segment_summaries: [],
      recent_segment_summary_ids: [],
      recent_segment_contexts: [],
      event_state: undefined,
      escalation_hints: [],
      recent_notifications: [],
      anonymous_subjects: [],
      segment_ids: [],
      evidence_start_ms: undefined,
      evidence_end_ms: undefined,
      targets: [],
      target_counter: 0,
    };
  }

  private openEvent(state: WorkingMemoryState, nowMs: number): string {
    const eventId = `evt_${state.camera_id}_${nowMs}`;
    state.current_event_id = eventId;
    state.event_start_time = nowMs;
    state.segment_count = 1;
    state.last_activity_time = nowMs;
    state.entity_context.clear();
    state.scene_context = "";
    state.event_summary = "";
    state.event_summary_segment_timestamp = undefined;
    state.recent_segment_summaries = [];
    state.recent_segment_summary_ids = [];
    state.recent_segment_contexts = [];
    state.event_state = undefined;
    state.escalation_hints = [];
    state.recent_notifications = [];
    state.segment_ids = [];
    state.evidence_start_ms = undefined;
    state.evidence_end_ms = undefined;
    state.targets = [];
    state.target_counter = 0;

    return eventId;
  }

  private closeEvent(state: WorkingMemoryState, _mode?: string): void {
    state.current_event_id = null;
    state.event_start_time = 0;
    state.segment_count = 0;
    state.entity_context.clear();
    state.scene_context = "";
    state.event_summary = "";
    state.event_summary_segment_timestamp = undefined;
    state.recent_segment_summaries = [];
    state.recent_segment_summary_ids = [];
    state.recent_segment_contexts = [];
    state.event_state = undefined;
    state.escalation_hints = [];
    state.recent_notifications = [];
    state.segment_ids = [];
    state.evidence_start_ms = undefined;
    state.evidence_end_ms = undefined;
    state.targets = [];
    state.target_counter = 0;
  }

  private normalizeOneLine(text: string): string {
    return text.replace(/\s+/g, " ").trim();
  }

  private normalizeDialogueLines(dialogue: PerceptionDialogueLine[] | undefined): PerceptionDialogueLine[] | undefined {
    const lines = (dialogue ?? [])
      .filter((line) => line.text?.trim())
      .slice(-WorkingMemoryManager.MAX_DIALOGUE_LINES_PER_SEGMENT)
      .map((line) => ({
        ...line,
        text: this.truncateChars(this.normalizeOneLine(line.text ?? ""), WorkingMemoryManager.MAX_DIALOGUE_TEXT_CHARS),
      }));
    return lines.length > 0 ? lines : undefined;
  }

  private renderDialogueLines(dialogue: PerceptionDialogueLine[] | undefined): string[] {
    return (dialogue ?? [])
      .filter((line) => line.text?.trim())
      .slice(-WorkingMemoryManager.MAX_DIALOGUE_LINES_PER_SEGMENT)
      .map((line) => {
        const speaker = this.normalizeOneLine(line.speaker ?? line.entity_id ?? line.track_id ?? "Unknown");
        const text = this.truncateChars(this.normalizeOneLine(line.text ?? ""), WorkingMemoryManager.MAX_DIALOGUE_TEXT_CHARS);
        return `- ${speaker}: ${text}`;
      });
  }

  private identityNamesMatch(a: string, b: string): boolean {
    return this.normalizeOneLine(a).toLocaleLowerCase() === this.normalizeOneLine(b).toLocaleLowerCase();
  }

  private truncateWords(text: string, maxWords: number): string {
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length <= maxWords) return text;
    return words.slice(0, maxWords).join(" ");
  }

  private truncateChars(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
  }
}
