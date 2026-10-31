import { describe, expect, it, vi } from "vitest";
import { DashboardSessionManager } from "../services/dashboard-sessions.js";

function manager(onSessionStarted?: (sessionId: string) => void): DashboardSessionManager {
  return new DashboardSessionManager({
    config: {
      enabled: true,
      maxActiveSessions: 5,
      staleTtlMs: 60_000,
      stopGraceMs: 60_000,
      hardCleanupMs: 120_000,
      maxSourcesPerSession: 2,
    },
    getActiveSources: () => [],
    onSessionStarted,
  });
}

describe("Dashboard health scope visibility", () => {
  it("activates a successful session without depending on the observer", () => {
    const onSessionStarted = vi.fn(() => { throw new Error("observer failed"); });
    const sessions = manager(onSessionStarted);

    expect(sessions.startSession({ session_id: "session-a", user_id: "user-a" }).status).toBe(200);
    expect(onSessionStarted).toHaveBeenCalledWith("session-a");
  });

  it("requires every provided user and session field to match", () => {
    const sessions = manager();
    sessions.startSession({ session_id: "session-a", user_id: "user-a" });
    const scope = { sessionId: "session-a", userId: "user-a", isAdmin: false };

    expect(sessions.eventVisibleToSession({
      type: "system:component_status",
      timestamp: Date.now(),
      data: { user_id: "user-a", session_id: "session-a" },
    }, scope)).toBe(true);
    expect(sessions.eventVisibleToSession({
      type: "system:component_status",
      timestamp: Date.now(),
      data: { user_id: "user-a", session_id: "session-b" },
    }, scope)).toBe(false);
  });

  it("does not change visibility semantics for non-health events", () => {
    const sessions = manager();
    sessions.startSession({ session_id: "session-a", user_id: "user-a" });
    const scope = { sessionId: "session-a", userId: "user-a", isAdmin: false };

    expect(sessions.eventVisibleToSession({
      type: "memory:memory_added",
      timestamp: Date.now(),
      data: { user_id: "user-a", session_id: "another-session" },
    }, scope)).toBe(true);
    expect(sessions.envelopeVisibleToSession({
      domain: "memory",
      id: "memory-a",
      version: 1,
      op: "upsert",
      timestamp: Date.now(),
      scope: { user_id: "user-a", session_id: "another-session" },
      data: {},
    }, scope)).toBe(true);
  });

  it("requires source ownership even when a health event also carries the same user", () => {
    const sessions = manager();
    sessions.startSession({ session_id: "session-a", user_id: "user-a" });
    sessions.startSession({ session_id: "session-b", user_id: "user-a" });
    const sourceScope = { sessionId: "session-a", userId: "user-a", isAdmin: false };
    sessions.recordSourceOwner("cam-a", sourceScope);
    const otherSession = { sessionId: "session-b", userId: "user-a", isAdmin: false };

    const event = {
      type: "system:component_status" as const,
      timestamp: Date.now(),
      camera_id: "cam-a",
      data: { user_id: "user-a", source_id: "cam-a" },
    };
    expect(sessions.eventVisibleToSession(event, sourceScope)).toBe(true);
    expect(sessions.eventVisibleToSession(event, otherSession)).toBe(false);

    const envelope = {
      domain: "service" as const,
      id: "memory|write|user=user-a|source=cam-a",
      version: 1,
      op: "upsert" as const,
      timestamp: Date.now(),
      scope: { user_id: "user-a" },
      data: {
        event_type: "system:component_status",
        source_id: "cam-a",
        camera_id: "cam-a",
      },
    };
    expect(sessions.envelopeVisibleToSession(envelope, sourceScope)).toBe(true);
    expect(sessions.envelopeVisibleToSession(envelope, otherSession)).toBe(false);
  });
});
