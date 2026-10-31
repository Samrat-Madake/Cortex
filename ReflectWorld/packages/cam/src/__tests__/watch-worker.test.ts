import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WatchWorkerManager } from "../watch-worker.js";

describe("WatchWorkerManager", () => {
  let manager: WatchWorkerManager;
  const mockCapture = vi.fn().mockResolvedValue({ data: "base64", timestamp: 1, source_name: "cam1" });

  beforeEach(() => {
    vi.useFakeTimers();
    mockCapture.mockClear();
    manager = new WatchWorkerManager();
  });

  afterEach(() => {
    manager.stopAll();
    vi.useRealTimers();
  });

  it("starts stream capture", () => {
    manager.start("cam1", { mode: "stream", fps: 1 }, mockCapture, vi.fn());
    expect(manager.isWatching("cam1")).toBe(true);
  });

  it("stops capture", () => {
    manager.start("cam1", { mode: "stream", fps: 1 }, mockCapture, vi.fn());
    manager.stop("cam1");
    expect(manager.isWatching("cam1")).toBe(false);
  });

  it("calls capture at fps rate", async () => {
    manager.start("cam1", { mode: "stream", fps: 2 }, mockCapture, vi.fn());
    // fps=2 → interval=500ms
    await vi.advanceTimersByTimeAsync(500);
    expect(mockCapture).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(mockCapture).toHaveBeenCalledTimes(2);
  });

  it("prevents duplicate watch on same source", () => {
    manager.start("cam1", { mode: "stream", fps: 1 }, mockCapture, vi.fn());
    expect(() => manager.start("cam1", { mode: "stream", fps: 2 }, mockCapture, vi.fn())).toThrow("already watching");
  });

  it("event mode starts with default interval", () => {
    manager.start("cam1", { mode: "event", fps: 1 }, mockCapture, vi.fn());
    expect(manager.isWatching("cam1")).toBe(true);
  });
});
