import type { IncomingMessage, ServerResponse } from "node:http";
import {
  envFlag,
  sanitizeSessionToken,
} from "./dashboard-common.js";
import type { DashboardSessionConfig } from "./dashboard-common.js";
import type { DashboardSessionManager } from "./dashboard-sessions.js";

export interface DashboardSessionRoutesOptions {
  config: DashboardSessionConfig;
  sessions: DashboardSessionManager;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readRequestBuffer: (req: IncomingMessage, maxBytes?: number) => Promise<Buffer>;
}

export class DashboardSessionRoutes {
  constructor(private readonly options: DashboardSessionRoutesOptions) {}

  async handleStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await this.options.readRequestBuffer(req, 1024 * 1024);
    const body = JSON.parse(raw.toString("utf8") || "{}") as Record<string, unknown>;
    const result = this.options.sessions.startSession(body);
    this.setSessionCookies(res, result.status, body);
    this.options.sendJson(res, result.status, result.body);
  }

  async handleHeartbeat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await this.options.readRequestBuffer(req, 1024 * 1024);
    const body = JSON.parse(raw.toString("utf8") || "{}") as Record<string, unknown>;
    const result = this.options.sessions.heartbeatSession(body);
    this.options.sendJson(res, result.status, result.body);
  }

  async handleEnd(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await this.options.readRequestBuffer(req, 1024 * 1024);
    const body = JSON.parse(raw.toString("utf8") || "{}") as Record<string, unknown>;
    const result = this.options.sessions.endSession(body);
    this.options.sendJson(res, result.status, result.body);
  }

  private setSessionCookies(res: ServerResponse, status: number, body: Record<string, unknown>): void {
    if (!this.options.config.enabled || status < 200 || status >= 300) return;
    const sessionId = sanitizeSessionToken(body.session_id);
    const userId = sanitizeSessionToken(body.user_id);
    if (!sessionId || !userId) return;
    const secure = envFlag("DASHBOARD_COOKIE_SECURE", false) ? "; Secure" : "";
    res.setHeader("Set-Cookie", [
      `vm_dashboard_session=${encodeURIComponent(sessionId)}; Path=/; SameSite=Lax; HttpOnly${secure}`,
      `vm_dashboard_user=${encodeURIComponent(userId)}; Path=/; SameSite=Lax; HttpOnly${secure}`,
    ]);
  }
}
