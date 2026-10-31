#!/usr/bin/env node
import { cpSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VM_PKG = resolve(ROOT, "packages/reflectworld");

// ── Python services ──
const BUNDLED_SERVICES = resolve(VM_PKG, "bundled-services");
rmSync(BUNDLED_SERVICES, { recursive: true, force: true });

const EXCLUDE_PATTERNS = ["__pycache__", ".pytest_cache", ".venv", ".ruff_cache"];

function shouldCopyServicePath(srcRoot, path) {
  const rel = path.slice(srcRoot.length);
  if (rel.endsWith(".pyc")) return false;
  if (rel.split(/[/\\]/).some((part) => part.endsWith(".egg-info"))) return false;
  for (const pat of EXCLUDE_PATTERNS) {
    if (rel.includes(`/${pat}`) || rel.includes(`\\${pat}`)) return false;
  }
  // Exclude tests directory (but not files that just contain "test" in name)
  if (/[/\\]tests[/\\]?$/.test(rel) || /[/\\]tests[/\\]/.test(rel)) return false;
  return true;
}

for (const svc of ["mem"]) {
  const src = resolve(ROOT, "services", svc);
  const dest = resolve(BUNDLED_SERVICES, svc);
  if (!existsSync(src)) {
    console.warn(`[bundle] services/${svc} not found, skipping`);
    continue;
  }
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, {
    recursive: true,
    filter: (s) => shouldCopyServicePath(src, s),
  });
  console.log(`[bundle] services/${svc} → bundled-services/${svc}`);
}

// ── Dashboard UI ──
const BUNDLED_DASHBOARD = resolve(VM_PKG, "bundled-dashboard");
rmSync(BUNDLED_DASHBOARD, { recursive: true, force: true });

const uiPackage = existsSync(resolve(ROOT, "packages", "dashboard", "package.json"))
  ? "dashboard"
  : null;

if (uiPackage) {
  try {
    console.log(`[bundle] Building ${uiPackage}...`);
    execSync(`npm run build --workspace=packages/${uiPackage}`, {
      cwd: ROOT,
      stdio: "inherit",
    });
    const dashboardDist = resolve(ROOT, "packages", uiPackage, "dist");
    if (existsSync(dashboardDist)) {
      mkdirSync(BUNDLED_DASHBOARD, { recursive: true });
      cpSync(dashboardDist, BUNDLED_DASHBOARD, { recursive: true });
      console.log(`[bundle] ${uiPackage}/dist → bundled-dashboard/`);
    } else {
      throw new Error(`${uiPackage} build produced no dist/`);
    }
  } catch (e) {
    if (process.env.REFLECTWORLD_BUNDLE_ALLOW_MISSING_DASHBOARD === "1") {
      console.warn(`[bundle] Dashboard UI build failed, skipping (REFLECTWORLD_BUNDLE_ALLOW_MISSING_DASHBOARD=1): ${e.message}`);
    } else {
      console.error(`[bundle] Dashboard UI build failed. Set REFLECTWORLD_BUNDLE_ALLOW_MISSING_DASHBOARD=1 to skip.`);
      process.exit(1);
    }
  }
} else {
  if (process.env.REFLECTWORLD_BUNDLE_ALLOW_MISSING_DASHBOARD === "1") {
    console.warn("[bundle] packages/dashboard not found, skipping");
  } else {
    console.error("[bundle] packages/dashboard not found. Set REFLECTWORLD_BUNDLE_ALLOW_MISSING_DASHBOARD=1 to skip.");
    process.exit(1);
  }
}

console.log("[bundle] Done.");
