import { monitorBus } from "@reflectworld/shared";
import { isRecord, type DashboardSessionScope } from "./dashboard-common.js";

export interface DashboardMemoryProxyOptions {
  reflectworldEndpoint: string;
  buildEntityRefMap: (limit: number, cameraId?: string, scope?: DashboardSessionScope | null) => Record<string, string>;
}

export class DashboardMemoryProxy {
  constructor(private readonly options: DashboardMemoryProxyOptions) {}

  singleMemoryDeleteId(method: string, pathname: string): string | null {
    if (method !== "DELETE") return null;
    const match = pathname.match(/^\/memories\/([^/]+)$/);
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  async checkMemoryOwner(
    memoryId: string,
    memoryType: string | null,
    scope: DashboardSessionScope,
  ): Promise<{ ok: true } | { ok: false; status: number; body: Record<string, unknown> }> {
    const lookup = new URL(`/memories/${encodeURIComponent(memoryId)}`, this.options.reflectworldEndpoint);
    if (memoryType) lookup.searchParams.set("memory_type", memoryType);
    try {
      const upstream = await fetch(lookup);
      if (!upstream.ok) {
        return { ok: false, status: upstream.status, body: { error: "Memory not found" } };
      }
      const payload = await upstream.json() as unknown;
      if (!this.memoryOwnedBy(payload, scope.userId)) {
        return { ok: false, status: 403, body: { error: "Memory does not belong to this dashboard session" } };
      }
      return { ok: true };
    } catch {
      return { ok: false, status: 502, body: { error: "ReflectWorld unreachable" } };
    }
  }

  publishProxyEvent(
    pathWithQuery: string,
    method: string,
    status: number,
    requestBody: Buffer | undefined,
    upstreamBody: string,
  ): void {
    if (status < 200 || status >= 300) return;

    try {
      const path = pathWithQuery.split("?")[0];
      if (method === "DELETE") {
        const match = path.match(/^\/memories\/([^/]+)$/);
        if (!match) return;
        const response = JSON.parse(upstreamBody) as { deleted_memory?: { id?: unknown; memory?: unknown } };
        const deleted = response.deleted_memory;
        const memoryId = typeof deleted?.id === "string" ? deleted.id : decodeURIComponent(match[1] ?? "");
        if (!memoryId) return;
        monitorBus.publish("memory:memory_deleted", {
          memory_id: memoryId,
          memory_type: "procedural",
          summary_preview: typeof deleted?.memory === "string" ? deleted.memory.slice(0, 200) : undefined,
        }, "global");
        return;
      }

      if (method !== "POST" || path !== "/memories" || !requestBody) return;
      const request = JSON.parse(requestBody.toString("utf8")) as Record<string, unknown>;
      if (request.memory_type !== "procedural") return;

      const response = JSON.parse(upstreamBody) as { results?: Array<Record<string, unknown>> };
      const results = Array.isArray(response.results) ? response.results : [];
      const metadata = typeof request.metadata === "object" && request.metadata !== null
        ? request.metadata as Record<string, unknown>
        : {};
      const cameraId = typeof request.camera_id === "string" && request.camera_id
        ? request.camera_id
        : typeof metadata.camera_id === "string" && metadata.camera_id
          ? metadata.camera_id
          : "global";
      const userId = typeof request.user_id === "string" && request.user_id
        ? request.user_id
        : typeof metadata.user_id === "string" && metadata.user_id
          ? metadata.user_id
          : undefined;

      for (const item of results) {
        const memoryId = typeof item.id === "string" ? item.id : "";
        const memory = typeof item.memory === "string" ? item.memory : "";
        if (!memoryId || !memory) continue;
        monitorBus.publish("memory:memory_added", {
          memory_id: memoryId,
          memory_type: "procedural",
          event: typeof item.event === "string" ? item.event : "ADD",
          camera_id: cameraId,
          ...(userId ? { user_id: userId } : {}),
          summary_preview: memory.slice(0, 200),
        }, cameraId);
      }
    } catch {
      // Best-effort UI hydration; proxy response is still returned to the caller.
    }
  }

  rewriteProxyResponse(
    pathWithQuery: string,
    method: string,
    status: number,
    upstreamBody: string,
    scope?: DashboardSessionScope | null,
  ): string {
    if (status < 200 || status >= 300 || method !== "GET") return upstreamBody;
    try {
      const parsedUrl = new URL(`http://dashboard.local${pathWithQuery}`);
      if (parsedUrl.pathname !== "/memories" || parsedUrl.searchParams.get("memory_type") !== "semantic") return upstreamBody;
      const cameraId = parsedUrl.searchParams.get("camera_id") ?? undefined;
      const refMap = this.options.buildEntityRefMap(100, cameraId, scope);
      if (Object.keys(refMap).length === 0) return upstreamBody;
      const body = JSON.parse(upstreamBody) as Record<string, unknown>;
      let changed = false;
      for (const value of Object.values(body)) {
        if (!Array.isArray(value)) continue;
        for (const item of value) {
          if (!item || typeof item !== "object") continue;
          const memory = item as Record<string, unknown>;
          const entityId = typeof memory.entity_id === "string" && memory.entity_id ? memory.entity_id : "";
          const ref = entityId ? refMap[entityId] : undefined;
          if (!ref || memory.entity_ref === ref) continue;
          memory.entity_ref = ref;
          changed = true;
        }
      }
      return changed ? JSON.stringify(body) : upstreamBody;
    } catch {
      return upstreamBody;
    }
  }

  private memoryOwnedBy(payload: unknown, userId: string): boolean {
    if (!isRecord(payload)) return false;
    if (typeof payload.user_id === "string") return payload.user_id === userId;
    for (const value of Object.values(payload)) {
      if (isRecord(value) && typeof value.user_id === "string") {
        if (value.user_id === userId) return true;
      }
    }
    return false;
  }
}
