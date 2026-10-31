import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NarrativeMemory } from "../narrative-memory.js";
import type { EpisodicSchemaWriter } from "../narrative-memory.js";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { EventCloseSummary } from "../types.js";

const TEST_DIR = join(tmpdir(), "narrative-memory-test-" + Date.now());

/** Stub memClient that records addEpisodicSchema calls for assertions. */
function createStubMemClient(): EpisodicSchemaWriter & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async addEpisodicSchema(request) {
      calls.push(request);
      return { ok: true };
    },
  };
}

function makeSummary(id: number, overrides: Partial<EventCloseSummary> = {}): EventCloseSummary {
  return {
    event_id: `evt_cam1_${id}`,
    event_summary: `The presenter (entity_id=person_${id}) explains topic ${id}.`,
    compressed_context: `legacy summary ${id}`,
    entities: [],
    segment_count: 2,
    segment_ids: [`seg_${id}_1`, `seg_${id}_2`],
    time_range: { start_ms: id * 1000, end_ms: id * 1000 + 500 },
    ...overrides,
  };
}

describe("NarrativeMemory", () => {
  let nm: NarrativeMemory;
  let memClient: EpisodicSchemaWriter & { calls: unknown[] };
  let llmCalls: string[];

  beforeEach(() => {
    llmCalls = [];
    memClient = createStubMemClient();
    mkdirSync(TEST_DIR, { recursive: true });
    nm = new NarrativeMemory({
      baseDir: TEST_DIR,
      eventsPerChapter: 20,
      memClient,
      userId: "test-user",
      schemaEventBudget: 100,
      llm: async (prompt) => {
        llmCalls.push(prompt);
        return "Schema summary line";
      },
    });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("ignores legacy compressed chunks", async () => {
    nm.onContextCompressed("cam1", "chunk1");
    await nm.flush("cam1");
    expect(llmCalls).toHaveLength(0);
    expect(nm.getNarrative("cam1")).toBe("");
  });

  it("does not create local narrative markdown for closed events", async () => {
    nm.onEventClosed("cam1", makeSummary(1));
    await nm.flush("cam1");

    expect(existsSync(join(TEST_DIR, "cam1", "chapters", "chapter-0001.md"))).toBe(false);
    expect(existsSync(join(TEST_DIR, "cam1", "events.jsonl"))).toBe(false);
    expect(existsSync(join(TEST_DIR, "cam1", "current.md"))).toBe(false);
    expect(existsSync(join(TEST_DIR, "cam1", "index.md"))).toBe(false);
    expect(nm.getNarrative("cam1")).toBe("");
    expect(nm.getIndex("cam1")).toBe("");
    expect(nm.getArchive("cam1")).toBe("");
    expect(llmCalls).toHaveLength(0);
    expect(memClient.calls).toHaveLength(0);
  });

  it("finalize writes episodic schema only and skips chapter summary", async () => {
    nm.onEventClosed("cam1", makeSummary(6));
    await nm.flush("cam1", { finalize: true });
    await nm.flush("cam1", { finalize: true });

    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]).toContain("chapter-level navigation index");
    expect(llmCalls[0]).toContain("detailed evidence remains in the segment/event records");
    expect(llmCalls[0]).not.toContain("navigation line");
    expect(memClient.calls).toHaveLength(1);
    expect((memClient.calls[0] as any).event_ids).toEqual(["evt_cam1_6"]);
    expect(nm.getIndex("cam1")).toBe("");
  });

  it("uses compressed_context as schema fallback when event_summary is absent", async () => {
    const oneShotMemClient = createStubMemClient();
    const nmOneShot = new NarrativeMemory({
      baseDir: TEST_DIR,
      eventsPerChapter: 20,
      memClient: oneShotMemClient,
      userId: "test-user",
      schemaEventBudget: 1,
      llm: async (prompt) => {
        llmCalls.push(prompt);
        return "Schema summary.";
      },
    });

    nmOneShot.onEventClosed("cam1", makeSummary(2, { event_summary: undefined, compressed_context: "Fallback event text." }));
    await nmOneShot.flush("cam1");

    expect(llmCalls[0]).toContain("Fallback event text.");
    expect(oneShotMemClient.calls).toHaveLength(1);
  });

  it("rounds schema memory time ranges to integers before writing to mem", async () => {
    const nmSmall = new NarrativeMemory({
      baseDir: TEST_DIR,
      eventsPerChapter: 20,
      memClient,
      userId: "test-user",
      schemaEventBudget: 2,
      llm: async () => "Schema summary.",
    });
    nmSmall.onEventClosed("cam_schema_float", makeSummary(1, {
      time_range: { start_ms: 128544.00000000001, end_ms: 129999.6 },
    }));
    nmSmall.onEventClosed("cam_schema_float", makeSummary(2, {
      time_range: { start_ms: 130000.2, end_ms: 131111.9 },
    }));
    await nmSmall.flush("cam_schema_float");

    expect(memClient.calls).toHaveLength(1);
    expect((memClient.calls[0] as any).time_range).toEqual({ start_ms: 128544, end_ms: 131112 });
  });

  it("preserves pending schema events when schema LLM fails", async () => {
    let fail = true;
    const retryMemClient = createStubMemClient();
    const nmRetry = new NarrativeMemory({
      baseDir: TEST_DIR,
      eventsPerChapter: 20,
      memClient: retryMemClient,
      userId: "test-user",
      schemaEventBudget: 1,
      llm: async (prompt) => {
        llmCalls.push(prompt);
        if (fail) throw new Error("OpenAI API 400 content_filter");
        return "Recovered schema summary.";
      },
    });

    nmRetry.onEventClosed("cam_retry", makeSummary(1));
    await nmRetry.flush("cam_retry");
    expect(retryMemClient.calls).toHaveLength(0);

    fail = false;
    await nmRetry.flush("cam_retry", { finalize: true });
    expect(retryMemClient.calls).toHaveLength(1);
    expect(llmCalls).toHaveLength(2);
  });

  it("clear drops pending schema state", async () => {
    nm.onEventClosed("cam1", makeSummary(4));
    nm.clear("cam1");
    await nm.flush("cam1", { finalize: true });

    expect(memClient.calls).toHaveLength(0);
    expect(nm.getNarrative("cam1")).toBe("");
  });
});
