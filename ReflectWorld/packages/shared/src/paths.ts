import { join, resolve } from "node:path";
import { homedir } from "node:os";

/** Expand ~ prefix and resolve to absolute path. Exported for use by CLI config. */
export function canonicalize(p: string): string {
  if (p.startsWith("~/") || p === "~") p = join(homedir(), p.slice(2));
  return resolve(p);
}

/** Shared read-only assets: bin/, models/, services/ */
export function resolveCortexHome(): string {
  const raw = process.env.CORTEX_HOME || join(homedir(), ".cortex");
  return canonicalize(raw);
}

/** Per-instance mutable state: qdrant-storage/, recordings/, sources/, media/, db/, cameras/, segments/ */
export function resolveCortexStateDir(): string {
  const raw =
    process.env.CORTEX_STATE_DIR || join(process.cwd(), ".cortex-state");
  return canonicalize(raw);
}
