/**
 * Cortex Host — loads the all-in-one plugin and exposes HTTP API.
 *
 * Usage:
 *   VLM_API_KEY=xxx npx tsx packages/host/src/server.ts
 *
 * Everything else is managed after setup:
 *   - Qdrant, Cortex → auto-start as plugin services
 *   - go2rtc, ffmpeg → resolved from setup-prepared binaries
 *   - Eye → Perception → Memory pipeline → auto-wired
 *
 * API:
 *   GET  /api/tools             — list registered tools
 *   POST /api/tool/:name        — call a tool with JSON body as params
 *   GET  /api/health            — health check
 */
import "dotenv/config";
import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCortexStateDir } from "@cortex/shared";
import { MiniHost } from "./mini-host.js";
import { attachMonitorWs } from "./ws-server.js";
import { serveStatic } from "./static-server.js";

const __hostDir = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIST = resolve(__hostDir, "../../dashboard/dist");
import cortexPlugin from "@cortex/cortex";

const PORT = parseInt(process.env.PORT ?? "3210", 10);
const GO2RTC_PORT = parseInt(process.env.GO2RTC_API_PORT ?? "1984", 10);
const STATE_DIR = resolveCortexStateDir();
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT ?? process.env.DASHBOARD_PORT ?? "3211", 10);

const host = new MiniHost({
  stateDir: STATE_DIR,
  pluginConfigs: {
    cortex: {
      cam: {
        sources_dir: `${STATE_DIR}/sources`,
        recordings_dir: `${STATE_DIR}/recordings`,
        ...(process.env.GO2RTC_API_PORT ? { go2rtc_api_port: parseInt(process.env.GO2RTC_API_PORT, 10) } : {}),
        ...(process.env.GO2RTC_RTSP_PORT ? { go2rtc_rtsp_port: parseInt(process.env.GO2RTC_RTSP_PORT, 10) } : {}),
        ...(process.env.GO2RTC_LISTEN_ADDR ? { go2rtc_listen_addr: process.env.GO2RTC_LISTEN_ADDR } : {}),
        ...(process.env.GO2RTC_REUSE_EXTERNAL ? { go2rtc_reuse_external: process.env.GO2RTC_REUSE_EXTERNAL === "true" } : {}),
      },
      perception: {
        // Provider config is resolved from env vars by resolvePerceptionConfig().
        // Explicit overrides can still be passed here.
      },
      memory: {},
      dashboard: {
        port: DASHBOARD_PORT,
      },
    },
  },
});

console.log("\n  Booting Cortex...\n");

// Load plugin → register tools + services
await host.loadPlugin(cortexPlugin);

// Start all services (Qdrant → Cortex → go2rtc)
await host.startServices();

// HTTP server
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const method = req.method ?? "GET";

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const json = (data: unknown, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };

  try {
    if (url.pathname === "/api/health") {
      return json({
        status: "ok",
        mode: "main",
        tools: host.listTools().length,
        state_dir: STATE_DIR,
        host_port: PORT,
        dashboard_port: DASHBOARD_PORT,
      });
    }

    // Runtime config for the dashboard frontend (ports that may differ per deployment)
    if (url.pathname === "/api/config") {
      return json({ go2rtcPort: GO2RTC_PORT });
    }

    if (url.pathname === "/api/tools" && method === "GET") {
      return json({ tools: host.listTools() });
    }

    // POST /api/monitor/inject — inject events into EventBus (for testing/mock)
    if (url.pathname === "/api/monitor/inject" && method === "POST") {
      const { monitorBus } = await import("@cortex/shared");
      const body = await readBody(req);
      const events = JSON.parse(body || "[]");
      const list = Array.isArray(events) ? events : [events];
      for (const evt of list) {
        monitorBus.emit("monitor", evt);
      }
      return json({ injected: list.length });
    }

    // GET /api/traces — proxy to DashboardServer (which has PipelineStore access)
    if (url.pathname === "/api/traces" && method === "GET") {
      try {
        const upstream = await fetch(`http://127.0.0.1:${DASHBOARD_PORT}/api/traces${url.search}`);
        const body = await upstream.text();
        res.writeHead(upstream.status, { "Content-Type": "application/json" });
        res.end(body);
      } catch {
        json({ error: "DashboardServer unreachable" }, 502);
      }
      return;
    }

    // GET /api/traces/stats — proxy to DashboardServer
    if (url.pathname === "/api/traces/stats" && method === "GET") {
      try {
        const upstream = await fetch(`http://127.0.0.1:${DASHBOARD_PORT}/api/traces/stats${url.search}`);
        const body = await upstream.text();
        res.writeHead(upstream.status, { "Content-Type": "application/json" });
        res.end(body);
      } catch {
        json({ error: "DashboardServer unreachable" }, 502);
      }
      return;
    }

    // GET /api/keyframe/:segmentId — serve the first keyframe JPEG for a segment
    if (url.pathname.startsWith("/api/keyframe/") && method === "GET") {
      const segmentId = url.pathname.slice("/api/keyframe/".length);
      if (!segmentId || /[^a-zA-Z0-9_-]/.test(segmentId)) {
        return json({ error: "Invalid segment ID" }, 400);
      }
      const mediaDir = join(STATE_DIR, "media");
      const cameraDirs = existsSync(mediaDir) ? readdirSync(mediaDir) : [];
      for (const cam of cameraDirs) {
        const kfDir = join(mediaDir, cam, "keyframe");
        if (!existsSync(kfDir)) continue;
        const match = readdirSync(kfDir).find(f => f.startsWith(segmentId));
        if (match) {
          const data = readFileSync(join(kfDir, match));
          res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=3600" });
          res.end(data);
          return;
        }
      }
      return json({ error: "Keyframe not found" }, 404);
    }

    const toolMatch = url.pathname.match(/^\/api\/tool\/([^/]+)$/);
    if (toolMatch && method === "POST") {
      const toolName = decodeURIComponent(toolMatch[1]);
      const body = await readBody(req);
      const params = JSON.parse(body || "{}");
      const result = await host.callTool(toolName, params);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(result);
      return;
    }

    // Serve dashboard frontend static files (SPA fallback)
    if (serveStatic(DASHBOARD_DIST, req, res)) return;

    json({ error: "Not found" }, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[host] Error: ${message}`);
    json({ error: message }, 500);
  }
});

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

// Attach WebSocket server for dashboard event broadcast
attachMonitorWs(server);

server.listen(PORT, () => {
  console.log(`\n  Cortex ready on http://localhost:${PORT}`);
  console.log(`  Tools: ${host.listTools().map(t => t.name).join(", ")}`);
  console.log(`  State: ${STATE_DIR}\n`);
});

// Graceful shutdown
const shutdown = async () => {
  console.log("\nShutting down...");
  server.close();
  await host.stopServices();
  console.log("Goodbye.");
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
