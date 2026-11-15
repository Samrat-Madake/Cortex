import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import dotenv from "dotenv";
import { resolveCliConfig } from "./config.js";
import { MiniHost } from "./mini-host.js";
import { attachMonitorWs } from "./ws-server.js";
import { checkSetupNeeded, runSetup } from "./setup.js";

const DEFAULT_TOOL_API_MAX_BODY_BYTES = 1024 * 1024;

function envFlag(name: string, env: NodeJS.ProcessEnv = process.env, fallback = false): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function envNonNegativeInt(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const value = Number.parseInt(env[name] ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function isToolApiRestricted(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag("CORTEX_PUBLIC_MODE", env) || envFlag("CORTEX_TOOL_API_RESTRICTED", env);
}

export function toolApiMaxBodyBytes(env: NodeJS.ProcessEnv = process.env): number {
  return envNonNegativeInt("CORTEX_TOOL_API_MAX_BODY_BYTES", DEFAULT_TOOL_API_MAX_BODY_BYTES, env);
}

export function isToolAdminAuthorized(req: IncomingMessage, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isToolApiRestricted(env)) return true;
  const expected = env.CORTEX_TOOL_API_TOKEN || env.DASHBOARD_ADMIN_TOKEN;
  if (!expected) return false;
  const bearer = typeof req.headers.authorization === "string" && req.headers.authorization.startsWith("Bearer ")
    ? req.headers.authorization.slice("Bearer ".length).trim()
    : "";
  const dashboardToken = typeof req.headers["x-dashboard-admin-token"] === "string" ? req.headers["x-dashboard-admin-token"].trim() : "";
  const toolToken = typeof req.headers["x-cortex-admin-token"] === "string" ? req.headers["x-cortex-admin-token"].trim() : "";
  return bearer === expected || dashboardToken === expected || toolToken === expected;
}

function readBoundedRequestBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (maxBytes > 0 && bytes > maxBytes) {
        settled = true;
        reject(new Error("request_body_too_large"));
        return;
      }
      body += chunk.toString();
    });
    req.on("end", () => {
      if (!settled) resolve(body);
    });
    req.on("error", (err) => {
      if (!settled) reject(err);
    });
  });
}

export async function runStart(args: string[]): Promise<void> {
  // 1. Load .env FIRST — must happen before resolveCliConfig reads process.env
  dotenv.config();

  // 2. Resolve config with env write-back
  const config = resolveCliConfig(args);

  // 3. Auto-setup if needed (throws on critical failure)
  const setupReason = checkSetupNeeded(config.homeDir);
  if (setupReason) {
    console.log(`\n  First-time setup required (${setupReason}).`);
    try {
      await runSetup(["--home-dir", config.homeDir, "--yes"]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n  Setup failed: ${msg}`);
      console.error("  Cannot start Cortex without a successful setup. Exiting.\n");
      process.exit(1);
    }
  }

  const { default: cortexPlugin } = await import("../../index.js");

  // Dashboard handler — set by DashboardServer via registerHandler callback
  let dashboardHandleRequest:
    | ((req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>)
    | null = null;

  const host = new MiniHost({
    homeDir: config.homeDir,
    stateDir: config.stateDir,
    flatStateDir: true,
    pluginConfigs: {
      cortex: {
        _homeDir: config.homeDir,
        _stateDir: config.stateDir,
        _ports: {
          qdrant: config.qdrantPort,
          qdrantGrpc: config.qdrantGrpcPort,
          mem: config.memPort,
          go2rtcApi: config.go2rtcApiPort,
          go2rtcRtsp: config.go2rtcRtspPort,
          go2rtcWebrtc: config.go2rtcWebrtcPort,
          go2rtcListen: config.go2rtcListenAddr,
          go2rtcReuseExternal: config.go2rtcReuseExternal,
        },
        dashboard: {
          existingServer: null as any, // replaced after server creation
          port: config.port,
          registerHandler: (
            handler: (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>,
          ) => {
            dashboardHandleRequest = handler;
          },
        },
        eye: {
          sources_dir: join(config.stateDir, "sources"),
          recordings_dir: join(config.stateDir, "recordings"),
        },
        perception: {},
        memory: {},
      },
    },
  });

  // Create HTTP server with health-aware routing
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);
    const method = req.method ?? "GET";

    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Dashboard-Admin-Token, X-Cortex-Admin-Token");
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health endpoint — exposes startup status (starting/ready/degraded)
    if (url.pathname === "/api/health" && method === "GET") {
      const healthStatus = host.getHealthStatus();
      const statusCode = healthStatus === "ready" ? 200 : healthStatus === "starting" ? 503 : 200;
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: healthStatus,
        tools: host.listTools().length,
        services: host.getServiceStatus(),
      }));
      return;
    }

    if (url.pathname === "/api/tools" && method === "GET") {
      if (!isToolAdminAuthorized(req)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Admin token is required for tool API in public mode" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ tools: host.listTools() }));
      return;
    }

    if (url.pathname.startsWith("/api/tool/") && method === "POST") {
      if (!isToolAdminAuthorized(req)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Admin token is required for tool API in public mode" }));
        return;
      }
      const toolName = url.pathname.slice("/api/tool/".length);
      try {
        const body = await readBoundedRequestBody(req, toolApiMaxBodyBytes());
        const params = body ? JSON.parse(body) : {};
        const result = await host.callTool(toolName, params);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(result);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        const status = message === "request_body_too_large" ? 413 : 500;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: status === 413 ? "Request body too large" : message }));
      }
      return;
    }

    // Delegate to DashboardServer handler (traces, media, cortex proxy, static files)
    if (dashboardHandleRequest) {
      const handled = await dashboardHandleRequest(req, res);
      if (handled) return;
    }

    // Fallback 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  // Inject server reference for DashboardServer WebSocket
  (host as any).pluginConfigs.cortex.dashboard.existingServer = server;

  // Load plugin — registers all services and tools
  await host.loadPlugin(cortexPlugin);

  // Step 1: Start dashboard first so UI is immediately available
  try {
    await host.startService("dashboard");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`  [warn] Dashboard failed to start: ${msg}`);
  }

  // Step 2: Attach WebSocket + listen — user can now access http://localhost:PORT
  attachMonitorWs(server);
  server.listen(config.port, () => {
    console.log(`\n  Cortex running at http://localhost:${config.port}`);
    console.log("  Starting services...\n");
  });

  // Step 3: Start remaining services in background, best-effort
  void host.startServices({ exclude: ["dashboard"], continueOnError: true }).then(() => {
    const status = host.getHealthStatus();
    if (status === "ready") {
      console.log("  All services started successfully.\n");
    } else {
      console.warn(`  Services status: ${status}`);
      const svcStatus = host.getServiceStatus();
      for (const [id, info] of Object.entries(svcStatus)) {
        if (info.status === "failed") {
          console.warn(`    ${id}: ${info.error}`);
        }
      }
      console.log();
    }
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n  Shutting down...");
    await host.stopServices();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
