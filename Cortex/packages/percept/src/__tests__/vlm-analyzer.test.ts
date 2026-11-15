// packages/percept/src/__tests__/vlm-analyzer.test.ts
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { VlmAnalyzer } from "../analyzers/vlm-analyzer.js";
import type { Frame } from "@cortex/shared";

function makeFrames(count: number): Frame[] {
  return Array.from({ length: count }, (_, i) => ({
    data: `base64jpeg_frame_${i}`,
    timestamp: Date.now() + i * 1000,
    index: i,
  }));
}

function geminiTextParts(parts: Array<Record<string, unknown>>): string {
  return parts
    .map((part) => typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n\n");
}

function geminiInlineImages(parts: Array<Record<string, unknown>>): Array<{ inline_data: { data: string } }> {
  return parts.filter((part): part is { inline_data: { data: string } } => Boolean(part.inline_data));
}

function openAIImageParts(content: Array<Record<string, unknown>>): Array<{ image_url: { url: string; detail?: string } }> {
  return content.filter((part): part is { image_url: { url: string; detail?: string } } => part.type === "image_url");
}

function openAITextParts(content: Array<Record<string, unknown>>): string {
  return content
    .map((part) => part.type === "text" && typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n\n");
}

const MOCK_VLM_RESPONSE = JSON.stringify({
  summary: "A person in a blue jacket is standing at the front door.",
  detailed_summary: "A person wearing a blue jacket arrived at the front door at daytime. They appear to be ringing the doorbell.",
  security_risk: false,
  main_targets: [{ type: "person", appearance: "blue jacket", behavior: "ringing doorbell" }],
});

function openAISseResponse(chunks: Array<Record<string, unknown> | "[DONE]">): Response {
  const body = chunks
    .map((chunk) => `data: ${chunk === "[DONE]" ? "[DONE]" : JSON.stringify(chunk)}\n\n`)
    .join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("VlmAnalyzer", () => {
  let analyzer: VlmAnalyzer;
  let fetchMock: Mock;

  beforeEach(() => {
    analyzer = new VlmAnalyzer({ provider: "gemini", apiKey: "test-key", textModel: "gemini-2.5-flash", maxRetries: 0 });

    fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: MOCK_VLM_RESPONSE }] } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a successful VlmSegmentAnalysis with VlmOutput", async () => {
    const result = await analyzer.analyzeSegment(makeFrames(2), "gemini-2.5-flash-lite");
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);

    const data = result.output;
    expect(data.summary).toContain("blue jacket");
    expect(data.security_risk).toBe(false);
    expect(data.main_targets).toHaveLength(1);
    expect(data.main_targets[0]?.type).toBe("person");
  });

  it("allows matched procedural rule ids containing colons", async () => {
    analyzer.setUserRules([
      "rule_id=rule:door:after-hours: Notify when the door opens after hours.",
      "rule_id=rule-simple: Notify when a pet appears.",
    ].join("\n"));
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  summary: "The door opened after hours.",
                  detailed_summary: "The door opened after hours.",
                  security_risk: false,
                  main_targets: [],
                  matched_rule_ids: ["rule:door:after-hours", "rule:hallucinated"],
                }),
              }],
            },
          }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await analyzer.analyzeSegment(makeFrames(1), "gemini-2.5-flash-lite");

    expect(result.output.matched_rule_ids).toEqual(["rule:door:after-hours"]);
  });

  it("includes scene context in the prompt when provided", async () => {
    await analyzer.analyzeSegment(makeFrames(1), "gemini-2.5-flash-lite", {
      sceneContext: "Hallway, daytime",
    });

    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    const callBody = JSON.parse(callArgs[1].body as string);
    const textPart = callBody.contents[0].parts[0].text as string;
    expect(textPart).toContain("Hallway, daytime");
  });

  it("includes event-summary working memory in the prompt", async () => {
    await analyzer.analyzeSegment(makeFrames(2), "gemini-2.5-flash-lite", {
      currentEventSummary: "The presenter (entity_id=person_1) introduces the topic.",
      recentSegmentSummaries: ["[seg_001] Presenter points at the slide."],
    });

    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    const callBody = JSON.parse(callArgs[1].body as string);
    const textPart = callBody.contents[0].parts[0].text as string;
    expect(textPart).toContain("Current event summary before this segment");
    expect(textPart).toContain("entity_id=person_1");
    expect(textPart).toContain("event_summary");
    expect(textPart).toContain("max 15 words");
    expect(textPart).toContain("max 60 words");
    expect(textPart).toContain("under 100 words");
    expect(textPart).toContain("These limits are mandatory");
    expect(textPart).toContain("Do not list every visible text item");
    expect(textPart).toContain("Natural-language chronological description");
    expect(textPart).toContain("Describe only what is visible or said in THIS segment");
    expect(textPart).toContain("Do not copy prior-context-only facts into detailed_summary");
    expect(textPart).toContain("Preserve ordering");
    expect(textPart).toContain("newly introduced topics");
    expect(textPart).toContain("no new meaningful visual, text, or audio information");
    expect(textPart).toContain("too broad to preserve its important video content");
    expect(textPart).toContain("event_summary must describe the new event starting from this segment");
    expect(textPart).toContain("verify word counts");
    expect(textPart).toContain("never use track_id as entity_id");
    expect(textPart).toContain("never mention track_id in summary, detailed_summary, or event_summary");
  });

  it("instructs VLM not to write track_id as entity_id when no stable entity id exists", async () => {
    await analyzer.analyzeSegment(makeFrames(2), "gemini-2.5-flash-lite", {
      localModelResults: {
        tracks: [{
          track_id: "track_1",
          class_name: "person",
          keyframe_idx: 0,
          keyframe_bbox: { x: 10, y: 20, width: 30, height: 40 },
        }],
      },
    });

    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    const callBody = JSON.parse(callArgs[1].body as string);
    const textPart = callBody.contents[0].parts[0].text as string;
    expect(textPart).toContain('"track_id": "track_1"');
    expect(textPart).toContain("track_id is a temporary per-segment subject label");
    expect(textPart).toContain("Do NOT write track_id in summary, detailed_summary, event_summary");
    expect(textPart).toContain("Never format a track_id as (entity_id=...)");
    expect(textPart).toContain("Stable entity IDs available now: (none)");
    expect(textPart).toContain("event_summary must contain no entity_id annotation");
  });

  it("lists stable entity IDs from ReID as allowed event_summary annotations", async () => {
    await analyzer.analyzeSegment(makeFrames(2), "gemini-2.5-flash-lite", {
      localModelResults: {
        tracks: [{
          track_id: "track_1",
          class_name: "person",
          keyframe_idx: 0,
          keyframe_bbox: { x: 10, y: 20, width: 30, height: 40 },
          entity_id: "person_1",
        }],
      },
    });

    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    const callBody = JSON.parse(callArgs[1].body as string);
    const textPart = callBody.contents[0].parts[0].text as string;
    expect(textPart).toContain('"entity_id": "person_1"');
    expect(textPart).toContain("Stable entity IDs available now: person_1");
    expect(textPart).toContain("Only write (entity_id=...) in event_summary for stable IDs explicitly present in target.entity_id");
  });

  it("does not expose ReID display labels to the VLM prompt", async () => {
    await analyzer.analyzeSegment(makeFrames(2), "gemini-2.5-flash-lite", {
      localModelResults: {
        tracks: [{
          track_id: "track_1",
          class_name: "person",
          keyframe_idx: 0,
          keyframe_bbox: { x: 10, y: 20, width: 30, height: 40 },
          entity_id: "person_1",
          display_index: 7,
          display_name: "Person 7",
          first_seen: "2026-06-04T00:00:00Z",
        } as any],
      },
    });

    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    const callBody = JSON.parse(callArgs[1].body as string);
    const textPart = callBody.contents[0].parts[0].text as string;
    expect(textPart).toContain('"entity_id": "person_1"');
    expect(textPart).not.toContain("display_name");
    expect(textPart).not.toContain("display_index");
    expect(textPart).not.toContain("Person 7");
    expect(textPart).not.toContain("first_seen");
  });

  it("parses and normalizes event_summary", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify({
            summary: "Segment summary",
            event_summary: "The presenter (entity_id=person_1) continues explaining.\n",
          }) }] } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await analyzer.analyzeSegment(makeFrames(1), "gemini-2.5-flash-lite");
    const data = result.output;
    expect(data.event_summary).toBe("The presenter (entity_id=person_1) continues explaining.");
  });

  it("preserves event_summary entity annotations without logic-based ID cleanup", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify({
            summary: "Segment summary",
            event_summary: "The presenter (entity_id=made_up) continues explaining.",
          }) }] } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await analyzer.analyzeSegment(makeFrames(1), "gemini-2.5-flash-lite");
    const data = result.output;
    expect(data.event_summary).toBe("The presenter (entity_id=made_up) continues explaining.");
  });

  it("sends all frames to VLM without subsampling", async () => {
    await analyzer.analyzeSegment(makeFrames(10), "gemini-2.5-flash-lite");

    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    const callBody = JSON.parse(callArgs[1].body as string);
    const frameParts = geminiInlineImages(callBody.contents[0].parts);
    expect(frameParts.length).toBe(10);
  });

  it("returns available=false on API error", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 }),
    );

    await expect(analyzer.analyzeSegment(makeFrames(1), "gemini-2.5-flash-lite"))
      .rejects.toThrow("500");
  });

  it("returns available=false on network failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Network timeout"));

    await expect(analyzer.analyzeSegment(makeFrames(1), "gemini-2.5-flash-lite"))
      .rejects.toThrow("Network timeout");
  });

  it("retries retryable Gemini errors (429) and eventually succeeds", async () => {
    const calls: any[] = [];
    const retryingAnalyzer = new VlmAnalyzer({
      provider: "gemini",
      apiKey: "test-key",
      textModel: "gemini-2.5-flash",
      maxRetries: 2,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0,
      requestTimeoutMs: 5_000,
      llmCallRecorder: (call) => calls.push(call),
    });

    fetchMock
      .mockResolvedValueOnce(
        new Response("Too Many Requests", { status: 429, headers: { "retry-after": "0" } }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: MOCK_VLM_RESPONSE }] } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const result = await retryingAnalyzer.analyzeSegment(makeFrames(1), "gemini-2.5-flash-lite");
    expect(result.output.summary).toContain("blue jacket");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      status: "ok",
      retry_count: 1,
      request: {
        request_timeout_ms: 5_000,
        max_retries: 2,
      },
      attempts: [
        {
          attempt: 1,
          status: "error",
          retryable: true,
          http_status: 429,
          retry_after_ms: 0,
          next_delay_ms: 0,
          error_type: "http_429",
        },
        {
          attempt: 2,
          status: "ok",
        },
      ],
    });
    expect(calls[0].attempts[0].latency_ms).toBeGreaterThanOrEqual(0);
    expect(calls[0].attempts[1].latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("retries aborted Gemini requests", async () => {
    const retryingAnalyzer = new VlmAnalyzer({
      provider: "gemini",
      apiKey: "test-key",
      textModel: "gemini-2.5-flash",
      maxRetries: 1,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0,
    });
    const abortErr = new Error("This operation was aborted");
    abortErr.name = "AbortError";
    fetchMock.mockRejectedValueOnce(abortErr);

    const result = await retryingAnalyzer.analyzeSegment(makeFrames(1), "gemini-2.5-flash-lite");
    expect(result.output.summary).toContain("blue jacket");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("only retries aborted requests once even when maxRetries is higher", async () => {
    const retryingAnalyzer = new VlmAnalyzer({
      provider: "gemini",
      apiKey: "test-key",
      textModel: "gemini-2.5-flash",
      maxRetries: 2,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0,
    });
    const abortErr = new Error("This operation was aborted");
    abortErr.name = "AbortError";
    fetchMock.mockRejectedValue(abortErr);

    await expect(retryingAnalyzer.analyzeSegment(makeFrames(1), "gemini-2.5-flash-lite"))
      .rejects.toThrow("This operation was aborted");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retryable Gemini errors (400)", async () => {
    const retryingAnalyzer = new VlmAnalyzer({
      provider: "gemini",
      apiKey: "test-key",
      textModel: "gemini-2.5-flash",
      maxRetries: 2,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0,
    });

    fetchMock.mockResolvedValueOnce(
      new Response("Bad Request", { status: 400 }),
    );

    await expect(retryingAnalyzer.analyzeSegment(makeFrames(1), "gemini-2.5-flash-lite"))
      .rejects.toThrow("400");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses Gemini API key endpoint when configured", async () => {
    const geminiAnalyzer = new VlmAnalyzer({
      provider: "gemini",
      apiKey: "test-key",
      textModel: "gemini-2.5-flash",
    });

    await geminiAnalyzer.analyzeSegment(makeFrames(1), "gemini-2.5-flash");

    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = callArgs[0];
    const headers = callArgs[1].headers as Record<string, string>;

    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect(headers["x-goog-api-key"]).toBe("test-key");
  });

  it("uses Gemini API endpoint with key in header when apiKey is provided", async () => {
    await analyzer.analyzeSegment(makeFrames(1), "gemini-2.5-flash-lite");

    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = callArgs[0];
    const headers = callArgs[1].headers as Record<string, string>;
    expect(url).toContain("generativelanguage.googleapis.com");
    expect(url).not.toContain("key=");
    expect(headers["x-goog-api-key"]).toBe("test-key");
  });

  it("handles missing main_targets gracefully", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: "Empty room" }) }] } }],
        }),
        { status: 200 },
      ),
    );

    const result = await analyzer.analyzeSegment(makeFrames(1), "gemini-2.5-flash-lite");
    const data = result.output;
    expect(data.main_targets).toEqual([]);
    expect(data.security_risk).toBe(false);
  });

  it("merges split target_details into main_targets", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  title: "Hallway Entry",
                  summary: "A person enters the hallway.",
                  security_risk: false,
                  main_targets: [{ type: "person", track_id: "track_1" }],
                  target_details: [{
                    target_ref: "track_1",
                    appearance: "dark jacket",
                    behavior: "walking through the hallway",
                  }],
                }),
              }],
            },
          }],
        }),
        { status: 200 },
      ),
    );

    const result = await analyzer.analyzeSegment(makeFrames(1), "gemini-2.5-flash-lite");
    expect(result.output.main_targets[0]).toMatchObject({
      type: "person",
      track_id: "track_1",
      appearance: "dark jacket",
      behavior: "walking through the hallway",
    });
  });

  it("keeps main target descriptions inline in the default prompt contract", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: MOCK_VLM_RESPONSE }] } }],
        }),
        { status: 200 },
      ),
    );

    await analyzer.analyzeSegment(makeFrames(2), "gemini-2.5-flash-lite");

    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    const callBody = JSON.parse(callArgs[1].body as string);
    const prompt = callBody.contents[0].parts[0].text as string;
    expect(prompt).toContain("appearance: objective visual features");
    expect(prompt).toContain("behavior: chronological actions across frames");
    expect(prompt).not.toContain("target_details");
    expect(prompt).toContain(
      "JSON fields in this order: title, summary, security_risk, security_reason, notify_user, matched_rule_ids, detailed_summary, retrieval_compact, main_targets, content_type, key_modality, is_static_scene, event_boundary, best_frame_index, custom_fields, event_summary, event_context_update.",
    );
  });

  it("uses split target_details in the live latency prompt contract", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: MOCK_VLM_RESPONSE }] } }],
        }),
        { status: 200 },
      ),
    );

    await analyzer.analyzeSegment(makeFrames(2), "gemini-2.5-flash-lite", { runtimeMode: "live_latency" });

    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    const callBody = JSON.parse(callArgs[1].body as string);
    const prompt = callBody.contents[0].parts[0].text as string;
    expect(prompt).toContain("Main Targets");
    expect(prompt).toContain("identity/structure fields only");
    expect(prompt).toContain("target_details");
    expect(prompt).toContain("Always output title, summary, security_risk");
    expect(prompt).toContain("Use [] for main_targets");
    expect(prompt).toContain(
      "JSON fields in this order: title, summary, security_risk, is_static_scene, notify_user, matched_rule_ids, best_frame_index, main_targets, event_boundary, security_reason, detailed_summary, retrieval_compact, event_summary, event_context_update, target_details, segment_policy_exit_met, content_type, key_modality, custom_fields.",
    );
  });

  it("falls back to raw text when the model returns malformed JSON", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{ "summary": "A person walks through the hallway' }] } }],
        }),
        { status: 200 },
      ),
    );

    const result = await analyzer.analyzeSegment(makeFrames(2), "gemini-2.5-flash-lite");

    const data = result.output;
    expect(data.summary).toBe("A person walks through the hallway");
    expect(data.main_targets).toEqual([]);
  });

  it("repairs Gemini JSON wrapped in fences with trailing commas", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [{
            content: {
              parts: [{
                text: "```json\n{\"summary\":\"Porch\",\"detailed_summary\":\"A person stands outside.\",\"main_targets\":[],\"is_static_scene\":false,}\n```",
              }],
            },
          }],
        }),
        { status: 200 },
      ),
    );

    const result = await analyzer.analyzeSegment(makeFrames(1), "gemini-2.5-flash-lite");
    const data = result.output;
    expect(data.summary).toBe("Porch");
  });

  it("returns available=false when the VLM response has no summary", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ main_targets: [] }) }] } }],
        }),
        { status: 200 },
      ),
    );

    await expect(analyzer.analyzeSegment(makeFrames(1), "gemini-2.5-flash-lite"))
      .rejects.toThrow("missing summary");
  });

  it("uses OpenAI chat completions API when provider is openai", async () => {
    const openaiAnalyzer = new VlmAnalyzer({
      provider: "openai",
      apiKey: "sk-test-key",
      baseUrl: "https://api.openai.com/v1",
      textModel: "gpt-5-mini",
    });

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: MOCK_VLM_RESPONSE } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await openaiAnalyzer.analyzeSegment(makeFrames(1), "gpt-4o");
    expect(result.output.summary).toContain("blue jacket");

    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = callArgs[0];
    const headers = callArgs[1].headers as Record<string, string>;
    const body = JSON.parse(callArgs[1].body as string);

    expect(url).toContain("api.openai.com/v1/chat/completions");
    expect(headers["Authorization"]).toBe("Bearer sk-test-key");
    expect(body.model).toBe("gpt-4o");
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.max_tokens).toBe(2048);
    expect(body.messages[0].content[0].type).toBe("text");
    const imageParts = openAIImageParts(body.messages[0].content);
    expect(imageParts).toHaveLength(1);
    expect(imageParts[0].image_url.url).toContain("data:image/jpeg;base64,");
    expect(imageParts[0].image_url.detail).toBe("high");
  });

  it("omits OpenAI image detail for multi-image requests", async () => {
    const openaiAnalyzer = new VlmAnalyzer({
      provider: "openai",
      apiKey: "sk-test-key",
      baseUrl: "https://api.openai.com/v1",
    });

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: MOCK_VLM_RESPONSE } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await openaiAnalyzer.analyzeSegment(makeFrames(2), "gpt-4o");
    expect(result.output.summary).toContain("blue jacket");

    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(callArgs[1].body as string);
    const imageParts = openAIImageParts(body.messages[0].content);

    expect(imageParts).toHaveLength(2);
    expect(imageParts[0].image_url.detail).toBeUndefined();
    expect(imageParts[1].image_url.detail).toBeUndefined();
  });

  // ── subject proposal via analyzeSegment tests ──

  describe("analyzeSegment with subjectProposal", () => {
    const MOCK_SUBJECT_PROPOSAL_RESPONSE = JSON.stringify({
      summary: "A person walks near the porch.",
      detailed_summary: "A person in a blue jacket walks through the porch segment.",
      content_type: "activity",
      key_modality: "visual",
      is_static_scene: false,
      event_boundary: false,
      event_summary: "A person in a blue jacket is walking near the porch.",
      security_risk: false,
      notify_user: false,
      targets: [
        { type: "person", bbox_ids: ["D0", "D5"], matched_wm_target: null, appearance: "blue jacket", behavior: "walking" },
      ],
    });

    const analyzeSegmentWithSubjectProposal = (
      instance: VlmAnalyzer,
      frames: ReturnType<typeof makeFrames>,
      model: string,
      didContext: string,
      options?: {
        runtimeMode?: "offline_quality" | "live_latency";
        sceneContext?: string;
        wmTargets?: Array<{
          target_id: string;
          class_name: string;
          appearance: string;
          behavior?: string;
          identity?: { name: string; evidence?: string };
          identity_hints?: Array<{
            name: string;
            evidence?: string;
            source?: "spoken" | "direct_address" | "third_person_reference" | "dialogue_about_person";
          }>;
          crop_base64?: string;
        }>;
        sttTranscript?: string;
        hasSpeakerDiarization?: boolean;
        currentEventSummary?: string;
        recentSegmentSummaries?: string[];
      },
    ) => instance.analyzeSegment(frames, model, {
      runtimeMode: options?.runtimeMode,
      sceneContext: options?.sceneContext,
      subjectProposal: {
        didContext,
        wmTargets: options?.wmTargets,
      },
      localModelResults: options?.sttTranscript
        ? { sttTranscript: options.sttTranscript, hasSpeakerDiarization: options.hasSpeakerDiarization }
        : undefined,
      currentEventSummary: options?.currentEventSummary,
      recentSegmentSummaries: options?.recentSegmentSummaries,
    }).then((result) => result.normalizedJson);

    it("returns normalized raw JSON string from Gemini", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: MOCK_SUBJECT_PROPOSAL_RESPONSE }] } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      const result = await analyzeSegmentWithSubjectProposal(
        analyzer,
        makeFrames(3),
        "gemini-2.5-flash",
        "D0: person at [10,20,100,200] frame 0\nD5: person at [15,25,105,205] frame 2",
      );

      expect(typeof result).toBe("string");
      const parsed = JSON.parse(result);
      expect(parsed.targets).toHaveLength(1);
      expect(parsed.targets[0].bbox_ids).toEqual(["D0", "D5"]);
    });

    it("returns normalized raw JSON string from OpenAI", async () => {
      const openaiAnalyzer = new VlmAnalyzer({
        provider: "openai",
        apiKey: "sk-test-key",
        baseUrl: "https://api.openai.com/v1",
        textModel: "gpt-5-mini",
        maxRetries: 0,
      });

      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: MOCK_SUBJECT_PROPOSAL_RESPONSE } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      const result = await analyzeSegmentWithSubjectProposal(
        openaiAnalyzer,
        makeFrames(2),
        "gpt-4o",
        "D0: person at [10,20,100,200] frame 0",
      );

      expect(typeof result).toBe("string");
      const parsed = JSON.parse(result);
      expect(parsed.targets).toHaveLength(1);
    });

    it("includes didContext in the prompt", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: MOCK_SUBJECT_PROPOSAL_RESPONSE }] } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      const didCtx = "Current segment visual evidence (D{id} labels are drawn on frames):\nMachine candidate links from ReID without a working-memory participant:\n- candidate entity=entity-1; type=person; name=Alex; possible D{id}s=[D0,D1]; history=standing near doorway";
      await analyzeSegmentWithSubjectProposal(analyzer, makeFrames(2), "gemini-2.5-flash", didCtx);

      const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
      const callBody = JSON.parse(callArgs[1].body as string);
      const textPart = geminiTextParts(callBody.contents[0].parts);
      expect(textPart).toContain("candidate entity=entity-1; type=person; name=Alex; possible D{id}s=[D0,D1]");
      expect(textPart).toContain("Do not output entity_id");
      expect(textPart).toContain("summary <=15 words");
      expect(textPart).toContain("detailed_summary <=60 words");
      expect(textPart).toContain("event_summary <=100 words");
      expect(textPart).toContain("Task flow:");
      expect(textPart).toContain("First understand the segment event");
      expect(textPart).toContain("From that event understanding, identify the small set of key people or animals");
      expect(textPart).toContain("decide whether the visible subject continues a Current Event Story participant");
      expect(textPart).toContain("do not decide continuity from names, roles, topic, or summary-level identity alone");
      expect(textPart).toContain("Only after continuity and D{id}s are consistent");
      expect(textPart).toContain("Field definitions:");
      expect(textPart).not.toContain("person-name consistency");
      expect(textPart).toContain("do not copy prior-context-only facts into detailed_summary");
      expect(textPart).toContain("Preserve salient identifying visual attributes");
      expect(textPart).toContain("mention both the action and the outcome");
      expect(textPart).toContain("durable navigation anchors");
      expect(textPart).toContain("Understand the segment first, then identify only the key visible subjects needed to explain it");
      expect(textPart).toContain("Treat D{id}s and machine ReID links as evidence hints");
      expect(textPart).toContain("Output constraints:");
      expect(textPart).toContain("target.identity: optional current-segment person-name evidence for this target");
      expect(textPart).toContain("attached only after continuity is decided and bbox_ids refer to one consistent physical subject");
      expect(textPart).toContain("matched_wm_target may be null for a new subject");
      expect(textPart).toContain("weak hint sources are spoken, direct_address, third_person_reference, dialogue_about_person, and visible_text");
      expect(textPart).toContain("Understand the segment first");
      expect(textPart).toContain("Match a subject to a Stable Participant only when visual continuity is clear");
      expect(textPart).toContain("Describe the visible subject itself");
      expect(textPart).toContain("If a subject has no reliable D{id}");
    });

    it("includes scene context and STT transcript when provided", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: MOCK_SUBJECT_PROPOSAL_RESPONSE }] } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      await analyzeSegmentWithSubjectProposal(analyzer, makeFrames(1), "gemini-2.5-flash", "D0: person", {
        sceneContext: "Front porch camera",
        sttTranscript: "Hey, is anyone home?",
      });

      const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
      const callBody = JSON.parse(callArgs[1].body as string);
      const textPart = geminiTextParts(callBody.contents[0].parts);
      expect(textPart).toContain("Front porch camera");
      expect(textPart).toContain("Hey, is anyone home?");
    });

    it("injects WM target crops as Gemini inline_data image parts", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: MOCK_SUBJECT_PROPOSAL_RESPONSE }] } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      await analyzeSegmentWithSubjectProposal(analyzer, makeFrames(1), "gemini-2.5-flash", "D0: person", {
        wmTargets: [
          {
            target_id: "wm_t1",
            class_name: "person",
            appearance: "red hat, blue jeans",
            identity_hints: [
              { name: "Michael Dell", evidence: "The name Michael is mentioned near this participant.", source: "spoken" },
            ],
            crop_base64: "crop_data_1",
          },
        ],
      });

      const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
      const callBody = JSON.parse(callArgs[1].body as string);
      const parts = callBody.contents[0].parts;

      // Prompt text should mention current-event participants
      const textPart = geminiTextParts(parts);
      expect(textPart).toContain("Current Event Story");
      expect(textPart).toContain("[wm_t1] person; appearance=red hat, blue jeans");
      expect(textPart).toContain("spoken_name_hints=Michael Dell/spoken: The name Michael is mentioned near this participant.");
      expect(textPart).toContain("spoken_name_hints are unconfirmed prior dialogue clues; use them only with current supporting evidence");
      expect(textPart).not.toContain("unconfirmed_names");
      expect(textPart).toContain("They may or may not appear now; do not force-match them to background people");
      expect(textPart).toContain("Current Segment Evidence");
      expect(textPart).toContain("Each crop is a visual reference for its labeled wm_target");
      expect(textPart).toContain("Use these crops only to decide whether a current visible subject continues that participant");
      expect(textPart).toContain("If the visual match is uncertain, set matched_wm_target to null");

      // Should have inline_data for the WM crop
      const cropParts = parts.filter(
        (p: Record<string, unknown>) => p.inline_data && (p.inline_data as Record<string, string>).data === "crop_data_1",
      );
      expect(cropParts).toHaveLength(1);

      // Should have label text for the WM crop
      const labelParts = parts.filter(
        (p: Record<string, unknown>) => typeof p.text === "string" && (p.text as string).includes("[wm_t1]"),
      );
      // One in the prompt template + one as crop label
      expect(labelParts.length).toBeGreaterThanOrEqual(1);
      expect(parts[1].text).toContain("Each crop image represents the wm_target in the immediately preceding label");
      expect(parts[2].text).toContain("[wm_t1] (person): appearance=red hat, blue jeans");
      expect((parts[3].inline_data as { data: string }).data).toBe("crop_data_1");
      expect(parts[4].text).toContain("Current Segment Evidence");
      expect(parts[5].text).toContain("Current segment frames");
      expect(parts[6].text).toContain("Segment frame 0");
      expect((parts[7].inline_data as { data: string }).data).toBe("base64jpeg_frame_0");
    });

    it("injects multiple stable WM target crops in continuity order", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: MOCK_SUBJECT_PROPOSAL_RESPONSE }] } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      await analyzeSegmentWithSubjectProposal(analyzer, makeFrames(1), "gemini-2.5-flash", "D0: person", {
        wmTargets: [
          {
            target_id: "wm_t1",
            class_name: "person",
            appearance: "red hat, blue jeans",
            crop_base64s: ["best_crop", "second_crop"],
          },
        ],
      });

      const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
      const callBody = JSON.parse(callArgs[1].body as string);
      const parts = callBody.contents[0].parts;
      const imageData = parts
        .filter((p: Record<string, unknown>) => p.inline_data)
        .map((p: { inline_data: { data: string } }) => p.inline_data.data);

      expect(imageData.slice(0, 2)).toEqual(["best_crop", "second_crop"]);
      expect(parts.some((p: Record<string, unknown>) => typeof p.text === "string" && (p.text as string).includes("[wm_t1#1]"))).toBe(true);
      expect(parts.some((p: Record<string, unknown>) => typeof p.text === "string" && (p.text as string).includes("[wm_t1#2]"))).toBe(true);
    });

    it("uses WM target text without crop images when no crop is provided", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: MOCK_SUBJECT_PROPOSAL_RESPONSE }] } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      await analyzeSegmentWithSubjectProposal(analyzer, makeFrames(1), "gemini-2.5-flash", "D0: person", {
        wmTargets: [
          {
            target_id: "wm_t1",
            class_name: "person",
            appearance: "red hat, blue jeans",
            behavior: "walking toward the doorway",
          },
        ],
      });

      const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
      const callBody = JSON.parse(callArgs[1].body as string);
      const parts = callBody.contents[0].parts;
      const textPart = geminiTextParts(parts);
      expect(textPart).toContain("[wm_t1] person; appearance=red hat, blue jeans");
      expect(textPart).toContain("behavior=walking toward the doorway");
      const cropParts = parts.filter(
        (p: Record<string, unknown>) => p.inline_data && (p.inline_data as Record<string, string>).data === "crop_data_1",
      );
      expect(cropParts).toHaveLength(0);
    });

    it("omits empty WM target text instead of falling back to class names", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: MOCK_SUBJECT_PROPOSAL_RESPONSE }] } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      await analyzeSegmentWithSubjectProposal(analyzer, makeFrames(1), "gemini-2.5-flash", "D0: person", {
        wmTargets: [
          { target_id: "wm_t1", class_name: "person", appearance: "" },
          { target_id: "wm_t2", class_name: "person", appearance: "", crop_base64: "crop_data_2" },
        ],
      });

      const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
      const callBody = JSON.parse(callArgs[1].body as string);
      const parts = callBody.contents[0].parts;
      const prompt = geminiTextParts(parts);
      expect(prompt).not.toContain("[wm_t1] (person):");
      expect(prompt).not.toContain("[wm_t2] (person):");
      expect(prompt).not.toContain("text descriptions");
      expect(prompt).toContain("Stable participant crop images follow before the current frames");
      expect(parts[2].text).toBe("[wm_t2] (person)");
    });

    it("keeps subject-proposal target details inline by default", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: MOCK_SUBJECT_PROPOSAL_RESPONSE }] } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      await analyzeSegmentWithSubjectProposal(analyzer, makeFrames(1), "gemini-2.5-flash", "D0: person\nD1: dog", {
        wmTargets: [
          { target_id: "wm_t1", class_name: "person", appearance: "red hat, blue jeans" },
        ],
        sttTranscript: "speaker_0: Hello Lily",
        hasSpeakerDiarization: true,
      });

      const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
      const callBody = JSON.parse(callArgs[1].body as string);
      const prompt = geminiTextParts(callBody.contents[0].parts);
      expect(prompt).toContain("Understand the segment first, then identify only the key visible subjects needed to explain it");
      expect(prompt).toContain("bbox_ids must be exact D<number> strings");
      expect(prompt).toContain("Skip incidental background people");
      expect(prompt).not.toContain("target_details");
      expect(prompt).not.toContain("tid field");
      expect(prompt).not.toContain("live-latency only temporary target correlation id");
      expect(prompt).toContain("Stable Participants are optional continuity candidates");
      expect(prompt).toContain("Use matched_wm_target only when the current visible subject is clearly the same visual subject");
      expect(prompt).toContain("matched_wm_target must be exactly one listed participant id or null");
      expect(prompt).toContain("never force-match absent participants");
      expect(prompt).toContain("never match a participant to a background person");
      expect(prompt).toContain("Treat D{id}s and machine ReID links as evidence hints");
      expect(prompt).toContain(
        "Use this top-level field order: targets, title, summary, detailed_summary, security_risk, security_reason, notify_user, matched_rule_ids, retrieval_compact, content_type, key_modality, is_static_scene, event_boundary, event_summary, event_context_update, custom_fields.",
      );
      expect(prompt).toContain("Attach each confident speaker_id");
      expect(prompt).toContain("target.speaker_ids");
      expect(prompt).toContain("never map two different speaker_id values to the same visible target/person");
      expect(prompt).toContain("target.identity is current-segment person-name evidence only");
      expect(prompt).toContain("Use source=\"visible_nameplate\" only when a nameplate/lower-third/badge is visually attached to that same target");
      expect(prompt).toContain("Use spoken, direct_address, third_person_reference, dialogue_about_person, or visible_text as weak hints");
    });

    it("splits target_details only in live_latency mode", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: MOCK_SUBJECT_PROPOSAL_RESPONSE }] } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      await analyzeSegmentWithSubjectProposal(analyzer, makeFrames(1), "gemini-2.5-flash", "D0: person\nD1: dog", {
        runtimeMode: "live_latency",
        wmTargets: [
          {
            target_id: "wm_t1",
            class_name: "person",
            appearance: "red hat, blue jeans",
            behavior: "walking toward the doorway",
          },
        ],
        sttTranscript: "speaker_0: Hello Lily",
        hasSpeakerDiarization: true,
      });

      const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
      const callBody = JSON.parse(callArgs[1].body as string);
      const prompt = geminiTextParts(callBody.contents[0].parts);
      expect(prompt).toContain("target_details");
      expect(prompt).toContain("For each target, include a unique tid");
      expect(prompt).toContain("tid: live-latency only temporary target correlation id.");
      expect(prompt).toContain("Use it only to match targets[] with target_details[] inside the same JSON response");
      expect(prompt).toContain("appearance/behavior from target_details cannot be matched safely when tid is missing or duplicated.");
      expect(prompt).toContain("Put descriptive fields in target_details");
      expect(prompt).toContain("target_details describes the visible subject represented by the target");
      expect(prompt).not.toContain("target.identity precision");
      expect(prompt).not.toContain("person-name consistency");
      expect(prompt).toContain("If visible text is ambiguous, applies to multiple people");
      expect(prompt).not.toContain("small edge/background/partial-body/no-face");
      expect(prompt).toContain("Always output title, summary, security_risk");
      expect(prompt).toContain("Use [] for targets");
      expect(prompt).toContain("summary, security_risk, is_static_scene");
      expect(prompt).toContain("[wm_t1] person; appearance=red hat, blue jeans; recent_behavior=walking toward the doorway");
      expect(prompt).toContain(
        "Use this top-level field order: title, summary, security_risk, is_static_scene, notify_user, matched_rule_ids, best_frame_index, targets, event_boundary, security_reason",
      );
    });

    it("injects WM target crops as OpenAI image_url parts", async () => {
      const openaiAnalyzer = new VlmAnalyzer({
        provider: "openai",
        apiKey: "sk-test-key",
        baseUrl: "https://api.openai.com/v1",
        textModel: "gpt-5-mini",
        maxRetries: 0,
      });

      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: MOCK_SUBJECT_PROPOSAL_RESPONSE } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      await analyzeSegmentWithSubjectProposal(openaiAnalyzer, makeFrames(1), "gpt-4o", "D0: person", {
        wmTargets: [
          { target_id: "wm_t1", class_name: "person", appearance: "red hat", crop_base64: "crop_openai" },
        ],
      });

      const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(callArgs[1].body as string);
      const content = body.messages[0].content;

      // Should contain an image_url with the crop data
      const cropParts = content.filter(
        (p: Record<string, unknown>) =>
          p.type === "image_url" &&
          (p.image_url as Record<string, string>).url?.includes("crop_openai"),
      );
      expect(cropParts).toHaveLength(1);
      const cropIndex = content.indexOf(cropParts[0]);
      const frameIndex = content.findIndex((p: Record<string, unknown>) =>
        p.type === "image_url" && (p.image_url as Record<string, string>).url?.includes("base64jpeg_frame_0")
      );
      expect(content[cropIndex - 1].text).toContain("[wm_t1] (person): appearance=red hat");
      expect(cropParts[0].image_url.detail).toBeUndefined();
      expect(cropIndex).toBeGreaterThan(0);
      expect(frameIndex).toBeGreaterThan(cropIndex);
    });

    it("falls back from WM crop images to text-only matching on content safety errors", async () => {
      const openaiAnalyzer = new VlmAnalyzer({
        provider: "openai",
        apiKey: "sk-test-key",
        baseUrl: "https://api.openai.com/v1",
        textModel: "gpt-5-mini",
        maxRetries: 0,
      });

      fetchMock
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              error: {
                message: "Your input image may contain content that is not allowed by our content safety system.",
                type: "invalid_request_error",
                code: "content_policy_violation",
              },
            }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: MOCK_SUBJECT_PROPOSAL_RESPONSE } }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );

      const result = await analyzeSegmentWithSubjectProposal(openaiAnalyzer, makeFrames(1), "gpt-4o", "D0: person", {
        wmTargets: [
          { target_id: "wm_t1", class_name: "person", appearance: "red hat", crop_base64: "crop_openai" },
        ],
      });

      expect(JSON.parse(result).targets).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const firstBody = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      const secondBody = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string);
      expect(firstBody.messages[0].content.some((p: Record<string, unknown>) => p.type === "image_url")).toBe(true);
      expect(secondBody.messages[0].content.some((p: Record<string, unknown>) => p.type === "image_url" && String((p.image_url as Record<string, string>)?.url).includes("crop_openai"))).toBe(false);
      expect(openAITextParts(secondBody.messages[0].content)).toContain("[wm_t1] person; appearance=red hat");
    });

    it("falls back from previous-target matching to current-only analysis on invalid prompt policy errors", async () => {
      const openaiAnalyzer = new VlmAnalyzer({
        provider: "openai",
        apiKey: "sk-test-key",
        baseUrl: "https://api.openai.com/v1",
        textModel: "gpt-5-mini",
        maxRetries: 0,
      });

      fetchMock
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              error: {
                message: "Invalid prompt: your prompt was flagged as potentially violating our usage policy.",
                type: "invalid_request_error",
                code: "invalid_prompt",
              },
            }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: MOCK_SUBJECT_PROPOSAL_RESPONSE } }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );

      const result = await openaiAnalyzer.analyzeSegment([{ data: "annotated_frame", timestamp: 1, index: 0 }], "gpt-4o", {
        summaryOnlyFrames: [{ data: "raw_frame", timestamp: 1, index: 0 }],
        subjectProposal: {
          didContext: "D0: person",
          wmTargets: [
            { target_id: "wm_t1", class_name: "person", appearance: "red hat" },
          ],
        },
      });

      expect(JSON.parse(result.normalizedJson).targets).toHaveLength(1);
      expect(result.subject_proposal_context?.fallback_layer).toBe("current_only_targets");
      expect(result.subject_proposal_context?.wm_target_ids).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const secondBody = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string);
      const secondPrompt = openAITextParts(secondBody.messages[0].content);
      expect(secondPrompt).toContain("D0: person");
      expect(secondPrompt).toContain("Understand the segment first");
      expect(secondPrompt).not.toContain("Previous segment targets");
    });

    it("falls back from current-only target aggregation to summary-only analysis", async () => {
      const openaiAnalyzer = new VlmAnalyzer({
        provider: "openai",
        apiKey: "sk-test-key",
        baseUrl: "https://api.openai.com/v1",
        textModel: "gpt-5-mini",
        maxRetries: 0,
      });

      fetchMock
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              error: {
                message: "Invalid prompt: your prompt was flagged as potentially violating our usage policy.",
                type: "invalid_request_error",
                code: "invalid_prompt",
              },
            }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              error: {
                message: "Invalid prompt: your prompt was flagged as potentially violating our usage policy.",
                type: "invalid_request_error",
                code: "invalid_prompt",
              },
            }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: MOCK_SUBJECT_PROPOSAL_RESPONSE } }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );

      const result = await openaiAnalyzer.analyzeSegment([{ data: "annotated_frame", timestamp: 1, index: 0 }], "gpt-4o", {
        summaryOnlyFrames: [{ data: "raw_frame", timestamp: 1, index: 0 }],
        subjectProposal: {
          didContext: "D0: person",
          wmTargets: [
            { target_id: "wm_t1", class_name: "person", appearance: "red hat" },
          ],
        },
      });

      expect(result.subject_proposal_context).toEqual({
        fallback_layer: "summary_only",
        wm_target_ids: [],
        wm_target_image_count: 0,
        target_aggregation: "disabled",
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      const thirdBody = JSON.parse((fetchMock.mock.calls[2] as [string, RequestInit])[1].body as string);
      const thirdContent = thirdBody.messages[0].content;
      const thirdPrompt = thirdContent[0].text as string;
      expect(thirdPrompt).toContain("Target aggregation is disabled for this call");
      expect(thirdPrompt).toContain("Return \"targets\": []");
      expect(thirdPrompt).not.toContain("D0: person");
      expect(thirdPrompt).not.toContain("Identify distinct targets");
      expect(thirdPrompt).not.toContain("matched_wm_target");
      expect(thirdPrompt).not.toContain("tid field");
      expect(thirdPrompt).not.toContain("target_details");
      expect(thirdContent.some((p: Record<string, unknown>) =>
        p.type === "image_url" && String((p.image_url as Record<string, string>)?.url).includes("raw_frame"),
      )).toBe(true);
      expect(thirdContent.some((p: Record<string, unknown>) =>
        p.type === "image_url" && String((p.image_url as Record<string, string>)?.url).includes("annotated_frame"),
      )).toBe(false);
    });

    it("includes event context in prompt when provided", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: MOCK_SUBJECT_PROPOSAL_RESPONSE }] } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      await analyzeSegmentWithSubjectProposal(analyzer, makeFrames(1), "gemini-2.5-flash", "D0: person", {
        currentEventSummary: "A delivery driver arrived at the front porch.",
        recentSegmentSummaries: ["Driver parks the van.", "Driver walks to the porch."],
      });

      const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
      const callBody = JSON.parse(callArgs[1].body as string);
      const textPart = geminiTextParts(callBody.contents[0].parts);
      expect(textPart).toContain("A delivery driver arrived at the front porch.");
      expect(textPart).toContain("1. Driver parks the van.");
      expect(textPart).toContain("2. Driver walks to the porch.");
    });

    it("propagates API errors (does not catch them like analyze())", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response("Internal Server Error", { status: 500 }),
      );

      await expect(
        analyzeSegmentWithSubjectProposal(analyzer, makeFrames(1), "gemini-2.5-flash", "D0: person"),
      ).rejects.toThrow("500");
    });
  });

  it("uses max_completion_tokens for GPT-5 family models without explicit reasoning", async () => {
    const openaiAnalyzer = new VlmAnalyzer({
      provider: "openai",
      apiKey: "sk-test-key",
      baseUrl: "https://api.openai.com/v1",
      textModel: "gpt-5-mini",
    });

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: MOCK_VLM_RESPONSE } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await openaiAnalyzer.analyzeSegment(makeFrames(1), "openai/gpt-5-mini");

    let callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    let body = JSON.parse(callArgs[1].body as string);
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.max_completion_tokens).toBe(2048);
    expect(body.max_tokens).toBeUndefined();

    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: MOCK_VLM_RESPONSE } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await openaiAnalyzer.analyzeSegment(makeFrames(1), "gpt-5.1");

    callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    body = JSON.parse(callArgs[1].body as string);
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.max_completion_tokens).toBe(2048);
    expect(body.max_tokens).toBeUndefined();
  });

  it("routes compressText through the same OpenAI controls as other completions", async () => {
    const openaiAnalyzer = new VlmAnalyzer({
      provider: "openai",
      apiKey: "sk-test-key",
      baseUrl: "https://api.openai.com/v1",
      textModel: "openai/gpt-5-mini",
    });

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "compressed text" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await openaiAnalyzer.compressText("Summarize this.", { maxTokens: 700, temperature: 0.2 });
    expect(result).toBe("compressed text");

    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(callArgs[1].body as string);
    expect(body.model).toBe("openai/gpt-5-mini");
    expect(body.messages[0].content).toBe("Summarize this.");
    expect(body.response_format).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.max_completion_tokens).toBe(700);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });

  it("records LLM call metadata and OpenAI token usage", async () => {
    const calls: any[] = [];
    const openaiAnalyzer = new VlmAnalyzer({
      provider: "openai",
      apiKey: "sk-test-key",
      baseUrl: "https://api.openai.com/v1",
      textModel: "openai/gpt-5-mini",
      llmCallRecorder: (call) => calls.push(call),
      llmContext: { run_id: "run_test", video_id: "video_test" },
    });

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "compressed text" } }],
          usage: {
            prompt_tokens: 11,
            completion_tokens: 7,
            total_tokens: 18,
            completion_tokens_details: { reasoning_tokens: 3 },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await openaiAnalyzer.compressText("Summarize this.", {
      stage: "narrative.chapter_summary",
      reasoningEffort: "minimal",
      promptVersion: "commit_test",
      llmContext: { camera_id: "cam_test" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      run_id: "run_test",
      video_id: "video_test",
      camera_id: "cam_test",
      stage: "narrative.chapter_summary",
      provider: "openai",
      model: "openai/gpt-5-mini",
      prompt_version: "commit_test",
      status: "ok",
      retry_count: 0,
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        reasoning_tokens: 3,
        total_tokens: 18,
      },
    });
    expect(calls[0].request.prompt_hash).toMatch(/^fnv1a32:/);
    expect(calls[0].request.max_completion_tokens).toBe(2048);
    expect(calls[0].request.reasoning_effort).toBe("minimal");
  });

  it("records subject-proposal fallback layer in LLM request metadata", async () => {
    const calls: any[] = [];
    const openaiAnalyzer = new VlmAnalyzer({
      provider: "openai",
      apiKey: "sk-test-key",
      baseUrl: "https://api.openai.com/v1",
      textModel: "gpt-5-mini",
      maxRetries: 0,
      llmCallRecorder: (call) => calls.push(call),
    });

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ summary: "A car is parked.", detailed_summary: "A car is parked near the curb.", event_summary: "A car is parked near the curb.", targets: [] }) } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await openaiAnalyzer.analyzeSegment(makeFrames(1), "gpt-5-mini", {
      subjectProposal: {
        didContext: "",
        targetAggregation: "disabled",
      },
    });

    expect(calls[0].request).toMatchObject({
      fallback_layer: "summary_only",
      target_aggregation: "disabled",
      has_detection_context: false,
    });
  });

  it("streams OpenAI segment JSON and emits completed summary before final parse", async () => {
    const openaiAnalyzer = new VlmAnalyzer({
      provider: "openai",
      apiKey: "sk-test-key",
      baseUrl: "https://api.openai.com/v1",
      textModel: "gpt-5-mini",
      maxRetries: 0,
    });
    const streamedJson = JSON.stringify({
      summary: "Person enters the hallway.",
      security_risk: true,
      security_reason: "Unknown person entered after hours.",
      notify_user: true,
      matched_rule_ids: ["rule-after-hours"],
      best_frame_index: 2,
      detailed_summary: "A person enters the hallway and walks past the camera.",
      retrieval_compact: ["person enters hallway"],
      main_targets: [{ type: "person", appearance: "dark jacket", behavior: "walking" }],
      content_type: "activity",
      key_modality: "visual",
      is_static_scene: false,
      event_summary: "A person enters the hallway.",
    });
    const splitAt = streamedJson.indexOf(",\"detailed_summary\"");
    const firstChunk = streamedJson.slice(0, splitAt);
    const secondChunk = streamedJson.slice(splitAt);
    const partials: unknown[] = [];

    fetchMock.mockResolvedValueOnce(openAISseResponse([
      { choices: [{ delta: { content: firstChunk } }] },
      { choices: [{ delta: { content: secondChunk } }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 20, total_tokens: 32 } },
      "[DONE]",
    ]));

    const result = await openaiAnalyzer.analyzeSegment(makeFrames(1), "gpt-5-mini", {
      stream: true,
      onPartial: (partial) => partials.push(partial),
    });

    expect(result.output.summary).toBe("Person enters the hallway.");
    expect(result.rawText).toBe(streamedJson);
    expect(partials.map((partial) => [partial.field, partial.value])).toEqual([
      ["summary", "Person enters the hallway."],
      ["security_risk", true],
      ["security_reason", "Unknown person entered after hours."],
      ["notify_user", true],
      ["matched_rule_ids", ["rule-after-hours"]],
      ["is_static_scene", false],
      ["best_frame_index", 2],
      ["main_targets", [{ type: "person", appearance: "dark jacket", behavior: "walking" }]],
    ]);
    expect(partials[0]).toMatchObject({
      field: "summary",
      received_at: expect.any(Number),
      request_started_at: expect.any(Number),
      ttft_ms: expect.any(Number),
      first_content_ms: expect.any(Number),
    });

    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(callArgs[1].body as string);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("streams OpenAI segment JSON when summary is not the first field", async () => {
    const openaiAnalyzer = new VlmAnalyzer({
      provider: "openai",
      apiKey: "sk-test-key",
      baseUrl: "https://api.openai.com/v1",
      textModel: "gpt-5-mini",
      maxRetries: 0,
    });
    const streamedJson = JSON.stringify({
      detailed_summary: "A person enters the hallway and walks past the camera.",
      retrieval_compact: ["person enters hallway"],
      summary: "Person enters the hallway.",
      best_frame_index: 1,
      main_targets: [],
      content_type: "activity",
      key_modality: "visual",
      is_static_scene: false,
      event_summary: "A person enters the hallway.",
      security_risk: false,
      notify_user: false,
    });
    const splitAt = streamedJson.indexOf(",\"main_targets\"");
    const partials: unknown[] = [];

    fetchMock.mockResolvedValueOnce(openAISseResponse([
      { choices: [{ delta: { content: streamedJson.slice(0, splitAt) } }] },
      { choices: [{ delta: { content: streamedJson.slice(splitAt) } }] },
      "[DONE]",
    ]));

    const result = await openaiAnalyzer.analyzeSegment(makeFrames(1), "gpt-5-mini", {
      stream: true,
      onPartial: (partial) => partials.push(partial),
    });

    expect(result.output.summary).toBe("Person enters the hallway.");
    expect(partials.map((partial) => [partial.field, partial.value])).toEqual([
      ["summary", "Person enters the hallway."],
      ["security_risk", false],
      ["is_static_scene", false],
      ["notify_user", false],
      ["best_frame_index", 1],
      ["main_targets", []],
    ]);
    expect(partials[0]).toMatchObject({
      field: "summary",
      received_at: expect.any(Number),
      request_started_at: expect.any(Number),
      ttft_ms: expect.any(Number),
      first_content_ms: expect.any(Number),
    });
  });

  it("retries OpenAI streaming without stream_options on 400", async () => {
    const openaiAnalyzer = new VlmAnalyzer({
      provider: "openai",
      apiKey: "sk-test-key",
      baseUrl: "https://api.openai.com/v1",
      textModel: "gpt-5-mini",
      maxRetries: 0,
    });
    const streamedJson = JSON.stringify({
      summary: "Person enters the hallway.",
      detailed_summary: "A person enters the hallway.",
      retrieval_compact: [],
      main_targets: [],
      content_type: "activity",
      key_modality: "visual",
      is_static_scene: false,
      event_summary: "A person enters the hallway.",
      security_risk: false,
      notify_user: false,
    });

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "stream_options unsupported" } }), { status: 400 }))
      .mockResolvedValueOnce(openAISseResponse([
        { choices: [{ delta: { content: streamedJson } }] },
        "[DONE]",
      ]));

    const result = await openaiAnalyzer.analyzeSegment(makeFrames(1), "gpt-5-mini", { stream: true });

    expect(result.output.summary).toBe("Person enters the hallway.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    const secondBody = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string);
    expect(firstBody.stream_options).toEqual({ include_usage: true });
    expect(secondBody.stream).toBe(true);
    expect(secondBody.stream_options).toBeUndefined();
  });

  it("falls back to non-streaming OpenAI completion when streaming fails", async () => {
    const openaiAnalyzer = new VlmAnalyzer({
      provider: "openai",
      apiKey: "sk-test-key",
      baseUrl: "https://api.openai.com/v1",
      textModel: "gpt-5-mini",
      maxRetries: 0,
    });
    const finalJson = JSON.stringify({
      summary: "Final hallway summary.",
      detailed_summary: "A person enters the hallway after streaming fails.",
      retrieval_compact: [],
      main_targets: [],
      content_type: "activity",
      key_modality: "visual",
      is_static_scene: false,
      event_summary: "A person enters the hallway.",
      security_risk: false,
      notify_user: false,
    });
    const partials: unknown[] = [];

    fetchMock
      .mockRejectedValueOnce(new Error("SSE disconnected"))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ choices: [{ message: { content: finalJson } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ));

    const result = await openaiAnalyzer.analyzeSegment(makeFrames(1), "gpt-5-mini", {
      stream: true,
      onPartial: (partial) => partials.push(partial),
    });

    expect(result.output.summary).toBe("Final hallway summary.");
    expect(partials).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const fallbackBody = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string);
    expect(fallbackBody.stream).toBeUndefined();
  });

  it("supports text-only JSON completions with model override", async () => {
    const openaiAnalyzer = new VlmAnalyzer({
      provider: "openai",
      apiKey: "sk-test-key",
      baseUrl: "https://api.openai.com/v1",
      textModel: "openai/gpt-5-mini",
    });

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "{\"no_update\":true}" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await openaiAnalyzer.completeText("Return JSON.", {
      responseFormat: "json",
      model: "openai/gpt-5-mini",
      reasoningEffort: "low",
    });
    expect(result).toBe("{\"no_update\":true}");

    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(callArgs[1].body as string);
    expect(body.model).toBe("openai/gpt-5-mini");
    expect(body.messages[0].content).toBe("Return JSON.");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.reasoning_effort).toBe("low");
    expect(body.max_completion_tokens).toBe(2048);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });

  it("drops reasoning effort for non-GPT-5 OpenAI-compatible models", async () => {
    const openaiAnalyzer = new VlmAnalyzer({
      provider: "openai",
      apiKey: "sk-test-key",
      baseUrl: "https://dashscope.example.test/compatible-mode/v1",
      textModel: "qwen3.6-flash",
      maxRetries: 0,
    });

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await openaiAnalyzer.completeText("Return JSON.", {
      responseFormat: "json",
      model: "qwen3.6-flash",
      reasoningEffort: "low",
    });

    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(callArgs[1].body as string);
    expect(body.model).toBe("qwen3.6-flash");
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.max_tokens).toBe(2048);
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it("passes provider-specific OpenAI-compatible options through", async () => {
    const openaiAnalyzer = new VlmAnalyzer({
      provider: "openai",
      apiKey: "sk-test-key",
      baseUrl: "https://dashscope.example.test/compatible-mode/v1",
      textModel: "qwen3.6-flash",
      maxRetries: 0,
    });

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await openaiAnalyzer.completeText("Return JSON.", {
      responseFormat: "json",
      model: "qwen3.6-flash",
      providerOptions: {
        openaiCompat: {
          enable_thinking: true,
          thinking_budget: 512,
        },
      },
    });

    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(callArgs[1].body as string);
    expect(body.model).toBe("qwen3.6-flash");
    expect(body.max_tokens).toBe(2048);
    expect(body.enable_thinking).toBe(true);
    expect(body.thinking_budget).toBe(512);
  });

  it("rejects empty JSON completions instead of returning an empty object", async () => {
    const calls: any[] = [];
    const openaiAnalyzer = new VlmAnalyzer({
      provider: "openai",
      apiKey: "sk-test-key",
      baseUrl: "https://api.openai.com/v1",
      textModel: "openai/gpt-5-mini",
      llmCallRecorder: (call) => calls.push(call),
    });

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: "length", message: { content: "" } }],
          usage: {
            prompt_tokens: 11,
            completion_tokens: 2048,
            total_tokens: 2059,
            completion_tokens_details: { reasoning_tokens: 2048 },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      openaiAnalyzer.completeText("Return JSON.", {
        responseFormat: "json",
        model: "openai/gpt-5-mini",
      }),
    ).rejects.toThrow("empty JSON response");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      status: "error",
      usage: {
        prompt_tokens: 11,
        completion_tokens: 2048,
        reasoning_tokens: 2048,
        total_tokens: 2059,
      },
      error_details: {
        provider: "openai",
        http_status: 200,
        reason: "empty_json_response",
        response: {
          choice_count: 1,
          choices: [{
            finish_reason: "length",
            content_length: 0,
            has_refusal: false,
          }],
        },
      },
    });
  });

  it("records provider error details for OpenAI 400 responses", async () => {
    const calls: any[] = [];
    const openaiAnalyzer = new VlmAnalyzer({
      provider: "openai",
      apiKey: "sk-test-key",
      baseUrl: "https://api.openai.com/v1",
      textModel: "openai/gpt-5-mini",
      llmCallRecorder: (call) => calls.push(call),
    });

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            message: "Invalid prompt: your prompt was flagged as potentially violating our usage policy.",
            type: "invalid_request_error",
            param: null,
            code: "invalid_prompt",
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      openaiAnalyzer.completeText("Return JSON.", {
        responseFormat: "json",
        model: "openai/gpt-5-mini",
      }),
    ).rejects.toThrow("Invalid prompt");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      status: "error",
      error_details: {
        provider: "openai",
        http_status: 400,
        error_type: "invalid_request_error",
        error_code: "invalid_prompt",
        error_message: "Invalid prompt: your prompt was flagged as potentially violating our usage policy.",
      },
    });
  });
});
