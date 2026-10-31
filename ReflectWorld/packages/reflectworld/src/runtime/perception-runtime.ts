import type { Segment, PerceptionResult } from "@reflectworld/shared";
import { PerCameraSegmentScheduler } from "../utils/per-camera-segment-scheduler.js";

export interface PerceptionRuntimeConfig {
  sourceConcurrency?: number;
  maxQueuedPerCamera?: number;
  liveBacklogSkipAfterMs?: number;
  streamDispatchMode?: "fire_and_forget" | "double_buffer" | "by_input_mode";
  sourceOrderBarrier?: "completed" | "critical_ready";
  maxInFlightPerCamera?: number;
}

export interface SegmentRuntimeTask {
  /** Safe point for source-local scheduling to release the next segment. */
  criticalReady?: Promise<void>;
  /** Full segment completion, including final projection/enrichment. */
  completed: Promise<void>;
}

export interface PerceptionRuntimeDeps {
  processStreamSegment: (segment: Segment) => Promise<void> | SegmentRuntimeTask;
  analyzeSnapshot: (segment: Segment) => Promise<PerceptionResult | null>;
  waitForObservers?: () => Promise<void>;
  onStart?: (segment: Segment) => void;
  onReject?: (cameraId: string, segment: Segment) => void;
  onSkip?: (cameraId: string, segment: Segment, info: PerceptionSkipInfo) => void;
  onError?: (err: unknown, segment: Segment) => void;
}

export interface PerceptionSkipInfo {
  reason: "backlog_lag_exceeded";
  lagMs: number;
  thresholdMs: number;
  latestSegmentId: string;
}

export interface PerceptionBacklog {
  total: number;
  byCamera: Record<string, number>;
  queued: number;
  running: number;
  pending: number;
  rejectedTotal: number;
  runningByCamera: Record<string, number>;
  pendingByCamera: Record<string, number>;
  rejectedByCamera: Record<string, number>;
}

class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Array<(release: () => void) => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next(() => this.release());
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}

/**
 * Runtime wrapper for source-local FIFO perception execution.
 *
 * Snapshot segments run inline. Stream/event segments are dispatched through
 * either the per-camera live scheduler or the local-file double-buffer path.
 */
export class PerceptionRuntime {
  private readonly scheduler: PerCameraSegmentScheduler<Segment>;
  private readonly executionGate: AsyncSemaphore;
  private readonly pendingByCamera = new Map<string, Promise<void>>();
  private readonly finalByCamera = new Map<string, Set<Promise<void>>>();
  private readonly doubleBufferErrorsByCamera = new Map<string, unknown[]>();
  private readonly finalErrorsByCamera = new Map<string, unknown[]>();
  private readonly runningByCamera = new Map<string, number>();
  private readonly rejectedByCamera = new Map<string, number>();
  private rejectedTotal = 0;
  readonly config: Required<Pick<PerceptionRuntimeConfig, "streamDispatchMode" | "sourceOrderBarrier" | "maxInFlightPerCamera" | "liveBacklogSkipAfterMs">> & PerceptionRuntimeConfig;

  constructor(private readonly deps: PerceptionRuntimeDeps, config: PerceptionRuntimeConfig = {}) {
    this.config = {
      ...config,
      streamDispatchMode: config.streamDispatchMode ?? "fire_and_forget",
      sourceOrderBarrier: config.sourceOrderBarrier ?? "completed",
      maxInFlightPerCamera: Math.max(1, Math.floor(config.maxInFlightPerCamera ?? 2)),
      liveBacklogSkipAfterMs: Math.max(1, Math.floor(config.liveBacklogSkipAfterMs ?? 180_000)),
    };
    const concurrency = Math.max(1, Math.floor(config.sourceConcurrency ?? 1));
    this.executionGate = new AsyncSemaphore(concurrency);
    this.scheduler = new PerCameraSegmentScheduler<Segment>({
      getCameraId: (segment) => segment.camera_id,
      handler: (segment) => this.processWithExecutionGate(segment),
      maxConcurrentCameras: concurrency,
      maxQueuedPerCamera: config.maxQueuedPerCamera,
      onReject: (cameraId, segment) => {
        this.rejectedTotal += 1;
        this.rejectedByCamera.set(cameraId, (this.rejectedByCamera.get(cameraId) ?? 0) + 1);
        deps.onReject?.(cameraId, segment);
      },
      onError: deps.onError,
    });
  }

  handleSegment(segment: Segment): Promise<PerceptionResult | null> | void {
    if (segment.mode === "snapshot") {
      return this.deps.analyzeSnapshot(segment);
    }
    const dispatchMode = this.dispatchModeFor(segment);
    if (dispatchMode === "double_buffer") {
      return this.handleDoubleBufferedStreamSegment(segment);
    }
    this.skipLaggingLiveQueuedSegments(segment);
    this.scheduler.enqueue(segment);
  }

  canAcceptSegment(segment: Segment): boolean {
    if (segment.mode === "snapshot") return true;
    if (this.dispatchModeFor(segment) === "double_buffer") return true;
    this.skipLaggingLiveQueuedSegments(segment);
    return this.scheduler.canAccept(segment.camera_id || "unknown");
  }

  private dispatchModeFor(segment: Segment): "fire_and_forget" | "double_buffer" {
    if (this.config.streamDispatchMode === "by_input_mode") {
      return segment._input_mode === "local_file" ? "double_buffer" : "fire_and_forget";
    }
    return this.config.streamDispatchMode;
  }

  private skipLaggingLiveQueuedSegments(latest: Segment): void {
    if (latest._input_mode !== "live_stream") return;
    const thresholdMs = this.config.liveBacklogSkipAfterMs;
    if (!Number.isFinite(thresholdMs) || thresholdMs === undefined || thresholdMs <= 0) return;
    const cameraId = latest.camera_id || "unknown";
    const cutoffTs = latest.timestamp - thresholdMs;
    const skipped = this.scheduler.removeQueued(cameraId, (queued) => {
      if (queued._input_mode !== "live_stream") return false;
      const queuedEndTs = queued.timestamp + Math.max(0, queued.duration_sec) * 1000;
      return queuedEndTs < cutoffTs;
    });
    for (const segment of skipped) {
      const segmentEndTs = segment.timestamp + Math.max(0, segment.duration_sec) * 1000;
      this.deps.onSkip?.(cameraId, segment, {
        reason: "backlog_lag_exceeded",
        lagMs: Math.max(0, latest.timestamp - segmentEndTs),
        thresholdMs,
        latestSegmentId: latest.segment_id,
      });
    }
  }

  getBacklog(cameraId?: string): PerceptionBacklog {
    const schedulerBacklog = this.scheduler.getBacklog(cameraId);
    const backlog: PerceptionBacklog = {
      total: schedulerBacklog.total,
      byCamera: { ...schedulerBacklog.byCamera },
      queued: schedulerBacklog.total,
      running: 0,
      pending: 0,
      rejectedTotal: this.rejectedTotal,
      runningByCamera: {},
      pendingByCamera: {},
      rejectedByCamera: {},
    };
    for (const [camera, count] of this.runningByCamera.entries()) {
      if (cameraId && camera !== cameraId) continue;
      backlog.runningByCamera[camera] = count;
      backlog.running += count;
    }
    for (const camera of this.pendingByCamera.keys()) {
      if (cameraId && camera !== cameraId) continue;
      backlog.pendingByCamera[camera] = (backlog.pendingByCamera[camera] ?? 0) + 1;
      backlog.pending += 1;
      backlog.byCamera[camera] = (backlog.byCamera[camera] ?? 0) + 1;
      backlog.total += 1;
    }
    if (this.config.sourceOrderBarrier === "critical_ready") {
      for (const [camera, finals] of this.finalByCamera.entries()) {
        if (cameraId && camera !== cameraId) continue;
        if (finals.size === 0) continue;
        backlog.pendingByCamera[camera] = (backlog.pendingByCamera[camera] ?? 0) + finals.size;
        backlog.pending += finals.size;
        backlog.byCamera[camera] = (backlog.byCamera[camera] ?? 0) + finals.size;
        backlog.total += finals.size;
      }
    }
    for (const [camera, count] of this.rejectedByCamera.entries()) {
      if (cameraId && camera !== cameraId) continue;
      backlog.rejectedByCamera[camera] = count;
    }
    return backlog;
  }

  async waitForIdle(): Promise<void> {
    await this.scheduler.waitForIdle();
    await Promise.all([...this.pendingByCamera.values()]);
    if (this.config.sourceOrderBarrier === "critical_ready") await this.waitForFinals();
    await this.deps.waitForObservers?.();
    this.throwDoubleBufferErrorIfAny();
    this.throwFinalErrorIfAny();
  }

  async waitForCameraIdle(cameraId: string): Promise<void> {
    await this.scheduler.waitForIdle(cameraId);
    await this.pendingByCamera.get(cameraId);
    if (this.config.sourceOrderBarrier === "critical_ready") await this.waitForFinals(cameraId);
    await this.deps.waitForObservers?.();
    this.throwDoubleBufferErrorIfAny(cameraId);
    this.throwFinalErrorIfAny(cameraId);
  }

  private async processWithExecutionGate(segment: Segment): Promise<void> {
    const cameraId = segment.camera_id || "unknown";
    if (this.config.sourceOrderBarrier === "critical_ready") await this.waitForFinalCapacity(cameraId);
    const release = await this.executionGate.acquire();
    this.runningByCamera.set(cameraId, (this.runningByCamera.get(cameraId) ?? 0) + 1);
    let released = false;
    const releaseGate = (): void => {
      if (released) return;
      released = true;
      const next = (this.runningByCamera.get(cameraId) ?? 1) - 1;
      if (next > 0) this.runningByCamera.set(cameraId, next);
      else this.runningByCamera.delete(cameraId);
      release();
    };
    try {
      this.deps.onStart?.(segment);
      const task = this.normalizeTask(this.deps.processStreamSegment(segment));
      if (this.config.sourceOrderBarrier === "critical_ready" && task.criticalReady) {
        const completed = this.trackFinal(cameraId, segment, task.completed);
        await task.criticalReady;
        releaseGate();
        return;
      }
      await task.completed;
    } finally {
      releaseGate();
    }
  }

  private normalizeTask(result: Promise<void> | SegmentRuntimeTask): SegmentRuntimeTask {
    if (result && typeof result === "object" && "completed" in result) {
      return result;
    }
    return { completed: Promise.resolve(result) };
  }

  private trackFinal(cameraId: string, segment: Segment, completed: Promise<void>): Promise<void> {
    let tracked!: Promise<void>;
    let observed!: Promise<void>;
    tracked = Promise.resolve(completed)
      .catch((err) => {
        const errors = this.finalErrorsByCamera.get(cameraId) ?? [];
        errors.push(err);
        this.finalErrorsByCamera.set(cameraId, errors);
        if (this.config.sourceOrderBarrier === "critical_ready") {
          this.deps.onError?.(err, segment);
        }
        throw err;
      })
      .finally(() => {
        const finals = this.finalByCamera.get(cameraId);
        finals?.delete(observed);
        if (finals && finals.size === 0) this.finalByCamera.delete(cameraId);
      });
    observed = tracked.catch(() => undefined);
    const finals = this.finalByCamera.get(cameraId) ?? new Set<Promise<void>>();
    finals.add(observed);
    this.finalByCamera.set(cameraId, finals);
    return tracked;
  }

  private async waitForFinalCapacity(cameraId: string): Promise<void> {
    if (this.config.sourceOrderBarrier !== "critical_ready") return;
    const maxInFlight = this.config.maxInFlightPerCamera;
    while ((this.finalByCamera.get(cameraId)?.size ?? 0) >= maxInFlight) {
      const finals = [...(this.finalByCamera.get(cameraId) ?? [])];
      if (finals.length === 0) return;
      await Promise.race(finals);
    }
  }

  private async waitForFinals(cameraId?: string): Promise<void> {
    const finals = cameraId
      ? [...(this.finalByCamera.get(cameraId) ?? [])]
      : [...this.finalByCamera.values()].flatMap((set) => [...set]);
    await Promise.all(finals);
  }

  private async handleDoubleBufferedStreamSegment(segment: Segment): Promise<PerceptionResult | null> {
    const cameraId = segment.camera_id || "unknown";
    const previous = this.pendingByCamera.get(cameraId);
    let current: Promise<void>;
    current = (async () => {
      if (previous) await previous;
      await this.processWithExecutionGate(segment);
    })()
      .catch((err) => {
        this.deps.onError?.(err, segment);
        const errors = this.doubleBufferErrorsByCamera.get(cameraId) ?? [];
        errors.push(err);
        this.doubleBufferErrorsByCamera.set(cameraId, errors);
      })
      .finally(() => {
        if (this.pendingByCamera.get(cameraId) === current) {
          this.pendingByCamera.delete(cameraId);
        }
      });
    this.pendingByCamera.set(cameraId, current);
    if (previous) await previous;
    return null;
  }

  private throwDoubleBufferErrorIfAny(cameraId?: string): void {
    if (cameraId) {
      const errors = this.doubleBufferErrorsByCamera.get(cameraId);
      const err = errors?.shift();
      if (errors && errors.length === 0) this.doubleBufferErrorsByCamera.delete(cameraId);
      if (err) throw err;
      return;
    }
    for (const [id, errors] of this.doubleBufferErrorsByCamera.entries()) {
      const err = errors.shift();
      if (errors.length === 0) this.doubleBufferErrorsByCamera.delete(id);
      if (err) throw err;
    }
  }

  private throwFinalErrorIfAny(cameraId?: string): void {
    if (cameraId) {
      const errors = this.finalErrorsByCamera.get(cameraId);
      const err = errors?.shift();
      if (errors && errors.length === 0) this.finalErrorsByCamera.delete(cameraId);
      if (err) throw err;
      return;
    }
    for (const [id, errors] of this.finalErrorsByCamera.entries()) {
      const err = errors.shift();
      if (errors.length === 0) this.finalErrorsByCamera.delete(id);
      if (err) throw err;
    }
  }
}
