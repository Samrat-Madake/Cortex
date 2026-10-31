import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { detectProtocol } from "./detect-protocol.js";
import type { SourceConfig } from "./types.js";

/**
 * Generate an ASCII-safe slug from a display name.
 * - Strips non-alphanumeric characters (keeps ascii letters, digits, dash, underscore)
 * - Collapses multiple underscores
 * - Falls back to `cam_{counter}` if result is empty (e.g. pure CJK input)
 */
export function toSlug(name: string, counter: number): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return slug.length > 0 ? slug : `cam_${counter}`;
}

/** Manages video source registration, lookup, and filesystem persistence. */
export class SourceManager {
  /** Keyed by source id (ASCII-safe). */
  private sources = new Map<string, SourceConfig>();
  private counter = 0;

  constructor(private readonly persistDir: string) {
    this.loadFromDisk();
  }

  /** Register a new video source with auto-detected protocol. */
  addSource(
    input: string,
    name?: string,
    metadata?: Pick<SourceConfig, "dashboard_user_id" | "dashboard_session_id"> & { id?: string },
  ): SourceConfig {
    this.counter++;
    const displayName = name ?? `source_${this.counter}`;
    const id = metadata?.id ? toSlug(metadata.id, this.counter) : toSlug(displayName, this.counter);

    if (this.sources.has(id)) {
      throw new Error(`Source id "${id}" already exists (from name "${displayName}")`);
    }

    const { protocol } = detectProtocol(input);
    const config: SourceConfig = {
      id,
      name: displayName,
      input,
      protocol,
      created_at: Date.now(),
      ...(metadata?.dashboard_user_id ? { dashboard_user_id: metadata.dashboard_user_id } : {}),
      ...(metadata?.dashboard_session_id ? { dashboard_session_id: metadata.dashboard_session_id } : {}),
    };

    this.sources.set(id, config);
    this.saveToDisk(config);
    return config;
  }

  /** Return all registered sources. */
  listSources(): SourceConfig[] {
    return Array.from(this.sources.values());
  }

  /** Look up a source by id or name. Returns null if not found. */
  getSource(idOrName: string): SourceConfig | null {
    // Try id first (exact match)
    const byId = this.sources.get(idOrName);
    if (byId) return byId;
    // Fallback: search by display name
    for (const src of this.sources.values()) {
      if (src.name === idOrName) return src;
    }
    return null;
  }

  /** Resolve an id or name to the source id. Returns null if not found. */
  resolveId(idOrName: string): string | null {
    return this.getSource(idOrName)?.id ?? null;
  }

  /** Remove a source by id or name. Returns true if it existed. */
  removeSource(idOrName: string): boolean {
    const src = this.getSource(idOrName);
    if (!src) return false;
    this.sources.delete(src.id);
    this.deleteFromDisk(src.id);
    return true;
  }

  private loadFromDisk(): void {
    if (!existsSync(this.persistDir)) return;

    for (const file of readdirSync(this.persistDir)) {
      if (!file.endsWith(".json")) continue;
      const data = readFileSync(join(this.persistDir, file), "utf-8");
      const config = JSON.parse(data) as SourceConfig;
      // Migrate legacy configs without id
      if (!config.id) {
        config.id = toSlug(config.name, ++this.counter);
      }
      this.sources.set(config.id, config);
      this.counter = Math.max(this.counter, this.sources.size);
    }
  }

  private saveToDisk(config: SourceConfig): void {
    if (!existsSync(this.persistDir)) {
      mkdirSync(this.persistDir, { recursive: true });
    }
    writeFileSync(
      join(this.persistDir, `${config.id}.json`),
      JSON.stringify(config, null, 2),
    );
  }

  private deleteFromDisk(id: string): void {
    const filepath = join(this.persistDir, `${id}.json`);
    if (existsSync(filepath)) {
      unlinkSync(filepath);
    }
  }
}
