#!/usr/bin/env npx tsx
/**
 * VisionController Full Lifecycle Test
 *
 * Simulates the complete cycle:
 *   Initial config → video stream → VisionController rule fires → Agent consulted →
 *   Agent reasons & reconfigures → new config takes effect → scene changes → baseline recovery
 *
 * The "Agent" is simulated as a decision function that receives VisionController consultation
 * context and returns a new configuration, mimicking what OpenClaw would do.
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";

const scriptDir = new URL(".", import.meta.url).pathname;
loadEnv({ path: join(scriptDir, "../.env") });

import { resolvePerceptionConfig } from "../packages/percept/src/config.js";
import { createPipelineDeps, analyze, type PipelineDeps } from "../packages/percept/src/pipeline.js";
import { VisionController } from "../packages/cortex/src/vision-controller/index.js";
import type { RuleAction } from "../packages/cortex/src/vc-types/types.js";
import type { VisionControllerConfig } from "../packages/cortex/src/vision-controller/index.js";
import type { Segment, Frame, PerceptionResult, MotionHint } from "@cortex/shared";
import { MotionFilter } from "../packages/cam/src/motion-filter.js";
import type { MediaSaver } from "../packages/percept/src/media-uploader.js";

// ── Config ──

const VIDEO_DIR = join(scriptDir, "../eval/video-runner/fixtures/videos");
const OUTPUT_DIR = join(scriptDir, "../eval/video-runner/fixtures/vision-controller-results");
const REPORT_PATH = join(OUTPUT_DIR, "full-lifecycle-report.md");

// ── Types ──

interface TimelineEntry {
  step: number;
  timestamp: string;
  phase: string;
  video: string;
  frameIndex: number;

  // Perception output
  perceptionLevel: number;
  entities: string[];
  entityCount: number;
  securityRisk: boolean;
  isStaticScene: boolean;
  summary: string;
  vlmLatencyMs: number;

  // Motion state
  hasMotion: boolean;

  // VisionController output
  firedRules: string[];
  action: RuleAction;
  shouldConsultAgent: boolean;
  consultReason?: string;

  // Effective config after this step
  effectiveFps: number;
  effectiveMaxLevel: number;

  // Agent action (if any)
  agentAction?: string;
  agentReasoning?: string;
  configChangeApplied?: Partial<VisionControllerConfig>;
}

// ── Helpers ──

function extractFrames(videoPath: string, fps: number, maxFrames: number): Buffer[] {
  const tmpDir = join(OUTPUT_DIR, "frames", videoPath.replace(/[^a-zA-Z0-9]/g, "_"));
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
  execSync(
    `ffmpeg -y -i "${videoPath}" -vf "fps=${fps}" -q:v 5 -frames:v ${maxFrames} "${tmpDir}/f_%03d.jpg" 2>/dev/null`,
    { timeout: 30_000 },
  );
  return readdirSync(tmpDir).filter(f => f.endsWith(".jpg")).sort().map(f => readFileSync(join(tmpDir, f)));
}

function makeSegment(cameraId: string, mode: "snapshot" | "event" | "stream", frames: Frame[], motionHint?: MotionHint): Segment {
  return {
    segment_id: `seg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    camera_id: cameraId,
    mode,
    frames,
    raw_url: "",
    timestamp: frames[0]?.timestamp ?? Date.now(),
    duration_sec: frames.length <= 1 ? 0 : frames.length,
    _motion_hint: motionHint,
  };
}

const nullMediaSaver: MediaSaver = {
  saveKeyframe: () => "/dev/null",
  saveGif: () => "/dev/null",
  saveCrop: () => "/dev/null",
};

// ── Simulated Agent ──

/**
 * Simulates OpenClaw Agent's reasoning when it receives a VisionController consultation.
 * In production, this would be the LLM processing the notification and calling
 * perception.configure() with new VisionController settings.
 */
function simulateAgentDecision(
  consultationContext: { trigger_reason: { type: string } },
  currentConfig: VisionControllerConfig,
  perceptionResult: PerceptionResult,
): { reasoning: string; action: string; newConfig?: Partial<VisionControllerConfig> } {
  const entities = perceptionResult.perception_memory.entities ?? [];
  const hasPerson = entities.some(e => e.type === "person");
  const isRisk = perceptionResult.perception_memory.security_risk;
  const hasUnknown = entities.some(e => e.is_new_entity);

  // Agent reasoning based on context
  if (isRisk && hasUnknown) {
    return {
      reasoning: "Security risk detected with unknown person. Adding a voice detection trigger for additional context.",
      action: "ESCALATE_MAX",
      newConfig: {
        rules: [
          ...currentConfig.rules,
          {
            name: "voice_monitor",
            trigger: { type: "voice_detected" },
            action: { fps: 2 },
            cooldown_ms: 5000,
          },
        ],
        segment_policy: {
          consultation_triggers: [
            { type: "security_risk" },
            { type: "voice_detected" },
          ],
          consultation_cooldown_seconds: 15,
        },
      },
    };
  }

  if (isRisk && !hasUnknown) {
    return {
      reasoning: "Security risk detected. Adding motion_sustained trigger for persistent threat detection, and lowering Agent consultation cooldown to 10s for faster response.",
      action: "ESCALATE_SECURITY",
      newConfig: {
        rules: [
          ...currentConfig.rules,
          {
            name: "sustained_threat",
            trigger: { type: "motion_sustained_ms", duration: 3000 },
            action: { fps: 2 },
            cooldown_ms: 5000,
          },
        ],
        segment_policy: {
          consultation_triggers: [
            { type: "security_risk" },
          ],
          consultation_cooldown_seconds: 10,
        },
      },
    };
  }

  if (hasUnknown && !isRisk) {
    return {
      reasoning: "New person detected without security risk. Adding face focus rule for better identification, keeping current escalation.",
      action: "ADD_FACE_FOCUS",
      newConfig: {
        rules: [
          ...currentConfig.rules,
          {
            name: "face_focus",
            trigger: { type: "face_detected" },
            action: { fps: 2 },
            cooldown_ms: 3000,
          },
        ],
      },
    };
  }

  return {
    reasoning: "No specific action needed. Current configuration is adequate.",
    action: "NO_CHANGE",
  };
}

// ── Main Test ──

async function main() {
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║       VisionController Full Lifecycle Test                  ║");
  console.log("║       Camera: front-door | Basic frame policy              ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  // ── Step 0: Initialize pipeline ──
  console.log("[INIT] Loading real models (YOLO26m + RetinaFace + ArcFace)...");
  const config = resolvePerceptionConfig({
    stubs_only: false,
    stt_provider: "",
    vlm_model_override: "gemini-2.5-flash",
  });
  const deps = await createPipelineDeps(config, nullMediaSaver);
  console.log("[INIT] Pipeline ready.\n");

  // ── Step 1: Configure VisionController with basic frame policy ──
  const initialConfig: VisionControllerConfig = {
    enabled: true,
    baseline: { fps: 1 },
    rules: [
      {
        name: "person_present",
        trigger: { type: "class_detected", class: "person" },
        action: { fps: 2 },
        cooldown_ms: 5000,
        hold_ms: 30_000,
      },
    ],
    segment_policy: {
      consultation_triggers: [{ type: "security_risk" }],
      consultation_cooldown_seconds: 60,
    },
  };

  const vc = new VisionController(initialConfig);
  const cameraId = "cam-front-door";

  // Track effective state (what the system would actually be running at)
  let effectiveFps = initialConfig.baseline.fps!;
  let effectiveMaxLevel = 1;

  console.log("[CONFIG] Initial VisionController configuration:");
  console.log(`  Policy: basic_frame_policy`);
  console.log(`  Baseline: fps=${effectiveFps}, max_level=${effectiveMaxLevel}`);
  console.log(`  Rules: ${initialConfig.rules.map(r => r.name).join(", ")}`);
  console.log(`  Segment policy: ${initialConfig.segment_policy?.consultation_triggers.map(t => t.type).join(", ")}`);
  console.log("");

  // ── Define scenario phases ──
  const phases = [
    {
      name: "Phase 1: Night quiet (empty room)",
      description: "Camera monitors an empty room at night. No activity. VisionController should maintain baseline low-power mode.",
      video: "11-empty-room.mp4",
      fps: 1, maxFrames: 3,
      expectedBehavior: "Baseline: fps=1",
    },
    {
      name: "Phase 2: Intruder appears",
      description: "An unknown person enters the frame. YOLO detects person → person_present rule fires → fps jumps to 2.",
      video: "02-thief-creep-house.mp4",
      fps: 1, maxFrames: 3,
      expectedBehavior: "Frame policy boost: fps=2",
    },
    {
      name: "Phase 3: Security risk confirmed",
      description: "Intruder is clearly suspicious. VLM flags security_risk. segment_policy fires → Agent consulted.",
      video: "01-thieves-security-cam.mp4",
      fps: 2, maxFrames: 3,
      expectedBehavior: "Agent consultation triggered",
    },
    {
      name: "Phase 4: Continued surveillance (post-Agent)",
      description: "Agent has potentially reconfigured. System runs with updated rules. Intruder still present.",
      video: "04-thief-server-room.mp4",
      fps: 1, maxFrames: 3,
      expectedBehavior: "Updated rules in effect",
    },
    {
      name: "Phase 5: Scene clears (empty room returns)",
      description: "Intruder leaves. Room is empty again. No person detected → no rules fire → baseline recovery.",
      video: "11-empty-room.mp4",
      fps: 1, maxFrames: 2,
      expectedBehavior: "Baseline recovery: fps=1",
    },
    {
      name: "Phase 6: Continued quiet",
      description: "Room remains empty. Baseline holds. System is back to low-power mode.",
      video: "11-empty-room.mp4",
      fps: 0.5, maxFrames: 2,
      expectedBehavior: "Baseline maintained",
    },
  ];

  const timeline: TimelineEntry[] = [];
  let stepCount = 0;
  let agentConsultationCount = 0;
  let currentConfig = { ...initialConfig };

  // ── Execute phases ──
  for (const phase of phases) {
    console.log(`\n${"═".repeat(70)}`);
    console.log(`  ${phase.name}`);
    console.log(`  ${phase.description}`);
    console.log(`  Expected: ${phase.expectedBehavior}`);
    console.log(`${"═".repeat(70)}`);

    const videoPath = join(VIDEO_DIR, phase.video);
    const jpegFrames = extractFrames(videoPath, phase.fps, phase.maxFrames);

    for (let i = 0; i < jpegFrames.length; i++) {
      stepCount++;
      const frameData = jpegFrames[i].toString("base64");
      const frame: Frame = { data: frameData, timestamp: Date.now(), index: i };

      // Run MotionFilter
      const motionFilter = new MotionFilter({ confirmFrames: 1, maxChangeRatio: 1.0 });
      for (let j = 0; j <= i && j < jpegFrames.length; j++) {
        motionFilter.detectWithRatio(jpegFrames[j]);
      }
      const motionHint: MotionHint = {
        has_motion: motionFilter.lastMotionAt > motionFilter.lastStillAt,
        ratio: 0,
        last_motion_at: motionFilter.lastMotionAt,
        last_still_at: motionFilter.lastStillAt,
      };

      // Build segment (single frame for speed, multi-frame for event)
      const segment = makeSegment(cameraId, "stream", [frame], motionHint);

      // Run perception pipeline
      const t0 = Date.now();
      const result = await analyze(segment, deps);
      const vlmLatency = Date.now() - t0;

      // Evaluate VisionController
      const output = vc.evaluateSegment(result, segment);

      // Apply effective config changes
      if (output.firedRules.length > 0) {
        if (output.action.fps != null) effectiveFps = output.action.fps;
        if (output.action.max_level != null) effectiveMaxLevel = output.action.max_level;
      } else {
        // No rules fired → baseline
        effectiveFps = currentConfig.baseline.fps!;
        effectiveMaxLevel = currentConfig.baseline.max_level ?? 1;
      }

      const entities = (result.perception_memory.entities ?? []).map(e => e.type);
      const entry: TimelineEntry = {
        step: stepCount,
        timestamp: new Date().toISOString(),
        phase: phase.name,
        video: phase.video,
        frameIndex: i,
        perceptionLevel: result.perception_memory.perception_level,
        entities,
        entityCount: entities.length,
        securityRisk: result.perception_memory.security_risk,
        isStaticScene: result.perception_memory.is_static_scene ?? false,
        summary: result.perception_memory.summary,
        vlmLatencyMs: vlmLatency,
        hasMotion: motionHint.has_motion,
        firedRules: output.firedRules,
        action: output.action,
        shouldConsultAgent: output.shouldConsultAgent,
        consultReason: output.consultationContext?.trigger_reason?.type,
        effectiveFps,
        effectiveMaxLevel,
      };

      // Log step
      const rulesStr = output.firedRules.length > 0 ? `rules=[${output.firedRules}]` : "baseline";
      console.log(
        `  [Step ${stepCount}] ${rulesStr} | entities=[${entities}] risk=${result.perception_memory.security_risk} ` +
        `| fps=${effectiveFps} level=${effectiveMaxLevel} ` +
        `| ${result.perception_memory.summary.slice(0, 60)}...`
      );

      // Handle Agent consultation
      if (output.shouldConsultAgent && output.consultationContext) {
        agentConsultationCount++;
        console.log(`\n  ┌─── AGENT CONSULTATION #${agentConsultationCount} ───────────────────────┐`);
        console.log(`  │ Trigger: ${output.consultationContext.trigger_reason.type}`);
        console.log(`  │ Camera: ${output.consultationContext.camera_id}`);

        const agentDecision = simulateAgentDecision(output.consultationContext, currentConfig, result);

        console.log(`  │ Agent reasoning: ${agentDecision.reasoning.slice(0, 80)}`);
        console.log(`  │ Agent action: ${agentDecision.action}`);

        entry.agentAction = agentDecision.action;
        entry.agentReasoning = agentDecision.reasoning;

        if (agentDecision.newConfig) {
          // Agent reconfigures VisionController
          vc.reconfigure(agentDecision.newConfig);
          currentConfig = { ...currentConfig, ...agentDecision.newConfig };
          entry.configChangeApplied = agentDecision.newConfig;

          const newRuleNames = (agentDecision.newConfig.rules ?? []).map((r: { name: string }) => r.name);
          console.log(`  │ Config updated: +rules=[${newRuleNames.filter(n => !initialConfig.rules.some(r => r.name === n))}]`);
        }
        console.log(`  └──────────────────────────────────────────────────┘\n`);
      }

      timeline.push(entry);
    }
  }

  // ── Generate Report ──
  console.log("\n\n");
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║                    GENERATING REPORT                       ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  const report = generateReport(timeline, initialConfig, agentConsultationCount);
  writeFileSync(REPORT_PATH, report);
  console.log(`\nReport saved to: ${REPORT_PATH}`);

  // Also save raw timeline
  writeFileSync(join(OUTPUT_DIR, "timeline.json"), JSON.stringify(timeline, null, 2));
  console.log(`Timeline saved to: ${join(OUTPUT_DIR, "timeline.json")}`);
}

function generateReport(timeline: TimelineEntry[], initialConfig: VisionControllerConfig, consultCount: number): string {
  let md = `# VisionController Full Lifecycle Test Report

> Generated: ${new Date().toISOString()}
> Camera: cam-front-door | Policy: basic_frame_policy

## Scenario

Simulated night security watch on a front door camera. The test walks through a complete lifecycle:
1. Empty room (quiet) → low-power baseline
2. Intruder appears → detection triggers escalation
3. Security risk confirmed → Agent consulted for strategic decision
4. Post-Agent surveillance → updated rules in effect
5. Scene clears → automatic baseline recovery
6. Continued quiet → baseline maintained

## Initial Configuration

| Parameter | Value |
|-----------|-------|
| Policy | basic_frame_policy |
| Baseline FPS | ${initialConfig.baseline.fps} |
| Baseline max_level | ${initialConfig.baseline.max_level ?? 1} |
| Rules | ${initialConfig.rules.map((r: { name: string; trigger: { type: string } }) => r.name + " (" + r.trigger.type + ")").join(", ")} |
| Segment policy triggers | ${initialConfig.segment_policy?.consultation_triggers.map(t => t.type).join(", ")} |

## Timeline

| Step | Phase | Entities | Risk | Rules Fired | FPS | Agent | Summary |
|------|-------|----------|------|-------------|-----|-------|---------|
`;

  for (const e of timeline) {
    const phaseName = e.phase.replace(/Phase \d+: /, "");
    const entitiesStr = e.entities.length > 0 ? e.entities.join(",") : "—";
    const rulesStr = e.firedRules.length > 0 ? e.firedRules.join(",") : "baseline";
    const agentStr = e.shouldConsultAgent ? `✉️ ${e.agentAction ?? "consulted"}` : "—";
    const summaryShort = e.summary.slice(0, 50).replace(/\|/g, "\\|");

    md += `| ${e.step} | ${phaseName} | ${entitiesStr} | ${e.securityRisk ? "⚠️" : "—"} | ${rulesStr} | ${e.effectiveFps} | ${agentStr} | ${summaryShort}... |\n`;
  }

  // Agent consultation details
  const consultations = timeline.filter(e => e.shouldConsultAgent);
  if (consultations.length > 0) {
    md += `\n## Agent Consultations\n\n`;
    for (let i = 0; i < consultations.length; i++) {
      const c = consultations[i];
      md += `### Consultation ${i + 1} (Step ${c.step})\n\n`;
      md += `- **Trigger**: \`${c.consultReason}\`\n`;
      md += `- **Context**: entities=[${c.entities}], security_risk=${c.securityRisk}\n`;
      md += `- **Agent reasoning**: ${c.agentReasoning}\n`;
      md += `- **Agent action**: \`${c.agentAction}\`\n`;
      if (c.configChangeApplied) {
        const newRules = (c.configChangeApplied.rules ?? []) as Array<{ name: string; trigger: { type: string } }>;
        md += `- **Config change**: added rules [${newRules.map(r => r.name).join(", ")}]\n`;
      }
      md += `\n`;
    }
  }

  // Config state transitions
  md += `## Configuration State Transitions\n\n\`\`\`\n`;

  let prevFps = initialConfig.baseline.fps!;
  md += `[Initial] fps=${prevFps} (basic frame policy baseline)\n`;

  for (const e of timeline) {
    if (e.effectiveFps !== prevFps) {
      const reason = e.firedRules.length > 0 ? `rule: ${e.firedRules[0]}` : "baseline recovery";
      md += `[Step ${e.step}] fps=${prevFps}→${e.effectiveFps} (${reason})\n`;
      prevFps = e.effectiveFps;
    }
    if (e.agentAction && e.configChangeApplied) {
      md += `[Step ${e.step}] AGENT: ${e.agentAction} — config updated\n`;
    }
  }
  md += `\`\`\`\n`;

  // Summary statistics
  const baselineSteps = timeline.filter(e => e.firedRules.length === 0);
  const escalatedSteps = timeline.filter(e => e.firedRules.length > 0);

  md += `\n## Summary Statistics\n\n`;
  md += `| Metric | Value |\n`;
  md += `|--------|-------|\n`;
  md += `| Total steps | ${timeline.length} |\n`;
  md += `| Baseline steps (low-power) | ${baselineSteps.length} |\n`;
  md += `| Escalated steps (rules fired) | ${escalatedSteps.length} |\n`;
  md += `| Agent consultations | ${consultCount} |\n`;
  md += `| Avg VLM latency | ${Math.round(timeline.reduce((s, e) => s + e.vlmLatencyMs, 0) / timeline.length)}ms |\n`;

  md += `\n## Data Flow Architecture\n\n`;
  md += `\`\`\`\n`;
  md += `Video Frame\n`;
  md += `  → MotionFilter.detectWithRatio() → _motion_hint attached to Segment\n`;
  md += `  → Perception Pipeline (YOLO26m + RetinaFace + VLM)\n`;
  md += `  → PerceptionResult (entities, security_risk, is_static_scene, custom_fields)\n`;
  md += `  → VisionController.evaluateSegment(result, segment)\n`;
  md += `      ├─ Frame policy: rule engine (< 1ms)\n`;
  md += `      │   Scan rules by priority, first-write-wins per field\n`;
  md += `      │   No rules fired → apply baseline\n`;
  md += `      │   → Adjust: set_sampling(fps), switch_mode, setFramePolicyOverride(max_level)\n`;
  md += `      └─ Segment policy: Agent Consultation (fire-and-forget)\n`;
  md += `          segment_policy matches → Notifier.sendAlert(context)\n`;
  md += `          → Agent receives notification with full signals\n`;
  md += `          → Agent calls perception.configure({ vc_rules_json: newRules })\n`;
  md += `          → VisionController.reconfigure() applies changes immediately\n`;
  md += `\`\`\`\n`;

  md += `\n## Conclusion\n\n`;

  const hasBaseline = baselineSteps.length > 0;
  const hasEscalation = escalatedSteps.length > 0;
  const hasConsult = consultCount > 0;
  const hasRecovery = timeline.length > 2 &&
    timeline[timeline.length - 1].firedRules.length === 0 &&
    timeline.some(e => e.firedRules.length > 0);

  md += `| Behavior | Verified |\n`;
  md += `|----------|----------|\n`;
  md += `| Baseline low-power mode | ${hasBaseline ? "✅" : "❌"} |\n`;
  md += `| Rule-triggered escalation | ${hasEscalation ? "✅" : "❌"} |\n`;
  md += `| Agent consultation triggered | ${hasConsult ? "✅" : "❌"} |\n`;
  md += `| Agent reconfiguration applied | ${consultations.some(c => c.configChangeApplied) ? "✅" : "❌"} |\n`;
  md += `| Baseline recovery after scene clears | ${hasRecovery ? "✅" : "❌"} |\n`;

  return md;
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
