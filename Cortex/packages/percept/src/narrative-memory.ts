import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { EntityContext, EventCloseSummary } from "./types.js";
import { sanitizeCameraId } from "./semantic-context.js";
import { writeStderr } from "@cortex/shared";

/**
 * Minimal interface for the Qdrant write path.
 * Matches CortexClient.addEpisodicSchema() without importing @cortex/mem.
 */
export interface EpisodicSchemaWriter {
  addEpisodicSchema(request: {
    summary: string;
    event_ids: string[];
    time_range: { start_ms: number; end_ms: number };
    camera_id: string;
    user_id?: string;
  }): Promise<unknown>;
}

/** Exported for orchestrator/benchmark construction. */
export interface NarrativeMemoryConfig {
  baseDir: string;
  /** @deprecated Append-only chapters rotate by eventsPerChapter, not character count. */
  rotationThreshold?: number;
  /** @deprecated Kept for compatibility; index entries are append-only. */
  indexMaxEntries?: number;
  /** @deprecated onContextCompressed is no longer ingested. */
  updateBufferSize?: number;
  /** Number of closed events per narrative chapter. Defaults to 20. */
  eventsPerChapter?: number;
  /** Qdrant client for writing episodic schema entries. */
  memClient: EpisodicSchemaWriter;
  /** User ID propagated to Qdrant writes. */
  userId: string;
  /** Number of closed events that trigger a schema flush. Defaults to 5. */
  schemaEventBudget?: number;
  /** Max event-time interval (ms) before forcing a schema flush. Defaults to 3_600_000 (1 hour). Uses EVENT timestamps, not wall clock. */
  schemaMaxIntervalMs?: number;
  llm: (prompt: string, options?: {
    maxTokens?: number;
    temperature?: number;
    reasoningEffort?: "minimal" | "low" | "medium" | "high";
    stage?: string;
    promptVersion?: string;
    llmContext?: import("@cortex/shared").LlmCallContext;
  }) => Promise<string>;
}

export interface NarrativeFlushOptions {
  /** When true, indexes the latest chapter even if it has fewer than eventsPerChapter events. */
  finalize?: boolean;
}

interface ClosedNarrativeEvent {
  event_id: string;
  event_summary: string;
  time_range: { start_ms: number; end_ms: number };
  segment_count: number;
  segment_ids: string[];
  entities: Array<{ key: string; context: EntityContext }>;
}

interface NarrativeState {
  pending: Promise<void>;
  generation: number;
}

function normalizeMs(value: number | undefined, fallback = 0): number {
  return Number.isFinite(value) ? Math.round(value!) : fallback;
}

export class NarrativeMemory {
  private states = new Map<string, NarrativeState>();
  private config: Required<Omit<NarrativeMemoryConfig, "llm">> & { llm: NarrativeMemoryConfig["llm"] };
  /** In-memory cache of latest chapter content per camera. */
  private narrativeCache = new Map<string, string>();
  /** In-memory cache of index.md content per camera. */
  private indexCache = new Map<string, string>();
  /** Pending closed events per camera, flushed to Qdrant when budget is met. */
  private pendingEvents = new Map<string, EventCloseSummary[]>();

  constructor(config: NarrativeMemoryConfig) {
    this.config = {
      baseDir: config.baseDir,
      rotationThreshold: config.rotationThreshold ?? 6000,
      indexMaxEntries: config.indexMaxEntries ?? 20,
      updateBufferSize: config.updateBufferSize ?? 3,
      eventsPerChapter: config.eventsPerChapter ?? 20,
      memClient: config.memClient,
      userId: config.userId,
      schemaEventBudget: config.schemaEventBudget ?? 5,
      schemaMaxIntervalMs: config.schemaMaxIntervalMs ?? 3_600_000,
      llm: config.llm,
    };
  }

  // --- Input methods (from WorkingMemory callbacks) ---

  onContextCompressed(_cameraId: string, _compressed: string, _entitySnapshot?: Array<{ key: string; context: EntityContext }>): void {
    // Compatibility no-op. WorkingMemory no longer performs LLM compression;
    // VLM maintains event_summary and NarrativeMemory ingests only closed events.
  }

  onEventClosed(cameraId: string, summary: EventCloseSummary): void {
    if (!this.toClosedEvent(summary)) return;
    const state = this.getState(cameraId);
    // Local markdown narrative chapters are disabled; retrieval/Agent-QA now uses
    // episodic_schema written to mem/Qdrant.

    // Accumulate closed events for Qdrant episodic schema write.
    // Budget check uses EVENT timestamps (not wall clock) for offline/benchmark correctness.
    const pending = this.pendingEvents.get(cameraId) ?? [];
    pending.push(summary);
    this.pendingEvents.set(cameraId, pending);

    const startMs = pending[0]!.time_range.start_ms;
    const endMs = pending[pending.length - 1]!.time_range.end_ms;
    const elapsed = endMs - startMs;
    const budget = this.config.schemaEventBudget;
    const maxInterval = this.config.schemaMaxIntervalMs;

    if (pending.length >= budget || elapsed >= maxInterval) {
      // Chain schema flush onto the state's pending promise to maintain ordering.
      state.pending = state.pending
        .catch(() => undefined)
        .then(() => this.flushSchema(cameraId));
    }
  }

  // --- Qdrant schema flush ---

  /**
   * Summarize pending events via LLM and write an episodic_schema entry to Qdrant.
   * On LLM failure the pending events are preserved for the next flush attempt.
   */
  private async flushSchema(cameraId: string): Promise<void> {
    const allPending = this.pendingEvents.get(cameraId) ?? [];
    if (!allPending.length) return;

    // Snapshot the current batch — new events arriving during LLM await stay in the array.
    const batch = allPending.slice();

    const eventsText = batch
      .map(
        (e) =>
          `[${new Date(e.time_range.start_ms).toISOString()} - ${new Date(e.time_range.end_ms).toISOString()}] ${e.event_summary ?? e.compressed_context ?? "no summary"}`,
      )
      .join("\n");

    let summary: string;
    try {
      summary = await this.config.llm(
        `Summarize this sequence of events into a cohesive natural-language navigation paragraph (max 200 words).

This episodic_schema is a chapter-level navigation index; detailed evidence remains in the segment/event records. Preserve anchors that help later drill down: proper names, places, short visible labels/OCR, exact numbers/scores/timers/rankings, explicit outcomes, comparisons, negations, and distinct repeated events when present. Do not invent counts; keep same-event continuations clear.

Events:
${eventsText}`,
        {
          stage: "narrative.schema_summary",
          llmContext: { camera_id: cameraId },
        },
      );
    } catch {
      // LLM failure: keep pending events so the next trigger retries.
      return;
    }

    const timeRange = {
      start_ms: normalizeMs(batch[0]!.time_range.start_ms),
      end_ms: normalizeMs(batch[batch.length - 1]!.time_range.end_ms, normalizeMs(batch[0]!.time_range.start_ms)),
    };
    const eventIds = batch.map((e) => e.event_id);

    await this.config.memClient.addEpisodicSchema({
      summary,
      event_ids: eventIds,
      time_range: timeRange,
      camera_id: cameraId,
      user_id: this.config.userId,
    });

    // Remove only the batch items; events that arrived during the LLM await are preserved.
    const remaining = this.pendingEvents.get(cameraId) ?? [];
    this.pendingEvents.set(cameraId, remaining.slice(batch.length));
  }

  // --- Output methods ---

  getNarrative(cameraId: string): string {
    if (this.narrativeCache.has(cameraId)) return this.narrativeCache.get(cameraId)!;
    const latest = this.latestChapterPath(cameraId);
    if (latest && existsSync(latest)) {
      const content = readFileSync(latest, "utf-8");
      this.narrativeCache.set(cameraId, content);
      return content;
    }
    const current = this.currentPath(cameraId);
    if (existsSync(current)) {
      const content = readFileSync(current, "utf-8");
      this.narrativeCache.set(cameraId, content);
      return content;
    }
    return "";
  }

  getIndex(cameraId: string): string {
    if (this.indexCache.has(cameraId)) return this.indexCache.get(cameraId)!;
    const path = this.indexPath(cameraId);
    if (existsSync(path)) {
      const content = readFileSync(path, "utf-8");
      this.indexCache.set(cameraId, content);
      return content;
    }
    return "";
  }

  getArchive(cameraId: string): string {
    const chaptersDir = this.chaptersDir(cameraId);
    if (!existsSync(chaptersDir)) return "";
    const files = readdirSync(chaptersDir)
      .filter(f => f.endsWith(".md"))
      .sort();
    const chapters: string[] = [];
    for (const file of files) {
      const path = join(chaptersDir, file);
      try {
        const content = readFileSync(path, "utf-8").trim();
        if (content) chapters.push(`## Archive Chapter: ${file.replace(/\.md$/, "")}\n\n${content}`);
      } catch {
        // Ignore concurrently written chapter files; next read will pick them up.
      }
    }
    return chapters.join("\n\n---\n\n");
  }

  getEventSeedContext(cameraId: string): string {
    const idx = this.getIndex(cameraId);
    if (!idx) return "";
    const lines = idx.split("\n").filter(l => l.startsWith("- "));
    return lines[lines.length - 1] ?? "";
  }

  async flush(cameraId: string, options: NarrativeFlushOptions = {}): Promise<void> {
    const state = this.states.get(cameraId);
    if (!state) return;
    if (options.finalize) {
      // Flush any incomplete schema batch to Qdrant on finalize (watch stop).
      state.pending = state.pending.then(() => this.flushSchema(cameraId));
    }
    await state.pending;
  }

  /** Clear in-memory state. Disk narrative is persistent and intentionally preserved. */
  clear(cameraId: string): void {
    const state = this.states.get(cameraId);
    if (state) {
      state.generation++;
      state.pending = Promise.resolve();
    }
    this.states.delete(cameraId);
    this.narrativeCache.delete(cameraId);
    this.indexCache.delete(cameraId);
    this.pendingEvents.delete(cameraId);
  }

  // --- Core logic ---

  private async appendClosedEvent(cameraId: string, event: ClosedNarrativeEvent, capturedState: NarrativeState, gen: number): Promise<void> {
    try {
      if (this.isStale(cameraId, capturedState, gen)) return;
      const dir = this.cameraDir(cameraId);
      const chaptersDir = this.chaptersDir(cameraId);
      await mkdir(chaptersDir, { recursive: true });
      if (this.isStale(cameraId, capturedState, gen)) return;

      await this.ensureIndexFile(cameraId);
      if (this.isStale(cameraId, capturedState, gen)) return;

      const existingEvents = await this.readEvents(cameraId);
      const eventIndex = existingEvents.length;
      const chapterNo = Math.floor(eventIndex / this.config.eventsPerChapter) + 1;
      const positionInChapter = eventIndex % this.config.eventsPerChapter;
      const chapterPath = this.chapterPath(cameraId, chapterNo);

      if (positionInChapter === 0 || !existsSync(chapterPath)) {
        await writeFile(chapterPath, `# Narrative Chapter ${chapterNo.toString().padStart(4, "0")}\n\n`, "utf-8");
      }
      if (this.isStale(cameraId, capturedState, gen)) return;

      await appendFile(chapterPath, `${this.formatEventLine(event)}\n`, "utf-8");
      await appendFile(this.eventsPath(cameraId), `${JSON.stringify(event)}\n`, "utf-8");
      if (this.isStale(cameraId, capturedState, gen)) return;

      const chapterContent = await readFile(chapterPath, "utf-8");
      await writeFile(this.currentPath(cameraId), chapterContent, "utf-8");
      this.narrativeCache.set(cameraId, chapterContent);

      if (positionInChapter + 1 >= this.config.eventsPerChapter) {
        const priorChapterEvents = positionInChapter === 0 ? [] : existingEvents.slice(-positionInChapter);
        const chapterEvents = [...priorChapterEvents, event];
        await this.appendIndexEntry(cameraId, chapterNo, chapterContent, chapterEvents, capturedState, gen);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      writeStderr(`[narrative-memory] append failed for ${cameraId}: ${reason}`);
      throw err;
    }
  }

  private async appendIndexEntry(
    cameraId: string,
    chapterNo: number,
    chapterContent: string,
    events: ClosedNarrativeEvent[],
    capturedState: NarrativeState,
    gen: number,
  ): Promise<void> {
    if (events.length === 0) return;
    const startMs = events[0]?.time_range.start_ms ?? 0;
    const endMs = events[events.length - 1]?.time_range.end_ms ?? startMs;
    const timeRange = this.formatTimeRange({ start_ms: startMs, end_ms: endMs });
    const chapterName = `chapter-${chapterNo.toString().padStart(4, "0")}.md`;
    const existingIndex = this.getIndex(cameraId);
    if (existingIndex.includes(chapterName)) return;

    const prompt = `Summarize this narrative chapter into one concise Chinese or English navigation line, max 40 words. Preserve the main activity plus key anchors: important names/entities, places, short labels/text, exact numbers/scores/timers, and outcome. Do not include markdown bullets.\n\nTime range: ${timeRange}\nChapter file: ${chapterName}\n\n${chapterContent}`;

    let rawSummary: string;
    try {
      rawSummary = await this.config.llm(prompt, {
        stage: "narrative.chapter_summary",
        llmContext: { camera_id: cameraId },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      writeStderr(`[narrative-memory] chapter summary failed for ${cameraId} ${chapterName}; using fallback index summary: ${reason}`);
      rawSummary = this.fallbackChapterSummary(events);
    }
    if (this.isStale(cameraId, capturedState, gen)) return;

    const summary = this.normalizeOneLine(rawSummary).replace(/^-\s*/, "") || "No summary available";
    const line = `- [${timeRange}] ${chapterName}: ${summary}`;
    const newIndex = existingIndex.trim()
      ? `${existingIndex.trim()}\n${line}\n`
      : `# Narrative Index\n\n${line}\n`;
    await writeFile(this.indexPath(cameraId), newIndex, "utf-8");
    this.indexCache.set(cameraId, newIndex);
  }

  // --- Helpers ---

  private async finalizeLatestChapter(cameraId: string, capturedState: NarrativeState, gen: number): Promise<void> {
    if (this.isStale(cameraId, capturedState, gen)) return;
    const events = await this.readEvents(cameraId);
    if (events.length === 0) return;

    const lastEventIndex = events.length - 1;
    const chapterNo = Math.floor(lastEventIndex / this.config.eventsPerChapter) + 1;
    const firstEventIndex = Math.floor(lastEventIndex / this.config.eventsPerChapter) * this.config.eventsPerChapter;
    const chapterEvents = events.slice(firstEventIndex);
    const chapterPath = this.chapterPath(cameraId, chapterNo);
    if (!existsSync(chapterPath)) return;

    await this.ensureIndexFile(cameraId);
    if (this.isStale(cameraId, capturedState, gen)) return;

    const chapterContent = await readFile(chapterPath, "utf-8");
    await this.appendIndexEntry(cameraId, chapterNo, chapterContent, chapterEvents, capturedState, gen);
  }

  private getState(cameraId: string): NarrativeState {
    if (!this.states.has(cameraId)) {
      this.states.set(cameraId, {
        pending: Promise.resolve(),
        generation: 0,
      });
    }
    return this.states.get(cameraId)!;
  }

  private isStale(cameraId: string, capturedState: NarrativeState, gen: number): boolean {
    return !this.states.has(cameraId)
      || this.states.get(cameraId) !== capturedState
      || capturedState.generation !== gen;
  }

  private toClosedEvent(summary: EventCloseSummary): ClosedNarrativeEvent | null {
    const eventSummary = this.truncateWords(
      this.normalizeOneLine(summary.event_summary || summary.compressed_context),
      100,
    );
    if (!eventSummary) return null;
    return {
      event_id: summary.event_id,
      event_summary: eventSummary,
      time_range: summary.time_range,
      segment_count: summary.segment_count,
      segment_ids: [...summary.segment_ids],
      entities: summary.entities.map(e => ({ key: e.key, context: { ...e.context } })),
    };
  }

  private fallbackChapterSummary(events: ClosedNarrativeEvent[]): string {
    const text = events
      .map(event => this.normalizeOneLine(event.event_summary))
      .filter(Boolean)
      .join(" ");
    return this.truncateWords(text, 40) || "Chapter summary unavailable";
  }

  private formatEventLine(event: ClosedNarrativeEvent): string {
    return `- [${this.formatTimeRange(event.time_range)}] ${event.event_summary}`;
  }

  private async readEvents(cameraId: string): Promise<ClosedNarrativeEvent[]> {
    const path = this.eventsPath(cameraId);
    if (!existsSync(path)) return [];
    const content = await readFile(path, "utf-8");
    return content.split("\n")
      .map(line => line.trim())
      .filter(Boolean)
      .flatMap(line => {
        try {
          return [JSON.parse(line) as ClosedNarrativeEvent];
        } catch {
          return [];
        }
      });
  }

  private latestChapterPath(cameraId: string): string | null {
    const chaptersDir = this.chaptersDir(cameraId);
    if (!existsSync(chaptersDir)) return null;
    const files = readdirSync(chaptersDir)
      .filter(f => f.endsWith(".md"))
      .sort();
    const latest = files[files.length - 1];
    return latest ? join(chaptersDir, latest) : null;
  }

  private async ensureIndexFile(cameraId: string): Promise<void> {
    const path = this.indexPath(cameraId);
    if (existsSync(path)) {
      if (!this.indexCache.has(cameraId)) {
        this.indexCache.set(cameraId, readFileSync(path, "utf-8"));
      }
      return;
    }
    const initial = "# Narrative Index\n\n";
    try {
      await writeFile(path, initial, { encoding: "utf-8", flag: "wx" });
      this.indexCache.set(cameraId, initial);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }

  private cameraDir(cameraId: string): string {
    return join(this.config.baseDir, sanitizeCameraId(cameraId));
  }

  private chaptersDir(cameraId: string): string {
    return join(this.cameraDir(cameraId), "chapters");
  }

  private chapterPath(cameraId: string, chapterNo: number): string {
    return join(this.chaptersDir(cameraId), `chapter-${chapterNo.toString().padStart(4, "0")}.md`);
  }

  private currentPath(cameraId: string): string {
    return join(this.cameraDir(cameraId), "current.md");
  }

  private indexPath(cameraId: string): string {
    return join(this.cameraDir(cameraId), "index.md");
  }

  private eventsPath(cameraId: string): string {
    return join(this.cameraDir(cameraId), "events.jsonl");
  }

  private normalizeOneLine(text: string): string {
    return text.replace(/\s+/g, " ").trim();
  }

  private truncateWords(text: string, maxWords: number): string {
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length <= maxWords) return text;
    return words.slice(0, maxWords).join(" ");
  }

  private formatTimeRange(range: { start_ms: number; end_ms: number }): string {
    const isEpoch = range.start_ms > 1e12;
    const fmt = (ms: number) => {
      if (isEpoch) {
        const d = new Date(ms);
        return [d.getHours(), d.getMinutes(), d.getSeconds()]
          .map(v => v.toString().padStart(2, "0"))
          .join(":");
      }
      const total = Math.max(0, Math.floor(ms / 1000));
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      return [h, m, s].map(v => v.toString().padStart(2, "0")).join(":");
    };
    return `${fmt(range.start_ms)} - ${fmt(range.end_ms)}`;
  }
}
