import { describe, expect, it } from "vitest";
import { PerCameraSegmentScheduler } from "../utils/per-camera-segment-scheduler.js";

interface Item {
  camera_id: string;
  seq: number;
  delayMs?: number;
}

describe("PerCameraSegmentScheduler", () => {
  it("preserves order within each camera while allowing camera-level concurrency", async () => {
    const processed: string[] = [];
    let active = 0;
    let maxActive = 0;

    const scheduler = new PerCameraSegmentScheduler<Item>({
      getCameraId: (item) => item.camera_id,
      maxConcurrentCameras: 2,
      handler: async (item) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, item.delayMs ?? 5));
        processed.push(`${item.camera_id}:${item.seq}`);
        active -= 1;
      },
    });

    scheduler.enqueue({ camera_id: "cam_a", seq: 1, delayMs: 20 });
    scheduler.enqueue({ camera_id: "cam_a", seq: 2, delayMs: 1 });
    scheduler.enqueue({ camera_id: "cam_b", seq: 1, delayMs: 10 });
    scheduler.enqueue({ camera_id: "cam_b", seq: 2, delayMs: 1 });

    await scheduler.waitForIdle();

    expect(processed.indexOf("cam_a:1")).toBeLessThan(processed.indexOf("cam_a:2"));
    expect(processed.indexOf("cam_b:1")).toBeLessThan(processed.indexOf("cam_b:2"));
    expect(maxActive).toBe(2);
  });

  it("rejects instead of dropping when a per-camera queue is full", async () => {
    let releaseFirst: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const rejected: string[] = [];

    const scheduler = new PerCameraSegmentScheduler<Item>({
      getCameraId: (item) => item.camera_id,
      maxConcurrentCameras: 1,
      maxQueuedPerCamera: 1,
      onReject: (cameraId, item) => rejected.push(`${cameraId}:${item.seq}`),
      handler: async (item) => {
        if (item.seq === 1) await firstBlocked;
      },
    });

    expect(scheduler.enqueue({ camera_id: "cam_a", seq: 1 })).toBe(true);
    expect(scheduler.enqueue({ camera_id: "cam_a", seq: 2 })).toBe(true);
    expect(scheduler.enqueue({ camera_id: "cam_a", seq: 3 })).toBe(false);

    releaseFirst!();
    await scheduler.waitForIdle();

    expect(rejected).toEqual(["cam_a:3"]);
  });
});
