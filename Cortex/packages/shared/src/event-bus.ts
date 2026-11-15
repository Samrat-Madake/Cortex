// Typed EventBus singleton for monitor events.
// All modules emit events here; WebSocket server subscribes and broadcasts.

import { EventEmitter } from "node:events";
import type { MonitorEvent, MonitorEventType } from "./events.js";

class MonitorEventBus extends EventEmitter {
  override emit(event: "monitor", payload: MonitorEvent): boolean {
    return super.emit("monitor", payload);
  }

  override on(event: "monitor", listener: (payload: MonitorEvent) => void): this {
    return super.on("monitor", listener);
  }

  /** Convenience method: build and emit a MonitorEvent. */
  publish(type: MonitorEventType, data: Record<string, unknown>, cameraId?: string): void {
    this.emit("monitor", {
      type,
      timestamp: Date.now(),
      camera_id: cameraId,
      data,
    });
  }
}

/** Singleton — shared across all modules in the same process. */
export const monitorBus = new MonitorEventBus();
