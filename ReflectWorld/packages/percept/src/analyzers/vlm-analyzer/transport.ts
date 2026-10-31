import {
  createLlmCallId,
  mergeLlmCallContext,
  type LlmCallAttemptRecord,
  type LlmCallContext,
  type LlmCallRecord,
  type LlmTokenUsage,
  writeStderr,
} from "@reflectworld/shared";
import {
  normalizeGeminiUsage,
  normalizeOpenAIUsage,
  retryErrorType,
  simpleHash,
  summarizeGeminiResponse,
  summarizeOpenAIResponse,
  truncateLogText,
  tryParseJsonObject,
} from "./archive.js";
import { VlmApiError } from "./errors.js";
import { extractClosedJsonValueField } from "./json.js";
import type {
  CompletionRequest,
  CompletionResult,
  GeminiRequest,
  GeminiResponse,
  LlmCallRecorder,
  OpenAIContentPart,
  OpenAIRequest,
  OpenAIResponse,
  ReasoningEffort,
  StreamTimingMeta,
} from "./types.js";

const OPENAI_GPT5_FAMILY_RE = /(?:^|\/)gpt-5(?:$|[-.])/i;
const COMPRESS_TEXT_DEFAULT_MAX_TOKENS = 2048;

export interface VlmTransportOptions {
  provider: "gemini" | "openai";
  apiKey: string;
  baseUrl?: string;
  textModel: string;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  requestTimeoutMs?: number;
  llmCallRecorder?: LlmCallRecorder;
  llmContext?: LlmCallContext;
  normalizeTitle: (title: string | undefined, fallbackSummary: string) => string;
}

export class VlmTransport {
  private static readonly RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
  private static readonly DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
  private readonly mode: "gemini" | "openai";
  private readonly apiKey: string;
  private readonly geminiBaseUrl: string;
  private readonly openaiBaseUrl: string;
  private readonly textModel: string;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly requestTimeoutMs: number;
  private llmCallRecorder?: LlmCallRecorder;
  private llmContext: LlmCallContext;
  private readonly normalizeTitleValue: (title: string | undefined, fallbackSummary: string) => string;

  constructor(options: VlmTransportOptions) {
    this.mode = options.provider;
    this.apiKey = options.apiKey;
    this.textModel = options.textModel;
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 2));
    this.retryBaseDelayMs = Math.max(0, Math.floor(options.retryBaseDelayMs ?? 600));
    this.retryMaxDelayMs = Math.max(this.retryBaseDelayMs, Math.floor(options.retryMaxDelayMs ?? 4_000));
    this.requestTimeoutMs = Math.max(
      1_000,
      Math.floor(options.requestTimeoutMs ?? VlmTransport.DEFAULT_REQUEST_TIMEOUT_MS),
    );
    this.llmCallRecorder = options.llmCallRecorder;
    this.llmContext = options.llmContext ?? {};
    this.normalizeTitleValue = options.normalizeTitle;

    if (options.provider === "openai") {
      this.openaiBaseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
      this.geminiBaseUrl = "";
    } else {
      this.openaiBaseUrl = "";
      this.geminiBaseUrl = options.baseUrl?.replace(/\/$/, "") ?? "https://generativelanguage.googleapis.com/v1beta";
    }
  }

  setLlmCallRecorder(recorder: LlmCallRecorder | undefined): void {
    this.llmCallRecorder = recorder;
  }

  setLlmContext(context: LlmCallContext): void {
    this.llmContext = { ...context };
  }


  private async callWithRetry<T>(
    op: () => Promise<T>,
    provider: "gemini" | "openai",
    onRetry?: (retryCount: number) => void,
    onAttempt?: (attempt: LlmCallAttemptRecord) => void,
  ): Promise<T> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const attemptStartedAt = Date.now();
      try {
        const result = await op();
        onAttempt?.({
          attempt: attempt + 1,
          status: "ok",
          latency_ms: Date.now() - attemptStartedAt,
        });
        return result;
      } catch (err) {
        const maxAttempts = this.maxAttemptsForError(err);
        const finalAttempt = attempt + 1 >= maxAttempts;
        const retryable = !finalAttempt && this.shouldRetry(err);
        const backoffMs = retryable ? this.computeBackoffMs(attempt) : undefined;
        const retryAfterMs = err instanceof VlmApiError ? err.retryAfterMs ?? 0 : 0;
        const delayMs = retryable ? Math.max(backoffMs ?? 0, retryAfterMs) : undefined;
        onAttempt?.({
          attempt: attempt + 1,
          status: "error",
          latency_ms: Date.now() - attemptStartedAt,
          retryable,
          ...(delayMs !== undefined ? { next_delay_ms: delayMs } : {}),
          ...(err instanceof VlmApiError && err.status !== undefined ? { http_status: err.status } : {}),
          ...(err instanceof VlmApiError ? { retry_after_ms: err.retryAfterMs ?? null } : {}),
          error_type: retryErrorType(err),
          error_message: truncateLogText(err instanceof Error ? err.message : String(err), 240),
        });
        if (!retryable) {
          throw err;
        }

        const errMsg = err instanceof Error ? err.message : String(err);
        writeStderr(
          `[vlm-analyzer] ${provider} request failed (attempt ${attempt + 1}/${maxAttempts}), retrying in ${delayMs}ms: ${errMsg}`,
        );
        onRetry?.(attempt + 1);
        await this.sleep(delayMs ?? 0);
      }
    }

    // Unreachable by construction, but keeps TS control-flow explicit.
    throw new Error("Unexpected retry flow in VlmTransport.callWithRetry");
  }

  private shouldRetry(err: unknown): boolean {
    if (err instanceof VlmApiError) {
      return err.status != null ? VlmTransport.RETRYABLE_STATUS.has(err.status) : true;
    }

    if (err instanceof Error) {
      const message = err.message.toLowerCase();
      if (this.isTimeoutLikeError(err)) return true;
      if (message.includes("network")) return true;
      if (message.includes("econn")) return true;
      if (message.includes("429") || message.includes("503") || message.includes("502") || message.includes("504")) return true;
    }

    return false;
  }

  private maxAttemptsForError(err: unknown): number {
    const configuredMaxAttempts = this.maxRetries + 1;
    return this.isTimeoutLikeError(err)
      ? Math.min(configuredMaxAttempts, 2)
      : configuredMaxAttempts;
  }

  private isTimeoutLikeError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const name = err.name.toLowerCase();
    const message = err.message.toLowerCase();
    return name.includes("abort") ||
      message.includes("aborted") ||
      message.includes("aborterror") ||
      message.includes("timeout") ||
      message.includes("etimedout");
  }

  private computeBackoffMs(attempt: number): number {
    const exponential = Math.min(this.retryMaxDelayMs, this.retryBaseDelayMs * 2 ** attempt);
    const jitter = Math.floor(exponential * 0.2 * Math.random());
    return exponential + jitter;
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private parseRetryAfterMs(headerValue: string | null): number | undefined {
    if (!headerValue) return undefined;
    const seconds = Number(headerValue);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.floor(seconds * 1000);
    }

    const dateMs = Date.parse(headerValue);
    if (!Number.isNaN(dateMs)) {
      const delta = dateMs - Date.now();
      return delta > 0 ? delta : 0;
    }

    return undefined;
  }

  private chatCompletionControls(
    model: string | undefined,
    maxTokens: number,
    temperature?: number,
    reasoningEffort?: ReasoningEffort,
  ): Pick<OpenAIRequest, "max_tokens" | "max_completion_tokens" | "temperature" | "reasoning_effort"> {
    const isGpt5Family = OPENAI_GPT5_FAMILY_RE.test(model ?? "");
    return {
      ...(isGpt5Family
        ? { max_completion_tokens: maxTokens }
        : { max_tokens: maxTokens }),
      ...(isGpt5Family && reasoningEffort != null ? { reasoning_effort: reasoningEffort } : {}),
      ...(temperature == null || isGpt5Family ? {} : { temperature }),
    };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const provider = this.mode;
    const startedAt = Date.now();
    let retryCount = 0;
    const attempts: LlmCallAttemptRecord[] = [];
    const baseCall = {
      schema_version: 1 as const,
      call_id: createLlmCallId(),
      stage: request.stage,
      provider,
      model: request.model,
      prompt_version: request.promptVersion,
      request: this.buildCallRequestMeta(request),
      created_at: new Date(startedAt).toISOString(),
    };
    try {
      const result = await this.callWithRetry(
        () => provider === "openai"
          ? (request.stream ? this.completeOpenAIWithStreamFallback(request) : this.completeOpenAI(request))
          : (request.stream ? this.completeGeminiWithStreamFallback(request) : this.completeGemini(request)),
        provider,
        (count) => { retryCount = count; },
        (attempt) => { attempts.push(attempt); },
      );
      const call = mergeLlmCallContext({
        ...baseCall,
        usage: result.usage,
        latency_ms: Date.now() - startedAt,
        status: "ok",
        retry_count: retryCount,
        attempts,
        error: null,
      }, { ...this.llmContext, ...request.context });
      this.recordLlmCall(call);
      return { text: result.text, call };
    } catch (err) {
      const apiErr = err instanceof VlmApiError ? err : undefined;
      const call = mergeLlmCallContext({
        ...baseCall,
        usage: apiErr?.usage ?? null,
        latency_ms: Date.now() - startedAt,
        status: "error",
        retry_count: retryCount,
        attempts,
        error: err instanceof Error ? err.message : String(err),
        ...(apiErr?.details ? { error_details: apiErr.details } : {}),
      }, { ...this.llmContext, ...request.context });
      this.recordLlmCall(call);
      throw err;
    }
  }

  private buildCallRequestMeta(request: CompletionRequest): LlmCallRecord["request"] {
    const frameCount = request.frames?.length ?? 0;
    const extraImageCount = request.extraImages?.length ?? 0;
    const contentPartImageCount = request.contentParts?.filter((part) => part.type === "image").length;
    const imageCount = contentPartImageCount ?? (frameCount + extraImageCount);
    const controls: Pick<OpenAIRequest, "max_tokens" | "max_completion_tokens" | "temperature" | "reasoning_effort"> = this.mode === "openai"
      ? this.chatCompletionControls(request.model, request.maxTokens, request.temperature, request.reasoningEffort)
      : {};
    return {
      response_format: request.responseFormat,
      max_tokens: controls.max_tokens,
      max_completion_tokens: controls.max_completion_tokens,
      max_output_tokens: this.mode === "gemini" ? request.maxTokens : undefined,
      request_timeout_ms: this.requestTimeoutMs,
      max_retries: this.maxRetries,
      reasoning_effort: controls.reasoning_effort,
      temperature: request.temperature ?? null,
      image_count: imageCount,
      frame_count: frameCount,
      extra_image_count: extraImageCount,
      provider_options: request.providerOptions ?? undefined,
      has_detection_context: request.hasDetectionContext ?? false,
      has_working_memory_images: request.hasWorkingMemoryImages ?? extraImageCount > 0,
      fallback_layer: request.fallbackLayer,
      target_aggregation: request.targetAggregation,
      prompt_hash: simpleHash(this.promptTextForHash(request)),
    };
  }

  private promptTextForHash(request: CompletionRequest): string {
    if (!request.contentParts?.length) return request.prompt;
    return request.contentParts
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n\n");
  }

  private recordLlmCall(call: LlmCallRecord): void {
    try {
      this.llmCallRecorder?.(call);
    } catch (err) {
      writeStderr(`[vlm-analyzer] LLM call recorder failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async emitStreamPart(request: CompletionRequest, textSoFar: string, emitted: Set<string>, timing: StreamTimingMeta): Promise<void> {
    if (!request.onPartial) return;
    const emit = async (field: string, value: unknown): Promise<void> => {
      if (emitted.has(field)) return;
      emitted.add(field);
      try {
        const receivedAt = Date.now();
        await request.onPartial?.({
          field,
          value,
          received_at: receivedAt,
          request_started_at: timing.requestStartedAt,
          ttft_ms: timing.firstChunkAt === undefined ? undefined : timing.firstChunkAt - timing.requestStartedAt,
          first_content_ms: timing.firstContentAt === undefined ? undefined : timing.firstContentAt - timing.requestStartedAt,
        });
      } catch (err) {
        writeStderr(`[vlm-analyzer] partial callback failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    const title = extractClosedJsonValueField(textSoFar, "title");
    if (typeof title === "string" && title.trim()) await emit("title", this.normalizeTitleValue(title, title));

    const summary = extractClosedJsonValueField(textSoFar, "summary");
    if (typeof summary === "string" && summary.trim()) await emit("summary", summary.trim());

    const securityRisk = extractClosedJsonValueField(textSoFar, "security_risk");
    if (typeof securityRisk === "boolean") await emit("security_risk", securityRisk);

    const isStaticScene = extractClosedJsonValueField(textSoFar, "is_static_scene");
    if (typeof isStaticScene === "boolean") await emit("is_static_scene", isStaticScene);

    const securityReason = extractClosedJsonValueField(textSoFar, "security_reason");
    if (typeof securityReason === "string" && securityReason.trim()) await emit("security_reason", securityReason.trim());

    const notifyUser = extractClosedJsonValueField(textSoFar, "notify_user");
    if (typeof notifyUser === "boolean") await emit("notify_user", notifyUser);

    const matchedRuleIds = extractClosedJsonValueField(textSoFar, "matched_rule_ids");
    if (Array.isArray(matchedRuleIds)) {
      await emit("matched_rule_ids", matchedRuleIds.filter((id): id is string => typeof id === "string" && id.length > 0));
    }

    const bestFrameIndex = extractClosedJsonValueField(textSoFar, "best_frame_index");
    if (typeof bestFrameIndex === "number" && Number.isFinite(bestFrameIndex)) await emit("best_frame_index", bestFrameIndex);

    // Metrics-only fields. These are intentionally not rendered directly by
    // Dashboard partials, but their arrival times determine whether source-local
    // early release can ever be safe or worthwhile.
    const mainTargets = extractClosedJsonValueField(textSoFar, "main_targets");
    if (Array.isArray(mainTargets)) await emit("main_targets", mainTargets);

    // Newer prompts may call the same payload "targets"; record it separately
    // so the instrumentation still works while the output contract settles.
    const targets = extractClosedJsonValueField(textSoFar, "targets");
    if (Array.isArray(targets)) await emit("targets", targets);

    const eventBoundary = extractClosedJsonValueField(textSoFar, "event_boundary");
    if (typeof eventBoundary === "boolean") await emit("event_boundary", eventBoundary);

  }

  private async readSseData(response: Response, onData: (data: string) => void | Promise<void>): Promise<void> {
    if (!response.body) throw new VlmApiError("Streaming response missing body", { status: response.status });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const flushBlock = async (block: string): Promise<void> => {
      const dataLines = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart());
      if (dataLines.length === 0) return;
      const data = dataLines.join("\n").trim();
      if (!data || data === "[DONE]") return;
      await onData(data);
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sepIndex: number;
      while ((sepIndex = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, sepIndex);
        const match = buffer.slice(sepIndex).match(/^\r?\n\r?\n/);
        buffer = buffer.slice(sepIndex + (match?.[0].length ?? 2));
        await flushBlock(block);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) await flushBlock(buffer);
  }

  private buildOpenAIContent(request: CompletionRequest): string | OpenAIContentPart[] {
    if (request.contentParts?.length) {
      const hasImages = request.contentParts.some((part) => part.type === "image");
      if (!hasImages) {
        return request.contentParts
          .filter((part): part is { type: "text"; text: string } => part.type === "text")
          .map((part) => part.text)
          .join("\n\n");
      }
      return request.contentParts.map((part): OpenAIContentPart => {
        if (part.type === "text") return { type: "text", text: part.text };
        return {
          type: "image_url",
          image_url: {
            url: `data:image/jpeg;base64,${part.base64}`,
            ...(part.detail ? { detail: part.detail } : {}),
          },
        };
      });
    }

    const frames = request.frames ?? [];
    const extraImages = request.extraImages ?? [];
    if (frames.length === 0 && extraImages.length === 0) return request.prompt;

    const content: OpenAIContentPart[] = [{ type: "text", text: request.prompt }];
    const appendExtraImages = () => {
      if (extraImages.length === 0) return;
      if (request.extraImageHeader) {
        content.push({ type: "text", text: request.extraImageHeader });
      }
      for (const image of extraImages) {
        if (image.label) content.push({ type: "text", text: image.label });
        content.push({
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${image.base64}` },
        });
      }
    };

    if (request.extraImagesPlacement === "before_frames") appendExtraImages();

    // Some OpenAI-compatible providers reject `detail` on multi-image requests.
    // Keep explicit high detail for single-frame analysis and omit it otherwise.
    const frameDetail = frames.length === 1 ? "high" : undefined;
    for (const frame of frames) {
      const image_url: { url: string; detail?: string } = { url: `data:image/jpeg;base64,${frame.data}` };
      if (frameDetail) image_url.detail = frameDetail;
      content.push({
        type: "image_url",
        image_url,
      });
    }
    if (request.extraImagesPlacement !== "before_frames") appendExtraImages();
    return content;
  }

  private buildGeminiParts(request: CompletionRequest): GeminiRequest["contents"][0]["parts"] {
    if (request.contentParts?.length) {
      return request.contentParts.map((part) => {
        if (part.type === "text") return { text: part.text };
        return { inline_data: { mime_type: "image/jpeg", data: part.base64 } };
      });
    }

    const parts: GeminiRequest["contents"][0]["parts"] = [{ text: request.prompt }];
    const extraImages = request.extraImages ?? [];
    const appendExtraImages = () => {
      if (extraImages.length === 0) return;
      if (request.extraImageHeader) parts.push({ text: request.extraImageHeader });
      for (const image of extraImages) {
        if (image.label) parts.push({ text: image.label });
        parts.push({ inline_data: { mime_type: "image/jpeg", data: image.base64 } });
      }
    };

    if (request.extraImagesPlacement === "before_frames") appendExtraImages();
    for (const frame of request.frames ?? []) {
      parts.push({ inline_data: { mime_type: "image/jpeg", data: frame.data } });
    }
    if (request.extraImagesPlacement !== "before_frames") appendExtraImages();
    return parts;
  }

  private async completeOpenAIWithStreamFallback(request: CompletionRequest): Promise<{ text: string; usage: LlmTokenUsage | null }> {
    try {
      return await this.completeOpenAIStream(request, true);
    } catch (err) {
      writeStderr(`[vlm-analyzer] OpenAI stream failed, falling back to non-streaming: ${err instanceof Error ? err.message : String(err)}`);
      return this.completeOpenAI({ ...request, stream: false, onPartial: undefined });
    }
  }

  private async completeOpenAIStream(request: CompletionRequest, includeUsage: boolean): Promise<{ text: string; usage: LlmTokenUsage | null }> {
    const requestBody: OpenAIRequest = {
      model: request.model,
      messages: [{ role: "user", content: this.buildOpenAIContent(request) }],
      ...(request.responseFormat === "json" ? { response_format: { type: "json_object" } } : {}),
      ...this.chatCompletionControls(request.model, request.maxTokens, request.temperature, request.reasoningEffort),
      ...(request.providerOptions?.openaiCompat ?? {}),
      stream: true,
      ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
    };

    const { url, headers } = this.buildOpenAIRequest(request.model);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const startedAt = Date.now();
    let content = "";
    let usage: LlmTokenUsage | null = null;
    const emitted = new Set<string>();
    let firstChunkAt: number | undefined;
    let firstContentAt: number | undefined;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errBody = await response.text();
        if (includeUsage && response.status === 400) {
          return this.completeOpenAIStream(request, false);
        }
        throw new VlmApiError(`OpenAI stream API ${response.status}: ${errBody}`, {
          status: response.status,
          retryAfterMs: this.parseRetryAfterMs(response.headers.get("retry-after")),
          details: {
            provider: "openai",
            http_status: response.status,
            retry_after_ms: this.parseRetryAfterMs(response.headers.get("retry-after")) ?? null,
            response_body_preview: truncateLogText(errBody),
          },
        });
      }

      await this.readSseData(response, async (data) => {
        firstChunkAt ??= Date.now();
        const chunk = tryParseJsonObject(data);
        const delta = chunk?.choices && Array.isArray(chunk.choices)
          ? (chunk.choices[0] as Record<string, unknown> | undefined)?.delta as Record<string, unknown> | undefined
          : undefined;
        const text = typeof delta?.content === "string" ? delta.content : "";
        if (text) {
          firstContentAt ??= Date.now();
          content += text;
          await this.emitStreamPart(request, content, emitted, { requestStartedAt: startedAt, firstChunkAt, firstContentAt });
        }
        if (chunk?.usage && typeof chunk.usage === "object") {
          usage = normalizeOpenAIUsage(chunk.usage as OpenAIResponse["usage"]);
        }
      });

      if (request.responseFormat === "json" && !content.trim()) {
        throw new VlmApiError("OpenAI stream returned empty JSON response", {
          status: response.status,
          usage,
          details: { provider: "openai", http_status: response.status, reason: "empty_json_response" },
        });
      }
      return { text: content, usage };
    } finally {
      clearTimeout(timer);
    }
  }

  private async completeOpenAI(request: CompletionRequest): Promise<{ text: string; usage: LlmTokenUsage | null }> {
    const requestBody: OpenAIRequest = {
      model: request.model,
      messages: [{ role: "user", content: this.buildOpenAIContent(request) }],
      ...(request.responseFormat === "json" ? { response_format: { type: "json_object" } } : {}),
      ...this.chatCompletionControls(request.model, request.maxTokens, request.temperature, request.reasoningEffort),
      ...(request.providerOptions?.openaiCompat ?? {}),
    };

    const { url, headers } = this.buildOpenAIRequest(request.model);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errBody = await response.text();
        const parsedError = tryParseJsonObject(errBody);
        const providerError = parsedError?.error && typeof parsedError.error === "object"
          ? parsedError.error as Record<string, unknown>
          : undefined;
        throw new VlmApiError(`OpenAI API ${response.status}: ${errBody}`, {
          status: response.status,
          retryAfterMs: this.parseRetryAfterMs(response.headers.get("retry-after")),
          details: {
            provider: "openai",
            http_status: response.status,
            retry_after_ms: this.parseRetryAfterMs(response.headers.get("retry-after")) ?? null,
            error_type: providerError?.type ?? null,
            error_code: providerError?.code ?? null,
            error_param: providerError?.param ?? null,
            error_message: providerError?.message ?? null,
            response_body_preview: truncateLogText(errBody),
          },
        });
      }

      const openaiResp = (await response.json()) as OpenAIResponse;
      const usage = normalizeOpenAIUsage(openaiResp.usage);
      const content = openaiResp.choices?.[0]?.message?.content ?? "";
      if (request.responseFormat === "json" && !content.trim()) {
        throw new VlmApiError("OpenAI API returned empty JSON response", {
          status: response.status,
          usage,
          details: {
            provider: "openai",
            http_status: response.status,
            reason: "empty_json_response",
            response: summarizeOpenAIResponse(openaiResp),
            response_preview: truncateLogText(JSON.stringify(openaiResp)),
          },
        });
      }
      return { text: content, usage };
    } finally {
      clearTimeout(timer);
    }
  }

  private async completeGemini(request: CompletionRequest): Promise<{ text: string; usage: LlmTokenUsage | null }> {
    const generationConfig: GeminiRequest["generationConfig"] = {
      ...(request.responseFormat === "json" ? { responseMimeType: "application/json" } : {}),
      maxOutputTokens: request.maxTokens,
      ...(request.temperature == null ? {} : { temperature: request.temperature }),
    };
    const requestBody: GeminiRequest = {
      contents: [{ role: "user", parts: this.buildGeminiParts(request) }],
      generationConfig,
    };

    const { url, headers } = this.buildGeminiRequest(request.model);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errBody = await response.text();
        const parsedError = tryParseJsonObject(errBody);
        const providerError = parsedError?.error && typeof parsedError.error === "object"
          ? parsedError.error as Record<string, unknown>
          : undefined;
        throw new VlmApiError(`Gemini API ${response.status}: ${errBody}`, {
          status: response.status,
          retryAfterMs: this.parseRetryAfterMs(response.headers.get("retry-after")),
          details: {
            provider: "gemini",
            http_status: response.status,
            retry_after_ms: this.parseRetryAfterMs(response.headers.get("retry-after")) ?? null,
            error_type: providerError?.status ?? providerError?.type ?? null,
            error_code: providerError?.code ?? null,
            error_message: providerError?.message ?? null,
            response_body_preview: truncateLogText(errBody),
          },
        });
      }

      const geminiResp = (await response.json()) as GeminiResponse;
      const usage = normalizeGeminiUsage(geminiResp.usageMetadata);
      const content = geminiResp.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      if (request.responseFormat === "json" && !content.trim()) {
        throw new VlmApiError("Gemini API returned empty JSON response", {
          status: response.status,
          usage,
          details: {
            provider: "gemini",
            http_status: response.status,
            reason: "empty_json_response",
            response: summarizeGeminiResponse(geminiResp),
            response_preview: truncateLogText(JSON.stringify(geminiResp)),
          },
        });
      }
      return { text: content, usage };
    } finally {
      clearTimeout(timer);
    }
  }

  private async completeGeminiWithStreamFallback(request: CompletionRequest): Promise<{ text: string; usage: LlmTokenUsage | null }> {
    try {
      return await this.completeGeminiStream(request);
    } catch (err) {
      writeStderr(`[vlm-analyzer] Gemini stream failed, falling back to non-streaming: ${err instanceof Error ? err.message : String(err)}`);
      return this.completeGemini({ ...request, stream: false, onPartial: undefined });
    }
  }

  private async completeGeminiStream(request: CompletionRequest): Promise<{ text: string; usage: LlmTokenUsage | null }> {
    const generationConfig: GeminiRequest["generationConfig"] = {
      ...(request.responseFormat === "json" ? { responseMimeType: "application/json" } : {}),
      maxOutputTokens: request.maxTokens,
      ...(request.temperature == null ? {} : { temperature: request.temperature }),
    };
    const requestBody: GeminiRequest = {
      contents: [{ role: "user", parts: this.buildGeminiParts(request) }],
      generationConfig,
    };

    const { url: baseUrl, headers } = this.buildGeminiRequest(request.model);
    const url = `${baseUrl.replace(/:generateContent$/, ":streamGenerateContent")}?alt=sse`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let content = "";
    let usage: LlmTokenUsage | null = null;
    const emitted = new Set<string>();
    const startedAt = Date.now();
    let firstChunkAt: number | undefined;
    let firstContentAt: number | undefined;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errBody = await response.text();
        throw new VlmApiError(`Gemini stream API ${response.status}: ${errBody}`, {
          status: response.status,
          retryAfterMs: this.parseRetryAfterMs(response.headers.get("retry-after")),
          details: {
            provider: "gemini",
            http_status: response.status,
            retry_after_ms: this.parseRetryAfterMs(response.headers.get("retry-after")) ?? null,
            response_body_preview: truncateLogText(errBody),
          },
        });
      }

      await this.readSseData(response, async (data) => {
        firstChunkAt ??= Date.now();
        const chunk = tryParseJsonObject(data) as GeminiResponse | undefined;
        const text = chunk?.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
        if (text) {
          firstContentAt ??= Date.now();
          content += text;
          await this.emitStreamPart(request, content, emitted, { requestStartedAt: startedAt, firstChunkAt, firstContentAt });
        }
        if (chunk?.usageMetadata) {
          usage = normalizeGeminiUsage(chunk.usageMetadata);
        }
      });

      if (request.responseFormat === "json" && !content.trim()) {
        throw new VlmApiError("Gemini stream returned empty JSON response", {
          status: response.status,
          usage,
          details: { provider: "gemini", http_status: response.status, reason: "empty_json_response" },
        });
      }
      return { text: content, usage };
    } finally {
      clearTimeout(timer);
    }
  }

  private buildOpenAIRequest(_model: string): { url: string; headers: Record<string, string> } {
    return {
      url: `${this.openaiBaseUrl}/chat/completions`,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
    };
  }

  private buildGeminiRequest(model: string): { url: string; headers: Record<string, string> } {
    return {
      url: `${this.geminiBaseUrl}/models/${model}:generateContent`,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.apiKey!,
      },
    };
  }

  /** Text-only completion through the shared provider transport. */
  async completeText(
    prompt: string,
    options?: {
      responseFormat?: "json" | "text";
      maxTokens?: number;
      reasoningEffort?: ReasoningEffort;
      providerOptions?: {
        openaiCompat?: Record<string, unknown>;
      };
      temperature?: number;
      model?: string;
      stage?: string;
      promptVersion?: string;
      llmContext?: LlmCallContext;
    },
  ): Promise<string> {
    const maxTokens = options?.maxTokens ?? COMPRESS_TEXT_DEFAULT_MAX_TOKENS;
    const result = await this.complete({
      model: options?.model ?? this.textModel,
      prompt,
      responseFormat: options?.responseFormat ?? "text",
      maxTokens,
      reasoningEffort: options?.reasoningEffort,
      providerOptions: options?.providerOptions,
      temperature: options?.temperature,
      stage: options?.stage ?? "percept.compress_text",
      promptVersion: options?.promptVersion,
      context: options?.llmContext,
    });
    return result.text;
  }
}
