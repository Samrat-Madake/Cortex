/** In-memory representation of one camera's semantic_context profile. */
export interface SemanticContextData {
  cameraId: string;
  userNotes: string;
  sceneDescription: string;
  knownEntities: string;
  dailyRoutine: string;
  anomalyBaseline: string;
  metadata: SemanticContextMetadata;
}

export interface SemanticContextMetadata {
  last_llm_update: string;
  last_update_segment_count: number;
  last_agent_consult: string;
  last_consult_segment_count: number;
  consecutive_no_updates: number;
}

export interface SemanticContextEntityObservation {
  entity_id?: string;
  track_id?: string;
  type: string;
  appearance?: string;
  is_new_entity?: boolean;
}

export interface SemanticContextIdentityCue {
  name: string;
  entity_id?: string;
  segment_id?: string;
  track_id?: string;
  speaker_id?: string;
  identity_level?: string;
  evidence?: string;
  source?: "target_identity" | "memory" | "other";
}

/**
 * Minimal interface for the Qdrant-backed semantic_context write/read path.
 * Matches ReflectWorldClient.upsertSemanticContext() + getMemories() without
 * importing @reflectworld/mem.
 */
export interface SemanticContextWriter {
  upsertSemanticContext(request: {
    camera_id: string;
    scene_description: string;
    known_entities: string;
    daily_routine: string;
    anomaly_baseline: string;
    user_notes?: string;
    user_id?: string;
    last_llm_update?: string;
    last_update_segment_count?: number;
    last_agent_consult?: string;
    last_consult_segment_count?: number;
    consecutive_no_updates?: number;
  }): Promise<unknown>;

  getMemories(request: Record<string, unknown>): Promise<unknown>;
}

const SYSTEM_CONTENT_LIMIT = 500;

interface LoadCachedOptions {
  throwOnHydrateError?: boolean;
}

/** JSON schema for LLM summarization output. */
export interface SummarizationResult {
  no_update: boolean;
  scene_description?: string;
  known_entities?: string;
  daily_routine?: string;
  anomaly_baseline?: string;
}

/** Sanitize camera_id for filesystem-safe paths used by other modules. */
export function sanitizeCameraId(cameraId: string): string {
  return cameraId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Format semantic context as sectioned prompt text. This is not persisted as a file. */
export function serializeSemanticContext(data: SemanticContextData): string {
  let systemParts = [data.sceneDescription, data.knownEntities, data.dailyRoutine, data.anomalyBaseline];
  const totalLen = systemParts.filter(Boolean).join("\n").length;
  if (totalLen > SYSTEM_CONTENT_LIMIT) {
    const ratio = SYSTEM_CONTENT_LIMIT / totalLen;
    systemParts = systemParts.map((s) => (s ? s.slice(0, Math.floor(s.length * ratio)) : s));
  }

  const lines = [`# Semantic Context: ${data.cameraId}`, ""];
  const addSection = (title: string, content: string) => {
    lines.push(`## ${title}`);
    lines.push(content || "");
    lines.push("");
  };

  addSection("User Notes", data.userNotes);
  addSection("Scene Description", systemParts[0] ?? "");
  addSection("Known Entities", systemParts[1] ?? "");
  addSection("Daily Routine", systemParts[2] ?? "");
  addSection("Anomaly Baseline", systemParts[3] ?? "");

  const m = data.metadata;
  addSection("Metadata", [
    `last_llm_update: ${m.last_llm_update}`,
    `last_update_segment_count: ${m.last_update_segment_count}`,
    `last_agent_consult: ${m.last_agent_consult}`,
    `last_consult_segment_count: ${m.last_consult_segment_count}`,
    `consecutive_no_updates: ${m.consecutive_no_updates}`,
  ].join("\n"));

  return lines.join("\n");
}

function parseUserNoteSubsections(userNotes: string): {
  freeLines: string[];
  sections: Map<string, string[]>;
} {
  const sections = new Map<string, string[]>();
  const freeLines: string[] = [];
  let currentSub = "";
  for (const line of userNotes.split("\n")) {
    const subMatch = line.match(/^###?\s+(.+)/);
    if (subMatch) {
      currentSub = subMatch[1]!.trim();
      if (!sections.has(currentSub)) sections.set(currentSub, []);
    } else if (currentSub) {
      sections.get(currentSub)!.push(line);
    } else {
      freeLines.push(line);
    }
  }
  return { freeLines, sections };
}

function serializeUserNoteSubsections(freeLines: string[], sections: Map<string, string[]>): string {
  const parts: string[] = [];
  if (freeLines.some((line) => line.trim())) parts.push(freeLines.join("\n").trim());
  for (const [title, lines] of sections) {
    const content = lines.join("\n").trim();
    if (content) parts.push(`### ${title}\n${content}`);
  }
  return parts.join("\n\n").trim();
}

// ── SemanticContextManager ──

/** Configuration for SemanticContextManager. */
export interface SemanticContextManagerConfig {
  /** Qdrant client for reading/writing semantic_context entries. REQUIRED. */
  memClient: SemanticContextWriter;
  /** User ID propagated to Qdrant writes. REQUIRED. */
  userId: string;
  /** Injected callback: query segment count from PipelineStore. */
  getSegmentCount: (cameraId: string) => number;
  /** Injected callback: run LLM summarization. Returns SummarizationResult with explicit fields. */
  onLlmUpdate?: (cameraId: string, currentProfile: string, observations: string[]) => Promise<SummarizationResult>;
  /** Injected callback: submit Agent consultation. */
  onAgentConsult?: (cameraId: string, currentProfile: string, observationSummary: string) => Promise<void>;
}

const BOOTSTRAP_THRESHOLD = 15;
const AGENT_CONSULT_THRESHOLD = 100;
const STABLE_DAILY_MS = 24 * 60 * 60 * 1000;
const CONSECUTIVE_NO_UPDATE_FOR_STABLE = 2;
const MAX_BUFFER_SIZE = 15;

/**
 * Manages per-camera semantic_context profiles.
 *
 * Responsibilities:
 * - Buffers VLM observations per camera
 * - Evaluates trigger conditions (bootstrap vs stable phase)
 * - Delegates LLM summarization and Agent consultation via callbacks
 * - Hydrates from Qdrant on first access and caches in memory
 * - Persists updates to Qdrant semantic_context as the sole durable store
 */
export class SemanticContextManager {
  private config: SemanticContextManagerConfig;
  private memClient: SemanticContextWriter;
  private userId: string;
  /** Per-camera observation buffers (in-memory, cleared on update or watch stop). */
  private buffers = new Map<string, string[]>();
  /** Per-camera new entity sightings since last update. */
  private entityBuffers = new Map<string, SemanticContextEntityObservation[]>();
  /** Per-camera named identity sightings since last update. */
  private identityBuffers = new Map<string, NamedIdentityObservation[]>();
  /** Per-camera locks to prevent concurrent semantic_context writes. */
  private writeLocks = new Map<string, Promise<void>>();
  /** Per-camera LLM update in-flight guard — stores generation to prevent cross-session interference. */
  private updateInFlight = new Map<string, number>();
  /** Per-camera agent consultation pending guard — stores generation for same reason. */
  private consultPending = new Map<string, number>();
  /** Per-camera generation counter — incremented on clearBuffer to invalidate in-flight LLM results. */
  private generations = new Map<string, number>();
  /** Per-camera semantic_context cache hydrated from Qdrant and updated after writes. */
  private cache = new Map<string, SemanticContextData>();

  constructor(config: SemanticContextManagerConfig) {
    this.config = config;
    this.memClient = config.memClient;
    this.userId = config.userId;
  }

  /** Load semantic_context from in-memory cache, hydrating from Qdrant on first access. */
  private async loadCached(cameraId: string, options: LoadCachedOptions = {}): Promise<SemanticContextData | undefined> {
    const cached = this.cache.get(cameraId);
    if (cached) return cloneSemanticContext(cached);
    try {
      return await this.hydrateFromQdrant(cameraId);
    } catch (err) {
      if (options.throwOnHydrateError) throw err;
      return undefined;
    }
  }

  /** Cold-start hydration: fetch semantic_context from Qdrant. */
  private async hydrateFromQdrant(cameraId: string): Promise<SemanticContextData | undefined> {
    const resp = await this.memClient.getMemories({
      memory_type: "semantic_context",
      camera_id: cameraId,
      user_id: this.userId,
      limit: 1,
    });
    const entries = Array.isArray(resp)
      ? resp
      : Object.values(resp as Record<string, unknown>)
          .filter((value): value is Array<Record<string, unknown>> => Array.isArray(value))
          .flat();
    if (entries.length === 0) return undefined;

    const entry = entries[0] as Record<string, unknown>;
    const meta = (entry.metadata ?? (entry.payload as Record<string, unknown>) ?? entry) as Record<string, unknown>;
    const data: SemanticContextData = {
      cameraId,
      sceneDescription: String(meta.scene_description ?? ""),
      knownEntities: String(meta.known_entities ?? ""),
      dailyRoutine: String(meta.daily_routine ?? ""),
      anomalyBaseline: String(meta.anomaly_baseline ?? ""),
      userNotes: String(meta.user_notes ?? ""),
      metadata: {
        last_llm_update: String(meta.last_llm_update ?? ""),
        last_update_segment_count: Number(meta.last_update_segment_count) || 0,
        last_agent_consult: String(meta.last_agent_consult ?? ""),
        last_consult_segment_count: Number(meta.last_consult_segment_count) || 0,
        consecutive_no_updates: Number(meta.consecutive_no_updates) || 0,
      },
    };
    this.updateCache(cameraId, data);
    return cloneSemanticContext(data);
  }

  private updateCache(cameraId: string, data: SemanticContextData): void {
    this.cache.set(cameraId, cloneSemanticContext(data));
  }

  /** Load semantic_context prompt text for VLM injection. Returns undefined when absent. */
  async load(cameraId: string): Promise<string | undefined> {
    let data: SemanticContextData | undefined;
    try {
      data = await this.loadCached(cameraId, { throwOnHydrateError: true });
    } catch {
      return;
    }
    if (!data) return undefined;
    return serializeSemanticContext(data);
  }

  /** Called after each segment. Buffers observations and checks trigger conditions. */
  async onSegmentProcessed(
    cameraId: string,
    summary: string,
    entities: SemanticContextEntityObservation[],
    identityCues: SemanticContextIdentityCue[] = [],
  ): Promise<void> {
    const buffer = this.buffers.get(cameraId) ?? [];
    const entityBuf = this.entityBuffers.get(cameraId) ?? [];
    const identityBuf = this.identityBuffers.get(cameraId) ?? [];

    const newEntities = entities.filter((entity) => entity.is_new_entity);
    const entityDesc = newEntities
      .map((entity) => `[new ${entity.type}${formatEntityAnchor(entity)}${entity.appearance ? `: ${entity.appearance}` : ""}]`)
      .join(" ");
    const identityObservations = buildNamedIdentityObservations(entities, identityCues);
    const identityDesc = identityObservations.map(formatNamedIdentityObservation).join(" ");
    buffer.push([summary, entityDesc, identityDesc].filter(Boolean).join(" "));
    while (buffer.length > MAX_BUFFER_SIZE) buffer.shift();
    this.buffers.set(cameraId, buffer);

    for (const entity of newEntities) {
      const isDuplicate = entity.entity_id
        ? entityBuf.some((existing) => existing.entity_id === entity.entity_id)
        : entityBuf.some((existing) => !existing.entity_id && existing.type === entity.type && existing.appearance === entity.appearance);
      if (!isDuplicate) {
        entityBuf.push({
          entity_id: entity.entity_id,
          track_id: entity.track_id,
          type: entity.type,
          appearance: entity.appearance,
          is_new_entity: entity.is_new_entity,
        });
      }
    }
    this.entityBuffers.set(cameraId, entityBuf);

    for (const identity of identityObservations) {
      const key = identityKey(identity);
      if (!identityBuf.some((existing) => identityKey(existing) === key)) {
        identityBuf.push(identity);
      }
    }
    this.identityBuffers.set(cameraId, identityBuf);

    let data: SemanticContextData | undefined;
    try {
      data = await this.loadCached(cameraId, { throwOnHydrateError: true });
    } catch {
      return;
    }
    const segmentCount = this.config.getSegmentCount(cameraId);

    const consultGen = this.generations.get(cameraId) ?? 0;
    if (data && this.config.onAgentConsult && !this.consultPending.has(cameraId)) {
      const sinceLastConsult = segmentCount - data.metadata.last_consult_segment_count;
      if (sinceLastConsult >= AGENT_CONSULT_THRESHOLD) {
        const profileText = serializeSemanticContext(data);
        const observationSummary = buffer.join("\n");
        this.consultPending.set(cameraId, consultGen);
        this.config.onAgentConsult(cameraId, profileText, observationSummary)
          .then(async () => {
            await this.withWriteLock(cameraId, async () => {
              if ((this.generations.get(cameraId) ?? 0) !== consultGen) return;
              const freshData = await this.loadCached(cameraId, { throwOnHydrateError: true });
              if (!freshData) return;
              freshData.metadata.last_agent_consult = new Date().toISOString();
              freshData.metadata.last_consult_segment_count = segmentCount;
              await this.persistAndCache(cameraId, freshData);
            });
          })
          .catch(() => {
            // Failed — don't update metadata so next trigger retries.
          })
          .finally(() => {
            if (this.consultPending.get(cameraId) === consultGen) {
              this.consultPending.delete(cameraId);
            }
          });
      }
    }

    if (!this.config.onLlmUpdate) return;
    if (this.updateInFlight.has(cameraId)) return;

    const shouldUpdate = this.shouldTriggerLlmUpdate(data, segmentCount, buffer.length, identityBuf.length);
    if (!shouldUpdate) return;

    const bufferSnapshot = this.buffers.get(cameraId) ?? [];
    this.buffers.set(cameraId, []);
    const entitySnapshot = this.entityBuffers.get(cameraId) ?? [];
    this.entityBuffers.set(cameraId, []);
    const identitySnapshot = this.identityBuffers.get(cameraId) ?? [];
    this.identityBuffers.set(cameraId, []);
    const gen = this.generations.get(cameraId) ?? 0;

    const preData = data ?? createDefaultSemanticContext(cameraId);
    const profileText = serializeSemanticContext(preData);

    this.updateInFlight.set(cameraId, gen);
    let result: SummarizationResult;
    try {
      result = await this.config.onLlmUpdate(cameraId, profileText, bufferSnapshot);
    } catch {
      if ((this.generations.get(cameraId) ?? 0) === gen) {
        const current = this.buffers.get(cameraId) ?? [];
        this.buffers.set(cameraId, [...bufferSnapshot, ...current]);
        const currentEntities = this.entityBuffers.get(cameraId) ?? [];
        this.entityBuffers.set(cameraId, [...entitySnapshot, ...currentEntities]);
        const currentIdentities = this.identityBuffers.get(cameraId) ?? [];
        this.identityBuffers.set(cameraId, [...identitySnapshot, ...currentIdentities]);
      }
      if (this.updateInFlight.get(cameraId) === gen) {
        this.updateInFlight.delete(cameraId);
      }
      return;
    }

    try {
      await this.withWriteLock(cameraId, async () => {
        if ((this.generations.get(cameraId) ?? 0) !== gen) return;

        const currentData = (await this.loadCached(cameraId, { throwOnHydrateError: true })) ?? createDefaultSemanticContext(cameraId);
        let semanticIdentityChanged = false;
        if (result.no_update) {
          currentData.metadata.consecutive_no_updates += 1;
        } else {
          if (typeof result.scene_description === "string") currentData.sceneDescription = result.scene_description;
          if (typeof result.known_entities === "string") {
            currentData.knownEntities = mergeKnownEntitiesPreservingAnchoredIdentities(
              currentData.knownEntities,
              result.known_entities,
            );
          }
          if (typeof result.daily_routine === "string") currentData.dailyRoutine = result.daily_routine;
          if (typeof result.anomaly_baseline === "string") currentData.anomalyBaseline = result.anomaly_baseline;
          currentData.metadata.consecutive_no_updates = 0;
        }
        if (identitySnapshot.length > 0) {
          const merged = mergeNamedIdentityKnownEntities(currentData.knownEntities, identitySnapshot);
          currentData.knownEntities = merged.text;
          semanticIdentityChanged = merged.changed;
          if (semanticIdentityChanged) currentData.metadata.consecutive_no_updates = 0;
        }

        currentData.metadata.last_llm_update = new Date().toISOString();
        currentData.metadata.last_update_segment_count = segmentCount;
        await this.persistAndCache(cameraId, currentData);
      });
    } catch {
      if ((this.generations.get(cameraId) ?? 0) === gen) {
        const current = this.buffers.get(cameraId) ?? [];
        this.buffers.set(cameraId, [...bufferSnapshot, ...current]);
        const currentEntities = this.entityBuffers.get(cameraId) ?? [];
        this.entityBuffers.set(cameraId, [...entitySnapshot, ...currentEntities]);
        const currentIdentities = this.identityBuffers.get(cameraId) ?? [];
        this.identityBuffers.set(cameraId, [...identitySnapshot, ...currentIdentities]);
      }
    } finally {
      if (this.updateInFlight.get(cameraId) === gen) {
        this.updateInFlight.delete(cameraId);
      }
    }
  }

  private async persistAndCache(cameraId: string, data: SemanticContextData): Promise<void> {
    await this.persistToQdrant(cameraId, data);
    this.updateCache(cameraId, data);
  }

  /** Persist semantic_context to Qdrant as the sole durable store. */
  private async persistToQdrant(cameraId: string, data: SemanticContextData): Promise<void> {
    await this.memClient.upsertSemanticContext({
      camera_id: cameraId,
      scene_description: data.sceneDescription,
      known_entities: data.knownEntities,
      daily_routine: data.dailyRoutine,
      anomaly_baseline: data.anomalyBaseline,
      user_notes: data.userNotes,
      user_id: this.userId,
      last_llm_update: data.metadata.last_llm_update,
      last_update_segment_count: data.metadata.last_update_segment_count,
      last_agent_consult: data.metadata.last_agent_consult,
      last_consult_segment_count: data.metadata.last_consult_segment_count,
      consecutive_no_updates: data.metadata.consecutive_no_updates,
    });
  }

  /** Write User Notes via tool action. */
  async setUserNotes(cameraId: string, notes: string): Promise<void> {
    await this.withWriteLock(cameraId, async () => {
      const data = (await this.loadCached(cameraId, { throwOnHydrateError: true })) ?? createDefaultSemanticContext(cameraId);
      data.userNotes = notes;
      await this.persistAndCache(cameraId, data);
    });
  }

  /** Update only the user-provided background subsection within User Notes. */
  async setUserBackground(cameraId: string, background: string): Promise<void> {
    await this.withWriteLock(cameraId, async () => {
      const data = (await this.loadCached(cameraId, { throwOnHydrateError: true })) ?? createDefaultSemanticContext(cameraId);
      const { freeLines, sections } = parseUserNoteSubsections(data.userNotes);
      const text = background.trim();
      if (text) sections.set("Background Context", text.split("\n"));
      else sections.delete("Background Context");
      data.userNotes = serializeUserNoteSubsections(freeLines, sections);
      await this.persistAndCache(cameraId, data);
    });
  }

  /**
   * Merge structured intelligence directives into User Notes.
   * Each directive maps to a named sub-section within User Notes.
   */
  async updateDirectives(cameraId: string, directives: {
    trackStates?: string[];
    trackActivities?: string[];
    explainDecisions?: boolean;
  }): Promise<string[]> {
    const applied: string[] = [];
    await this.withWriteLock(cameraId, async () => {
      const data = (await this.loadCached(cameraId, { throwOnHydrateError: true })) ?? createDefaultSemanticContext(cameraId);

      const { freeLines, sections } = parseUserNoteSubsections(data.userNotes);

      if (directives.trackStates !== undefined) {
        if (directives.trackStates.length > 0) {
          sections.set("Track States", directives.trackStates.map((value) => `- ${value}`));
          applied.push(`track_states: ${directives.trackStates.join(", ")}`);
        } else {
          sections.delete("Track States");
          applied.push("track_states: removed");
        }
      }
      if (directives.trackActivities !== undefined) {
        if (directives.trackActivities.length > 0) {
          sections.set("Track Activities", [directives.trackActivities.join(", ")]);
          applied.push(`track_activities: ${directives.trackActivities.join(", ")}`);
        } else {
          sections.delete("Track Activities");
          applied.push("track_activities: removed");
        }
      }
      if (directives.explainDecisions !== undefined) {
        if (directives.explainDecisions) {
          sections.set("Explain Decisions", ["enabled"]);
          applied.push("explain_decisions: enabled");
        } else {
          sections.delete("Explain Decisions");
          applied.push("explain_decisions: disabled");
        }
      }

      data.userNotes = serializeUserNoteSubsections(freeLines, sections);
      await this.persistAndCache(cameraId, data);
    });
    return applied;
  }

  /** Create or update initial semantic_context scene description. */
  async initProfile(cameraId: string, sceneDescription: string): Promise<void> {
    await this.withWriteLock(cameraId, async () => {
      const data = (await this.loadCached(cameraId, { throwOnHydrateError: true })) ?? createDefaultSemanticContext(cameraId);
      data.sceneDescription = sceneDescription;
      await this.persistAndCache(cameraId, data);
    });
  }

  /** Clear observation buffers, in-flight guards, and memory cache for a camera. */
  clearBuffer(cameraId: string): void {
    this.buffers.delete(cameraId);
    this.entityBuffers.delete(cameraId);
    this.identityBuffers.delete(cameraId);
    this.updateInFlight.delete(cameraId);
    this.consultPending.delete(cameraId);
    this.cache.delete(cameraId);
    this.generations.set(cameraId, (this.generations.get(cameraId) ?? 0) + 1);
  }

  private async withWriteLock(cameraId: string, fn: () => Promise<void>): Promise<void> {
    const previous = this.writeLocks.get(cameraId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current, () => current);
    this.writeLocks.set(cameraId, tail);
    await previous.catch(() => undefined);
    try {
      await fn();
    } finally {
      release();
      if (this.writeLocks.get(cameraId) === tail) {
        this.writeLocks.delete(cameraId);
      }
    }
  }

  private shouldTriggerLlmUpdate(
    data: SemanticContextData | undefined,
    segmentCount: number,
    bufferSize: number,
    identityBufferSize = 0,
  ): boolean {
    if (bufferSize === 0) return false;
    if (identityBufferSize > 0) return true;
    if (!data) return segmentCount >= BOOTSTRAP_THRESHOLD;

    const sinceLastUpdate = segmentCount - data.metadata.last_update_segment_count;
    const isStable = data.metadata.consecutive_no_updates >= CONSECUTIVE_NO_UPDATE_FOR_STABLE;

    if (isStable) {
      const lastUpdateTime = data.metadata.last_llm_update
        ? new Date(data.metadata.last_llm_update).getTime()
        : 0;
      return (Date.now() - lastUpdateTime > STABLE_DAILY_MS) && sinceLastUpdate > 0;
    }

    return sinceLastUpdate >= BOOTSTRAP_THRESHOLD;
  }
}

/** Build the prompt for LLM summarization of semantic_context. The injected LLM provider should return JSON. */
export function buildSummarizationPrompt(currentProfile: string, observations: string[]): string {
  return `You are updating a persistent semantic_context profile for one video source. This profile helps the video understanding pipeline interpret stable context over time.

CURRENT SEMANTIC_CONTEXT:
${currentProfile}

RECENT OBSERVATIONS (newest last):
${observations.map((observation, index) => `${index + 1}. ${observation}`).join("\n")}

INSTRUCTIONS:
- Merge meaningful new observations into the existing profile fields
- Keep ONLY significant, recurring patterns. Drop one-off observations
- Total content across scene_description, known_entities, daily_routine, and anomaly_baseline must be under 500 characters combined
- Use scene_description for stable source format, main content type, camera environment, or recurring view/editing style when repeated observations support it.
- Keep scene_description identity-neutral: do not put person names, entity_ids, per-person roles, or position-to-identity claims there.
- Treat scene_description as background only, not as evidence for target matching or identity correction.
- Use known_entities as a compact cast/entity roster. If recent observations include a named person with entity_id evidence, preserve the name, entity_id, and concise appearance/location cue.
- If a named person has no entity_id, still preserve the name as unresolved_identity with concise appearance/action/dialogue evidence so text retrieval can find it later.
- Treat named identity lines as candidate navigation evidence, not final truth. If the same name maps to multiple entity_ids, keep candidate_entity_ids or conflict wording instead of overwriting silently.
- Do not treat track_id, bbox_id, or speaker_id as durable identity anchors. For unresolved identities, keep segment_ids as the retrieval pointer back to the supporting segment.
- Do not invent names, entity_ids, or appearance details. Do not attach a name to a different target when matched identity evidence is missing.
- Fill a field only when the observations support suitable content for it; use an empty string for fields that have no appropriate content
- For general videos, daily_routine may describe recurring temporal patterns or repeated scene structure; leave it empty if no such pattern is clear
- Leave anomaly_baseline empty unless there is a clear normal baseline that would help detect deviations
- If nothing meaningful changed, set no_update to true and omit other fields
- Be extremely concise — use short phrases, not full sentences

Respond with a JSON object:
{
  "no_update": false,
  "scene_description": "Brief main content or scene overview",
  "known_entities": "- Entity1: description\\n- Entity2: description",
  "daily_routine": "",
  "anomaly_baseline": ""
}

Or if no meaningful changes: { "no_update": true }
Respond with valid JSON only.`;
}

interface NamedIdentityObservation {
  name: string;
  entity_id?: string;
  segment_id?: string;
  track_id?: string;
  speaker_id?: string;
  identity_level?: string;
  appearance?: string;
  evidence?: string;
  source?: SemanticContextIdentityCue["source"];
}

function buildNamedIdentityObservations(
  entities: SemanticContextEntityObservation[],
  identityCues: SemanticContextIdentityCue[],
): NamedIdentityObservation[] {
  const observations: NamedIdentityObservation[] = [];
  for (const cue of identityCues) {
    const name = normalizePersonName(cue.name);
    if (!name) continue;
    const matchedEntity = findIdentityEntity(entities, cue);
    const entityId = cue.entity_id ?? matchedEntity?.entity_id;
    const trackId = cue.track_id ?? matchedEntity?.track_id;
    if (!entityId && !cue.segment_id && !cue.speaker_id) continue;
    observations.push({
      name,
      entity_id: entityId,
      segment_id: cue.segment_id,
      track_id: trackId,
      speaker_id: cue.speaker_id,
      identity_level: cue.identity_level,
      appearance: compactText(matchedEntity?.appearance, 80),
      evidence: compactText(cue.evidence, 80),
      source: cue.source,
    });
  }
  return observations;
}

function findIdentityEntity(
  entities: SemanticContextEntityObservation[],
  cue: SemanticContextIdentityCue,
): SemanticContextEntityObservation | undefined {
  return entities.find((entity) => {
    if (cue.entity_id && entity.entity_id === cue.entity_id) return true;
    if (cue.track_id && entity.track_id === cue.track_id) return true;
    return false;
  });
}

function formatNamedIdentityObservation(identity: NamedIdentityObservation): string {
  const parts = [
    `name=${identity.name}`,
    identity.entity_id ? `entity_id=${identity.entity_id}` : undefined,
    identity.segment_id ? `segment_id=${identity.segment_id}` : undefined,
    identity.entity_id && identity.track_id ? `track_id=${identity.track_id}` : undefined,
    identity.speaker_id ? `speaker_id=${identity.speaker_id}` : undefined,
    identity.appearance ? `appearance=${identity.appearance}` : undefined,
    identity.evidence ? `cue=${identity.evidence}` : undefined,
  ].filter(Boolean);
  return `[named identity: ${parts.join("; ")}]`;
}

function formatEntityAnchor(entity: SemanticContextEntityObservation): string {
  const anchors = [
    entity.entity_id ? ` entity_id=${entity.entity_id}` : "",
    entity.track_id ? ` track_id=${entity.track_id}` : "",
  ].join("");
  return anchors ? ` ${anchors.trim()}` : "";
}

function mergeNamedIdentityKnownEntities(
  existing: string,
  observations: NamedIdentityObservation[],
): { text: string; changed: boolean } {
  const byName = new Map<string, NamedIdentityObservation[]>();
  for (const observation of observations) {
    const list = byName.get(observation.name) ?? [];
    list.push(observation);
    byName.set(observation.name, list);
  }

  const generatedNames = new Set([...byName.keys()].map((name) => name.toLocaleLowerCase()));
  const rawExistingLines = existing
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of rawExistingLines) {
    const parsed = parseKnownEntityIdentityLine(line);
    if (!parsed || !generatedNames.has(parsed.name.toLocaleLowerCase())) continue;
    const list = byName.get(parsed.name) ?? [];
    list.push(parsed);
    byName.set(parsed.name, list);
  }

  const generated = [...byName.entries()].map(([name, items]) => formatKnownEntityLine(name, items));
  const existingLines = rawExistingLines.filter((line) => {
    const match = line.match(/^-\s*([^:]+):/);
    return !match || !generatedNames.has(match[1]!.trim().toLocaleLowerCase());
  });
  const nextLines = [...generated, ...existingLines].slice(0, 8);
  const text = fitKnownEntities(nextLines);
  return { text, changed: text.trim() !== existing.trim() };
}

function mergeKnownEntitiesPreservingAnchoredIdentities(existing: string, incoming: string): string {
  const incomingLines = splitKnownEntityLines(incoming);
  const incomingNames = new Set(
    incomingLines
      .map((line) => line.match(/^-\s*([^:]+):/)?.[1])
      .map(normalizePersonName)
      .filter((name): name is string => Boolean(name))
      .map((name) => name.toLocaleLowerCase()),
  );
  const preserved = splitKnownEntityLines(existing).filter((line) => {
    const parsed = parseKnownEntityIdentityLine(line);
    if (!parsed?.name) return false;
    if (!parsed.entity_id && !parsed.segment_id) return false;
    return !incomingNames.has(parsed.name.toLocaleLowerCase());
  });
  return fitKnownEntities([...preserved, ...incomingLines].slice(0, 8));
}

function splitKnownEntityLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function formatKnownEntityLine(name: string, items: NamedIdentityObservation[]): string {
  const entityIds = uniqueStrings(items.map((item) => item.entity_id)).slice(0, 3);
  const segmentIds = uniqueStrings(items.map((item) => item.segment_id)).slice(0, 3);
  const speakerIds = uniqueStrings(items.map((item) => item.speaker_id)).slice(0, 2);
  const entityBackedItems = items.filter((item) => item.entity_id);
  const appearance = firstNonEmpty((entityBackedItems.length ? entityBackedItems : items).map((item) => item.appearance));
  const evidence = firstNonEmpty((entityBackedItems.length ? entityBackedItems : items).map((item) => item.evidence));
  const identity = entityIds.length === 1
    ? `entity_id=${entityIds[0]}`
    : entityIds.length > 1
      ? `candidate_entity_ids=${entityIds.join("/")}`
      : "unresolved_identity";
  const localHints = entityIds.length === 0
    ? [
        segmentIds.length ? `segment_ids=${segmentIds.join("/")}` : undefined,
        speakerIds.length ? `speaker_ids=${speakerIds.join("/")}` : undefined,
      ]
    : [];
  const details = [identity, ...localHints, appearance, evidence ? `cue=${evidence}` : undefined].filter(Boolean).join("; ");
  return `- ${name}: ${details}`;
}

function parseKnownEntityIdentityLine(line: string): NamedIdentityObservation | undefined {
  const match = line.match(/^-\s*([^:]+):\s*(.*)$/);
  if (!match) return undefined;
  const name = normalizePersonName(match[1]);
  if (!name) return undefined;
  const body = match[2] ?? "";
  const entityMatch = body.match(/\bentity_id=([^;\s]+)/);
  const candidateMatch = body.match(/\bcandidate_entity_ids=([^;]+)/);
  const segmentMatch = body.match(/\bsegment_ids=([^;]+)/);
  const rawAnchors = [
    ...parseAnchorList(candidateMatch?.[1]),
    ...parseAnchorList(entityMatch?.[1]),
  ];
  const entityIds = rawAnchors.filter(isDurableEntityId);
  const segmentIds = [
    ...parseAnchorList(segmentMatch?.[1]),
    ...rawAnchors.filter(isSegmentId),
  ];
  return {
    name,
    entity_id: entityIds[0],
    segment_id: segmentIds[0],
    appearance: compactText(
      body
        .replace(/\b(candidate_entity_ids|entity_id|segment_ids|speaker_ids|speaker_id)=[^;]+;?\s*/g, "")
        .replace(/\bunresolved_identity\b;?\s*/g, ""),
      80,
    ),
    source: "memory",
  };
}

function parseAnchorList(value: string | undefined): string[] {
  return String(value ?? "")
    .replace(/^[\[\(]+|[\]\),.]+$/g, "")
    .split(/[\/,\s]+/)
    .map((item) => item.replace(/^[\[\(]+|[\]\),.]+$/g, "").trim())
    .filter(Boolean);
}

function isDurableEntityId(value: string): boolean {
  return /^entity_[A-Za-z0-9_-]+$/.test(value);
}

function isSegmentId(value: string): boolean {
  return /^seg_[A-Za-z0-9_-]+$/.test(value);
}

function fitKnownEntities(lines: string[]): string {
  const kept: string[] = [];
  let total = 0;
  for (const line of lines) {
    const compactLine = compactText(line, 160);
    if (!compactLine) continue;
    const nextTotal = total + compactLine.length + (kept.length ? 1 : 0);
    if (nextTotal > 420) break;
    kept.push(compactLine);
    total = nextTotal;
  }
  return kept.join("\n");
}

function normalizePersonName(value: string | undefined): string | undefined {
  const name = String(value ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\s*\([^)]*\b(?:entity_|unresolved_identity|segment_id)[^)]*\)\s*/gi, "")
    .trim();
  if (!name) return undefined;
  if (!/[A-Za-z]/.test(name)) return undefined;
  if (/^(robot|assistant|camera|user|person|man|woman)$/i.test(name)) return undefined;
  if (name.length > 40) return undefined;
  return name;
}

function identityKey(identity: NamedIdentityObservation): string {
  return [
    identity.name.toLocaleLowerCase(),
    identity.entity_id ?? "",
    identity.segment_id ?? "",
    identity.track_id ?? "",
    identity.speaker_id ?? "",
  ].join("\t");
}

function compactText(value: string | undefined, max = 120): string | undefined {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trim()}…` : text;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function firstNonEmpty(values: Array<string | undefined>): string | undefined {
  return values.find((value) => Boolean(value));
}

/** Create a fresh SemanticContextData with default template. */
export function createDefaultSemanticContext(cameraId: string): SemanticContextData {
  return {
    cameraId,
    userNotes: "",
    sceneDescription: "",
    knownEntities: "",
    dailyRoutine: "",
    anomalyBaseline: "",
    metadata: {
      last_llm_update: "",
      last_update_segment_count: 0,
      last_agent_consult: "",
      last_consult_segment_count: 0,
      consecutive_no_updates: 0,
    },
  };
}

function cloneSemanticContext(data: SemanticContextData): SemanticContextData {
  return {
    ...data,
    metadata: { ...data.metadata },
  };
}
