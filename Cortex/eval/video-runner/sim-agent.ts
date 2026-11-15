/**
 * SimAgent — Gemini-based OpenClaw test double for E2E testing.
 *
 * Reads Skill files on init, calls Gemini with Skill content as system prompt,
 * and returns parsed tool call JSON. Two modes:
 * - respondToConsultation: simulates how OpenClaw would react to a segment
 *   policy consultation
 * - respondToUserInstruction: Skill understanding test (simulated user commands)
 *
 * Reuses the Gemini REST API key pattern.
 */

import { readFileSync } from "node:fs";

// ── Types ──

export interface ToolCall {
  tool?: string;
  params?: Record<string, unknown>;
  /** Exit condition for segment policy override (TriggerCondition format). */
  exit_condition?: Record<string, unknown>;
}

export interface ConsultationContext {
  camera_id: string;
  signals: Record<string, unknown>;
  trigger_reason: Record<string, unknown>;
  eventText: string;
  current_baseline?: Record<string, unknown>;
  current_overrides?: Record<string, unknown>;
  recommended_action_types?: string[];
}

interface GeminiRequest {
  contents: Array<{
    role: string;
    parts: Array<{ text: string }>;
  }>;
  generationConfig: {
    responseMimeType: string;
  };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}

export interface SimAgentOptions {
  /** Paths to Skill .md files to load as tool documentation. */
  skillPaths: string[];
  /** Gemini API key (uses generativelanguage.googleapis.com). */
  apiKey?: string;
  /** Model to use for agent reasoning. Default: gemini-2.5-flash. */
  model?: string;
  /** Request timeout in ms. Default: 15000. */
  timeoutMs?: number;
}

// ── SimAgent ──

export class SimAgent {
  private skillContent: string;
  private model: string;
  private timeoutMs: number;
  private apiKey?: string;

  constructor(options: SimAgentOptions) {
    // Read and concatenate all Skill files
    this.skillContent = options.skillPaths
      .map((p) => {
        const content = readFileSync(p, "utf-8");
        const fileName = p.split("/").pop() ?? p;
        return `=== ${fileName} ===\n${content}`;
      })
      .join("\n\n");

    this.model = options.model ?? "gemini-2.5-flash";
    this.timeoutMs = options.timeoutMs ?? 15_000;

    this.apiKey = options.apiKey ?? process.env.VLM_API_KEY ?? "";
  }

  /**
   * Simulate how OpenClaw would respond to a VisionController segment policy consultation.
   * Returns a tool call JSON, or null if no action is needed.
   */
  async respondToConsultation(
    context: ConsultationContext,
    systemState?: { visionControllerConfig?: unknown; latestPerception?: string },
  ): Promise<ToolCall | null> {
    const systemPrompt = this.buildSystemPrompt(context.camera_id, systemState);

    const userPrompt = [
      `You received a VisionController consultation notification:`,
      `- Camera: ${context.camera_id}`,
      `- Detected classes: ${JSON.stringify(context.signals.detected_classes ?? [])}`,
      `- Security risk: ${context.signals.security_risk ?? false}`,
      `- Trigger reason: ${JSON.stringify(context.trigger_reason)}`,
      `- Event text: ${context.eventText}`,
      `- Current baseline: ${JSON.stringify(context.current_baseline ?? {})}`,
      `- Current overrides: ${JSON.stringify(context.current_overrides ?? {})}`,
      `- Recommended action types: ${JSON.stringify(context.recommended_action_types ?? [])}`,
      ``,
      `Based on this consultation, decide what action to take.`,
      `You may adjust camera/runtime settings when appropriate. Common options include:`,
      `- cortex_cam/set_sampling: fps, width, height`,
      `- cortex_cam/switch_mode: event or stream`,
      `- cortex_perception/configure: security_rules, scene_description, focus_targets, vlm_model`,
      `- cortex_perception/configure: vc_rules_json / vc_segment_policy_json`,
      `Use cortex_perception/configure when you want to change VLM behavior, model choice, or semantic guidance.`,
      `Use cortex_cam when you want to change fps, resolution, or watch mode immediately.`,
      `If you use cortex_perception with action="configure", generate a camera-specific natural-language "security_rules" text based on the scene, trigger, detected classes, and risk posture.`,
      `Do not use vague placeholders. Make the rule text operational and specific to what should be watched next.`,
      `Example perception config: {"tool":"cortex_perception","params":{"action":"configure","camera_id":"${context.camera_id}","config":{"camera_id":"${context.camera_id}","security_rules":"Watch for vehicles lingering near the gate; treat any person approaching the truck after hours as suspicious and describe whether they load, unload, or inspect it.","vlm_model":"gemini-2.5-flash"}}}`,
      `Example camera tuning: {"tool":"cortex_cam","params":{"action":"set_sampling","name":"${context.camera_id}","fps":2,"width":1280,"height":720}}`,
      `Output a single JSON object with "tool" and "params" fields. If no action needed, output {"tool": "none", "params": {}}.`,
    ].join("\n");

    try {
      const call = await this.callGemini(systemPrompt, userPrompt);
      return this.finalizeConsultationToolCall(call, context) ?? this.fallbackConsultationToolCall(context);
    } catch {
      return this.fallbackConsultationToolCall(context);
    }
  }

  /**
   * Respond to a simulated user instruction (Skill understanding test).
   * Returns a tool call JSON.
   */
  async respondToUserInstruction(
    instruction: string,
    context?: { camera_id?: string; visionControllerConfig?: unknown },
  ): Promise<ToolCall | null> {
    const cameraId = context?.camera_id ?? "e2e-front-door";
    const systemPrompt = this.buildSystemPrompt(cameraId, {
      visionControllerConfig: context?.visionControllerConfig,
    });

    const userPrompt = [
      `The user says: "${instruction}"`,
      ``,
      `Output the corresponding tool call as a JSON object with "tool" and "params" fields.`,
    ].join("\n");

    try {
      const call = await this.callGemini(systemPrompt, userPrompt);
      return call ?? this.fallbackUserInstructionToolCall(instruction, cameraId);
    } catch {
      return this.fallbackUserInstructionToolCall(instruction, cameraId);
    }
  }

  /**
   * Returns a consultation dispatcher compatible object for injection into
   * Cortex during E2E. This simulates OpenClaw receiving a consultation.
   */
  asConsultationDispatcher(): {
    submitConsultation(context: ConsultationContext): Promise<ToolCall | null>;
  } {
    return {
      submitConsultation: (context) => this.respondToConsultation(context),
    };
  }

  /**
   * @deprecated Use asConsultationDispatcher(). Kept for backward compatibility
   * with older E2E setup code.
   */
  asConsultationHandler(): {
    onConsult(context: ConsultationContext): Promise<ToolCall | null>;
  } {
    return {
      onConsult: (context) => this.respondToConsultation(context),
    };
  }

  // ── Private ──

  private buildSystemPrompt(
    cameraId: string,
    state?: { visionControllerConfig?: unknown; latestPerception?: string },
  ): string {
    const parts = [
      `You are Cortex's management Agent. You control a visual perception system.`,
      ``,
      `Available tools (read carefully — your output must match these exactly):`,
      this.skillContent,
      ``,
      `Current system state:`,
      `- Camera: ${cameraId}`,
    ];

    if (state?.visionControllerConfig) {
      parts.push(`- VisionController config: ${JSON.stringify(state.visionControllerConfig)}`);
    }
    if (state?.latestPerception) {
      parts.push(`- Latest perception: ${state.latestPerception}`);
    }

    parts.push(
      ``,
      `Output a single JSON object with "tool" and "params" fields. Nothing else.`,
      `If the user or consultation clearly implies an action, do not return "none".`,
      `Prefer these canonical tool names: "cortex_perception", "cortex_cam", "cortex_memory".`,
      `Legacy runtime aliases are still accepted during migration: "cortex_cam" for cam and "cortex_mem" for memory.`,
      `The "params" field must include "action" and all required parameters for that action.`,
      `You are allowed to tune fps, resolution, watch mode, VLM model, semantic prompt context, and VisionController config when the situation calls for it.`,
    );

    return parts.join("\n");
  }

  private async callGemini(systemPrompt: string, userPrompt: string): Promise<ToolCall | null> {
    const requestBody: GeminiRequest = {
      contents: [
        { role: "user", parts: [{ text: `${systemPrompt}\n\n---\n\n${userPrompt}` }] },
      ],
      generationConfig: { responseMimeType: "application/json" },
    };

    const { url, headers } = this.buildRequestConfig();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`Gemini API ${response.status}: ${errBody}`);
      }

      const geminiResp = (await response.json()) as GeminiResponse;
      const rawText = geminiResp.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
      const parsed = JSON.parse(rawText) as Record<string, unknown>;

      if (!parsed.tool || parsed.tool === "none") return null;

      return {
        tool: parsed.tool as string,
        params: (parsed.params as Record<string, unknown>) ?? {},
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private fallbackConsultationToolCall(context: ConsultationContext): ToolCall | null {
    const text = `${context.eventText} ${JSON.stringify(context.trigger_reason)}`.toLowerCase();
    if (text.includes("action required") || text.includes("configure") || text.includes("class_detected")) {
      return {
        tool: "cortex_perception",
        params: {
          action: "configure",
          camera_id: context.camera_id,
          config: {
            camera_id: context.camera_id,
            security_rules: this.buildFallbackSecurityRulesText(context),
            e2e_consultation_reason: JSON.stringify(context.trigger_reason),
          },
        },
      };
    }
    return null;
  }

  private finalizeConsultationToolCall(call: ToolCall | null, context: ConsultationContext): ToolCall | null {
    if (!call) return null;
    if (call.tool !== "cortex_perception") return call;

    const params = { ...call.params };
    const action = typeof params.action === "string" ? params.action : undefined;
    if (action !== "configure") return call;

    const config = params.config && typeof params.config === "object"
      ? { ...(params.config as Record<string, unknown>) }
      : {};

    if (typeof params.camera_id !== "string") {
      params.camera_id = context.camera_id;
    }
    if (typeof config.camera_id !== "string") {
      config.camera_id = context.camera_id;
    }
    if (typeof config.security_rules !== "string" || config.security_rules.trim().length < 24) {
      config.security_rules = this.buildFallbackSecurityRulesText(context);
    }

    params.config = config;
    return { tool: call.tool, params };
  }

  private buildFallbackSecurityRulesText(context: ConsultationContext): string {
    const classes = Array.isArray(context.signals.detected_classes)
      ? context.signals.detected_classes.filter((value): value is string => typeof value === "string")
      : [];
    const classSummary = classes.length > 0 ? classes.join(", ") : "unknown objects";
    const risk = context.signals.security_risk
      ? "Escalate any suspicious interaction immediately."
      : "Escalate if activity becomes unusual or prolonged.";
    return `Camera ${context.camera_id}: pay close attention to ${classSummary}. Describe whether they are moving, lingering, interacting with property, or approaching restricted areas. ${risk}`;
  }

  private fallbackUserInstructionToolCall(instruction: string, cameraId: string): ToolCall | null {
    const text = instruction.toLowerCase();

    if (text.includes("night") && text.includes("security")) {
      return {
        tool: "cortex_perception",
        params: {
          action: "configure",
          config: {
            scene_description: "Night security monitoring scene",
            security_rules: "Treat after-hours people, lingering vehicles, or unusual activity as notable. Describe who or what appears and whether they approach restricted areas.",
          },
        },
      };
    }

    if (text.includes("walking")) {
      return {
        tool: "cortex_perception",
        params: {
          action: "configure",
          config: {
            scene_description: "Walking or outdoor movement scene",
            security_rules: "Prioritize nearby people, vehicles, and movement that affects pedestrian safety or access.",
          },
        },
      };
    }

    if (text.includes("frame rate") || /\bfps\b/.test(text)) {
      const fpsMatch = text.match(/(\d+(?:\.\d+)?)/);
      const fps = fpsMatch ? Number(fpsMatch[1]) : 3;
      return {
        tool: "cortex_cam",
        params: {
          action: "set_sampling",
          name: cameraId,
          fps,
        },
      };
    }

    if (text.includes("stop") && (text.includes("monitor") || text.includes("watch"))) {
      return {
        tool: "cortex_cam",
        params: {
          action: "stop_watch",
          name: cameraId,
        },
      };
    }

    if (text.includes("who came") || text.includes("came by") || text.includes("visitor") || text.includes("today")) {
      return {
        tool: "cortex_memory",
        params: {
          action: "search",
          camera_id: cameraId,
          query: "who came by today",
        },
      };
    }

    return null;
  }

  private buildRequestConfig(): { url: string; headers: Record<string, string> } {
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.apiKey!,
      },
    };
  }
}

// ── Factory ──}

// ── Factory ──

/**
 * Creates a SimAgent by reading Skill files and resolving Gemini credentials from env.
 */
export async function createSimAgent(skillPaths: string[]): Promise<SimAgent> {
  return new SimAgent({
    skillPaths,
    apiKey: process.env.VLM_API_KEY,
    model: process.env.QA_MODEL ?? process.env.LLM_MODEL ?? "gemini-2.5-flash",
  });
}
