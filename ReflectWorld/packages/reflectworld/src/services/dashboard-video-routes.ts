import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRuntimeHealthReporter } from "@cortex/shared";
import { MAX_UPLOAD_BYTES, VIDEO_EXTENSIONS } from "./dashboard-common.js";
import type { DashboardSessionScope } from "./dashboard-common.js";
import { ensurePreviewVideoFile, ensureThumbnailImageFile } from "./dashboard-ffmpeg.js";
import { serveVideoFile } from "./dashboard-segment-clips.js";
import type { DashboardVideoLibrary } from "./dashboard-videos.js";

const runtimeHealth = createRuntimeHealthReporter("dashboard-video-routes");

export interface DashboardVideoRoutesOptions {
  uploadsDir: string;
  fixturePreviewCacheDir?: string | null;
  videos: DashboardVideoLibrary;
  sessionEnabled: () => boolean;
  scopeFromRequest: (req: IncomingMessage, body?: Record<string, unknown>, url?: URL) => DashboardSessionScope | null;
  requireDashboardSession: (
    req: IncomingMessage,
    res: ServerResponse,
    body?: Record<string, unknown>,
    url?: URL,
  ) => DashboardSessionScope | null;
  enforceSourceLimit: (scope: DashboardSessionScope | null) => { ok: true } | { ok: false; status: number; body: Record<string, unknown> };
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readRequestBuffer: (req: IncomingMessage, maxBytes?: number) => Promise<Buffer>;
  runFfmpegToFile: (args: string[], outputPath: string, label: string, res?: ServerResponse) => Promise<void>;
}

export class DashboardVideoRoutes {
  constructor(private readonly options: DashboardVideoRoutesOptions) {}

  handleList(res: ServerResponse, scope?: DashboardSessionScope | null): void {
    this.options.sendJson(res, 200, { videos: this.options.videos.listVideos(scope) });
  }

  async handleFile(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const videoId = url.searchParams.get("video_id") ?? "";
    const scope = this.options.scopeFromRequest(req, undefined, url);
    if (videoId.startsWith("upload/") && !this.options.videos.uploadVisibleToScope(videoId.slice("upload/".length), scope)) {
      this.options.sendJson(res, 404, { error: "Video not found" });
      return;
    }
    const filePath = this.options.videos.resolveVideoId(videoId);
    if (!filePath) {
      this.options.sendJson(res, 404, { error: "Video not found" });
      return;
    }
    serveVideoFile(req, res, filePath);
  }

  async handlePreview(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const videoId = url.searchParams.get("video_id") ?? "";
    const scope = this.options.scopeFromRequest(req, undefined, url);
    if (videoId.startsWith("upload/") && !this.options.videos.uploadVisibleToScope(videoId.slice("upload/".length), scope)) {
      this.options.sendJson(res, 404, { error: "Video not found" });
      return;
    }
    const filePath = this.options.videos.resolveVideoId(videoId);
    if (!filePath) {
      this.options.sendJson(res, 404, { error: "Video not found" });
      return;
    }
    try {
      const previewPath = await this.ensurePreviewVideo(videoId, filePath, res);
      if (res.destroyed || res.writableEnded) return;
      runtimeHealth.observe({
        component: "preview",
        operation: "generate",
        status: "ok",
        scope: dashboardHealthScope(scope),
      });
      serveVideoFile(req, res, previewPath);
    } catch (err) {
      runtimeHealth.observe({
        component: "preview",
        operation: "generate",
        status: "down",
        code: "generation_failed",
        scope: dashboardHealthScope(scope),
      });
      this.options.sendJson(res, 500, { error: err instanceof Error ? err.message : "Preview generation failed" });
    }
  }

  async handleThumbnail(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const videoId = url.searchParams.get("video_id") ?? "";
    const scope = this.options.scopeFromRequest(req, undefined, url);
    if (videoId.startsWith("upload/") && !this.options.videos.uploadVisibleToScope(videoId.slice("upload/".length), scope)) {
      this.options.sendJson(res, 404, { error: "Video not found" });
      return;
    }
    const filePath = this.options.videos.resolveVideoId(videoId);
    if (!filePath) {
      this.options.sendJson(res, 404, { error: "Video not found" });
      return;
    }
    try {
      const thumbnailPath = await this.ensureThumbnailImage(videoId, filePath, res);
      if (res.destroyed || res.writableEnded) return;
      runtimeHealth.observe({
        component: "preview",
        operation: "thumbnail",
        status: "ok",
        scope: dashboardHealthScope(scope),
      });
      serveJpegFile(req, res, thumbnailPath);
    } catch (err) {
      runtimeHealth.observe({
        component: "preview",
        operation: "thumbnail",
        status: "down",
        code: "generation_failed",
        scope: dashboardHealthScope(scope),
      });
      this.options.sendJson(res, 500, { error: err instanceof Error ? err.message : "Thumbnail generation failed" });
    }
  }

  async ensurePreviewVideo(videoId: string, sourcePath: string, res?: ServerResponse): Promise<string> {
    return ensurePreviewVideoFile({
      uploadsDir: this.options.uploadsDir,
      previewCacheDir: videoId.startsWith("fixture/") ? this.options.fixturePreviewCacheDir : null,
      videoId,
      sourcePath,
      res,
      runFfmpegToFile: this.options.runFfmpegToFile,
    });
  }

  async ensureThumbnailImage(videoId: string, sourcePath: string, res?: ServerResponse): Promise<string> {
    return ensureThumbnailImageFile({
      uploadsDir: this.options.uploadsDir,
      previewCacheDir: videoId.startsWith("fixture/") ? this.options.fixturePreviewCacheDir : null,
      videoId,
      sourcePath,
      res,
      runFfmpegToFile: this.options.runFfmpegToFile,
    });
  }

  async handleUpload(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const scope = this.options.requireDashboardSession(req, res, undefined, url);
    if (this.options.sessionEnabled() && !scope) return;
    const limit = this.options.enforceSourceLimit(scope);
    if (!limit.ok) {
      this.options.sendJson(res, limit.status, limit.body);
      return;
    }
    try {
      const contentType = req.headers["content-type"] ?? "";
      if (!contentType.includes("multipart/form-data")) {
        this.options.sendJson(res, 400, { error: "multipart/form-data upload required" });
        return;
      }
      const body = await this.options.readRequestBuffer(req, MAX_UPLOAD_BYTES + 1024 * 1024);
      const upload = this.options.videos.parseMultipartUpload(body, contentType);
      if (!upload) {
        this.options.sendJson(res, 400, { error: "Could not parse uploaded file" });
        return;
      }
      if (upload.data.length > MAX_UPLOAD_BYTES) {
        this.options.sendJson(res, 413, { error: "Video file exceeds 500MB limit" });
        return;
      }
      const filename = this.options.videos.sanitizeVideoFilename(upload.filename);
      if (!filename) {
        this.options.sendJson(res, 400, { error: `Unsupported video filename or extension. Allowed: ${[...VIDEO_EXTENSIONS].join(", ")}` });
        return;
      }
      const scopedFilename = this.options.sessionEnabled() && scope
        ? `${this.options.videos.scopedUploadPrefix(scope)}${filename}`
        : filename;
      const dest = this.options.videos.uniqueUploadPath(scopedFilename);
      this.options.videos.writeUpload(dest.path, upload.data);
      const sizeMb = Math.round((upload.data.length / 1024 / 1024) * 10) / 10;
      this.options.sendJson(res, 200, {
        ok: true,
        video: {
          video_id: `upload/${dest.filename}`,
          name: this.options.videos.displayUploadName(dest.filename, scope),
          size_mb: sizeMb,
          source: "upload",
          updated_at: Date.now(),
          tags: [],
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Upload failed";
      this.options.sendJson(res, msg.includes("exceeds") ? 413 : 500, { error: msg });
    }
  }

  async handleDelete(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const scope = this.options.scopeFromRequest(req, undefined, url);
    try {
      const raw = await this.options.readRequestBuffer(req, 1024 * 1024);
      const payload = JSON.parse(raw.toString("utf8")) as { video_id?: unknown };
      const videoId = typeof payload.video_id === "string" ? payload.video_id.trim() : "";
      if (!videoId.startsWith("upload/")) {
        this.options.sendJson(res, 400, { error: "Only uploaded videos can be deleted" });
        return;
      }
      const uploadName = videoId.slice("upload/".length);
      if (!this.options.videos.uploadVisibleToScope(uploadName, scope)) {
        this.options.sendJson(res, 404, { error: "Uploaded video not found" });
        return;
      }
      const uploadRemoved = this.options.videos.deleteUploadVideo(videoId);
      if (!uploadRemoved) {
        this.options.sendJson(res, 404, { error: "Uploaded video not found" });
        return;
      }
      this.options.sendJson(res, 200, { ok: true, video_id: videoId, upload_removed: true });
    } catch (err) {
      this.options.sendJson(res, 400, { error: err instanceof Error ? err.message : "Invalid video delete request" });
    }
  }
}

function dashboardHealthScope(scope: DashboardSessionScope | null): { user_id?: string; session_id?: string } | undefined {
  if (!scope) return undefined;
  return { user_id: scope.userId, session_id: scope.sessionId };
}

function serveJpegFile(req: IncomingMessage, res: ServerResponse, filePath: string): void {
  const stat = statSync(filePath);
  res.writeHead(200, {
    "Content-Type": "image/jpeg",
    "Content-Length": String(stat.size),
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "max-age=3600",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}
