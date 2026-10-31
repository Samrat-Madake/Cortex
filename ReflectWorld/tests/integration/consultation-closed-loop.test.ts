// E2E: Consultation chain — tests each link: VC trigger → context → tool dispatch → execution
//
// The full closed-loop (VC → Gemini SimAgent → MiniHost.callTool → monitor event)
// is only exercised by eval/video-runner/runner.ts with live services. This file tests
// the deterministic links in the chain to catch regressions without external deps.
import { describe, it, expect, vi } from "vitest";
import { VisionController } from "../../packages/reflectworld/src/vision-controller/index.js";
import type { VisionControllerConfig } from "../../packages/reflectworld/src/vision-controller/index.js";
import type { PerceptionResult, Segment, PerceptionMemory } from "@reflectworld/shared";
import type { ToolCall, ConsultationContext } from "../../eval/video-runner/sim-agent.js";
import type { ToolResult } from "../../eval/video-runner/tool-executor.js";

// ── Factories ──

function makeSegment(cameraId = "cam1"): Segment {
  return {
    segment_id: `seg_${Date.now()}`,
    camera_id: cameraId,
    mode: "stream",
    frames: [{ data: "base64", timestamp: Date.now(), index: 0 }],
    raw_url: "/tmp/raw.jpg",
    timestamp: Date.now(),
    duration_sec: 10,
    _motion_hint: {
      has_motion: true,
      ratio: 0.5,
      last_motion_at: Date.now(),
      last_still_at: 0,
    },
  };
}

function makeResult(overrides?: {
  camera_id?: string;
  entities?: PerceptionMemory["entities"];
  security_risk?: boolean;
  is_static_scene?: boolean;
  custom_fields?: Record<string, string | number | boolean>;
}): PerceptionResult {
  const cameraId = overrides?.camera_id ?? "cam1";
  return {
    segment_id: `seg_${Date.now()}`,
    camera_id: cameraId,
    mode: "stream",
    event_id: "evt_1",
    perception_memory: {
      summary: "Person detected at front door",
      detailed_summary: "A person in a dark hoodie approached the front door",
      security_risk: overrides?.security_risk ?? false,
      timestamp: Date.now(),
      entities: overrides?.entities ?? [{ type: "person" }],
      perception_level: 1,
      is_static_scene: overrides?.is_static_scene ?? false,
      custom_fields: overrides?.custom_fields,
    },
    media_urls: { raw: "/tmp/raw.jpg", keyframes: [], crops: [] },
  };
}

function makeConfig(overrides?: Partial<VisionControllerConfig>): VisionControllerConfig {
  return {
    enabled: true,
    baseline: { fps: 1 },
    rules: [],
    ...overrides,
  };
}

// ── Link 1: VisionController trigger → consultationContext ──

describe("consultation chain: VC trigger", () => {
  it("security_risk trigger produces consultationContext with camera_id + trigger_reason", () => {
    const vc = new VisionController(makeConfig({
      segment_policy: {
        consultation_triggers: [{ type: "security_risk" }],
        consultation_cooldown_seconds: 60,
      },
    }));

    const result = makeResult({ security_risk: true });
    const out = vc.evaluateSegment(result, makeSegment());

    expect(out.shouldConsultAgent).toBe(true);
    expect(out.consultationContext!.camera_id).toBe("cam1");
    expect(out.consultationContext!.trigger_reason).toEqual({ type: "security_risk" });
    expect(out.consultationContext!.signals).toBeDefined();
  });

  it("unknown_entity trigger fires when entity has is_new_entity=true", () => {
    const vc = new VisionController(makeConfig({
      segment_policy: {
        consultation_triggers: [{ type: "unknown_entity" }],
        consultation_cooldown_seconds: 60,
      },
    }));

    const result = makeResult({
      entities: [{ type: "person", entity_id: "entity_unknown_1", is_new_entity: true }],
    });
    const out = vc.evaluateSegment(result, makeSegment());

    expect(out.shouldConsultAgent).toBe(true);
    expect(out.consultationContext).toBeDefined();
  });

  it("cooldown prevents re-consultation within window", () => {
    const vc = new VisionController(makeConfig({
      segment_policy: {
        consultation_triggers: [{ type: "security_risk" }],
        consultation_cooldown_seconds: 60,
      },
    }));

    const result = makeResult({ security_risk: true });
    expect(vc.evaluateSegment(result, makeSegment()).shouldConsultAgent).toBe(true);
    expect(vc.evaluateSegment(result, makeSegment()).shouldConsultAgent).toBe(false);
  });
});

// ── Link 2: consultationContext → ConsultationContext (runner marshalling) ──

describe("consultation chain: context marshalling", () => {
  it("VC consultationContext maps to SimAgent ConsultationContext shape", () => {
    const vc = new VisionController(makeConfig({
      segment_policy: {
        consultation_triggers: [{ type: "security_risk" }],
        consultation_cooldown_seconds: 60,
      },
    }));

    const result = makeResult({ security_risk: true });
    const out = vc.evaluateSegment(result, makeSegment());
    const ctx = out.consultationContext!;

    // Build ConsultationContext as the E2E runner does
    const consultCtx: ConsultationContext = {
      camera_id: ctx.camera_id,
      signals: {
        detected_classes: [...ctx.signals.detected_classes],
        security_risk: ctx.signals.security_risk,
      },
      trigger_reason: ctx.trigger_reason,
      eventText: result.perception_memory.detailed_summary,
      current_baseline: { fps: 1 },
    };

    expect(consultCtx.camera_id).toBe("cam1");
    expect(consultCtx.trigger_reason).toEqual({ type: "security_risk" });
    expect(consultCtx.eventText).toContain("dark hoodie");
  });
});

// ── Link 3: ToolCall → tool-executor dispatch ──

describe("consultation chain: tool dispatch", () => {
  it("executeTool routes reflectworld_cam to MiniHost.callTool", async () => {
    // Import executeTool dynamically to verify the dispatch logic
    const { executeTool } = await import("../../eval/video-runner/tool-executor.js");

    const toolCall: ToolCall = {
      tool: "reflectworld_cam",
      params: { action: "set_sampling", name: "cam1", fps: 5 },
    };

    // Mock MiniHost with a callTool that records the invocation
    const callToolSpy = vi.fn().mockResolvedValue(JSON.stringify({ ok: true }));
    const mockHost = { callTool: callToolSpy } as any;

    const result: ToolResult = await executeTool(toolCall, mockHost);

    expect(result.success).toBe(true);
    expect(result.tool).toBe("reflectworld_cam");
    expect(result.action).toBe("set_sampling");
    expect(callToolSpy).toHaveBeenCalledWith("reflectworld_cam", toolCall.params);
  });

  it("executeTool routes reflectworld_perception to MiniHost.callTool", async () => {
    const { executeTool } = await import("../../eval/video-runner/tool-executor.js");

    const toolCall: ToolCall = {
      tool: "reflectworld_perception",
      params: {
        action: "configure",
        camera_id: "cam1",
        config: { security_rules: "Watch the door", vlm_model: "gemini-2.5-flash" },
      },
    };

    const callToolSpy = vi.fn().mockResolvedValue(JSON.stringify({ configured: true }));
    const mockHost = { callTool: callToolSpy } as any;

    const result: ToolResult = await executeTool(toolCall, mockHost);

    expect(result.success).toBe(true);
    expect(result.tool).toBe("reflectworld_perception");
    expect(callToolSpy).toHaveBeenCalledWith("reflectworld_perception", toolCall.params);
  });

  it("executeTool returns error for unknown tool", async () => {
    const { executeTool } = await import("../../eval/video-runner/tool-executor.js");

    const toolCall: ToolCall = {
      tool: "unknown_tool",
      params: { action: "test" },
    };
    const mockHost = { callTool: vi.fn() } as any;

    const result: ToolResult = await executeTool(toolCall, mockHost);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown tool");
  });

  it("executeTool captures MiniHost errors without throwing", async () => {
    const { executeTool } = await import("../../eval/video-runner/tool-executor.js");

    const toolCall: ToolCall = {
      tool: "reflectworld_cam",
      params: { action: "set_sampling", name: "cam1", fps: 5 },
    };

    const mockHost = {
      callTool: vi.fn().mockRejectedValue(new Error("Plugin not loaded")),
    } as any;

    const result: ToolResult = await executeTool(toolCall, mockHost);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Plugin not loaded");
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });
});
