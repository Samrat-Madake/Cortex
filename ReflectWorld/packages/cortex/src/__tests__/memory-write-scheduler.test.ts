import { describe, it, expect, vi, afterEach } from "vitest";
import { MemoryWriteScheduler } from "../memory-write-scheduler.js";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("MemoryWriteScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("releases the queue while waiting to retry a failed write", async () => {
    vi.useFakeTimers();
    const scheduler = new MemoryWriteScheduler({ retryDelayMs: 1000, maxAttempts: 2 });
    const order: string[] = [];

    const first = scheduler.enqueue({
      run: async ({ attempt }) => {
        order.push(`a${attempt}`);
        if (attempt === 0) throw new Error("temporary memory failure");
      },
    });
    await flushMicrotasks();

    const second = scheduler.enqueue({
      run: async ({ attempt }) => {
        order.push(`b${attempt}`);
      },
    });
    await flushMicrotasks();

    expect(order).toEqual(["a0", "b0"]);
    await second;

    await vi.advanceTimersByTimeAsync(1000);
    await first;
    expect(order).toEqual(["a0", "b0", "a1"]);
  });

  it("waitForIdle includes delayed retries", async () => {
    vi.useFakeTimers();
    const scheduler = new MemoryWriteScheduler({ retryDelayMs: 1000, maxAttempts: 2 });
    let idleResolved = false;

    const write = scheduler.enqueue({
      run: async ({ attempt }) => {
        if (attempt === 0) throw new Error("temporary memory failure");
      },
    });
    const idle = scheduler.waitForIdle().then(() => { idleResolved = true; });
    await flushMicrotasks();

    expect(idleResolved).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    await flushMicrotasks();
    expect(idleResolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await write;
    await idle;
    expect(idleResolved).toBe(true);
  });

  it("rejects and reports final failure after max attempts", async () => {
    vi.useFakeTimers();
    const scheduler = new MemoryWriteScheduler({ retryDelayMs: 100, maxAttempts: 2 });
    const onRetry = vi.fn();
    const onFinalError = vi.fn();
    let calls = 0;

    const write = scheduler.enqueue({
      run: async () => {
        calls++;
        throw new Error(`failure ${calls}`);
      },
      onRetry,
      onFinalError,
    });
    const rejection = expect(write).rejects.toThrow("failure 2");

    await flushMicrotasks();
    expect(onRetry).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(calls).toBe(2);
    expect(onFinalError).toHaveBeenCalledTimes(1);
    expect(onFinalError.mock.calls[0]![0]).toMatchObject({ attempts: 2 });
  });

  it("does not retry a successful write when onSuccess throws", async () => {
    const onHookError = vi.fn();
    const run = vi.fn().mockResolvedValue(undefined);
    const scheduler = new MemoryWriteScheduler({ maxAttempts: 2, onHookError });

    const write = scheduler.enqueue({
      run,
      onSuccess: () => {
        throw new Error("archive patch failed");
      },
    });

    await expect(write).resolves.toBeUndefined();
    await scheduler.waitForIdle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(onHookError).toHaveBeenCalledTimes(1);
    expect(onHookError.mock.calls[0]![1]).toBe("success");
  });

  it("treats undefined thrown by run as a failure", async () => {
    vi.useFakeTimers();
    const scheduler = new MemoryWriteScheduler({ retryDelayMs: 100, maxAttempts: 2 });
    const run = vi.fn()
      .mockImplementationOnce(async () => { throw undefined; })
      .mockResolvedValueOnce(undefined);

    const write = scheduler.enqueue({ run });

    await flushMicrotasks();
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    await write;
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("still schedules retry and drains idle when onRetry throws", async () => {
    vi.useFakeTimers();
    const onHookError = vi.fn();
    const scheduler = new MemoryWriteScheduler({ retryDelayMs: 100, maxAttempts: 2, onHookError });
    let calls = 0;

    const write = scheduler.enqueue({
      run: async () => {
        calls++;
        if (calls === 1) throw new Error("temporary memory failure");
      },
      onRetry: () => {
        throw new Error("retry diagnostics failed");
      },
    });
    const idle = scheduler.waitForIdle();

    await flushMicrotasks();
    expect(calls).toBe(1);
    expect(onHookError).toHaveBeenCalledTimes(1);
    expect(onHookError.mock.calls[0]![1]).toBe("retry");

    await vi.advanceTimersByTimeAsync(100);
    await write;
    await idle;
    expect(calls).toBe(2);
  });

  it("still rejects and drains idle when onFinalError throws", async () => {
    const onHookError = vi.fn();
    const scheduler = new MemoryWriteScheduler({ maxAttempts: 1, onHookError });

    const write = scheduler.enqueue({
      run: async () => {
        throw new Error("permanent memory failure");
      },
      onFinalError: () => {
        throw new Error("dead-letter failed");
      },
    });
    const idle = scheduler.waitForIdle();

    await expect(write).rejects.toThrow("permanent memory failure");
    await idle;
    expect(scheduler.isIdle).toBe(true);
    expect(onHookError).toHaveBeenCalledTimes(1);
    expect(onHookError.mock.calls[0]![1]).toBe("finalError");
  });
});
