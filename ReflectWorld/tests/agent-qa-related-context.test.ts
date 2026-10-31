import { describe, expect, it } from "vitest";
import { buildRelatedTraceContext } from "../eval/benchmark/pipeline/agent-qa-related-context.js";

describe("Agent-QA related trace context", () => {
  it("expands episodic_schema hits to bounded episodic_trace evidence by event id", () => {
    const expanded = buildRelatedTraceContext(
      [{
        id: "schema1",
        memory: "Chapter about a rocket launch.",
        metadata: {
          event_ids: ["evt1", "evt2"],
          time_range_start_ms: 1000,
          time_range_end_ms: 9000,
        },
      }],
      [
        {
          id: "trace1",
          memory: "summary: Rocket lifts off.\ntranscript: A rocket is launched.",
          video_id: "seg_001",
          metadata: { event_id: "evt1", media_start_ms: 1000 },
        },
        {
          id: "trace2",
          memory: "summary: Control room reacts.",
          video_id: "seg_002",
          metadata: { event_id: "evt2", media_start_ms: 6000 },
        },
      ],
      5,
    );

    expect(expanded).toMatchObject([
      {
        source: "schema_event_id",
        primary_memory_id: "schema1",
        segment_id: "seg_001",
        timestamp_sec: 1,
        memory_type: "episodic_trace",
        summary: "Rocket lifts off.",
        transcript: "A rocket is launched.",
      },
      {
        source: "schema_event_id",
        primary_memory_id: "schema1",
        segment_id: "seg_002",
        timestamp_sec: 6,
        memory_type: "episodic_trace",
      },
    ]);
  });

  it("falls back to schema time range when event ids are unavailable", () => {
    const expanded = buildRelatedTraceContext(
      [{
        id: "schema1",
        memory: "Chapter with a visible sign.",
        metadata: {
          time_range_start_ms: 1000,
          time_range_end_ms: 3000,
        },
      }],
      [
        { id: "before", memory: "Before", video_id: "seg_000", metadata: { media_start_ms: 0 } },
        { id: "inside", memory: "summary: Sign appears.", video_id: "seg_001", metadata: { media_start_ms: 2000 } },
        { id: "after", memory: "After", video_id: "seg_002", metadata: { media_start_ms: 4000 } },
      ],
      5,
    );

    expect(expanded).toHaveLength(1);
    expect(expanded[0]).toMatchObject({
      source: "schema_time_range",
      segment_id: "seg_001",
      summary: "Sign appears.",
    });
  });

  it("keeps expansion bounded", () => {
    const traces = Array.from({ length: 10 }, (_, index) => ({
      id: `trace${index}`,
      memory: `summary: Trace ${index}`,
      video_id: `seg_${index}`,
      metadata: { event_id: `evt${index}`, media_start_ms: index * 1000 },
    }));
    const expanded = buildRelatedTraceContext(
      [{
        id: "schema1",
        memory: "Long chapter.",
        metadata: {
          event_ids: traces.map(trace => trace.metadata.event_id),
          time_range_start_ms: 0,
          time_range_end_ms: 9000,
        },
      }],
      traces,
      3,
    );

    expect(expanded).toHaveLength(3);
    expect(expanded.map(item => item.segment_id)).toEqual(["seg_0", "seg_4", "seg_9"]);
  });

  it("expands episodic_trace hits to adjacent trace context", () => {
    const traces = [
      { id: "trace0", memory: "summary: Before launch.", video_id: "seg_000", memory_type: "episodic_trace", metadata: { media_start_ms: 0, memory_type: "episodic_trace" } },
      { id: "trace1", memory: "summary: Rocket lifts off.", video_id: "seg_001", memory_type: "episodic_trace", metadata: { media_start_ms: 1000, memory_type: "episodic_trace" } },
      { id: "trace2", memory: "summary: Narrator explains the rocket's function.", video_id: "seg_002", memory_type: "episodic_trace", metadata: { media_start_ms: 2000, memory_type: "episodic_trace" } },
      { id: "trace3", memory: "summary: Later scene.", video_id: "seg_003", memory_type: "episodic_trace", metadata: { media_start_ms: 3000, memory_type: "episodic_trace" } },
    ];

    const expanded = buildRelatedTraceContext([traces[1]], traces, 3);

    expect(expanded).toHaveLength(2);
    expect(expanded).toMatchObject([
      {
        source: "trace_time_neighbor",
        primary_memory_id: "trace1",
        primary_memory_type: "episodic_trace",
        segment_id: "seg_000",
      },
      {
        source: "trace_time_neighbor",
        primary_memory_id: "trace1",
        primary_memory_type: "episodic_trace",
        segment_id: "seg_002",
        summary: "Narrator explains the rocket's function.",
      },
    ]);
  });

  it("expands entity-level hits to trace evidence by video_ids provenance", () => {
    const expanded = buildRelatedTraceContext(
      [{
        id: "entity1",
        memory: "A chef handles a red bowl.",
        memory_type: "episodic_entity",
        metadata: {
          entity_id: "entity-chef",
          video_ids: ["seg_010", "seg_011"],
          memory_type: "episodic_entity",
        },
      }],
      [
        { id: "trace9", memory: "summary: Before cooking.", video_id: "seg_009", metadata: { media_start_ms: 9000, memory_type: "episodic_trace" } },
        { id: "trace10", memory: "summary: Chef picks up a red bowl.", video_id: "seg_010", metadata: { media_start_ms: 10000, memory_type: "episodic_trace" } },
        { id: "trace11", memory: "summary: Chef pours ingredients.", video_id: "seg_011", metadata: { media_start_ms: 11000, memory_type: "episodic_trace" } },
      ],
      5,
    );

    expect(expanded).toMatchObject([
      {
        source: "entity_video_id",
        primary_memory_id: "entity1",
        primary_memory_type: "episodic_entity",
        segment_id: "seg_010",
        summary: "Chef picks up a red bowl.",
      },
      {
        source: "entity_video_id",
        primary_memory_id: "entity1",
        primary_memory_type: "episodic_entity",
        segment_id: "seg_011",
        summary: "Chef pours ingredients.",
      },
    ]);
  });
});
