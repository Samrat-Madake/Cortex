/**
 * Thin HTTP client for the Python Pipeline Service.
 *
 * Sends a video URL and receives structured perception results.
 */

export interface ProcessRequest {
  video_url: string;
  camera_id: string;
  mode: string;
  event_id?: string;
  capabilities?: string[];
}

export interface ProcessResponse {
  task_id: string;
  status: string;
  message: string;
}

export interface HealthResponse {
  status: string;
  capabilities: {
    available: string[];
    all: string[];
  };
}

export interface TaskResult {
  status: string;
  result?: Record<string, unknown>;
  error?: string;
}

export interface PipelineClientConfig {
  pipelineUrl: string;
  timeoutMs?: number;
}

export class PipelineClient {
  private readonly url: string;
  private readonly timeoutMs: number;

  constructor(config: PipelineClientConfig) {
    this.url = config.pipelineUrl.replace(/\/$/, "");
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  async process(req: ProcessRequest): Promise<ProcessResponse> {
    const resp = await fetch(`${this.url}/process`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!resp.ok) {
      throw new Error(`Pipeline /process failed: ${resp.status} ${resp.statusText}`);
    }
    return resp.json() as Promise<ProcessResponse>;
  }

  async health(): Promise<HealthResponse> {
    const resp = await fetch(`${this.url}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    return resp.json() as Promise<HealthResponse>;
  }

  async getTask(taskId: string): Promise<TaskResult> {
    const resp = await fetch(`${this.url}/task/${taskId}`, {
      signal: AbortSignal.timeout(5_000),
    });
    return resp.json() as Promise<TaskResult>;
  }

  async waitForResult(
    taskId: string,
    opts: { pollIntervalMs?: number; maxWaitMs?: number } = {},
  ): Promise<TaskResult> {
    const interval = opts.pollIntervalMs ?? 1_000;
    const maxWait = opts.maxWaitMs ?? 120_000;
    const deadline = Date.now() + maxWait;

    while (Date.now() < deadline) {
      const result = await this.getTask(taskId);
      if (result.status === "completed" || result.status === "failed") {
        return result;
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error(`Task ${taskId} did not complete within ${maxWait}ms`);
  }
}
