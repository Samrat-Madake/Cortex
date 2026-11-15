import { describe, it, expect } from "vitest";
import type { SegmentTrace, PipelineTrace, Segment, PerceptionResult } from "../types.js";

describe("SegmentTrace", () => {
  it("accepts valid timing metadata", () => {
    const trace: SegmentTrace = {
      first_frame_at: 1700000000000,
      segment_built_at: 1700000001000,
    };
    expect(trace.segment_built_at - trace.first_frame_at).toBe(1000);
  });
});

describe("PipelineTrace", () => {
  it("accepts a full trace with all fields", () => {
    const trace: PipelineTrace = {
      segment_id: "seg_001",
      camera_id: "cam_front",
      timestamps: {
        first_frame_at: 1000,
        segment_built_at: 2000,
        analysis_started_at: 2100,
        stt_completed_at: 2200,
        detection_completed_at: 2300,
        tracking_completed_at: 2400,
        reid_completed_at: 2500,
        vlm_completed_at: 2800,
        analysis_completed_at: 3000,
        memory_stored_at: 3100,
        notification_sent_at: 3200,
      },
      latencies: {
        accumulation_ms: 1000,
        dispatch_ms: 100,
        stt_ms: 50,
        detection_ms: 100,
        tracking_ms: 100,
        reid_ms: 100,
        vlm_ms: 300,
        perception_ms: 900,
        memory_blocking_ms: 100,
        memory_ms: 100,
        e2e_ms: 2000,
      },
      context: {
        mode: "event",
        level: 2,
        frame_count: 5,
        vlm_model: "gemini-2.5-flash",
        analyzers_run: ["detection", "tracking", "reid", "vlm"],
      },
    };

    expect(trace.segment_id).toBe("seg_001");
    expect(trace.context.analyzers_run).toHaveLength(4);
    expect(trace.latencies.e2e_ms).toBe(2000);
  });

  it("accepts a minimal trace with optional fields omitted", () => {
    const trace: PipelineTrace = {
      segment_id: "seg_002",
      camera_id: "cam_back",
      timestamps: {
        first_frame_at: 5000,
        segment_built_at: 5000,
        analysis_started_at: 5100,
        analysis_completed_at: 5600,
      },
      latencies: {
        accumulation_ms: 0,
        dispatch_ms: 100,
        perception_ms: 500,
        e2e_ms: 600,
      },
      context: {
        mode: "snapshot",
        level: 0,
        frame_count: 1,
        analyzers_run: ["vlm"],
      },
    };

    expect(trace.latencies.vlm_ms).toBeUndefined();
    expect(trace.timestamps.detection_completed_at).toBeUndefined();
  });
});

describe("Segment._trace", () => {
  it("allows _trace on Segment interface", () => {
    const seg: Segment = {
      segment_id: "seg_003",
      camera_id: "cam_test",
      mode: "snapshot",
      frames: [{ data: "base64", timestamp: 1000, index: 0 }],
      raw_url: "",
      timestamp: 1000,
      duration_sec: 0,
      _trace: { first_frame_at: 1000, segment_built_at: 1010 },
    };
    expect(seg._trace?.first_frame_at).toBe(1000);
  });
});

describe("PerceptionResult._trace", () => {
  it("allows _trace on PerceptionResult interface", () => {
    const result: PerceptionResult = {
      segment_id: "seg_004",
      camera_id: "cam_test",
      mode: "snapshot",
      event_id: "evt_001",
      perception_memory: {
        summary: "test",
        detailed_summary: "",
        security_risk: false,
        timestamp: Date.now(),
        perception_level: 0,
      },
      media_urls: { raw: "", keyframes: [], crops: [] },
      _trace: {
        segment_id: "seg_004",
        camera_id: "cam_test",
        timestamps: {
          first_frame_at: 1000,
          segment_built_at: 1000,
          analysis_started_at: 1100,
          analysis_completed_at: 1600,
        },
        latencies: {
          accumulation_ms: 0,
          dispatch_ms: 100,
          perception_ms: 500,
          e2e_ms: 600,
        },
        context: {
          mode: "snapshot",
          level: 0,
          frame_count: 1,
          analyzers_run: ["vlm"],
        },
      },
    };
    expect(result._trace?.latencies.perception_ms).toBe(500);
  });
});
