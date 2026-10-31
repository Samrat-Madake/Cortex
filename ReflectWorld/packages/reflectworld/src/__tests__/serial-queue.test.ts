import { describe, it, expect, vi } from "vitest";
import { SerialQueue } from "../utils/serial-queue.js";

describe("SerialQueue", () => {
  it("processes items in order", async () => {
    const order: number[] = [];
    const queue = new SerialQueue<number>(async (n) => {
      await new Promise((r) => setTimeout(r, 10));
      order.push(n);
    });

    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);

    await new Promise((r) => setTimeout(r, 100));
    expect(order).toEqual([1, 2, 3]);
  });

  it("handles handler errors without stopping", async () => {
    const processed: number[] = [];
    const queue = new SerialQueue<number>(async (n) => {
      if (n === 2) throw new Error("boom");
      processed.push(n);
    });

    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);

    await new Promise((r) => setTimeout(r, 50));
    expect(processed).toEqual([1, 3]);
  });

  it("drops oldest when exceeding maxSize", async () => {
    const processed: number[] = [];
    let resolveFirst: () => void;
    const firstBlocked = new Promise<void>((r) => { resolveFirst = r; });

    const onDrop = vi.fn();
    const queue = new SerialQueue<number>(async (n) => {
      if (n === 1) await firstBlocked;
      processed.push(n);
    }, 2, onDrop);

    queue.enqueue(1); // processing, blocks
    queue.enqueue(2); // queued
    queue.enqueue(3); // queued (queue: [2, 3])
    queue.enqueue(4); // overflow: drop 2, queue: [3, 4]

    expect(queue.depth).toBeLessThanOrEqual(2);
    expect(queue.dropped).toBe(1);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith(1);

    resolveFirst!();
    await new Promise((r) => setTimeout(r, 50));
    expect(processed).toEqual([1, 3, 4]);
  });

  it("reports depth correctly", () => {
    const queue = new SerialQueue<number>(async () => {
      await new Promise((r) => setTimeout(r, 1000));
    });
    expect(queue.depth).toBe(0);
    queue.enqueue(1);
    queue.enqueue(2);
    expect(queue.depth).toBe(1);
  });
});
