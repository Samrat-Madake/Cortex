import { describe, expect, it } from "vitest";
import type { Segment } from "@cortex/shared";
import { PerceptionRuntime } from "../runtime/perception-runtime.js";

function makeSegment(cameraId: string, mode: Segment["mode"] = "stream"): Segment {
  return {
    segment_id: `${cameraId}-${mode}`,
    camera_id: cameraId,
    mode,
    timestamp: 0,
    duration_sec: 1,
    frames: [],
    raw_url: "",
  };
}

describe("PerceptionRuntime", () => {
  it("runs snapshot segments inline", async () => {
    const runtime = new PerceptionRuntime({
      processStreamSegment: async () => {
        throw new Error("stream path should not run");
      },
      analyzeSnapshot: async (segment) => ({
        segment_id: segment.segment_id,
        camera_id: segment.camera_id,
        timestamp: segment.timestamp,
        perception_memory: { summary: "snapshot", observations: [] },
        entities: [],
        notifications: [],
      } as any),
    });

    const result = await runtime.handleSegment(makeSegment("cam1", "snapshot"));
    expect(result?.perception_memory.summary).toBe("snapshot");
  });

  it("keeps per-camera FIFO while allowing source concurrency", async () => {
    const order: string[] = [];
    let releaseA!: () => void;
    const aStarted = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const runtime = new PerceptionRuntime({
      processStreamSegment: async (segment) => {
        order.push(`start:${segment.segment_id}`);
        if (segment.camera_id === "a" && segment.segment_id === "a-1") {
          await aStarted;
        }
        order.push(`end:${segment.segment_id}`);
      },
      analyzeSnapshot: async () => null,
    }, { sourceConcurrency: 2 });

    runtime.handleSegment({ ...makeSegment("a"), segment_id: "a-1" });
    runtime.handleSegment({ ...makeSegment("a"), segment_id: "a-2" });
    runtime.handleSegment({ ...makeSegment("b"), segment_id: "b-1" });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toContain("start:a-1");
    expect(order).toContain("start:b-1");
    expect(order).not.toContain("start:a-2");

    releaseA();
    await runtime.waitForIdle();
    expect(order.indexOf("end:a-1")).toBeLessThan(order.indexOf("start:a-2"));
  });

  it("reports backlog and drains observers in waitForIdle", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let observerDrained = false;

    const runtime = new PerceptionRuntime({
      processStreamSegment: async () => { await blocked; },
      analyzeSnapshot: async () => null,
      waitForObservers: async () => { observerDrained = true; },
    }, { sourceConcurrency: 1 });

    runtime.handleSegment(makeSegment("cam1"));
    runtime.handleSegment(makeSegment("cam1"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.getBacklog("cam1").total).toBe(1);

    release();
    await runtime.waitForIdle();
    expect(runtime.getBacklog().total).toBe(0);
    expect(observerDrained).toBe(true);
  });

  it("supports benchmark-style double buffering for stream segments", async () => {
    const order: string[] = [];
    const starts: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const runtime = new PerceptionRuntime({
      processStreamSegment: async (segment) => {
        order.push(`start:${segment.segment_id}`);
        if (segment.segment_id === "seg1") await firstBlocked;
        order.push(`end:${segment.segment_id}`);
      },
      analyzeSnapshot: async () => null,
      onStart: (segment) => {
        starts.push(segment.segment_id);
      },
    }, { streamDispatchMode: "double_buffer" });

    const firstReturn = runtime.handleSegment({ ...makeSegment("cam1"), segment_id: "seg1" });
    await firstReturn;
    expect(order).toEqual(["start:seg1"]);

    let secondReturned = false;
    const secondReturn = Promise.resolve(runtime.handleSegment({ ...makeSegment("cam1"), segment_id: "seg2" }))
      .then(() => { secondReturned = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondReturned).toBe(false);
    expect(order).not.toContain("start:seg2");
    expect(starts).toEqual(["seg1"]);
    expect(runtime.getBacklog("cam1").total).toBe(1);

    releaseFirst();
    await secondReturn;
    await runtime.waitForIdle();
    expect(order).toEqual(["start:seg1", "end:seg1", "start:seg2", "end:seg2"]);
    expect(starts).toEqual(["seg1", "seg2"]);
  });

  it("drains double-buffer segments that are chained while waiting for a previous segment", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondBlocked = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    const runtime = new PerceptionRuntime({
      processStreamSegment: async (segment) => {
        order.push(`start:${segment.segment_id}`);
        if (segment.segment_id === "seg1") await firstBlocked;
        if (segment.segment_id === "seg2") await secondBlocked;
        order.push(`end:${segment.segment_id}`);
      },
      analyzeSnapshot: async () => null,
    }, { streamDispatchMode: "double_buffer" });

    await runtime.handleSegment({ ...makeSegment("cam1"), segment_id: "seg1" });
    const secondReturn = Promise.resolve(runtime.handleSegment({ ...makeSegment("cam1"), segment_id: "seg2" }));
    let idleResolved = false;
    const idle = runtime.waitForIdle().then(() => { idleResolved = true; });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["start:seg1"]);

    releaseFirst();
    await secondReturn;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["start:seg1", "end:seg1", "start:seg2"]);
    expect(idleResolved).toBe(false);

    releaseSecond();
    await idle;
    expect(order).toEqual(["start:seg1", "end:seg1", "start:seg2", "end:seg2"]);
  });

  it("shares the execution gate across local-file double buffer and live scheduler paths", async () => {
    const order: string[] = [];
    let releaseLocal!: () => void;
    const localBlocked = new Promise<void>((resolve) => {
      releaseLocal = resolve;
    });

    const runtime = new PerceptionRuntime({
      processStreamSegment: async (segment) => {
        order.push(`start:${segment.segment_id}`);
        if (segment.segment_id === "local") await localBlocked;
        order.push(`end:${segment.segment_id}`);
      },
      analyzeSnapshot: async () => null,
    }, { sourceConcurrency: 1, streamDispatchMode: "by_input_mode" });

    await runtime.handleSegment({ ...makeSegment("cam-local"), segment_id: "local", _input_mode: "local_file" });
    runtime.handleSegment({ ...makeSegment("cam-live"), segment_id: "live", _input_mode: "live_stream" });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["start:local"]);

    releaseLocal();
    await runtime.waitForIdle();
    expect(order).toEqual(["start:local", "end:local", "start:live", "end:live"]);
  });

  it("treats live-stream input mode as scheduler work under by-input-mode dispatch", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rejected: string[] = [];
    const runtime = new PerceptionRuntime({
      processStreamSegment: async (segment) => {
        if (segment.segment_id === "live-1") await blocked;
      },
      analyzeSnapshot: async () => null,
      onReject: (_cameraId, segment) => {
        rejected.push(segment.segment_id);
      },
    }, { streamDispatchMode: "by_input_mode", maxQueuedPerCamera: 1 });

    runtime.handleSegment({ ...makeSegment("cam-live"), segment_id: "live-1", _input_mode: "live_stream" });
    runtime.handleSegment({ ...makeSegment("cam-live"), segment_id: "live-2", _input_mode: "live_stream" });
    expect(runtime.canAcceptSegment({ ...makeSegment("cam-live"), segment_id: "live-3", _input_mode: "live_stream" })).toBe(false);
    runtime.handleSegment({ ...makeSegment("cam-live"), segment_id: "live-3", _input_mode: "live_stream" });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.getBacklog("cam-live").queued).toBe(1);
    expect(rejected).toEqual(["live-3"]);

    release();
    await runtime.waitForIdle();
  });

  it("skips stale queued live segments when backlog exceeds the configured media lag", async () => {
    const order: string[] = [];
    const skipped: Array<{ id: string; lagMs: number; thresholdMs: number; latest: string }> = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const runtime = new PerceptionRuntime({
      processStreamSegment: async (segment) => {
        order.push(`start:${segment.segment_id}`);
        if (segment.segment_id === "seg1") await firstBlocked;
        order.push(`end:${segment.segment_id}`);
      },
      analyzeSnapshot: async () => null,
      onSkip: (_cameraId, segment, info) => {
        skipped.push({
          id: segment.segment_id,
          lagMs: info.lagMs,
          thresholdMs: info.thresholdMs,
          latest: info.latestSegmentId,
        });
      },
    }, {
      sourceConcurrency: 1,
      maxQueuedPerCamera: 10,
      streamDispatchMode: "by_input_mode",
      liveBacklogSkipAfterMs: 180_000,
    });

    runtime.handleSegment({ ...makeSegment("cam1"), segment_id: "seg1", timestamp: 0, _input_mode: "live_stream" });
    runtime.handleSegment({ ...makeSegment("cam1"), segment_id: "seg2", timestamp: 10_000, duration_sec: 1, _input_mode: "live_stream" });
    runtime.handleSegment({ ...makeSegment("cam1"), segment_id: "seg3", timestamp: 60_000, duration_sec: 1, _input_mode: "live_stream" });
    runtime.handleSegment({ ...makeSegment("cam1"), segment_id: "seg4", timestamp: 200_000, duration_sec: 1, _input_mode: "live_stream" });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["start:seg1"]);
    expect(skipped).toEqual([{ id: "seg2", lagMs: 189_000, thresholdMs: 180_000, latest: "seg4" }]);
    expect(runtime.getBacklog("cam1").queued).toBe(2);

    releaseFirst();
    await runtime.waitForIdle();
    expect(order).toEqual(["start:seg1", "end:seg1", "start:seg3", "end:seg3", "start:seg4", "end:seg4"]);
  });

  it("surfaces double-buffer fatal errors", async () => {
    const err = new Error("fatal analyze");
    const errors: string[] = [];
    const runtime = new PerceptionRuntime({
      processStreamSegment: async () => { throw err; },
      analyzeSnapshot: async () => null,
      onError: (caught) => { errors.push(caught instanceof Error ? caught.message : String(caught)); },
    }, { streamDispatchMode: "double_buffer" });

    await expect(runtime.handleSegment(makeSegment("cam1"))).resolves.toBeNull();
    await expect(runtime.waitForIdle()).rejects.toThrow("fatal analyze");
    expect(errors).toEqual(["fatal analyze"]);
  });

  it("keeps double-buffer fatal errors visible until drain even when another segment arrives", async () => {
    const runtime = new PerceptionRuntime({
      processStreamSegment: async (segment) => {
        if (segment.segment_id === "seg1") throw new Error("fatal analyze");
      },
      analyzeSnapshot: async () => null,
    }, { streamDispatchMode: "double_buffer" });

    await expect(runtime.handleSegment({ ...makeSegment("cam1"), segment_id: "seg1" })).resolves.toBeNull();
    await expect(runtime.handleSegment({ ...makeSegment("cam1"), segment_id: "seg2" })).resolves.toBeNull();
    await expect(runtime.waitForIdle()).rejects.toThrow("fatal analyze");
  });

  it("scopes double-buffer fatal errors to the camera being drained", async () => {
    const runtime = new PerceptionRuntime({
      processStreamSegment: async (segment) => {
        if (segment.camera_id === "cam1") throw new Error("cam1 fatal");
      },
      analyzeSnapshot: async () => null,
    }, { streamDispatchMode: "double_buffer" });

    await expect(runtime.handleSegment({ ...makeSegment("cam1"), segment_id: "seg1" })).resolves.toBeNull();
    await expect(runtime.handleSegment({ ...makeSegment("cam2"), segment_id: "seg2" })).resolves.toBeNull();

    await expect(runtime.waitForCameraIdle("cam2")).resolves.toBeUndefined();
    await expect(runtime.waitForCameraIdle("cam1")).rejects.toThrow("cam1 fatal");
  });

  it("releases source FIFO at criticalReady but drains final completion", async () => {
    const order: string[] = [];
    const releaseCritical = new Map<string, () => void>();
    const releaseCompleted = new Map<string, () => void>();
    const makeTask = (id: string) => {
      const criticalReady = new Promise<void>((resolve) => releaseCritical.set(id, resolve));
      const completed = new Promise<void>((resolve) => releaseCompleted.set(id, resolve));
      return { criticalReady, completed };
    };

    const runtime = new PerceptionRuntime({
      processStreamSegment: (segment) => {
        order.push(`start:${segment.segment_id}`);
        return makeTask(segment.segment_id);
      },
      analyzeSnapshot: async () => null,
    }, { streamDispatchMode: "double_buffer", sourceOrderBarrier: "critical_ready", maxInFlightPerCamera: 2 });

    await runtime.handleSegment({ ...makeSegment("cam1"), segment_id: "seg1" });
    let secondReturned = false;
    const secondReturn = Promise.resolve(runtime.handleSegment({ ...makeSegment("cam1"), segment_id: "seg2" }))
      .then(() => { secondReturned = true; });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["start:seg1"]);
    expect(secondReturned).toBe(false);

    releaseCritical.get("seg1")?.();
    await secondReturn;
    expect(order).toEqual(["start:seg1", "start:seg2"]);
    expect(runtime.getBacklog("cam1").pending).toBeGreaterThan(0);

    releaseCritical.get("seg2")?.();
    releaseCompleted.get("seg1")?.();
    releaseCompleted.get("seg2")?.();
    await runtime.waitForIdle();
    expect(runtime.getBacklog("cam1").total).toBe(0);
  });

  it("owns the critical-ready ordering for live scheduler segments", async () => {
    const order: string[] = [];
    const releaseCritical = new Map<string, () => void>();
    const releaseCompleted = new Map<string, () => void>();
    const makeTask = (id: string) => ({
      criticalReady: new Promise<void>((resolve) => releaseCritical.set(id, resolve)),
      completed: new Promise<void>((resolve) => releaseCompleted.set(id, resolve)),
    });

    const runtime = new PerceptionRuntime({
      processStreamSegment: (segment) => {
        order.push(`start:${segment.segment_id}`);
        return makeTask(segment.segment_id);
      },
      analyzeSnapshot: async () => null,
    }, { sourceOrderBarrier: "critical_ready", maxInFlightPerCamera: 2 });

    runtime.handleSegment({ ...makeSegment("cam1"), segment_id: "seg1" });
    runtime.handleSegment({ ...makeSegment("cam1"), segment_id: "seg2" });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["start:seg1"]);

    releaseCritical.get("seg1")?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["start:seg1", "start:seg2"]);
    expect(runtime.getBacklog("cam1").pending).toBeGreaterThan(0);

    releaseCritical.get("seg2")?.();
    releaseCompleted.get("seg1")?.();
    releaseCompleted.get("seg2")?.();
    await runtime.waitForIdle();
    expect(runtime.getBacklog("cam1").total).toBe(0);
  });

  it("caps live-latency in-flight final tasks per camera", async () => {
    const order: string[] = [];
    const releaseCritical = new Map<string, () => void>();
    const releaseCompleted = new Map<string, () => void>();
    const makeTask = (id: string) => ({
      criticalReady: new Promise<void>((resolve) => releaseCritical.set(id, resolve)),
      completed: new Promise<void>((resolve) => releaseCompleted.set(id, resolve)),
    });

    const runtime = new PerceptionRuntime({
      processStreamSegment: (segment) => {
        order.push(`start:${segment.segment_id}`);
        return makeTask(segment.segment_id);
      },
      analyzeSnapshot: async () => null,
    }, { streamDispatchMode: "double_buffer", sourceOrderBarrier: "critical_ready", maxInFlightPerCamera: 2 });

    const firstReturn = Promise.resolve(runtime.handleSegment({ ...makeSegment("cam1"), segment_id: "seg1" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseCritical.get("seg1")?.();
    await firstReturn;
    const secondReturn = Promise.resolve(runtime.handleSegment({ ...makeSegment("cam1"), segment_id: "seg2" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseCritical.get("seg2")?.();
    await secondReturn;

    await Promise.resolve(runtime.handleSegment({ ...makeSegment("cam1"), segment_id: "seg3" }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["start:seg1", "start:seg2"]);

    releaseCompleted.get("seg1")?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["start:seg1", "start:seg2", "start:seg3"]);

    releaseCritical.get("seg3")?.();
    releaseCompleted.get("seg2")?.();
    releaseCompleted.get("seg3")?.();
    await runtime.waitForIdle();
  });
});
