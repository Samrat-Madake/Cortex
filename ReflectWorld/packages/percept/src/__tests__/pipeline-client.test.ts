import { describe, it, expect, vi, beforeEach } from "vitest";
import { PipelineClient } from "../pipeline-client.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("PipelineClient", () => {
  const client = new PipelineClient({ pipelineUrl: "http://localhost:8222" });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("calls /process with correct payload", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ task_id: "abc-123", status: "accepted", message: "ok" }),
    });

    const result = await client.process({
      video_url: "s3://raw-video/seg_001.mp4",
      camera_id: "front_door",
      mode: "event",
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe("http://localhost:8222/process");
    expect(JSON.parse(opts.body)).toMatchObject({
      video_url: "s3://raw-video/seg_001.mp4",
      camera_id: "front_door",
      mode: "event",
    });
    expect(result.task_id).toBe("abc-123");
  });

  it("calls /health", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "healthy",
        capabilities: { available: ["scene"], all: ["scene", "identify"] },
      }),
    });

    const health = await client.health();
    expect(health.status).toBe("healthy");
    expect(health.capabilities.available).toContain("scene");
  });

  it("polls /task/{id} until completed", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "processing" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "completed", result: { summary: "test" } }),
      });

    const result = await client.waitForResult("task-1", { pollIntervalMs: 10, maxWaitMs: 1000 });
    expect(result.status).toBe("completed");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
