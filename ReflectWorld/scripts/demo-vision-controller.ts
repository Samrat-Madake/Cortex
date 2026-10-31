/**
 * Semi-automated ReflectWorld VisionController demo script.
 *
 * Three-act showcase (~10 minutes):
 *   Act 1: Basic security — baseline -> person frame boost -> Agent consultation -> baseline recovery
 *   Act 2: Walking guidance — crowded + vehicle rules, per-camera isolation
 *   Act 3: Scene Exit — VLM custom_fields semantic trigger -> Agent consultation
 *
 * Usage:
 *   npx tsx scripts/demo-vision-controller.ts                # full demo
 *   npx tsx scripts/demo-vision-controller.ts --preflight-only  # pre-flight checks only
 */

import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { resolveReflectWorldHome } from "@reflectworld/shared";

// ── Config ──

const HOST_URL = process.env.HOST_URL ?? "http://localhost:3210";
const MONITOR_WS_URL = process.env.MONITOR_WS_URL ?? "ws://localhost:3211";
const GO2RTC_URL = process.env.GO2RTC_URL ?? "http://localhost:1984";
const REFLECTWORLD_URL = process.env.REFLECTWORLD_URL ?? "http://localhost:8219";

const VIDEO_DIR = resolve("eval/video-runner/fixtures/videos");
const MODEL_DIR = join(resolveReflectWorldHome(), "models");

// ── Types ──

interface DemoPhase {
  name: string;
  narration: string;
  video?: string;
  camera?: string;
  config?: Record<string, unknown>;
  setup?: boolean;
  waitSec?: number;
  waitForAgent?: boolean;
}

// ── Stats ──

const stats = {
  vlmCalls: 0,
  rulesFired: 0,
  agentConsultations: 0,
  stateChanges: 0,
  segmentsProcessed: 0,
  startTime: 0,
};

// ── Direct VisionController policies ──

const POLICIES = {
  basic_security: {
    enabled: true,
    baseline: { fps: 1 },
    auto_rules: [
      {
        name: "person_present",
        trigger: { type: "class_detected", class: "person" },
        action: { fps: 2 },
        cooldown_ms: 5000,
        hold_ms: 30_000,
      },
    ],
    segment_policy: {
      consultation_triggers: [
        { type: "security_risk" },
      ],
      consultation_cooldown_seconds: 60,
    },
  },
  walking_guidance: {
    enabled: true,
    baseline: { fps: 1 },
    auto_rules: [
      {
        name: "crowded",
        trigger: { type: "class_count_gte", class: "person", count: 3 },
        action: { fps: 2 },
        cooldown_ms: 10000,
      },
      {
        name: "moving_object_observe",
        trigger: {
          type: "any_of",
          conditions: [
            { type: "class_detected", class: "car" },
            { type: "class_detected", class: "vehicle" },
            { type: "class_detected", class: "truck" },
            { type: "class_detected", class: "bus" },
          ],
        },
        action: { fps: 1 },
        cooldown_ms: 10000,
      },
    ],
    segment_policy: {
      consultation_triggers: [{ type: "voice_detected" }],
      consultation_cooldown_seconds: 60,
    },
  },
};

// ── Phases ──
//
// Uses authorized demo footage.
// Timeline: empty driveway -> delivery truck arrives -> person activity -> truck leaves -> quiet again.
// Single video, no switching — VisionController reacts naturally to what happens on screen.

const PHASES: DemoPhase[] = [
  // Act 1: Authorized demo footage — basic frame policy on continuous footage
  {
    name: "Act 1 Setup — Demo Security",
    narration:
      "Adding front-door camera using authorized continuous demo footage.\n" +
      "  Configuring basic frame policy: baseline fps=1, person fps=2.\n" +
      "  VisionController will react to whatever happens on screen — no video switching needed.",
    setup: true,
    camera: "front-door",
    video: "demo-front-door-main.mp4",
    config: POLICIES.basic_security,
  },
  {
    name: "Quiet Driveway",
    camera: "front-door",
    waitSec: 60,
    narration:
      "Empty driveway and street. System in baseline: fps=1.\n" +
      "  Watch the FPS curve — flat at 1.\n" +
      "  Cars may pass on the road — only person_present boosts frame policy.",
  },
  {
    name: "Vehicle Arrives",
    camera: "front-door",
    waitSec: 90,
    narration:
      "A delivery truck (Knights Old Logistics) pulls up and stops near the driveway.\n" +
      "  YOLO detects 'truck' — but only person_present boosts fps.\n" +
      "  If a delivery person gets out, person_present will fire → fps jumps to 2.\n" +
      "  Watch for the state change in the VisionController panel.",
  },
  {
    name: "Activity + Agent Consultation",
    camera: "front-door",
    waitSec: 120,
    waitForAgent: true,
    narration:
      "People may be visible near the truck or on the sidewalk.\n" +
      "  If person detected → person_present fires → fps=2.\n" +
      "  If VLM flags security_risk → Agent consulted.\n" +
      "  Watch the Agent log panel for consultation events.",
  },
  {
    name: "Scene Clears — Baseline Recovery",
    camera: "front-door",
    waitSec: 90,
    narration:
      "Truck leaves, street returns to quiet. No more person detections.\n" +
      "  VisionController: no rules match → baseline recovery → fps=1.\n" +
      "  FPS curve drops back to 1.",
  },

  // Act 2: Same CCTV with walking guidance — demonstrates different rules on same footage
  {
    name: "Act 2 Setup — Walking Guidance on Same Camera",
    narration:
      "Switching the same camera to walking guidance.\n" +
      "  Now moving_object_observe is active while person/crowd can still boost fps.\n" +
      "  Demonstrates: same footage, different rules → different system behavior.",
    setup: true,
    camera: "front-door",
    config: POLICIES.walking_guidance,
  },
  {
    name: "Walking Guidance — Vehicle Detection",
    camera: "front-door",
    video: "demo-front-door-followup.mp4",
    waitSec: 120,
    narration:
      "Playing the follow-up demo clip (same camera, different time).\n" +
      "  Walking guidance detects vehicles → moving_object_observe fires.\n" +
      "  If 3+ people visible → crowded fires → fps=2.\n" +
      "  Compare the FPS curve with Act 1 — different rules, different response pattern.",
  },

  // Act 3: Scene Exit — custom_fields on side camera
  {
    name: "Act 3 Setup — Scene Exit Detection",
    narration:
      "Adding side-cam using the authorized side-entrance demo clip.\n" +
      "  Configuring: 'Watch this side entrance. If scene changes fundamentally, output custom_fields.scene_changed=true'.\n" +
      "  This tests VLM semantic understanding + VisionController custom_field trigger.",
    setup: true,
    camera: "side-cam",
    video: "demo-side-entrance.mp4",
    config: {
      enabled: true,
      baseline: { fps: 1 },
      auto_rules: [],
      segment_policy: {
        consultation_triggers: [
          { type: "custom_field", key: "scene_changed", value: true },
        ],
        consultation_cooldown_seconds: 30,
      },
    },
  },
  {
    name: "Side Camera Monitoring",
    camera: "side-cam",
    waitSec: 120,
    waitForAgent: true,
    narration:
      "Side entrance view — quiet alleyway with fence.\n" +
      "  VLM continuously analyzes the scene. If something unusual happens,\n" +
      "  VLM outputs custom_fields.scene_changed=true → Agent consulted.\n" +
      "  This shows VLM acting as a semantic sensor for the rule engine.",
  },
];

// ── Helpers ──

async function checkPort(url: string, label: string): Promise<boolean> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
    console.log(`  [OK] ${label} (${url}) — status ${resp.status}`);
    return true;
  } catch {
    console.log(`  [FAIL] ${label} (${url}) — unreachable`);
    return false;
  }
}

function checkFile(path: string, label: string): boolean {
  const ok = existsSync(path);
  console.log(`  ${ok ? "[OK]" : "[FAIL]"} ${label}: ${path}`);
  return ok;
}

async function callTool(name: string, params: Record<string, unknown>): Promise<unknown> {
  const resp = await fetch(`${HOST_URL}/api/tool/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return JSON.parse(await resp.text());
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function timestamp(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

function banner(text: string): void {
  const line = "=".repeat(60);
  console.log(`\n${line}`);
  console.log(`  ${text}`);
  console.log(line);
}

function narrate(text: string): void {
  console.log(`\n  [NARRATION] ${text}\n`);
}

// ── Pre-flight Checks ──

async function preflight(): Promise<boolean> {
  console.log("\n--- Pre-flight Checks ---\n");

  const portChecks = await Promise.all([
    checkPort(`${GO2RTC_URL}/api/streams`, "go2rtc"),
    checkPort(`${HOST_URL}/api/health`, "ReflectWorld Host"),
    checkPort(`${MONITOR_WS_URL.replace("ws", "http")}`, "Monitor"),
    checkPort(`${REFLECTWORLD_URL}/health`, "ReflectWorld Python"),
  ]);

  console.log();

  // Video files used in the demo. These must be authorized for public demos.
  const requiredVideos = [
    "demo-front-door-main.mp4",
    "demo-side-entrance.mp4",
    "demo-front-door-followup.mp4",
  ];
  const videoChecks = requiredVideos.map((v) =>
    checkFile(resolve(VIDEO_DIR, v), v),
  );

  console.log();

  // Model files (optional — Level 0 works without them)
  const modelChecks = [
    checkFile(resolve(MODEL_DIR, "yolo26m.onnx"), "YOLO26m"),
  ];

  const allServices = portChecks.every(Boolean);
  const allVideos = videoChecks.every(Boolean);

  console.log("\n--- Summary ---");
  console.log(`  Services: ${allServices ? "ALL OK" : "SOME MISSING"}`);
  console.log(`  Videos:   ${allVideos ? "ALL OK" : "SOME MISSING"}`);
  console.log(`  Models:   ${modelChecks.every(Boolean) ? "ALL OK" : "SOME MISSING (Level 0 still works)"}`);
  console.log();

  return allServices && allVideos;
}

// ── WebSocket Monitor ──

let monitorWs: WebSocket | null = null;

function connectMonitor(): Promise<WebSocket> {
  return new Promise((resolveWs) => {
    const ws = new WebSocket(MONITOR_WS_URL);
    monitorWs = ws;

    ws.addEventListener("open", () => resolveWs(ws));
    ws.addEventListener("error", () => resolveWs(ws)); // continue even if WS fails

    ws.addEventListener("message", (msg) => {
      try {
        const raw = typeof msg.data === "string" ? msg.data : String(msg.data);
        const evt = JSON.parse(raw);
        const type = evt.type as string;

        if (type === "perception:vlm_result") stats.vlmCalls++;
        if (type === "vision_controller:rule_fired") stats.rulesFired++;
        if (type === "vision_controller:agent_consulted") stats.agentConsultations++;
        if (type === "vision_controller:state_changed") stats.stateChanges++;
        if (type === "cam:segment_built") stats.segmentsProcessed++;

        // Log notable events
        if (type === "vision_controller:rule_fired") {
          const rules = (evt.data?.rules as string[]) ?? [];
          console.log(`  [EVENT] ${timestamp()} Rule fired: ${rules.join(", ")}`);
        }
        if (type === "vision_controller:agent_consulted") {
          console.log(`  [EVENT] ${timestamp()} Agent consulted (${evt.data?.phase ?? "unknown"})`);
        }
        if (type === "vision_controller:state_changed") {
          const d = evt.data ?? {};
          const label = d.is_baseline ? "BASELINE" : `RULES: ${(d.fired_rules as string[])?.join(", ")}`;
          console.log(`  [STATE] ${timestamp()} fps=${d.fps} level=${d.max_level} [${label}]`);
        }
      } catch {
        // ignore parse errors
      }
    });
  });
}

// ── Phase Execution ──

async function configureVisionController(config: Record<string, unknown>): Promise<void> {
  console.log(`  Configuring VisionController...`);
  try {
    await callTool("reflectworld_perception", {
      action: "configure",
      vc_rules_json: JSON.stringify(config.auto_rules),
      vc_segment_policy_json: config.segment_policy
        ? JSON.stringify(config.segment_policy)
        : undefined,
    });
  } catch (err) {
    console.error(`  [WARN] configure failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function switchVideo(camera: string, videoFile: string): Promise<void> {
  const videoPath = resolve(VIDEO_DIR, videoFile);
  console.log(`  Switching ${camera} to ${videoFile}`);
  try {
    // Remove existing source, then re-add with new video
    await callTool("reflectworld_cam", { action: "remove_source", name: camera }).catch(() => {});
    await sleep(500);
    await callTool("reflectworld_cam", {
      action: "add_source",
      name: camera,
      url: videoPath,
    });
  } catch (err) {
    console.error(`  [WARN] switch failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function waitForAgentResponse(timeoutSec: number): Promise<boolean> {
  const start = Date.now();
  const initialCount = stats.agentConsultations;
  console.log(`  Waiting up to ${timeoutSec}s for Agent response...`);

  while (Date.now() - start < timeoutSec * 1000) {
    if (stats.agentConsultations > initialCount) {
      console.log(`  Agent responded!`);
      return true;
    }
    await sleep(1000);
  }

  console.log(`  Agent timeout (${timeoutSec}s) — continuing.`);
  return false;
}

async function runPhase(phase: DemoPhase, index: number): Promise<void> {
  banner(`Phase ${index + 1}/${PHASES.length}: ${phase.name}`);
  narrate(phase.narration);

  if (phase.setup) {
    if (phase.config) {
      await configureVisionController(phase.config);
    }
    if (phase.video && phase.camera) {
      await switchVideo(phase.camera, phase.video);
    }
    return;
  }

  // Switch video source
  if (phase.video && phase.camera) {
    await switchVideo(phase.camera, phase.video);
  }

  // Wait for processing
  if (phase.waitSec) {
    if (phase.waitForAgent) {
      const agentWait = Math.min(phase.waitSec, 30);
      const remaining = phase.waitSec - agentWait;
      await waitForAgentResponse(agentWait);
      if (remaining > 0) {
        console.log(`  Waiting ${remaining}s more for pipeline...`);
        await sleep(remaining * 1000);
      }
    } else {
      console.log(`  Waiting ${phase.waitSec}s...`);
      await sleep(phase.waitSec * 1000);
    }
  }
}

// ── Statistics ──

function printStatistics(): void {
  const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(0);

  banner("Demo Complete — Statistics");
  console.log(`
  Duration:             ${elapsed}s
  Segments processed:   ${stats.segmentsProcessed}
  VLM calls:            ${stats.vlmCalls}
  State changes:        ${stats.stateChanges}
  Rules fired:          ${stats.rulesFired}
  Agent consultations:  ${stats.agentConsultations}
  `);

  if (stats.segmentsProcessed > 0 && stats.vlmCalls < stats.segmentsProcessed) {
    const saved = (((stats.segmentsProcessed - stats.vlmCalls) / stats.segmentsProcessed) * 100).toFixed(0);
    console.log(`  VLM cost savings:    ~${saved}% (${stats.segmentsProcessed - stats.vlmCalls} segments skipped VLM)`);
  }
  console.log();
}

// ── Main ──

async function main(): Promise<void> {
  const preflightOnly = process.argv.includes("--preflight-only");

  const ok = await preflight();

  if (preflightOnly) {
    process.exit(ok ? 0 : 1);
  }

  if (!ok) {
    console.error("\nPre-flight checks failed. Start all services first:");
    console.error("  npx @reflectworld/reflectworld start\n");
    process.exit(1);
  }

  // Connect to Monitor WebSocket for event tracking
  const ws = await connectMonitor();

  stats.startTime = Date.now();
  banner("ReflectWorld VisionController Demo");
  console.log("\n  Open Monitor: http://localhost:3211/\n");

  // Run all phases
  for (let i = 0; i < PHASES.length; i++) {
    await runPhase(PHASES[i], i);
  }

  // Print final statistics
  printStatistics();

  // Cleanup
  ws.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nDemo failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
