import { describe, expect, it, vi } from "vitest";
import { DashboardRuntimeHealthRegistry, parseRuntimeHealthObservation } from "../services/dashboard-runtime-health.js";

function observation(sequence: number, status: "ok" | "down") {
  return {
    producer: "test",
    producer_epoch: "epoch-1",
    sequence,
    component: "embedder" as const,
    operation: "search",
    status,
    observed_at: Date.now() + sequence,
    scope: { user_id: "user-a", session_id: "session-a" },
    code: status === "down" ? "request_failed" : undefined,
  };
}

describe("DashboardRuntimeHealthRegistry", () => {
  it("projects failures and recovery without retaining an active failure", () => {
    const publish = vi.fn();
    const registry = new DashboardRuntimeHealthRegistry({ publish });

    registry.observe(observation(1, "down"));
    registry.observe(observation(2, "ok"));

    const snapshot = registry.snapshot(() => true);
    expect(snapshot.component_statuses).toEqual([
      expect.objectContaining({ capability: "Memory Search", status: "ok", failure_count: 0 }),
    ]);
    expect(snapshot.recent_operation_errors).toHaveLength(1);
    expect(publish.mock.calls.map((call) => call[0].type)).toEqual([
      "system:component_status",
      "system:operation_error",
      "system:component_status",
    ]);
  });

  it("uses explicit error wording for failed capabilities", () => {
    const registry = new DashboardRuntimeHealthRegistry({ publish: vi.fn() });
    registry.observe(observation(1, "down"));

    expect(registry.snapshot(() => true).component_statuses[0]?.summary).toBe(
      "Memory Search encountered an error. Chat may miss older events.",
    );
  });

  it("coalesces repeated status while publishing transitions immediately", () => {
    const publish = vi.fn();
    const registry = new DashboardRuntimeHealthRegistry({ publish });
    const first = observation(1, "ok");
    registry.observe(first);
    registry.observe({ ...observation(2, "ok"), observed_at: first.observed_at + 1_000 });
    registry.observe({ ...observation(3, "down"), observed_at: first.observed_at + 2_000 });

    expect(publish.mock.calls.map((call) => call[0].type)).toEqual([
      "system:component_status",
      "system:component_status",
      "system:operation_error",
    ]);
  });

  it("rejects stale observations and applies exact scope visibility", () => {
    const registry = new DashboardRuntimeHealthRegistry({ publish: vi.fn() });
    registry.observe(observation(2, "ok"));
    registry.observe(observation(1, "down"));

    expect(registry.snapshot((scope) => scope?.user_id === "user-a" && scope.session_id === "session-a").component_statuses).toHaveLength(1);
    expect(registry.snapshot((scope) => scope?.user_id === "user-a" && scope.session_id === "session-b").component_statuses).toHaveLength(0);
  });

  it("accepts only bounded structured webhook observations", () => {
    expect(parseRuntimeHealthObservation(observation(1, "down"))).toMatchObject({ component: "embedder", status: "down" });
    expect(parseRuntimeHealthObservation({ ...observation(1, "down"), component: "raw-provider-name" })).toBeNull();
    expect(parseRuntimeHealthObservation({ ...observation(1, "down"), sequence: "1" })).toBeNull();
  });

  it("does not let a delayed producer epoch overwrite newer state", () => {
    const registry = new DashboardRuntimeHealthRegistry({ publish: vi.fn() });
    const current = observation(1, "ok");
    registry.observe(current);
    registry.observe({
      ...observation(1, "down"),
      producer_epoch: "older-epoch",
      observed_at: current.observed_at - 100,
    });

    expect(registry.snapshot(() => true).component_statuses[0]?.status).toBe("ok");
  });

  it("does not let a retired producer epoch regain ownership", () => {
    const registry = new DashboardRuntimeHealthRegistry({ publish: vi.fn() });
    const first = observation(1, "down");
    registry.observe(first);
    registry.observe({
      ...observation(1, "ok"),
      producer_epoch: "epoch-2",
      observed_at: first.observed_at + 100,
    });
    registry.observe({
      ...observation(2, "down"),
      producer_epoch: first.producer_epoch,
      observed_at: first.observed_at + 200,
    });

    expect(registry.snapshot(() => true).component_statuses[0]?.status).toBe("ok");
  });

  it("rejects all observations after source removal until an explicit recreation", () => {
    const registry = new DashboardRuntimeHealthRegistry({ publish: vi.fn() });
    const removedAt = Date.now();
    registry.purgeSource("cam-a", removedAt);
    registry.observe({
      ...observation(1, "down"),
      component: "pipeline",
      operation: "run",
      observed_at: removedAt - 1,
      scope: { source_id: "cam-a" },
    });
    expect(registry.snapshot(() => true).component_statuses).toHaveLength(0);

    registry.observe({
      ...observation(2, "ok"),
      component: "pipeline",
      operation: "run",
      observed_at: removedAt + 1,
      scope: { source_id: "cam-a" },
    });
    expect(registry.snapshot(() => true).component_statuses).toHaveLength(0);

    registry.activateSource("cam-a");
    registry.observe({
      ...observation(3, "ok"),
      component: "pipeline",
      operation: "run",
      observed_at: removedAt + 2,
      scope: { source_id: "cam-a" },
    });
    expect(registry.snapshot(() => true).component_statuses).toEqual([
      expect.objectContaining({ status: "ok", scope: { source_id: "cam-a" } }),
    ]);
  });

  it("disables source issues while stopped and rejects late work until restart", () => {
    const publish = vi.fn();
    const registry = new DashboardRuntimeHealthRegistry({ publish });
    const stoppedAt = Date.now();
    registry.observe({
      ...observation(1, "down"),
      component: "vlm",
      operation: "analyze",
      observed_at: stoppedAt - 1,
      scope: { source_id: "cam-a" },
    });

    registry.deactivateSource("cam-a", stoppedAt);
    expect(registry.snapshot(() => true)).toEqual({
      component_statuses: [expect.objectContaining({
        component: "vlm",
        status: "disabled",
        failure_count: 0,
        scope: { source_id: "cam-a" },
      })],
      recent_operation_errors: [],
    });
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "system:component_status",
      data: expect.objectContaining({ status: "disabled", source_id: "cam-a" }),
    }));

    registry.observe({
      ...observation(2, "down"),
      component: "vlm",
      operation: "analyze",
      observed_at: stoppedAt + 1,
      scope: { source_id: "cam-a" },
    });
    expect(registry.snapshot(() => true).component_statuses[0]?.status).toBe("disabled");

    registry.activateSource("cam-a");
    registry.observe({
      ...observation(3, "ok"),
      component: "vlm",
      operation: "analyze",
      observed_at: stoppedAt + 2,
      scope: { source_id: "cam-a" },
    });
    expect(registry.snapshot(() => true).component_statuses[0]?.status).toBe("ok");
  });
});
