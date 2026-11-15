/**
 * ToolExecutor — maps SimAgent/OpenClaw test-double tool call JSON to
 * MiniHost callTool() or, for legacy E2E coverage, Cortex Python HTTP API calls.
 *
 * In E2E, this simulates OpenClaw invoking Cortex tools after receiving a
 * segment policy consultation.
 *
 * Two execution paths:
 * 1. Plugin tools (cam/perception/memory) → MiniHost.callTool() (same surface OpenClaw uses)
 * 2. Legacy cortex_mem actions → direct HTTP to Cortex Python service
 */

import type { MiniHost } from "../../packages/host/src/mini-host.js";
import type { ToolCall } from "./sim-agent.js";

// Lazy getter: top-level const freezes the value at module-import time, but
// e2e-runner.ts sets process.env.CORTEX_ENDPOINT AFTER its imports
// resolve. Read on each call so the chosen E2E port is actually picked up.
const memUrl = () => process.env.CORTEX_ENDPOINT ?? "http://127.0.0.1:8219";

export interface ToolResult {
  success: boolean;
  tool: string;
  action?: string;
  data?: unknown;
  error?: string;
  latency_ms: number;
}

/**
 * Execute a tool call through MiniHost (for plugin tools) or HTTP (for legacy mem).
 * This is the test-side stand-in for an OpenClaw tool invocation.
 *
 * @param call - Tool call suggested by SimAgent acting as an OpenClaw test double
 * @param host - MiniHost instance with loaded Cortex plugin
 */
export async function executeTool(call: ToolCall, host: MiniHost): Promise<ToolResult> {
  const start = Date.now();
  // ToolCall.tool/params are optional in the type; default them here so the
  // rest of the function works with concrete values (sim-agent always fills
  // params with `?? {}` and emits a tool name, but the type allows undefined).
  const tool = call.tool ?? "none";
  const params = call.params ?? {};
  const action = params.action as string | undefined;
  const runtimeTool = resolveRuntimeToolName(tool);

  try {
    let data: unknown;

    switch (runtimeTool) {
      case "cortex_memory":
      case "cortex_cam":
      case "cortex_perception": {
        // Route through MiniHost — same code path as production
        const result = await host.callTool(runtimeTool, params);
        data = typeof result === "string" ? tryParseJson(result) : result;
        break;
      }

      case "cortex_mem": {
        // Direct HTTP to Cortex Python service
        data = await callMemApi(params);
        break;
      }

      default:
        return {
          success: false,
          tool,
          action,
          error: `Unknown tool: ${tool}`,
          latency_ms: Date.now() - start,
        };
    }

    return {
      success: true,
      tool: runtimeTool,
      action,
      data,
      latency_ms: Date.now() - start,
    };
  } catch (err) {
    return {
      success: false,
      tool: runtimeTool,
      action,
      error: err instanceof Error ? err.message : String(err),
      latency_ms: Date.now() - start,
    };
  }
}

// ── Cortex Python API ──

async function callMemApi(params: Record<string, unknown>): Promise<unknown> {
  const action = params.action as string;

  switch (action) {
    case "search": {
      const resp = await fetch(`${memUrl()}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: params.query,
          camera_id: params.camera_id,
          entity_id: params.entity_id,
          limit: params.limit ?? 5,
        }),
      });
      if (!resp.ok) throw new Error(`Mem search failed: ${resp.status}`);
      return resp.json();
    }

    case "get_memories": {
      const qs = new URLSearchParams();
      if (params.camera_id) qs.set("camera_id", String(params.camera_id));
      if (params.memory_type) qs.set("memory_type", String(params.memory_type));
      if (params.limit) qs.set("limit", String(params.limit));

      const resp = await fetch(`${memUrl()}/memories?${qs.toString()}`);
      if (!resp.ok) throw new Error(`Mem get_memories failed: ${resp.status}`);
      return resp.json();
    }

    case "reid_upsert": {
      const resp = await fetch(`${memUrl()}/reid/upsert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      if (!resp.ok) throw new Error(`Mem reid_upsert failed: ${resp.status}`);
      return resp.json();
    }

    case "reid_search": {
      const resp = await fetch(`${memUrl()}/reid/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      if (!resp.ok) throw new Error(`Mem reid_search failed: ${resp.status}`);
      return resp.json();
    }

    case "expire_media": {
      const resp = await fetch(`${memUrl()}/memories/expire_media`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      if (!resp.ok) throw new Error(`Mem expire_media failed: ${resp.status}`);
      return resp.json();
    }

    default:
      throw new Error(`Unknown mem action: ${action}`);
  }
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function resolveRuntimeToolName(tool: string): string {
  if (tool === "cortex_cam") return "cortex_cam";
  return tool;
}
