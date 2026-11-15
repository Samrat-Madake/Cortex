/**
 * Simple async FIFO queue for serializing state-mutating operations.
 * Ensures only one task runs at a time. Tasks are processed in order.
 */
export class AsyncQueue {
  private tail: Promise<void> = Promise.resolve();

  /**
   * Enqueue a task. Returns a promise that resolves with the task's return
   * value, or rejects if the task throws. Errors do not block subsequent tasks.
   */
  enqueue<T>(task: () => T | Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.tail = this.tail
        .then(() => Promise.resolve(task()))
        .then(resolve, reject)
        .catch(() => {}); // Prevent unhandled rejection on tail chain
    });
  }
}
