// packages/mem/src/__tests__/plugin.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import memoryPlugin from "../../index.js";

describe("memoryPlugin", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("has correct id and name", () => {
    expect(memoryPlugin.id).toBe("cortex-mem");
    expect(memoryPlugin.name).toBe("Cortex Memory");
  });

  it("register() calls api.registerTool once", () => {
    const mockApi = { registerTool: vi.fn() };
    memoryPlugin.register(mockApi as unknown as Parameters<typeof memoryPlugin.register>[0]);
    expect(mockApi.registerTool).toHaveBeenCalledOnce();
  });

  it("registered tool has name cortex_memory", () => {
    const mockApi = { registerTool: vi.fn() };
    memoryPlugin.register(mockApi as unknown as Parameters<typeof memoryPlugin.register>[0]);
    const tool = mockApi.registerTool.mock.calls[0][0] as { name: string };
    expect(tool.name).toBe("cortex_memory");
  });

  it("search action calls client.search", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ results: [] }),
      }),
    );

    const mockApi = { registerTool: vi.fn(), pluginConfig: { baseUrl: "http://localhost:8219" } };
    memoryPlugin.register(mockApi as unknown as Parameters<typeof memoryPlugin.register>[0]);

    const tool = mockApi.registerTool.mock.calls[0][0] as {
      execute: (toolCallId: string, params: unknown) => Promise<unknown>;
    };

    const result = await tool.execute("test-call-id", {
      action: "search",
      query: "who was at the door",
      camera_id: "cam-front",
    });

    expect(result).toEqual({ results: [] });

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall[0]).toContain("/search");
  });

  it("get_history supports earliest timeline ordering", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      }),
    );

    const mockApi = { registerTool: vi.fn(), pluginConfig: { baseUrl: "http://localhost:8219" } };
    memoryPlugin.register(mockApi as unknown as Parameters<typeof memoryPlugin.register>[0]);

    const tool = mockApi.registerTool.mock.calls[0][0] as {
      execute: (toolCallId: string, params: unknown) => Promise<unknown>;
    };

    await tool.execute("test-call-id", {
      action: "get_history",
      camera_id: "cam-front",
      position: "earliest",
      limit: 10,
    });

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(String(fetchCall[0])).toContain("/memories?");
    expect(String(fetchCall[0])).toContain("memory_type=episodic_trace");
    expect(String(fetchCall[0])).toContain("sort_order=asc");
  });

  it("get_history supports latest timeline ordering", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      }),
    );

    const mockApi = { registerTool: vi.fn(), pluginConfig: { baseUrl: "http://localhost:8219" } };
    memoryPlugin.register(mockApi as unknown as Parameters<typeof memoryPlugin.register>[0]);

    const tool = mockApi.registerTool.mock.calls[0][0] as {
      execute: (toolCallId: string, params: unknown) => Promise<unknown>;
    };

    await tool.execute("test-call-id", {
      action: "get_history",
      camera_id: "cam-front",
      position: "latest",
      limit: 10,
    });

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(String(fetchCall[0])).toContain("/memories?");
    expect(String(fetchCall[0])).toContain("memory_type=episodic_trace");
    expect(String(fetchCall[0])).toContain("sort_order=desc");
  });

  it("get_narrative returns timeline and archive from qdrant", async () => {
    // Simulate two Qdrant GET /memories calls: episodic_schema (timeline), episodic_trace (recent)
    const schemaItems = [
      { id: "s1", memory: "The blue thread is covered by a later stitch.", created_at: "2026-01-01T00:00:00Z", metadata: { title: "002" } },
      { id: "s2", memory: "The final scene shows a completed pattern.", created_at: "2026-01-01T01:00:00Z", metadata: { title: "003" } },
    ];
    const traceItems = [
      { id: "t1", memory: "A person walked through the door.", created_at: "2026-01-01T02:00:00Z", metadata: {} },
    ];
    let callIndex = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        const items = callIndex === 0 ? schemaItems : traceItems;
        callIndex++;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(items),
        });
      }),
    );

    const mockApi = {
      registerTool: vi.fn(),
      pluginConfig: { baseUrl: "http://localhost:8219" },
    };
    memoryPlugin.register(mockApi as unknown as Parameters<typeof memoryPlugin.register>[0]);

    const tool = mockApi.registerTool.mock.calls[0][0] as {
      execute: (toolCallId: string, params: unknown) => Promise<unknown>;
    };

    const result = await tool.execute("test-call-id", {
      action: "get_narrative",
      camera_id: "cam-front",
      query: "blue thread stitch",
      limit: 2,
    }) as Record<string, unknown>;

    expect(result.source).toBe("qdrant");
    expect(result.archive).toContain("blue thread");
    expect(result.archive_chapter_count).toBe(1);
    expect(result.archive_total_chapters).toBe(2);
    expect((result.timeline as unknown[]).length).toBe(2);
    expect((result.recent as unknown[]).length).toBe(1);
  });

  it("get_narrative returns graceful fallback when server unreachable", async () => {
    const mockApi = { registerTool: vi.fn(), pluginConfig: { baseUrl: "http://localhost:8219" } };
    memoryPlugin.register(mockApi as unknown as Parameters<typeof memoryPlugin.register>[0]);

    const tool = mockApi.registerTool.mock.calls[0][0] as {
      execute: (toolCallId: string, params: unknown) => Promise<unknown>;
    };

    // Server unreachable → returns empty result set (graceful fallback).
    const result = await tool.execute("test-call-id", {
      action: "get_narrative",
      camera_id: "cam-front",
    }) as Record<string, unknown>;
    expect(result).toMatchObject({
      timeline: [],
      recent: [],
      source: "qdrant",
    });
  });

  it("throws on unknown action (type guard)", async () => {
    const mockApi = { registerTool: vi.fn() };
    memoryPlugin.register(mockApi as unknown as Parameters<typeof memoryPlugin.register>[0]);

    const tool = mockApi.registerTool.mock.calls[0][0] as {
      execute: (toolCallId: string, params: unknown) => Promise<unknown>;
    };

    await expect(
      tool.execute("test-call-id", { action: "unknown_action" }),
    ).rejects.toThrow(/unknown cortex_memory action/i);
  });
});
