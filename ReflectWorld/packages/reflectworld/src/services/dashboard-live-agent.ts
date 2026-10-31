import type { IncomingMessage, ServerResponse } from "node:http";
import { WebSocket } from "ws";
import { createRuntimeHealthReporter, writeStderr } from "@reflectworld/shared";
import type { DashboardSessionScope } from "./dashboard-common.js";
import type { DashboardChatCallback, DashboardChatMessage } from "./dashboard-chat.js";

const runtimeHealth = createRuntimeHealthReporter("dashboard-live-agent");

export interface DashboardLiveAgentConfig {
  enabled: boolean;
  provider: "google";
  model: string;
  apiKey: string;
  hotkey: string;
  voiceName: string;
  language: string;
  debug: boolean;
}

export interface DashboardLiveAgentPublicConfig {
  enabled: boolean;
  provider?: "google";
  model?: string;
  hotkey?: string;
  language?: string;
}

export interface DashboardLiveAgentControllerOptions {
  sessionEnabled: () => boolean;
  getDashboardChat: () => DashboardChatCallback | null;
  scopeFromRequest: (
    req: IncomingMessage,
    body?: Record<string, unknown>,
    url?: URL,
  ) => DashboardSessionScope | null;
  sourceVisibleToSession: (sourceId: string, scope?: DashboardSessionScope | null) => boolean;
  consumeChatRateLimit: (req: IncomingMessage, scope: DashboardSessionScope | null) => { ok: true } | { ok: false; retryAfterSec: number };
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  buildDashboardChatContext: (cameraId?: string, limit?: number, scope?: DashboardSessionScope | null) => string;
  buildDashboardRuntimeContext: (cameraId?: string, scope?: DashboardSessionScope | null) => string;
}

type ClientMessage =
  | { type: "probe" }
  | { type: "start"; camera_id?: unknown; history?: unknown }
  | { type: "audio"; data?: unknown }
  | { type: "stop" }
  | { type: "close" };

type ServerMessage =
  | { type: "ready"; hotkey: string }
  | { type: "status"; status: "connecting" | "listening" | "thinking" | "speaking" | "idle"; message?: string }
  | { type: "input_transcript"; text: string; final?: boolean }
  | { type: "assistant_delta"; text: string }
  | { type: "audio"; data: string; sample_rate: number }
  | { type: "done" }
  | { type: "error"; error: string };

interface GeminiFunctionCall {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
}

interface GeminiServerMessage {
  setupComplete?: unknown;
  serverContent?: {
    turnComplete?: boolean;
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
    modelTurn?: {
      parts?: Array<{
        text?: string;
        inlineData?: { data?: string; mimeType?: string };
      }>;
    };
  };
  toolCall?: {
    functionCalls?: GeminiFunctionCall[];
  };
  error?: { message?: string };
}

const DEFAULT_HOTKEY = "F8";
const DEFAULT_GOOGLE_LIVE_MODEL = "gemini-3.1-flash-live-preview";
const DEFAULT_GOOGLE_LIVE_VOICE = "Vega";
const VOICE_TURN_TIMEOUT_MS = 25_000;

export function resolveDashboardLiveAgentConfig(env: NodeJS.ProcessEnv = process.env): DashboardLiveAgentConfig | null {
  const enabled = env.DASHBOARD_LIVE_AGENT_ENABLED === "true" || env.DASHBOARD_LIVE_AGENT_ENABLED === "1";
  if (!enabled) return null;
  const provider = (env.DASHBOARD_LIVE_AGENT_PROVIDER ?? "google").trim().toLowerCase();
  if (provider !== "google" && provider !== "gemini") return null;
  const apiKey = (env.DASHBOARD_LIVE_AGENT_API_KEY ?? env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY ?? "").trim();
  if (!apiKey) return null;
  return {
    enabled: true,
    provider: "google",
    apiKey,
    model: (env.DASHBOARD_LIVE_AGENT_MODEL ?? DEFAULT_GOOGLE_LIVE_MODEL).trim(),
    hotkey: (env.DASHBOARD_LIVE_AGENT_HOTKEY ?? DEFAULT_HOTKEY).trim() || DEFAULT_HOTKEY,
    voiceName: (env.DASHBOARD_LIVE_AGENT_VOICE ?? DEFAULT_GOOGLE_LIVE_VOICE).trim() || DEFAULT_GOOGLE_LIVE_VOICE,
    language: (env.DASHBOARD_LIVE_AGENT_LANGUAGE ?? "zh").trim() || "zh",
    debug: env.DASHBOARD_LIVE_AGENT_DEBUG === "true" || env.DASHBOARD_LIVE_AGENT_DEBUG === "1",
  };
}

export class DashboardLiveAgentController {
  private readonly config = resolveDashboardLiveAgentConfig();

  constructor(private readonly options: DashboardLiveAgentControllerOptions) {}

  enabled(): boolean {
    return Boolean(this.config);
  }

  publicConfig(): DashboardLiveAgentPublicConfig {
    if (!this.config) return { enabled: false };
    return {
      enabled: true,
      provider: this.config.provider,
      model: this.config.model,
      hotkey: this.config.hotkey,
      language: this.config.language,
    };
  }

  handleConfig(res: ServerResponse): void {
    this.options.sendJson(res, 200, this.publicConfig());
  }

  handleConnection(client: WebSocket, req: IncomingMessage): void {
    const config = this.config;
    if (!config) {
      client.close(1008, "Live agent is not configured");
      return;
    }
    const url = new URL(req.url ?? "/ws/live-agent", "http://localhost");
    const scope = this.options.scopeFromRequest(req, undefined, url);
    if (this.options.sessionEnabled() && !scope) {
      client.close(1008, "Unauthorized");
      return;
    }

    const session = new GoogleLiveAgentSession({
      config,
      client,
      req,
      scope,
      options: this.options,
    });
    void session.start();
  }
}

class GoogleLiveAgentSession {
  private google: WebSocket | null = null;
  private googleOpen = false;
  private googleReady = false;
  private readonly pendingGoogleMessages: Record<string, unknown>[] = [];
  private cameraId: string | undefined;
  private history: DashboardChatMessage[] = [];
  private inputTranscript = "";
  private spokenTranscript = "";
  private postToolTranscript = "";
  private toolAnswerFallback = "";
  private toolResponseSent = false;
  private readonly bufferedAudio: Array<{ data: string; sample_rate: number }> = [];
  private readonly bufferedToolCalls: GeminiFunctionCall[] = [];
  private started = false;
  private turnTimer: NodeJS.Timeout | null = null;
  private turnClosed = false;
  private closing = false;

  constructor(private readonly deps: {
    config: DashboardLiveAgentConfig;
    client: WebSocket;
    req: IncomingMessage;
    scope: DashboardSessionScope | null;
    options: DashboardLiveAgentControllerOptions;
  }) {}

  async start(): Promise<void> {
    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(this.deps.config.apiKey)}`;
    const google = new WebSocket(wsUrl, { maxPayload: 16 * 1024 * 1024 });
    this.google = google;

    this.deps.client.on("message", (raw) => this.handleClientMessage(raw));
    this.deps.client.on("close", () => this.close());
    this.deps.client.on("error", () => this.close());
    this.sendClient({ type: "status", status: "connecting" });

    google.on("open", () => {
      this.googleOpen = true;
      this.log("google_open", { model: this.deps.config.model });
      this.sendGoogle(this.setupMessage(), { force: true });
    });
    google.on("message", (raw) => {
      void this.handleGoogleMessage(raw);
    });
    google.on("close", (code, reason) => {
      const wasReady = this.googleReady;
      const turnInFlight = this.started || this.turnTimer !== null;
      this.googleOpen = false;
      this.googleReady = false;
      this.log("google_close", { code, reason: reason.toString(), wasReady, turnInFlight });
      if (shouldReportLiveAgentConnectionClose({ closing: this.closing, wasReady, turnInFlight, code })) {
        this.observeHealth("down", "connection_closed");
      }
      if (turnInFlight) {
        this.started = false;
        this.clearTurnTimer();
        this.sendClient({ type: "error", error: "Live voice connection closed unexpectedly" });
      } else {
        this.sendClient({ type: "status", status: "idle" });
      }
      // The browser socket represents this provider session. Once the provider
      // closes it cannot be reused; closing it makes the next voice turn create
      // a fresh provider connection instead of queueing messages indefinitely.
      if (!this.closing && this.deps.client.readyState === WebSocket.OPEN) {
        this.deps.client.close(1012, "Voice provider connection closed");
      }
    });
    google.on("error", (err) => {
      this.observeHealth("down", "connection_failed");
      this.log("google_error", { error: err instanceof Error ? err.message : String(err) });
      this.sendClient({ type: "error", error: err instanceof Error ? err.message : "Google Live connection failed" });
      this.close();
    });
  }

  private handleClientMessage(raw: WebSocket.RawData): void {
    let message: ClientMessage;
    try {
      message = JSON.parse(String(raw)) as ClientMessage;
    } catch {
      this.sendClient({ type: "error", error: "Invalid live agent message" });
      return;
    }

    if (message.type === "probe") {
      this.log("probe");
      return;
    }

    if (message.type === "start") {
      const cameraId = typeof message.camera_id === "string" && message.camera_id.trim()
        ? message.camera_id.trim()
        : undefined;
      if (cameraId && !this.deps.options.sourceVisibleToSession(cameraId, this.deps.scope)) {
        this.sendClient({ type: "error", error: "Source not found" });
        return;
      }
      this.cameraId = cameraId;
      this.history = normalizeHistory(message.history);
      this.inputTranscript = "";
      this.spokenTranscript = "";
      this.postToolTranscript = "";
      this.toolAnswerFallback = "";
      this.toolResponseSent = false;
      this.bufferedAudio.length = 0;
      this.bufferedToolCalls.length = 0;
      this.started = true;
      this.turnClosed = false;
      this.clearTurnTimer();
      this.log("start", { cameraId: cameraId ?? "all_sources" });
      this.sendGoogle({ realtimeInput: { activityStart: {} } });
      this.sendClient({ type: "status", status: "listening" });
      return;
    }

    if (message.type === "audio") {
      if (!this.started || typeof message.data !== "string" || !message.data) return;
      this.sendGoogle({
        realtimeInput: {
          audio: {
            data: message.data,
            mimeType: "audio/pcm;rate=16000",
          },
        },
      });
      return;
    }

    if (message.type === "stop") {
      if (!this.started) return;
      this.started = false;
      this.log("stop");
      this.sendGoogle({ realtimeInput: { activityEnd: {} } });
      this.sendClient({ type: "status", status: "thinking" });
      this.scheduleTurnTimeout();
      return;
    }

    if (message.type === "close") this.close();
  }

  private async handleGoogleMessage(raw: WebSocket.RawData): Promise<void> {
    let message: GeminiServerMessage;
    try {
      message = JSON.parse(String(raw)) as GeminiServerMessage;
    } catch {
      return;
    }
    if (message.error?.message) {
      this.observeHealth("down", "provider_error");
      this.log("server_error", { error: message.error.message });
      this.sendClient({ type: "error", error: message.error.message });
      return;
    }
    if (message.setupComplete) {
      this.googleReady = true;
      this.observeHealth("ok");
      this.log("setup_complete");
      this.flushPendingGoogleMessages();
      this.sendClient({ type: "ready", hotkey: this.deps.config.hotkey });
      return;
    }
    if (this.turnClosed) return;

    const serverContent = message.serverContent;
    const inputText = serverContent?.inputTranscription?.text;
    if (inputText) {
      this.inputTranscript += inputText;
      this.sendClient({ type: "input_transcript", text: this.inputTranscript, final: Boolean(serverContent?.turnComplete) });
      await this.flushTranscriptGatedOutput();
    }

    const outputText = serverContent?.outputTranscription?.text;
    if (outputText) {
      this.appendAssistantText(outputText);
    }

    for (const part of serverContent?.modelTurn?.parts ?? []) {
      if (part.text) {
        this.appendAssistantText(part.text);
      }
      if (part.inlineData?.data) {
        this.bufferedAudio.push({ data: part.inlineData.data, sample_rate: 24_000 });
        if (this.hasInputTranscript()) await this.flushTranscriptGatedOutput();
      }
    }

    if (message.toolCall?.functionCalls?.length) {
      this.bufferedToolCalls.push(...message.toolCall.functionCalls);
      if (this.hasInputTranscript()) await this.flushTranscriptGatedOutput();
    }

    if (serverContent?.turnComplete) {
      this.clearTurnTimer();
      if (!this.hasInputTranscript()) {
        this.log("turn_without_transcript", {
          spokenTranscriptChars: this.spokenTranscript.length,
          postToolTranscriptChars: this.postToolTranscript.length,
          toolAnswerFallbackChars: this.toolAnswerFallback.length,
          bufferedAudioChunks: this.bufferedAudio.length,
          bufferedToolCalls: this.bufferedToolCalls.length,
        });
        this.rejectBufferedToolCallsWithoutTranscript();
        this.sendClient({ type: "done" });
        this.sendClient({ type: "status", status: "idle" });
        this.turnClosed = true;
        this.resetTurnState();
        return;
      }
      await this.flushTranscriptGatedOutput();
      this.sendClient({ type: "input_transcript", text: this.inputTranscript.trim(), final: true });
      const finalText = this.finalAssistantText();
      if (finalText) this.sendClient({ type: "assistant_delta", text: finalText });
      this.sendClient({ type: "done" });
      this.sendClient({ type: "status", status: "idle" });
      this.turnClosed = true;
      this.resetTurnState();
    }
  }

  private appendAssistantText(text: string): void {
    const cleaned = sanitizeLiveAssistantText(text);
    if (!cleaned) return;
    if (this.toolResponseSent) {
      this.postToolTranscript = sanitizeLiveAssistantText(this.postToolTranscript + cleaned);
    } else {
      this.spokenTranscript = sanitizeLiveAssistantText(this.spokenTranscript + cleaned);
    }
    if (this.hasInputTranscript()) void this.flushTranscriptGatedOutput();
  }

  private hasInputTranscript(): boolean {
    return hasReliableLiveInputTranscript(this.inputTranscript);
  }

  private async flushTranscriptGatedOutput(): Promise<void> {
    if (!this.hasInputTranscript()) return;
    if (this.bufferedToolCalls.length > 0) {
      const calls = this.bufferedToolCalls.splice(0);
      await this.handleToolCall(calls);
    }
    const assistantText = this.visibleAssistantText();
    if (assistantText) {
      this.sendClient({ type: "assistant_delta", text: assistantText });
    }
    while (this.bufferedAudio.length > 0) {
      const audio = this.bufferedAudio.shift();
      if (!audio) continue;
      this.sendClient({ type: "status", status: "speaking" });
      this.sendClient({ type: "audio", data: audio.data, sample_rate: audio.sample_rate });
    }
  }

  private async handleToolCall(calls: GeminiFunctionCall[]): Promise<void> {
    this.log("tool_call", { count: calls.length });
    const responses = [];
    for (const call of calls) {
      if (call.name !== "execute") {
        responses.push({
          id: call.id,
          name: call.name,
          response: { error: `Unknown tool: ${call.name ?? "unknown"}` },
        });
        continue;
      }
      const question = extractQuestion(call.args, this.inputTranscript);
      const currentContext = extractCurrentContext(call.args);
      const answer = await this.executeReflect(question, currentContext);
      const answerText = typeof answer.answer === "string" ? answer.answer.trim() : "";
      if (answerText) this.setToolAnswerFallback(answerText);
      responses.push({
        id: call.id,
        name: "execute",
        response: { result: answer },
      });
    }
    this.toolResponseSent = true;
    this.sendGoogle({ toolResponse: { functionResponses: responses } });
  }

  private setToolAnswerFallback(text: string): void {
    const cleaned = sanitizeLiveAssistantText(text).trim();
    if (!cleaned) return;
    this.toolAnswerFallback = cleaned;
  }

  private currentAssistantText(): string {
    if (this.toolResponseSent || this.toolAnswerFallback.trim()) {
      return (this.postToolTranscript.trim() || this.toolAnswerFallback.trim() || this.spokenTranscript.trim()).trim();
    }
    return this.spokenTranscript.trim();
  }

  private visibleAssistantText(): string {
    if (this.toolResponseSent && this.postToolTranscript.trim()) return this.postToolTranscript.trim();
    return this.spokenTranscript.trim();
  }

  private finalAssistantText(): string {
    return this.currentAssistantText();
  }

  private rejectBufferedToolCallsWithoutTranscript(): void {
    const calls = this.bufferedToolCalls.splice(0);
    if (calls.length === 0) return;
    this.log("tool_call_without_transcript", { count: calls.length });
    this.sendGoogle({
      toolResponse: {
        functionResponses: calls.map(call => ({
          id: call.id,
          name: call.name ?? "execute",
          response: { ok: false, error: "No input transcription is available for this voice turn." },
        })),
      },
    });
  }

  private scheduleTurnTimeout(): void {
    this.clearTurnTimer();
    this.turnTimer = setTimeout(() => {
      this.log("turn_timeout", {
        transcriptChars: this.inputTranscript.length,
        spokenTranscriptChars: this.spokenTranscript.length,
        postToolTranscriptChars: this.postToolTranscript.length,
        toolAnswerFallbackChars: this.toolAnswerFallback.length,
      });
      if (!this.hasInputTranscript() || !this.currentAssistantText()) this.completeTimedOutTurn();
      else {
        void this.flushTranscriptGatedOutput();
        const finalText = this.finalAssistantText();
        if (finalText) this.sendClient({ type: "assistant_delta", text: finalText });
        this.sendClient({ type: "done" });
        this.sendClient({ type: "status", status: "idle" });
        this.turnClosed = true;
        this.resetTurnState();
      }
    }, VOICE_TURN_TIMEOUT_MS);
  }

  private clearTurnTimer(): void {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
  }

  private completeTimedOutTurn(): void {
    if (this.turnClosed) return;
    this.turnClosed = true;
    this.clearTurnTimer();
    this.sendClient({ type: "done" });
    this.sendClient({ type: "status", status: "idle" });
    this.rejectBufferedToolCallsWithoutTranscript();
    this.resetTurnState();
  }

  private resetTurnState(): void {
    this.clearTurnTimer();
    this.started = false;
    this.inputTranscript = "";
    this.spokenTranscript = "";
    this.postToolTranscript = "";
    this.toolAnswerFallback = "";
    this.toolResponseSent = false;
    this.bufferedAudio.length = 0;
    this.bufferedToolCalls.length = 0;
  }

  private async executeReflect(question: string, currentContext?: string): Promise<Record<string, unknown>> {
    const dashboardChat = this.deps.options.getDashboardChat();
    if (!dashboardChat) return { ok: false, error: "Reflect.World chat is not configured" };
    const rateLimit = this.deps.options.consumeChatRateLimit(this.deps.req, this.deps.scope);
    if (!rateLimit.ok) {
      return { ok: false, error: `Too many voice questions. Try again in ${rateLimit.retryAfterSec}s.` };
    }
    try {
      const result = await dashboardChat({
        prompt: question,
        ...(this.cameraId ? { cameraId: this.cameraId } : {}),
        context: this.deps.options.buildDashboardChatContext(this.cameraId, 2, this.deps.scope),
        runtimeContext: this.deps.options.buildDashboardRuntimeContext(this.cameraId, this.deps.scope),
        history: currentContext
          ? [...this.history, { role: "user", text: `Current voice context: ${currentContext}` }]
          : this.history,
        ...(this.deps.scope?.userId ? { userId: this.deps.scope.userId } : {}),
        ...(this.deps.scope?.sessionId ? { sessionId: this.deps.scope.sessionId } : {}),
      });
      if (result.error) {
        this.log("execute_error", { error: result.error });
        return { ok: false, error: result.error };
      }
      this.log("execute_ok", { answerChars: (result.answer ?? "").length });
      return { ok: true, answer: result.answer ?? "" };
    } catch (err) {
      this.log("execute_exception", { error: err instanceof Error ? err.message : String(err) });
      return { ok: false, error: err instanceof Error ? err.message : "Reflect.World chat failed" };
    }
  }

  private setupMessage(): Record<string, unknown> {
    return buildGoogleLiveSetupMessage(this.deps.config);
  }

  private sendGoogle(payload: Record<string, unknown>, opts: { force?: boolean } = {}): void {
    if (this.google?.readyState === WebSocket.OPEN && this.googleOpen && (this.googleReady || opts.force)) {
      if (this.deps.config.debug) {
        this.log("send_google", { payload: JSON.stringify(payload).slice(0, 500) });
      }
      this.google.send(JSON.stringify(payload));
      return;
    }
    this.pendingGoogleMessages.push(payload);
    if (this.pendingGoogleMessages.length > 256) this.pendingGoogleMessages.shift();
  }

  private flushPendingGoogleMessages(): void {
    const pending = this.pendingGoogleMessages.splice(0);
    for (const payload of pending) this.sendGoogle(payload);
  }

  private sendClient(payload: ServerMessage): void {
    if (this.deps.client.readyState === WebSocket.OPEN) this.deps.client.send(JSON.stringify(payload));
  }

  private close(): void {
    this.closing = true;
    this.clearTurnTimer();
    if (this.google) {
      if (this.google.readyState === WebSocket.OPEN) this.google.close();
      else if (this.google.readyState === WebSocket.CONNECTING) this.google.terminate();
    }
    if (this.deps.client.readyState === WebSocket.OPEN) this.deps.client.close();
  }

  private log(event: string, data: Record<string, unknown> = {}): void {
    writeStderr(`[dashboard-live-agent] ${event}`, data);
  }

  private observeHealth(status: "ok" | "down", code?: string): void {
    runtimeHealth.observe({
      component: "live_agent",
      operation: "connect",
      status,
      ...(code ? { code } : {}),
      scope: {
        ...(this.deps.scope?.userId ? { user_id: this.deps.scope.userId } : {}),
        ...(this.deps.scope?.sessionId ? { session_id: this.deps.scope.sessionId } : {}),
        ...(this.cameraId ? { source_id: this.cameraId } : {}),
      },
    });
  }
}

export function shouldReportLiveAgentConnectionClose(state: {
  closing: boolean;
  wasReady: boolean;
  turnInFlight: boolean;
  code: number;
}): boolean {
  // Live API periodically retires established WebSocket connections. Ignore
  // expected idle retirement after setup, but surface abnormal transport or
  // provider closes even when no turn is currently in flight.
  if (state.closing) return false;
  if (!state.wasReady || state.turnInFlight) return true;
  return state.code !== 1000 && state.code !== 1001 && state.code !== 1008;
}

export function buildGoogleLiveSetupMessage(config: { model: string; voiceName?: string }): Record<string, unknown> {
  const voiceName = config.voiceName?.trim() || DEFAULT_GOOGLE_LIVE_VOICE;
  const generationConfig: Record<string, unknown> = {
    responseModalities: ["AUDIO"],
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName,
        },
      },
    },
  };
  return {
    setup: {
      model: formatGoogleLiveModel(config.model),
      generationConfig,
      systemInstruction: {
        parts: [{ text: liveAgentSystemPrompt() }],
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: true,
        },
      },
      tools: [{
        functionDeclarations: [{
          name: "execute",
          description: "Ask Reflect.World video memory and dashboard state. Use this for all questions about past observed video, recent events, known people/entities, objects, safety risks, source status, or analysis progress.",
          parameters: {
            type: "object",
            properties: {
              question: {
                type: "string",
                description: "The user's exact question, preserving any time range, person/object description, or source reference.",
              },
              current_context: {
                type: "string",
                description: "Optional visible or conversational context relevant to the question.",
              },
              intent: {
                type: "string",
                description: "One of: recent_events, known_entities, safety_risk, source_status, object_lookup, other.",
              },
            },
            required: ["question"],
          },
        }],
      }],
    },
  };
}

function formatGoogleLiveModel(model: string): string {
  const value = model.trim();
  if (!value) return `models/${DEFAULT_GOOGLE_LIVE_MODEL}`;
  return value.startsWith("models/") ? value : `models/${value}`;
}

function normalizeHistory(value: unknown): DashboardChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-8).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const msg = item as Record<string, unknown>;
    const role = msg.role === "assistant" ? "assistant" : msg.role === "user" ? "user" : null;
    const text = typeof msg.text === "string" ? msg.text.trim().slice(0, 1200) : "";
    return role && text ? [{ role, text }] : [];
  });
}

export function hasReliableLiveInputTranscript(text: string): boolean {
  return text.trim().length > 0;
}

function extractQuestion(args: Record<string, unknown> | undefined, fallback: string): string {
  const question = typeof args?.question === "string" ? args.question.trim() : "";
  return (question || fallback || "Answer the user's question using Reflect.World video memory.").slice(0, 2000);
}

function extractCurrentContext(args: Record<string, unknown> | undefined): string | undefined {
  const text = typeof args?.current_context === "string" ? args.current_context.trim() : "";
  return text ? text.slice(0, 1200) : undefined;
}

function liveAgentSystemPrompt(): string {
  return `You are a real-time voice interface for Reflect.World.

Reply in the same language as the user's current voice or text input. If the user's language is unclear, use the dominant language of the current conversation. If the user explicitly asks for another language, follow that request.

Keep every spoken response brief, natural, and useful. Prefer one sentence. Use at most 2 short bullets only when needed.

You cannot see the current video stream directly. You do not analyze camera frames yourself. You have no long-term memory of your own.

You have exactly ONE tool: execute. This tool connects to Reflect.World, a video memory assistant. It can answer questions about previously observed video, recent events, detected people/entities, objects, safety risks, sources/cameras, and dashboard analysis state.

Always call execute for questions about:
- What happened recently
- Whether anyone appeared earlier
- Whether this person/object has been seen before
- Dangerous, unusual, or suspicious events
- When someone/something appeared, left, or changed
- Known entities, repeated appearances, or past sightings
- Recent activity summaries
- Whether video analysis/source/stream processing is working

Do not answer video-memory questions from your own knowledge. Reflect.World is the source of truth.

Before calling execute, say one very short acknowledgment in the user's language, then call the tool. Do not use a fixed-language acknowledgment.

When calling execute, include the user's exact question, any time range mentioned, visible person/object/location description if provided by the user, and whether this is about recent events, known entities, safety risk, or source status.

After the tool returns, you must continue with a final spoken answer. Summarize the result for the user in 1-2 short sentences. Do not stop after the acknowledgment. Do not read long lists unless the user asks for details.

Do not say “dashboard”, “tool”, “memory database”, “segment”, “camera_id”, or other internal terms unless the user asks for diagnostics.

Never speak or display tool-call syntax, JSON function calls, or strings such as call:execute. Tool calls must only be sent through the tool protocol.

If the user asks to send messages, search the web, create reminders, control devices, or manage apps, say briefly that this assistant is only connected to video memory and cannot do that.

If the tool returns a long answer, compress it aggressively into the shortest useful spoken answer.`;
}

export function sanitizeLiveAssistantText(text: string): string {
  const markers = [
    /\bcall\s*:\s*execute\b/i,
    /\bexecute\s*\{/i,
    /\btool_code\b/i,
    /\bfunction_call\b/i,
  ];
  let cut = text.length;
  for (const marker of markers) {
    const match = marker.exec(text);
    if (match?.index !== undefined) cut = Math.min(cut, match.index);
  }
  return text.slice(0, cut);
}
