import type { FrameResult, WatchMode } from "./types.js";

type CaptureFunction = () => Promise<FrameResult>;
type FrameCallback = (frame: FrameResult) => void;

interface WatchEntry {
  timer: ReturnType<typeof setInterval>;
  mode: WatchMode;
}

/** Manages background periodic frame capture workers. */
export class WatchWorkerManager {
  private watchers = new Map<string, WatchEntry>();

  /** Start a capture worker for the given source. */
  start(
    sourceName: string,
    mode: WatchMode,
    capture: CaptureFunction,
    onFrame: FrameCallback,
  ): void {
    if (this.watchers.has(sourceName)) {
      throw new Error(`Source "${sourceName}" is already watching`);
    }

    let intervalMs: number;

    switch (mode.mode) {
      case "stream":
        // Stream: continuous capture at fps rate (default 1fps)
        intervalMs = 1000 / (mode.fps ?? 1);
        break;
      case "event":
        // Event: low-frequency polling until sentinel triggers (default 0.5fps)
        intervalMs = 1000 / (mode.fps ?? 0.5);
        break;
      default:
        throw new Error(`Unknown watch mode: ${mode.mode}`);
    }

    const timer = setInterval(async () => {
      try {
        const frame = await capture();
        onFrame(frame);
      } catch {
        // Capture error logged but does not stop the watcher
      }
    }, intervalMs);

    this.watchers.set(sourceName, { timer, mode });
  }

  /** Stop the watcher for a specific source. Returns true if it existed. */
  stop(sourceName: string): boolean {
    const entry = this.watchers.get(sourceName);
    if (!entry) return false;
    clearInterval(entry.timer);
    this.watchers.delete(sourceName);
    return true;
  }

  /** Stop all active watchers. */
  stopAll(): void {
    for (const [name] of this.watchers) {
      this.stop(name);
    }
  }

  /** Check whether a source is currently being watched. */
  isWatching(sourceName: string): boolean {
    return this.watchers.has(sourceName);
  }
}
