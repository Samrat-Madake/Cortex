/**
 * Shared binary download and extraction utilities.
 * Reuses the same pattern as @cortex/cam's binary-installer.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, chmodSync, createWriteStream, unlinkSync } from "node:fs";
import { get as httpsGet } from "node:https";
import { join } from "node:path";

/** Follow redirects and download a file. */
export function downloadFile(url: string, dest: string): Promise<void> {
  const dir = join(dest, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  return new Promise((resolve, reject) => {
    const doGet = (targetUrl: string) => {
      httpsGet(targetUrl, (response) => {
        if (
          response.statusCode &&
          [301, 302, 307, 308].includes(response.statusCode) &&
          response.headers.location
        ) {
          return doGet(response.headers.location);
        }
        if (response.statusCode !== 200)
          return reject(new Error(`HTTP ${response.statusCode} for ${targetUrl}`));
        const file = createWriteStream(dest);
        response.pipe(file);
        file.on("finish", () => { file.close(); resolve(); });
        file.on("error", reject);
      }).on("error", reject);
    };
    doGet(url);
  });
}

/** Extract a .tar.gz archive, placing contents in destDir. */
export function extractTarGz(archivePath: string, destDir: string): void {
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
  execFileSync("tar", ["-xzf", archivePath, "-C", destDir], { timeout: 60_000, stdio: "ignore" });
}

/** Make a file executable. */
export function makeExecutable(path: string): void {
  chmodSync(path, 0o755);
}

/** Check if a command exists in PATH. */
export function commandExists(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { timeout: 3000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Check if a TCP port is reachable (service already running). */
export async function isPortReachable(port: number, host = "127.0.0.1", timeoutMs = 2000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`http://${host}:${port}/`, { signal: controller.signal }).catch(() => null);
    clearTimeout(timer);
    return res !== null;
  } catch {
    return false;
  }
}

/**
 * Check if a specific service is healthy via its health endpoint.
 * Unlike isPortReachable (accepts any HTTP response), this verifies
 * the service-specific health endpoint returns 2xx.
 */
export async function isServiceHealthy(
  endpoint: string,
  healthPath: string,
  timeoutMs = 2000,
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${endpoint}${healthPath}`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/** Wait for a health endpoint to become reachable. */
export async function waitForHealthy(
  url: string,
  timeoutMs: number,
  intervalMs = 300,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/** Ensure a directory exists, creating it if needed. */
export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Clean up a downloaded archive. */
export function cleanupArchive(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

/** Get the bin directory under stateDir for downloaded binaries. */
export function getBinDir(stateDir: string): string {
  const dir = join(stateDir, "bin");
  ensureDir(dir);
  return dir;
}
