import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { DashboardSessionScope } from "./dashboard-common.js";
import { GO2RTC_STREAMS_CACHE_TTL_MS } from "./dashboard-common.js";

export interface Go2rtcStreamHealth {
  exists: boolean;
  active: boolean;
  producerCount: number;
  consumerCount: number;
  bytes: number;
}

export interface DashboardLiveProxyOptions {
  go2rtcApiPort: number;
  scopeFromRequest: (req: IncomingMessage, body?: Record<string, unknown>, url?: URL) => DashboardSessionScope | null;
  sourceVisibleToSession: (sourceId: string, scope?: DashboardSessionScope | null) => boolean;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
}

export class DashboardLiveProxy {
  private streamsCache: { expiresAt: number; value: Record<string, unknown> | null } | null = null;
  private streamsInFlight: Promise<Record<string, unknown> | null> | null = null;

  constructor(private readonly options: DashboardLiveProxyOptions) {}

  requireVisibleSource(req: IncomingMessage, res: ServerResponse, url: URL, src: string): boolean {
    const scope = this.options.scopeFromRequest(req, undefined, url);
    if (this.options.sourceVisibleToSession(src, scope)) return true;
    this.options.sendJson(res, 404, { error: "Source not found" });
    return false;
  }

  async handleStream(req: IncomingMessage, res: ServerResponse, url: URL, format: "mp4" | "mjpeg"): Promise<void> {
    const src = url.searchParams.get("src")?.trim();
    if (!src) {
      this.options.sendJson(res, 400, { error: "src is required" });
      return;
    }
    if (!this.requireVisibleSource(req, res, url, src)) return;

    const controller = new AbortController();
    const abort = () => controller.abort();
    req.on("close", abort);

    try {
      const upstreamUrl = `http://127.0.0.1:${this.options.go2rtcApiPort}/api/stream.${format}?src=${encodeURIComponent(src)}`;
      const upstream = await fetch(upstreamUrl, { signal: controller.signal });
      if (!upstream.ok || !upstream.body) {
        this.options.sendJson(res, upstream.status || 502, { error: `go2rtc stream unavailable for ${src}` });
        return;
      }
      res.writeHead(200, {
        "Content-Type": upstream.headers.get("content-type") ?? "multipart/x-mixed-replace",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });

      const stream = Readable.fromWeb(upstream.body as ReadableStream<Uint8Array>);
      req.on("close", () => stream.destroy());
      stream.on("error", () => {
        if (!res.destroyed) res.end();
      });
      stream.pipe(res);
    } catch (err) {
      if (controller.signal.aborted) return;
      if (!res.headersSent) {
        this.options.sendJson(res, 502, { error: err instanceof Error ? err.message : "go2rtc stream proxy failed" });
      } else if (!res.destroyed) {
        res.end();
      }
    }
  }

  async handleStatus(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const src = url.searchParams.get("src")?.trim();
    if (!src) {
      this.options.sendJson(res, 400, { error: "src is required" });
      return;
    }
    if (!this.requireVisibleSource(req, res, url, src)) return;
    const health = await this.getStreamHealth(src);
    this.options.sendJson(res, 200, {
      src,
      exists: health.exists,
      active: health.active,
      producer_count: health.producerCount,
      consumer_count: health.consumerCount,
      bytes: health.bytes,
    });
  }

  async handleFrame(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const src = url.searchParams.get("src")?.trim();
    if (!src) {
      this.options.sendJson(res, 400, { error: "src is required" });
      return;
    }
    if (!this.requireVisibleSource(req, res, url, src)) return;

    try {
      const upstreamUrl = `http://127.0.0.1:${this.options.go2rtcApiPort}/api/frame.jpeg?src=${encodeURIComponent(src)}`;
      const upstream = await fetch(upstreamUrl);
      if (!upstream.ok) {
        this.options.sendJson(res, upstream.status || 502, { error: `go2rtc frame unavailable for ${src}` });
        return;
      }

      const body = Buffer.from(await upstream.arrayBuffer());
      if (body.length === 0) {
        this.options.sendJson(res, 502, { error: `go2rtc frame returned no data for ${src}` });
        return;
      }
      res.writeHead(200, {
        "Content-Type": upstream.headers.get("content-type") ?? "image/jpeg",
        "Content-Length": String(body.length),
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(body);
    } catch (err) {
      this.options.sendJson(res, 502, { error: err instanceof Error ? err.message : "go2rtc frame proxy failed" });
    }
  }

  async getStreams(): Promise<Record<string, unknown> | null> {
    const now = Date.now();
    if (this.streamsCache && this.streamsCache.expiresAt > now) {
      return this.streamsCache.value;
    }
    if (this.streamsInFlight) return this.streamsInFlight;

    this.streamsInFlight = (async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${this.options.go2rtcApiPort}/api/streams`);
        if (!res.ok) return null;
        return await res.json() as Record<string, unknown>;
      } catch {
        return null;
      }
    })();

    try {
      const value = await this.streamsInFlight;
      this.streamsCache = {
        value,
        expiresAt: Date.now() + GO2RTC_STREAMS_CACHE_TTL_MS,
      };
      return value;
    } finally {
      this.streamsInFlight = null;
    }
  }

  private async getStreamHealth(src: string): Promise<Go2rtcStreamHealth> {
    return this.readStreamHealth(await this.getStreams(), src);
  }

  readStreamHealth(streams: Record<string, unknown> | null, src: string): Go2rtcStreamHealth {
    const entry = streams?.[src];
    if (!entry || typeof entry !== "object") {
      return { exists: false, active: false, producerCount: 0, consumerCount: 0, bytes: 0 };
    }
    const record = entry as Record<string, unknown>;
    const producers = Array.isArray(record.producers) ? record.producers : [];
    const consumers = Array.isArray(record.consumers) ? record.consumers : [];
    let bytes = 0;
    for (const producer of producers) {
      if (!producer || typeof producer !== "object") continue;
      const producerRecord = producer as Record<string, unknown>;
      const receivers = Array.isArray(producerRecord.receivers) ? producerRecord.receivers : [];
      for (const receiver of receivers) {
        if (!receiver || typeof receiver !== "object") continue;
        const value = (receiver as Record<string, unknown>).bytes;
        if (typeof value === "number" && Number.isFinite(value)) bytes += value;
      }
    }
    return {
      exists: true,
      // A go2rtc producer is enough to consider the stream playable. Some
      // WebRTC/RTSP bridge producers do not expose receiver byte counters until
      // a consumer is attached, but frame/stream proxies can still read video.
      active: producers.length > 0,
      producerCount: producers.length,
      consumerCount: consumers.length,
      bytes,
    };
  }
}
