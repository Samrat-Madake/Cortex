import { join, resolve } from "node:path";
import { homedir } from "node:os";

/** Expand ~ prefix and resolve to absolute path. Exported for use by CLI config. */
export function canonicalize(p: string): string {
  if (p.startsWith("~/") || p === "~") p = join(homedir(), p.slice(2));
  return resolve(p);
}

/** Shared read-only assets: bin/, models/, services/ */
export function resolveReflectWorldHome(): string {
  const raw = process.env.REFLECTWORLD_HOME || join(homedir(), ".reflectworld");
  return canonicalize(raw);
}

/** Per-instance mutable state: qdrant-storage/, recordings/, sources/, media/, db/, cameras/, segments/ */
export function resolveReflectWorldStateDir(): string {
  const raw =
    process.env.REFLECTWORLD_STATE_DIR || join(process.cwd(), ".reflectworld-state");
  return canonicalize(raw);
}
