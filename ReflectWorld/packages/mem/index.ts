// packages/mem/index.ts
import { CortexClient } from "./src/client.js";
import { parseMemoryConfig, type MemoryConfig } from "./src/config.js";
import { monitorBus } from "@cortex/shared";
import type {
  CaptureMode,
  MemoryType,
  SearchMemoryType,
  GetMemoryType,
  WriteMemoryType,
} from "./src/types.js";
import type {
  SearchAction,
  GetAction,
  DeleteAction,
  AddNoteAction,
  GetHistoryAction,
  SetIdentityAction,
  GetNarrativeAction,
} from "./src/schema.js";
import { CortexMemoryToolSchema } from "./src/schema.js";
import { flattenMemoriesResponse } from "./src/types.js";

interface ArchiveChapter {
  title: string;
  content: string;
}

const DEFAULT_ARCHIVE_CHAPTER_LIMIT = 5;
const MAX_ARCHIVE_CHAPTER_LIMIT = 8;
const MAX_ARCHIVE_CHARS_PER_CHAPTER = 3500;
const ARCHIVE_STOP_WORDS = new Set([
  "about", "after", "again", "also", "another", "because", "before", "between",
  "could", "following", "their", "there", "these", "thing", "those", "video",
  "which", "while", "would",
]);
// All valid collection names + group aliases for the new taxonomy.
const SEARCH_MEMORY_TYPES = new Set<string>([
  "episodic_trace", "episodic_entity", "episodic_schema",
  "semantic_entity", "semantic_context", "procedural",
  "episodic", "semantic", "all",
]);

const GET_MEMORY_TYPES = new Set<string>([
  ...SEARCH_MEMORY_TYPES,
  "episodic_visual",
]);

const ALL_MEMORY_TYPES = new Set<string>([...GET_MEMORY_TYPES]);

const WRITE_MEMORY_TYPES = new Set<string>([
  "semantic_entity", "procedural",
]);

function asSearchMemoryType(value: string | undefined): SearchMemoryType | undefined {
  if (value === undefined) return undefined;
  if (SEARCH_MEMORY_TYPES.has(value)) return value as SearchMemoryType;
  throw new Error(`Invalid memory_type for search: ${value}`);
}

function asGetMemoryType(value: string | undefined): GetMemoryType | undefined {
  if (value === undefined) return undefined;
  if (GET_MEMORY_TYPES.has(value)) return value as GetMemoryType;
  throw new Error(`Invalid memory_type for get: ${value}`);
}

function asWriteMemoryType(value: string | undefined): WriteMemoryType | undefined {
  if (value === undefined) return undefined;
  if (WRITE_MEMORY_TYPES.has(value)) return value as WriteMemoryType;
  throw new Error(`Invalid memory_type for write: ${value}`);
}

function asMemoryType(value: string | undefined): MemoryType | undefined {
  if (value === undefined) return undefined;
  if (ALL_MEMORY_TYPES.has(value)) return value as MemoryType;
  throw new Error(`Invalid memory_type: ${value}`);
}

export { CortexClient, type MemoryConfig };
export type {
  AddMemoryRequest,
  AddMemoryResponse,
  AddSchemaRequest,
  UpsertContextRequest,
  SearchRequest,
  SearchResponse,
  SearchResultItem,
  GetMemoriesRequest,
  GetMemoriesResponse,
  MemoryItem,
  DeleteMemoriesRequest,
  DeleteMemoryByIdRequest,
  DeleteMemoryResponse,
  ExpireMediaRequest,
  ExpireMediaResponse,
  ReidSearchRequest,
  ReidSearchResponse,
  ReidUpsertRequest,
  ReidUpsertResponse,
  ReidGalleryUpdateRequest,
  ReidGalleryUpdateResponse,
  BatchInitVectorEntry,
  BatchInitRequest,
  BatchInitResponse,
  HealthResponse,
  StatusResponse,
  CaptureMode,
  SemanticMode,
  MemoryType,
  TextCollection,
  VisualCollection,
  MemoryCollection,
  MemoryGroup,
  SearchMemoryType,
  GetMemoryType,
  WriteMemoryType,
  ReidCollection,
} from "./src/types.js";
export { flattenSearchResults, flattenMemoriesResponse } from "./src/types.js";
export { parseMemoryConfig };

/**
 * OpenClaw plugin definition for @cortex/mem.
 *
 * Usage:
 *   import memoryPlugin from "@cortex/mem";
 *   openclaw.register(memoryPlugin, { baseUrl: "http://cortex:8219" });
 */
const memoryPlugin = {
  id: "cortex-mem",
  name: "Cortex Memory",
  description:
    "Search and manage Cortex video memories — episodic, semantic, and procedural.",

  register(api: { registerTool: (tool: any) => void; pluginConfig?: Record<string, unknown> }) {
    const config = parseMemoryConfig(api.pluginConfig ?? {});
    const client = new CortexClient({
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
    });

    api.registerTool({
      name: "cortex_memory",
      description: `Query and manage semantic context (Cortex). You MUST call this tool to recall past events — never guess or make up memories.

Actions:
- search: Semantic search for past events. Requires: query (English), camera_id. Best for "what happened" questions.
- get: List memories by filter (camera_id, user_id, entity_id, or memory_id for a single record). Returns raw memory records.
- delete: Remove memories by filter (camera_id, user_id, entity_id) or by memory_id for a single record. Use with caution.
- add_note: Store a manual observation or user rule. Requires: note, camera_id. Set memory_type="procedural" for user notification rules/preferences (e.g. "alert me when animals appear", "notify me if someone enters"). Default is episodic.
- get_history: Get episodic event timeline for a camera. Requires: camera_id. Use position="earliest" for the start of a video/session, or position="latest" for recent memories.
- set_identity: Label a detected entity with a name and status. Requires: entity_id, identity (description), status (familiar/unfamiliar/admin). Example: user says "that person is my neighbor Alex" → set_identity with entity_id from recent detection, identity="neighbor Alex", status="familiar". Identity memories are protected from automatic LLM changes.
- get_narrative: Get current narrative, scene index, and selected archived narrative chapters for a camera. Requires: camera_id. Pass query to select relevant older chapters; limit controls chapter count.

IMPORTANT: When user asks about past camera events, you MUST call this tool — never fabricate memories.
IMPORTANT: When user sets a notification rule or preference (e.g. "tell me when X happens"), store it as a procedural memory using add_note with memory_type="procedural" and camera_id="global" (or a specific camera). Do NOT use cortex_perception configure for this.
IMPORTANT: When user identifies someone ("that's my neighbor", "that car is mine"), use set_identity to label the entity.`,
      parameters: CortexMemoryToolSchema,

      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const input = params as unknown as SearchAction | GetAction | DeleteAction | AddNoteAction | GetHistoryAction | SetIdentityAction | GetNarrativeAction;
        let result: unknown;
        switch (input.action) {
          case "search": {
            const req = input as SearchAction;
            result = await client.search({
              query: req.query,
              user_id: req.user_id ?? config.defaultUserId,
              camera_id: req.camera_id ?? config.defaultCameraId,
              mode: req.mode as CaptureMode | undefined,
              memory_type: asSearchMemoryType(req.memory_type ?? config.defaultSearchMemoryType),
              limit: req.limit ?? config.defaultSearchLimit,
              threshold: req.threshold,
            });
            break;
          }

          case "get": {
            const req = input as GetAction;
            result = await client.getMemories({
              user_id: req.user_id ?? config.defaultUserId,
              agent_id: req.agent_id,
              entity_id: req.entity_id,
              camera_id: req.camera_id ?? config.defaultCameraId,
              memory_type: asGetMemoryType(req.memory_type),
              limit: req.limit ?? config.defaultSearchLimit,
            });
            break;
          }

          case "delete": {
            const req = input as DeleteAction;
            if (req.memory_id) {
              result = await client.deleteMemoryById({
                memory_id: req.memory_id,
                memory_type: asMemoryType(req.memory_type),
              });
              break;
            }
            result = await client.deleteMemories({
              user_id: req.user_id ?? config.defaultUserId,
              agent_id: req.agent_id,
              entity_id: req.entity_id,
              camera_id: req.camera_id,
              memory_type: asMemoryType(req.memory_type),
            });
            break;
          }

          case "add_note": {
            const req = input as AddNoteAction;
            const isProcedural = req.memory_type === "procedural";
            result = await client.add({
              // Procedural memories use messages; episodic uses video_data
              ...(isProcedural
                ? { messages: req.note }
                : { video_data: { summary: req.note } }),
              camera_id: req.camera_id ?? config.defaultCameraId,
              user_id: req.user_id ?? config.defaultUserId,
              agent_id: req.agent_id,
              memory_type: asWriteMemoryType(req.memory_type),
              mode: req.mode as CaptureMode | undefined,
              infer: false,
            });
            monitorBus.publish("memory:memory_added", {
              camera_id: req.camera_id ?? config.defaultCameraId,
              memory_type: req.memory_type ?? "procedural",
              summary_preview: req.note.slice(0, 100),
            }, req.camera_id ?? "global");
            break;
          }

          case "get_history": {
            const req = input as GetHistoryAction;
            result = await client.getMemories({
              camera_id: req.camera_id,
              user_id: req.user_id ?? config.defaultUserId,
              entity_id: req.entity_id,
              memory_type: "episodic_trace",
              limit: req.limit ?? config.defaultSearchLimit,
              sort_order: req.position === "earliest" ? "asc" : "desc",
            });
            break;
          }

          case "set_identity": {
            const req = input as SetIdentityAction;
            result = await client.setIdentity({
              entity_id: req.entity_id,
              identity: req.identity,
              status: req.status ?? "familiar",
              user_id: req.user_id ?? config.defaultUserId,
              camera_id: req.camera_id ?? config.defaultCameraId,
            });
            monitorBus.publish("memory:identity_set", {
              entity_id: req.entity_id,
              identity: req.identity,
              status: req.status ?? "familiar",
              user_id: req.user_id ?? config.defaultUserId,
              camera_id: req.camera_id ?? config.defaultCameraId,
            }, req.camera_id ?? config.defaultCameraId ?? "global");
            break;
          }

          case "get_narrative": {
            const req = input as GetNarrativeAction;
            const cameraId = req.camera_id ?? config.defaultCameraId;
            if (!cameraId) {
              result = { error: "camera_id required for get_narrative" };
              break;
            }
            const userId = req.user_id ?? config.defaultUserId;

            try {
              // Read from Qdrant collections (single source of truth)
              // Timeline = episodic_schema entries sorted by time (chapter summaries)
              const timelineRaw = await client.getMemories({
                memory_type: "episodic_schema" as any,
                camera_id: cameraId,
                ...(userId ? { user_id: userId } : {}),
                sort_order: "asc",
                limit: 100,
              });
              const timeline = flattenMemoriesResponse(timelineRaw);

              // Recent = latest episodic_trace entries
              const recentRaw = await client.getMemories({
                memory_type: "episodic_trace" as any,
                camera_id: cameraId,
                ...(userId ? { user_id: userId } : {}),
                sort_order: "desc",
                limit: 5,
              });
              const recent = flattenMemoriesResponse(recentRaw);

              // Format timeline as archive chapters (legacy output shape).
              const archive = timeline.map((item) => {
                const title = (item.metadata?.title as string) ?? `Chapter ${item.id.slice(0, 8)}`;
                return `## Archive Chapter: ${title}\n\n${item.memory}`;
              }).join("\n\n---\n\n");

              const selectedArchive = selectArchiveChapters(archive, req.query, req.limit);

              result = {
                timeline: timeline.map((item) => ({
                  id: item.id,
                  memory: item.memory,
                  created_at: item.created_at,
                  metadata: item.metadata,
                })),
                recent: recent.map((item) => ({
                  id: item.id,
                  memory: item.memory,
                  created_at: item.created_at,
                  metadata: item.metadata,
                })),
                archive: selectedArchive.text,
                archive_chapter_count: selectedArchive.selectedCount,
                archive_total_chapters: selectedArchive.totalCount,
                archive_truncated: selectedArchive.totalCount > selectedArchive.selectedCount,
                query: req.query,
                source: "qdrant",
              };
            } catch (err) {
              result = {
                timeline: [],
                recent: [],
                archive: "",
                archive_chapter_count: 0,
                archive_total_chapters: 0,
                archive_truncated: false,
                query: req.query,
                source: "qdrant",
                error: err instanceof Error ? err.message : "narrative unavailable",
              };
            }
            break;
          }

          default: {
            throw new Error(`Unknown cortex_memory action: ${JSON.stringify((input as any).action)}`);
          }
        }

        const eventCameraId = extractCameraId(input, config.defaultCameraId);
        monitorBus.publish("system:tool_invoked", {
          tool: "cortex_memory",
          action: input.action,
          success: true,
          camera_id: eventCameraId,
        }, eventCameraId);
        return result;
      },
    });
  },
};

export default memoryPlugin;

function extractCameraId(
  input: SearchAction | GetAction | DeleteAction | AddNoteAction | GetHistoryAction | SetIdentityAction | GetNarrativeAction,
  defaultCameraId?: string,
): string | undefined {
  switch (input.action) {
    case "search":
    case "get":
    case "delete":
    case "add_note":
    case "get_history":
    case "set_identity":
    case "get_narrative":
      return input.camera_id ?? defaultCameraId;
    default:
      return defaultCameraId;
  }
}

function selectArchiveChapters(
  archive: string,
  query?: string,
  requestedLimit?: number,
): { text: string; selectedCount: number; totalCount: number } {
  const chapters = splitArchiveChapters(archive);
  if (chapters.length === 0) return { text: "", selectedCount: 0, totalCount: 0 };

  const limit = Math.min(
    Math.max(requestedLimit ?? DEFAULT_ARCHIVE_CHAPTER_LIMIT, 1),
    MAX_ARCHIVE_CHAPTER_LIMIT,
  );
  const queryText = query?.trim() ?? "";

  let selected: ArchiveChapter[];
  if (!queryText) {
    selected = chapters.slice(-limit);
  } else {
    selected = selectRelevantArchiveChapters(chapters, queryText, limit);
  }

  return {
    text: formatArchiveChapters(selected),
    selectedCount: selected.length,
    totalCount: chapters.length,
  };
}

function splitArchiveChapters(archive: string): ArchiveChapter[] {
  if (!archive.trim()) return [];
  return archive
    .split(/\n(?=## Archive Chapter: )/g)
    .map((part, idx) => {
      const trimmed = part.trim();
      if (!trimmed) return null;
      const [firstLine = "", ...rest] = trimmed.split("\n");
      const hasTitle = firstLine.startsWith("## Archive Chapter: ");
      const title = hasTitle
        ? firstLine.replace("## Archive Chapter: ", "").trim()
        : `archive_${idx + 1}`;
      const content = hasTitle ? rest.join("\n").trim() : trimmed;
      return content ? { title, content } : null;
    })
    .filter((chapter): chapter is ArchiveChapter => chapter !== null);
}

function selectRelevantArchiveChapters(
  chapters: ArchiveChapter[],
  query: string,
  limit: number,
): ArchiveChapter[] {
  const keywords = extractArchiveKeywords(query);
  const isTemporal = /\b(first|beginning|initial|difference|different|before|after|later|final|last|end|hidden|covered|concealed|beneath|process)\b/i.test(query);
  const selected = new Map<number, ArchiveChapter>();

  if (isTemporal) {
    selected.set(0, chapters[0]!);
    selected.set(chapters.length - 1, chapters[chapters.length - 1]!);
  }

  const scored = chapters
    .map((chapter, index) => {
      const text = normalizeArchiveText(`${chapter.title}\n${chapter.content}`);
      const score = keywords.reduce((sum, keyword) => sum + countArchiveOccurrences(text, keyword), 0);
      return { chapter, index, score };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);

  for (const item of scored) {
    if (item.score <= 0) break;
    selected.set(item.index, item.chapter);
    if (selected.size >= limit) break;
  }

  if (selected.size === 0) {
    selected.set(chapters.length - 1, chapters[chapters.length - 1]!);
  }

  return [...selected.entries()]
    .sort(([a], [b]) => a - b)
    .slice(0, limit)
    .map(([, chapter]) => chapter);
}

function formatArchiveChapters(chapters: ArchiveChapter[]): string {
  return chapters
    .map(chapter => `## Archive Chapter: ${chapter.title}\n\n${chapter.content.slice(0, MAX_ARCHIVE_CHARS_PER_CHAPTER)}`)
    .join("\n\n---\n\n");
}

function normalizeArchiveText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function extractArchiveKeywords(text: string): string[] {
  const seen = new Set<string>();
  for (const token of normalizeArchiveText(text).split(/\s+/)) {
    if (token.length < 4 || ARCHIVE_STOP_WORDS.has(token)) continue;
    seen.add(token);
  }
  return [...seen];
}

function countArchiveOccurrences(text: string, token: string): number {
  if (!token) return 0;
  let count = 0;
  let pos = text.indexOf(token);
  while (pos !== -1) {
    count++;
    pos = text.indexOf(token, pos + token.length);
  }
  return count;
}
