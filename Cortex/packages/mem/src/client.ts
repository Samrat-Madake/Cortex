// packages/mem/src/client.ts
import type {
  AddMemoryRequest,
  AddMemoryResponse,
  SearchRequest,
  SearchResponse,
  GetMemoriesRequest,
  GetMemoriesResponse,
  DeleteMemoriesRequest,
  DeleteMemoryByIdRequest,
  DeleteMemoryResponse,
  ExpireMediaRequest,
  ExpireMediaResponse,
  SetIdentityRequest,
  SetIdentityResponse,
  ReidSearchRequest,
  ReidSearchResponse,
  ReidUpsertRequest,
  ReidUpsertResponse,
  ReidUpdateIdentityRequest,
  ReidUpdateIdentityResponse,
  ReidGalleryUpdateRequest,
  ReidGalleryUpdateResponse,
  BatchInitRequest,
  BatchInitResponse,
  ReidDeleteRequest,
  ReidDeleteResponse,
  HealthResponse,
  StatusResponse,
  AddSchemaRequest,
  UpsertContextRequest,
} from "./types.js";

/** Subset of the memory client config needed by the HTTP layer. */
export interface CortexClientConfig {
  baseUrl: string | (() => string);
  timeoutMs?: number;
}

export class CortexClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "CortexClientError";
  }
}

/**
 * Thin HTTP client for the Cortex FastAPI service.
 * All methods throw CortexClientError on non-2xx responses.
 */
export class CortexClient {
  private readonly getBaseUrl: () => string;
  private readonly timeoutMs: number;

  constructor(config: CortexClientConfig) {
    const baseUrl = config.baseUrl;
    this.getBaseUrl = typeof baseUrl === "function"
      ? () => baseUrl().replace(/\/$/, "")
      : () => baseUrl.replace(/\/$/, "");
    this.timeoutMs = config.timeoutMs ?? 60_000;
  }

  // -- Private helpers --------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.getBaseUrl()}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new CortexClientError(
        `Network error calling ${method} ${path}: ${String(err)}`,
        0,
        null,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let errorBody: unknown = null;
      try {
        errorBody = await response.json();
      } catch {
        // ignore parse error
      }
      throw new CortexClientError(
        `Cortex ${method} ${path} returned ${response.status}`,
        response.status,
        errorBody,
      );
    }

    try {
      return (await response.json()) as T;
    } catch (err) {
      throw new CortexClientError(
        `Cortex ${method} ${path} returned malformed JSON: ${String(err)}`,
        response.status,
        null,
      );
    }
  }

  // -- Public API -------------------------------------------------------------

  /**
   * Store a new memory from video structured data.
   * Corresponds to POST /memories.
   */
  async add(request: AddMemoryRequest): Promise<AddMemoryResponse> {
    return this.request<AddMemoryResponse>("POST", "/memories", request);
  }

  /**
   * Semantic search across memory collections.
   * Corresponds to POST /search.
   */
  async search(request: SearchRequest): Promise<SearchResponse> {
    return this.request<SearchResponse>("POST", "/search", request);
  }

  /**
   * List memories by filter criteria.
   * Corresponds to GET /memories?camera_id=...&user_id=...
   */
  async getMemories(request: GetMemoriesRequest): Promise<GetMemoriesResponse> {
    const params = new URLSearchParams();
    if (request.user_id) params.set("user_id", request.user_id);
    if (request.agent_id) params.set("agent_id", request.agent_id);
    if (request.run_id) params.set("run_id", request.run_id);
    if (request.video_id) params.set("video_id", request.video_id);
    if (request.entity_id) params.set("entity_id", request.entity_id);
    if (request.camera_id) params.set("camera_id", request.camera_id);
    if (request.memory_type) params.set("memory_type", request.memory_type);
    if (request.limit) params.set("limit", String(request.limit));
    if (request.sort_order) params.set("sort_order", request.sort_order);
    const qs = params.toString();
    return this.request<GetMemoriesResponse>("GET", `/memories${qs ? `?${qs}` : ""}`);
  }

  /**
   * Delete memories by filter criteria (batch).
   * Corresponds to DELETE /memories?camera_id=...&user_id=...
   */
  async deleteMemories(request: DeleteMemoriesRequest): Promise<DeleteMemoryResponse> {
    const params = new URLSearchParams();
    if (request.user_id) params.set("user_id", request.user_id);
    if (request.agent_id) params.set("agent_id", request.agent_id);
    if (request.run_id) params.set("run_id", request.run_id);
    if (request.video_id) params.set("video_id", request.video_id);
    if (request.entity_id) params.set("entity_id", request.entity_id);
    if (request.camera_id) params.set("camera_id", request.camera_id);
    if (request.memory_type) params.set("memory_type", request.memory_type);
    if (request.data_type) params.set("data_type", request.data_type);
    const qs = params.toString();
    return this.request<DeleteMemoryResponse>("DELETE", `/memories${qs ? `?${qs}` : ""}`);
  }

  /**
   * Delete a single memory by ID.
   * Corresponds to DELETE /memories/{memory_id}
   */
  async deleteMemoryById(request: DeleteMemoryByIdRequest): Promise<DeleteMemoryResponse> {
    const params = new URLSearchParams();
    if (request.memory_type) params.set("memory_type", request.memory_type);
    if (request.data_type) params.set("data_type", request.data_type);
    const qs = params.toString();
    return this.request<DeleteMemoryResponse>(
      "DELETE",
      `/memories/${request.memory_id}${qs ? `?${qs}` : ""}`,
    );
  }

  /**
   * Mark media_urls as expired for all episodic memories of a segment.
   * Corresponds to PATCH /memories/expire_media.
   */
  async expireMedia(request: ExpireMediaRequest): Promise<ExpireMediaResponse> {
    return this.request<ExpireMediaResponse>("PATCH", "/memories/expire_media", request);
  }

  /**
   * Create or update an identity memory for an entity.
   * Corresponds to POST /identity/set.
   */
  async setIdentity(request: SetIdentityRequest): Promise<SetIdentityResponse> {
    return this.request<SetIdentityResponse>("POST", "/identity/set", request);
  }

  /**
   * Search a ReID collection by feature vector similarity.
   * Corresponds to POST /reid/search.
   */
  async reidSearch(request: ReidSearchRequest): Promise<ReidSearchResponse> {
    return this.request<ReidSearchResponse>("POST", "/reid/search", request);
  }

  /**
   * Insert or update a feature vector for an entity.
   * Corresponds to POST /reid/upsert.
   */
  async reidUpsert(request: ReidUpsertRequest): Promise<ReidUpsertResponse> {
    return this.request<ReidUpsertResponse>("POST", "/reid/upsert", request);
  }

  /**
   * Update stable ReID identity metadata.
   * Corresponds to PATCH /reid/identity.
   */
  async reidUpdateIdentity(request: ReidUpdateIdentityRequest): Promise<ReidUpdateIdentityResponse> {
    return this.request<ReidUpdateIdentityResponse>("PATCH", "/reid/identity", request);
  }

  /**
   * Diversity-aware gallery update for a previously matched entity.
   * Corresponds to POST /reid/gallery-update.
   */
  async reidGalleryUpdate(request: ReidGalleryUpdateRequest): Promise<ReidGalleryUpdateResponse> {
    return this.request<ReidGalleryUpdateResponse>("POST", "/reid/gallery-update", request);
  }

  /**
   * Multi-slot gallery initialization for a new entity.
   * Corresponds to POST /reid/batch-init.
   */
  async reidBatchInit(request: BatchInitRequest): Promise<BatchInitResponse> {
    return this.request<BatchInitResponse>("POST", "/reid/batch-init", request);
  }

  /**
   * Delete ReID vectors observed from a camera/source. ReID search remains user-scoped;
   * camera_id is stored only to support source lifecycle cleanup.
   * Corresponds to DELETE /reid?camera_id=...&user_id=...
   */
  async reidDelete(request: ReidDeleteRequest): Promise<ReidDeleteResponse> {
    const params = new URLSearchParams();
    params.set("camera_id", request.camera_id);
    if (request.user_id) params.set("user_id", request.user_id);
    return this.request<ReidDeleteResponse>("DELETE", `/reid?${params.toString()}`);
  }

  /**
   * Create an episodic schema memory that aggregates related events.
   * Corresponds to POST /memories/schema.
   */
  async addEpisodicSchema(request: AddSchemaRequest): Promise<any> {
    return this.request<any>("POST", "/memories/schema", request);
  }

  /**
   * Create or update a semantic context memory for a camera.
   * Corresponds to PUT /memories/context.
   */
  async upsertSemanticContext(request: UpsertContextRequest): Promise<any> {
    return this.request<any>("PUT", "/memories/context", request);
  }

  /**
   * Health check -- returns service status.
   * Corresponds to GET /health.
   */
  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/health");
  }

  /**
   * Detailed service status.
   * Corresponds to GET /status.
   */
  async status(): Promise<StatusResponse> {
    return this.request<StatusResponse>("GET", "/status");
  }
}
