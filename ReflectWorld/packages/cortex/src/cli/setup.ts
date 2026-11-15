import { platform, arch } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";
import dotenv from "dotenv";
import { BINARIES, resolveModelPlan } from "./manifest.js";
import { downloadAndExtractBinary, downloadFile, extractZipMember, verifyModelFile, ensureDir } from "./download.js";
import { copyServices } from "./python-env.js";
import { setupSttModels, verifyOnnxLoadable } from "@cortex/percept";
import { convertModel } from "./model-converter.js";
import { resolveHomeDir } from "./config.js";
import { fileURLToPath } from "node:url";

// ── Setup manifest: tracks what was installed and at which version ──

interface SetupManifest {
  version: string;
  level: number;
  timestamp: string;
  models?: Record<string, { ok: boolean; sha256?: string }>;
}

function getPackageVersion(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    while (dir !== dirname(dir)) {
      const pkgPath = join(dir, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (pkg.name === "@cortex/cortex") return pkg.version ?? "0.0.0";
      }
      dir = dirname(dir);
    }
  } catch { /* fallback */ }
  return "0.0.0";
}

function readManifest(homeDir: string): SetupManifest | null {
  const p = join(homeDir, ".setup.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as SetupManifest;
  } catch { return null; }
}

function binaryVersionOutput(binPath: string): string | null {
  try {
    return execFileSync(binPath, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function isPreparedBinaryUsable(bin: { name: string; version: string }, binPath: string): boolean {
  if (!existsSync(binPath)) return false;
  // Qdrant Linux binaries are sensitive to libc compatibility. If an existing
  // binary cannot even print its version, setup should replace it instead of
  // letting memory fail later because Qdrant never started.
  if (bin.name === "qdrant") {
    return binaryVersionOutput(binPath) !== null;
  }
  return true;
}

function writeManifest(homeDir: string, level: number, modelsDir: string, requestedLevel: number): void {
  const modelsInRange = resolveModelPlan(requestedLevel);
  const modelStatus: Record<string, { ok: boolean; sha256?: string }> = {};
  for (const model of modelsInRange) {
    const filePath = join(modelsDir, model.filename);
    modelStatus[model.filename] = { ok: existsSync(filePath) };
  }
  const manifest: SetupManifest = {
    version: getPackageVersion(),
    level,
    timestamp: new Date().toISOString(),
    models: modelStatus,
  };
  writeFileSync(join(homeDir, ".setup.json"), JSON.stringify(manifest, null, 2) + "\n");
}

/** Check if setup is needed. Returns reason string or null if up-to-date. */
export function checkSetupNeeded(homeDir: string): string | null {
  const manifest = readManifest(homeDir);
  if (!manifest) return "first run";

  const currentVersion = getPackageVersion();
  if (manifest.version !== currentVersion && currentVersion !== "0.0.0") {
    return `version changed (${manifest.version} → ${currentVersion})`;
  }

  // Verify key binaries still exist
  const binDir = join(homeDir, "bin");
  for (const bin of BINARIES) {
    const binPath = join(binDir, bin.filename);
    if (!existsSync(binPath)) {
      return `missing binary: ${bin.name}`;
    }
    if (!isPreparedBinaryUsable(bin, binPath)) {
      return `incompatible binary: ${bin.name}`;
    }
  }

  // Verify models that were present at setup time still exist
  if (manifest.models) {
    const modelsDir = join(homeDir, "models");
    for (const [filename, status] of Object.entries(manifest.models)) {
      if (status.ok && !existsSync(join(modelsDir, filename))) {
        return `missing model: ${filename} (was present at setup)`;
      }
    }
  }

  return null;
}

function parseArgs(args: string[]): { yes: boolean; level: number; acceptModelLicenses: boolean } {
  let yes = false;
  let level = -1; // -1 means "not set, will prompt or default"
  let acceptModelLicenses = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--yes" || args[i] === "-y") yes = true;
    else if (args[i] === "--accept-model-licenses") acceptModelLicenses = true;
    else if (args[i] === "--level" && args[i + 1]) { level = parseInt(args[i + 1]!, 10); i++; }
  }

  // Non-interactive defaults
  const isTTY = process.stdin.isTTY && process.stdout.isTTY;
  if (!isTTY && !yes && level === -1) {
    console.log("  No TTY detected, defaulting to --yes --level 0\n");
    yes = true;
    level = 0;
  }
  if (yes && level === -1) level = 0;

  return { yes, level, acceptModelLicenses };
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function runSetup(args: string[]): Promise<void> {
  dotenv.config();
  const homeDir = resolveHomeDir(args);
  const opts = parseArgs(args);
  const binDir = join(homeDir, "bin");
  const modelsDir = join(homeDir, "models");
  const os = platform();
  const cpuArch = arch();

  console.log("\n  Cortex Setup\n");
  console.log(`  Home directory: ${homeDir}`);
  console.log(`  Platform: ${os}-${cpuArch}\n`);

  // -- Phase 1: Binaries --
  console.log("[1/3] Downloading binaries...");
  ensureDir(binDir);

  for (const bin of BINARIES) {
    const destPath = join(binDir, bin.filename);
    if (existsSync(destPath)) {
      if (!isPreparedBinaryUsable(bin, destPath)) {
        try { unlinkSync(destPath); } catch { /* ignore */ }
        console.log(`      -- ${bin.name}: replacing incompatible binary with v${bin.version}`);
      } else {
        console.log(`      ok ${bin.name} v${bin.version} (already installed)`);
        continue;
      }
    }

    const url = bin.getUrl(os, cpuArch);
    if (!url) {
      console.warn(`      !! ${bin.name}: no download available for ${os}-${cpuArch}`);
      continue;
    }

    try {
      process.stdout.write(`      Downloading ${bin.name} v${bin.version}...`);
      await downloadAndExtractBinary(url, binDir, bin.filename, bin.extraFilenames);
      console.log(` done`);
    } catch (e: unknown) {
      console.log(` failed`);
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`      !! ${bin.name}: ${msg}`);
    }
  }

  // Copy bundled services if available (Path A: npm package has bundled-services/)
  copyServices(homeDir, ["mem"]);

  // -- Phase 2: Perception level + models --
  let level = opts.level;

  if (level === -1) {
    // Interactive: ask for level
    console.log("\n[2/3] Choose perception level:\n");
    console.log("      Level 0 — Scene Understanding");
    console.log("        Describes what the camera sees using cloud VLM (Gemini / OpenAI).");
    console.log("        Requires a VLM API key. No extra download.\n");
    console.log("      Level 1 — Scene Understanding + Local Recognition (~200MB)");
    console.log("        Everything in Level 0, plus local models that run entirely on your machine:");
    console.log("        • Recognize returning individuals — \"this is the same person from yesterday\"");
    console.log("        • Precise object detection with locations and coordinates");
    console.log("        • Feed structured detections into VLM for more accurate descriptions");
    console.log("        • All identity data stays on your device — nothing sent to the cloud\n");
    const answer = await ask("      Select [0/1]: ");
    level = parseInt(answer, 10);
    if (![0, 1].includes(level)) {
      console.log("      Invalid selection, defaulting to Level 0");
      level = 0;
    }
  } else {
    console.log(`\n[2/3] Downloading models (Level ${level})...`);
  }

  ensureDir(modelsDir);

  // Resolve models for selected level, applying STT/body-reid gates from the environment
  const modelsToInstall = resolveModelPlan(level);

  // Re-verify any already-present model files and drop invalid ones, so a truncated,
  // corrupt, or hand-placed-wrong file is re-acquired (and re-gated) rather than trusted.
  for (const model of modelsToInstall) {
    const destPath = join(modelsDir, model.filename);
    if (!existsSync(destPath)) continue;
    try {
      verifyModelFile(destPath, model.sha256 ?? model.archive?.sha256);
      // Converted models have no fixed sha — structurally validate the existing ONNX too,
      // so a corrupt >100KB conversion artifact is dropped and re-converted, not trusted.
      if (model.convert) await verifyOnnxLoadable(destPath);
    } catch (e: unknown) {
      if (existsSync(destPath)) { try { unlinkSync(destPath); } catch { /* ignore */ } }
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`      !! ${model.filename}: existing file invalid (${msg}); will re-acquire`);
    }
  }

  // Restricted models (AGPL or non-commercial weights) must be license-accepted before
  // ANY download/conversion — regardless of acquisition method (url/archive/convert).
  const restricted = modelsToInstall.filter((m) => m.license && !existsSync(join(modelsDir, m.filename)));
  let licensesAccepted = opts.acceptModelLicenses;
  if (restricted.length > 0 && !licensesAccepted) {
    console.log("\n      The following models carry AGPL or non-commercial (research-only) licenses.");
    console.log("      They are downloaded/converted on your machine; Cortex does not redistribute them.");
    console.log("      Continuing means you accept each license:\n");
    for (const m of restricted) console.log(`        - ${m.name}: ${m.license}`);
    const isTTY = process.stdin.isTTY && process.stdout.isTTY;
    if (isTTY) {
      const ans = (await ask("\n      Accept and continue? [y/N]: ")).toLowerCase();
      licensesAccepted = ans === "y" || ans === "yes";
    } else {
      console.log("\n      Non-interactive: re-run with --accept-model-licenses to install these. Skipping them for now.");
    }
  }

  for (const model of modelsToInstall) {
    const destPath = join(modelsDir, model.filename);
    if (existsSync(destPath)) {
      console.log(`      ok ${model.filename} (${model.sizeMb}MB, already installed)`);
      continue;
    }

    // A license (AGPL / non-commercial) means the user must have accepted it first.
    if (model.license && !licensesAccepted) {
      console.log(`      -- ${model.filename}: skipped (license not accepted; re-run with --accept-model-licenses)`);
      continue;
    }

    if (model.url) {
      try {
        process.stdout.write(`      Downloading ${model.filename} (${model.sizeMb}MB)...`);
        await downloadFile(model.url, destPath);
        verifyModelFile(destPath, model.sha256);
        console.log(` done`);
      } catch (e: unknown) {
        console.log(` failed`);
        if (existsSync(destPath)) { try { unlinkSync(destPath); } catch { /* ignore */ } }
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`      !! ${model.filename}: ${msg}`);
      }
    } else if (model.archive) {
      const tmpZip = join(modelsDir, `.${model.filename}.download.zip`);
      try {
        process.stdout.write(`      Downloading ${model.filename} (${model.sizeMb}MB, extracting from pack)...`);
        await downloadFile(model.archive.url, tmpZip);
        extractZipMember(tmpZip, model.archive.member, destPath);
        verifyModelFile(destPath, model.archive.sha256);
        console.log(` done`);
      } catch (e: unknown) {
        console.log(` failed`);
        if (existsSync(destPath)) { try { unlinkSync(destPath); } catch { /* ignore */ } }
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`      !! ${model.filename}: ${msg}`);
      } finally {
        if (existsSync(tmpZip)) { try { unlinkSync(tmpZip); } catch { /* ignore */ } }
      }
    } else if (model.convert) {
      try {
        console.log(`      Converting ${model.filename} (${model.sizeMb}MB) from open-source weights...`);
        convertModel(model, destPath, { binDir, workRoot: join(homeDir, "model-convert") });
        verifyModelFile(destPath); // sanity: export produced a non-trivial ONNX
        await verifyOnnxLoadable(destPath); // structural check (best-effort; skipped if onnxruntime-node absent)
        console.log(`      ok ${model.filename} (converted)`);
      } catch (e: unknown) {
        if (existsSync(destPath)) { try { unlinkSync(destPath); } catch { /* ignore */ } }
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`      !! ${model.filename}: conversion failed: ${msg}`);
      }
    } else {
      console.log(`      !! ${model.filename} (${model.sizeMb}MB): no source configured`);
      console.log(`        Please manually place the file at: ${destPath}`);
    }
  }

  // STT model (Moonshine) — installed only when local STT is selected.
  // Installed into modelsDir so the perception runtime's default lookup
  // (models_dir/sherpa-onnx-moonshine-tiny-en-int8) finds it without extra config.
  // With ElevenLabs (or STT disabled) this step is skipped entirely.
  if (process.env.STT_PROVIDER === "moonshine") {
    try {
      console.log(`      Setting up Moonshine STT model...`);
      await setupSttModels(modelsDir);
      console.log(`      ok Moonshine STT`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`      !! Moonshine STT: ${msg}`);
    }
  }

  // -- Phase 3: Verify --
  console.log("\n[3/3] Verifying installation...");

  // Gate 1: ALL binaries must be present
  const missingBinaries = BINARIES.filter(b => !existsSync(join(binDir, b.filename)));
  if (missingBinaries.length > 0) {
    console.error(`  Setup FAILED: missing binaries: ${missingBinaries.map(b => b.name).join(", ")}`);
    throw new Error(`Setup incomplete: ${missingBinaries.length} binary(ies) missing`);
  }

  // Gate 2: determine highest fully-satisfied model level
  const requiredModels = resolveModelPlan(level);
  const missingModels = requiredModels.filter(m => !existsSync(join(modelsDir, m.filename)));

  let actualLevel = -1;
  for (let l = 0; l <= level; l++) {
    const modelsAtLevel = resolveModelPlan(l);
    if (modelsAtLevel.every(m => existsSync(join(modelsDir, m.filename)))) {
      actualLevel = l;
    } else {
      break;
    }
  }

  if (actualLevel < 0) {
    console.error(`  Setup FAILED: L0 required models missing.`);
    console.error(`  Missing: ${missingModels.map(m => m.filename).join(", ")}`);
    throw new Error("Setup incomplete: L0 required models missing");
  } else if (missingModels.length > 0) {
    writeManifest(homeDir, actualLevel, modelsDir, level);
    console.warn(`  Setup completed at Level ${actualLevel} (requested ${level}).`);
    console.warn(`  Missing: ${missingModels.map(m => m.filename).join(", ")}`);
  } else {
    writeManifest(homeDir, level, modelsDir, level);
  }

  console.log(`\n  Setup complete!\n`);

  if (level === 0) {
    console.log("  To upgrade to Level 1 (local detection + face recognition):");
    console.log("    npx @cortex/cortex setup --level 1 --yes --accept-model-licenses");
    console.log("    (--accept-model-licenses acknowledges the AGPL / non-commercial model licenses.)\n");
  }
}
