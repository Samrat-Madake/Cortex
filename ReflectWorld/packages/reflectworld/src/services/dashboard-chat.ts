import type { IncomingMessage, ServerResponse } from "node:http";
import type { DashboardSessionScope } from "./dashboard-common.js";

export interface DashboardChatMessage {
  role: "user" | "assistant";
  text: string;
}

export interface DashboardChatRequest {
  prompt: string;
  cameraId?: string;
  context: string;
  runtimeContext?: string;
  history: DashboardChatMessage[];
  userId?: string;
  sessionId?: string;
  emit?: (event: DashboardChatStreamEvent) => void;
}

export interface DashboardChatResponse {
  ok?: boolean;
  answer?: string;
  error?: string;
  statusCode?: number;
}

export interface SemanticContextRequest {
  cameraId: string;
  userId?: string;
  sessionId?: string;
}

export interface SemanticContextResponse {
  ok?: boolean;
  camera_id?: string;
  content?: string;
  error?: string;
  statusCode?: number;
}

export type DashboardChatStreamEvent =
  | { type: "status"; message: string }
  | { type: "delta"; text: string }
  | { type: "done"; answer?: string }
  | { type: "error"; error: string };

export type DashboardChatCallback = (req: DashboardChatRequest) => Promise<DashboardChatResponse>;
export type SemanticContextCallback = (req: SemanticContextRequest) => Promise<SemanticContextResponse>;

interface OpenAIChatMessage {
  role?: unknown;
  content?: unknown;
}

type ChatRateLimitResult = { ok: true } | { ok: false; retryAfterSec: number };

export interface DashboardChatControllerOptions {
  sessionEnabled: () => boolean;
  getDashboardChat: () => DashboardChatCallback | null;
  getSemanticContext: () => SemanticContextCallback | null;
  requireDashboardSession: (
    req: IncomingMessage,
    res: ServerResponse,
    body?: Record<string, unknown>,
    url?: URL,
  ) => DashboardSessionScope | null;
  scopeFromRequest: (
    req: IncomingMessage,
    body?: Record<string, unknown>,
    url?: URL,
  ) => DashboardSessionScope | null;
  sourceVisibleToSession: (sourceId: string, scope?: DashboardSessionScope | null) => boolean;
  consumeChatRateLimit: (req: IncomingMessage, scope: DashboardSessionScope | null) => ChatRateLimitResult;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readRequestBuffer: (req: IncomingMessage, maxBytes?: number) => Promise<Buffer>;
  buildDashboardChatContext: (cameraId?: string, limit?: number, scope?: DashboardSessionScope | null) => string;
  buildDashboardRuntimeContext: (cameraId?: string, scope?: DashboardSessionScope | null) => string;
}

export class DashboardChatController {
  constructor(private readonly options: DashboardChatControllerOptions) {}

  async handleDashboardChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const dashboardChat = this.options.getDashboardChat();
    if (!dashboardChat) {
      this.options.sendJson(res, 503, { error: "Dashboard chat is not configured" });
      return;
    }
    try {
      const raw = await this.options.readRequestBuffer(req, 1024 * 1024);
      const payload = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      const scope = this.options.requireDashboardSession(req, res, payload);
      if (this.options.sessionEnabled() && !scope) return;

      const prompt = typeof payload.prompt === "string" ? payload.prompt.trim().slice(0, 2000) : "";
      if (!prompt) {
        this.options.sendJson(res, 400, { error: "prompt is required" });
        return;
      }

      const cameraId = typeof payload.camera_id === "string" && payload.camera_id.trim()
        ? payload.camera_id.trim()
        : undefined;
      if (cameraId && !this.options.sourceVisibleToSession(cameraId, scope)) {
        this.options.sendJson(res, 404, { error: "Source not found" });
        return;
      }

      const rateLimit = this.options.consumeChatRateLimit(req, scope);
      if (!rateLimit.ok) {
        this.sendChatRateLimited(res, rateLimit.retryAfterSec);
        return;
      }

      const rawHistory = Array.isArray(payload.history) ? payload.history : [];
      const history: DashboardChatMessage[] = rawHistory.slice(-8).flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const msg = item as Record<string, unknown>;
        const role = msg.role === "assistant" ? "assistant" : msg.role === "user" ? "user" : null;
        const text = typeof msg.text === "string" ? msg.text.trim().slice(0, 1200) : "";
        return role && text ? [{ role, text }] : [];
      });

      const wantsStream = payload.stream === true || String(req.headers.accept ?? "").includes("text/event-stream");
      const chatReq: DashboardChatRequest = {
        prompt,
        ...(cameraId ? { cameraId } : {}),
        context: this.options.buildDashboardChatContext(cameraId, 2, scope),
        runtimeContext: this.options.buildDashboardRuntimeContext(cameraId, scope),
        history,
        ...(scope?.userId ? { userId: scope.userId } : {}),
        ...(scope?.sessionId ? { sessionId: scope.sessionId } : {}),
      };
      if (wantsStream) {
        await this.handleDashboardChatStream(req, res, chatReq);
        return;
      }

      const result = await dashboardChat(chatReq);
      this.options.sendJson(res, result.statusCode ?? (result.error ? 500 : 200), result);
    } catch (err) {
      this.options.sendJson(res, 400, { error: err instanceof Error ? err.message : "Invalid dashboard chat request" });
    }
  }

  async handleOpenAIChatCompletions(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const dashboardChat = this.options.getDashboardChat();
    if (!dashboardChat) {
      this.sendOpenAIError(res, 503, "Dashboard chat is not configured");
      return;
    }
    try {
      const raw = await this.options.readRequestBuffer(req, 1024 * 1024);
      const payload = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      const scope = this.options.requireDashboardSession(req, res, payload, url);
      if (this.options.sessionEnabled() && !scope) return;

      const messages = Array.isArray(payload.messages) ? payload.messages as OpenAIChatMessage[] : [];
      const prompt = this.extractOpenAIPrompt(messages);
      if (!prompt) {
        this.sendOpenAIError(res, 400, "messages must include a user message");
        return;
      }
      const cameraId = this.extractOpenAICameraId(payload);
      if (cameraId && !this.options.sourceVisibleToSession(cameraId, scope)) {
        this.sendOpenAIError(res, 404, "Source not found");
        return;
      }

      const rateLimit = this.options.consumeChatRateLimit(req, scope);
      if (!rateLimit.ok) {
        this.sendOpenAIChatRateLimited(res, rateLimit.retryAfterSec);
        return;
      }

      const model = typeof payload.model === "string" && payload.model.trim()
        ? payload.model.trim()
        : "reflect-dashboard-chat";
      const chatReq: DashboardChatRequest = {
        prompt,
        ...(cameraId ? { cameraId } : {}),
        context: this.options.buildDashboardChatContext(cameraId, 2, scope),
        runtimeContext: this.options.buildDashboardRuntimeContext(cameraId, scope),
        history: this.extractOpenAIHistory(messages),
        ...(scope?.userId ? { userId: scope.userId } : {}),
        ...(scope?.sessionId ? { sessionId: scope.sessionId } : {}),
      };

      if (payload.stream === true) {
        await this.handleOpenAIChatCompletionsStream(req, res, chatReq, model);
        return;
      }

      const result = await dashboardChat(chatReq);
      if (result.error) {
        this.sendOpenAIError(res, result.statusCode ?? 500, result.error);
        return;
      }
      this.options.sendJson(res, 200, this.openAIChatCompletion(model, result.answer ?? ""));
    } catch (err) {
      this.sendOpenAIError(res, 400, err instanceof Error ? err.message : "Invalid chat completions request");
    }
  }

  async handleSemanticContext(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const getSemanticContext = this.options.getSemanticContext();
    if (!getSemanticContext) {
      this.options.sendJson(res, 503, { error: "Semantic Context service is not configured" });
      return;
    }
    try {
      const scope = this.options.scopeFromRequest(req, undefined, url);
      const cameraId = (url.searchParams.get("camera_id") ?? "").trim();
      if (!cameraId) {
        this.options.sendJson(res, 400, { error: "camera_id is required" });
        return;
      }
      if (!this.options.sourceVisibleToSession(cameraId, scope)) {
        this.options.sendJson(res, 404, { error: "Source not found" });
        return;
      }
      const result = await getSemanticContext({
        cameraId,
        ...(scope?.userId ? { userId: scope.userId } : {}),
        ...(scope?.sessionId ? { sessionId: scope.sessionId } : {}),
      });
      this.options.sendJson(res, result.statusCode ?? (result.error ? 500 : 200), result);
    } catch (err) {
      this.options.sendJson(res, 400, { error: err instanceof Error ? err.message : "Invalid Semantic Context request" });
    }
  }

  private async handleDashboardChatStream(req: IncomingMessage, res: ServerResponse, chatReq: DashboardChatRequest): Promise<void> {
    const dashboardChat = this.options.getDashboardChat();
    if (!dashboardChat) {
      this.options.sendJson(res, 503, { error: "Dashboard chat is not configured" });
      return;
    }
    let closed = false;
    let emittedDelta = false;
    req.on("close", () => {
      closed = true;
    });
    const emit = (event: DashboardChatStreamEvent) => {
      if (closed || res.destroyed) return;
      if (event.type === "delta") emittedDelta = true;
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no",
    });
    emit({ type: "status", message: "Reading dashboard state..." });
    try {
      const result = await dashboardChat({ ...chatReq, emit });
      if (result.error) {
        emit({ type: "error", error: result.error });
      } else if (result.answer && !emittedDelta) {
        for (const chunk of this.chunkChatAnswer(result.answer)) {
          emit({ type: "delta", text: chunk });
        }
      }
      emit({ type: "done", ...(result.answer ? { answer: result.answer } : {}) });
    } catch (err) {
      emit({ type: "error", error: err instanceof Error ? err.message : "Dashboard chat failed" });
      emit({ type: "done" });
    } finally {
      if (!closed && !res.destroyed) res.end();
    }
  }

  private async handleOpenAIChatCompletionsStream(
    req: IncomingMessage,
    res: ServerResponse,
    chatReq: DashboardChatRequest,
    model: string,
  ): Promise<void> {
    const dashboardChat = this.options.getDashboardChat();
    if (!dashboardChat) {
      this.sendOpenAIError(res, 503, "Dashboard chat is not configured");
      return;
    }
    let closed = false;
    req.on("close", () => {
      closed = true;
    });
    const writeChunk = (content: string) => {
      if (closed || res.destroyed || !content) return;
      res.write(`data: ${JSON.stringify(this.openAIChatCompletionChunk(model, content))}\n\n`);
    };
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no",
    });
    try {
      const result = await dashboardChat(chatReq);
      if (result.error) {
        res.write(`data: ${JSON.stringify({ error: { message: result.error, type: "dashboard_chat_error" } })}\n\n`);
      } else {
        for (const chunk of this.chunkChatAnswer(result.answer ?? "")) writeChunk(chunk);
      }
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: { message: err instanceof Error ? err.message : "Dashboard chat failed", type: "dashboard_chat_error" } })}\n\n`);
    } finally {
      if (!closed && !res.destroyed) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }
  }

  private extractOpenAIPrompt(messages: OpenAIChatMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role !== "user") continue;
      const text = this.openAIMessageContentToText(messages[i]?.content).trim();
      if (text) return text.slice(0, 2000);
    }
    return "";
  }

  private extractOpenAIHistory(messages: OpenAIChatMessage[]): DashboardChatMessage[] {
    const history: DashboardChatMessage[] = [];
    const prior = messages.slice(0, -1);
    for (const message of prior) {
      const role = message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : null;
      if (!role) continue;
      const text = this.openAIMessageContentToText(message.content).trim().slice(0, 1200);
      if (text) history.push({ role, text });
    }
    return history.slice(-8);
  }

  private openAIMessageContentToText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const item = part as Record<string, unknown>;
      if (typeof item.text === "string") return [item.text];
      return [];
    }).join("\n");
  }

  private extractOpenAICameraId(payload: Record<string, unknown>): string | undefined {
    if (typeof payload.camera_id === "string" && payload.camera_id.trim()) return payload.camera_id.trim();
    const metadata = payload.metadata && typeof payload.metadata === "object"
      ? payload.metadata as Record<string, unknown>
      : null;
    if (typeof metadata?.camera_id === "string" && metadata.camera_id.trim()) return metadata.camera_id.trim();
    return undefined;
  }

  private openAIChatCompletion(model: string, answer: string): Record<string, unknown> {
    return {
      id: `chatcmpl-${Date.now().toString(36)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: answer },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  private openAIChatCompletionChunk(model: string, content: string): Record<string, unknown> {
    return {
      id: `chatcmpl-${Date.now().toString(36)}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        delta: { content },
        finish_reason: null,
      }],
    };
  }

  private sendChatRateLimited(res: ServerResponse, retryAfterSec: number): void {
    res.setHeader("Retry-After", String(retryAfterSec));
    this.options.sendJson(res, 429, { error: "Dashboard chat rate limit exceeded", retry_after_sec: retryAfterSec });
  }

  private sendOpenAIChatRateLimited(res: ServerResponse, retryAfterSec: number): void {
    res.setHeader("Retry-After", String(retryAfterSec));
    this.sendOpenAIError(res, 429, "Dashboard chat rate limit exceeded");
  }

  private sendOpenAIError(res: ServerResponse, status: number, message: string): void {
    this.options.sendJson(res, status, {
      error: {
        message,
        type: "dashboard_chat_error",
        code: null,
      },
    });
  }

  private chunkChatAnswer(answer: string): string[] {
    const chunks = answer.match(/.{1,48}(\s|$)|.{1,48}/gs);
    return chunks && chunks.length ? chunks : [answer];
  }
}
