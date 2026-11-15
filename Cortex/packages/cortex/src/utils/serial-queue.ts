/**
 * Bounded serial async queue. Processes one item at a time in FIFO order.
 * When the queue exceeds maxSize, queues with onDrop shed the oldest queued item;
 * correctness-sensitive queues without onDrop reject the new item instead.
 */
export interface SerialQueueOptions {
  maxSize?: number;
  onDrop?: (dropped: number) => void;
  onError?: (err: unknown) => void;
}

export class SerialQueue<T> {
  private queue: T[] = [];
  private running = false;
  private _dropped = 0;
  private readonly maxSize: number;
  private readonly onDrop?: (dropped: number) => void;
  private readonly onError?: (err: unknown) => void;
  private idleResolvers: Array<() => void> = [];

  constructor(
    private readonly handler: (item: T) => Promise<void>,
    options?: number | SerialQueueOptions,
    onDrop?: (dropped: number) => void,
  ) {
    if (typeof options === "number") {
      // Backward compat: new SerialQueue(handler, maxSize, onDrop)
      this.maxSize = options;
      this.onDrop = onDrop;
    } else {
      this.maxSize = options?.maxSize ?? 50;
      this.onDrop = options?.onDrop;
      this.onError = options?.onError;
    }
  }

  /** Enqueue an item. Returns false if the queue is full and the item was not accepted. */
  enqueue(item: T): boolean {
    if (this.queue.length >= this.maxSize) {
      if (this.onDrop) {
        // Segment queue: bounded, oldest items can be dropped
        this.queue.shift();
        this._dropped++;
        this.onDrop(this._dropped);
      } else {
        // No drop handler = correctness-sensitive queue (e.g. memory writes).
        return false;
      }
    }
    this.queue.push(item);
    if (!this.running) void this.drain();
    return true;
  }

  get depth(): number { return this.queue.length; }
  get dropped(): number { return this._dropped; }
  get isIdle(): boolean { return !this.running && this.queue.length === 0; }

  removeQueued(predicate: (item: T) => boolean): T[] {
    const removed: T[] = [];
    const kept: T[] = [];
    for (const item of this.queue) {
      if (predicate(item)) removed.push(item);
      else kept.push(item);
    }
    if (removed.length === 0) return removed;
    this.queue = kept;
    if (this.isIdle) this.resolveIdle();
    return removed;
  }

  /** Returns a promise that resolves when the queue is empty and no handler is running. */
  waitForIdle(): Promise<void> {
    if (this.isIdle) return Promise.resolve();
    return new Promise((resolve) => { this.idleResolvers.push(resolve); });
  }

  private async drain(): Promise<void> {
    this.running = true;
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      try {
        await this.handler(item);
      } catch (err) {
        this.onError?.(err);
      }
    }
    this.running = false;
    this.resolveIdle();
  }

  private resolveIdle(): void {
    if (!this.isIdle) return;
    for (const resolve of this.idleResolvers) resolve();
    this.idleResolvers = [];
  }
}
