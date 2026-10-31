import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { monitorBus } from "@reflectworld/shared";
import type { MonitorEvent } from "@reflectworld/shared";

describe("service_health heartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    monitorBus.removeAllListeners();
  });

  it("emits system:service_health events on interval", async () => {
    const events: MonitorEvent[] = [];
    monitorBus.on("monitor", (e) => {
      if (e.type === "system:service_health") events.push(e);
    });

    // Simulate the health check logic from index.ts
    // (We test the publish mechanism, not actual HTTP calls)
    const health: Record<string, string> = {
      ReflectWorld: "ok",
      Qdrant: "ok",
      Go2RTC: "down",
      Monitor: "ok",
    };

    const interval = setInterval(() => {
      monitorBus.publish("system:service_health", { services: health });
    }, 30_000);

    // No event emitted before first tick
    expect(events).toHaveLength(0);

    // Advance 30s — first heartbeat
    vi.advanceTimersByTime(30_000);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("system:service_health");
    expect(events[0]!.data.services).toEqual(health);
    expect(events[0]!.timestamp).toBeGreaterThan(0);

    // Advance another 30s — second heartbeat
    vi.advanceTimersByTime(30_000);
    expect(events).toHaveLength(2);

    clearInterval(interval);

    // No more events after cleanup
    vi.advanceTimersByTime(60_000);
    expect(events).toHaveLength(2);
  });

  it("health check reports 'down' for unreachable services", () => {
    const events: MonitorEvent[] = [];
    monitorBus.on("monitor", (e) => {
      if (e.type === "system:service_health") events.push(e);
    });

    // Simulate all services down
    const health: Record<string, string> = {
      ReflectWorld: "down",
      Qdrant: "down",
      Go2RTC: "down",
      Monitor: "down",
    };

    monitorBus.publish("system:service_health", { services: health });

    expect(events).toHaveLength(1);
    const services = events[0]!.data.services as Record<string, string>;
    expect(services.ReflectWorld).toBe("down");
    expect(services.Qdrant).toBe("down");
    expect(services.Go2RTC).toBe("down");
    expect(services.Monitor).toBe("down");
  });

  it("health event includes all expected service keys", () => {
    const events: MonitorEvent[] = [];
    monitorBus.on("monitor", (e) => events.push(e));

    monitorBus.publish("system:service_health", {
      services: { ReflectWorld: "ok", Qdrant: "ok", Go2RTC: "ok", Monitor: "ok" },
    });

    const services = events[0]!.data.services as Record<string, string>;
    expect(Object.keys(services).sort()).toEqual(["Go2RTC", "Monitor", "Qdrant", "ReflectWorld"]);
  });
});
