// eval/benchmark/pipeline/video-pipeline.ts
// Streaming video pipeline — processes frames one at a time from ffmpeg,
// with async perception overlap (analyze segment N while accumulating N+1).

import { execFileSync } from "node:child_process";
import { basename, extname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { monitorBus, type Segment, type PerceptionResult, type FrameDetection } from "@cortex/shared";
import { CamPipeline, CompositeSegmenter, MotionFilter, SileroVad, VAD_CHUNK_SIZE, getSileroVadModelPath, resolveFfmpegBin, resolveFfprobeBin } from "@cortex/cam";
import type { SegmenterHints } from "@cortex/cam";
import { analyze, logPipelineSelfCheck, parseSemanticContextSections } from "@cortex/percept";
import type { EventCloseSummary, PipelineDeps, PipelineSelfCheckComponent } from "@cortex/percept";
import { NarrativeMemory } from "@cortex/percept";
import { CortexClient } from "@cortex/mem";
import { FRAME_POLICY_MAX_FPS } from "../../../packages/cortex/src/vision-controller/constants.js";
import { VisionController } from "../../../packages/cortex/src/vision-controller/vision-controller.js";
import type { VisionControllerConfig } from "../../../packages/cortex/src/vision-controller/types.js";
import { PerceptionRuntime } from "../../../packages/cortex/src/runtime/perception-runtime.js";
import { buildSourceTimeMetadata, createMemoryStorePerception } from "../../../packages/cortex/src/memory-adapter.js";
import type { SrtEntry } from "./srt-provider.js";
import { sliceSrtToSttOutput } from "./srt-provider.js";
import { streamFrames } from "./frame-stream.js";
import { extractAudio } from "./frame-extractor.js";

const BENCHMARK_TRACKABLE_LABELS = new Set([
  "person", "car", "motorcycle", "bus", "train",
  "truck", "bicycle", "boat", "dog", "cat", "bird",
  "horse", "cow",
]);

interface ToolModule {
  executeToolAction: (params: Record<string, unknown>, deps: PipelineDeps) => Promise<string>;
}

function commandAvailable(bin: string): boolean {
  const value = bin.trim();
  if (!value) return false;
  if (value.includes("/") || value.startsWith(".")) return existsSync(value);
  try {
    execFileSync("which", [value], { timeout: 3000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function benchmarkFfmpegComponent(ffmpegBin: string): PipelineSelfCheckComponent {
  return {
    name: "ffmpeg",
    status: commandAvailable(ffmpegBin) ? "ok" : "error",
    required: true,
    detail: `bin=${ffmpegBin}`,
  };
}

function benchmarkFfprobeComponent(ffprobeBin: string): PipelineSelfCheckComponent {
  return {
    name: "ffprobe",
    status: commandAvailable(ffprobeBin) ? "ok" : "error",
    required: true,
    detail: `bin=${ffprobeBin}`,
  };
}

function hasBenchmarkTrackableEntity(detections: FrameDetection[] | undefined): boolean {
  return (detections ?? []).some((det) => BENCHMARK_TRACKABLE_LABELS.has(det.label.toLowerCase()));
}

function writeSegmentResult(path: string, result: PerceptionResult): void {
  writeFileSync(path, JSON.stringify(result, null, 2));
}

function wordCount(text: string | undefined): number {
  return text?.trim() ? text.trim().split(/\s+/).length : 0;
}

function patchSegmentArchive(path: string, archive: PerceptionResult["_archive"]): void {
  if (!archive || !existsSync(path)) return;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as PerceptionResult;
    raw._archive = archive;
    writeSegmentResult(path, raw);
  } catch {
    // Best-effort archive patching; the initial segment JSON remains usable.
  }
}

function compactText(text: string | undefined, maxChars: number): string | undefined {
  const value = text?.replace(/\s+/g, " ").trim();
  if (!value) return undefined;
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

function normalizeConsultationValue(value: unknown): unknown {
  if (value instanceof Set) return [...value];
  if (value instanceof Map) return Object.fromEntries(value.entries());
  if (Array.isArray(value)) return value.map(normalizeConsultationValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = normalizeConsultationValue(child);
    }
    return out;
  }
  return value;
}

async function loadSemanticContextForConsultation(
  pipelineDeps: PipelineDeps,
  cameraId: string,
): Promise<string | undefined> {
  if (!pipelineDeps.semanticContext) return undefined;
  try {
    const content = await pipelineDeps.semanticContext.load(cameraId);
    if (!content) return undefined;
    return compactText(parseSemanticContextSections(content).profileContent, 1800);
  } catch {
    return undefined;
  }
}

export interface VideoPipelineOptions {
  videoPath: string;
  cameraId: string;
  userId?: string;
  fps: number;
  framesPerSegment: number;
  outputDir: string;
  pipelineDeps: PipelineDeps;
  memClient: CortexClient;
  vcConfig?: VisionControllerConfig;
  consultationDispatcher?: {
    submitConsultation: (context: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  };
  /** Cap video duration (seconds). Useful for fast iteration during dev. */
  maxDurationSec?: number;
  /** Added to extracted frame offsets to create the segment media timeline. */
  mediaTimeOffsetMs?: number;
  /** Describes how segment media timestamps should be interpreted in memory metadata. */
  timeBasis?: string;
  /** Added to segment output numbering. Used when several clips share one logical session directory. */
  segmentIndexOffset?: number;
  narrativeMemory?: NarrativeMemory;
  checkpoints?: VideoPipelineCheckpoint[];
  onMemoryCheckpoint?: (context: VideoPipelineCheckpointContext) => Promise<void>;
  /** Capture unsatisfied checkpoints at EOF up to this media time. Defaults to all remaining checkpoints. */
  captureRemainingCheckpointsUntilMs?: number;
  /** Close and finalize narrative memory at EOF. Multi-clip sessions only do this on the last clip. */
  finalizeNarrative?: boolean;
  /** Long benchmark videos can build a large narrative backlog; do not fail perception/QA if narrative summarization cannot drain. */
  ignoreNarrativeFlushErrors?: boolean;
  /** Extra process/service checks supplied by the caller (Qdrant, mem service, etc.). */
  selfCheckComponents?: PipelineSelfCheckComponent[];
  /** Pre-parsed SRT subtitle entries. When provided, wired as precomputedStt on PipelineDeps. */
  srtEntries?: SrtEntry[];
}

export interface VideoPipelineCheckpoint {
  id: string;
  mediaTimeMs: number;
  metadata?: Record<string, unknown>;
}

export interface VideoPipelineCheckpointContext {
  checkpoint: VideoPipelineCheckpoint;
  cameraId: string;
  userId: string;
  outputDir: string;
  segment: Segment;
  segmentIndex: number;
  segmentResult: PerceptionResult;
}

export interface VideoPipelineResult {
  segmentCount: number;
  segmentResults: PerceptionResult[];
  capturedCheckpointIds: string[];
  /** Resolves when all memory writes are complete. Call before QA phase. */
  memoryBarrier: Promise<void>;
}

const narrativeConfiguredDeps = new WeakSet<object>();

export async function runVideoPipeline(opts: VideoPipelineOptions): Promise<VideoPipelineResult> {
  const { videoPath, cameraId, fps, outputDir, pipelineDeps, memClient, vcConfig, maxDurationSec } = opts;
  const userId = opts.userId ?? basename(videoPath, extname(videoPath));
  const mediaTimeOffsetMs = opts.mediaTimeOffsetMs ?? 0;

  // Wire external SRT subtitles as precomputed STT provider.
  // Each segment receives time-sliced subtitle text as SttOutput,
  // entering the pipeline before VLM (via formatSttForVlm) and memory.
  // Always returns SttOutput — empty transcript = confirmed no speech, not failure.
  //
  // IMPORTANT: Check `!== undefined`, NOT `.length`. Once a video opts into the
  // SRT path (runner found and parsed the file), precomputedStt MUST be wired
  // even if entries is empty (e.g. SRT was all [Music]/noise). Otherwise real
  // STT is disabled but precomputed isn't connected — pipeline sees no STT provider.
  if (opts.srtEntries !== undefined) {
    const srtEntries = opts.srtEntries;
    pipelineDeps.precomputedStt = (segment) => {
      const segStartMs = segment.timestamp;
      const segEndMs = segStartMs + Math.round((segment.duration_sec ?? 0) * 1000);
      return sliceSrtToSttOutput(srtEntries, segStartMs, segEndMs);
    };
  }

  // Output dirs
  const segmentsDir = join(outputDir, "segments");
  const audioPath = join(outputDir, "audio.pcm");
  mkdirSync(segmentsDir, { recursive: true });

  // 1. Derive maxFps from benchmark frame-policy rules.
  const ruleMaxFps = Math.max(
    vcConfig?.baseline?.fps ?? fps,
    ...(vcConfig?.rules ?? []).map((r: any) => {
      const ruleFps = r.action?.fps;
      return typeof ruleFps === "number" ? Math.min(ruleFps, FRAME_POLICY_MAX_FPS) : 0;
    }),
  );
  const maxFps = Math.max(fps, ruleMaxFps);

  // 2. Resolve a prepared ffmpeg binary, then pre-extract audio.
  const ffmpegBin = resolveFfmpegBin();
  const ffprobeBin = resolveFfprobeBin(undefined, ffmpegBin);
  console.error(`[benchmark] Extracting audio from ${videoPath} with ${ffmpegBin}...`);
  const extractedAudio = await extractAudio(videoPath, audioPath, maxDurationSec, ffmpegBin, ffprobeBin);
  const audioBuffer = extractedAudio && extractedAudio.buffer.length > 0 ? extractedAudio.buffer : null;
  const audioStartPtsMs = extractedAudio?.startPtsMs ?? 0;
  if (!audioBuffer) {
    console.error(`[benchmark] No usable audio extracted for ${videoPath}; VAD/STT disabled (output=${audioPath})`);
  }
  const audioSamples = audioBuffer
    ? new Float32Array(audioBuffer.length / 2).map((_, i) => audioBuffer.readInt16LE(i * 2) / 32768)
    : null;
  let audioSampleIndex = 0;

  // 3. Init components
  const motionFilter = new MotionFilter();
  const vc = vcConfig ? new VisionController(vcConfig) : null;
  const detector = pipelineDeps.router?.getDetector("general-detection") ?? null;

  // VAD
  let vad: SileroVad | null = null;
  let vadComponent: PipelineSelfCheckComponent = audioBuffer
    ? { name: "vad", status: "warn", detail: "audio present but VAD init not completed" }
    : { name: "vad", status: "disabled", detail: "no audio track or audio extraction returned empty" };
  if (audioBuffer) {
    try {
      const vadModelPath = getSileroVadModelPath();
      vad = new SileroVad({ modelPath: vadModelPath, minSilenceDuration: 0.05 });
      const ok = await vad.init();
      if (!ok) {
        console.error(`[MODEL WARNING] Benchmark Silero VAD unavailable for ${vadModelPath}; VAD disabled.`);
        vadComponent = { name: "vad", status: "warn", detail: `model=${vadModelPath} available=false` };
        vad = null;
      } else {
        vadComponent = { name: "vad", status: "ok", detail: `model=${vadModelPath}` };
        console.error("[benchmark] VAD initialized");
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[MODEL WARNING] Benchmark Silero VAD setup failed; VAD disabled: ${reason}`);
      vadComponent = { name: "vad", status: "warn", detail: `setup_failed=${reason}` };
      vad = null;
    }
  }

  // Ensure notifications are no-op; benchmark writes Memory externally below.
  const existingPP = pipelineDeps.postProcessor ?? {};
  pipelineDeps.postProcessor = {
    ...existingPP,
    async sendNotifications() { /* no-op */ },
  };

  // Wire NarrativeMemory into perception pipeline
  if (opts.narrativeMemory && !narrativeConfiguredDeps.has(opts.pipelineDeps as object)) {
    narrativeConfiguredDeps.add(opts.pipelineDeps as object);
    opts.pipelineDeps.narrativeMemory = opts.narrativeMemory;
    opts.pipelineDeps.workingMemory.setNarrativeCallbacks({
      onContextCompressed: (cameraId, compressed, entitySnapshot) => {
        opts.narrativeMemory!.onContextCompressed(cameraId, compressed, entitySnapshot);
      },
      onEventClosed: (cameraId, summary) => {
        opts.narrativeMemory!.onEventClosed(cameraId, summary);
        recordEventClose(summary);
      },
    });

  }

  logPipelineSelfCheck(pipelineDeps, {
    mode: "benchmark-video",
    label: cameraId,
    throwOnFatal: true,
    components: [
      ...(opts.selfCheckComponents ?? []),
      {
        name: "video_input",
        status: existsSync(videoPath) ? "ok" : "error",
        required: true,
        detail: `path=${videoPath}`,
      },
      benchmarkFfmpegComponent(ffmpegBin),
      benchmarkFfprobeComponent(ffprobeBin),
      { name: "memory_client", status: "ok", required: true, detail: "configured" },
      {
        name: "vision_controller",
        status: vc ? "ok" : "disabled",
        detail: vc ? `rules=${vc.getConfig().rules?.length ?? 0}` : "not configured",
      },
      { name: "motion_filter", status: "ok", detail: "configured" },
      {
        name: "frame_stream",
        status: "ok",
        detail: `fps=${fps} max_fps=${maxFps} frames_per_segment=${opts.framesPerSegment} max_duration_sec=${maxDurationSec ?? "unbounded"}`,
      },
      vadComponent,
    ],
  });

  // 4. Double-buffer perception: while perception(N) runs, frames for segment N+1
  // accumulate. When N+1 is cut, frame loop pauses (handleSegment blocks the queue)
  // until perception(N) finishes, then starts perception(N+1) fire-and-forget.
  const segmentResults: PerceptionResult[] = [];
  const memPromises: Promise<void>[] = [];
  const capturedCheckpointIds: string[] = [];
  const checkpoints = [...(opts.checkpoints ?? [])]
    .filter(cp => Number.isFinite(cp.mediaTimeMs))
    .sort((a, b) => a.mediaTimeMs - b.mediaTimeMs);
  let checkpointCursor = 0;
  const segmentIndexOffset = opts.segmentIndexOffset ?? 0;
  let currentFps = fps;
  let segCounter = 0;
  const lastCompletedSegmentRef: { value: { segment: Segment; segIdx: number; result: PerceptionResult } | null } = { value: null };
  const segmentFileById = new Map<string, string>();
  const segmentResultById = new Map<string, PerceptionResult>();
  const consultationPromises: Promise<void>[] = [];

  const updateSegmentArchive = (
    segmentId: string,
    updater: (archive: NonNullable<PerceptionResult["_archive"]>) => void,
  ) => {
    const result = segmentResultById.get(segmentId);
    if (result?._archive) {
      updater(result._archive);
      const path = segmentFileById.get(segmentId);
      if (path) patchSegmentArchive(path, result._archive);
      return;
    }

    const path = segmentFileById.get(segmentId);
    if (!path || !existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as PerceptionResult;
      if (!raw._archive) return;
      updater(raw._archive);
      writeSegmentResult(path, raw);
    } catch {
      // Best-effort archive patching.
    }
  };

  const recordEventClose = (summary: EventCloseSummary) => {
    const eventClose = {
      closed: true,
      event_id: summary.event_id,
      segment_count: summary.segment_count,
      summary_words: wordCount(summary.event_summary ?? summary.compressed_context),
      time_range: summary.time_range,
      segment_ids: summary.segment_ids,
    };
    for (const segmentId of summary.segment_ids) {
      updateSegmentArchive(segmentId, (archive) => {
        archive.event_narrative = {
          ...(archive.event_narrative ?? {}),
          event_close: eventClose,
        };
      });
    }
  };

  const recordNarrativeFlush = (
    result: PerceptionResult | undefined,
    flush: { attempted: boolean; status: "ok" | "error"; finalize?: boolean; checkpoint_id?: string; error?: string },
  ) => {
    if (!result?._archive) return;
    result._archive.event_narrative = {
      ...(result._archive.event_narrative ?? {}),
      narrative_flush: flush,
    };
    const path = segmentFileById.get(result.segment_id);
    if (path) patchSegmentArchive(path, result._archive);
  };

  const previousMemoryAdapter = pipelineDeps.memory;
  const baseStorePerception = previousMemoryAdapter?.storePerception
    ?? createMemoryStorePerception({
      memClient,
      userId,
      sourceTimeMetadataForSegment: ({ mediaStartMs, mediaDurationMs }) =>
        buildSourceTimeMetadata(mediaStartMs, mediaDurationMs, opts.timeBasis),
    });
  pipelineDeps.memory = {
    ...previousMemoryAdapter,
    storePerception(result, segment) {
      const startedAt = Date.now();
      if (result._archive?.memory_write) {
        result._archive.memory_write = {
          ...result._archive.memory_write,
          attempted: true,
          status: "pending",
        };
      }
      const write = baseStorePerception(result, segment)
        .catch(async () => {
          // Perception fires memory writes without awaiting them. Benchmark's
          // memoryBarrier must wait for the retry's final state, not only the
          // first rejected write promise.
          await new Promise((resolve) => setTimeout(resolve, 2000));
          try {
            await baseStorePerception(result, segment);
            if (result._archive?.memory_write) {
              result._archive.memory_write = {
                ...result._archive.memory_write,
                retry_count: 1,
              };
            }
          } catch (retryErr) {
            throw retryErr;
          }
          return undefined;
        });
      const tracked = write
        .then(() => {
          if (result._archive?.memory_write) {
            result._archive.memory_write = {
              ...result._archive.memory_write,
              status: "ok",
              latency_ms: Date.now() - startedAt,
            };
            const segmentPath = segmentFileById.get(segment.segment_id);
            if (segmentPath) patchSegmentArchive(segmentPath, result._archive);
          }
        })
        .catch(err => {
          if (result._archive?.memory_write) {
            result._archive.memory_write = {
              ...result._archive.memory_write,
              status: "error",
              latency_ms: Date.now() - startedAt,
              error: err instanceof Error ? err.message : String(err),
            };
            const segmentPath = segmentFileById.get(segment.segment_id);
            if (segmentPath) patchSegmentArchive(segmentPath, result._archive);
          }
          console.error(`[benchmark] Mem write failed for ${segment.segment_id}: ${err}`);
          throw err;
        });
      memPromises.push(tracked.catch(() => undefined));
      return write;
    },
  };

  async function captureDueCheckpoints(segment: Segment, segIdx: number, result: PerceptionResult): Promise<void> {
    if (!opts.onMemoryCheckpoint || checkpointCursor >= checkpoints.length) return;
    const segmentEndMs = segment.timestamp + Math.max(0, Math.round((segment.duration_sec ?? 0) * 1000));
    while (checkpointCursor < checkpoints.length && checkpoints[checkpointCursor]!.mediaTimeMs <= segmentEndMs) {
      const checkpoint = checkpoints[checkpointCursor++]!;
      await Promise.all(memPromises);
      if (opts.narrativeMemory) {
        try {
          await opts.narrativeMemory.flush(cameraId);
          recordNarrativeFlush(result, {
            attempted: true,
            status: "ok",
            checkpoint_id: checkpoint.id,
          });
        } catch (err) {
          recordNarrativeFlush(result, {
            attempted: true,
            status: "error",
            checkpoint_id: checkpoint.id,
            error: err instanceof Error ? err.message : String(err),
          });
          if (!opts.ignoreNarrativeFlushErrors) throw err;
          console.error(`[benchmark] NarrativeMemory checkpoint flush failed but continuing: ${err}`);
        }
      }
      await opts.onMemoryCheckpoint({
        checkpoint,
        cameraId,
        userId,
        outputDir,
        segment,
        segmentIndex: segIdx,
        segmentResult: result,
      });
      capturedCheckpointIds.push(checkpoint.id);
    }
  }

  const processBenchmarkSegment = async (segment: Segment): Promise<void> => {
    const localSegIdx = segCounter++;
    const segIdx = segmentIndexOffset + localSegIdx;
    const segmentPath = join(segmentsDir, `seg_${String(segIdx).padStart(3, "0")}.json`);
    segmentFileById.set(segment.segment_id, segmentPath);

    const result = await analyze(segment, pipelineDeps);

      const hasVlmResult = (result._trace?.context.analyzers_run ?? []).includes("vlm");
      if (!hasVlmResult) {
        console.error(`[benchmark] Mem write skipped for ${segment.segment_id} (no VLM result)`);
      }


      // Segment policy + consultation (fire-and-forget, non-blocking)
      if (vc) {
        const segmentPolicy = vc.evaluateSegment(result, segment);
        if (result._archive) {
          result._archive.postprocess = {
            ...(result._archive.postprocess ?? {}),
            vision_controller_segment_policy: {
              evaluated: true,
              fired_rules: segmentPolicy.firedRules,
              rule_details: segmentPolicy.firedRuleDetails,
              action: segmentPolicy.action,
              segment_policy_cleared: segmentPolicy.segmentPolicyCleared,
              should_consult_agent: segmentPolicy.shouldConsultAgent,
              trigger_reason: segmentPolicy.consultationContext?.trigger_reason,
              dispatcher_available: Boolean(opts.consultationDispatcher),
            },
          };
        }
        const hasSegmentOverride =
          segmentPolicy.action.skip_vlm != null
          || segmentPolicy.action.max_level != null
          || segmentPolicy.action.vlm_model != null;
        if (hasSegmentOverride) {
          pipelineDeps.strategyManager.setSegmentPolicyOverride(cameraId, {
            skipVlm: segmentPolicy.action.skip_vlm,
            maxLevel: segmentPolicy.action.max_level as 0 | 1 | 2 | undefined,
            vlmModel: segmentPolicy.action.vlm_model,
          });
        } else {
          pipelineDeps.strategyManager.clearSegmentPolicyOverride(cameraId);
        }
        // Segment policy consultation — only fires when segment_policy matches (with cooldown).
        // Non-blocking: results applied when they arrive, doesn't delay perception.
        if (segmentPolicy.shouldConsultAgent && segmentPolicy.consultationContext && opts.consultationDispatcher) {
          const consultationRequestedAt = Date.now();
          const consultationId = `consult_${consultationRequestedAt.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
          if (result._archive) {
            result._archive.postprocess = {
              ...(result._archive.postprocess ?? {}),
              vision_controller_consultation: {
                consultation_id: consultationId,
                attempted: true,
                status: "pending",
                trigger_reason: segmentPolicy.consultationContext.trigger_reason,
                requested_at: consultationRequestedAt,
              },
            };
          }
          const semanticContext = await loadSemanticContextForConsultation(pipelineDeps, cameraId);
          const currentEventSummary = opts.pipelineDeps.workingMemory.getCurrentEventSummary(cameraId);
          const recentSegmentSummaries = opts.pipelineDeps.workingMemory.getRecentSegmentSummaries(cameraId);
          const consultationContext = {
            camera_id: cameraId,
            segment_id: segment.segment_id,
            trigger_reason: segmentPolicy.consultationContext.trigger_reason,
            eventText: `[Benchmark] ${result.perception_memory.summary}`,
            video_context: {
              semantic_context: semanticContext,
            },
            event_context: {
              current_event_summary: compactText(currentEventSummary, 1000),
              recent_segments: recentSegmentSummaries.slice(-6).map((summary) => compactText(summary, 360)).filter(Boolean),
            },
            current_segment: {
              summary: compactText(result.perception_memory.summary, 600),
              detailed_summary: compactText(result.perception_memory.detailed_summary, 1000),
              event_summary: compactText(
                (result.perception_memory as { event_summary?: string }).event_summary,
                1000,
              ),
              signals: normalizeConsultationValue(segmentPolicy.consultationContext.signals),
            },
            policy_state: {
              baseline: vc.getConfig().baseline,
              active_overrides: segmentPolicy.action,
            },
            constraints: {
              allowed_config_keys: ["scene_description", "focus_targets", "security_rules"],
              requires_exit_condition: true,
            },
            // Backward-compatible fields for custom dispatchers.
            signals: normalizeConsultationValue(segmentPolicy.consultationContext.signals),
            current_baseline: vc.getConfig().baseline,
            current_overrides: segmentPolicy.action,
            recommended_action_types: ["perception_config"],
            requires_exit_condition: true,
            exit_condition_hint: 'Specify when to revert the temporary perception adjustment (e.g., {"type":"event_boundary"} or {"type":"no_motion","duration_ms":30000})',
          };
          const consultationPromise = opts.consultationDispatcher.submitConsultation(consultationContext).then(toolCall => {
            const completedAt = Date.now();
            if (result._archive) {
              result._archive.postprocess = {
                ...(result._archive.postprocess ?? {}),
                vision_controller_consultation: {
                  consultation_id: consultationId,
                  attempted: true,
                  status: "ok",
                  trigger_reason: segmentPolicy.consultationContext!.trigger_reason,
                  suggested_tool: (toolCall as Record<string, unknown> | null)?.tool,
                  has_exit_condition: Boolean((toolCall as Record<string, unknown> | null)?.exit_condition),
                  requested_at: consultationRequestedAt,
                  completed_at: completedAt,
                  roundtrip_ms: completedAt - consultationRequestedAt,
                },
              };
              const segmentPath = segmentFileById.get(segment.segment_id);
              if (segmentPath) patchSegmentArchive(segmentPath, result._archive);
            }
            monitorBus.publish("vision_controller:agent_consulted", {
              consultation_id: consultationId,
              segment_id: segment.segment_id,
              camera_id: cameraId,
              trigger_reason: segmentPolicy.consultationContext!.trigger_reason,
              signals_snapshot: segmentPolicy.consultationContext!.signals,
              phase: toolCall ? "submitted_with_suggestion" : "submitted",
              suggested_tool: (toolCall as Record<string, unknown> | null)?.tool,
              recommended_action_types: ["perception_config"],
              requested_at: consultationRequestedAt,
              completed_at: completedAt,
              roundtrip_ms: completedAt - consultationRequestedAt,
            }, cameraId);
            if (!toolCall) return;
            const toolName = (toolCall as Record<string, unknown>)?.tool as string | undefined;
            if (toolName === "cortex_perception" && (toolCall as Record<string, unknown>).params) {
              const toolModuleSpecifier = "@cortex/percept/src/tool.js";
              (import(toolModuleSpecifier) as Promise<ToolModule>)
                .then(({ executeToolAction }) => {
                  executeToolAction(
                    (toolCall as Record<string, unknown>).params as Record<string, unknown>,
                    pipelineDeps,
                  ).catch((err: unknown) => console.error(`[benchmark] segment policy tool execution failed: ${err}`));
                })
                .catch(() => {});
            }
            if ((toolCall as Record<string, unknown>).exit_condition) {
              vc.setSegmentPolicyExitCondition(cameraId, (toolCall as Record<string, unknown>).exit_condition as any);
            }
          }).catch(err => {
            if (result._archive) {
              result._archive.postprocess = {
                ...(result._archive.postprocess ?? {}),
                vision_controller_consultation: {
                  consultation_id: consultationId,
                  attempted: true,
                  status: "error",
                  trigger_reason: segmentPolicy.consultationContext!.trigger_reason,
                  requested_at: consultationRequestedAt,
                  completed_at: Date.now(),
                  error: err instanceof Error ? err.message : String(err),
                },
              };
              const segmentPath = segmentFileById.get(segment.segment_id);
              if (segmentPath) patchSegmentArchive(segmentPath, result._archive);
            }
            console.error(`[benchmark] segment policy consultation failed: ${err}`);
          });
          consultationPromises.push(consultationPromise);
        }
      }

      // Save result at the pre-assigned index (preserves segment order)
      writeSegmentResult(segmentPath, result);
      segmentResultById.set(segment.segment_id, result);
      segmentResults[localSegIdx] = result;
      lastCompletedSegmentRef.value = { segment, segIdx, result };
      await captureDueCheckpoints(segment, segIdx, result);
      console.error(`[benchmark] Segment ${segIdx + 1}: "${result.perception_memory.summary.slice(0, 60)}..."`);
  };

  const perceptionRuntime = new PerceptionRuntime({
    processStreamSegment: processBenchmarkSegment,
    analyzeSnapshot: async () => null,
    waitForObservers: async () => {
      await Promise.all(memPromises);
      await Promise.all(consultationPromises);
    },
  }, {
    sourceConcurrency: 1,
    streamDispatchMode: "double_buffer",
  });

  const handleSegment = (segment: Segment): Promise<PerceptionResult | null> | void => {
    return perceptionRuntime.handleSegment(segment);
  };

  // 5. Create CamPipeline
  const camPipeline = new CamPipeline(
    { cameraId, mode: "stream", onSegment: handleSegment },
    { segmenters: [new CompositeSegmenter({ maxFrames: opts.framesPerSegment })] },
  );

  // Voice state tracking
  let latestHasVoice = false;
  let lastVoiceDetectTimeMs = -Infinity;
  const VOICE_RECENCY_MS = 2_000;

  // 6. Stream frames from ffmpeg — one at a time, no batch memory
  console.error(`[benchmark] Streaming frames at ${maxFps}fps from ${videoPath} (maxDurationSec=${maxDurationSec ?? "unbounded"})...`);
  let nextSampleTimeMs = 0;
  let frameCount = 0;

  for await (const { jpeg, index: fi, timestampMs: frameTimeMs } of streamFrames(videoPath, maxFps, maxDurationSec, 1024, ffmpegBin, undefined, ffprobeBin)) {
    // Dynamic fps sampling — skip frames below currentFps
    if (frameTimeMs < nextSampleTimeMs) continue;
    nextSampleTimeMs = frameTimeMs + 1000 / currentFps;
    frameCount++;

    const base64 = jpeg.toString("base64");

    // YOLO detection
    let detections: FrameDetection[] | undefined;
    if (detector) {
      try {
        const output = await detector.detect({ imageBuffer: jpeg });
        detections = output.boxes.map((b) => ({
          label: b.class_name ?? `class_${b.class_id}`,
          confidence: b.confidence,
          bbox: { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 },
        }));
      } catch {
        detections = [];
      }
    }

    // Motion filter
    const motionResult = motionFilter.detectWithRatio(jpeg, frameTimeMs);

    // VAD: feed audio up to current frame timestamp
    if (vad && audioSamples && audioBuffer) {
      const targetSample = Math.floor(((frameTimeMs - audioStartPtsMs) / 1000) * 16000);
      while (audioSampleIndex + VAD_CHUNK_SIZE <= targetSample && audioSampleIndex + VAD_CHUNK_SIZE <= audioSamples.length) {
        const chunkTimeMs = audioStartPtsMs + (audioSampleIndex / 16000) * 1000;
        const chunk = audioSamples.subarray(audioSampleIndex, audioSampleIndex + VAD_CHUNK_SIZE);
        const vadResult = vad.feedChunk(chunk);
        if (vadResult.isSpeaking) {
          lastVoiceDetectTimeMs = chunkTimeMs;
        }
        const voiceSegs = vadResult.segments.map(s => ({ start: s.start, length: s.samples.length }));
        const pcmChunkBuf = Buffer.from(
          audioBuffer.subarray(audioSampleIndex * 2, (audioSampleIndex + VAD_CHUNK_SIZE) * 2),
        );
        camPipeline.ingestAudio(pcmChunkBuf, voiceSegs, vadResult.segments, vadResult.isSpeaking);
        camPipeline.updateVoiceState(vadResult.isSpeaking, mediaTimeOffsetMs + chunkTimeMs);
        audioSampleIndex += VAD_CHUNK_SIZE;
      }
    }
    latestHasVoice = (frameTimeMs - lastVoiceDetectTimeMs) < VOICE_RECENCY_MS;

    // Frame policy
    if (vc) {
      const framePolicy = vc.evaluateFrame(
        cameraId,
        detections ?? [],
        {
          has_motion: motionResult.motion,
          last_motion_at: motionResult.motion ? frameTimeMs : motionFilter.lastMotionAt,
          last_still_at: motionResult.motion ? motionFilter.lastStillAt : frameTimeMs,
        },
        mediaTimeOffsetMs + frameTimeMs,
        { has_voice: latestHasVoice },
      );
      const hasFrameOverride =
        framePolicy.action.skip_vlm != null
        || framePolicy.action.max_level != null
        || framePolicy.action.vlm_model != null;
      if (hasFrameOverride) {
        pipelineDeps.strategyManager.setFramePolicyOverride(cameraId, {
          skipVlm: framePolicy.action.skip_vlm,
          maxLevel: framePolicy.action.max_level as 0 | 1 | 2 | undefined,
          vlmModel: framePolicy.action.vlm_model,
        });
      } else {
        pipelineDeps.strategyManager.clearFramePolicyOverride(cameraId);
      }
      if (framePolicy.action.fps) {
        const nextFps = Math.min(framePolicy.action.fps, FRAME_POLICY_MAX_FPS);
        if (nextFps !== currentFps) currentFps = nextFps;
      }
    }

    // Feed frame to CamPipeline
    const hasEntity = hasBenchmarkTrackableEntity(detections);
    await camPipeline.feedFrame(
      { data: base64, timestamp: mediaTimeOffsetMs + frameTimeMs, source_name: "benchmark", detections },
      { hasMotion: motionResult.motion, motionRatio: motionResult.ratio, hasVoice: latestHasVoice, hasEntity } satisfies SegmenterHints,
    );
  }

  console.error(`[benchmark] Streamed ${frameCount} frames`);

  // 7. End-of-video flush
  if (vad && audioBuffer) {
    const remaining = vad.flush();
    const voiceSegs = remaining.map(s => ({ start: s.start, length: s.samples.length }));
    const tailSampleStart = audioSampleIndex * 2;
    const tailPcm = tailSampleStart < audioBuffer.length
      ? Buffer.from(audioBuffer.subarray(tailSampleStart))
      : Buffer.alloc(0);
    if (tailPcm.length > 0 || voiceSegs.length > 0) {
      camPipeline.ingestAudio(tailPcm, voiceSegs, remaining);
    }
  }
  await camPipeline.forceFlush();

  await perceptionRuntime.waitForIdle();

  const remainingCheckpointLimit = opts.captureRemainingCheckpointsUntilMs ?? Infinity;
  const hasRemainingCheckpointDue =
    checkpointCursor < checkpoints.length
    && checkpoints[checkpointCursor]!.mediaTimeMs <= remainingCheckpointLimit;
  if (opts.onMemoryCheckpoint && hasRemainingCheckpointDue) {
    await Promise.all(memPromises);
    if (opts.narrativeMemory) {
      try {
        await opts.narrativeMemory.flush(cameraId);
        recordNarrativeFlush(lastCompletedSegmentRef.value?.result, {
          attempted: true,
          status: "ok",
        });
      } catch (err) {
        recordNarrativeFlush(lastCompletedSegmentRef.value?.result, {
          attempted: true,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
        if (!opts.ignoreNarrativeFlushErrors) throw err;
        console.error(`[benchmark] NarrativeMemory final checkpoint flush failed but continuing: ${err}`);
      }
    }
    while (
      lastCompletedSegmentRef.value
      && checkpointCursor < checkpoints.length
      && checkpoints[checkpointCursor]!.mediaTimeMs <= remainingCheckpointLimit
    ) {
      const checkpoint = checkpoints[checkpointCursor++]!;
      await opts.onMemoryCheckpoint({
        checkpoint,
        cameraId,
        userId,
        outputDir,
        segment: lastCompletedSegmentRef.value.segment,
        segmentIndex: lastCompletedSegmentRef.value.segIdx,
        segmentResult: lastCompletedSegmentRef.value.result,
      });
      capturedCheckpointIds.push(checkpoint.id);
    }
  }

  // Close tail event and flush narrative
  if (opts.narrativeMemory && opts.finalizeNarrative !== false) {
    opts.pipelineDeps.workingMemory.closeCurrentEvent(opts.cameraId);
    try {
      await opts.narrativeMemory.flush(opts.cameraId, { finalize: true });
      recordNarrativeFlush(lastCompletedSegmentRef.value?.result, {
        attempted: true,
        status: "ok",
        finalize: true,
      });
    } catch (err) {
      recordNarrativeFlush(lastCompletedSegmentRef.value?.result, {
        attempted: true,
        status: "error",
        finalize: true,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!opts.ignoreNarrativeFlushErrors) throw err;
      console.error(`[benchmark] NarrativeMemory flush failed but continuing: ${err}`);
    }
  }

  const memoryBarrier = Promise.all([...memPromises, ...consultationPromises]).then(() => {});
  pipelineDeps.memory = previousMemoryAdapter;
  return { segmentCount: segmentResults.length, segmentResults, capturedCheckpointIds, memoryBarrier };
}
