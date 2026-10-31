import { describe, it, expect, afterEach } from "vitest";
import { monitorBus } from "@reflectworld/shared";
import type { MonitorEvent } from "@reflectworld/shared";

describe("Cam monitor events", () => {
  const events: MonitorEvent[] = [];
  const handler = (e: MonitorEvent) => events.push(e);

  afterEach(() => {
    events.length = 0;
    monitorBus.removeListener("monitor", handler);
  });

  it("emits source_added event", () => {
    monitorBus.on("monitor", handler);
    monitorBus.publish("cam:source_added", { name: "test_cam", protocol: "ffmpeg" }, "test_cam");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("cam:source_added");
  });

  it("emits segment_built event with metadata", () => {
    monitorBus.on("monitor", handler);
    monitorBus.publish("cam:segment_built", {
      segment_id: "seg_123",
      mode: "event",
      frame_count: 5,
      duration_sec: 2.5,
    }, "test_cam");
    expect(events[0].data.frame_count).toBe(5);
  });
});
