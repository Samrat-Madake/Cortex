import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PipelineStore } from "../store.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("PipelineStore.getSegmentCount", () => {
  let tempDir: string;
  let store: PipelineStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "store-test-"));
    store = new PipelineStore(tempDir);
  });

  afterEach(async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns 0 for unknown camera", () => {
    expect(store.getSegmentCount("nonexistent")).toBe(0);
  });

  it("counts segments for a specific camera", () => {
    for (let i = 0; i < 5; i++) {
      store.logResult(
        {
          segment_id: `seg_${i}`,
          camera_id: "cam_a",
          mode: "stream",
          frames: [],
          raw_url: "",
          timestamp: Date.now(),
          duration_sec: 10,
        } as any,
        {
          segment_id: `seg_${i}`,
          camera_id: "cam_a",
          mode: "stream",
          event_id: "evt_1",
          perception_memory: {
            summary: "test",
            detailed_summary: "",
            security_risk: false,
            timestamp: Date.now(),
            entities: [],
            perception_level: 0,
            strategy_context: "stream/level0",
            is_static_scene: false,
          },
          media_urls: {},
        } as any,
      );
    }
    // Different camera
    store.logResult(
      {
        segment_id: "seg_other",
        camera_id: "cam_b",
        mode: "stream",
        frames: [],
        raw_url: "",
        timestamp: Date.now(),
        duration_sec: 10,
      } as any,
      {
        segment_id: "seg_other",
        camera_id: "cam_b",
        mode: "stream",
        event_id: "evt_2",
        perception_memory: {
          summary: "test",
          detailed_summary: "",
          security_risk: false,
          timestamp: Date.now(),
          entities: [],
          perception_level: 0,
          strategy_context: "stream/level0",
          is_static_scene: false,
        },
        media_urls: {},
      } as any,
    );

    expect(store.getSegmentCount("cam_a")).toBe(5);
    expect(store.getSegmentCount("cam_b")).toBe(1);
  });

  it("clears subject counters with camera data", () => {
    let session = store.createSubjectIndexSession("user-a", "cam-a");
    const first = session.resolve({ category: "person", timestamp: 1_000 });
    session.commit();
    expect(first.subject_index).toBe(1);

    session = store.createSubjectIndexSession("user-a", "cam-a");
    const second = session.resolve({ category: "person", timestamp: 2_000 });
    session.commit();
    expect(second.subject_index).toBe(2);

    store.clearCamera("cam-a");

    session = store.createSubjectIndexSession("user-a", "cam-a");
    const afterClear = session.resolve({ category: "person", timestamp: 3_000 });
    session.commit();
    expect(afterClear.subject_index).toBe(1);
  });
});
