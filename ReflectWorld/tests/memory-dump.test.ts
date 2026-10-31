import { describe, expect, it } from "vitest";
import { countEpisodicMemories, countSemanticMemories, dumpMemories } from "../eval/benchmark/pipeline/memory-dump.js";

class FakeMemClient {
  async getMemories(request: { memory_type: string }): Promise<unknown[]> {
    return [{ id: `${request.memory_type}-1`, memory: request.memory_type }];
  }
}

describe("memory dump", () => {
  it("uses only explicit memory collection keys without legacy aliases", async () => {
    const dump = await dumpMemories(new FakeMemClient() as never, "camera-a", "user-a");

    expect(Object.keys(dump).sort()).toEqual([
      "episodic_entity",
      "episodic_schema",
      "episodic_trace",
      "procedural",
      "semantic_context",
      "semantic_entity",
    ]);
    expect("episodic" in dump).toBe(false);
    expect("semantic" in dump).toBe(false);
    expect(countEpisodicMemories(dump)).toBe(3);
    expect(countSemanticMemories(dump)).toBe(2);
  });
});
