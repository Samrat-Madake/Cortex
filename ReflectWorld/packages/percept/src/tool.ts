// packages/percept/src/tool.ts
import { monitorBus } from "@cortex/shared";
import type { Segment } from "@cortex/shared";
import type { PipelineDeps } from "./pipeline.js";
import { analyze } from "./pipeline.js";

/**
 * Dispatches incoming OpenClaw tool calls to the correct pipeline function.
 *
 * Supported actions:
 * - "analyze"    — Main pipeline: Working Memory → Strategy → Analyzers → Local Storage → PerceptionResult
 * - "get_status" — Working memory state + strategy info for a camera
 * - "configure"  — Runtime hot updates (prompt context, VLM model names, VC, semantic context directives)
 */
export async function executeToolAction(
  params: Record<string, unknown>,
  deps: PipelineDeps,
): Promise<string> {
  const action = params.action as string;
  let result: string;

  switch (action) {
    case "analyze": {
      const now = Date.now();
      const segment: Segment = {
        segment_id: (params.segment_id as string | undefined) ?? `seg_manual_${now}`,
        camera_id: (params.camera_id as string | undefined) ?? "default",
        mode: (params.mode as Segment["mode"] | undefined) ?? "snapshot",
        frames: (params.frames as Segment["frames"] | undefined) ?? [],
        raw_url: (params.raw_url as string | undefined) ?? "",
        timestamp: (params.timestamp as number | undefined) ?? now,
        duration_sec: (params.duration_sec as number | undefined) ?? 0,
        event_hint: params.event_hint as string | undefined,
      };

      const analyzed = await analyze(segment, deps);
      result = JSON.stringify(analyzed);
      break;
    }

    case "get_status": {
      const cameraId = (params.camera_id as string | undefined) ?? "__all__";
      if (cameraId === "__all__") {
        result = JSON.stringify({ status: "ok", message: "Perception pipeline is running." });
        break;
      }
      const memState = deps.workingMemory.getState(cameraId);
      const testSeg: Segment = {
        segment_id: "status_probe",
        camera_id: cameraId,
        mode: "snapshot",
        frames: [],
        raw_url: "",
        timestamp: Date.now(),
        duration_sec: 0,
      };
      const strategy = deps.strategyManager.selectStrategy(testSeg);
      result = JSON.stringify({
        camera_id: cameraId,
        has_active_event: memState.current_event_id !== null,
        current_event_id: memState.current_event_id,
        segment_count: memState.segment_count,
        scene_context_length: memState.scene_context.length,
        escalation_hints: memState.escalation_hints,
        default_strategy: strategy,
      });
      break;
    }

    case "configure": {
      const config = (params.config ?? params) as Record<string, unknown>;
      const applied: Record<string, string> = {};

      const ctx: Record<string, string | undefined> = {};
      if (typeof config.scene_description === "string") {
        ctx.sceneDescription = config.scene_description;
        applied.scene_description = config.scene_description;
      }
      if (typeof config.focus_targets === "string") {
        ctx.focusTargets = config.focus_targets;
        applied.focus_targets = config.focus_targets;
      }
      if (typeof config.security_rules === "string") {
        ctx.securityRules = config.security_rules;
        applied.security_rules = config.security_rules;
      }

      if (Object.keys(ctx).length > 0) {
        deps.vlmAnalyzer.setPromptContext(ctx);
      }

      const modelUpdates: { modelLite?: string; modelFull?: string } = {};
      if (typeof config.vlm_model === "string") {
        modelUpdates.modelFull = config.vlm_model;
        applied.vlm_model = config.vlm_model;
      }
      if (typeof config.vlm_model_lite === "string") {
        modelUpdates.modelLite = config.vlm_model_lite;
        applied.vlm_model_lite = config.vlm_model_lite;
      }
      if (Object.keys(modelUpdates).length > 0) deps.strategyManager.setVlmModels(modelUpdates);

      // VisionController configuration (delegated to parent plugin).
      // Param names: vc_enabled, vc_rules_json, vc_segment_policy_json.
      const vcConfig: Record<string, unknown> = {};
      for (const key of ["vc_enabled", "vc_rules_json", "vc_segment_policy_json"] as const) {
        const value = config[key];
        if (value !== undefined) vcConfig[key] = value;
      }
      if (Object.keys(vcConfig).length > 0 && deps.onVisionControllerConfigure) {
        const vcResult = deps.onVisionControllerConfigure(vcConfig);
        applied.vision_controller = vcResult;
      }

      // Semantic Context configuration
      if (typeof config.semantic_context_notes === "string" && deps.semanticContext) {
        const cameraId = (config.camera_id as string) ?? (params.camera_id as string);
        if (!cameraId) {
          result = JSON.stringify({ error: "camera_id required for semantic_context_notes" });
          break;
        }
        await deps.semanticContext.setUserNotes(cameraId, config.semantic_context_notes);
        applied.semantic_context_notes = `User Notes updated for ${cameraId}`;
      }

      const userBackground = typeof config.semantic_context_background === "string"
        ? config.semantic_context_background
        : typeof config.source_context === "string"
          ? config.source_context
          : undefined;
      if (typeof userBackground === "string" && deps.semanticContext) {
        const cameraId = (config.camera_id as string) ?? (params.camera_id as string);
        if (!cameraId) {
          result = JSON.stringify({ error: "camera_id required for semantic context background" });
          break;
        }
        if (deps.semanticContext.setUserBackground) {
          await deps.semanticContext.setUserBackground(cameraId, userBackground);
        } else {
          await deps.semanticContext.setUserNotes(cameraId, userBackground);
        }
        applied.semantic_context_background = `User background updated for ${cameraId}`;
      }

      // Intelligence directives (structured params → Semantic Context sub-sections)
      const hasDirectives = config.track_states || config.track_activities || config.explain_decisions !== undefined;
      if (hasDirectives && deps.semanticContext?.updateDirectives) {
        const cameraId = (config.camera_id as string) ?? (params.camera_id as string);
        if (!cameraId) {
          result = JSON.stringify({ error: "camera_id required for intelligence directives" });
          break;
        }
        const directiveResults = await deps.semanticContext.updateDirectives(cameraId, {
          trackStates: Array.isArray(config.track_states) ? config.track_states as string[] : undefined,
          trackActivities: Array.isArray(config.track_activities) ? config.track_activities as string[] : undefined,
          explainDecisions: typeof config.explain_decisions === "boolean" ? config.explain_decisions as boolean : undefined,
        });
        for (const r of directiveResults) applied[r.split(":")[0]!.trim()] = r;
      }

      result = JSON.stringify({
        status: "ok",
        message: Object.keys(applied).length > 0
          ? `Updated: ${Object.keys(applied).join(", ")}`
          : "No recognized config fields provided. Supported runtime fields: scene_description, focus_targets, security_rules, vlm_model, vlm_model_lite, vc_enabled, vc_rules_json, vc_segment_policy_json, semantic_context_notes, semantic_context_background, source_context, track_states, track_activities, explain_decisions.",
        applied,
      });
      break;
    }

    default:
      result = JSON.stringify({ error: `Unknown action: ${action}` });
  }

  const eventCameraId = resolveCameraId(params);
  const success = !(result.includes('"error"'));
  const parsed = tryParseJson(result);
  const config = params.config;
  const securityRulesPreview = config && typeof config === "object" && typeof (config as Record<string, unknown>).security_rules === "string"
    ? String((config as Record<string, unknown>).security_rules).slice(0, 160)
    : undefined;
  monitorBus.publish("system:tool_invoked", {
    tool: "cortex_perception",
    action,
    success,
    camera_id: eventCameraId,
    result_message: typeof parsed?.message === "string" ? parsed.message : undefined,
    applied_keys: parsed?.applied && typeof parsed.applied === "object"
      ? Object.keys(parsed.applied as Record<string, unknown>)
      : undefined,
    security_rules_preview: securityRulesPreview,
  }, eventCameraId);
  return result;
}

function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function resolveCameraId(params: Record<string, unknown>): string | undefined {
  if (typeof params.camera_id === "string") return params.camera_id;
  const config = params.config;
  if (config && typeof config === "object" && typeof (config as Record<string, unknown>).camera_id === "string") {
    return (config as Record<string, unknown>).camera_id as string;
  }
  return undefined;
}
