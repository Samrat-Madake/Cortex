import type { IncomingMessage } from "node:http";
import type {
  ActiveSourceStatus,
  DashboardStateEnvelope,
  MonitorEvent,
} from "@cortex/shared";
import {
  readCookie,
  sanitizeSessionToken,
} from "./dashboard-common.js";
import type {
  DashboardSessionConfig,
  DashboardSessionRecord,
  DashboardSessionScope,
} from "./dashboard-common.js";

export interface DashboardSessionManagerOptions {
  config: DashboardSessionConfig;
  getActiveSources: () => ActiveSourceStatus[];
  onSessionStarted?: (sessionId: string) => void;
}

export interface DashboardSessionCleanupHooks {
  now?: number;
  cleanupChatRateBuckets: (now: number) => void;
  removeSource: ((req: { name: string; userId?: string; sessionId?: string }) => Promise<unknown>) | null;
  purgeSourceState: (
    sourceId: string,
    opts: { scope: DashboardSessionScope; publishRemoval: true },
  ) => Promise<unknown>;
  clearUploadsAndCaches: (scope: DashboardSessionScope) => void;
  purgeSessionHealth: (sessionId: string) => void;
}

export class DashboardSessionManager {
  private readonly sessions = new Map<string, DashboardSessionRecord>();
  private readonly sourceOwners = new Map<string, { sessionId: string; userId: string }>();

  constructor(private readonly options: DashboardSessionManagerOptions) {}

  activeSessions(now = Date.now()): DashboardSessionRecord[] {
    return Array.from(this.sessions.values())
      .filter((session) => session.isAdmin || now - session.lastSeen <= this.options.config.staleTtlMs);
  }

  startSession(body: Record<string, unknown>): { status: number; body: Record<string, unknown> } {
    const config = this.options.config;
    if (!config.enabled) {
      return { status: 200, body: { ok: true, multi_user: false } };
    }
    const sessionId = sanitizeSessionToken(body.session_id);
    const userId = sanitizeSessionToken(body.user_id);
    const wantsAdmin = body.is_admin === true || userId === "admin";
    const adminToken = typeof body.admin_token === "string" ? body.admin_token : "";
    if (wantsAdmin && (!config.adminToken || adminToken !== config.adminToken)) {
      return { status: 403, body: { ok: false, error: "admin token is required" } };
    }
    const isAdmin = wantsAdmin;
    if (!sessionId || !userId) {
      return { status: 400, body: { ok: false, error: "session_id and user_id are required" } };
    }

    const now = Date.now();
    const existing = this.sessions.get(sessionId);
    if (existing && existing.userId !== userId) {
      return {
        status: 409,
        body: {
          ok: false,
          error: "session_id is already bound to a different user_id",
        },
      };
    }
    if (!existing) {
      const activeCount = this.activeSessions(now).filter((session) => !session.isAdmin).length;
      if (!isAdmin && activeCount >= config.maxActiveSessions) {
        return {
          status: 429,
          body: {
            ok: false,
            code: "capacity_full",
            multi_user: true,
            max_active_sessions: config.maxActiveSessions,
            message: "Demo capacity is full. Vision analysis is GPU/API intensive, so concurrent sessions are limited to keep the experience stable. Please try again later.",
          },
        };
      }
    }

    const record: DashboardSessionRecord = existing ?? {
      sessionId,
      userId,
      isAdmin,
      createdAt: now,
      lastSeen: now,
      sources: new Set<string>(),
    };
    record.userId = userId;
    record.isAdmin = isAdmin;
    record.lastSeen = now;
    record.staleSince = undefined;
    this.sessions.set(sessionId, record);
    try {
      this.options.onSessionStarted?.(sessionId);
    } catch {
      // Session lifecycle must not depend on Dashboard observability.
    }
    return {
      status: 200,
      body: {
        ok: true,
        multi_user: true,
        session_id: sessionId,
        user_id: userId,
        max_active_sessions: config.maxActiveSessions,
        max_sources_per_session: config.maxSourcesPerSession,
        heartbeat_interval_ms: 15_000,
        stale_ttl_ms: config.staleTtlMs,
      },
    };
  }

  heartbeatSession(body: Record<string, unknown>): { status: number; body: Record<string, unknown> } {
    if (!this.options.config.enabled) return { status: 200, body: { ok: true, multi_user: false } };
    const sessionId = sanitizeSessionToken(body.session_id);
    if (!sessionId) return { status: 400, body: { ok: false, error: "session_id is required" } };
    const record = this.sessions.get(sessionId);
    if (!record) return { status: 404, body: { ok: false, error: "session not found" } };
    record.lastSeen = Date.now();
    record.staleSince = undefined;
    return { status: 200, body: { ok: true, multi_user: true } };
  }

  endSession(body: Record<string, unknown>): { status: number; body: Record<string, unknown> } {
    if (!this.options.config.enabled) return { status: 200, body: { ok: true, multi_user: false } };
    const sessionId = sanitizeSessionToken(body.session_id);
    const record = sessionId ? this.sessions.get(sessionId) : null;
    if (record) {
      record.lastSeen = 0;
      record.staleSince = Date.now();
    }
    return { status: 200, body: { ok: true, multi_user: true } };
  }

  scopeFromRequest(req: IncomingMessage, body?: Record<string, unknown>, url?: URL): DashboardSessionScope | null {
    if (!this.options.config.enabled) return null;
    const sessionId = sanitizeSessionToken(body?.session_id)
      ?? sanitizeSessionToken(req.headers["x-dashboard-session-id"])
      ?? sanitizeSessionToken(url?.searchParams.get("session_id"))
      ?? sanitizeSessionToken(readCookie(req, "vm_dashboard_session"));
    const userId = sanitizeSessionToken(body?.user_id)
      ?? sanitizeSessionToken(req.headers["x-dashboard-user-id"])
      ?? sanitizeSessionToken(url?.searchParams.get("user_id"))
      ?? sanitizeSessionToken(readCookie(req, "vm_dashboard_user"));
    if (!sessionId || !userId) return null;
    const record = this.sessions.get(sessionId);
    if (!record || record.userId !== userId) return null;
    record.lastSeen = Date.now();
    record.staleSince = undefined;
    return { sessionId, userId, isAdmin: record.isAdmin };
  }

  recordSourceOwner(sourceId: string | undefined, scope: DashboardSessionScope | null): void {
    if (!this.options.config.enabled || !sourceId || !scope) return;
    this.sourceOwners.set(sourceId, { sessionId: scope.sessionId, userId: scope.userId });
    this.sessions.get(scope.sessionId)?.sources.add(sourceId);
  }

  sourceVisibleToSession(sourceId: string, scope?: DashboardSessionScope | null): boolean {
    if (!this.options.config.enabled) return true;
    if (!scope) return false;
    if (scope.isAdmin) return true;
    const owner = this.sourceOwners.get(sourceId);
    if (!owner) {
      const source = this.options.getActiveSources().find((item) => item.source_id === sourceId);
      if (!source?.session_id && !source?.user_id) return false;
      if (source.session_id && source.user_id) {
        return source.session_id === scope.sessionId && source.user_id === scope.userId;
      }
      if (source.session_id) return source.session_id === scope.sessionId;
      return source.user_id === scope.userId;
    }
    return owner.sessionId === scope.sessionId && owner.userId === scope.userId;
  }

  eventVisibleToSession(event: MonitorEvent, scope?: DashboardSessionScope | null): boolean {
    if (!this.options.config.enabled) return true;
    if (!scope) return false;
    if (scope.isAdmin) return true;
    const eventSession = sanitizeSessionToken(event.data?.session_id);
    const eventUser = sanitizeSessionToken(event.data?.user_id);
    if (eventSession || eventUser) {
      if (isRuntimeHealthEvent(event)) {
        if (eventSession && eventSession !== scope.sessionId) return false;
        if (eventUser && eventUser !== scope.userId) return false;
        const sourceId = runtimeHealthSourceId(event);
        if (sourceId && !this.sourceVisibleToSession(sourceId, scope)) return false;
        return true;
      }
      return eventSession === scope.sessionId || eventUser === scope.userId;
    }
    const sourceId = typeof event.camera_id === "string" && event.camera_id
      ? event.camera_id
      : typeof event.data?.source_id === "string"
        ? event.data.source_id
        : typeof event.data?.id === "string"
          ? event.data.id
          : "";
    if (!sourceId) return false;
    return this.sourceVisibleToSession(sourceId, scope);
  }

  envelopeVisibleToSession(envelope: DashboardStateEnvelope, scope?: DashboardSessionScope | null): boolean {
    if (!this.options.config.enabled) return true;
    if (!scope) return false;
    if (scope.isAdmin) return true;
    if (envelope.scope?.session_id || envelope.scope?.user_id) {
      if (isRuntimeHealthEnvelope(envelope)) {
        if (envelope.scope.session_id && envelope.scope.session_id !== scope.sessionId) return false;
        if (envelope.scope.user_id && envelope.scope.user_id !== scope.userId) return false;
        const sourceId = runtimeHealthEnvelopeSourceId(envelope);
        if (sourceId && !this.sourceVisibleToSession(sourceId, scope)) return false;
        return true;
      }
      return envelope.scope.session_id === scope.sessionId || envelope.scope.user_id === scope.userId;
    }
    if (envelope.domain === "segment") {
      const cameraId = typeof envelope.data?.camera_id === "string" ? envelope.data.camera_id : "";
      return Boolean(cameraId) && this.sourceVisibleToSession(cameraId, scope);
    }
    if (envelope.domain === "memory" || envelope.domain === "trace") {
      const eventUser = typeof envelope.data?.user_id === "string" ? envelope.data.user_id : undefined;
      const eventSession = typeof envelope.data?.session_id === "string" ? envelope.data.session_id : undefined;
      if (eventSession || eventUser) return eventSession === scope.sessionId || eventUser === scope.userId;
      const cameraId = typeof envelope.data?.camera_id === "string" ? envelope.data.camera_id : "";
      return Boolean(cameraId) && this.sourceVisibleToSession(cameraId, scope);
    }
    if (envelope.domain === "service") {
      const cameraId = typeof envelope.data?.camera_id === "string" ? envelope.data.camera_id : "";
      return !cameraId || this.sourceVisibleToSession(cameraId, scope);
    }
    return this.sourceVisibleToSession(envelope.id, scope);
  }

  enforceSourceLimit(scope: DashboardSessionScope | null): { ok: true } | { ok: false; status: number; body: Record<string, unknown> } {
    const config = this.options.config;
    if (!config.enabled || !scope?.sessionId || scope.isAdmin) return { ok: true };
    const record = this.sessions.get(scope.sessionId);
    const count = record?.sources.size ?? 0;
    if (count >= config.maxSourcesPerSession) {
      return {
        ok: false,
        status: 429,
        body: {
          error: `Session source limit reached (${config.maxSourcesPerSession}). Remove an existing source before adding another.`,
          code: "source_limit_reached",
        },
      };
    }
    return { ok: true };
  }

  forgetSourceOwnership(sourceId: string, scope?: DashboardSessionScope | null): void {
    this.sourceOwners.delete(sourceId);
    if (scope) {
      this.sessions.get(scope.sessionId)?.sources.delete(sourceId);
      return;
    }
    for (const session of this.sessions.values()) {
      session.sources.delete(sourceId);
    }
  }

  sourceOwner(sourceId: string): { sessionId: string; userId: string } | undefined {
    return this.sourceOwners.get(sourceId);
  }

  sourceOwnerIds(): string[] {
    return Array.from(this.sourceOwners.keys());
  }

  sourceIdsForSession(sessionId: string): string[] {
    return Array.from(this.sessions.get(sessionId)?.sources ?? []);
  }

  clearSessionSources(sessionId: string): void {
    this.sessions.get(sessionId)?.sources.clear();
  }

  async cleanupStaleSessions(hooks: DashboardSessionCleanupHooks): Promise<void> {
    const config = this.options.config;
    if (!config.enabled) return;
    const now = hooks.now ?? Date.now();
    hooks.cleanupChatRateBuckets(now);
    for (const session of this.sessions.values()) {
      if (session.isAdmin) continue;
      const idleMs = now - session.lastSeen;
      if (idleMs < config.staleTtlMs) continue;
      session.staleSince ??= now;
      const staleMs = now - session.staleSince;
      if (!session.stopRequested && staleMs >= config.stopGraceMs) {
        session.stopRequested = true;
        for (const sourceId of Array.from(session.sources)) {
          await hooks.removeSource?.({ name: sourceId, userId: session.userId, sessionId: session.sessionId }).catch(() => undefined);
          await hooks.purgeSourceState(sourceId, {
            scope: { sessionId: session.sessionId, userId: session.userId, isAdmin: false },
            publishRemoval: true,
          });
        }
        session.sources.clear();
      }
      if (!session.hardCleaned && staleMs >= config.hardCleanupMs) {
        session.hardCleaned = true;
        hooks.clearUploadsAndCaches({ sessionId: session.sessionId, userId: session.userId, isAdmin: false });
        try {
          hooks.purgeSessionHealth(session.sessionId);
        } catch {
          // Session cleanup must not depend on Dashboard observability.
        }
        this.sessions.delete(session.sessionId);
      }
    }
  }
}

function isRuntimeHealthEvent(event: MonitorEvent): boolean {
  return event.type === "system:component_status" || event.type === "system:operation_error";
}

function runtimeHealthSourceId(event: MonitorEvent): string {
  if (typeof event.data?.source_id === "string") return event.data.source_id;
  return typeof event.camera_id === "string" ? event.camera_id : "";
}

function isRuntimeHealthEnvelope(envelope: DashboardStateEnvelope): boolean {
  const eventType = envelope.data?.event_type;
  return eventType === "system:component_status" || eventType === "system:operation_error";
}

function runtimeHealthEnvelopeSourceId(envelope: DashboardStateEnvelope): string {
  if (typeof envelope.data?.source_id === "string") return envelope.data.source_id;
  return typeof envelope.data?.camera_id === "string" ? envelope.data.camera_id : "";
}
