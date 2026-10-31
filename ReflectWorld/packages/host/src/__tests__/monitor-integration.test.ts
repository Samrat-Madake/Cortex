import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import { attachMonitorWs } from "../ws-server.js";
import { monitorBus } from "@reflectworld/shared";

describe("Monitor integration", () => {
  let server: Server;

  afterEach(() => {
    server?.close();
  });

  it("delivers cam + perception events over WebSocket", async () => {
    server = createServer();
    attachMonitorWs(server);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;

    const ws = new WebSocket(`ws://localhost:${port}/ws/monitor`);
    const received: { type: string }[] = [];

    await new Promise<void>((resolve) => {
      ws.on("message", (data) => {
        received.push(JSON.parse(data.toString()));
        if (received.length === 3) resolve();
      });
      ws.on("open", () => {
        monitorBus.publish("cam:segment_built", { segment_id: "seg_1", frame_count: 3 }, "cam");
        monitorBus.publish("perception:analysis_completed", { segment_id: "seg_1", level: 1 }, "cam");
      });
    });

    ws.close();
    expect(received.map((e) => e.type)).toEqual([
      "system:connected",
      "cam:segment_built",
      "perception:analysis_completed",
    ]);
  });

  it("delivers memory + system events over WebSocket", async () => {
    server = createServer();
    attachMonitorWs(server);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;

    const ws = new WebSocket(`ws://localhost:${port}/ws/monitor`);
    const received: { type: string }[] = [];

    await new Promise<void>((resolve) => {
      ws.on("message", (data) => {
        received.push(JSON.parse(data.toString()));
        if (received.length === 3) resolve();
      });
      ws.on("open", () => {
        monitorBus.publish("memory:memory_added", { summary_preview: "Person at door" }, "cam");
        monitorBus.publish("system:pipeline_metrics", { vlm_latency_ms: 1200 });
      });
    });

    ws.close();
    expect(received.map((e) => e.type)).toEqual([
      "system:connected",
      "memory:memory_added",
      "system:pipeline_metrics",
    ]);
  });
});
