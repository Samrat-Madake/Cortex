import { describe, it, expect } from "vitest";
import {
  createDefaultSemanticContext,
  sanitizeCameraId,
  SemanticContextManager,
  serializeSemanticContext,
  buildSummarizationPrompt,
} from "../semantic-context.js";
import type { SemanticContextData, SemanticContextWriter } from "../semantic-context.js";

function createMemoryClient() {
  const store = new Map<string, Record<string, unknown>>();
  const calls: Array<Record<string, unknown>> = [];
  let failWrites = false;
  let failReads = false;
  const client: SemanticContextWriter = {
    async upsertSemanticContext(request) {
      calls.push(request);
      if (failWrites) throw new Error("upsert failed");
      store.set(request.camera_id, { ...request });
      return {};
    },
    async getMemories(request) {
      if (failReads) throw new Error("get failed");
      const cameraId = String(request.camera_id ?? "");
      const item = store.get(cameraId);
      return item ? [{ metadata: item }] : [];
    },
  };
  return {
    client,
    calls,
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
    setFailWrites(value: boolean) {
      failWrites = value;
    },
    setFailReads(value: boolean) {
      failReads = value;
    },
  };
}

describe("serializeSemanticContext", () => {
  it("formats semantic context as sectioned prompt text", () => {
    const data = createDefaultSemanticContext("front_door");
    data.userNotes = "Owner is John.";
    data.sceneDescription = "Porch camera.";
    data.knownEntities = "- White car";
    data.metadata.last_update_segment_count = 45;

    const text = serializeSemanticContext(data);
    expect(text).toContain("# Semantic Context: front_door");
    expect(text).toContain("## User Notes\nOwner is John.");
    expect(text).toContain("## Scene Description\nPorch camera.");
    expect(text).toContain("last_update_segment_count: 45");
  });

  it("truncates system sections to 500 chars", () => {
    const data = createDefaultSemanticContext("test");
    data.sceneDescription = "A".repeat(300);
    data.knownEntities = "B".repeat(300);

    const text = serializeSemanticContext(data);
    const scene = text.match(/## Scene Description\n([\s\S]*?)\n\n## Known Entities/)?.[1] ?? "";
    const known = text.match(/## Known Entities\n([\s\S]*?)\n\n## Daily Routine/)?.[1] ?? "";
    expect([scene, known].filter(Boolean).join("\n").length).toBeLessThanOrEqual(500);
  });
});

describe("sanitizeCameraId", () => {
  it("replaces unsafe characters", () => {
    expect(sanitizeCameraId("front/door cam")).toBe("front_door_cam");
    expect(sanitizeCameraId("cam-01_test")).toBe("cam-01_test");
  });
});

describe("buildSummarizationPrompt", () => {
  it("includes current profile and observations", () => {
    const prompt = buildSummarizationPrompt(
      "## Scene Description\nFront door camera.",
      ["Person arrived at door.", "Package delivered."],
    );
    expect(prompt).toContain("CURRENT SEMANTIC_CONTEXT");
    expect(prompt).toContain("Front door camera");
    expect(prompt).toContain("Person arrived at door");
    expect(prompt).toContain("Package delivered");
    expect(prompt).toContain("no_update");
  });

  it("instructs the summarizer to preserve named identity anchors", () => {
    const prompt = buildSummarizationPrompt(
      "## Known Entities\n",
      ["Lily talks near the yoga mat. [named identity: name=Lily; entity_id=entity_lily; appearance=pink top; cue=addressed as Lily]"],
    );

    expect(prompt).toContain("named person with entity_id evidence");
    expect(prompt).toContain("unresolved_identity");
    expect(prompt).toContain("candidate_entity_ids");
    expect(prompt).toContain("Do not invent names");
  });

  it("keeps scene description useful but identity-neutral", () => {
    const prompt = buildSummarizationPrompt(
      "## Scene Description\n",
      [
        "Split-screen interview with two speakers and a host.",
        "Camera cuts between close-ups and a wide conference stage with audience.",
      ],
    );

    expect(prompt).toContain("stable source format");
    expect(prompt).toContain("recurring view/editing style");
    expect(prompt).toContain("identity-neutral");
    expect(prompt).toContain("do not put person names");
    expect(prompt).toContain("not as evidence for target matching");
  });
});

describe("SemanticContextManager trigger logic", () => {
  it("buffers observations without writing below bootstrap threshold", async () => {
    const mem = createMemoryClient();
    const manager = new SemanticContextManager({
      memClient: mem.client,
      userId: "test",
      getSegmentCount: () => 5,
    });

    await manager.onSegmentProcessed("cam_a", "Person walked to door.", []);
    expect(mem.calls).toHaveLength(0);
    expect(await manager.load("cam_a")).toBeUndefined();
  });

  it("hydrates from Qdrant and injects semantic context prompt text", async () => {
    const mem = createMemoryClient();
    const seed = createDefaultSemanticContext("cam_a");
    seed.sceneDescription = "Front door with porch.";
    mem.seed(seed);

    const manager = new SemanticContextManager({
      memClient: mem.client,
      userId: "test",
      getSegmentCount: () => 0,
    });

    const text = await manager.load("cam_a");
    expect(text).toContain("Front door with porch.");
  });

  it("triggers LLM update at bootstrap threshold and writes semantic_context", async () => {
    const mem = createMemoryClient();
    let llmCalled = false;
    const manager = new SemanticContextManager({
      memClient: mem.client,
      userId: "test",
      getSegmentCount: () => 16,
      onLlmUpdate: async () => {
        llmCalled = true;
        return {
          no_update: false,
          scene_description: "Updated front door.",
        };
      },
    });

    await manager.onSegmentProcessed("cam_a", "Observation", []);
    expect(llmCalled).toBe(true);
    expect(mem.snapshot("cam_a")?.scene_description).toBe("Updated front door.");
    expect(mem.snapshot("cam_a")?.last_update_segment_count).toBe(16);
  });

  it("deterministically writes named person entity anchors into known_entities", async () => {
    const mem = createMemoryClient();
    const manager = new SemanticContextManager({
      memClient: mem.client,
      userId: "test",
      getSegmentCount: () => 16,
      onLlmUpdate: async (_cameraId, _profile, observations) => {
        expect(observations.join("\n")).toContain("name=Lily");
        expect(observations.join("\n")).toContain("entity_id=entity_lily");
        return {
          no_update: true,
        };
      },
    });

    await manager.onSegmentProcessed(
      "cam_identity",
      "A woman is addressed as Lily while sitting on a yoga mat.",
      [{ entity_id: "entity_lily", track_id: "D0", type: "person", appearance: "woman in a light pink sweatshirt on a yoga mat" }],
      [{ name: "Lily", entity_id: "entity_lily", track_id: "D0", evidence: "addressed as Lily", source: "target_identity" }],
    );

    const known = String(mem.snapshot("cam_identity")?.known_entities ?? "");
    expect(known).toContain("- Lily:");
    expect(known).toContain("entity_id=entity_lily");
    expect(known).toContain("light pink sweatshirt");
    expect(known).toContain("cue=addressed as Lily");
    expect(mem.snapshot("cam_identity")?.consecutive_no_updates).toBe(0);
  });

  it("named identity cues trigger semantic_context update before the bootstrap threshold", async () => {
    const mem = createMemoryClient();
    let llmCalled = false;
    const manager = new SemanticContextManager({
      memClient: mem.client,
      userId: "test",
      getSegmentCount: () => 3,
      onLlmUpdate: async (_cameraId, _profile, observations) => {
        llmCalled = true;
        expect(observations.join("\n")).toContain("name=Jack");
        expect(observations.join("\n")).toContain("entity_id=entity_jack");
        return { no_update: true };
      },
    });

    await manager.onSegmentProcessed(
      "cam_identity_early",
      "A person is named Jack.",
      [{ entity_id: "entity_jack", track_id: "D0", type: "person", appearance: "man in black shirt" }],
      [{ name: "Jack", entity_id: "entity_jack", track_id: "D0", evidence: "called Jack", source: "target_identity" }],
    );

    expect(llmCalled).toBe(true);
    expect(mem.snapshot("cam_identity_early")?.known_entities).toContain("entity_id=entity_jack");
  });

  it("writes track-only named identity cues as unresolved text evidence", async () => {
    const mem = createMemoryClient();
    let llmCalled = false;
    const manager = new SemanticContextManager({
      memClient: mem.client,
      userId: "test",
      getSegmentCount: () => 3,
      onLlmUpdate: async (_cameraId, _profile, observations) => {
        llmCalled = true;
        expect(observations.join("\n")).toContain("name=Jack");
        expect(observations.join("\n")).toContain("segment_id=seg_jack");
        return { no_update: true };
      },
    });

    await manager.onSegmentProcessed(
      "cam_identity_track_only",
      "A person is addressed as Jack.",
      [{ track_id: "D22", type: "person", appearance: "person on couch" }],
      [{ name: "Jack", segment_id: "seg_jack", track_id: "D22", evidence: "called Jack", source: "target_identity" }],
    );

    const known = String(mem.snapshot("cam_identity_track_only")?.known_entities ?? "");
    expect(llmCalled).toBe(true);
    expect(known).toContain("- Jack:");
    expect(known).toContain("unresolved_identity");
    expect(known).toContain("person on couch");
    expect(known).toContain("cue=called Jack");
    expect(known).toContain("segment_ids=seg_jack");
    expect(known).not.toContain("local_track_ids");
  });

  it("keeps unresolved segment ids before long evidence can be truncated", async () => {
    const mem = createMemoryClient();
    const manager = new SemanticContextManager({
      memClient: mem.client,
      userId: "test",
      getSegmentCount: () => 3,
      onLlmUpdate: async () => ({ no_update: true }),
    });

    await manager.onSegmentProcessed(
      "cam_identity_long_cue",
      "A person is addressed as Jack.",
      [{ track_id: "D22", type: "person", appearance: "adult reclining on couch in dark clothing with pillow nearby" }],
      [{
        name: "Jack",
        segment_id: "seg_jack_long",
        track_id: "D22",
        evidence: "Dialogue address wake up Jack directed at the person lying on the sofa while a standing woman gestures toward the couch; the addressee appears asleep and then shifts posture.",
        source: "target_identity",
      }],
    );

    const known = String(mem.snapshot("cam_identity_long_cue")?.known_entities ?? "");
    expect(known).toContain("segment_ids=seg_jack_long");
  });

  it("keeps multiple entity ids for the same name as candidates", async () => {
    const mem = createMemoryClient();
    const seed = createDefaultSemanticContext("cam_identity_conflict");
    seed.knownEntities = "- Lily: entity_id=entity_old; blue top";
    mem.seed(seed);
    const manager = new SemanticContextManager({
      memClient: mem.client,
      userId: "test",
      getSegmentCount: () => 20,
      onLlmUpdate: async () => ({
        no_update: false,
        known_entities: "- Lily: entity_id=entity_old; blue top",
      }),
    });

    await manager.onSegmentProcessed(
      "cam_identity_conflict",
      "Another target is called Lily.",
      [{ entity_id: "entity_new", track_id: "D1", type: "person", appearance: "woman in gray leggings" }],
      [{ name: "Lily", entity_id: "entity_new", track_id: "D1", evidence: "called Lily", source: "target_identity" }],
    );

    const known = String(mem.snapshot("cam_identity_conflict")?.known_entities ?? "");
    expect(known).toContain("- Lily:");
    expect(known).toContain("candidate_entity_ids=");
    expect(known).toContain("entity_old");
    expect(known).toContain("entity_new");
    expect(known).toContain("woman in gray leggings");
  });

  it("merges unresolved same-name evidence into existing entity-backed identity", async () => {
    const mem = createMemoryClient();
    const seed = createDefaultSemanticContext("cam_identity_unresolved_merge");
    seed.knownEntities = "- Lily (entity_lily): entity_id=entity_lily; woman in pink hoodie";
    mem.seed(seed);
    const manager = new SemanticContextManager({
      memClient: mem.client,
      userId: "test",
      getSegmentCount: () => 20,
      onLlmUpdate: async () => ({
        no_update: false,
        known_entities: "- Lily (entity_lily): entity_id=entity_lily; woman in pink hoodie",
      }),
    });

    await manager.onSegmentProcessed(
      "cam_identity_unresolved_merge",
      "Someone mentions Lily while a woman in a dark coat is visible.",
      [{ track_id: "D4", type: "person", appearance: "woman in dark coat" }],
      [{ name: "Lily", segment_id: "seg_lily_late", track_id: "D4", evidence: "called Lily near doorway", source: "target_identity" }],
    );

    const known = String(mem.snapshot("cam_identity_unresolved_merge")?.known_entities ?? "");
    expect((known.match(/^- Lily:/gm) ?? [])).toHaveLength(1);
    expect(known).toContain("entity_id=entity_lily");
    expect(known).toContain("woman in pink hoodie");
    expect(known).not.toContain("unresolved_identity");
  });

  it("does not parse segment ids as candidate entity ids from existing known_entities", async () => {
    const mem = createMemoryClient();
    const seed = createDefaultSemanticContext("cam_identity_segment_candidate");
    seed.knownEntities = "- Jack: unresolved_identity; candidate_entity_ids=[seg_jack_old, entity_jack]; adult male in black shirt";
    mem.seed(seed);
    const manager = new SemanticContextManager({
      memClient: mem.client,
      userId: "test",
      getSegmentCount: () => 20,
      onLlmUpdate: async () => ({
        no_update: false,
        known_entities: "- Jack: unresolved_identity; candidate_entity_ids=[seg_jack_old, entity_jack]; adult male in black shirt",
      }),
    });

    await manager.onSegmentProcessed(
      "cam_identity_segment_candidate",
      "Someone refers to Jack again.",
      [{ track_id: "D0", type: "person", appearance: "adult male seated left in a black shirt" }],
      [{ name: "Jack", segment_id: "seg_jack_new", track_id: "D0", evidence: "called Jack", source: "target_identity" }],
    );

    const known = String(mem.snapshot("cam_identity_segment_candidate")?.known_entities ?? "");
    expect(known).toContain("- Jack:");
    expect(known).toContain("entity_id=entity_jack");
    expect(known).toContain("adult male in black shirt");
    expect(known).not.toContain("candidate_entity_ids=[seg_jack_old");
    expect(known).not.toContain("unresolved_identity");
  });

  it("preserves anchored identity lines when LLM known_entities omits them", async () => {
    const mem = createMemoryClient();
    const seed = createDefaultSemanticContext("cam_identity_preserve");
    seed.knownEntities = "- Jack: unresolved_identity; segment_ids=seg_jack_old; adult male in black shirt\n- Lily: entity_id=entity_lily; woman in pink hoodie";
    mem.seed(seed);
    const manager = new SemanticContextManager({
      memClient: mem.client,
      userId: "test",
      getSegmentCount: () => 20,
      onLlmUpdate: async () => ({
        no_update: false,
        known_entities: "- Lily: entity_id=entity_lily; woman in pink hoodie\n- Robert: entity_id=entity_robert; man in black shirt",
      }),
    });

    await manager.onSegmentProcessed(
      "cam_identity_preserve",
      "A diner is thanked as Robert.",
      [{ entity_id: "entity_robert", track_id: "D17", type: "person", appearance: "man in black shirt" }],
      [{ name: "Robert", entity_id: "entity_robert", track_id: "D17", evidence: "thanked as Robert", source: "target_identity" }],
    );

    const known = String(mem.snapshot("cam_identity_preserve")?.known_entities ?? "");
    expect(known).toContain("Jack:");
    expect(known).toContain("segment_ids=seg_jack_old");
    expect(known).toContain("Lily:");
    expect(known).toContain("Robert:");
  });

  it("skips LLM update when Qdrant hydration fails before cache is warm", async () => {
    const mem = createMemoryClient();
    mem.setFailReads(true);
    let llmCalled = false;
    const manager = new SemanticContextManager({
      memClient: mem.client,
      userId: "test",
      getSegmentCount: () => 16,
      onLlmUpdate: async () => {
        llmCalled = true;
        return {
          no_update: false,
          scene_description: "Should not overwrite.",
        };
      },
    });

    await manager.onSegmentProcessed("cam_read_fail", "Observation", []);

    expect(llmCalled).toBe(false);
    expect(mem.calls).toHaveLength(0);
    expect(mem.snapshot("cam_read_fail")).toBeUndefined();

    mem.setFailReads(false);
    await manager.onSegmentProcessed("cam_read_fail", "Recovery observation", []);
    expect(llmCalled).toBe(true);
    expect(mem.snapshot("cam_read_fail")?.scene_description).toBe("Should not overwrite.");
  });

  it("does not trigger agent consultation below 100 segments", async () => {
    const mem = createMemoryClient();
    const seed = createDefaultSemanticContext("cam_a");
    mem.seed(seed);
    let agentCalled = false;
    const manager = new SemanticContextManager({
      memClient: mem.client,
      userId: "test",
      getSegmentCount: () => 50,
      onAgentConsult: async () => {
        agentCalled = true;
      },
    });

    await manager.onSegmentProcessed("cam_a", "Test", []);
    expect(agentCalled).toBe(false);
  });

  it("triggers agent consultation at 100 segments since last consult", async () => {
    const mem = createMemoryClient();
    const seed = createDefaultSemanticContext("cam_a");
    mem.seed(seed);
    let agentCalled = false;
    const manager = new SemanticContextManager({
      memClient: mem.client,
      userId: "test",
      getSegmentCount: () => 101,
      onAgentConsult: async () => {
        agentCalled = true;
      },
    });

    await manager.onSegmentProcessed("cam_a", "Test", []);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(agentCalled).toBe(true);
    expect(mem.snapshot("cam_a")?.last_consult_segment_count).toBe(101);
  });

  it("initProfile and setUserNotes write through Qdrant and update cache", async () => {
    const mem = createMemoryClient();
    const manager = new SemanticContextManager({
      memClient: mem.client,
      userId: "test",
      getSegmentCount: () => 0,
    });

    await manager.initProfile("cam_rt", "Backyard facing pool.");
    await manager.setUserNotes("cam_rt", "Kids swim after school.");

    expect(mem.snapshot("cam_rt")?.scene_description).toBe("Backyard facing pool.");
    expect(mem.snapshot("cam_rt")?.user_notes).toBe("Kids swim after school.");
    expect(await manager.load("cam_rt")).toContain("Kids swim after school.");
  });

  it("serializes concurrent semantic context writes for the same camera", async () => {
    const store = new Map<string, Record<string, unknown>>();
    const writes: Array<Record<string, unknown>> = [];
    let firstWrite = true;
    let markFirstStarted!: () => void;
    let unblockFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstCanFinish = new Promise<void>((resolve) => {
      unblockFirst = resolve;
    });
    const client: SemanticContextWriter = {
      async upsertSemanticContext(request) {
        writes.push(request);
        if (firstWrite) {
          firstWrite = false;
          markFirstStarted();
          await firstCanFinish;
        }
        store.set(request.camera_id, { ...request });
        return {};
      },
      async getMemories(request) {
        const item = store.get(String(request.camera_id ?? ""));
        return item ? [{ metadata: item }] : [];
      },
    };
    const manager = new SemanticContextManager({
      memClient: client,
      userId: "test",
      getSegmentCount: () => 0,
    });

    const first = manager.initProfile("cam_lock", "First scene.");
    await firstStarted;
    const second = manager.setUserNotes("cam_lock", "Second note.");
    await Promise.resolve();

    expect(writes).toHaveLength(1);
    unblockFirst();
    await Promise.all([first, second]);

    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({
      camera_id: "cam_lock",
      scene_description: "First scene.",
      user_notes: "",
    });
    expect(writes[1]).toMatchObject({
      camera_id: "cam_lock",
      scene_description: "First scene.",
      user_notes: "Second note.",
    });
    expect(store.get("cam_lock")?.scene_description).toBe("First scene.");
    expect(store.get("cam_lock")?.user_notes).toBe("Second note.");
  });

  it("allows LLM updates to clear unsupported optional fields", async () => {
    const mem = createMemoryClient();
    const seed = createDefaultSemanticContext("cam_clear_fields");
    seed.sceneDescription = "Old scene.";
    seed.dailyRoutine = "- 8am: stale routine";
    seed.anomalyBaseline = "- stale baseline";
    mem.seed(seed);

    const manager = new SemanticContextManager({
      memClient: mem.client,
      userId: "test",
      getSegmentCount: () => 20,
      onLlmUpdate: async () => ({
        no_update: false,
        scene_description: "General documentary montage.",
        daily_routine: "",
        anomaly_baseline: "",
      }),
    });

    await manager.onSegmentProcessed("cam_clear_fields", "Observation", []);

    expect(mem.snapshot("cam_clear_fields")?.scene_description).toBe("General documentary montage.");
    expect(mem.snapshot("cam_clear_fields")?.daily_routine).toBe("");
    expect(mem.snapshot("cam_clear_fields")?.anomaly_baseline).toBe("");
  });

  it("restores observations when Qdrant write fails and retries later", async () => {
    const mem = createMemoryClient();
    const seed = createDefaultSemanticContext("cam_wf");
    mem.seed(seed);
    let segCount = 0;
    let llmCallCount = 0;
    const llmCalls: string[][] = [];
    const manager = new SemanticContextManager({
      memClient: mem.client,
      userId: "test",
      getSegmentCount: () => segCount,
      onLlmUpdate: async (_cameraId, _profile, observations) => {
        llmCallCount++;
        llmCalls.push([...observations]);
        return { no_update: false, scene_description: `Update ${llmCallCount}` };
      },
    });

    for (let i = 1; i <= 15; i++) {
      segCount = i;
      await manager.onSegmentProcessed("cam_wf", `Obs ${i}`, []);
    }
    expect(mem.snapshot("cam_wf")?.scene_description).toBe("Update 1");

    mem.setFailWrites(true);
    segCount = 35;
    await manager.onSegmentProcessed("cam_wf", "Fail obs", []);
    expect(mem.snapshot("cam_wf")?.scene_description).toBe("Update 1");

    mem.setFailWrites(false);
    segCount = 55;
    await manager.onSegmentProcessed("cam_wf", "Recovery obs", []);
    const retryCall = llmCalls[llmCalls.length - 1]!;
    expect(retryCall.some((obs) => obs.includes("Fail obs"))).toBe(true);
    expect(retryCall.some((obs) => obs.includes("Recovery obs"))).toBe(true);
    expect(mem.snapshot("cam_wf")?.scene_description).toContain("Update");
    expect(mem.snapshot("cam_wf")?.scene_description).not.toBe("Update 1");
  });
});
