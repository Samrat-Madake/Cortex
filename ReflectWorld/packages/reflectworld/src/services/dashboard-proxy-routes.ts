import type { IncomingMessage, ServerResponse } from "node:http";
import { monitorBus } from "@reflectworld/shared";
import type { MonitorEvent } from "@reflectworld/shared";
import {
  MEMORY_WEBHOOK_EVENT_TYPES,
  isRecord,
} from "./dashboard-common.js";
import { isAuthorizedInternalWebhookRequest } from "./internal-webhook-auth.js";
import type { DashboardSessionScope } from "./dashboard-common.js";
import type { DashboardMemoryProxy } from "./dashboard-memory-proxy.js";

export interface DashboardProxyRoutesOptions {
  reflectworldEndpoint: string;
  internalWebhookToken?: string;
  requireInternalWebhookToken: boolean;
  sessionEnabled: () => boolean;
  memoryProxy: DashboardMemoryProxy;
  requireDashboardSession: (
    req: IncomingMessage,
    res: ServerResponse,
    body?: Record<string, unknown>,
    url?: URL,
  ) => DashboardSessionScope | null;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readRequestBuffer: (req: IncomingMessage, maxBytes?: number) => Promise<Buffer>;
}

export class DashboardProxyRoutes {
  constructor(private readonly options: DashboardProxyRoutesOptions) {}

  async handleReflectWorldProxy(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const scope = this.options.requireDashboardSession(req, res, undefined, url);
    if (this.options.sessionEnabled() && !scope) return;
    const upstreamUrl = new URL(url.toString());
    upstreamUrl.pathname = url.pathname.replace("/api/reflectworld", "");
    upstreamUrl.searchParams.delete("session_id");
    upstreamUrl.searchParams.delete("user_id");
    if (this.options.sessionEnabled() && scope) {
      upstreamUrl.searchParams.set("user_id", scope.userId);
      const method = (req.method ?? "GET").toUpperCase();
      const memoryDeleteId = this.options.memoryProxy.singleMemoryDeleteId(method, upstreamUrl.pathname);
      const dangerousPath = upstreamUrl.pathname === "/reset";
      const destructiveWithoutOwnerCheck = method === "DELETE" && !memoryDeleteId;
      if ((dangerousPath || destructiveWithoutOwnerCheck) && !scope.isAdmin) {
        this.options.sendJson(res, 403, { error: "Admin session is required" });
        return;
      }
      if (memoryDeleteId && !scope.isAdmin) {
        const ownerCheck = await this.options.memoryProxy.checkMemoryOwner(memoryDeleteId, upstreamUrl.searchParams.get("memory_type"), scope);
        if (!ownerCheck.ok) {
          this.options.sendJson(res, ownerCheck.status, ownerCheck.body);
          return;
        }
      }
    }
    try {
      let requestBody = req.method === "GET" || req.method === "HEAD"
        ? undefined
        : await this.options.readRequestBuffer(req, 1024 * 1024);
      const contentType = typeof req.headers["content-type"] === "string"
        ? req.headers["content-type"]
        : "application/json";
      if (this.options.sessionEnabled() && scope && requestBody && contentType.includes("application/json")) {
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(requestBody.toString("utf8") || "{}") as unknown;
        } catch {
          this.options.sendJson(res, 400, { error: "Invalid JSON body" });
          return;
        }
        if (isRecord(parsedBody)) {
          const sanitizedBody: Record<string, unknown> = { ...parsedBody, user_id: scope.userId };
          delete sanitizedBody.session_id;
          requestBody = Buffer.from(JSON.stringify(sanitizedBody));
        }
      }
      const reflectworldPath = `${upstreamUrl.pathname}${upstreamUrl.search}`;
      const reflectworldUrl = `${this.options.reflectworldEndpoint}${reflectworldPath}`;
      const upstream = await fetch(reflectworldUrl, {
        method: req.method,
        headers: { "Content-Type": contentType },
        body: requestBody,
      });
      const upstreamBody = await upstream.text();
      this.options.memoryProxy.publishProxyEvent(reflectworldPath, req.method ?? "GET", upstream.status, requestBody, upstreamBody);
      const responseBody = this.options.memoryProxy.rewriteProxyResponse(reflectworldPath, req.method ?? "GET", upstream.status, upstreamBody, scope);
      res.writeHead(upstream.status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(responseBody);
    } catch {
      res.writeHead(502); res.end('{"error":"ReflectWorld unreachable"}');
    }
  }

  async handleMemoryEvent(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isAuthorizedInternalWebhookRequest(
      req,
      this.options.internalWebhookToken,
      this.options.requireInternalWebhookToken,
    )) {
      res.writeHead(403, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end('{"error":"Forbidden"}');
      return;
    }
    try {
      const raw = await this.options.readRequestBuffer(req, 256 * 1024);
      const payload = JSON.parse(raw.toString("utf8") || "{}");
      if (!isRecord(payload)) {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end('{"error":"Invalid memory-event payload"}');
        return;
      }
      const eventType = typeof payload.type === "string" ? payload.type : "memory:memory_added";
      if (!MEMORY_WEBHOOK_EVENT_TYPES.has(eventType as MonitorEvent["type"])) {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end('{"error":"Unsupported memory-event type"}');
        return;
      }
      const data = isRecord(payload.data) ? payload.data : {};
      const cameraId = typeof data.camera_id === "string" ? data.camera_id : undefined;
      monitorBus.publish(eventType as MonitorEvent["type"], data, cameraId);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end('{"ok":true}');
    } catch {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end('{"error":"Invalid memory-event payload"}');
    }
  }
}
