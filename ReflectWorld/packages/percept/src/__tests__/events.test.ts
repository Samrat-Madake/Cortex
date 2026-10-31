import { describe, it, expect, afterEach } from "vitest";
import { monitorBus } from "@reflectworld/shared";
import type { MonitorEvent } from "@reflectworld/shared";

describe("Perception monitor events", () => {
  const events: MonitorEvent[] = [];
  const handler = (e: MonitorEvent) => events.push(e);

  afterEach(() => {
    events.length = 0;
    monitorBus.removeListener("monitor", handler);
  });

  it("emits analysis_started event", () => {
    monitorBus.on("monitor", handler);
    monitorBus.publish("perception:analysis_started", {
      segment_id: "seg_001",
      mode: "event",
      level: 1,
      vlm_model: "gemini-2.5-flash",
    }, "cam_01");
    expect(events[0].type).toBe("perception:analysis_started");
    expect(events[0].data.level).toBe(1);
  });

  it("emits vlm_result event", () => {
    monitorBus.on("monitor", handler);
    monitorBus.publish("perception:vlm_result", {
      segment_id: "seg_001",
      summary: "Person walking",
      security_risk: false,
      notify_user: true,
    }, "cam_01");
    expect(events[0].type).toBe("perception:vlm_result");
    expect(events[0].data.summary).toBe("Person walking");
  });
});
