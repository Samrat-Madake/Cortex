import { describe, expect, it } from "vitest";
import { parseSimpleReasoning } from "../eval/benchmark/pipeline/agent-qa.js";

describe("parseSimpleReasoning (simple QA mode)", () => {
  it("parses a bare search decision with memory type and query", () => {
    const r = parseSimpleReasoning(
      '{"decision":"search","memory_type":"episodic_trace","search_query":"red car parked outside"}',
    );
    expect(r.decision).toBe("search");
    expect(r.memory_type).toBe("episodic_trace");
    expect(r.search_query).toBe("red car parked outside");
    expect(r.segment_id).toBeUndefined();
  });

  it("extracts JSON embedded in markdown fences / prose", () => {
    const r = parseSimpleReasoning('Here is my decision:\n```json\n{"decision":"answer"}\n```');
    expect(r.decision).toBe("answer");
  });

  it("lowercases the decision and reads segment_id for view_visual", () => {
    const r = parseSimpleReasoning('{"decision":"VIEW_VISUAL","segment_id":"seg_42"}');
    expect(r.decision).toBe("view_visual");
    expect(r.segment_id).toBe("seg_42");
  });

  it("falls back to answer on non-JSON output", () => {
    const r = parseSimpleReasoning("I will now answer the question directly.");
    expect(r.decision).toBe("answer");
  });

  it("defaults the decision to answer when the field is missing", () => {
    const r = parseSimpleReasoning('{"memory_type":"episodic_trace"}');
    expect(r.decision).toBe("answer");
  });

  it("ignores non-string memory_type / search_query / segment_id", () => {
    const r = parseSimpleReasoning('{"decision":"search","memory_type":5,"search_query":null}');
    expect(r.decision).toBe("search");
    expect(r.memory_type).toBeUndefined();
    expect(r.search_query).toBeUndefined();
  });

  it("parses a timeline whole-span read (memory_type + sort_order, case-insensitive)", () => {
    const r = parseSimpleReasoning('{"decision":"timeline","memory_type":"episodic_trace","sort_order":"ASC"}');
    expect(r.decision).toBe("timeline");
    expect(r.memory_type).toBe("episodic_trace");
    expect(r.sort_order).toBe("asc");
  });

  it("parses a timeline neighbour read (around_segment_id)", () => {
    const r = parseSimpleReasoning('{"decision":"timeline","around_segment_id":"seg_9"}');
    expect(r.decision).toBe("timeline");
    expect(r.around_segment_id).toBe("seg_9");
  });
});
