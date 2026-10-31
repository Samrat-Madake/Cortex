import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import type { DashboardSessionScope } from "./dashboard-common.js";
import { VIDEO_EXTENSIONS } from "./dashboard-common.js";
import { PREVIEW_SUFFIXES, THUMBNAIL_SUFFIX } from "./dashboard-ffmpeg.js";

function compareVideoNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export interface DashboardVideoEntry {
  video_id: string;
  name: string;
  size_mb: number;
  source: "upload" | "fixture";
  updated_at: number;
  duration_sec?: number;
  tags: string[];
}

export interface MultipartUpload {
  filename: string;
  data: Buffer;
}

export interface DashboardVideoLibraryOptions {
  uploadsDir: string;
  uploadSearchDirs: string[];
  fixtureVideosDir: string | null;
  sessionEnabled: () => boolean;
  ffprobeBin?: string;
}

export class DashboardVideoLibrary {
  private readonly durationCache = new Map<string, { mtimeMs: number; size: number; durationSec?: number }>();

  constructor(private readonly options: DashboardVideoLibraryOptions) {}

  sanitizeVideoFilename(name: string): string | null {
    const base = basename(name).replace(/[\x00-\x1f\x7f/\\]/g, "_").replace(/[^a-zA-Z0-9._-]/g, "_");
    const ext = extname(base).toLowerCase();
    if (!base || base === "." || base === ".." || !VIDEO_EXTENSIONS.has(ext)) return null;
    return base;
  }

  uniqueUploadPath(filename: string): { path: string; filename: string } {
    if (!existsSync(this.options.uploadsDir)) mkdirSync(this.options.uploadsDir, { recursive: true });
    const ext = extname(filename);
    const stem = filename.slice(0, filename.length - ext.length);
    let candidate = filename;
    let n = 1;
    while (existsSync(join(this.options.uploadsDir, candidate))) {
      candidate = `${stem}_${n}${ext}`;
      n += 1;
    }
    return { path: join(this.options.uploadsDir, candidate), filename: candidate };
  }

  scopedUploadPrefix(scope?: DashboardSessionScope | null): string {
    if (!this.options.sessionEnabled() || !scope) return "";
    return `session_${scope.sessionId}_`;
  }

  uploadVisibleToScope(name: string, scope?: DashboardSessionScope | null): boolean {
    if (!this.options.sessionEnabled()) return true;
    if (scope?.isAdmin) return true;
    const prefix = this.scopedUploadPrefix(scope);
    return Boolean(prefix && name.startsWith(prefix));
  }

  displayUploadName(name: string, scope?: DashboardSessionScope | null): string {
    const prefix = this.scopedUploadPrefix(scope);
    return prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
  }

  listVideos(scope?: DashboardSessionScope | null): DashboardVideoEntry[] {
    const out: Array<DashboardVideoEntry & { sortTimeMs: number }> = [];
    const seenUploads = new Set<string>();
    const addVideo = (root: string, relName: string, source: "upload" | "fixture") => {
      const file = join(root, relName);
      const stat = statSync(file);
      if (!stat.isFile()) return;
      if (source === "upload") {
        if (!this.uploadVisibleToScope(relName, scope)) return;
        if (seenUploads.has(relName)) return;
        seenUploads.add(relName);
      }
      const metadata = this.readVideoMetadata(file, stat);
      out.push({
        video_id: `${source}/${relName}`,
        name: source === "upload" ? this.displayUploadName(relName, scope) : relName,
        size_mb: Math.round((stat.size / 1024 / 1024) * 10) / 10,
        source,
        updated_at: Math.round(stat.mtimeMs),
        ...(metadata.duration_sec !== undefined ? { duration_sec: metadata.duration_sec } : {}),
        tags: metadata.tags,
        sortTimeMs: stat.mtimeMs,
      });
    };
    const scan = (dir: string | null, source: "upload" | "fixture", prefix = "") => {
      if (!dir || !existsSync(dir)) return;
      for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
        const relName = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (source === "fixture") scan(dir, source, relName);
          continue;
        }
        if (!entry.isFile()) continue;
        const ext = extname(entry.name).toLowerCase();
        if (!VIDEO_EXTENSIONS.has(ext)) continue;
        addVideo(dir, relName, source);
      }
    };
    for (const dir of this.options.uploadSearchDirs) scan(dir, "upload");
    scan(this.options.fixtureVideosDir, "fixture");
    return out
      .sort((a, b) => {
        if (a.source !== b.source) return a.source === "upload" ? -1 : 1;
        if (a.source === "upload") return b.sortTimeMs - a.sortTimeMs || compareVideoNames(a.name, b.name);
        return compareVideoNames(a.name, b.name);
      })
      .map((entry) => ({
        video_id: entry.video_id,
        name: entry.name,
        size_mb: entry.size_mb,
        source: entry.source,
        updated_at: entry.updated_at,
        ...(entry.duration_sec !== undefined ? { duration_sec: entry.duration_sec } : {}),
        tags: entry.tags,
      }));
  }

  private readVideoMetadata(file: string, stat: Stats): { duration_sec?: number; tags: string[] } {
    const sidecar = this.readVideoMetadataSidecar(file);
    return {
      duration_sec: sidecar.duration_sec ?? this.probeVideoDurationSec(file, stat),
      tags: sidecar.tags,
    };
  }

  private readVideoMetadataSidecar(file: string): { duration_sec?: number; tags: string[] } {
    const ext = extname(file);
    const candidates = [`${file}.json`, ext ? `${file.slice(0, -ext.length)}.json` : ""].filter(Boolean);
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { duration_sec?: unknown; duration?: unknown; tags?: unknown };
        const durationRaw = parsed.duration_sec ?? parsed.duration;
        const duration = typeof durationRaw === "number" && Number.isFinite(durationRaw) && durationRaw > 0
          ? Math.round(durationRaw * 1000) / 1000
          : undefined;
        return {
          ...(duration !== undefined ? { duration_sec: duration } : {}),
          tags: normalizeVideoTags(parsed.tags),
        };
      } catch {
        return { tags: [] };
      }
    }
    return { tags: [] };
  }

  private probeVideoDurationSec(file: string, stat: Stats): number | undefined {
    const cached = this.durationCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.durationSec;
    const result = spawnSync(this.options.ffprobeBin ?? "ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=nokey=1:noprint_wrappers=1",
      file,
    ], { encoding: "utf8", timeout: 2_000, maxBuffer: 64 * 1024 });
    const duration = result.status === 0
      ? Number.parseFloat(String(result.stdout).trim())
      : Number.NaN;
    const durationSec = Number.isFinite(duration) && duration > 0
      ? Math.round(duration * 1000) / 1000
      : undefined;
    this.durationCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, durationSec });
    return durationSec;
  }

  resolveVideoId(videoId: string): string | null {
    const [source, ...rest] = videoId.split("/");
    const name = rest.join("/");
    if (!name) return null;
    if (source !== "upload" && source !== "fixture") return null;
    if (source === "upload" && name !== basename(name)) return null;
    const ext = extname(name).toLowerCase();
    if (!VIDEO_EXTENSIONS.has(ext)) return null;
    const roots = source === "upload"
      ? this.options.uploadSearchDirs
      : this.options.fixtureVideosDir
        ? [this.options.fixtureVideosDir]
        : [];
    for (const root of roots) {
      const abs = resolve(root, name);
      const rel = relative(resolve(root), abs);
      if (rel.startsWith("..") || rel === "" || resolve(root, rel) !== abs) continue;
      if (existsSync(abs) && statSync(abs).isFile()) return abs;
    }
    return null;
  }

  parseMultipartUpload(body: Buffer, contentType: string): MultipartUpload | null {
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
    if (!boundary) return null;
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd < 0) return null;
    const header = body.slice(0, headerEnd).toString("utf8");
    const filenameMatch = header.match(/filename="([^"]+)"/i);
    const filename = filenameMatch?.[1];
    if (!filename) return null;
    const dataStart = headerEnd + 4;
    const dataEnd = body.indexOf(Buffer.from(`\r\n--${boundary}`), dataStart);
    if (dataEnd < 0 || dataEnd < dataStart) return null;
    return { filename, data: body.slice(dataStart, dataEnd) };
  }

  clearUploadsAndCaches(scope?: DashboardSessionScope | null): void {
    if (this.options.sessionEnabled() && scope && !scope.isAdmin) {
      const prefix = this.scopedUploadPrefix(scope);
      if (existsSync(this.options.uploadsDir)) {
        for (const name of readdirSync(this.options.uploadsDir)) {
          if (name.startsWith(prefix)) {
            try { rmSync(join(this.options.uploadsDir, name), { force: true }); } catch { /* best-effort */ }
          }
        }
      }
      const previewDir = join(this.options.uploadsDir, ".preview");
      if (existsSync(previewDir)) {
        const previewPrefix = `upload_${prefix}`;
        for (const name of readdirSync(previewDir)) {
          if (name.startsWith(previewPrefix)) {
            try { rmSync(join(previewDir, name), { force: true }); } catch { /* best-effort */ }
          }
        }
      }
      return;
    }
    try {
      rmSync(this.options.uploadsDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
    if (!existsSync(this.options.uploadsDir)) mkdirSync(this.options.uploadsDir, { recursive: true });
  }

  deleteUploadVideo(videoId: string): boolean {
    if (!videoId.startsWith("upload/")) return false;
    const filePath = this.resolveVideoId(videoId);
    let removed = false;
    if (filePath) {
      try {
        rmSync(filePath, { force: true });
        removed = true;
      } catch {
        // Best-effort cleanup only.
      }
    }
    const previewStem = videoId.replace(/[^a-zA-Z0-9._-]/g, "_");
    for (const suffix of [...PREVIEW_SUFFIXES, THUMBNAIL_SUFFIX]) {
      try {
        rmSync(join(this.options.uploadsDir, ".preview", `${previewStem}${suffix}`), { force: true });
      } catch {
        // Best-effort cleanup only.
      }
    }
    return removed;
  }

  writeUpload(path: string, data: Buffer): void {
    writeFileSync(path, data);
  }
}

function normalizeVideoTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const tag = item.trim().replace(/^#/, "");
    if (!tag || tag.length > 32) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= 6) break;
  }
  return out;
}
