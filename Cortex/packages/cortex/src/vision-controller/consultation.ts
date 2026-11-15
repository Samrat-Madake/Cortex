import { writeStderr } from "@cortex/shared";

const ALLOWED_CONFIG_KEYS = new Set(["scene_description", "focus_targets", "security_rules"]);

export function buildVisionControllerConsultationPrompt(context: Record<string, unknown>): string {
  return [
    "You are a conservative VisionController consultation responder for a video understanding pipeline.",
    "Decide whether the current situation needs a temporary perception adjustment.",
    "",
    "Context priority:",
    "- For security_risk triggers, prioritize current_segment and recent_segments.",
    "- For periodic_budget triggers, use video_context and event_context as a lightweight health check; usually return null.",
    "- Treat video_context.semantic_context as long-term background only. Never override current visual evidence with it.",
    "",
    "Default behavior:",
    "- Return null when no adjustment is clearly needed.",
    "- Do not change perception just because a normal event boundary, ordinary motion, or common object appears.",
    "",
    "Only adjust perception when the context clearly indicates one of these special situations:",
    "- A security/safety risk needs closer monitoring.",
    "- A specific target, object, person, vehicle, animal, sign, scoreboard, or text region needs extra attention.",
    "- The scene has become confusing, fast-changing, crowded, or visually ambiguous enough that more perception detail is needed.",
    "- Recent perception appears too coarse for the current event and a temporary higher-fidelity prompt would help.",
    "",
    "Allowed output:",
    "- Return null for no change.",
    "- Or return JSON exactly in this shape:",
    "{\"tool\":\"cortex_perception\",\"params\":{\"action\":\"configure\",\"camera_id\":\"...\",\"config\":{\"scene_description\":\"...\",\"focus_targets\":\"...\",\"security_rules\":\"...\"}},\"exit_condition\":{...}}",
    "",
    "Output constraints:",
    "- params.action must be \"configure\".",
    "- config may only contain scene_description, focus_targets, and security_rules.",
    "- Do not output vc_rules_json, vc_segment_policy_json, semantic_context_notes, semantic_context_init, track_states, track_activities, explain_decisions, vlm_model, or vlm_model_lite.",
    "- Include exit_condition for every tool call.",
    "- Keep adjustments minimal and temporary.",
    "- Do not answer benchmark questions; only decide perception configuration.",
    "",
    "Context:",
    JSON.stringify(context),
  ].join("\n");
}

export function parseVisionControllerConsultationResponse(
  text: string,
  logPrefix: string,
): Record<string, unknown> | null {
  const parsed = JSON.parse(text) as Record<string, unknown> | null;
  if (!parsed) return null;
  if (parsed.tool !== "cortex_perception") return null;
  if (!parsed.exit_condition) {
    writeStderr(`[${logPrefix}] segment policy consultation ignored: missing exit_condition`);
    return null;
  }

  const params = parsed.params && typeof parsed.params === "object"
    ? parsed.params as Record<string, unknown>
    : {};
  if (params.action !== "configure") {
    writeStderr(`[${logPrefix}] segment policy consultation ignored: unsupported action=${String(params.action)}`);
    return null;
  }

  const rawConfig = params.config && typeof params.config === "object"
    ? params.config as Record<string, unknown>
    : params;
  const config: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawConfig)) {
    if (!ALLOWED_CONFIG_KEYS.has(key)) continue;
    if (typeof value === "string" && value.trim()) config[key] = value.trim();
  }
  if (Object.keys(config).length === 0) {
    writeStderr(`[${logPrefix}] segment policy consultation ignored: no allowed config keys`);
    return null;
  }

  return {
    tool: "cortex_perception",
    params: {
      action: "configure",
      camera_id: typeof params.camera_id === "string" ? params.camera_id : undefined,
      config,
    },
    exit_condition: parsed.exit_condition,
  };
}
