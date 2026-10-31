// packages/mem/src/__tests__/client.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ReflectWorldClient, ReflectWorldClientError } from "../client.js";
import type { AddMemoryResponse, SearchResponse, AddSchemaRequest, UpsertContextRequest } from "../types.js";

const BASE_URL = "http://localhost:8219";

function mockFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    }),
  );
}

describe("ReflectWorldClient", () => {
  let client: ReflectWorldClient;

  beforeEach(() => {
    client = new ReflectWorldClient({ baseUrl: BASE_URL, timeoutMs: 5_000 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // -- add() ------------------------------------------------------------------

  describe("add()", () => {
    it("posts to /memories and returns response", async () => {
      const mockResp: AddMemoryResponse = {
        results: [
          { id: "mem-1", memory: {}, event: "ADD", memory_type: "episodic_trace" },
        ],
      };
      mockFetch(200, mockResp);

      const result = await client.add({
        video_data: { summary: "dog at door" },
        camera_id: "cam-front",
        mode: "event",
        event_id: "evt-001",
      });

      expect(result.results).toHaveLength(1);
      expect(result.results[0].id).toBe("mem-1");

      const fetchCall = vi.mocked(fetch).mock.calls[0];
      expect(fetchCall[0]).toBe(`${BASE_URL}/memories`);
      expect(fetchCall[1]?.method).toBe("POST");

      const sentBody = JSON.parse(fetchCall[1]?.body as string);
      expect(sentBody.mode).toBe("event");
      expect(sentBody.event_id).toBe("evt-001");
    });


    it("passes procedural memory_type directly to server", async () => {
      mockFetch(200, { results: [] });

      await client.add({
        messages: "alert me when animals appear",
        camera_id: "cam-front",
        memory_type: "procedural",
      });

      const sentBody = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
      expect(sentBody.memory_type).toBe("procedural");
    });


    it("preserves segment video_id and event_id fields", async () => {
      mockFetch(200, { results: [] });

      await client.add({
        video_data: { summary: "segment summary" },
        camera_id: "cam-front",
        user_id: "cam-front",
        video_id: "seg_001",
        event_id: "evt_cam-front_123",
      });

      const sentBody = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
      expect(sentBody.video_id).toBe("seg_001");
      expect(sentBody.event_id).toBe("evt_cam-front_123");
      expect(sentBody.run_id).toBeUndefined();
    });

    it("resolves dynamic baseUrl at request time", async () => {
      let baseUrl = "http://localhost:8219";
      client = new ReflectWorldClient({ baseUrl: () => baseUrl, timeoutMs: 5_000 });
      mockFetch(200, { results: [] });

      baseUrl = "http://localhost:28220";
      await client.add({ video_data: { summary: "test" }, camera_id: "cam-front" });

      expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("http://localhost:28220/memories");
    });

    it("uses a 60s default timeout when none is configured", async () => {
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      client = new ReflectWorldClient({ baseUrl: BASE_URL });
      mockFetch(200, { status: "healthy" });

      await client.health();

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
      setTimeoutSpy.mockRestore();
    });
  });

  // -- search() ---------------------------------------------------------------

  describe("search()", () => {
    it("posts to /search and returns results", async () => {
      const mockResp: SearchResponse = {
        results: [
          { id: "mem-2", memory: "person walking", score: 0.88 },
        ],
      };
      mockFetch(200, mockResp);

      const result = await client.search({
        query: "who was at the door",
        camera_id: "cam-front",
        mode: "event",
      });

      expect(result.results![0].score).toBe(0.88);

      const sentBody = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
      expect(sentBody.mode).toBe("event");
    });

    it("passes memory_type directly to server without translation", async () => {
      const mockResp: SearchResponse = {
        results: [
          { id: "mem-3", memory: "plane history", score: 0.91, memory_type: "episodic_trace" },
        ],
      };
      mockFetch(200, mockResp);

      const result = await client.search({
        query: "wright brothers",
        memory_type: "episodic",
      });

      const sentBody = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
      expect(sentBody.memory_type).toBe("episodic");
      expect(result.results![0].memory_type).toBe("episodic_trace");
    });
  });

  // -- getMemories() ---------------------------------------------------------

  describe("getMemories()", () => {
    it("passes memory_type directly in query params", async () => {
      mockFetch(200, []);

      await client.getMemories({
        camera_id: "cam-front",
        memory_type: "semantic_entity",
        sort_order: "asc",
      });

      const fetchUrl = String(vi.mocked(fetch).mock.calls[0][0]);
      expect(fetchUrl).toContain("/memories?");
      expect(fetchUrl).toContain("memory_type=semantic_entity");
      expect(fetchUrl).toContain("sort_order=asc");
    });

    it("passes group alias memory_type directly in query params", async () => {
      mockFetch(200, []);

      await client.getMemories({
        camera_id: "cam-front",
        memory_type: "episodic",
      });

      const fetchUrl = String(vi.mocked(fetch).mock.calls[0][0]);
      expect(fetchUrl).toContain("memory_type=episodic");
    });
  });

  // -- expireMedia() ----------------------------------------------------------

  describe("expireMedia()", () => {
    it("sends PATCH to /memories/expire_media", async () => {
      mockFetch(200, { segment_id: "seg-001", updated_count: 2, status: "ok" });

      const result = await client.expireMedia({ segment_id: "seg-001", camera_id: "cam-01" });

      expect(result.updated_count).toBe(2);
      expect(vi.mocked(fetch).mock.calls[0][1]?.method).toBe("PATCH");
    });
  });

  // -- reidSearch() -----------------------------------------------------------

  describe("reidSearch()", () => {
    it("posts to /reid/search", async () => {
      mockFetch(200, { collection: "reid_entity", results: [] });

      const result = await client.reidSearch({
        vector: new Array(1536).fill(0.1),
        collection: "reid_entity",
        limit: 5,
      });

      expect(result.collection).toBe("reid_entity");
      expect(vi.mocked(fetch).mock.calls[0][0]).toBe(`${BASE_URL}/reid/search`);
    });
  });

  // -- reidUpsert() -----------------------------------------------------------

  describe("reidUpsert()", () => {
    it("posts to /reid/upsert", async () => {
      mockFetch(200, {
        id: "uuid-stable",
        entity_id: "person-001",
        collection: "reid_face",
        event: "INSERT",
      });

      const result = await client.reidUpsert({
        entity_id: "person-001",
        vector: new Array(512).fill(0.2),
        collection: "reid_face",
        user_id: "user-a",
        camera_id: "cam-a",
      });

      expect(result.event).toBe("INSERT");
    });
  });

  // -- reidDelete() -----------------------------------------------------------

  describe("reidDelete()", () => {
    it("deletes reid vectors by camera_id and optional user_id", async () => {
      mockFetch(200, {
        deleted: { reid_face: 1, reid_entity: 2 },
        total_deleted: 3,
      });

      const result = await client.reidDelete({
        camera_id: "cam-a",
        user_id: "user-a",
      });

      expect(result.total_deleted).toBe(3);
      expect(vi.mocked(fetch).mock.calls[0][0]).toBe(`${BASE_URL}/reid?camera_id=cam-a&user_id=user-a`);
      expect(vi.mocked(fetch).mock.calls[0][1]?.method).toBe("DELETE");
    });
  });

  // -- health() ---------------------------------------------------------------

  describe("health()", () => {
    it("sends GET to /health and returns response as-is", async () => {
      mockFetch(200, {
        status: "healthy",
        version: "1.1.0",
        service: "ReflectWorld Memory",
        memory_types: ["episodic_trace", "episodic_entity", "episodic_schema", "episodic_visual", "semantic_entity", "semantic_context", "procedural"],
        reid_collections: ["reid_entity", "reid_face"],
        vector_store: "qdrant",
        llm_provider: "openai",
        embedder_provider: "openai",
      });

      const result = await client.health();

      expect(result.status).toBe("healthy");
      expect(result.memory_types).toEqual([
        "episodic_trace", "episodic_entity", "episodic_schema", "episodic_visual",
        "semantic_entity", "semantic_context", "procedural",
      ]);
      expect(vi.mocked(fetch).mock.calls[0][0]).toBe(`${BASE_URL}/health`);
      expect(vi.mocked(fetch).mock.calls[0][1]?.method).toBe("GET");
    });
  });

  // -- status() ---------------------------------------------------------------

  describe("status()", () => {
    it("sends GET to /status and returns initialized state", async () => {
      mockFetch(200, {
        status: "healthy",
        version: "1.1.0",
        service: "ReflectWorld Memory",
        memory_types: ["episodic_trace"],
        reid_collections: ["reid_entity", "reid_face"],
        vector_store: "qdrant",
        llm_provider: "openai",
        embedder_provider: "openai",
        initialized: true,
      });

      const result = await client.status();

      expect(result.initialized).toBe(true);
      expect(result.reid_collections).toEqual(["reid_entity", "reid_face"]);
      expect(vi.mocked(fetch).mock.calls[0][0]).toBe(`${BASE_URL}/status`);
      expect(vi.mocked(fetch).mock.calls[0][1]?.method).toBe("GET");
    });
  });

  // -- addEpisodicSchema() ---------------------------------------------------

  describe("addEpisodicSchema()", () => {
    it("posts to /memories/schema", async () => {
      mockFetch(200, { id: "schema-1", memory_type: "episodic_schema" });

      const result = await client.addEpisodicSchema({
        summary: "Dog walked across yard twice",
        event_ids: ["evt-1", "evt-2"],
        time_range: { start_ms: 1000, end_ms: 5000 },
        camera_id: "cam-front",
      });

      expect(result.memory_type).toBe("episodic_schema");
      const fetchCall = vi.mocked(fetch).mock.calls[0];
      expect(fetchCall[0]).toBe(`${BASE_URL}/memories/schema`);
      expect(fetchCall[1]?.method).toBe("POST");
    });
  });

  // -- upsertSemanticContext() -----------------------------------------------

  describe("upsertSemanticContext()", () => {
    it("puts to /memories/context", async () => {
      mockFetch(200, { id: "ctx-1", memory_type: "semantic_context" });

      const result = await client.upsertSemanticContext({
        camera_id: "cam-front",
        scene_description: "Front yard with driveway",
        known_entities: "owner, white Toyota",
        daily_routine: "Owner leaves at 8am",
        anomaly_baseline: "No visitors after 10pm",
      });

      expect(result.memory_type).toBe("semantic_context");
      const fetchCall = vi.mocked(fetch).mock.calls[0];
      expect(fetchCall[0]).toBe(`${BASE_URL}/memories/context`);
      expect(fetchCall[1]?.method).toBe("PUT");
    });
  });

  // -- Error handling ---------------------------------------------------------

  describe("error handling", () => {
    it("throws ReflectWorldClientError on non-2xx response", async () => {
      mockFetch(500, { detail: "internal server error" });

      await expect(client.health()).rejects.toThrow(ReflectWorldClientError);
    });

    it("includes status code in the error", async () => {
      mockFetch(404, { detail: "not found" });

      try {
        await client.health();
      } catch (err) {
        expect(err).toBeInstanceOf(ReflectWorldClientError);
        expect((err as ReflectWorldClientError).statusCode).toBe(404);
      }
    });

    it("throws on network error", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      await expect(client.health()).rejects.toThrow(ReflectWorldClientError);
    });

    it("wraps malformed successful JSON responses", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: () => Promise.reject(new SyntaxError("bad json")),
        }),
      );

      await expect(client.health()).rejects.toThrow(ReflectWorldClientError);
      await expect(client.health()).rejects.toThrow("malformed JSON");
    });
  });
});
