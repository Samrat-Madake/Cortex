import { createReadStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DashboardSessionScope } from "./dashboard-common.js";
import type { PipelineStore } from "../store.js";

const VIDEO_MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mpg": "video/mpeg",
  ".mpeg": "video/mpeg",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

interface DashboardSourceLabel {
  label: string;
  isMediaSource: boolean;
}

export interface DashboardSegmentClipServiceOptions {
  store: PipelineStore | null;
  recordingsDir: string | null;
  uploadsDir: string;
  scopeFromRequest: (req: IncomingMessage, body?: Record<string, unknown>, url?: URL) => DashboardSessionScope | null;
  sourceVisibleToSession: (sourceId: string, scope?: DashboardSessionScope | null) => boolean;
  sourceLabels: (scope?: DashboardSessionScope | null) => Map<string, DashboardSourceLabel>;
  readSourceConfig: (cameraId: string) => Record<string, unknown> | null;
  runFfmpegToFile: (args: string[], outputPath: string, label: string, res?: ServerResponse) => Promise<void>;
}

export function serveVideoFile(req: IncomingMessage, res: ServerResponse, filePath: string): void {
  const stat = statSync(filePath);
  const mime = VIDEO_MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.range;
  const headers = {
    "Content-Type": mime,
    "Accept-Ranges": "bytes",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "max-age=3600",
  };

  if (!range) {
    res.writeHead(200, { ...headers, "Content-Length": String(stat.size) });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(filePath).pipe(res);
    return;
  }

  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    res.writeHead(416, headers);
    res.end();
    return;
  }
  const start = match[1] ? parseInt(match[1], 10) : 0;
  const end = match[2] ? Math.min(parseInt(match[2], 10), stat.size - 1) : stat.size - 1;
  if (start >= stat.size || end < start) {
    res.writeHead(416, { ...headers, "Content-Range": `bytes */${stat.size}` });
    res.end();
    return;
  }
  res.writeHead(206, {
    ...headers,
    "Content-Length": String(end - start + 1),
    "Content-Range": `bytes ${start}-${end}/${stat.size}`,
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(filePath, { start, end }).pipe(res);
}

export class DashboardSegmentClipService {
  constructor(private readonly options: DashboardSegmentClipServiceOptions) {}

  async handle(req: IncomingMessage, segmentId: string, res: ServerResponse, url?: URL): Promise<void> {
    const cors = { "Access-Control-Allow-Origin": "*" };
    const store = this.options.store;

    if (!store) {
      res.writeHead(503, { "Content-Type": "application/json", ...cors });
      res.end('{"error":"PipelineStore not available"}');
      return;
    }

    const entry = store.getBySegmentId(segmentId);
    if (!entry) {
      res.writeHead(404, { "Content-Type": "application/json", ...cors });
      res.end('{"error":"Segment not found"}');
      return;
    }
    const scope = this.options.scopeFromRequest(req, undefined, url);
    if (!this.options.sourceVisibleToSession(entry.camera_id, scope)) {
      res.writeHead(404, { "Content-Type": "application/json", ...cors });
      res.end('{"error":"Segment not found"}');
      return;
    }

    const segmentStartMs = entry.segment_start ?? new Date(entry.created_at + "Z").getTime();
    const segmentDurationSec = entry.duration_sec || 10;

    if (entry.raw_url && entry.raw_url.endsWith(".mp4") && existsSync(entry.raw_url)) {
      const rawStartMs = this.recordingStartMs(entry.raw_url);
      if (rawStartMs !== null && this.isWallClockTimestampMs(segmentStartMs)) {
        try {
          const offsetSec = Math.max(0, (segmentStartMs - rawStartMs) / 1000);
          const clipPath = await this.ensureSegmentClip(segmentId, entry.raw_url, offsetSec, segmentDurationSec, res);
          if (res.destroyed || res.writableEnded) return;
          serveVideoFile(req, res, clipPath);
        } catch (err) {
          if (!res.destroyed && !res.writableEnded) {
            res.writeHead(500, { "Content-Type": "application/json", ...cors });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Segment clip generation failed" }));
          }
        }
        return;
      }
      serveVideoFile(req, res, entry.raw_url);
      return;
    }

    const sourceMeta = this.options.sourceLabels(scope).get(entry.camera_id);
    const sourceConfig = this.options.readSourceConfig(entry.camera_id);
    const sourceInput = typeof sourceConfig?.input === "string" ? sourceConfig.input : "";
    const isMediaSource = sourceMeta?.isMediaSource === true
      || sourceConfig?.protocol === "file"
      || entry.camera_id.startsWith("video-");
    if (isMediaSource && sourceInput && existsSync(sourceInput)) {
      try {
        const clipPath = await this.ensureSegmentClip(segmentId, sourceInput, Math.max(0, segmentStartMs / 1000), segmentDurationSec, res);
        if (res.destroyed || res.writableEnded) return;
        serveVideoFile(req, res, clipPath);
      } catch (err) {
        if (!res.destroyed && !res.writableEnded) {
          res.writeHead(500, { "Content-Type": "application/json", ...cors });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Segment clip generation failed" }));
        }
      }
      return;
    }

    if (!this.options.recordingsDir) {
      res.writeHead(503, { "Content-Type": "application/json", ...cors });
      res.end('{"error":"Recordings directory not configured"}');
      return;
    }

    const cameraDir = join(this.options.recordingsDir, entry.camera_id);
    if (!existsSync(cameraDir)) {
      res.writeHead(404, { "Content-Type": "application/json", ...cors });
      res.end('{"error":"No recordings found for camera"}');
      return;
    }

    const files = readdirSync(cameraDir)
      .filter(f => f.endsWith(".mp4"))
      .map(name => {
        const path = join(cameraDir, name);
        const startMs = this.recordingStartMs(path);
        return startMs === null ? null : { name, path, startMs };
      })
      .filter((f): f is NonNullable<typeof f> => f !== null)
      .sort((a, b) => a.startMs - b.startMs);

    if (files.length === 0) {
      res.writeHead(404, { "Content-Type": "application/json", ...cors });
      res.end('{"error":"No recording files found"}');
      return;
    }

    let matched = files[0];
    for (const f of files) {
      if (f.startMs <= segmentStartMs) matched = f;
      else break;
    }
    if (!this.isWallClockTimestampMs(segmentStartMs)) {
      serveVideoFile(req, res, matched.path);
      return;
    }

    const offsetSec = Math.max(0, (segmentStartMs - matched.startMs) / 1000);
    try {
      const clipPath = await this.ensureSegmentClip(segmentId, matched.path, offsetSec, segmentDurationSec, res);
      if (res.destroyed || res.writableEnded) return;
      serveVideoFile(req, res, clipPath);
    } catch (err) {
      if (!res.destroyed && !res.writableEnded) {
        res.writeHead(500, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Segment clip generation failed" }));
      }
    }
  }

  private isWallClockTimestampMs(timestampMs: number): boolean {
    // Media PTS for local files is usually near zero; recording filenames are
    // wall-clock based. Only align against recording filenames when the segment
    // timestamp is clearly an epoch timestamp.
    return timestampMs >= Date.UTC(2000, 0, 1);
  }

  private recordingStartMs(filePath: string): number | null {
    const name = basename(filePath);
    const eventMatch = name.match(/_event_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.mp4$/);
    const streamMatch = name.match(/_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.mp4$/);
    const m = eventMatch ?? streamMatch;
    if (!m) return null;
    const fileDate = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`);
    const startMs = fileDate.getTime();
    return Number.isFinite(startMs) ? startMs : null;
  }

  private async ensureSegmentClip(
    segmentId: string,
    sourcePath: string,
    offsetSec: number,
    durationSec: number,
    res?: ServerResponse,
  ): Promise<string> {
    const clipDir = join(this.options.uploadsDir, ".segment-clips");
    if (!existsSync(clipDir)) mkdirSync(clipDir, { recursive: true });

    const sourceStat = statSync(sourcePath);
    const safeSegmentId = segmentId.replace(/[^a-zA-Z0-9._-]/g, "_");
    const safeOffset = Math.max(0, Math.round(offsetSec * 1000));
    const safeDuration = Math.max(1, Math.round(durationSec * 1000));
    const clipPath = join(clipDir, `${safeSegmentId}-${safeOffset}-${safeDuration}.mp4`);
    if (existsSync(clipPath) && statSync(clipPath).mtimeMs >= sourceStat.mtimeMs) {
      return clipPath;
    }

    const tmpPath = `${clipPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    const ffmpegArgs = [
      "-ss", String(offsetSec),
      "-i", sourcePath,
      "-t", String(durationSec),
      "-an",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-pix_fmt", "yuv420p",
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-movflags", "+faststart",
      "-f", "mp4",
      tmpPath,
    ];

    try {
      await this.options.runFfmpegToFile(ffmpegArgs, tmpPath, "segment clip", res);
      renameSync(tmpPath, clipPath);
    } finally {
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        // Best-effort cleanup only.
      }
    }
    return clipPath;
  }
}
