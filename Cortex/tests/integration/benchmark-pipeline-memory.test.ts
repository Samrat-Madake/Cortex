import { describe, expect, it, vi } from "vitest";
import type { PipelineDeps } from "@cortex/percept";
import { wireBenchmarkReidMemory } from "../../eval/benchmark/pipeline/pipeline-memory.js";
import { createMemoryStorePerception } from "../../packages/cortex/src/memory-adapter.js";

function makeDeps(): PipelineDeps {
  return { memory: {} } as PipelineDeps;
}

describe("wireBenchmarkReidMemory", () => {
  it("does not wire ReID memory when disabled", () => {
    const deps = makeDeps();
    wireBenchmarkReidMemory({
      pipelineDeps: deps,
      memClient: {
        reidSearch: vi.fn(),
        reidUpsert: vi.fn(),
      },
      userId: "video-a",
      enabled: false,
    });

    expect(deps.memory?.reidSearch).toBeUndefined();
    expect(deps.memory?.reidUpsert).toBeUndefined();
  });

  it("wires ReID search with benchmark user scope and history", async () => {
    const deps = makeDeps();
    const memClient = {
      reidSearch: vi.fn().mockResolvedValue({
        collection: "reid_face",
        results: [{
          entity_id: "entity_1",
          score: 0.91,
          semantic_memories: ["usually sits at the table"],
          episodic_memories: ["picked up a banana"],
        }],
      }),
      reidUpsert: vi.fn(),
    };

    wireBenchmarkReidMemory({
      pipelineDeps: deps,
      memClient,
      userId: "4VniCsSusJs_2min",
      enabled: true,
    });

    const results = await deps.memory!.reidSearch!([0.1, 0.2], "face");

    expect(memClient.reidSearch).toHaveBeenCalledWith({
      vector: [0.1, 0.2],
      collection: "reid_face",
      limit: 5,
      threshold: 0.5,
      user_id: "4VniCsSusJs_2min",
      include_history: true,
    });
    expect(results).toEqual([{
      entity_id: "entity_1",
      score: 0.91,
      type: "face",
      semantic_memories: ["usually sits at the table"],
      episodic_memories: ["picked up a banana"],
    }]);
  });

  it("wires ReID upsert for face and body collections with one entity id", async () => {
    const deps = makeDeps();
    const memClient = {
      reidSearch: vi.fn(),
      reidUpsert: vi.fn().mockResolvedValue({
        id: "point_1",
        entity_id: "entity_fixed",
        collection: "reid_face",
        event: "INSERT",
      }),
      reidGalleryUpdate: vi.fn(),
    };

    wireBenchmarkReidMemory({
      pipelineDeps: deps,
      memClient,
      userId: "4VniCsSusJs_2min",
      enabled: true,
    });

    const result = await deps.memory!.reidUpsert!({
      face: { vector: [0.1], quality: 0.9, yaw: 12, pitch: 4 },
      body: { vector: [0.2], quality: 0.7 },
    });

    expect(result.entity_id).toMatch(/^entity_[a-f0-9]{12}$/);
    expect(memClient.reidUpsert).toHaveBeenCalledTimes(2);
    const entityId = result.entity_id;
    expect(memClient.reidUpsert).toHaveBeenNthCalledWith(1, {
      entity_id: entityId,
      vector: [0.1],
      collection: "reid_face",
      quality: 0.9,
      yaw: 12,
      pitch: 4,
      user_id: "4VniCsSusJs_2min",
    });
    expect(memClient.reidUpsert).toHaveBeenNthCalledWith(2, {
      entity_id: entityId,
      vector: [0.2],
      collection: "reid_entity",
      quality: 0.7,
      user_id: "4VniCsSusJs_2min",
    });
  });

  it("builds storePerception requests with production memory semantics", async () => {
    const add = vi.fn().mockResolvedValue({
      results: [{ id: "mem_1", memory: "summary", event: "ADD", memory_type: "episodic" }],
    });
    const onStored = vi.fn();
    const storePerception = createMemoryStorePerception({
      memClient: { add },
      userId: "4VniCsSusJs_2min",
      onStored,
    });

    await storePerception({
      segment_id: "seg_001",
      camera_id: "bench_video",
      mode: "stream",
      event_id: "event_1",
      transcript: "hello",
      media_urls: {
        gif: "/tmp/seg.gif",
        keyframes: ["/tmp/keyframe.jpg"],
      },
      perception_memory: {
        summary: "A person enters.",
        detailed_summary: "A person in dark clothing enters the room.",
        security_risk: false,
        is_static_scene: false,
        perception_level: 1,
        entities: [{
          type: "person",
          entity_id: "entity_1",
          appearance: "dark clothing",
          behavior: "enters",
          interaction: "none",
        }],
      },
    } as any, {
      segment_id: "seg_001",
      camera_id: "bench_video",
      mode: "stream",
      timestamp: 123,
      duration_sec: 5,
      frames: [],
    } as any);

    expect(add).toHaveBeenCalledWith(expect.objectContaining({
      video_data: expect.objectContaining({
        summary: "A person enters.",
        detailed_summary: "A person in dark clothing enters the room.",
        security_risk: false,
        main_targets: [{
          entity_id: "entity_1",
          class_name: "person",
          appearance: "dark clothing",
          behavior: "enters",
          interaction: "none",
        }],
        media_assets: {
          gif: "/tmp/seg.gif",
          keyframes: ["/tmp/keyframe.jpg"],
        },
        media_urls: ["/tmp/seg.gif", "/tmp/keyframe.jpg"],
        transcript: "hello",
      }),
      entity_data: [{
        entity_id: "entity_1",
        class_name: "person",
        appearance: "dark clothing",
        behavior: "enters",
        interaction: "none",
      }],
      camera_id: "bench_video",
      user_id: "4VniCsSusJs_2min",
      mode: "stream",
      event_id: "event_1",
      video_id: "seg_001",
      metadata: expect.objectContaining({
        segment_id: "seg_001",
        media_start_ms: 123,
        media_duration_ms: 5000,
        media_assets: {
          gif: "/tmp/seg.gif",
          keyframes: ["/tmp/keyframe.jpg"],
        },
        media_urls: ["/tmp/seg.gif", "/tmp/keyframe.jpg"],
      }),
      infer: true,
    }));
    expect(onStored).toHaveBeenCalledTimes(1);
  });
});
