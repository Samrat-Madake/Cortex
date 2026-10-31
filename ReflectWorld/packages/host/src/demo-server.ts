import "dotenv/config";
import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { MiniHost } from "./mini-host.js";
import { attachMonitorWs } from "./ws-server.js";
import { serveStatic } from "./static-server.js";
import reflectworldPlugin from "@reflectworld/reflectworld";
import { resolveReflectWorldHome } from "@reflectworld/shared";
import { VlmAnalyzer } from "../../percept/src/analyzers/vlm-analyzer.js";
import { resolveVlmCallProfile } from "../../percept/src/vlm-call-profiles.js";
import {
  buildVisionControllerConsultationPrompt,
  parseVisionControllerConsultationResponse,
} from "../../reflectworld/src/vision-controller/consultation.js";

const __hostDir = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIST = resolve(__hostDir, "../../dashboard/dist");

const HOME = process.env.HOME ?? homedir();
const DEMO_HOME_DIR = process.env.REFLECTWORLD_DEMO_HOME_DIR ?? process.env.REFLECTWORLD_HOME ?? resolveReflectWorldHome();
const DEMO_STATE_DIR = process.env.REFLECTWORLD_DEMO_STATE_DIR ?? join(HOME, ".reflectworld-demo");
const DEMO_NAME = process.env.REFLECTWORLD_DEMO_NAME ?? "dashboard-demo";
const PORT = parseInt(process.env.PORT ?? process.env.REFLECTWORLD_DEMO_HOST_PORT ?? "3214", 10);
const HOST_LISTEN_ADDR = process.env.REFLECTWORLD_DEMO_HOST_LISTEN_ADDR ?? process.env.HOST_LISTEN_ADDR ?? "";
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT ?? process.env.DASHBOARD_PORT ?? process.env.REFLECTWORLD_DEMO_DASHBOARD_PORT ?? "3213", 10);
const MEM_PORT = parseInt(process.env.REFLECTWORLD_DEMO_MEM_PORT ?? "48219", 10);
const QDRANT_PORT = parseInt(process.env.REFLECTWORLD_DEMO_QDRANT_PORT ?? "46333", 10);
const QDRANT_GRPC_PORT = parseInt(process.env.REFLECTWORLD_DEMO_QDRANT_GRPC_PORT ?? String(QDRANT_PORT + 1), 10);
const GO2RTC_API_PORT = parseInt(process.env.GO2RTC_API_PORT ?? process.env.REFLECTWORLD_DEMO_GO2RTC_API_PORT ?? "21984", 10);
const GO2RTC_RTSP_PORT = parseInt(process.env.GO2RTC_RTSP_PORT ?? process.env.REFLECTWORLD_DEMO_GO2RTC_RTSP_PORT ?? "28554", 10);
const MEM_SOURCE_DIR = resolve(__hostDir, "../../../services/mem");

process.env.DASHBOARD_PORT = String(DASHBOARD_PORT);
process.env.REFLECTWORLD_HOME = DEMO_HOME_DIR;
process.env.REFLECTWORLD_STATE_DIR = DEMO_STATE_DIR;
process.env.REFLECTWORLD_MODELS_DIR ??= join(DEMO_HOME_DIR, "models");

function createBenchmarkStyleConsultationDispatcher() {
  const agentProviderEnv = process.env.QA_PROVIDER ?? process.env.AGENT_PROVIDER ?? process.env.VLM_PROVIDER;
  const agentProvider = agentProviderEnv === "gemini" ? "gemini" : "openai";
  const agentApiBase =
    process.env.QA_BASE_URL
    ?? process.env.QA_API_BASE
    ?? process.env.AGENT_API_BASE
    ?? process.env.BENCH_AGENT_API_BASE
    ?? process.env.BENCH_AGENT_BASE_URL
    ?? process.env.OPENAI_BASE_URL
    ?? process.env.VLM_BASE_URL
    ?? "https://api.openai.com/v1";
  const agentApiKey =
    process.env.QA_API_KEY
    ?? process.env.AGENT_API_KEY
    ?? process.env.BENCH_AGENT_API_KEY
    ?? process.env.OPENAI_API_KEY
    ?? process.env.VLM_API_KEY
    ?? "";
  const agentModel = process.env.QA_MODEL ?? process.env.LLM_MODEL ?? "gpt-5-mini";
  const analyzer = new VlmAnalyzer(agentProvider === "gemini"
    ? { provider: "gemini", apiKey: agentApiKey, textModel: agentModel }
    : { provider: "openai", apiKey: agentApiKey, baseUrl: agentApiBase, textModel: agentModel });

  return {
    async submitConsultation(context: Record<string, unknown>) {
      try {
        const prompt = buildVisionControllerConsultationPrompt(context);
        const segmentId = typeof context.segment_id === "string" ? context.segment_id : undefined;
        const profile = resolveVlmCallProfile({
          model: agentModel,
          stage: "benchmark_consultation",
        });
        const text = await analyzer.completeText(prompt, {
          responseFormat: "json",
          model: agentModel,
          stage: "vision_controller.consultation",
          maxTokens: profile.maxOutputTokens,
          reasoningEffort: profile.reasoning,
          temperature: profile.temperature,
          llmContext: {
            demo_name: DEMO_NAME,
            segment_id: segmentId,
          },
        });
        if (!text) return null;
        return parseVisionControllerConsultationResponse(text, "dashboard-demo");
      } catch (err) {
        console.error(`[dashboard-demo] segment policy consultation failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    },
  };
}

const host = new MiniHost({
  stateDir: DEMO_STATE_DIR,
  pluginConfigs: {
    reflectworld: {
      _homeDir: DEMO_HOME_DIR,
      _stateDir: DEMO_STATE_DIR,
      _ports: {
        qdrant: QDRANT_PORT,
        qdrantGrpc: QDRANT_GRPC_PORT,
        mem: MEM_PORT,
        go2rtcApi: GO2RTC_API_PORT,
        go2rtcRtsp: GO2RTC_RTSP_PORT,
      },
      cam: {
        sources_dir: `${DEMO_STATE_DIR}/sources`,
        recordings_dir: `${DEMO_STATE_DIR}/recordings`,
        go2rtc_api_port: GO2RTC_API_PORT,
        go2rtc_rtsp_port: GO2RTC_RTSP_PORT,
        go2rtc_listen_addr: process.env.GO2RTC_LISTEN_ADDR ?? "127.0.0.1",
        go2rtc_reuse_external: process.env.GO2RTC_REUSE_EXTERNAL === "true",
        restore_watches: false,
      },
      memory: {
        source_dir: MEM_SOURCE_DIR,
        storage_path: `${DEMO_STATE_DIR}/mem-storage`,
        collection_name: DEMO_NAME.replace(/[^a-zA-Z0-9_-]/g, "_"),
        port: MEM_PORT,
        qdrant_port: QDRANT_PORT,
        qdrant_grpc_port: QDRANT_GRPC_PORT,
        user_id: "demo",
      },
      qdrant: {
        port: QDRANT_PORT,
        grpc_port: QDRANT_GRPC_PORT,
      },
      dashboard: {
        port: DASHBOARD_PORT,
      },
      consultation_dispatcher: createBenchmarkStyleConsultationDispatcher(),
      apply_consultation_tool_calls: true,
      perception: {
        // Provider config still resolves from env (.env / shell).
        runtime_mode: "live_latency",
        animated_segment_previews: true,
        vlm_frame_resize_enabled: true,
        vlm_frame_resize_short_edge: 432,
        vlm_frame_resize_jpeg_quality: 75,
      },
    },
  },
});

console.log("\n  Booting ReflectWorld Demo...\n");
console.log(`  Demo name:    ${DEMO_NAME}`);
console.log(`  Host port:    ${HOST_LISTEN_ADDR ? `${HOST_LISTEN_ADDR}:` : ""}${PORT}`);
console.log(`  Dashboard port: ${DASHBOARD_PORT}`);
console.log(`  Mem port:     ${MEM_PORT}`);
console.log(`  Qdrant:       ${QDRANT_PORT}/${QDRANT_GRPC_PORT}`);
console.log(`  Home dir:     ${DEMO_HOME_DIR}`);
console.log(`  State dir:    ${DEMO_STATE_DIR}\n`);

await host.loadPlugin(reflectworldPlugin);
await host.startServices();

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
        tools: host.listTools().length,
        mode: "demo",
        dashboard_port: DASHBOARD_PORT,
        mem_port: parseInt((process.env.REFLECTWORLD_URL ?? `http://127.0.0.1:${MEM_PORT}`).split(":").pop() ?? String(MEM_PORT), 10),
        mem_url: process.env.REFLECTWORLD_URL ?? `http://127.0.0.1:${MEM_PORT}`,
        qdrant_port: QDRANT_PORT,
        state_dir: DEMO_STATE_DIR,
      });
    }

    if (url.pathname === "/api/tools" && method === "GET") {
      return json({ tools: host.listTools() });
    }

    if (url.pathname === "/api/monitor/inject" && method === "POST") {
      const { monitorBus } = await import("@reflectworld/shared");
      const body = await readBody(req);
      const events = JSON.parse(body || "[]");
      const list = Array.isArray(events) ? events : [events];
      for (const evt of list) monitorBus.emit("monitor", evt);
      return json({ injected: list.length });
    }

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

    if (url.pathname.startsWith("/api/keyframe/") && method === "GET") {
      const segmentId = url.pathname.slice("/api/keyframe/".length);
      if (!segmentId || /[^a-zA-Z0-9_-]/.test(segmentId)) {
        return json({ error: "Invalid segment ID" }, 400);
      }
      const mediaDir = join(DEMO_STATE_DIR, "media");
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

    if (serveStatic(DASHBOARD_DIST, req, res)) return;

    json({ error: "Not found" }, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[demo-host] Error: ${message}`);
    json({ error: message }, 500);
  }
});

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString()));
    req.on("error", rejectPromise);
  });
}

attachMonitorWs(server);

const onListen = () => {
  console.log(`\n  ReflectWorld demo ready on http://localhost:${PORT}`);
  console.log(`  Dashboard: http://localhost:${DASHBOARD_PORT}`);
  console.log(`  Mode: isolated dashboard demo`);
  console.log(`  Tools: ${host.listTools().map(t => t.name).join(", ")}`);
  console.log(`  State: ${DEMO_STATE_DIR}\n`);
};

if (HOST_LISTEN_ADDR) {
  server.listen(PORT, HOST_LISTEN_ADDR, onListen);
} else {
  server.listen(PORT, onListen);
}

const shutdown = async () => {
  console.log("\nShutting down demo...");
  server.close();
  await host.stopServices();
  console.log("Goodbye.");
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
