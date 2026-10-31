import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { attachMonitorWs } from "../ws-server.js";
import { monitorBus } from "@reflectworld/shared";

describe("attachMonitorWs", () => {
  let server: ReturnType<typeof createServer>;
  let port: number;

  afterEach(() => {
    server?.close();
  });

  it("broadcasts events to connected clients", async () => {
    server = createServer();
    attachMonitorWs(server);
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as any).port;

    const ws = new WebSocket(`ws://localhost:${port}/ws/monitor`);
    const messages: string[] = [];

    await new Promise<void>((resolve) => {
      ws.on("message", (data) => {
        messages.push(data.toString());
        if (messages.length === 2) resolve(); // handshake + event
      });
      ws.on("open", () => {
        monitorBus.publish("cam:source_added", { name: "test" });
      });
    });

    ws.close();

    expect(messages).toHaveLength(2);
    const handshake = JSON.parse(messages[0]);
    expect(handshake.type).toBe("system:connected");
    const event = JSON.parse(messages[1]);
    expect(event.type).toBe("cam:source_added");
    expect(event.data.name).toBe("test");
  });
});
