import { describe, it, expect, vi, afterEach } from "vitest";
import { monitorBus } from "../event-bus.js";
import type { MonitorEvent } from "../events.js";

describe("MonitorEventBus", () => {
  const handler = vi.fn();

  afterEach(() => {
    handler.mockClear();
    monitorBus.removeListener("monitor", handler);
  });

  it("publishes typed events with correct fields", () => {
    monitorBus.on("monitor", handler);

    monitorBus.publish("cam:source_added", { name: "front_door" }, "cam_01");

    expect(handler).toHaveBeenCalledOnce();
    const event: MonitorEvent = handler.mock.calls[0][0];
    expect(event.type).toBe("cam:source_added");
    expect(event.camera_id).toBe("cam_01");
    expect(event.data.name).toBe("front_door");
    expect(event.timestamp).toBeGreaterThan(0);
  });

  it("publishes events without camera_id", () => {
    monitorBus.on("monitor", handler);

    monitorBus.publish("system:service_health", { status: "ok" });

    expect(handler).toHaveBeenCalledOnce();
    const event: MonitorEvent = handler.mock.calls[0][0];
    expect(event.type).toBe("system:service_health");
    expect(event.camera_id).toBeUndefined();
  });

  it("supports multiple listeners", () => {
    const h2 = vi.fn();
    monitorBus.on("monitor", handler);
    monitorBus.on("monitor", h2);

    monitorBus.publish("system:pipeline_metrics", { segments: 5 });

    expect(handler).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();

    monitorBus.removeListener("monitor", h2);
  });
});
