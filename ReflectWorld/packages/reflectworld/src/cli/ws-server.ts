// WebSocket server for monitor event broadcast.
// Attaches to existing http.Server, subscribes to monitorBus, broadcasts to all clients.

import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import { monitorBus } from "@reflectworld/shared";
import type { MonitorEvent } from "@reflectworld/shared";

export function attachMonitorWs(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws/monitor" });

  monitorBus.on("monitor", (event: MonitorEvent) => {
    const msg = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  });

  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({
      type: "system:connected",
      timestamp: Date.now(),
      data: {},
    }));
  });

  return wss;
}
