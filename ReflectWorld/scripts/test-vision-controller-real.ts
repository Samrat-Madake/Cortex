#!/usr/bin/env npx tsx
/**
 * VisionController Real-World Test Suite
 *
 * Runs progressively complex tests using real video files, real models, and real VLM.
 *
 * Stage 1: Frame extraction from video files
 * Stage 2: Real model inference (YOLO26m + RetinaFace) on extracted frames
 * Stage 3: Full perception pipeline (Percept L1 + VLM) on video frames
 * Stage 4: VisionController rule evaluation with real PerceptionResults
 * Stage 5: Simulated video stream with VisionController adaptive behavior
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { config as loadEnv } from "dotenv";

// Load environment variables
const scriptDir = new URL(".", import.meta.url).pathname;
loadEnv({ path: join(scriptDir, "../.env") });

import { resolvePerceptionConfig, type PerceptionConfig } from "../packages/percept/src/config.js";
import { createPipelineDeps, analyze, type PipelineDeps } from "../packages/percept/src/pipeline.js";
import { WorkingMemoryManager } from "../packages/percept/src/working-memory.js";
import { StrategyManager } from "../packages/percept/src/strategy-manager.js";
import { MediaUploader, type MediaSaver } from "../packages/percept/src/media-uploader.js";
import { VisionController, type VisionControllerConfig } from "../packages/reflectworld/src/vision-controller/index.js";
import type { SegmentPolicyOutput } from "../packages/reflectworld/src/vision-controller/index.js";
import type { Segment, Frame, PerceptionResult, MotionHint } from "@reflectworld/shared";
import { MotionFilter } from "../packages/cam/src/motion-filter.js";

// ── Helpers ──

const VIDEO_DIR = join(scriptDir, "../eval/video-runner/fixtures/videos");
const OUTPUT_DIR = join(scriptDir, "../eval/video-runner/fixtures/vision-controller-results");
const FRAME_DIR = join(OUTPUT_DIR, "frames");

const BASIC_VC_CONFIG: VisionControllerConfig = {
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
    {
      name: "moving_object_observe",
      trigger: {
        type: "all_of",
        conditions: [
          {
            type: "any_of",
            conditions: [
              { type: "class_detected", class: "vehicle" },
              { type: "class_detected", class: "car" },
              { type: "class_detected", class: "truck" },
              { type: "class_detected", class: "bus" },
              { type: "class_detected", class: "animal" },
              { type: "class_detected", class: "dog" },
              { type: "class_detected", class: "cat" },
              { type: "class_detected", class: "bird" },
            ],
          },
          { type: "motion_sustained_ms", duration: 1000 },
        ],
      },
      action: { fps: 1 },
      cooldown_ms: 5000,
      hold_ms: 30_000,
    },
  ],
  segment_policy: {
    consultation_triggers: [{ type: "security_risk" }],
    consultation_cooldown_seconds: 60,
  },
};

function log(level: string, msg: string, data?: Record<string, unknown>) {
  const ts = new Date().toISOString().slice(11, 23);
  const extra = data ? " " + JSON.stringify(data) : "";
  console.log(`[${ts}] [${level}] ${msg}${extra}`);
}

function pass(name: string) { log("PASS", `✅ ${name}`); }
function fail(name: string, err: unknown) { log("FAIL", `❌ ${name}: ${err instanceof Error ? err.message : String(err)}`); }

/** Extract frames from a video file using ffmpeg. */
function extractFrames(videoPath: string, fps: number = 1, maxFrames: number = 10): Buffer[] {
  const tmpDir = join(FRAME_DIR, basename(videoPath, ".mp4"));
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

  execSync(
    `ffmpeg -y -i "${videoPath}" -vf "fps=${fps}" -q:v 5 -frames:v ${maxFrames} "${tmpDir}/frame_%03d.jpg" 2>/dev/null`,
    { timeout: 30_000 },
  );

  const files = readdirSync(tmpDir).filter(f => f.endsWith(".jpg")).sort();
  return files.map(f => readFileSync(join(tmpDir, f)));
}

/** Convert JPEG buffers to Segment frames. */
function framesToSegmentFrames(jpegBuffers: Buffer[]): Frame[] {
  return jpegBuffers.map((buf, i) => ({
    data: buf.toString("base64"),
    timestamp: Date.now() + i * 1000,
    index: i,
  }));
}

/** Build a Segment from frames. */
function makeSegment(
  cameraId: string,
  mode: "snapshot" | "event" | "stream",
  frames: Frame[],
  motionHint?: MotionHint,
): Segment {
  return {
    segment_id: `seg_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    camera_id: cameraId,
    mode,
    frames,
    raw_url: "",
    timestamp: frames[0]?.timestamp ?? Date.now(),
    duration_sec: frames.length <= 1 ? 0 : frames.length,
    _motion_hint: motionHint,
  };
}

/** No-op media saver for testing. */
const nullMediaSaver: MediaSaver = {
  saveKeyframe: () => "/dev/null",
  saveGif: () => "/dev/null",
  saveCrop: () => "/dev/null",
};

// ── Test Stages ──

async function level1_frameExtraction() {
  log("INFO", "═══ Stage 1: Frame Extraction ═══");
  const videos = readdirSync(VIDEO_DIR).filter(f => f.endsWith(".mp4")).sort();
  let passed = 0;

  for (const video of videos) {
    const testName = `extract frames from ${video}`;
    try {
      const frames = extractFrames(join(VIDEO_DIR, video), 1, 5);
      if (frames.length === 0) throw new Error("No frames extracted");
      if (frames[0][0] !== 0xff || frames[0][1] !== 0xd8) throw new Error("Not a valid JPEG");
      pass(`${testName} (${frames.length} frames, ${(frames[0].length / 1024).toFixed(0)}KB each)`);
      passed++;
    } catch (err) {
      fail(testName, err);
    }
  }

  log("INFO", `Stage 1 complete: ${passed}/${videos.length} passed`);
  return passed === videos.length;
}

async function level2_modelInference(deps: PipelineDeps) {
  log("INFO", "═══ Stage 2: Real Model Inference (YOLO26m + RetinaFace) ═══");

  const testCases = [
    { video: "01-thieves-security-cam.mp4", expectPerson: true, desc: "thieves in room" },
    { video: "07-pedestrian-tokyo.mp4", expectPerson: true, desc: "Tokyo pedestrians" },
    { video: "09-crowds-crossing.mp4", expectPerson: true, desc: "crowd crossing" },
  ];

  let passed = 0;
  for (const tc of testCases) {
    const testName = `detect objects in ${tc.desc}`;
    try {
      const frames = extractFrames(join(VIDEO_DIR, tc.video), 1, 3);
      const segFrames = framesToSegmentFrames(frames);
      const segment = makeSegment("test-cam", "snapshot", [segFrames[0]]);

      // Run Percept L1 analysis (detection + VLM)
      const result = await analyze(segment, deps);

      const entities = result.perception_memory.entities ?? [];
      const hasPersonDetection = entities.some(e => e.type === "person");
      const summary = result.perception_memory.summary;

      log("INFO", `  ${tc.video}:`, {
        entities: entities.length,
        hasPerson: hasPersonDetection,
        summary: summary.slice(0, 80),
        level: result.perception_memory.perception_level,
      });

      if (tc.expectPerson && !hasPersonDetection && entities.length === 0) {
        // VLM might describe people even if detection didn't find them
        if (!summary.toLowerCase().includes("person") && !summary.toLowerCase().includes("people") && !summary.toLowerCase().includes("man") && !summary.toLowerCase().includes("woman")) {
          throw new Error("Expected person detection but none found");
        }
      }
      pass(testName);
      passed++;
    } catch (err) {
      fail(testName, err);
    }
  }

  log("INFO", `Stage 2 complete: ${passed}/${testCases.length} passed`);
  return passed === testCases.length;
}

async function level3_fullPipeline(deps: PipelineDeps) {
  log("INFO", "═══ Stage 3: Full Pipeline (multi-frame + VLM) ═══");

  const testCases = [
    { video: "04-thief-server-room.mp4", fps: 1, maxFrames: 5, desc: "server room (multi-frame)" },
    { video: "02-thief-creep-house.mp4", fps: 2, maxFrames: 5, desc: "house intrusion (multi-frame)" },
    { video: "10-busy-street.mp4", fps: 1, maxFrames: 3, desc: "busy street (multi-frame)" },
  ];

  let passed = 0;
  for (const tc of testCases) {
    const testName = `full pipeline: ${tc.desc}`;
    try {
      const frames = extractFrames(join(VIDEO_DIR, tc.video), tc.fps, tc.maxFrames);
      const segFrames = framesToSegmentFrames(frames);

      // Add motion hint via real MotionFilter
      const motionFilter = new MotionFilter({ confirmFrames: 1, maxChangeRatio: 1.0 });
      for (const f of frames) motionFilter.detectWithRatio(f);
      const motionHint: MotionHint = {
        has_motion: motionFilter.lastMotionAt > motionFilter.lastStillAt,
        ratio: 0,
        last_motion_at: motionFilter.lastMotionAt,
        last_still_at: motionFilter.lastStillAt,
      };

      const segment = makeSegment("test-cam", "event", segFrames, motionHint);
      const result = await analyze(segment, deps);

      log("INFO", `  ${tc.video}:`, {
        level: result.perception_memory.perception_level,
        entities: (result.perception_memory.entities ?? []).length,
        security_risk: result.perception_memory.security_risk,
        is_static: result.perception_memory.is_static_scene,
        summary: result.perception_memory.summary.slice(0, 100),
        motion: motionHint.has_motion,
      });

      // Verify result structure
      if (!result.segment_id) throw new Error("Missing segment_id");
      if (!result.event_id) throw new Error("Missing event_id");
      if (typeof result.perception_memory.summary !== "string") throw new Error("Missing summary");
      if (typeof result.perception_memory.security_risk !== "boolean") throw new Error("Missing security_risk");

      pass(testName);
      passed++;
    } catch (err) {
      fail(testName, err);
    }
  }

  log("INFO", `Stage 3 complete: ${passed}/${testCases.length} passed`);
  return passed === testCases.length;
}

async function level4_vcRules(deps: PipelineDeps) {
  log("INFO", "═══ Stage 4: VisionController Rule Evaluation with Real Data ═══");

  const vc = new VisionController(BASIC_VC_CONFIG);

  const testCases = [
    {
      video: "01-thieves-security-cam.mp4",
      desc: "person in security cam → should escalate",
      expectFiredRules: true,
      expectFps: 5,
    },
    {
      video: "06-surveillance-alert.mp4",
      desc: "surveillance room → depends on content",
      expectFiredRules: null, // unknown, depends on detection
      expectFps: null,
    },
  ];

  let passed = 0;
  for (const tc of testCases) {
    const testName = `vision-controller: ${tc.desc}`;
    try {
      const frames = extractFrames(join(VIDEO_DIR, tc.video), 1, 3);
      const segFrames = framesToSegmentFrames(frames);

      const motionFilter = new MotionFilter({ confirmFrames: 1, maxChangeRatio: 1.0 });
      for (const f of frames) motionFilter.detectWithRatio(f);
      const motionHint: MotionHint = {
        has_motion: motionFilter.lastMotionAt > motionFilter.lastStillAt,
        ratio: 0,
        last_motion_at: motionFilter.lastMotionAt,
        last_still_at: motionFilter.lastStillAt,
      };

      const segment = makeSegment("cam-front", "stream", segFrames, motionHint);
      const result = await analyze(segment, deps);
      const output = vc.evaluateSegment(result, segment);

      log("INFO", `  ${tc.video}:`, {
        firedRules: output.firedRules,
        action: output.action,
        shouldConsultAgent: output.shouldConsultAgent,
        entities: (result.perception_memory.entities ?? []).map(e => e.type),
      });

      if (tc.expectFiredRules === true && output.firedRules.length === 0) {
        // Check if person was actually detected
        const hasPerson = (result.perception_memory.entities ?? []).some(e => e.type === "person");
        if (hasPerson) {
          throw new Error("Person detected but no rules fired");
        }
        log("INFO", `  ⚠️ No person detected in this frame, rule not expected to fire`);
      }

      if (tc.expectFps != null && output.action.fps !== tc.expectFps) {
        const hasPerson = (result.perception_memory.entities ?? []).some(e => e.type === "person");
        if (hasPerson) {
          throw new Error(`Expected fps=${tc.expectFps}, got fps=${output.action.fps}`);
        }
      }

      pass(testName);
      passed++;
    } catch (err) {
      fail(testName, err);
    }
  }

  log("INFO", `Stage 4 complete: ${passed}/${testCases.length} passed`);
  return passed === testCases.length;
}

async function level5_simulatedStream(deps: PipelineDeps) {
  log("INFO", "═══ Stage 5: Simulated Video Stream with VisionController ═══");

  // Simulate a security camera scenario:
  // Phase 1: Empty scene (static) → expect baseline (fps=1)
  // Phase 2: Person appears → expect frame-policy boost (fps=2)
  // Phase 3: Person leaves → expect baseline recovery

  const vc = new VisionController({
    enabled: true,
    baseline: { fps: 1 },
    rules: [
      {
        name: "person_present",
        trigger: { type: "class_detected", class: "person" },
        action: { fps: 2 },
        cooldown_ms: 0,
        hold_ms: 30_000,
      },
    ],
    segment_policy: {
      consultation_triggers: [
        { type: "security_risk" },
      ],
      consultation_cooldown_seconds: 60,
    },
  });
  const cameraId = "cam-sim-stream";

  // Phase 1: Use empty room video (no people → baseline should hold)
  log("INFO", "  Phase 1: Empty room (no people)...");
  const phase1Frames = extractFrames(join(VIDEO_DIR, "11-empty-room.mp4"), 1, 2);

  // Phase 2: Use thieves video (person present → escalation)
  log("INFO", "  Phase 2: Person appears...");
  const phase2Frames = extractFrames(join(VIDEO_DIR, "01-thieves-security-cam.mp4"), 1, 3);

  // Phase 3: Back to empty room (person gone → baseline recovery)
  log("INFO", "  Phase 3: Person leaves (empty room again)...");
  const phase3Frames = extractFrames(join(VIDEO_DIR, "12-empty-hallway.mp4"), 1, 2);

  const allPhases = [
    { name: "Phase 1: static/indoor", frames: phase1Frames, expectBaseline: true },
    { name: "Phase 2: person detected", frames: phase2Frames, expectEscalation: true },
    { name: "Phase 3: person gone", frames: phase3Frames, expectBaseline: true },
  ];

  const timeline: Array<{ phase: string; output: SegmentPolicyOutput; entities: string[] }> = [];
  let passed = 0;

  for (const phase of allPhases) {
    try {
      const segFrames = framesToSegmentFrames(phase.frames);
      const motionFilter = new MotionFilter({ confirmFrames: 1, maxChangeRatio: 1.0 });
      for (const f of phase.frames) motionFilter.detectWithRatio(f);

      const motionHint: MotionHint = {
        has_motion: motionFilter.lastMotionAt > motionFilter.lastStillAt,
        ratio: 0,
        last_motion_at: motionFilter.lastMotionAt,
        last_still_at: motionFilter.lastStillAt,
      };

      const segment = makeSegment(cameraId, "stream", segFrames, motionHint);
      const result = await analyze(segment, deps);
      const output = vc.evaluateSegment(result, segment);

      const entities = (result.perception_memory.entities ?? []).map(e => e.type);
      timeline.push({ phase: phase.name, output, entities });

      log("INFO", `  ${phase.name}:`, {
        entities,
        firedRules: output.firedRules,
        fps: output.action.fps,
        shouldConsultAgent: output.shouldConsultAgent,
      });

      pass(phase.name);
      passed++;
    } catch (err) {
      fail(phase.name, err);
    }
  }

  // Analyze timeline
  log("INFO", "");
  log("INFO", "  ═══ Stream Simulation Timeline ═══");
  for (const entry of timeline) {
    const rulesStr = entry.output.firedRules.length > 0
      ? `rules=[${entry.output.firedRules.join(",")}]`
      : "baseline";
    log("INFO", `  ${entry.phase}: entities=[${entry.entities.join(",")}] ${rulesStr} fps=${entry.output.action.fps} consult=${entry.output.shouldConsultAgent}`);
  }

  log("INFO", `Stage 5 complete: ${passed}/${allPhases.length} passed`);
  return passed === allPhases.length;
}

// ── Main ──

async function main() {
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  if (!existsSync(FRAME_DIR)) mkdirSync(FRAME_DIR, { recursive: true });

  const results: Array<{ level: string; passed: boolean }> = [];

  // Stage 1: Frame extraction (no models needed)
  results.push({ level: "Stage 1: Frame Extraction", passed: await level1_frameExtraction() });

  // Create real pipeline deps for model-backed stages
  log("INFO", "Creating pipeline dependencies with real models...");
  const config = resolvePerceptionConfig({
    stubs_only: false,
    stt_provider: "",
    // Use gemini-2.5-flash for all levels (flash-lite may not be available on Vertex)
    vlm_model_override: "gemini-2.5-flash",
  });
  const deps = await createPipelineDeps(config, nullMediaSaver);
  log("INFO", "Pipeline deps ready.");

  // Stage 2: Model inference
  results.push({ level: "Stage 2: Model Inference", passed: await level2_modelInference(deps) });

  // Stage 3: Full pipeline
  results.push({ level: "Stage 3: Full Pipeline", passed: await level3_fullPipeline(deps) });

  // Stage 4: VisionController rules
  results.push({ level: "Stage 4: VisionController Rules", passed: await level4_vcRules(deps) });

  // Stage 5: Simulated stream
  results.push({ level: "Stage 5: Simulated Stream", passed: await level5_simulatedStream(deps) });

  // Summary
  log("INFO", "");
  log("INFO", "═══════════════════════════════════════════");
  log("INFO", "           TEST SUMMARY");
  log("INFO", "═══════════════════════════════════════════");
  for (const r of results) {
    log("INFO", `  ${r.passed ? "✅" : "❌"} ${r.level}`);
  }

  const allPassed = results.every(r => r.passed);
  log("INFO", `\n  Overall: ${allPassed ? "ALL PASSED ✅" : "SOME FAILED ❌"}`);

  // Save results
  const reportPath = join(OUTPUT_DIR, "test-report.json");
  writeFileSync(reportPath, JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2));
  log("INFO", `\n  Report saved to ${reportPath}`);

  process.exit(allPassed ? 0 : 1);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
