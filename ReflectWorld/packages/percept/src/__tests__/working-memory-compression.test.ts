import { describe, it, expect, vi, afterEach } from "vitest";
import { WorkingMemoryManager } from "../working-memory.js";

describe("WorkingMemory VLM summary context", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("switchEvent returns new event_id and clears prior context from new event", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const wm = new WorkingMemoryManager();
    const eid1 = wm.onSegmentArrived("cam1", "stream");
    wm.updateEventSummary("cam1", "Prior event summary");
    wm.appendSceneContext("cam1", "summary 1");

    vi.advanceTimersByTime(100);
    const eid2 = wm.switchEvent("cam1", "stream");
    expect(eid2).not.toBe(eid1);
    expect(wm.getCurrentEventSummary("cam1")).toBe("");
    expect(wm.getSceneContext("cam1")).toBe("");
  });

  it("switchEvent resets segment_count so the next segment gets count 2", () => {
    const wm = new WorkingMemoryManager();
    wm.onSegmentArrived("cam1", "stream");
    wm.onSegmentArrived("cam1", "stream");
    wm.onSegmentArrived("cam1", "stream");

    wm.switchEvent("cam1", "stream");

    wm.onSegmentArrived("cam1", "stream");
    const state = wm.getState("cam1");
    expect(state.segment_count).toBe(2);
  });

  it("keeps only the latest three segment summaries", () => {
    const wm = new WorkingMemoryManager();
    wm.onSegmentArrived("cam1", "stream");

    for (let i = 0; i < 10; i++) {
      wm.appendSceneContext("cam1", `summary line ${i}`);
    }

    expect(wm.getRecentSegmentSummaries("cam1")).toEqual([
      "summary line 7",
      "summary line 8",
      "summary line 9",
    ]);
    expect(wm.getSceneContext("cam1")).toContain("summary line 9");
    expect(wm.getSceneContext("cam1")).not.toContain("summary line 0");
  });
});
