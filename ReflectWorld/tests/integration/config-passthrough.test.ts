/**
 * Regression tests for CLI config resolution and eye/cam merge logic.
 *
 * Gap 1: eye/cam config merge — cam overrides eye, _ports overlay wins.
 * Gap 2: Custom GO2RTC_API_PORT passthrough — env flows through to cam
 *         config, self-check endpoint, and go2rtc endpoint resolution.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCliConfig } from "../../packages/reflectworld/src/cli/config.js";
import { buildCamConfig, resolveGo2rtcEndpoint } from "../../packages/reflectworld/src/config-helpers.js";
import { DashboardServer } from "../../packages/reflectworld/src/services/dashboard-server.js";

// ─── Environment isolation ───────────────────────────────────────────

const ENV_KEYS = [
  "REFLECTWORLD_HOME",
  "REFLECTWORLD_STATE_DIR",
  "REFLECTWORLD_MODELS_DIR",
  "PORT",
  "QDRANT_PORT",
  "QDRANT_GRPC_PORT",
  "REFLECTWORLD_MEM_PORT",
  "GO2RTC_API_PORT",
  "GO2RTC_RTSP_PORT",
  "GO2RTC_WEBRTC_PORT",
  "GO2RTC_LISTEN_ADDR",
  "GO2RTC_REUSE_EXTERNAL",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

// ═════════════════════════════════════════════════════════════════════
// Gap 2: resolveCliConfig — port resolution & env write-back
// ═════════════════════════════════════════════════════════════════════

describe("resolveCliConfig", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = snapshotEnv();
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    restoreEnv(saved);
  });

  it("uses default ports when nothing is set", () => {
    const cfg = resolveCliConfig([]);
    expect(cfg.port).toBe(3210);
    expect(cfg.qdrantPort).toBe(6333);
    expect(cfg.qdrantGrpcPort).toBe(6334); // default = qdrantPort + 1
    expect(cfg.memPort).toBe(8219);
    expect(cfg.go2rtcApiPort).toBe(1984);
    expect(cfg.go2rtcRtspPort).toBe(8554);
    expect(cfg.go2rtcWebrtcPort).toBe(8555);
    expect(cfg.go2rtcListenAddr).toBe("127.0.0.1");
    expect(cfg.go2rtcReuseExternal).toBe(true);
  });

  it("CLI --port overrides env PORT", () => {
    process.env.PORT = "4000";
    const cfg = resolveCliConfig(["--port", "5000"]);
    expect(cfg.port).toBe(5000);
  });

  it("env PORT is respected when no CLI --port", () => {
    process.env.PORT = "4000";
    const cfg = resolveCliConfig([]);
    expect(cfg.port).toBe(4000);
  });

  it("env GO2RTC_API_PORT is respected", () => {
    process.env.GO2RTC_API_PORT = "2984";
    const cfg = resolveCliConfig([]);
    expect(cfg.go2rtcApiPort).toBe(2984);
  });

  it("env GO2RTC_RTSP_PORT and GO2RTC_WEBRTC_PORT are respected", () => {
    process.env.GO2RTC_RTSP_PORT = "9554";
    process.env.GO2RTC_WEBRTC_PORT = "9555";
    const cfg = resolveCliConfig([]);
    expect(cfg.go2rtcRtspPort).toBe(9554);
    expect(cfg.go2rtcWebrtcPort).toBe(9555);
  });

  it("env GO2RTC_LISTEN_ADDR is respected", () => {
    process.env.GO2RTC_LISTEN_ADDR = "0.0.0.0";
    const cfg = resolveCliConfig([]);
    expect(cfg.go2rtcListenAddr).toBe("0.0.0.0");
    expect(process.env.GO2RTC_LISTEN_ADDR).toBe("0.0.0.0");
  });

  it("env GO2RTC_REUSE_EXTERNAL is respected", () => {
    process.env.GO2RTC_REUSE_EXTERNAL = "false";
    const cfg = resolveCliConfig([]);
    expect(cfg.go2rtcReuseExternal).toBe(false);
    expect(process.env.GO2RTC_REUSE_EXTERNAL).toBe("false");
  });

  it("QDRANT_GRPC_PORT defaults to qdrantPort + 1", () => {
    process.env.QDRANT_PORT = "7000";
    const cfg = resolveCliConfig([]);
    expect(cfg.qdrantPort).toBe(7000);
    expect(cfg.qdrantGrpcPort).toBe(7001);
  });

  it("QDRANT_GRPC_PORT can be overridden independently", () => {
    process.env.QDRANT_PORT = "7000";
    process.env.QDRANT_GRPC_PORT = "7777";
    const cfg = resolveCliConfig([]);
    expect(cfg.qdrantPort).toBe(7000);
    expect(cfg.qdrantGrpcPort).toBe(7777);
  });

  it("writes resolved values back to process.env", () => {
    resolveCliConfig(["--home-dir", "/tmp/test-home", "--port", "4444"]);
    expect(process.env.REFLECTWORLD_HOME).toBe("/tmp/test-home");
    expect(process.env.PORT).toBe("4444");
    expect(process.env.GO2RTC_API_PORT).toBe("1984"); // default written back
  });

  it("--home-dir canonicalizes ~ paths", () => {
    const cfg = resolveCliConfig(["--home-dir", "~/test-vm"]);
    expect(cfg.homeDir).not.toContain("~");
    expect(cfg.homeDir).toMatch(/test-vm$/);
  });

  it("--dev sets pythonSourceDir to cwd/services/mem", () => {
    const cfg = resolveCliConfig(["--dev"]);
    expect(cfg.dev).toBe(true);
    expect(cfg.pythonSourceDir).toMatch(/services\/mem$/);
    // In dev mode, pythonSourceDir must NOT be under ~/.reflectworld
    expect(cfg.pythonSourceDir).not.toContain(".reflectworld");
  });

  it("non-dev pythonSourceDir is under homeDir", () => {
    const cfg = resolveCliConfig([]);
    expect(cfg.dev).toBe(false);
    expect(cfg.pythonSourceDir).toContain(cfg.homeDir);
    expect(cfg.pythonSourceDir).toMatch(/services\/mem$/);
  });

  it("ignores garbage env values and falls back to defaults", () => {
    process.env.PORT = "not-a-number";
    process.env.GO2RTC_API_PORT = "";
    const cfg = resolveCliConfig([]);
    expect(cfg.port).toBe(3210);
    expect(cfg.go2rtcApiPort).toBe(1984);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Gap 1: eye/cam config merge — tests real buildCamConfig + resolveGo2rtcEndpoint
// from packages/reflectworld/src/config-helpers.ts (same code index.ts imports)
// ═════════════════════════════════════════════════════════════════════

describe("eye/cam config merge", () => {
  it("eye keys are used when cam is absent", () => {
    const merged = buildCamConfig(
      { sources_dir: "/from-eye", go2rtc_api_port: 1984, custom_key: "eye-only" },
      undefined,
      {},
    );
    expect(merged.sources_dir).toBe("/from-eye");
    expect(merged.go2rtc_api_port).toBe(1984);
    expect(merged.custom_key).toBe("eye-only");
  });

  it("cam keys override eye keys", () => {
    const merged = buildCamConfig(
      { sources_dir: "/from-eye", go2rtc_api_port: 1984, keep_me: true },
      { sources_dir: "/from-cam" },
      {},
    );
    expect(merged.sources_dir).toBe("/from-cam");
    // go2rtc_api_port falls through: ports undefined → cam undefined → eye 1984
    expect(merged.go2rtc_api_port).toBe(1984);
    // Keys only in eye survive the merge
    expect(merged.keep_me).toBe(true);
  });

  it("_ports overlay takes highest priority over both eye and cam", () => {
    const merged = buildCamConfig(
      { go2rtc_api_port: 1000, go2rtc_rtsp_port: 2000 },
      { go2rtc_api_port: 3000, go2rtc_rtsp_port: 4000, go2rtc_webrtc_port: 5000 },
      { go2rtcApi: 2984, go2rtcRtsp: 9554 },
    );
    expect(merged.go2rtc_api_port).toBe(2984);   // from ports
    expect(merged.go2rtc_rtsp_port).toBe(9554);   // from ports
    expect(merged.go2rtc_webrtc_port).toBe(5000);  // fallback to cam
  });

  it("fallback chain: ports → cam → eye → undefined", () => {
    // No ports, no cam value → falls to eye
    const merged = buildCamConfig(
      { go2rtc_api_port: 1984 },
      { /* no go2rtc_api_port */ },
      {},
    );
    expect(merged.go2rtc_api_port).toBe(1984);
  });

  it("all three port overlays from _ports", () => {
    const merged = buildCamConfig(
      {},
      {},
      { go2rtcApi: 2984, go2rtcRtsp: 9554, go2rtcWebrtc: 9555 },
    );
    expect(merged.go2rtc_api_port).toBe(2984);
    expect(merged.go2rtc_rtsp_port).toBe(9554);
    expect(merged.go2rtc_webrtc_port).toBe(9555);
  });

  it("listen address overlay from _ports wins over eye and cam", () => {
    const merged = buildCamConfig(
      { go2rtc_listen_addr: "127.0.0.1" },
      { go2rtc_listen_addr: "0.0.0.0" },
      { go2rtcListen: "127.0.0.1" },
    );
    expect(merged.go2rtc_listen_addr).toBe("127.0.0.1");
  });

  it("external reuse overlay from _ports wins over eye and cam", () => {
    const merged = buildCamConfig(
      { go2rtc_reuse_external: true },
      { go2rtc_reuse_external: true },
      { go2rtcReuseExternal: false },
    );
    expect(merged.go2rtc_reuse_external).toBe(false);
  });

  it("both eye and cam absent produces port-only config", () => {
    const merged = buildCamConfig(undefined, undefined, { go2rtcApi: 2984 });
    expect(merged.go2rtc_api_port).toBe(2984);
    expect(merged.go2rtc_rtsp_port).toBeUndefined();
  });
});

describe("go2rtc endpoint resolution", () => {
  it("uses ports.go2rtcApi when present", () => {
    expect(resolveGo2rtcEndpoint({ go2rtcApi: 2984 })).toBe("http://127.0.0.1:2984");
  });

  it("falls back to cam go2rtc_api_port", () => {
    expect(resolveGo2rtcEndpoint({}, { go2rtc_api_port: 3000 })).toBe("http://127.0.0.1:3000");
  });

  it("falls back to eye go2rtc_api_port", () => {
    expect(resolveGo2rtcEndpoint({}, undefined, { go2rtc_api_port: 4000 })).toBe("http://127.0.0.1:4000");
  });

  it("defaults to 1984 when nothing is set", () => {
    expect(resolveGo2rtcEndpoint({})).toBe("http://127.0.0.1:1984");
  });

  it("handles string port values (coerces to number)", () => {
    expect(resolveGo2rtcEndpoint({}, { go2rtc_api_port: "2984" as any })).toBe("http://127.0.0.1:2984");
  });

  it("handles garbage string port → defaults to 1984", () => {
    expect(resolveGo2rtcEndpoint({}, { go2rtc_api_port: "garbage" as any })).toBe("http://127.0.0.1:1984");
  });
});

// ═════════════════════════════════════════════════════════════════════
// End-to-end: CLI env → ports → cam merge → go2rtc endpoint
// ═════════════════════════════════════════════════════════════════════

describe("CLI → _ports → camConfig → go2rtcEndpoint integration", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = snapshotEnv();
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    restoreEnv(saved);
  });

  it("custom GO2RTC_API_PORT flows through the full path", () => {
    process.env.GO2RTC_API_PORT = "2984";
    const cfg = resolveCliConfig([]);

    // 1. CLI config resolves the port
    expect(cfg.go2rtcApiPort).toBe(2984);

    // 2. process.env is updated
    expect(process.env.GO2RTC_API_PORT).toBe("2984");

    // 3. Simulate what start.ts builds as _ports
    const ports = {
      go2rtcApi: cfg.go2rtcApiPort,
      go2rtcRtsp: cfg.go2rtcRtspPort,
      go2rtcWebrtc: cfg.go2rtcWebrtcPort,
      go2rtcListen: cfg.go2rtcListenAddr,
      go2rtcReuseExternal: cfg.go2rtcReuseExternal,
    };

    // 4. camConfig merge picks up the port
    const camConfig = buildCamConfig(
      { sources_dir: "/some/eye/dir" },
      { sources_dir: "/some/cam/dir" },
      ports,
    );
    expect(camConfig.go2rtc_api_port).toBe(2984);
    expect(camConfig.go2rtc_listen_addr).toBe("127.0.0.1");
    expect(camConfig.go2rtc_reuse_external).toBe(true);

    // 5. go2rtc endpoint uses the same port
    const endpoint = resolveGo2rtcEndpoint(ports);
    expect(endpoint).toBe("http://127.0.0.1:2984");
  });

  it("default ports flow correctly when env is clean", () => {
    const cfg = resolveCliConfig([]);
    const ports = {
      go2rtcApi: cfg.go2rtcApiPort,
      go2rtcRtsp: cfg.go2rtcRtspPort,
      go2rtcWebrtc: cfg.go2rtcWebrtcPort,
      go2rtcListen: cfg.go2rtcListenAddr,
      go2rtcReuseExternal: cfg.go2rtcReuseExternal,
    };
    const camConfig = buildCamConfig(undefined, undefined, ports);
    expect(camConfig.go2rtc_api_port).toBe(1984);
    expect(camConfig.go2rtc_rtsp_port).toBe(8554);
    expect(camConfig.go2rtc_webrtc_port).toBe(8555);
    expect(camConfig.go2rtc_listen_addr).toBe("127.0.0.1");
    expect(camConfig.go2rtc_reuse_external).toBe(true);

    const endpoint = resolveGo2rtcEndpoint(ports);
    expect(endpoint).toBe("http://127.0.0.1:1984");
  });
});

// ═════════════════════════════════════════════════════════════════════
// DashboardServer /api/dashboard/runtime — ensure go2rtcApiPort passthrough
// ═════════════════════════════════════════════════════════════════════

/** Find a free ephemeral port by briefly binding to port 0. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, () => {
      const addr = s.address();
      if (!addr || typeof addr === "string") { s.close(); reject(new Error("no address")); return; }
      const port = addr.port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

describe("DashboardServer /api/dashboard/runtime", () => {
  let saved: Record<string, string | undefined>;
  let dashboard: DashboardServer | null = null;
  let testPort: number;
  let tempDirs: string[] = [];

  beforeEach(async () => {
    saved = snapshotEnv();
    for (const k of ENV_KEYS) delete process.env[k];
    testPort = await getFreePort();
  });

  afterEach(() => {
    restoreEnv(saved);
    if (dashboard) { dashboard.stop(); dashboard = null; }
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs = [];
  });

  it("returns go2rtc_api_port from GO2RTC_API_PORT env", async () => {
    process.env.GO2RTC_API_PORT = "2984";
    dashboard = new DashboardServer({ distDir: "/nonexistent", port: testPort });
    await dashboard.start();

    const res = await fetch(`http://127.0.0.1:${testPort}/api/dashboard/runtime`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.go2rtc_api_port).toBe(2984);
  });

  it("defaults go2rtc_api_port to 1984 when env is unset", async () => {
    dashboard = new DashboardServer({ distDir: "/nonexistent", port: testPort });
    await dashboard.start();

    const res = await fetch(`http://127.0.0.1:${testPort}/api/dashboard/runtime`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.go2rtc_api_port).toBe(1984);
  });

  it("accepts go2rtcApiPort as string (plugin config compat)", async () => {
    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port: testPort,
      go2rtcApiPort: "2984" as unknown as number,
    });
    await dashboard.start();

    const res = await fetch(`http://127.0.0.1:${testPort}/api/dashboard/runtime`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.go2rtc_api_port).toBe(2984);
  });

  it("full path: CLI env → DashboardServer /api/dashboard/runtime", async () => {
    process.env.GO2RTC_API_PORT = "2984";
    const cfg = resolveCliConfig([]);
    expect(cfg.go2rtcApiPort).toBe(2984);

    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port: testPort,
      go2rtcApiPort: cfg.go2rtcApiPort,
    });
    await dashboard.start();

    const res = await fetch(`http://127.0.0.1:${testPort}/api/dashboard/runtime`);
    const data = await res.json();
    expect(data.go2rtc_api_port).toBe(2984);
  });

  it("lists and serves legacy upload directories as read-only upload videos", async () => {
    const root = mkdtempSync(join(tmpdir(), "reflectworld-dashboard-"));
    tempDirs.push(root);
    const uploadsDir = join(root, "current");
    const legacyUploadsDir = join(root, "legacy");
    mkdirSync(uploadsDir, { recursive: true });
    mkdirSync(legacyUploadsDir, { recursive: true });
    writeFileSync(join(legacyUploadsDir, "old.mp4"), Buffer.from("legacy-video"));

    dashboard = new DashboardServer({
      distDir: "/nonexistent",
      port: testPort,
      uploadsDir,
      legacyUploadsDirs: [legacyUploadsDir],
    });
    await dashboard.start();

    const listRes = await fetch(`http://127.0.0.1:${testPort}/api/videos`);
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.videos).toContainEqual(expect.objectContaining({
      video_id: "upload/old.mp4",
      name: "old.mp4",
      source: "upload",
    }));

    const fileRes = await fetch(`http://127.0.0.1:${testPort}/api/videos/file?video_id=upload/old.mp4`);
    expect(fileRes.status).toBe(200);
    expect(await fileRes.text()).toBe("legacy-video");
  });
});
