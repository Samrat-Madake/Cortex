import { existsSync, cpSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { ensureDir } from "./download.js";

/** Copy Python service source from npm package's bundled-services/ to ~/.cortex/services/. */
export function copyServices(stateDir: string, serviceNames: string[]): void {
  const servicesDir = join(stateDir, "services");
  ensureDir(servicesDir);

  // Find bundled-services directory: walk up from this file to find package root
  const pkgRoot = dirname(dirname(dirname(dirname(resolve(import.meta.url.replace("file://", ""))))));
  // Check for bundled-services at package root
  const candidates = [
    join(pkgRoot, "bundled-services"),
    // If running from dist/src/cli/python-env.js, pkgRoot might be off
    join(dirname(dirname(dirname(resolve(import.meta.url.replace("file://", ""))))), "..", "bundled-services"),
  ];

  let bundledDir: string | null = null;
  for (const c of candidates) {
    if (existsSync(c)) { bundledDir = c; break; }
  }

  // Also try monorepo path: ../../../../services/
  const monoRepoServices = join(pkgRoot, "..", "..", "services");

  for (const svc of serviceNames) {
    const dest = join(servicesDir, svc);
    if (existsSync(join(dest, "pyproject.toml"))) {
      console.log(`      ${svc}: already present, skipping copy`);
      continue;
    }

    // Try bundled first, then monorepo
    let src: string | null = null;
    if (bundledDir && existsSync(join(bundledDir, svc))) {
      src = join(bundledDir, svc);
    } else if (existsSync(join(monoRepoServices, svc))) {
      src = join(monoRepoServices, svc);
    }

    if (!src) {
      console.warn(`      ${svc}: source not found, skipping`);
      continue;
    }

    cpSync(src, dest, { recursive: true });
    console.log(`      ${svc}: copied to ${dest}`);
  }
}
