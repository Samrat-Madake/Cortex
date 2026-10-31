import { SerialQueue } from "./utils/serial-queue.js";

export interface MemoryWriteAttemptContext {
  attempt: number;
  queueWaitMs: number;
}

export interface MemoryWriteRetryContext {
  error: unknown;
  attempt: number;
  nextAttempt: number;
  delayMs: number;
}

export interface MemoryWriteFinalErrorContext {
  error: unknown;
  attempts: number;
}

export interface MemoryWriteSuccessContext {
  attempts: number;
}

export interface MemoryWriteJob {
  run: (context: MemoryWriteAttemptContext) => Promise<void>;
  onRetry?: (context: MemoryWriteRetryContext) => void;
  onSuccess?: (context: MemoryWriteSuccessContext) => void;
  onFinalError?: (context: MemoryWriteFinalErrorContext) => void;
}

export interface MemoryWriteSchedulerOptions {
  maxSize?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  onHookError?: (err: unknown, hook: "retry" | "success" | "finalError") => void;
}

interface MemoryWriteState {
  job: MemoryWriteJob;
  attempt: number;
  enqueuedAt: number;
  resolve: () => void;
  reject: (err: unknown) => void;
  retryTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Serializes memory writes without holding the serial queue during retry delay.
 *
 * A failed attempt schedules a timer and re-enters the queue later, so one
 * camera's transient memory failure does not block writes for every camera.
 * waitForIdle() still waits for queued attempts, active attempts, and delayed
 * retries before resolving.
 */
export class MemoryWriteScheduler {
  private readonly queue: SerialQueue<MemoryWriteState>;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly onHookError?: (err: unknown, hook: "retry" | "success" | "finalError") => void;
  private readonly active = new Set<MemoryWriteState>();
  private idleResolvers: Array<() => void> = [];

  constructor(options: MemoryWriteSchedulerOptions = {}) {
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 2));
    this.retryDelayMs = Math.max(0, Math.floor(options.retryDelayMs ?? 2_000));
    this.onHookError = options.onHookError;
    this.queue = new SerialQueue<MemoryWriteState>(
      async (state) => { await this.runAttempt(state); },
      { maxSize: options.maxSize ?? 500 },
    );
  }

  get depth(): number {
    return this.queue.depth;
  }

  get isIdle(): boolean {
    return this.active.size === 0;
  }

  enqueue(job: MemoryWriteJob): Promise<void> {
    let resolve!: () => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const state: MemoryWriteState = {
      job,
      attempt: 0,
      enqueuedAt: Date.now(),
      resolve,
      reject,
    };
    this.active.add(state);
    if (!this.queue.enqueue(state)) {
      const err = new Error("Memory write queue full");
      this.finishError(state, err);
    }
    return promise;
  }

  waitForIdle(): Promise<void> {
    if (this.isIdle) return Promise.resolve();
    return new Promise((resolve) => { this.idleResolvers.push(resolve); });
  }

  private async runAttempt(state: MemoryWriteState): Promise<void> {
    const attempt = state.attempt;
    let runSucceeded = false;
    let runError: unknown;
    try {
      await state.job.run({
        attempt,
        queueWaitMs: Date.now() - state.enqueuedAt,
      });
      runSucceeded = true;
    } catch (err) {
      runError = err;
    }

    if (runSucceeded) {
      this.active.delete(state);
      state.resolve();
      this.resolveIdleIfNeeded();
      this.callHook("success", () => {
        state.job.onSuccess?.({ attempts: attempt + 1 });
      });
      return;
    }

    if (attempt + 1 < this.maxAttempts) {
      const nextAttempt = attempt + 1;
      const delayMs = this.retryDelayMs;
      state.attempt = nextAttempt;
      state.retryTimer = setTimeout(() => {
        state.retryTimer = undefined;
        state.enqueuedAt = Date.now();
        if (!this.queue.enqueue(state)) {
          this.finishError(state, new Error("Memory write queue full during retry"));
        }
      }, delayMs);
      this.callHook("retry", () => {
        state.job.onRetry?.({ error: runError, attempt, nextAttempt, delayMs });
      });
      this.resolveIdleIfNeeded();
      return;
    }
    this.finishError(state, runError);
  }

  private finishError(state: MemoryWriteState, err: unknown): void {
    if (state.retryTimer) {
      clearTimeout(state.retryTimer);
      state.retryTimer = undefined;
    }
    this.active.delete(state);
    state.reject(err);
    this.resolveIdleIfNeeded();
    this.callHook("finalError", () => {
      state.job.onFinalError?.({ error: err, attempts: state.attempt + 1 });
    });
  }

  private resolveIdleIfNeeded(): void {
    if (!this.isIdle) return;
    const resolvers = this.idleResolvers;
    this.idleResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  private callHook(hook: "retry" | "success" | "finalError", fn: () => void): void {
    try {
      fn();
    } catch (err) {
      try {
        this.onHookError?.(err, hook);
      } catch {
        // Hook error reporting must not affect scheduler state.
      }
    }
  }
}
