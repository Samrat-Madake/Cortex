import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { rehydrateMemoriesFromDump } from "../eval/benchmark/pipeline/memory-rehydrate.js";

class FakeMemClient {
  added: unknown[] = [];
  schemas: unknown[] = [];
  contexts: unknown[] = [];

  async getMemories(): Promise<[]> {
    return [];
  }

  async add(request: unknown): Promise<void> {
    this.added.push(request);
  }

  async addEpisodicSchema(request: unknown): Promise<void> {
    this.schemas.push(request);
  }

  async upsertSemanticContext(request: unknown): Promise<void> {
    this.contexts.push(request);
  }
}

describe("memory rehydrate", () => {
  it("preserves trace entity ids and entity video ids from dumps", async () => {
    const dir = mkdtempSync(join(tmpdir(), `memory-rehydrate-${process.pid}-`));
    const dumpPath = join(dir, "memory_dump.json");
    writeFileSync(dumpPath, JSON.stringify({
      episodic_trace: [{
        id: "trace-1",
        memory: "segment summary",
        metadata: {
          segment_id: "seg-trace",
          entity_ids: ["entity-a", "entity-b"],
          media_urls: ["/tmp/keyframe.jpg"],
        },
      }],
      episodic_entity: [{
        id: "episodic-entity-1",
        memory: "entity observation",
        entity_id: "entity-a",
        entity_class: "person",
        video_ids: ["seg-entity-a"],
        metadata: {
          video_ids: ["seg-entity-b", "seg-entity-a"],
          media_start_ms: 1000,
        },
      }],
      episodic_schema: [],
      semantic_entity: [{
        id: "semantic-1",
        memory: "entity preference",
        metadata: {
          entity_id: "entity-a",
          video_ids: ["seg-sem-b"],
          importance: 0.8,
        },
        video_ids: ["seg-sem-a", "seg-sem-b"],
      }],
      semantic_context: [],
      procedural: [],
    }), "utf-8");

    const client = new FakeMemClient();

    const result = await rehydrateMemoriesFromDump(client as never, "camera-a", "user-a", dumpPath);

    expect(result).toEqual(expect.objectContaining({
      skipped: false,
      failed: 0,
      restored: expect.objectContaining({
        episodic_trace: 1,
        episodic_entity: 1,
        semantic_entity: 1,
      }),
    }));
    expect(client.added).toHaveLength(3);

    expect(client.added[0]).toEqual(expect.objectContaining({
      video_id: "seg-trace",
      metadata: expect.objectContaining({
        entity_ids: ["entity-a", "entity-b"],
      }),
    }));
    expect(client.added[1]).toEqual(expect.objectContaining({
      video_id: "seg-entity-a",
      metadata: expect.objectContaining({
        video_ids: ["seg-entity-a", "seg-entity-b"],
      }),
    }));
    expect(client.added[2]).toEqual(expect.objectContaining({
      video_id: "seg-sem-a",
      metadata: expect.objectContaining({
        video_ids: ["seg-sem-a", "seg-sem-b"],
      }),
      entity_data: [expect.objectContaining({
        entity_id: "entity-a",
        video_ids: ["seg-sem-a", "seg-sem-b"],
      })],
    }));
  });
});
