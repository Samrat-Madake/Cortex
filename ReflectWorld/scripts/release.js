#!/usr/bin/env node
/**
 * Build a single self-contained npm package for @reflectworld/reflectworld.
 *
 * Inlines all @reflectworld/* workspace packages via esbuild so the published
 * package has no unresolvable workspace deps; keeps third-party deps external
 * (declared in the generated publish package.json). Produces a publish/ staging
 * dir + a .tgz via `npm pack`. Does NOT publish to the registry.
 *
 * Run via `npm run release` (which runs `npm run build` first to refresh dist/
 * and bundled-services/bundled-dashboard).
 */
import { rmSync, mkdirSync, cpSync, existsSync, readFileSync, writeFileSync, chmodSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import * as esbuild from "esbuild";
import { generateDtsBundle } from "dts-bundle-generator";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VM_PKG = resolve(ROOT, "packages/reflectworld");
const PUBLISH = resolve(VM_PKG, "publish");
const BUNDLE = resolve(PUBLISH, "bundle");

const WORKSPACE_SCOPE = "@reflectworld/";
const INLINED = ["@reflectworld/cam", "@reflectworld/mem", "@reflectworld/percept", "@reflectworld/shared"];

const log = (m) => console.log(`[release] ${m}`);

// ── 0. Pre-flight ──
if (!existsSync(resolve(VM_PKG, "dist/index.js"))) {
  console.error("[release] packages/reflectworld/dist not found. Run `npm run build` first.");
  process.exit(1);
}

// ── 1. Clean publish/ ──
rmSync(PUBLISH, { recursive: true, force: true });
mkdirSync(BUNDLE, { recursive: true });

// ── 2. esbuild bundle: inline @reflectworld/*, externalize third-party + node builtins ──
const externalizeNonWorkspace = {
  name: "externalize-non-workspace",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      const p = args.path;
      if (p.startsWith(".") || p.startsWith("/")) return undefined; // relative → bundle
      if (p.startsWith(WORKSPACE_SCOPE)) return undefined; // workspace pkg → inline
      return { path: p, external: true }; // third-party + node: builtins → external
    });
  },
};

log("esbuild bundling (inline @reflectworld/*, external third-party)...");
await esbuild.build({
  entryPoints: [
    resolve(VM_PKG, "dist/index.js"),
    resolve(VM_PKG, "dist/src/cli/index.js"),
  ],
  outdir: BUNDLE,
  outbase: resolve(VM_PKG, "dist"),
  bundle: true,
  splitting: true, // CLI uses dynamic import() for setup/start subcommands
  format: "esm",
  platform: "node",
  target: "node22",
  plugins: [externalizeNonWorkspace],
  logLevel: "warning",
});

// Preserve shebang + executable bit on the CLI entry
const cliEntry = resolve(BUNDLE, "src/cli/index.js");
if (existsSync(cliEntry)) {
  const cli = readFileSync(cliEntry, "utf8");
  if (!cli.startsWith("#!")) writeFileSync(cliEntry, "#!/usr/bin/env node\n" + cli);
  chmodSync(cliEntry, 0o755);
}

// ── 3. dts-bundle-generator: single .d.ts with @reflectworld/* types inlined ──
log("generating bundled .d.ts...");
let dtsInlined = false;
// dts-bundle-generator chokes on ambient global augmentations pulled in by
// auto-loaded @types/* (e.g. @types/webxr extending EventInit). Pin types to
// just "node" via a temp tsconfig so those ambient libs aren't loaded.
const dtsTsconfig = resolve(VM_PKG, "tsconfig.dts.json");
writeFileSync(dtsTsconfig, JSON.stringify({
  extends: "./tsconfig.json",
  compilerOptions: { types: ["node"], skipLibCheck: true },
}, null, 2));
try {
  const [dts] = generateDtsBundle(
    [{
      filePath: resolve(VM_PKG, "index.ts"),
      output: { noBanner: true, sortNodes: false },
      libraries: { inlinedLibraries: INLINED },
    }],
    { preferredConfigPath: dtsTsconfig },
  );
  writeFileSync(resolve(BUNDLE, "index.d.ts"), dts);
  dtsInlined = true;
} catch (e) {
  // Fall back to the tsc-emitted declarations so the package still ships types.
  // Runtime is unaffected; consumer-side @reflectworld/* type resolution may degrade.
  console.warn(`[release] dts bundling failed (${String(e.message).split("\n")[0]}); using raw dist/index.d.ts`);
  cpSync(resolve(VM_PKG, "dist/index.d.ts"), resolve(BUNDLE, "index.d.ts"));
} finally {
  rmSync(dtsTsconfig, { force: true });
}

// ── 4. Copy assets ──
log("copying assets...");
const copyAsset = (rel, dest = rel) => {
  const fromPkg = resolve(VM_PKG, rel);
  const fromRoot = resolve(ROOT, rel);
  const src = existsSync(fromPkg) ? fromPkg : existsSync(fromRoot) ? fromRoot : null;
  if (!src) { console.warn(`[release] asset missing (skipped): ${rel}`); return; }
  cpSync(src, resolve(PUBLISH, dest), { recursive: true });
};
copyAsset("bundled-services");
copyAsset("bundled-dashboard");
copyAsset("openclaw.plugin.json");
// Aggregate skills from ALL workspace packages (cam/percept/mem each ship their
// own SKILL.md) into a single publish/skills/ so the manifest's "./skills" picks
// up the full set, not just reflectworld's own two.
const skillsDest = resolve(PUBLISH, "skills");
mkdirSync(skillsDest, { recursive: true });
let skillCount = 0;
for (const pkgName of readdirSync(resolve(ROOT, "packages"))) {
  const skillsDir = resolve(ROOT, "packages", pkgName, "skills");
  if (!existsSync(skillsDir)) continue;
  for (const entry of readdirSync(skillsDir)) {
    const src = resolve(skillsDir, entry);
    if (statSync(src).isDirectory()) {
      cpSync(src, resolve(skillsDest, entry), { recursive: true });
      skillCount++;
    }
  }
}
log(`aggregated ${skillCount} skills from workspace packages`);
mkdirSync(resolve(PUBLISH, "scripts"), { recursive: true });
copyAsset("scripts/post-install.cjs");
if (existsSync(resolve(ROOT, "LICENSE"))) cpSync(resolve(ROOT, "LICENSE"), resolve(PUBLISH, "LICENSE"));
copyAsset("THIRD_PARTY_NOTICES.md");
const readme = existsSync(resolve(VM_PKG, "README.md")) ? resolve(VM_PKG, "README.md") : resolve(ROOT, "README.md");
if (existsSync(readme)) cpSync(readme, resolve(PUBLISH, "README.md"));
if (existsSync(resolve(ROOT, ".env.example"))) cpSync(resolve(ROOT, ".env.example"), resolve(PUBLISH, ".env.example"));

// ── 5. Generate publish package.json (drop @reflectworld/* deps, merge third-party) ──
log("generating publish package.json...");
const deps = {}, optDeps = {}, peerDeps = {}, peerDepsMeta = {};
for (const p of ["shared", "mem", "cam", "percept", "reflectworld"]) {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "packages", p, "package.json"), "utf8"));
  for (const [k, v] of Object.entries(pkg.dependencies || {})) if (!k.startsWith(WORKSPACE_SCOPE)) deps[k] = v;
  for (const [k, v] of Object.entries(pkg.optionalDependencies || {})) optDeps[k] = v;
  for (const [k, v] of Object.entries(pkg.peerDependencies || {})) peerDeps[k] = v;
  for (const [k, v] of Object.entries(pkg.peerDependenciesMeta || {})) peerDepsMeta[k] = v;
}
const base = JSON.parse(readFileSync(resolve(VM_PKG, "package.json"), "utf8"));
const workspace = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
const admZipOverride = workspace.overrides?.["onnxruntime-node"]?.["adm-zip"];
const publishOverrides = admZipOverride
  ? { "onnxruntime-node": { "adm-zip": admZipOverride } }
  : {};
const publishPkg = {
  name: base.name,
  version: base.version,
  type: "module",
  description: base.description,
  license: base.license,
  keywords: base.keywords,
  repository: base.repository,
  homepage: base.homepage,
  engines: base.engines,
  main: "./bundle/index.js",
  types: "./bundle/index.d.ts",
  exports: { ".": { types: "./bundle/index.d.ts", import: "./bundle/index.js", default: "./bundle/index.js" } },
  bin: { reflectworld: "bundle/src/cli/index.js" },
  files: ["bundle", "bundled-services", "bundled-dashboard", "skills", "openclaw.plugin.json", "scripts/post-install.cjs", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", ".env.example"],
  scripts: { postinstall: "node scripts/post-install.cjs" },
  dependencies: deps,
  ...(Object.keys(optDeps).length ? { optionalDependencies: optDeps } : {}),
  ...(Object.keys(peerDeps).length ? { peerDependencies: peerDeps } : {}),
  ...(Object.keys(peerDepsMeta).length ? { peerDependenciesMeta: peerDepsMeta } : {}),
  ...(Object.keys(publishOverrides).length ? { overrides: publishOverrides } : {}),
  openclaw: { extensions: ["./bundle/index.js"], install: base.openclaw?.install },
  publishConfig: { access: "public" },
};
writeFileSync(resolve(PUBLISH, "package.json"), JSON.stringify(publishPkg, null, 2) + "\n");

// ── 6. Verify no @reflectworld/* leaked into the bundle .d.ts ──
if (/@reflectworld\//.test(readFileSync(resolve(BUNDLE, "index.d.ts"), "utf8"))) {
  if (dtsInlined) {
    console.error("[release] FAIL: @reflectworld/* remains in inlined bundle/index.d.ts.");
    process.exit(1);
  }
  console.warn("[release] WARN: fallback .d.ts still references @reflectworld/* types — runtime unaffected; fix dts bundling later.");
} else {
  log("verified: no @reflectworld/* in bundled .d.ts");
}

// ── 7. npm pack from publish/ ──
log("npm pack...");
execSync("npm pack", { cwd: PUBLISH, stdio: "inherit" });
log(`done. staging dir: ${PUBLISH}`);
