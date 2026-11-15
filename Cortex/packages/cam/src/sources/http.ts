import type { FrameResult, SnapshotOptions } from "../types.js";

/** HTTP-based source for fetching static JPEG snapshots from URLs. */
export class HTTPSource {
  constructor(
    public readonly name: string,
    public readonly url: string,
  ) {}

  /** Fetch a single frame from the HTTP endpoint. */
  async snapshot(_options?: SnapshotOptions): Promise<FrameResult> {
    const response = await fetch(this.url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText} fetching ${this.url}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    return {
      data: buffer.toString("base64"),
      timestamp: Date.now(),
      source_name: this.name,
    };
  }
}
