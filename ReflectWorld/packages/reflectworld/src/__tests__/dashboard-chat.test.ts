import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { dashboardChatRequiredSearchFailureResponse } from "../services/dashboard-chat-agent-policy.js";
import { DashboardChatController } from "../services/dashboard-chat.js";
import { executeDashboardChatMemorySearch } from "../services/dashboard-chat-memory-search.js";

function makeRequest(payload: Record<string, unknown>): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.headers = { accept: "text/event-stream" };
  Object.assign(req, { testPayload: Buffer.from(JSON.stringify(payload)) });
  return req;
}

function makeResponse(): { res: ServerResponse; chunks: string[] } {
  const chunks: string[] = [];
  const res = {
    destroyed: false,
    writableEnded: false,
    writeHead: vi.fn(),
    write: vi.fn((chunk: string) => {
      chunks.push(chunk);
      return true;
    }),
    end: vi.fn(function end(this: { writableEnded: boolean }) {
      this.writableEnded = true;
    }),
  } as unknown as ServerResponse;
  return { res, chunks };
}

describe("DashboardChatController", () => {
  it("streams the required-search failure response without synthesizing an answer", async () => {
    const memorySearch = vi.fn(async () => {
      throw new Error("memory backend unavailable");
    });
    const callback = vi.fn(async () => {
      const result = await executeDashboardChatMemorySearch({
        execute: memorySearch,
        formatSuccess: () => "unexpected search result",
      });
      const failureResponse = await dashboardChatRequiredSearchFailureResponse(
        result,
        async () => "I cannot reliably verify the video content right now.",
      );
      return failureResponse ?? { ok: true, answer: "unexpected answer" };
    });
    const controller = new DashboardChatController({
      sessionEnabled: () => false,
      getDashboardChat: () => callback,
      getSemanticContext: () => null,
      requireDashboardSession: () => null,
      scopeFromRequest: () => null,
      sourceVisibleToSession: () => true,
      consumeChatRateLimit: () => ({ ok: true }),
      sendJson: vi.fn(),
      readRequestBuffer: async (req) => (req as IncomingMessage & { testPayload: Buffer }).testPayload,
      buildDashboardChatContext: () => "recent moments",
      buildDashboardRuntimeContext: () => "runtime status",
    });
    const req = makeRequest({ prompt: "How many Ferraris are in the video?", stream: true });
    const { res, chunks } = makeResponse();

    await controller.handleDashboardChat(req, res);

    const stream = chunks.join("");
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      "Content-Type": "text/event-stream; charset=utf-8",
    }));
    expect(stream).toContain("event: error");
    expect(stream).toContain("I cannot reliably verify the video content right now.");
    expect(stream).toContain("event: done");
    expect(stream).not.toContain("event: delta");
    expect(memorySearch).toHaveBeenCalledOnce();
    expect(res.end).toHaveBeenCalledOnce();
  });
});
