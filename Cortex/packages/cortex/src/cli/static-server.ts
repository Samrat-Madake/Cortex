import { existsSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/**
 * Serve static files from the given directory with SPA fallback.
 * Returns true if the request was handled, false otherwise.
 */
export function serveStatic(
  staticDir: string,
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  let filePath = join(staticDir, url.pathname === "/" ? "index.html" : url.pathname);

  // SPA fallback: if file doesn't exist, serve index.html
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    filePath = join(staticDir, "index.html");
    if (!existsSync(filePath)) return false;
  }

  const ext = extname(filePath);
  const mime = MIME[ext] ?? "application/octet-stream";
  const content = readFileSync(filePath);
  res.writeHead(200, { "Content-Type": mime });
  res.end(content);
  return true;
}
