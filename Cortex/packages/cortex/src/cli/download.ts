// Re-export from existing service download utilities
export {
  downloadFile,
  extractTarGz,
  makeExecutable,
  ensureDir,
  getBinDir,
} from "../services/download.js";

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { downloadFile, extractTarGz, makeExecutable, ensureDir } from "../services/download.js";

/** SHA-256 hex digest of a file. */
export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Verify an acquired model file: it must exist, be non-trivial, and (if an expected
 * hash is given) match it. Deletes the bad file and throws on failure, so a corrupt
 * or truncated download is never treated as "installed".
 */
export function verifyModelFile(path: string, expectedSha256?: string): void {
  if (!existsSync(path) || statSync(path).size < 100_000) {
    if (existsSync(path)) { try { unlinkSync(path); } catch { /* ignore */ } }
    throw new Error("missing or truncated");
  }
  if (expectedSha256) {
    const actual = sha256File(path);
    if (actual !== expectedSha256) {
      try { unlinkSync(path); } catch { /* ignore */ }
      throw new Error(`sha256 mismatch (expected ${expectedSha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`);
    }
  }
}

/** Extract a .zip archive to destDir. */
export function extractZip(archivePath: string, destDir: string): void {
  execFileSync("unzip", ["-o", archivePath, "-d", destDir], {
    timeout: 60_000,
    stdio: "ignore",
  });
}

/** Extract a single member from a .zip archive to destPath (internal paths are junked). */
export function extractZipMember(archivePath: string, member: string, destPath: string): void {
  const destDir = dirname(destPath);
  execFileSync("unzip", ["-o", "-j", archivePath, member, "-d", destDir], {
    timeout: 180_000,
    stdio: "ignore",
  });
  const extracted = join(destDir, basename(member));
  if (extracted !== destPath) renameSync(extracted, destPath);
}

/** Extract a .tar.xz archive to destDir. */
export function extractTarXz(archivePath: string, destDir: string): void {
  execFileSync("tar", ["-xf", archivePath, "-C", destDir], {
    timeout: 60_000,
    stdio: "ignore",
  });
}

/** Find a binary file by name recursively in a directory (1 level deep). */
function findBinaryInDir(dir: string, name: string): string | null {
  // Check direct path first
  const direct = join(dir, name);
  if (existsSync(direct) && statSync(direct).isFile()) return direct;

  // Check one level of subdirectories
  for (const entry of readdirSync(dir)) {
    const subdir = join(dir, entry);
    try {
      if (!statSync(subdir).isDirectory()) continue;
      const candidate = join(subdir, name);
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch { continue; }
  }
  return null;
}

/** Download a binary asset, extract if needed, find binary in extracted content, and make executable. */
export async function downloadAndExtractBinary(
  url: string,
  binDir: string,
  filename: string,
  extraFilenames: string[] = [],
): Promise<void> {
  const destPath = join(binDir, filename);
  if (existsSync(destPath)) return; // idempotent

  ensureDir(binDir);

  if (url.endsWith(".tar.gz") || url.endsWith(".tgz")) {
    const archivePath = join(binDir, `${filename}-download.tar.gz`);
    await downloadFile(url, archivePath);
    extractTarGz(archivePath, binDir);
    unlinkSync(archivePath);
  } else if (url.endsWith(".tar.xz")) {
    const archivePath = join(binDir, `${filename}-download.tar.xz`);
    await downloadFile(url, archivePath);
    extractTarXz(archivePath, binDir);
    unlinkSync(archivePath);
  } else if (url.endsWith(".zip")) {
    const archivePath = join(binDir, `${filename}-download.zip`);
    await downloadFile(url, archivePath);
    extractZip(archivePath, binDir);
    unlinkSync(archivePath);
  } else {
    // Raw binary download
    await downloadFile(url, destPath);
  }

  // Binary might be inside a subdirectory after extraction — find and move it
  if (!existsSync(destPath)) {
    const found = findBinaryInDir(binDir, filename);
    if (found) {
      renameSync(found, destPath);
    }
  }
  for (const extra of extraFilenames) {
    const extraDest = join(binDir, extra);
    if (existsSync(extraDest)) continue;
    const found = findBinaryInDir(binDir, extra);
    if (found) renameSync(found, extraDest);
  }

  // Clean up extracted subdirectories (e.g. uv-aarch64-apple-darwin/)
  for (const entry of readdirSync(binDir)) {
    const fullPath = join(binDir, entry);
    try {
      if (statSync(fullPath).isDirectory()) {
        rmSync(fullPath, { recursive: true, force: true });
      }
    } catch { /* ignore cleanup errors */ }
  }

  if (existsSync(destPath)) {
    makeExecutable(destPath);
  }
  for (const extra of extraFilenames) {
    const extraDest = join(binDir, extra);
    if (existsSync(extraDest)) makeExecutable(extraDest);
  }
}
