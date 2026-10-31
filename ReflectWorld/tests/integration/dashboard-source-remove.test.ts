import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { DashboardServer, type SourcePurgeRequest, type SourceRemoveRequest } from "../../packages/reflectworld/src/services/dashboard-server.js";
import { PipelineStore } from "../../packages/reflectworld/src/store.js";
import { monitorBus } from "@reflectworld/shared";

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function postJson(port: number, path: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function getJson(port: number, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function collectDashboardWsMessages(port: number, cursor: number, waitMs = 50): Promise<any[]> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/dashboard?cursor=${cursor}`);
  const messages: any[] = [];
  ws.on("message", (raw) => {
    messages.push(JSON.parse(String(raw)));
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  await new Promise(resolve => setTimeout(resolve, waitMs));
  ws.close();
  return messages;
}

describe("DashboardServer source remove lifecycle", () => {
  let dashboard: DashboardServer | null = null;
  let port = 0;
  let tmpRoot = "";
  let uploadsDir = "";
  let store: PipelineStore | null = null;
  let upstream: Server | null = null;

  beforeEach(async () => {
    port = await getFreePort();
    tmpRoot = mkdtempSync(join(tmpdir(), "reflectworld-dashboard-remove-"));
    uploadsDir = join(tmpRoot, "uploads");
    mkdirSync(uploadsDir, { recursive: true });
  });

  afterEach(() => {
    dashboard?.stop();
    dashboard = null;
    upstream?.close();
    upstream = null;
    store?.close();
    store = null;
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("rejects cross-session source deletion before calling removeSource", async () => {
    const removeCalls: SourceRemoveRequest[] = [];
    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port,
      uploadsDir,
      dashboardSessions: { enabled: true },
      removeSource: async (req) => {
        removeCalls.push(req);
        return { ok: true, source_id: req.name };
      },
      getActiveSources: () => [{
        source_id: "cam-a",
        source_name: "cam-a",
        user_id: "user-a",
        session_id: "session-a",
        status: "active",
      }],
    });
    await dashboard.start();
    await postJson(port, "/api/dashboard/session/start", { session_id: "session-a", user_id: "user-a" });
    await postJson(port, "/api/dashboard/session/start", { session_id: "session-b", user_id: "user-b" });

    const res = await postJson(port, "/api/sources/remove", {
      source_id: "cam-a",
      session_id: "session-b",
      user_id: "user-b",
    });

    expect(res.status).toBe(404);
    expect(removeCalls).toHaveLength(0);
  });

  it("requires an admin token before granting admin sessions", async () => {
    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port,
      uploadsDir,
      dashboardSessions: { enabled: true, adminToken: "secret" },
    });
    await dashboard.start();

    const rejected = await postJson(port, "/api/dashboard/session/start", {
      session_id: "admin-session",
      user_id: "admin",
      is_admin: true,
    });
    expect(rejected.status).toBe(403);

    const accepted = await postJson(port, "/api/dashboard/session/start", {
      session_id: "admin-session",
      user_id: "admin",
      is_admin: true,
      admin_token: "secret",
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.ok).toBe(true);
  });

  it("does not allow an existing dashboard session to be rebound to another user", async () => {
    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port,
      uploadsDir,
      dashboardSessions: { enabled: true },
    });
    await dashboard.start();

    const first = await postJson(port, "/api/dashboard/session/start", {
      session_id: "session-a",
      user_id: "user-a",
    });
    const rebound = await postJson(port, "/api/dashboard/session/start", {
      session_id: "session-a",
      user_id: "user-b",
    });

    expect(first.status).toBe(200);
    expect(rebound.status).toBe(409);
    expect(rebound.body.error).toContain("different user_id");
  });

  it("sets hardened dashboard session cookies", async () => {
    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port,
      uploadsDir,
      dashboardSessions: { enabled: true },
    });
    await dashboard.start();

    const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "session-cookie", user_id: "user-cookie" }),
    });
    const cookie = res.headers.get("set-cookie") ?? "";

    expect(res.status).toBe(200);
    expect(cookie).toContain("vm_dashboard_session=");
    expect(cookie).toContain("vm_dashboard_user=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("rejects dashboard websocket connections without a multi-user session", async () => {
    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port,
      uploadsDir,
      dashboardSessions: { enabled: true },
    });
    await dashboard.start();

    await expect(new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/dashboard`);
      ws.once("open", () => {
        ws.close();
        reject(new Error("websocket opened without a dashboard session"));
      });
      ws.once("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? 0);
      });
      ws.once("error", reject);
    })).resolves.toBe(401);
  });

  it("requires a session for dashboard state and analysis status in multi-user mode", async () => {
    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port,
      uploadsDir,
      dashboardSessions: { enabled: true },
    });
    await dashboard.start();

    const state = await getJson(port, "/api/dashboard/state");
    const analysis = await getJson(port, "/api/analysis/status");

    expect(state).toMatchObject({
      status: 401,
      body: { error: "Dashboard session is required" },
    });
    expect(analysis).toMatchObject({
      status: 401,
      body: { error: "Dashboard session is required" },
    });
  });

  it("treats public mode as requiring dashboard sessions", async () => {
    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port,
      uploadsDir,
      dashboardSecurity: { publicMode: true },
    });
    await dashboard.start();

    const runtime = await getJson(port, "/api/dashboard/runtime");
    expect(runtime.body.multi_user).toBe(true);
    await expect(new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/dashboard`);
      ws.once("open", () => {
        ws.close();
        reject(new Error("websocket opened without a public-mode dashboard session"));
      });
      ws.once("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? 0);
      });
      ws.once("error", reject);
    })).resolves.toBe(401);
  });

  it("rejects cross-origin dashboard websocket upgrades in multi-user mode", async () => {
    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port,
      uploadsDir,
      dashboardSessions: { enabled: true },
    });
    await dashboard.start();
    await postJson(port, "/api/dashboard/session/start", { session_id: "session-a", user_id: "user-a" });

    await expect(new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/dashboard?session_id=session-a&user_id=user-a`, {
        headers: { Origin: "https://evil.example" },
      });
      ws.once("open", () => {
        ws.close();
        reject(new Error("websocket opened with a cross-origin header"));
      });
      ws.once("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? 0);
      });
      ws.once("error", reject);
    })).resolves.toBe(403);
  });

  it("limits websocket connections in strict dashboard security mode", async () => {
    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port,
      uploadsDir,
      dashboardSessions: { enabled: true },
      dashboardSecurity: { maxWsConnections: 1 },
    });
    await dashboard.start();
    await postJson(port, "/api/dashboard/session/start", { session_id: "session-a", user_id: "user-a" });
    const url = `ws://127.0.0.1:${port}/ws/dashboard?session_id=session-a&user_id=user-a`;
    const first = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      first.once("open", resolve);
      first.once("error", reject);
    });

    try {
      await expect(new Promise<number>((resolve, reject) => {
        const second = new WebSocket(url);
        second.once("open", () => {
          second.close();
          reject(new Error("second websocket opened despite connection limit"));
        });
        second.once("unexpected-response", (_req, res) => {
          resolve(res.statusCode ?? 0);
        });
        second.once("error", reject);
      })).resolves.toBe(429);
    } finally {
      first.close();
    }
  });

  it("rate limits dashboard chat per session in multi-user mode", async () => {
    const dashboardChat = vi.fn(async () => ({ ok: true, answer: "ok" }));
    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port,
      uploadsDir,
      dashboardSessions: { enabled: true },
      dashboardSecurity: { chatRateLimitPerMinute: 1 },
      dashboardChat,
    });
    await dashboard.start();
    await postJson(port, "/api/dashboard/session/start", { session_id: "session-a", user_id: "user-a" });

    const first = await postJson(port, "/api/dashboard/chat", {
      session_id: "session-a",
      user_id: "user-a",
      prompt: "What happened?",
    });
    const second = await postJson(port, "/api/dashboard/chat", {
      session_id: "session-a",
      user_id: "user-a",
      prompt: "Try again",
    });

    expect(first.status).toBe(200);
    expect(first.body.answer).toBe("ok");
    expect(second.status).toBe(429);
    expect(second.body.error).toContain("rate limit");
    expect(dashboardChat).toHaveBeenCalledTimes(1);
  });

  it("rate limits OpenAI-compatible dashboard chat completions", async () => {
    const dashboardChat = vi.fn(async () => ({ ok: true, answer: "ok" }));
    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port,
      uploadsDir,
      dashboardSessions: { enabled: true },
      dashboardSecurity: { chatRateLimitPerMinute: 1 },
      dashboardChat,
    });
    await dashboard.start();
    await postJson(port, "/api/dashboard/session/start", { session_id: "session-a", user_id: "user-a" });

    const body = {
      session_id: "session-a",
      user_id: "user-a",
      messages: [{ role: "user", content: "What happened?" }],
    };
    const first = await postJson(port, "/v1/chat/completions", body);
    const second = await postJson(port, "/v1/chat/completions", body);

    expect(first.status).toBe(200);
    expect(first.body.choices?.[0]?.message?.content).toBe("ok");
    expect(second.status).toBe(429);
    expect(second.body.error?.message).toContain("rate limit");
    expect(dashboardChat).toHaveBeenCalledTimes(1);
  });

  it("cleans expired dashboard chat rate limit buckets during session cleanup", async () => {
    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port,
      uploadsDir,
      dashboardSessions: { enabled: true },
      dashboardSecurity: { chatRateLimitPerMinute: 1 },
      dashboardChat: async () => ({ ok: true, answer: "ok" }),
    });
    const access = dashboard as unknown as {
      chatRateBuckets: Map<string, { windowStart: number; count: number }>;
      cleanupChatRateBuckets(now?: number): void;
    };
    access.chatRateBuckets.set("ip:stale", { windowStart: 1_000, count: 1 });
    access.chatRateBuckets.set("ip:fresh", { windowStart: 61_000, count: 1 });

    access.cleanupChatRateBuckets(62_000);

    expect(access.chatRateBuckets.has("ip:stale")).toBe(false);
    expect(access.chatRateBuckets.has("ip:fresh")).toBe(true);
  });

  it("requires an admin session for multi-user runtime config updates", async () => {
    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port,
      uploadsDir,
      dashboardSessions: { enabled: true, adminToken: "secret" },
    });
    await dashboard.start();
    await postJson(port, "/api/dashboard/session/start", { session_id: "session-a", user_id: "user-a" });
    await postJson(port, "/api/dashboard/session/start", {
      session_id: "admin-session",
      user_id: "admin-user",
      is_admin: true,
      admin_token: "secret",
    });

    const rejected = await postJson(port, "/api/config", {
      session_id: "session-a",
      user_id: "user-a",
      key: "sampling_rate",
      value: "3",
    });
    expect(rejected.status).toBe(403);

    const accepted = await postJson(port, "/api/config", {
      session_id: "admin-session",
      user_id: "admin-user",
      key: "sampling_rate",
      value: "3",
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ ok: true, key: "sampling_rate", value: "3" });
  });

  it("requires session and enforces source limits for the legacy add-source endpoint", async () => {
    const addCalls: Array<{ source: string; name?: string; opts?: { userId?: string; sessionId?: string } }> = [];
    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port,
      uploadsDir,
      dashboardSessions: { enabled: true, maxSourcesPerSession: 1 },
      addSource: async (source, name, opts) => {
        addCalls.push({ source, name, opts });
        return JSON.stringify({ success: true, source: { id: `cam-${addCalls.length}`, name: name ?? source } });
      },
    });
    await dashboard.start();

    const noSession = await postJson(port, "/api/sources", { source: "rtsp://example/no-session", name: "No Session" });
    expect(noSession.status).toBe(401);
    expect(addCalls).toHaveLength(0);

    await postJson(port, "/api/dashboard/session/start", { session_id: "session-a", user_id: "user-a" });
    const accepted = await postJson(port, "/api/sources", {
      session_id: "session-a",
      user_id: "user-a",
      source: "rtsp://example/one",
      name: "One",
    });
    expect(accepted.status).toBe(200);
    expect(addCalls).toEqual([{
      source: "rtsp://example/one",
      name: "One",
      opts: { userId: "user-a", sessionId: "session-a" },
    }]);

    const limited = await postJson(port, "/api/sources", {
      session_id: "session-a",
      user_id: "user-a",
      source: "rtsp://example/two",
      name: "Two",
    });
    expect(limited.status).toBe(429);
    expect(addCalls).toHaveLength(1);
  });

  it("requires session and user to both match when active source has both owner fields", async () => {
    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port,
      uploadsDir,
      dashboardSessions: { enabled: true },
      getActiveSources: () => [{
        source_id: "cam-owned",
        source_name: "cam-owned",
        user_id: "user-a",
        session_id: "session-a",
        status: "active",
      }],
    });
    await dashboard.start();
    await postJson(port, "/api/dashboard/session/start", { session_id: "session-a", user_id: "user-a" });
    await postJson(port, "/api/dashboard/session/start", { session_id: "session-b", user_id: "user-a" });

    const owner = await getJson(port, "/api/dashboard/state?session_id=session-a&user_id=user-a");
    const sameUserDifferentSession = await getJson(port, "/api/dashboard/state?session_id=session-b&user_id=user-a");

    expect(owner.body.sources.map((source: any) => source.source_id)).toContain("cam-owned");
    expect(sameUserDifferentSession.body.sources.map((source: any) => source.source_id)).not.toContain("cam-owned");
  });

  it("exposes canonical source state through dashboard snapshot", async () => {
    store = new PipelineStore(join(tmpRoot, "store"));
    store.logResult(
      {
        segment_id: "seg-source-summary",
        camera_id: "cam-snapshot",
        mode: "stream",
        frames: [],
        raw_url: "",
        timestamp: 1_000,
        duration_sec: 5,
      } as any,
      {
        segment_id: "seg-source-summary",
        camera_id: "cam-snapshot",
        mode: "stream",
        event_id: "evt-source-summary",
        perception_memory: {
          summary: "A person is near the front door.",
          detailed_summary: "",
          security_risk: false,
          timestamp: 1_000,
          entities: [],
          perception_level: 0,
          strategy_context: "stream/level0",
          is_static_scene: false,
        },
        media_urls: {},
      } as any,
    );
    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port,
      uploadsDir,
      store,
      getActiveSources: () => [{
        source_id: "cam-snapshot",
        source_name: "front door",
        input: "rtsp://example/front-door",
        protocol: "rtsp",
        status: "active",
        created_at: 1_000,
      }],
    });
    await dashboard.start();

    const res = await getJson(port, "/api/dashboard/state");

    expect(res.status).toBe(200);
    expect(typeof res.body.cursor).toBe("number");
    expect(res.body.sources).toHaveLength(1);
    expect(res.body.sources[0]).toMatchObject({
      source_id: "cam-snapshot",
      label: "front door",
      kind: "stream_url",
      display_status: "unavailable",
      input_kind: "url",
      summary: "A person is near the front door.",
      watch_status: "running",
      can_stop: true,
      can_delete: true,
    });
  });

  it("projects canonical segment targets with new-entity badge fields", async () => {
    store = new PipelineStore(join(tmpRoot, "store"));
    store.logResult(
      {
        segment_id: "seg-new-entity",
        camera_id: "cam-segment",
        mode: "stream",
        frames: [],
        raw_url: "",
        timestamp: 1_000,
        duration_sec: 5,
      } as any,
      {
        segment_id: "seg-new-entity",
        camera_id: "cam-segment",
        mode: "stream",
        event_id: "evt-new-entity",
        perception_memory: {
          summary: "A person entered the room.",
          detailed_summary: "A person entered the room.",
          security_risk: false,
          matched_rule_ids: ["rule-proc-1"],
          timestamp: 1_000,
          entities: [{
            type: "person",
            entity_id: "entity-1",
            appearance: "blue jacket",
            behavior: "entered the room",
            is_new_entity: true,
            name: "Lily",
            subject_index: 7,
            first_seen: "2026-06-03T10:00:00Z",
          }],
          perception_level: 0,
          strategy_context: "stream/level0",
          is_static_scene: false,
        },
        media_urls: {},
      } as any,
    );
    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port,
      uploadsDir,
      store,
    });
    await dashboard.start();

    const res = await getJson(port, "/api/dashboard/state");

    expect(res.status).toBe(200);
    expect(res.body.segments).toHaveLength(1);
    expect(res.body.segments[0].targets[0]).toMatchObject({
      type: "person",
      entity_id: "entity-1",
      name: "Lily",
      subject_index: 7,
      ref: "person:7",
      label: "Lily",
      has_name: true,
      first_seen: "2026-06-03T10:00:00Z",
      is_new: true,
    });
    expect(res.body.segments[0].entity_refs).toEqual(["person:7"]);
    expect(res.body.segments[0].entity_ids).toEqual(["entity-1"]);
    expect(res.body.entity_ref_map).toBeUndefined();
    expect(res.body.segments[0].triggered_rules).toEqual(["rule-proc-1"]);
  });

  it("scopes traces and segment clips to the owning dashboard session", async () => {
    store = new PipelineStore(join(tmpRoot, "store"));
    store.logResult(
      {
        segment_id: "seg-owned",
        camera_id: "cam-owned",
        mode: "stream",
        frames: [],
        raw_url: "",
        timestamp: 1_000,
        duration_sec: 5,
      } as any,
      {
        segment_id: "seg-owned",
        camera_id: "cam-owned",
        mode: "stream",
        event_id: "evt-owned",
        perception_memory: {
          summary: "owned segment",
          detailed_summary: "owned segment",
          security_risk: false,
          entities: [],
          perception_level: 0,
          strategy_context: "stream/level0",
          is_static_scene: false,
        },
      },
      { notify_user: false },
    );
    store.saveTrace({
      segment_id: "seg-owned",
      camera_id: "cam-owned",
      timestamps: {
        first_frame_at: 1,
        segment_built_at: 2,
        analysis_started_at: 3,
        analysis_completed_at: 4,
      },
      latencies: {
        accumulation_ms: 1,
        dispatch_ms: 1,
        perception_ms: 2,
        e2e_ms: 4,
      },
      context: {
        mode: "stream",
        level: 0,
        frame_count: 1,
        analyzers_run: [],
      },
    } as any);
    for (let i = 0; i < 20; i++) {
      store.saveTrace({
        segment_id: `seg-hidden-${i}`,
        camera_id: `cam-hidden-${i}`,
        timestamps: {
          first_frame_at: 100 + i,
          segment_built_at: 101 + i,
          analysis_started_at: 102 + i,
          analysis_completed_at: 103 + i,
        },
        latencies: {
          accumulation_ms: 1,
          dispatch_ms: 1,
          perception_ms: 2,
          e2e_ms: 4,
        },
        context: {
          mode: "stream",
          level: 0,
          frame_count: 1,
          analyzers_run: [],
        },
      } as any);
    }
    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port,
      uploadsDir,
      store,
      dashboardSessions: { enabled: true },
      getActiveSources: () => [{
        source_id: "cam-owned",
        source_name: "cam-owned",
        user_id: "user-a",
        session_id: "session-a",
        status: "active",
      }],
    });
    await dashboard.start();
    await postJson(port, "/api/dashboard/session/start", { session_id: "session-a", user_id: "user-a" });
    await postJson(port, "/api/dashboard/session/start", { session_id: "session-b", user_id: "user-b" });

    const ownerTraces = await getJson(port, "/api/traces?session_id=session-a&user_id=user-a&limit=1");
    expect(ownerTraces.status).toBe(200);
    expect(ownerTraces.body.count).toBe(1);

    const otherTraces = await getJson(port, "/api/traces?session_id=session-b&user_id=user-b");
    expect(otherTraces.status).toBe(200);
    expect(otherTraces.body.count).toBe(0);

    const clip = await fetch(`http://127.0.0.1:${port}/api/segment/seg-owned/clip?session_id=session-b&user_id=user-b`);
    expect(clip.status).toBe(404);
  });

  it("scopes live proxy and generated media to the owning dashboard session", async () => {
    const go2rtcPort = await getFreePort();
    let upstreamHits = 0;
    upstream = createServer((req, res) => {
      upstreamHits += 1;
      if (req.url?.startsWith("/api/streams")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          "cam-owned": {
            producers: [{ receivers: [{ bytes: 128 }] }],
            consumers: [],
          },
        }));
        return;
      }
      if (req.url?.startsWith("/api/frame.jpeg")) {
        res.writeHead(200, { "Content-Type": "image/jpeg" });
        res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => upstream!.listen(go2rtcPort, "127.0.0.1", resolve));

    const mediaDir = join(tmpRoot, "media");
    const ownedMediaDir = join(mediaDir, "cam-owned", "keyframe");
    mkdirSync(ownedMediaDir, { recursive: true });
    writeFileSync(join(ownedMediaDir, "seg-owned_0.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port,
      uploadsDir,
      mediaDirs: [mediaDir],
      go2rtcApiPort: go2rtcPort,
      dashboardSessions: { enabled: true },
      getActiveSources: () => [{
        source_id: "cam-owned",
        source_name: "cam-owned",
        user_id: "user-a",
        session_id: "session-a",
        status: "active",
      }],
    });
    await dashboard.start();
    await postJson(port, "/api/dashboard/session/start", { session_id: "session-a", user_id: "user-a" });
    await postJson(port, "/api/dashboard/session/start", { session_id: "session-b", user_id: "user-b" });

    const ownerStatus = await getJson(port, "/api/live/status?src=cam-owned&session_id=session-a&user_id=user-a");
    expect(ownerStatus.status).toBe(200);
    expect(ownerStatus.body.active).toBe(true);
    const ownerStatusCached = await getJson(port, "/api/live/status?src=cam-owned&session_id=session-a&user_id=user-a");
    expect(ownerStatusCached.status).toBe(200);
    expect(ownerStatusCached.body.active).toBe(true);

    const otherStatus = await getJson(port, "/api/live/status?src=cam-owned&session_id=session-b&user_id=user-b");
    expect(otherStatus.status).toBe(404);

    const ownerFrame = await fetch(`http://127.0.0.1:${port}/api/live/frame.jpeg?src=cam-owned&session_id=session-a&user_id=user-a`);
    expect(ownerFrame.status).toBe(200);

    const otherFrame = await fetch(`http://127.0.0.1:${port}/api/live/frame.jpeg?src=cam-owned&session_id=session-b&user_id=user-b`);
    expect(otherFrame.status).toBe(404);

    const otherStream = await fetch(`http://127.0.0.1:${port}/api/live/stream.mjpeg?src=cam-owned&session_id=session-b&user_id=user-b`);
    expect(otherStream.status).toBe(404);

    const ownerMedia = await fetch(`http://127.0.0.1:${port}/media/cam-owned/keyframe/seg-owned_0.jpg?session_id=session-a&user_id=user-a`);
    expect(ownerMedia.status).toBe(200);

    const otherMedia = await fetch(`http://127.0.0.1:${port}/media/cam-owned/keyframe/seg-owned_0.jpg?session_id=session-b&user_id=user-b`);
    expect(otherMedia.status).toBe(404);

    expect(upstreamHits).toBe(2);
  });

  it("keeps a completed upload file when removing a missing upload source and purges memory once", async () => {
    const uploadName = "session_session-a_clip.mp4";
    const uploadPath = join(uploadsDir, uploadName);
    writeFileSync(uploadPath, "fake video");
    const purgeCalls: SourcePurgeRequest[] = [];
    const removeCalls: SourceRemoveRequest[] = [];
    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port,
      uploadsDir,
      dashboardSessions: { enabled: true },
      removeSource: async (req) => {
        removeCalls.push(req);
        return { error: "not found", statusCode: 404 };
      },
      purgeSource: async (req) => {
        purgeCalls.push(req);
        return { ok: true };
      },
      getActiveSources: () => [],
    });
    await dashboard.start();
    await postJson(port, "/api/dashboard/session/start", { session_id: "session-a", user_id: "user-a" });

    const res = await postJson(port, "/api/sources/remove", {
      source_id: "video-1",
      video_id: `upload/${uploadName}`,
      remove_upload: true,
      session_id: "session-a",
      user_id: "user-a",
    });

    expect(res.status).toBe(200);
    expect(res.body.upload_removed).toBeUndefined();
    expect(existsSync(uploadPath)).toBe(true);
    expect(removeCalls).toHaveLength(0);
    expect(purgeCalls).toEqual([{
      sourceId: "video-1",
      videoId: `upload/${uploadName}`,
      sessionId: "session-a",
      userId: "user-a",
    }]);
  });

  it("returns an error when completed upload memory purge fails", async () => {
    const uploadName = "session_session-a_clip.mp4";
    const uploadPath = join(uploadsDir, uploadName);
    writeFileSync(uploadPath, "fake video");
    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port,
      uploadsDir,
      dashboardSessions: { enabled: true },
      purgeSource: async () => ({ error: "memory purge failed", statusCode: 500 }),
      getActiveSources: () => [],
    });
    await dashboard.start();
    await postJson(port, "/api/dashboard/session/start", { session_id: "session-a", user_id: "user-a" });

    const res = await postJson(port, "/api/sources/remove", {
      source_id: "video-1",
      video_id: `upload/${uploadName}`,
      remove_upload: true,
      session_id: "session-a",
      user_id: "user-a",
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("memory purge failed");
  });

  it("projects local idle-skip static runs as static gaps while keeping VLM static segments as cards", async () => {
    store = new PipelineStore(join(tmpRoot, "store"));
    for (const [segmentId, cameraId, timestamp] of [
      ["seg-live-static-a", "cam-static", 1_000],
      ["seg-live-static-b", "cam-static", 6_000],
      ["seg-upload-static", "video-static", 20_000],
      ["seg-vlm-static", "cam-vlm-static", 30_000],
    ] as const) {
      const localIdleSkip = segmentId !== "seg-vlm-static";
      store.logResult(
        {
          segment_id: segmentId,
          camera_id: cameraId,
          mode: "stream",
          frames: [],
          raw_url: "",
          timestamp,
          duration_sec: 5,
        } as any,
        {
          segment_id: segmentId,
          camera_id: cameraId,
          mode: "stream",
          event_id: `evt-${segmentId}`,
          perception_memory: {
            summary: "Static scene",
            detailed_summary: "Static scene",
            security_risk: false,
            timestamp,
            entities: [],
            perception_level: 0,
            strategy_context: "stream/level0",
            is_static_scene: true,
          },
          media_urls: {},
        } as any,
        {
          is_static_scene: true,
          vlm_model: localIdleSkip ? "local-idle-skip" : "gpt-5-mini",
          vlm_latency_ms: localIdleSkip ? 0 : 1234,
        },
      );
    }
    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port,
      uploadsDir,
      store,
      getActiveSources: () => [
        {
          source_id: "cam-static",
          source_name: "Live static",
          input: "rtsp://example/static",
          protocol: "rtsp",
          status: "active",
        },
        {
          source_id: "video-static",
          source_name: "Upload static",
          protocol: "file",
          video_id: "upload/static.mp4",
          status: "stopped",
        },
        {
          source_id: "cam-vlm-static",
          source_name: "VLM static",
          input: "rtsp://example/vlm-static",
          protocol: "rtsp",
          status: "active",
        },
      ],
    });
    await dashboard.start();

    const res = await getJson(port, "/api/dashboard/state");

    expect(res.status).toBe(200);
    const liveGap = res.body.segments.find((segment: any) => segment.camera_id === "cam-static");
    const uploadStatic = res.body.segments.find((segment: any) => segment.camera_id === "video-static");
    const vlmStatic = res.body.segments.find((segment: any) => segment.camera_id === "cam-vlm-static");
    expect(liveGap).toMatchObject({
      timeline_type: "static_gap",
      is_static: true,
      merged_count: 2,
      summary: "Static Scene",
    });
    expect(liveGap.duration_sec).toBe(10);
    expect(uploadStatic).toMatchObject({
      timeline_type: "segment",
      is_static: true,
      merged_count: 1,
      summary: "Static scene",
    });
    expect(vlmStatic).toMatchObject({
      timeline_type: "segment",
      is_static: true,
      merged_count: 1,
      summary: "Static scene",
    });
  });

  it("projects reconnecting source status with display_status recomputed", async () => {
    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port,
      uploadsDir,
      getActiveSources: () => [{
        source_id: "cam-reconnect",
        source_name: "Front door",
        input: "rtsp://example/front-door",
        protocol: "rtsp",
        status: "active",
        created_at: 1_000,
      }],
    });
    await dashboard.start();

    monitorBus.publish("cam:source_reconnecting", {
      source_id: "cam-reconnect",
      source_name: "Front door",
    }, "cam-reconnect");
    await new Promise(resolve => setTimeout(resolve, 20));

    const res = await getJson(port, "/api/dashboard/state");

    expect(res.status).toBe(200);
    expect(res.body.sources[0]).toMatchObject({
      source_id: "cam-reconnect",
      status: "reconnecting",
      display_status: "reconnecting",
      last_error: "Reconnecting stream",
    });
  });

  it("does not replay dashboard event log on initial cursor but replays later cursors", async () => {
    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port,
      uploadsDir,
    });
    await dashboard.start();

    monitorBus.publish("cam:source_added", {
      source_id: "cam-old",
      source_name: "Old source",
    }, "cam-old");
    await new Promise(resolve => setTimeout(resolve, 20));

    monitorBus.publish("cam:source_added", {
      source_id: "cam-new",
      source_name: "New source",
    }, "cam-new");
    await new Promise(resolve => setTimeout(resolve, 20));

    const initialMessages = await collectDashboardWsMessages(port, 0);
    expect(initialMessages.some((msg) => msg.id === "cam-old" || msg.id === "cam-new")).toBe(false);

    const replayMessages = await collectDashboardWsMessages(port, 1);
    expect(replayMessages.some((msg) => msg.id === "cam-old")).toBe(false);
    expect(replayMessages.some((msg) => msg.id === "cam-new")).toBe(true);
  });

  it("filters legacy recent segments by dashboard session even without camera_id", async () => {
    store = new PipelineStore(join(tmpRoot, "store"));
    store.logResult(
      {
        segment_id: "seg-session-a",
        camera_id: "cam-a",
        mode: "stream",
        frames: [],
        raw_url: "",
        timestamp: 1_000,
        duration_sec: 5,
      } as any,
      {
        segment_id: "seg-session-a",
        camera_id: "cam-a",
        mode: "stream",
        event_id: "evt-session-a",
        perception_memory: {
          summary: "Visible to session A",
          detailed_summary: "",
          security_risk: false,
          timestamp: 1_000,
          entities: [],
          perception_level: 0,
          strategy_context: "stream/level0",
          is_static_scene: false,
        },
        media_urls: {},
      } as any,
    );
    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port,
      uploadsDir,
      store,
      dashboardSessions: { enabled: true },
      getActiveSources: () => [{
        source_id: "cam-a",
        source_name: "cam-a",
        user_id: "user-a",
        session_id: "session-a",
        status: "active",
      }],
    });
    await dashboard.start();
    await postJson(port, "/api/dashboard/session/start", { session_id: "session-a", user_id: "user-a" });
    await postJson(port, "/api/dashboard/session/start", { session_id: "session-b", user_id: "user-b" });

    const visible = await getJson(port, "/api/segments/recent?limit=10&session_id=session-a&user_id=user-a");
    const hidden = await getJson(port, "/api/segments/recent?limit=10&session_id=session-b&user_id=user-b");

    expect(visible.status).toBe(200);
    expect(visible.body.events.some((event: any) => event.data?.segment_id === "seg-session-a")).toBe(true);
    expect(hidden.status).toBe(200);
    expect(hidden.body.events).toEqual([]);
  });

  it("does not forward dashboard session query params to ReflectWorld in single-user mode", async () => {
    const upstreamPort = await getFreePort();
    let upstreamUrl = "";
    upstream = createServer((req, res) => {
      upstreamUrl = req.url ?? "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ memories: [] }));
    });
    await new Promise<void>((resolve, reject) => {
      upstream!.listen(upstreamPort, "127.0.0.1", resolve);
      upstream!.on("error", reject);
    });
    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port,
      uploadsDir,
      reflectworldEndpoint: `http://127.0.0.1:${upstreamPort}`,
    });
    await dashboard.start();

    const res = await getJson(port, "/api/reflectworld/memories?memory_type=semantic&camera_id=cam-a&session_id=session-a&user_id=random-user");

    expect(res.status).toBe(200);
    expect(upstreamUrl).toContain("/memories?");
    expect(upstreamUrl).toContain("memory_type=semantic");
    expect(upstreamUrl).toContain("camera_id=cam-a");
    expect(upstreamUrl).not.toContain("session_id=");
    expect(upstreamUrl).not.toContain("user_id=");
  });

  it("requires a dashboard session before proxying ReflectWorld in multi-user mode", async () => {
    const upstreamPort = await getFreePort();
    let upstreamHits = 0;
    upstream = createServer((_req, res) => {
      upstreamHits += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ memories: [] }));
    });
    await new Promise<void>((resolve, reject) => {
      upstream!.listen(upstreamPort, "127.0.0.1", resolve);
      upstream!.on("error", reject);
    });
    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port,
      uploadsDir,
      dashboardSessions: { enabled: true },
      reflectworldEndpoint: `http://127.0.0.1:${upstreamPort}`,
    });
    await dashboard.start();

    const res = await getJson(port, "/api/reflectworld/memories?memory_type=semantic&user_id=victim-user");

    expect(res.status).toBe(401);
    expect(upstreamHits).toBe(0);
  });

  it("derives proxied ReflectWorld user_id from the dashboard session", async () => {
    const upstreamPort = await getFreePort();
    let upstreamUrl = "";
    let upstreamBody: any = null;
    upstream = createServer(async (req, res) => {
      upstreamUrl = req.url ?? "";
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      upstreamBody = raw ? JSON.parse(raw) : {};
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ memories: [] }));
    });
    await new Promise<void>((resolve, reject) => {
      upstream!.listen(upstreamPort, "127.0.0.1", resolve);
      upstream!.on("error", reject);
    });
    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port,
      uploadsDir,
      dashboardSessions: { enabled: true },
      reflectworldEndpoint: `http://127.0.0.1:${upstreamPort}`,
    });
    await dashboard.start();
    await postJson(port, "/api/dashboard/session/start", { session_id: "session-a", user_id: "user-a" });

    const res = await fetch(`http://127.0.0.1:${port}/api/reflectworld/memories?memory_type=semantic&user_id=victim-user`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-dashboard-session-id": "session-a",
        "x-dashboard-user-id": "user-a",
      },
      body: JSON.stringify({ session_id: "session-a", user_id: "victim-user", memory_type: "semantic" }),
    });

    expect(res.status).toBe(200);
    expect(upstreamUrl).toContain("memory_type=semantic");
    expect(upstreamUrl).toContain("user_id=user-a");
    expect(upstreamUrl).not.toContain("session_id=");
    expect(upstreamUrl).not.toContain("victim-user");
    expect(upstreamBody).toMatchObject({ user_id: "user-a", memory_type: "semantic" });
    expect(upstreamBody).not.toHaveProperty("session_id");
  });

  it("blocks destructive ReflectWorld proxy requests for non-admin sessions", async () => {
    const upstreamPort = await getFreePort();
    let upstreamHits = 0;
    upstream = createServer((_req, res) => {
      upstreamHits += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve, reject) => {
      upstream!.listen(upstreamPort, "127.0.0.1", resolve);
      upstream!.on("error", reject);
    });
    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port,
      uploadsDir,
      dashboardSessions: { enabled: true },
      reflectworldEndpoint: `http://127.0.0.1:${upstreamPort}`,
    });
    await dashboard.start();
    await postJson(port, "/api/dashboard/session/start", { session_id: "session-a", user_id: "user-a" });

    const res = await fetch(`http://127.0.0.1:${port}/api/reflectworld/memories?session_id=session-a&user_id=user-a`, {
      method: "DELETE",
    });

    expect(res.status).toBe(403);
    expect(upstreamHits).toBe(0);
  });

  it("allows deleting a single ReflectWorld memory owned by the dashboard session", async () => {
    const upstreamPort = await getFreePort();
    const upstreamUrls: string[] = [];
    upstream = createServer((req, res) => {
      upstreamUrls.push(`${req.method} ${req.url ?? ""}`);
      if (req.method === "GET" && req.url?.startsWith("/memories/rule-1")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          reflectworld_procedural: {
            id: "rule-1",
            memory: "Keep the front door clear.",
            user_id: "user-a",
          },
        }));
        return;
      }
      if (req.method === "DELETE" && req.url?.startsWith("/memories/rule-1")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((resolve, reject) => {
      upstream!.listen(upstreamPort, "127.0.0.1", resolve);
      upstream!.on("error", reject);
    });
    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port,
      uploadsDir,
      dashboardSessions: { enabled: true },
      reflectworldEndpoint: `http://127.0.0.1:${upstreamPort}`,
    });
    await dashboard.start();
    await postJson(port, "/api/dashboard/session/start", { session_id: "session-a", user_id: "user-a" });

    const res = await fetch(`http://127.0.0.1:${port}/api/reflectworld/memories/rule-1?memory_type=procedural&session_id=session-a&user_id=user-a`, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    expect(upstreamUrls).toEqual([
      "GET /memories/rule-1?memory_type=procedural",
      "DELETE /memories/rule-1?memory_type=procedural&user_id=user-a",
    ]);
  });

  it("does not forward single-memory deletes for memories owned by another user", async () => {
    const upstreamPort = await getFreePort();
    const upstreamUrls: string[] = [];
    upstream = createServer((req, res) => {
      upstreamUrls.push(`${req.method} ${req.url ?? ""}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        reflectworld_procedural: {
          id: "rule-1",
          memory: "Victim rule.",
          user_id: "victim-user",
        },
      }));
    });
    await new Promise<void>((resolve, reject) => {
      upstream!.listen(upstreamPort, "127.0.0.1", resolve);
      upstream!.on("error", reject);
    });
    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port,
      uploadsDir,
      dashboardSessions: { enabled: true },
      reflectworldEndpoint: `http://127.0.0.1:${upstreamPort}`,
    });
    await dashboard.start();
    await postJson(port, "/api/dashboard/session/start", { session_id: "session-a", user_id: "user-a" });

    const res = await fetch(`http://127.0.0.1:${port}/api/reflectworld/memories/rule-1?memory_type=procedural&session_id=session-a&user_id=user-a`, {
      method: "DELETE",
    });

    expect(res.status).toBe(403);
    expect(upstreamUrls).toEqual(["GET /memories/rule-1?memory_type=procedural"]);
  });

  it("adds dashboard display refs to proxied semantic memories without rewriting entity ids", async () => {
    store = new PipelineStore(join(tmpRoot, "store"));
    store.logResult(
      {
        segment_id: "seg-memory-ref",
        camera_id: "cam-memory",
        mode: "stream",
        frames: [],
        raw_url: "",
        timestamp: 1_000,
        duration_sec: 5,
      } as any,
      {
        segment_id: "seg-memory-ref",
        camera_id: "cam-memory",
        mode: "stream",
        event_id: "evt-memory-ref",
        perception_memory: {
          summary: "Lily entered.",
          detailed_summary: "",
          security_risk: false,
          timestamp: 1_000,
          entities: [{
            type: "person",
            entity_id: "entity-1",
            subject_index: 7,
            name: "Lily",
          }],
          perception_level: 0,
          strategy_context: "stream/level0",
          is_static_scene: false,
        },
        media_urls: {},
      } as any,
    );
    const upstreamPort = await getFreePort();
    upstream = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        memories: [{
          id: "mem-1",
          entity_id: "entity-1",
          memory: "Lily often appears near the door.",
        }],
      }));
    });
    await new Promise<void>((resolve, reject) => {
      upstream!.listen(upstreamPort, "127.0.0.1", resolve);
      upstream!.on("error", reject);
    });
    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port,
      uploadsDir,
      store,
      reflectworldEndpoint: `http://127.0.0.1:${upstreamPort}`,
    });
    await dashboard.start();

    const res = await getJson(port, "/api/reflectworld/memories?memory_type=semantic&camera_id=cam-memory");

    expect(res.status).toBe(200);
    expect(res.body.memories[0].entity_id).toBe("entity-1");
    expect(res.body.memories[0].entity_ref).toBe("person:7");
  });
});
