// packages/mem/src/schema.ts
import { Type, type Static } from "@sinclair/typebox";

/**
 * Flat object schema for cortex_memory tool.
 * OpenClaw does not support anyOf/oneOf/allOf in tool schemas.
 */
export const CortexMemoryToolSchema = Type.Object({
  action: Type.Unsafe<string>(
    Type.String({
      description: "Action to perform: search, get, delete, add_note, get_history, set_identity, get_narrative",
      enum: ["search", "get", "delete", "add_note", "get_history", "set_identity", "get_narrative"],
    }),
  ),
  query: Type.Optional(
    Type.String({
      description: "Natural language query in English. Required for action=search. Optional for action=get_narrative to select relevant archived chapters.",
    }),
  ),
  camera_id: Type.Optional(
    Type.String({
      description: "The camera source name to query. Use the exact name from cortex_cam list_sources (e.g. 'my phone camera'). Required for all actions — Cortex rejects requests without camera_id.",
    }),
  ),
  mode: Type.Optional(
    Type.Unsafe<string>(
      Type.String({
        description: "Filter by capture mode. Omit to search all modes.",
        enum: ["snapshot", "event", "stream"],
      }),
    ),
  ),
  memory_type: Type.Optional(
    Type.String({
      description:
        "Which memory to search. " +
        "episodic_trace=segment summaries (default), " +
        "episodic_entity=per-entity observations, " +
        "episodic_schema=chapter summaries, " +
        "semantic_entity=entity knowledge, " +
        "semantic_context=camera patterns, " +
        "procedural=user rules. " +
        "Group aliases: episodic, semantic, all.",
      enum: [
        "episodic_trace", "episodic_entity", "episodic_schema",
        "semantic_entity", "semantic_context", "procedural",
        "episodic", "semantic", "all",
      ],
    }),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 50, description: "Max results to return (default 5). For get_narrative, max archived chapters to include." }),
  ),
  position: Type.Optional(
    Type.Unsafe<string>(
      Type.String({
        description: "For action=get_history: which end of the episodic timeline to fetch. latest=recent memories, earliest=start of the video/session.",
        enum: ["latest", "earliest"],
      }),
    ),
  ),
  threshold: Type.Optional(
    Type.Number({ minimum: 0, maximum: 1, description: "Minimum similarity score 0-1 (default: no threshold)" }),
  ),
  note: Type.Optional(
    Type.String({ description: "The note text to store. Required for action=add_note." }),
  ),
  user_id: Type.Optional(
    Type.String({ description: "User ID to scope memory requests. Defaults to the configured user." }),
  ),
  agent_id: Type.Optional(
    Type.String({ description: "Agent ID to associate with the note (add_note)" }),
  ),
  memory_id: Type.Optional(
    Type.String({ description: "Specific memory ID to get or delete a single record (get, delete)" }),
  ),
  entity_id: Type.Optional(
    Type.String({ description: "Filter to a specific tracked entity/person (get, get_history, delete, set_identity)" }),
  ),
  identity: Type.Optional(
    Type.String({ description: "Identity description for set_identity, e.g. 'neighbor Alex' or 'owner's white Toyota'" }),
  ),
  status: Type.Optional(
    Type.Unsafe<string>(
      Type.String({
        description: "Identity status for set_identity: familiar (known person/vehicle), unfamiliar (stranger), admin (owner/authority)",
        enum: ["familiar", "unfamiliar", "admin"],
      }),
    ),
  ),
});

export type CortexMemoryToolInput = Static<typeof CortexMemoryToolSchema>;

// Legacy types used by index.ts
export interface SearchAction {
  action: "search";
  query: string;
  camera_id?: string;
  user_id?: string;
  mode?: string;
  memory_type?: string;
  limit?: number;
  threshold?: number;
}

export interface AddNoteAction {
  action: "add_note";
  note: string;
  camera_id?: string;
  user_id?: string;
  agent_id?: string;
  memory_type?: string;
  mode?: string;
}

export interface GetAction {
  action: "get";
  camera_id?: string;
  user_id?: string;
  agent_id?: string;
  entity_id?: string;
  memory_id?: string;
  memory_type?: string;
  limit?: number;
}

export interface DeleteAction {
  action: "delete";
  camera_id?: string;
  user_id?: string;
  agent_id?: string;
  entity_id?: string;
  memory_id?: string;
  memory_type?: string;
}

export interface GetHistoryAction {
  action: "get_history";
  camera_id: string;
  user_id?: string;
  limit?: number;
  entity_id?: string;
  position?: "latest" | "earliest";
}

export interface SetIdentityAction {
  action: "set_identity";
  entity_id: string;
  identity: string;
  status?: string;
  user_id?: string;
  camera_id?: string;
}

export interface GetNarrativeAction {
  action: "get_narrative";
  camera_id: string;
  user_id?: string;
  query?: string;
  limit?: number;
}
