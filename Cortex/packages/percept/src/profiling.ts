import type { PipelineTrace } from "@cortex/shared";

export type PipelineStage =
  | "stt"
  | "detection"
  | "reid"
  | "vlm_stage"
  | "vlm_analyze"
  | "vlm_finalize";

interface StageRecord {
  startedAt?: number;
  completedAt?: number;
  latencyMs?: number;
}

export class PipelineProfiler {
  private readonly stages = new Map<PipelineStage, StageRecord>();

  start(stage: PipelineStage, now = Date.now()): number {
    const record = this.stages.get(stage) ?? {};
    record.startedAt = now;
    this.stages.set(stage, record);
    return now;
  }

  end(stage: PipelineStage, opts?: { now?: number; latencyMs?: number }): number {
    const now = opts?.now ?? Date.now();
    const record = this.stages.get(stage) ?? {};
    record.completedAt = now;
    record.latencyMs = opts?.latencyMs ?? (record.startedAt !== undefined ? Math.max(0, now - record.startedAt) : undefined);
    this.stages.set(stage, record);
    return now;
  }

  set(stage: PipelineStage, opts: { startedAt?: number; completedAt?: number; latencyMs?: number }): void {
    this.stages.set(stage, { ...this.stages.get(stage), ...opts });
  }

  timestamp(stage: PipelineStage, point: "start" | "end"): number | undefined {
    const record = this.stages.get(stage);
    return point === "start" ? record?.startedAt : record?.completedAt;
  }

  latency(stage: PipelineStage): number | undefined {
    return this.stages.get(stage)?.latencyMs;
  }

  traceTimestamps(): Partial<PipelineTrace["timestamps"]> {
    return {
      stt_started_at: this.timestamp("stt", "start"),
      stt_completed_at: this.timestamp("stt", "end"),
      detection_started_at: this.timestamp("detection", "start"),
      detection_completed_at: this.timestamp("detection", "end"),
      reid_started_at: this.timestamp("reid", "start"),
      reid_completed_at: this.timestamp("reid", "end"),
      vlm_stage_started_at: this.timestamp("vlm_stage", "start"),
      vlm_analyze_started_at: this.timestamp("vlm_analyze", "start"),
      vlm_analyze_completed_at: this.timestamp("vlm_analyze", "end"),
      vlm_completed_at: this.timestamp("vlm_stage", "end"),
    };
  }

  traceLatencies(): Partial<PipelineTrace["latencies"]> {
    const vlmPrepMs = this.diff("vlm_stage", "start", "vlm_analyze", "start");
    const vlmFinalizeMs = this.diff("vlm_analyze", "end", "vlm_stage", "end");
    return {
      stt_ms: this.latency("stt"),
      detection_ms: this.latency("detection"),
      reid_ms: this.latency("reid"),
      vlm_ms: this.latency("vlm_stage"),
      vlm_prep_ms: vlmPrepMs,
      vlm_analyze_ms: this.latency("vlm_analyze"),
      vlm_finalize_ms: vlmFinalizeMs,
    };
  }

  private diff(
    fromStage: PipelineStage,
    fromPoint: "start" | "end",
    toStage: PipelineStage,
    toPoint: "start" | "end",
  ): number | undefined {
    const from = this.timestamp(fromStage, fromPoint);
    const to = this.timestamp(toStage, toPoint);
    return from !== undefined && to !== undefined ? Math.max(0, to - from) : undefined;
  }
}
