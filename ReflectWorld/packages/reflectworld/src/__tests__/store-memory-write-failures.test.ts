import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PipelineStore } from "../store.js";

describe("PipelineStore — memory write failures", () => {
  let store: PipelineStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "store-memory-failures-"));
    store = new PipelineStore(tmpDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records terminal memory write payloads for diagnosis", () => {
    const id = store.logMemoryWriteFailure({
      segment_id: "seg_dead",
      camera_id: "cam_a",
      user_id: "user_a",
      attempts: 2,
      error: "ReflectWorld POST /memories returned 500",
      request: {
        video_id: "seg_dead",
        camera_id: "cam_a",
        user_id: "user_a",
        video_data: { summary: "Person entered the room" },
      },
    });

    const rows = store.getRecentMemoryWriteFailures("cam_a");
    expect(id).toBeGreaterThan(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({
      segment_id: "seg_dead",
      camera_id: "cam_a",
      user_id: "user_a",
      attempts: 2,
      error: "ReflectWorld POST /memories returned 500",
    });
    expect(JSON.parse(rows[0]!.request_json)).toMatchObject({
      video_id: "seg_dead",
      video_data: { summary: "Person entered the room" },
    });
  });
});
