/**
 * Assertion engine for E2E tests.
 * Four assertion types: structure, semantic, state (Mem verification), and trace.
 */

import type { PipelineTrace } from "@reflectworld/shared";

const logger = {
  info: (msg: string) => console.log(`[e2e:assertion] ${msg}`),
};
// Lazy getter: top-level const freezes the value at module-import time, but
// e2e-runner.ts sets process.env.REFLECTWORLD_URL AFTER its imports resolve —
// that means any module-level `const MEM_URL = process.env...` gets the old
// default and silently talks to :8219. Read on each call instead.
const memUrl = () => process.env.REFLECTWORLD_URL ?? "http://127.0.0.1:8219";

interface MemoryItemLike {
  id?: string;
  memory?: string;
  score?: number;
}

export interface AssertionResult {
  id: number;
  category: string;
  name: string;
  passed: boolean;
  details: string;
  severity: "required" | "best_effort";
}

/**
 * Structure assertion: checks that data contains all required fields.
 */
export function assertStructure(
  id: number,
  category: string,
  name: string,
  data: unknown,
  requiredFields: string[],
): AssertionResult {
  if (data == null || typeof data !== "object") {
    return { id, category, name, passed: false, details: `Expected object, got ${typeof data}`, severity: "required" };
  }
  const obj = data as Record<string, unknown>;
  const missing = requiredFields.filter((f) => !(f in obj));
  if (missing.length > 0) {
    return { id, category, name, passed: false, details: `Missing fields: ${missing.join(", ")}`, severity: "required" };
  }
  return { id, category, name, passed: true, details: `All required fields present: ${requiredFields.join(", ")}`, severity: "required" };
}

/**
 * Semantic assertion: checks action type, value ranges, and decision direction.
 */
export function assertSemantic(
  id: number,
  category: string,
  name: string,
  actual: unknown,
  expectations: {
    actionType?: string;
    fpsRange?: [number, number];
    directionUp?: boolean;
    toolName?: string;
    containsAny?: string[];
  },
): AssertionResult {
  if (actual == null || typeof actual !== "object") {
    return { id, category, name, passed: false, details: `Expected object, got ${typeof actual}`, severity: "required" };
  }
  const obj = actual as Record<string, unknown>;
  const failures: string[] = [];

  if (expectations.toolName !== undefined) {
    if (obj.tool !== expectations.toolName) {
      failures.push(`tool: expected "${expectations.toolName}", got "${obj.tool}"`);
    }
  }

  if (expectations.actionType !== undefined) {
    const params = obj.params as Record<string, unknown> | undefined;
    const action = (obj.action ?? params?.action) as string | undefined;
    if (action !== expectations.actionType) {
      failures.push(`action: expected "${expectations.actionType}", got "${action}"`);
    }
  }

  if (expectations.fpsRange !== undefined) {
    const fps = (obj.fps ?? (obj.params as Record<string, unknown> | undefined)?.fps) as number | undefined;
    if (fps == null) {
      failures.push("fps: field missing");
    } else if (fps < expectations.fpsRange[0] || fps > expectations.fpsRange[1]) {
      failures.push(`fps: ${fps} not in range [${expectations.fpsRange[0]}, ${expectations.fpsRange[1]}]`);
    }
  }

  if (expectations.directionUp !== undefined) {
    const action = obj.action as Record<string, unknown> | undefined;
    const params = obj.params as Record<string, unknown> | undefined;
    const fps = (obj.fps ?? action?.fps ?? params?.fps) as number | undefined;
    const skipVlm = (obj.skip_vlm ?? action?.skip_vlm) as boolean | undefined;
    if (expectations.directionUp) {
      // Escalation: fps should be > 1 or skip_vlm should be false
      if (fps != null && fps <= 1 && skipVlm !== false) {
        failures.push("Expected escalation (higher fps or VLM enabled), but got baseline-level values");
      }
    } else {
      // De-escalation: fps should be <= baseline or skip_vlm should be true
      if (fps != null && fps > 1 && skipVlm === false) {
        failures.push("Expected de-escalation, but got escalated values");
      }
    }
  }

  if (expectations.containsAny !== undefined && expectations.containsAny.length > 0) {
    const str = JSON.stringify(actual).toLowerCase();
    const found = expectations.containsAny.some((kw) => str.includes(kw.toLowerCase()));
    if (!found) {
      failures.push(`none of [${expectations.containsAny.join(", ")}] found in output`);
    }
  }

  if (failures.length > 0) {
    return { id, category, name, passed: false, details: failures.join("; "), severity: "required" };
  }
  return { id, category, name, passed: true, details: "Semantic expectations met", severity: "required" };
}

/**
 * State assertion: verifies ReflectWorld memory state via HTTP API.
 */
export async function assertMemState(
  id: number,
  name: string,
  expectations: {
    cameraId?: string;
    minEpisodicCount?: number;
    hasSemanticMemory?: boolean;
    searchQuery?: string;
    minSearchScore?: number;
    entityId?: string;
  },
): Promise<AssertionResult> {
  const category = "Mem";
  const failures: string[] = [];

  if (expectations.minEpisodicCount !== undefined) {
    const params = new URLSearchParams({ memory_type: "episodic" });
    if (expectations.cameraId) params.set("camera_id", expectations.cameraId);
    const resp = await fetch(`${memUrl()}/memories?${params.toString()}`);
    if (!resp.ok) {
      return { id, category, name, passed: false, details: `GET /memories failed: ${resp.status}`, severity: "required" };
    }
    const memories = flattenMemoriesResponse(await resp.json());
    const count = memories.length;
    if (count < expectations.minEpisodicCount) {
      failures.push(`episodic count: ${count} < ${expectations.minEpisodicCount}`);
    }
  }

  if (expectations.hasSemanticMemory) {
    const params = new URLSearchParams({ memory_type: "semantic" });
    if (expectations.cameraId) params.set("camera_id", expectations.cameraId);
    const resp = await fetch(`${memUrl()}/memories?${params.toString()}`);
    if (!resp.ok) {
      return { id, category, name, passed: false, details: `GET /memories (semantic) failed: ${resp.status}`, severity: "required" };
    }
    const memories = flattenMemoriesResponse(await resp.json());
    const count = memories.length;
    if (count === 0) {
      failures.push("no semantic memories found");
    }
  }

  if (expectations.searchQuery) {
    const body: Record<string, unknown> = {
      query: expectations.searchQuery,
      limit: 5,
    };
    if (expectations.cameraId) body.camera_id = expectations.cameraId;
    if (expectations.entityId) body.entity_id = expectations.entityId;

    const resp = await fetch(`${memUrl()}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      return { id, category, name, passed: false, details: `POST /search failed: ${resp.status}`, severity: "required" };
    }
    const result = (await resp.json()) as Record<string, unknown>;
    // ReflectWorld search returns { results: [...] } or nested structure
    const results = extractSearchResults(result);

    if (results.length === 0) {
      failures.push(`search "${expectations.searchQuery}" returned no results`);
    } else if (expectations.minSearchScore !== undefined) {
      const topScore = results[0]?.score ?? 0;
      if (topScore < expectations.minSearchScore) {
        failures.push(`top score ${topScore.toFixed(3)} < ${expectations.minSearchScore}`);
      }
    }
  }

  if (failures.length > 0) {
    return { id, category, name, passed: false, details: failures.join("; "), severity: "required" };
  }
  return { id, category, name, passed: true, details: "Memory state verified", severity: "required" };
}

/**
 * Extract flat array of search results from ReflectWorld response.
 * Response may be { results: [...] } or { episodic: [...], semantic: [...] }.
 */
function extractSearchResults(
  data: Record<string, unknown>,
): Array<{ memory: string; score: number }> {
  if (Array.isArray(data.results)) {
    return data.results as Array<{ memory: string; score: number }>;
  }
  // Flatten all arrays in the response
  const all: Array<{ memory: string; score: number }> = [];
  for (const val of Object.values(data)) {
    if (Array.isArray(val)) {
      all.push(...(val as Array<{ memory: string; score: number }>));
    }
  }
  // Sort by score descending
  all.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return all;
}

function flattenMemoriesResponse(data: unknown): MemoryItemLike[] {
  if (Array.isArray(data)) {
    return data as MemoryItemLike[];
  }
  if (data && typeof data === "object") {
    const all: MemoryItemLike[] = [];
    for (const value of Object.values(data as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        all.push(...(value as MemoryItemLike[]));
      }
    }
    return all;
  }
  return [];
}

/**
 * Trace assertion: verifies PipelineTrace data — analyzer execution, latency SLA, coverage.
 */
export function assertTrace(
  id: number,
  name: string,
  traces: PipelineTrace[],
  expectations: {
    minCount?: number;
    requiredAnalyzers?: string[];
    maxE2eMs?: number;
    maxPerceptionMs?: number;
    minLevel?: number;
  },
): AssertionResult {
  const category = "Trace";
  const failures: string[] = [];

  if (expectations.minCount !== undefined && traces.length < expectations.minCount) {
    failures.push(`trace count: ${traces.length} < ${expectations.minCount}`);
  }

  if (expectations.requiredAnalyzers !== undefined && traces.length > 0) {
    for (const analyzer of expectations.requiredAnalyzers) {
      const withAnalyzer = traces.filter((t) => t.context.analyzers_run.includes(analyzer));
      if (withAnalyzer.length === 0) {
        failures.push(`no traces ran "${analyzer}" analyzer`);
      }
    }
  }

  if (expectations.maxE2eMs !== undefined && traces.length > 0) {
    const sorted = traces.map((t) => t.latencies.e2e_ms).sort((a, b) => a - b);
    const p95Idx = Math.min(Math.ceil(sorted.length * 0.95) - 1, sorted.length - 1);
    const p95 = sorted[p95Idx];
    if (p95 > expectations.maxE2eMs) {
      failures.push(`e2e p95 ${p95}ms > ${expectations.maxE2eMs}ms SLA`);
    }
  }

  if (expectations.maxPerceptionMs !== undefined && traces.length > 0) {
    const sorted = traces.map((t) => t.latencies.perception_ms).sort((a, b) => a - b);
    const p95Idx = Math.min(Math.ceil(sorted.length * 0.95) - 1, sorted.length - 1);
    const p95 = sorted[p95Idx];
    if (p95 > expectations.maxPerceptionMs) {
      failures.push(`perception p95 ${p95}ms > ${expectations.maxPerceptionMs}ms SLA`);
    }
  }

  if (expectations.minLevel !== undefined && traces.length > 0) {
    const maxLevel = Math.max(...traces.map((t) => t.context.level));
    if (maxLevel < expectations.minLevel) {
      failures.push(`max observed level ${maxLevel} < required ${expectations.minLevel}`);
    }
  }

  if (failures.length > 0) {
    return { id, category, name, passed: false, details: failures.join("; "), severity: "required" };
  }

  const analyzersUsed = [...new Set(traces.flatMap((t) => t.context.analyzers_run))];
  return {
    id,
    category,
    name,
    passed: true,
    details: `${traces.length} traces, analyzers: [${analyzersUsed.join(", ")}]`,
    severity: "required",
  };
}

/** Log an assertion result with PASS/FAIL prefix. */
export function logResult(result: AssertionResult): void {
  const icon = result.passed ? "PASS" : "FAIL";
  logger.info(`[${icon}] #${result.id} ${result.category}: ${result.name} — ${result.details}`);
}
