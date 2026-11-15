// eval/benchmark/pipeline/runner.ts
// Offline video benchmark runner for Cortex perception + memory + Agent QA evaluation.

import dotenv from "dotenv";
import { resolve, dirname, join, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
const __root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
dotenv.config({ path: resolve(__root, ".env") });

import { monitorBus, resolveCortexHome, resolveCortexStateDir } from "@cortex/shared";
import { createPipelineDeps, resolvePerceptionConfig, VlmAnalyzer } from "@cortex/percept";
import { CortexClient } from "@cortex/mem";
import { PipelineStore } from "../../../packages/cortex/src/store.js";
import { QdrantService } from "../../../packages/cortex/src/services/qdrant-service.js";
import { CortexService } from "../../../packages/cortex/src/services/cortex-service.js";
import { runVideoPipeline } from "./video-pipeline.js";
import { runAgentQA } from "./agent-qa.js";
import { countEpisodicMemories, countSemanticMemories, dumpMemories } from "./memory-dump.js";
import { rehydrateMemoriesFromDump } from "./memory-rehydrate.js";
import { wireBenchmarkReidMemory } from "./pipeline-memory.js";
import { recordBenchmarkSemanticContextObservation, wireBenchmarkSemanticContext } from "./semantic-context.js";
import { buildVisionControllerConsultationPrompt, parseVisionControllerConsultationResponse } from "./consultation.js";
import type { BenchmarkDataset, RunMeta, VideoQAOutput } from "./types.js";
import { createBenchmarkVisionControllerConfig } from "../../../packages/cortex/src/vision-controller/default-config.js";
import { SingleFileFrameSource } from "./video-frame-source.js";
import { loadSrtFile, type SrtEntry } from "./srt-provider.js";

// ── CLI args ──
const args = process.argv.slice(2);
function getArg(name: string, defaultVal?: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return defaultVal;
}
const hasFlag = (name: string) => args.includes(`--${name}`);

function loadSegmentTranscripts(videoDir: string): string {
  const segmentsDir = join(videoDir, "segments");
  if (!existsSync(segmentsDir)) return "";
  const blocks: string[] = [];
  for (const file of readdirSync(segmentsDir).filter(f => f.endsWith(".json")).sort()) {
    try {
      const raw = JSON.parse(readFileSync(join(segmentsDir, file), "utf-8")) as {
        segment_id?: string;
        transcript?: string;
        perception_memory?: {
          summary?: string;
          detailed_summary?: string;
          timestamp?: number;
          custom_fields?: Record<string, unknown>;
        };
      };
      const transcript = raw.transcript?.trim();
      const summary = raw.perception_memory?.summary?.trim();
      const detailedSummary = raw.perception_memory?.detailed_summary?.trim();
      const onScreenText = [
        raw.perception_memory?.custom_fields?.on_screen_text,
        raw.perception_memory?.custom_fields?.viewer_comments,
      ].filter(Boolean).map(String).join("\n");
      if (!transcript && !summary && !detailedSummary && !onScreenText) continue;
      const title = `Transcript ${file.replace(/\.json$/, "")} ${raw.segment_id ?? ""}`.trim();
      const timestamp = typeof raw.perception_memory?.timestamp === "number"
        ? `Timestamp: ${Math.round(raw.perception_memory.timestamp / 1000)}s\n`
        : "";
      blocks.push([
        `## Archive Chapter: ${title}`,
        "",
        timestamp.trim(),
        summary ? `Summary: ${summary}` : "",
        detailedSummary ? `Detailed summary: ${detailedSummary}` : "",
        onScreenText ? `On-screen text: ${onScreenText}` : "",
        transcript ? `Transcript: ${transcript}` : "",
      ].filter(Boolean).join("\n"));
    } catch {
      // Ignore malformed segment files; benchmark evidence can still come from memory.
    }
  }
  return blocks.join("\n\n---\n\n");
}

const datasetPath = getArg("dataset");
if (!datasetPath) {
  console.error("Usage: npx tsx eval/benchmark/pipeline/runner.ts --dataset <path> [--fps N] [--frames-per-segment N] [--output DIR] [--videos id1,id2] [--reuse-run DIR] [--cleanup] [--max-duration-sec N] [--no-narrative] [--subtitle-dir DIR] [--require-subtitles]");
  process.exit(1);
}

const fps = parseInt(getArg("fps", "1")!, 10);
const framesPerSegment = parseInt(getArg("frames-per-segment", "15")!, 10);
const runId = `run_${Date.now().toString(36)}`;
const outputDir = resolve(getArg("output") ?? join(resolveCortexStateDir(), "benchmark", runId));
const videoFilter = getArg("videos")?.split(",");
const reuseRunDir = getArg("reuse-run");
const doCleanup = hasFlag("cleanup");
const disableNarrative = hasFlag("no-narrative") || process.env.BENCH_DISABLE_NARRATIVE === "1";
// Cap video duration for fast iteration during dev. Unbounded by default.
const maxDurationSec = getArg("max-duration-sec") ? parseInt(getArg("max-duration-sec")!, 10) : undefined;
const subtitleDir = getArg("subtitle-dir") ?? process.env.BENCH_SUBTITLE_DIR;
const requireSubtitles = hasFlag("require-subtitles");

/**
 * Look up SRT file for a video. Tries multiple name patterns:
 * 1. video.id (e.g. "_8lBR0E_Tx8.srt")
 * 2. basename of video.path without extension
 * 3. video.metadata.subtitle_path, resolved relative to subtitleDir
 */
function findSrtFile(
  video: { id: string; path: string; metadata?: Record<string, unknown> },
  dir: string,
): string | undefined {
  const candidates = [
    join(dir, `${video.id}.srt`),
    join(dir, `${basename(video.path, extname(video.path))}.srt`),
  ];
  const metaSub = video.metadata?.subtitle_path;
  if (typeof metaSub === "string") {
    candidates.push(resolve(dir, metaSub));
  }
  return candidates.find((p) => existsSync(p));
}

async function main() {
  // ── Load dataset ──
  const datasetRaw = JSON.parse(readFileSync(resolve(datasetPath!), "utf-8")) as BenchmarkDataset;
  const datasetDir = dirname(resolve(datasetPath!));
  let videos = datasetRaw.videos;
  if (videoFilter) {
    videos = videos.filter(v => videoFilter.includes(v.id));
  }

  // ── Determine collection prefix ──
  let collectionPrefix: string;
  const cameraIdMap = new Map<string, string>();

  if (reuseRunDir) {
    const oldMetaPath = join(resolve(reuseRunDir), "run_meta.json");
    if (!existsSync(oldMetaPath)) {
      console.error(`Error: --reuse-run specified but ${oldMetaPath} not found`);
      process.exit(1);
    }
    const oldMeta = JSON.parse(readFileSync(oldMetaPath, "utf-8")) as RunMeta;
    collectionPrefix = oldMeta.collection_prefix;
    for (const v of oldMeta.videos) cameraIdMap.set(v.id, v.camera_id);
    console.error(`[benchmark] Reusing run: prefix=${collectionPrefix}, ${cameraIdMap.size} video mappings`);
  } else {
    collectionPrefix = `bench_${runId}`;
    for (const v of videos) cameraIdMap.set(v.id, `bench_${v.id}`);
  }

  console.error(`\n── Benchmark Runner ──`);
  console.error(`Dataset: ${datasetRaw.dataset} (${videos.length} videos)`);
  console.error(`Output: ${outputDir}`);
  console.error(`FPS: ${fps}, VC policy: benchmark_basic`);
  console.error(`Collection prefix: ${collectionPrefix}`);

  // ── Start Qdrant (reuse external or setup-prepared binary) ──
  const stateDir = resolveCortexHome();
  const qdrantPort = parseInt(process.env.QDRANT_PORT ?? process.env.BENCH_QDRANT_PORT ?? "6333", 10);
  const qdrantGrpcPort = parseInt(process.env.QDRANT_GRPC_PORT ?? process.env.BENCH_QDRANT_GRPC_PORT ?? String(qdrantPort + 1), 10);
  const qdrantService = new QdrantService({ stateDir, httpPort: qdrantPort, grpcPort: qdrantGrpcPort });
  console.error(`[benchmark] Starting Qdrant on ${qdrantPort}...`);
  await qdrantService.start();
  console.error(`[benchmark] Qdrant ready (mode=${qdrantService.mode}, endpoint=${qdrantService.endpoint})`);

  // ── Start Mem service (managed lifecycle) ──
  const memPort = parseInt(process.env.BENCH_CORTEX_PORT ?? "18219", 10);

  // CortexService.start() handles port conflicts: if the port is occupied
  // and a custom collectionName is set, it auto-finds a free port instead of
  // killing the existing process.

  // Create output dir before Mem service starts — Mem needs it for SQLite history db
  mkdirSync(join(outputDir, "mem-storage"), { recursive: true });

  const memService = new CortexService({
    stateDir,
    port: memPort,
    qdrantPort,
    storagePath: join(outputDir, "mem-storage"),
    collectionName: collectionPrefix,
  });

  const stopServices = async () => {
    console.error("[benchmark] Stopping services...");
    await memService.stop().catch((err: unknown) => {
      console.error(`[benchmark] Mem service stop error: ${err}`);
    });
    await qdrantService.stop().catch((err: unknown) => {
      console.error(`[benchmark] Qdrant stop error: ${err}`);
    });
  };
  process.on("SIGINT", async () => { await stopServices(); process.exit(130); });
  process.on("SIGTERM", async () => { await stopServices(); process.exit(143); });

  console.error("[benchmark] Starting Mem service...");
  await memService.start();
  console.error(`[benchmark] Mem service ready (mode=${memService.mode}, endpoint=${memService.endpoint})`);

  const memClient = new CortexClient({
    baseUrl: memService.endpoint,
    timeoutMs: parseInt(process.env.BENCH_MEM_TIMEOUT_MS ?? "120000", 10),
  });

  // Agent config. Benchmark QA can use a different OpenAI-compatible endpoint
  // from perception; VLM_* remains the backward-compatible fallback.
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

  // ── Perception config (immutable, shared) ──
  const perceptionConfig = resolvePerceptionConfig({ runtime_mode: "offline_quality" });

  // ── VC config ──
  const vcConfig = createBenchmarkVisionControllerConfig();

  // ── Run ──
  mkdirSync(outputDir, { recursive: true });

  const vlmModel = perceptionConfig.vlm_model;
  const runMeta: RunMeta = {
    run_id: runId,
    dataset: datasetRaw.dataset,
    collection_prefix: collectionPrefix,
    created_at: new Date().toISOString(),
    config: { fps, frames_per_segment: framesPerSegment, vlm_model: vlmModel, agent_model: agentModel },
    videos: [],
  };

  const allResults: VideoQAOutput[] = [];

  for (let vi = 0; vi < videos.length; vi++) {
    const video = videos[vi]!;
    const cameraId = cameraIdMap.get(video.id) ?? `bench_${video.id}`;
    const userId = video.id;
    const videoOutputDir = join(outputDir, video.id);
    mkdirSync(videoOutputDir, { recursive: true });

    console.error(`\n── [${vi + 1}/${videos.length}] ${video.id} ──`);

    const videoPath = resolve(datasetDir, video.path);
    if (!existsSync(videoPath)) {
      console.error(`  Video not found: ${videoPath}`);
      continue;
    }

    let segmentCount = 0;
    const promptVersion = process.env.BENCH_GIT_COMMIT?.trim()
      || process.env.EVAL_GIT_COMMIT?.trim()
      || basename(outputDir);
    const store = new PipelineStore(videoOutputDir);

    const { NarrativeMemory } = await import("@cortex/percept");

    if (!reuseRunDir) {
      // Phase 1: Perception pipeline
      console.error(`  Phase 1: Perception pipeline...`);

      // Fresh pipelineDeps per video — prevents cross-video state pollution.
      // Save keyframes to disk so Agent QA view_keyframe tool can read them.
      // Layout: {videoOutputDir}/keyframes/{segmentId}_{mediaType}_{suffix}.jpg
      const keyframesDir = join(videoOutputDir, "keyframes");
      mkdirSync(keyframesDir, { recursive: true });
      const pipelineDeps = await createPipelineDeps(perceptionConfig, {
        saveMedia: (_cameraId, segmentId, mediaType, data, suffix) => {
          const name = suffix != null
            ? `${segmentId}_${mediaType}_${suffix}.jpg`
            : `${segmentId}_${mediaType}.jpg`;
          const path = join(keyframesDir, name);
          writeFileSync(path, data);
          return path;
        },
      });
      wireBenchmarkReidMemory({
        pipelineDeps,
        memClient,
        userId,
        enabled: !perceptionConfig.stubs_only,
      });

      // Load external SRT subtitles — replaces STT pipeline for this video.
      let srtEntries: SrtEntry[] | undefined;
      if (subtitleDir) {
        const srtPath = findSrtFile(video, resolve(subtitleDir));
        if (srtPath) {
          srtEntries = loadSrtFile(srtPath);
          // Disable real STT — precomputedStt takes priority in pipeline,
          // but also null these to avoid runtime STT calls.
          pipelineDeps.sttAnalyzer = undefined;
          pipelineDeps.elevenLabsStt = undefined;
          console.error(`  SRT loaded: ${srtEntries.length} entries from ${srtPath}`);
        } else if (requireSubtitles) {
          console.error(`  ERROR: --require-subtitles set but no SRT found for ${video.id}`);
          continue;
        } else {
          console.error(`  SRT not found for ${video.id}, falling back to STT`);
        }
      }

      pipelineDeps.logging = {
        archiveSegments: true,
        promptVersion,
        llmContext: {
          run_id: runId,
          snapshot_version: basename(outputDir),
          video_id: video.id,
          camera_id: cameraId,
        },
      };
      pipelineDeps.vlmAnalyzer.setLlmCallRecorder((call) => {
        try { store.saveLlmCall(call); } catch { /* best-effort */ }
      });
      const semanticContextManager = wireBenchmarkSemanticContext({
        pipelineDeps,
        memClient,
        store,
        userId,
        model: perceptionConfig.vlm_model_lite,
        promptVersion,
        llmContext: pipelineDeps.logging?.llmContext,
        logPrefix: "benchmark",
      });
      const semanticContextPromises: Promise<void>[] = [];

      // Wire trace subscriber for profiling data
      const traceHandler = (event: { type: string; data: unknown }) => {
        if (event.type === "system:pipeline_trace") {
          try { store.saveTrace(event.data as any); } catch { /* best-effort */ }
        }
      };
      monitorBus.on("monitor", traceHandler);

      pipelineDeps.postProcessor = {
        async sendNotifications() { /* no-op */ },
        onPipelineComplete(result, segment, meta) {
          try {
            store.logResult(segment, result, meta.vlm ? {
              notify_user: meta.vlm.notify_user,
              is_static_scene: meta.vlm.is_static_scene,
              vlm_model: meta.vlm.vlm_model,
              vlm_latency_ms: meta.vlm.vlm_latency_ms,
            } : undefined);
          } catch { /* ignore logging errors */ }
          const semanticContextPromise = recordBenchmarkSemanticContextObservation(semanticContextManager, result)
            .catch((err) => {
              console.error(`[benchmark][semantic-context] onSegmentProcessed failed: ${err instanceof Error ? err.message : err}`);
            });
          semanticContextPromises.push(semanticContextPromise);
        },
        onPipelineError(segId, camId, stage, msg) {
          store.logError(segId, camId, stage, msg);
        },
      };

      // Segment policy consultation dispatcher — fire-and-forget, non-blocking.
      // Only triggered when VC segment_policy matches (with cooldown).
      const consultationAnalyzer = new VlmAnalyzer(agentProvider === "gemini"
        ? {
            provider: "gemini",
            apiKey: agentApiKey,
            textModel: agentModel,
            llmCallRecorder: (call) => {
              try { store.saveLlmCall(call); } catch { /* best-effort */ }
            },
            llmContext: pipelineDeps.logging?.llmContext,
          }
        : {
            provider: "openai",
            apiKey: agentApiKey,
            baseUrl: agentApiBase,
            textModel: agentModel,
            llmCallRecorder: (call) => {
              try { store.saveLlmCall(call); } catch { /* best-effort */ }
            },
            llmContext: pipelineDeps.logging?.llmContext,
          });
      const consultationDispatcher = {
        async submitConsultation(context: Record<string, unknown>) {
          const prompt = buildVisionControllerConsultationPrompt(context);
          const segmentId = typeof context.segment_id === "string" ? context.segment_id : undefined;
          const text = await consultationAnalyzer.completeText(prompt, {
            responseFormat: "json",
            model: agentModel,
            stage: "vision_controller.consultation",
            reasoningEffort: "low",
            promptVersion,
            llmContext: { ...pipelineDeps.logging?.llmContext, segment_id: segmentId },
          });
          if (!text) return null;
          return parseVisionControllerConsultationResponse(text, "benchmark");
        },
      };

      const narrativeMemory = disableNarrative
        ? undefined
        : new NarrativeMemory({
            baseDir: join(videoOutputDir, "narratives"),
            memClient,
            userId,
            schemaEventBudget: 5,
            schemaMaxIntervalMs: 3_600_000,
            updateBufferSize: Math.max(
              1,
              Number.parseInt(process.env.BENCH_NARRATIVE_UPDATE_BUFFER_SIZE ?? "12", 10) || 12,
            ),
            llm: (prompt, options) => pipelineDeps.vlmAnalyzer.compressText(prompt, {
              ...options,
              promptVersion,
              llmContext: { ...pipelineDeps.logging?.llmContext, ...options?.llmContext },
            }),
          });


      const pipelineResult = await runVideoPipeline({
        videoPath,
        cameraId,
        userId,
        fps,
        framesPerSegment,
        outputDir: videoOutputDir,
        pipelineDeps,
        memClient,
        vcConfig,
        consultationDispatcher,
        maxDurationSec,
        narrativeMemory,
        srtEntries,
        ignoreNarrativeFlushErrors: process.env.BENCH_REQUIRE_NARRATIVE_FLUSH === "true" ? false : true,
        selfCheckComponents: [
          {
            name: "qdrant",
            status: qdrantService.mode === "stopped" ? "error" : "ok",
            required: true,
            detail: `mode=${qdrantService.mode} endpoint=${qdrantService.endpoint}`,
          },
          {
            name: "memory_service",
            status: memService.mode === "stopped" ? "error" : "ok",
            required: true,
            detail: `mode=${memService.mode} endpoint=${memService.endpoint}`,
          },
        ],
      });
      segmentCount = pipelineResult.segmentCount;
      console.error(`  ${segmentCount} segments processed, waiting for memory writes...`);
      await pipelineResult.memoryBarrier;
      await Promise.all(semanticContextPromises);
      console.error(`  Memory writes complete`);

      // Cleanup: unsubscribe trace listener
      monitorBus.off("monitor", traceHandler);
    } else {
      console.error(`  Phase 1: Skipped (--reuse-run)`);
      const reuseVideoDir = join(resolve(reuseRunDir!), video.id);

      const restorePath = join(reuseVideoDir, "memory_dump.json");
      console.error(`  Rehydrating memories from reuse run if needed...`);
      const restore = await rehydrateMemoriesFromDump(
        memClient,
        cameraId,
        userId,
        restorePath,
        message => console.error(`  [rehydrate] ${message}`),
      );
      if (restore.skipped) {
        console.error(`  Rehydrate skipped: ${restore.reason}`);
      } else {
        console.error(
          `  Rehydrated memories: ${restore.restored.episodic} episodic, ` +
          `${restore.restored.semantic} semantic, ${restore.restored.procedural} procedural` +
          (restore.failed ? ` (${restore.failed} failed)` : ""),
        );
      }
    }

    // Memory dump
    console.error(`  Dumping memories...`);
    const memDump = await dumpMemories(memClient, cameraId, userId);
    writeFileSync(join(videoOutputDir, "memory_dump.json"), JSON.stringify(memDump, null, 2));
    console.error(`  ${countEpisodicMemories(memDump)} episodic, ${countSemanticMemories(memDump)} semantic`);

    // Phase 2: QA
    console.error(`  Phase 2: Agent QA (${video.questions.length} questions)...`);
    const qaResults = await runAgentQA(video.questions, {
      agentProvider,
      agentApiBase,
      agentApiKey,
      agentModel,
      cameraId,
      userId,
      memClient,
      videoFrameSource: new SingleFileFrameSource(videoPath),
      promptVersion,
      llmContext: {
        run_id: runId,
        snapshot_version: basename(outputDir),
        video_id: video.id,
        camera_id: cameraId,
      },
      llmCallRecorder: (call) => {
        try { store.saveLlmCall(call); } catch { /* best-effort */ }
      },
    });

    const qaOutput: VideoQAOutput = { video_id: video.id, camera_id: cameraId, user_id: userId, questions: qaResults };
    writeFileSync(join(videoOutputDir, "qa.json"), JSON.stringify(qaOutput, null, 2));
    allResults.push(qaOutput);

    const okCount = qaResults.filter(r => r.status === "ok").length;
    console.error(`  QA: ${okCount}/${qaResults.length} answered`);

    runMeta.videos.push({ id: video.id, camera_id: cameraId, user_id: userId, path: video.path, segment_count: segmentCount });
  }

  // Save results + meta
  writeFileSync(join(outputDir, "results.json"), JSON.stringify(allResults, null, 2));
  writeFileSync(join(outputDir, "run_meta.json"), JSON.stringify(runMeta, null, 2));

  console.error(`\n── Done ──`);
  console.error(`Results: ${join(outputDir, "results.json")}`);
  console.error(`Run meta: ${join(outputDir, "run_meta.json")}`);

  // Cleanup: delete benchmark Qdrant collections (BEFORE stopping Mem service)
  if (doCleanup) {
    const memUrl = memService.endpoint;
    console.error(`Cleanup: deleting benchmark collections (prefix=${collectionPrefix})...`);
    try {
      const resetResp = await fetch(`${memUrl}/reset`, { method: "POST" });
      if (resetResp.ok) {
        console.error(`  Benchmark collections cleaned up`);
      } else {
        console.error(`  Cleanup failed: ${resetResp.status}`);
      }
    } catch (err) {
      console.error(`  Cleanup failed: ${err}`);
    }
  }

  // Stop managed services (after cleanup)
  await stopServices();

  process.exit(0);
}

main().catch((err) => {
  console.error(`[benchmark] Fatal error: ${err}`);
  process.exit(1);
});
