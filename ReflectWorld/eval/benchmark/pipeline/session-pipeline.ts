import type { NarrativeMemory } from "@cortex/percept";
import type { VideoPipelineCheckpoint, VideoPipelineOptions, VideoPipelineResult } from "./video-pipeline.js";
import { runVideoPipeline } from "./video-pipeline.js";

export interface SessionPipelineClip {
  path: string;
  mediaStartMs: number;
  mediaDurationMs?: number;
  metadata?: Record<string, unknown>;
}

export interface SessionPipelineOptions extends Omit<
  VideoPipelineOptions,
  "videoPath" | "mediaTimeOffsetMs" | "checkpoints" | "captureRemainingCheckpointsUntilMs" | "finalizeNarrative"
> {
  clips: SessionPipelineClip[];
  checkpoints?: VideoPipelineCheckpoint[];
  narrativeMemory?: NarrativeMemory;
}

export interface SessionPipelineResult extends VideoPipelineResult {
  clipCount: number;
}

function finitePositiveMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

function finitePositiveSeconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function firstString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function effectiveClipDurationMs(clip: SessionPipelineClip, maxDurationSec?: number): number | undefined {
  const caps = [
    finitePositiveMs(clip.mediaDurationMs),
    finitePositiveSeconds(maxDurationSec) != null
      ? Math.round(finitePositiveSeconds(maxDurationSec)! * 1000)
      : undefined,
  ].filter((value): value is number => value != null);
  return caps.length ? Math.min(...caps) : undefined;
}

export async function runSessionPipeline(opts: SessionPipelineOptions): Promise<SessionPipelineResult> {
  const clips = [...opts.clips]
    .filter((clip) => clip.path.trim())
    .sort((a, b) => a.mediaStartMs - b.mediaStartMs || a.path.localeCompare(b.path));
  if (!clips.length) {
    throw new Error("runSessionPipeline requires at least one clip");
  }

  let remainingCheckpoints = [...(opts.checkpoints ?? [])]
    .filter((cp) => Number.isFinite(cp.mediaTimeMs))
    .sort((a, b) => a.mediaTimeMs - b.mediaTimeMs || a.id.localeCompare(b.id));
  const segmentResults: VideoPipelineResult["segmentResults"] = [];
  const capturedCheckpointIds: string[] = [];
  const barriers: Promise<void>[] = [];
  let segmentIndexOffset = opts.segmentIndexOffset ?? 0;

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]!;
    const nextClip = clips[i + 1];
    const clipDurationMs = effectiveClipDurationMs(clip, opts.maxDurationSec);
    const clipEndMs = clipDurationMs != null ? clip.mediaStartMs + clipDurationMs : undefined;
    const captureUntilMs = nextClip
      ? nextClip.mediaStartMs
      : clipEndMs ?? Infinity;
    const result = await runVideoPipeline({
      ...opts,
      videoPath: clip.path,
      maxDurationSec: clipDurationMs != null ? clipDurationMs / 1000 : undefined,
      mediaTimeOffsetMs: clip.mediaStartMs,
      timeBasis: firstString(clip.metadata?.time_basis) ?? opts.timeBasis,
      segmentIndexOffset,
      checkpoints: remainingCheckpoints,
      captureRemainingCheckpointsUntilMs: captureUntilMs,
      finalizeNarrative: i === clips.length - 1,
    });

    segmentIndexOffset += result.segmentCount;
    segmentResults.push(...result.segmentResults);
    capturedCheckpointIds.push(...result.capturedCheckpointIds);
    barriers.push(result.memoryBarrier);

    if (result.capturedCheckpointIds.length) {
      const captured = new Set(result.capturedCheckpointIds);
      remainingCheckpoints = remainingCheckpoints.filter((cp) => !captured.has(cp.id));
    }

    if (i < clips.length - 1) {
      await result.memoryBarrier;
    }
  }

  const memoryBarrier = Promise.all(barriers).then(() => {});
  return {
    clipCount: clips.length,
    segmentCount: segmentResults.length,
    segmentResults,
    capturedCheckpointIds,
    memoryBarrier,
  };
}
