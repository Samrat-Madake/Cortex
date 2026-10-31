import { describe, it, expect } from "vitest";
import {
  createDefaultSemanticContext,
  SemanticContextManager,
} from "../semantic-context.js";
import type { SemanticContextData, SemanticContextWriter } from "../semantic-context.js";

function createMemoryClient() {
  const store = new Map<string, Record<string, unknown>>();
  const client: SemanticContextWriter = {
    async upsertSemanticContext(request) {
      store.set(request.camera_id, { ...request });
      return {};
    },
    async getMemories(request) {
      const cameraId = String(request.camera_id ?? "");
      const item = store.get(cameraId);
      return item ? [{ metadata: item }] : [];
    },
  };
  return {
    client,
    seed(data: SemanticContextData) {
      store.set(data.cameraId, {
        camera_id: data.cameraId,
        scene_description: data.sceneDescription,
        known_entities: data.knownEntities,
        daily_routine: data.dailyRoutine,
        anomaly_baseline: data.anomalyBaseline,
        user_notes: data.userNotes,
        last_llm_update: data.metadata.last_llm_update,
        last_update_segment_count: data.metadata.last_update_segment_count,
        last_agent_consult: data.metadata.last_agent_consult,
        last_consult_segment_count: data.metadata.last_consult_segment_count,
        consecutive_no_updates: data.metadata.consecutive_no_updates,
      });
    },
    snapshot(cameraId: string) {
      return store.get(cameraId);
    },
  };
}

describe("SemanticContextManager integration", () => {
  it("full lifecycle: hydrate none -> buffer -> LLM update -> stabilize", async () => {
    const mem = createMemoryClient();
    const segmentCounts = new Map<string, number>();
    let llmCallCount = 0;

    const manager = new SemanticContextManager({
      memClient: mem.client,
      userId: "test",
      getSegmentCount: (cameraId) => segmentCounts.get(cameraId) ?? 0,
      onLlmUpdate: async () => {
        llmCallCount++;
        if (llmCallCount <= 2) {
          return {
            no_update: false,
            scene_description: "Front door with porch.",
            known_entities: "- White car: owner",
            daily_routine: "- 8am: leaves",
            anomaly_baseline: "- Quiet after 10pm",
          };
        }
        return { no_update: true };
      },
    });

    for (let i = 1; i <= 50; i++) {
      segmentCounts.set("cam_test", i);
      await manager.onSegmentProcessed("cam_test", `Scene observation ${i}`, []);
    }

    const stored = mem.snapshot("cam_test")!;
    expect(stored.scene_description).toContain("Front door");
    expect(stored.known_entities).toContain("White car");
    expect(Number(stored.consecutive_no_updates)).toBeGreaterThan(0);
    expect(llmCallCount).toBeGreaterThanOrEqual(2);
  });

  it("preserves semantic_context notes across LLM updates", async () => {
    const mem = createMemoryClient();
    const seed = createDefaultSemanticContext("cam_notes");
    seed.userNotes = "This is my front door. Two kids live here.";
    mem.seed(seed);

    const manager = new SemanticContextManager({
      memClient: mem.client,
      userId: "test",
      getSegmentCount: () => 20,
      onLlmUpdate: async () => ({
        no_update: false,
        scene_description: "Updated scene.",
      }),
    });

    await manager.onSegmentProcessed("cam_notes", "Observation", []);

    const stored = mem.snapshot("cam_notes")!;
    expect(stored.user_notes).toBe("This is my front door. Two kids live here.");
    expect(stored.scene_description).toBe("Updated scene.");
  });

  it("clearBuffer invalidates in-memory cache and rehydrates from Qdrant on next load", async () => {
    const mem = createMemoryClient();
    const seed = createDefaultSemanticContext("cam_clear");
    seed.sceneDescription = "Initial scene.";
    mem.seed(seed);

    const manager = new SemanticContextManager({
      memClient: mem.client,
      userId: "test",
      getSegmentCount: () => 0,
    });

    expect(await manager.load("cam_clear")).toContain("Initial scene.");

    seed.sceneDescription = "Rehydrated scene.";
    mem.seed(seed);
    manager.clearBuffer("cam_clear");

    expect(await manager.load("cam_clear")).toContain("Rehydrated scene.");
  });
});
