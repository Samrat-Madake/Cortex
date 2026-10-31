import { describe, it, expect } from "vitest";
import { AsyncQueue } from "../async-queue.js";

describe("AsyncQueue", () => {
  it("runs tasks sequentially", async () => {
    const q = new AsyncQueue();
    const order: number[] = [];
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const p1 = q.enqueue(async () => {
      await delay(50);
      order.push(1);
    });
    const p2 = q.enqueue(async () => {
      order.push(2);
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it("propagates errors without blocking queue", async () => {
    const q = new AsyncQueue();
    const p1 = q.enqueue(async () => {
      throw new Error("fail");
    });
    const p2 = q.enqueue(async () => 42);
    await expect(p1).rejects.toThrow("fail");
    expect(await p2).toBe(42);
  });

  it("handles sync tasks", async () => {
    const q = new AsyncQueue();
    const result = await q.enqueue(() => "hello");
    expect(result).toBe("hello");
  });
});
