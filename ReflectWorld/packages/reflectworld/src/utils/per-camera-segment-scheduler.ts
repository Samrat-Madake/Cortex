import { SerialQueue } from "./serial-queue.js";

class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Array<(release: () => void) => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }

    return new Promise<() => void>((resolve) => this.waiters.push(resolve));
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

export interface PerCameraSegmentSchedulerOptions<T> {
  getCameraId: (item: T) => string;
  handler: (item: T) => Promise<void>;
  maxConcurrentCameras?: number;
  maxQueuedPerCamera?: number;
  onReject?: (cameraId: string, item: T) => void;
  onError?: (err: unknown, item: T) => void;
}

/**
 * Per-camera FIFO scheduler with cross-camera concurrency.
 *
 * This preserves Benchmark's source-local ordering while allowing independent
 * live sources to make progress when one camera's perception call is slow.
 */
export class PerCameraSegmentScheduler<T> {
  private readonly queues = new Map<string, SerialQueue<T>>();
  private readonly semaphore: AsyncSemaphore;
  private readonly maxQueuedPerCamera: number;

  constructor(private readonly options: PerCameraSegmentSchedulerOptions<T>) {
    const maxConcurrent = Math.max(1, Math.floor(options.maxConcurrentCameras ?? 1));
    this.semaphore = new AsyncSemaphore(maxConcurrent);
    this.maxQueuedPerCamera = options.maxQueuedPerCamera ?? Number.POSITIVE_INFINITY;
  }

  enqueue(item: T): boolean {
    const cameraId = this.options.getCameraId(item) || "unknown";
    const queue = this.getQueue(cameraId);
    const accepted = queue.enqueue(item);
    if (!accepted) this.options.onReject?.(cameraId, item);
    return accepted;
  }

  get depth(): number {
    let total = 0;
    for (const queue of this.queues.values()) total += queue.depth;
    return total;
  }

  depthForCamera(cameraId: string): number {
    return this.queues.get(cameraId)?.depth ?? 0;
  }

  canAccept(cameraId: string): boolean {
    return this.depthForCamera(cameraId) < this.maxQueuedPerCamera;
  }

  getBacklog(cameraId?: string): { total: number; byCamera: Record<string, number> } {
    const byCamera: Record<string, number> = {};
    for (const [id, queue] of this.queues.entries()) {
      if (cameraId && id !== cameraId) continue;
      byCamera[id] = queue.depth;
    }
    const total = Object.values(byCamera).reduce((sum, depth) => sum + depth, 0);
    return { total, byCamera };
  }

  removeQueued(cameraId: string, predicate: (item: T) => boolean): T[] {
    return this.queues.get(cameraId)?.removeQueued(predicate) ?? [];
  }

  async waitForIdle(cameraId?: string): Promise<void> {
    for (;;) {
      const queues = cameraId
        ? [...(this.queues.get(cameraId) ? [this.queues.get(cameraId)!] : [])]
        : [...this.queues.values()];
      await Promise.all(queues.map((queue) => queue.waitForIdle()));
      const currentQueues = cameraId
        ? [...(this.queues.get(cameraId) ? [this.queues.get(cameraId)!] : [])]
        : [...this.queues.values()];
      if (currentQueues.every((queue) => queue.isIdle)) return;
    }
  }

  private getQueue(cameraId: string): SerialQueue<T> {
    const existing = this.queues.get(cameraId);
    if (existing) return existing;

    const queue = new SerialQueue<T>(async (item) => {
      const release = await this.semaphore.acquire();
      try {
        await this.options.handler(item);
      } catch (err) {
        this.options.onError?.(err, item);
      } finally {
        release();
      }
    }, { maxSize: this.maxQueuedPerCamera });
    this.queues.set(cameraId, queue);
    return queue;
  }
}
