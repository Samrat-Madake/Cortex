import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import type { DashboardSessionScope } from "./dashboard-common.js";

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mpg": "video/mpeg",
  ".mpeg": "video/mpeg",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

export interface DashboardStaticFilesOptions {
  distDir: string;
  mediaDirs: string[];
  scopeFromRequest: (req: IncomingMessage, body?: Record<string, unknown>, url?: URL) => DashboardSessionScope | null;
  sourceVisibleToSession: (sourceId: string, scope?: DashboardSessionScope | null) => boolean;
}

export class DashboardStaticFiles {
  constructor(private readonly options: DashboardStaticFilesOptions) {}

  hasIndex(): boolean {
    return existsSync(join(this.options.distDir, "index.html"));
  }

  handleMedia(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (!url.pathname.startsWith("/media/")) return false;
    const mediaPath = decodeURIComponent(url.pathname.replace("/media/", ""));
    const scope = this.options.scopeFromRequest(req, undefined, url);
    const mediaSourceId = mediaPath.split(/[\\/]/)[0] ?? "";
    if (!mediaSourceId || !this.options.sourceVisibleToSession(mediaSourceId, scope)) {
      res.writeHead(404); res.end("Not found");
      return true;
    }
    for (const root of this.options.mediaDirs) {
      const rootAbs = resolve(root);
      const p = resolve(rootAbs, mediaPath);
      const rel = relative(rootAbs, p);
      if (rel.startsWith("..") || rel === "") continue;
      if (existsSync(p) && statSync(p).isFile()) {
        const ext = extname(p);
        const mime = MIME[ext] ?? "application/octet-stream";
        res.writeHead(200, { "Content-Type": mime, "Cache-Control": "max-age=3600" });
        res.end(readFileSync(p));
        return true;
      }
    }
    res.writeHead(404); res.end("Not found");
    return true;
  }

  handleStatic(res: ServerResponse, url: URL, hasIndex: boolean): void {
    if (!hasIndex) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("Dashboard UI not built. Run: cd packages/dashboard && npm run build");
      return;
    }

    let filePath = join(this.options.distDir, url.pathname === "/" ? "index.html" : url.pathname);

    // SPA fallback
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      filePath = join(this.options.distDir, "index.html");
    }

    const ext = extname(filePath);
    const mime = MIME[ext] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    res.end(readFileSync(filePath));
  }
}
