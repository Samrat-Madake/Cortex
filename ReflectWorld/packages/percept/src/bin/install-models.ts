#!/usr/bin/env node
// packages/percept/src/bin/install-models.ts
import { MODEL_MANIFEST, getModelsDir, type ModelId, type ModelDefinition } from "../models/model-manifest.js";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> =>
  new Promise((resolve) => rl.question(q, resolve));

/** Perception levels shown to the user. */
const LEVEL_INFO = [
  {
    level: 0,
    name: "Cloud VLM Only",
    size: "no download needed",
    description: [
      "Scene description and safety analysis via Gemini",
      "No local models, zero disk usage",
    ],
  },
  {
    level: 1,
    name: "Smart Detection + Face Recognition",
    size: "~200MB",
    description: [
      "Everything in Level 0, plus:",
      "  Object detection (person, car, pet, package...)",
      "  Face detection with landmarks",
      "  Face recognition — identify known people",
      "  Structured data feeds into VLM for richer analysis",
    ],
  },
];

/** Get models required for a given level (excludes optional models with min_level=0). */
function getModelsForLevel(level: number): ModelDefinition[] {
  return Object.values(MODEL_MANIFEST).filter((m) => m.min_level > 0 && m.min_level <= level);
}

/** Detect currently installed level. */
function detectInstalledLevel(modelsDir: string): number {
  const l1Models = getModelsForLevel(1);

  if (l1Models.every((m) => existsSync(join(modelsDir, m.filename)))) return 1;
  return 0;
}

async function main() {
  const modelsDir = getModelsDir();

  if (!existsSync(modelsDir)) {
    mkdirSync(modelsDir, { recursive: true });
  }

  const currentLevel = detectInstalledLevel(modelsDir);

  console.log(`\nReflectWorld Perception Setup\n`);
  console.log(`Model directory: ${modelsDir}`);
  console.log(`Current level: ${currentLevel}\n`);
  console.log(`Choose your perception level:\n`);

  for (const info of LEVEL_INFO) {
    const marker = info.level === currentLevel ? " [current]" : "";
    console.log(`  Level ${info.level} — ${info.name} (${info.size})${marker}`);
    for (const line of info.description) {
      console.log(`    ${line}`);
    }
    console.log();
  }

  const answer = await ask(`Select level [0/1]: `);
  const selectedLevel = Number(answer.trim());

  if (![0, 1].includes(selectedLevel)) {
    console.log("Invalid selection. Exiting.");
    rl.close();
    return;
  }

  if (selectedLevel === currentLevel) {
    console.log(`\nAlready at Level ${selectedLevel}. Nothing to do.`);
    rl.close();
    return;
  }

  if (selectedLevel === 0) {
    console.log(`\nLevel 0 selected. No models needed.`);
    console.log(`Existing models in ${modelsDir} can be manually removed if desired.`);
    rl.close();
    return;
  }

  // Check runtime dependencies for Level 1.
  let hasOrt = false;
  try { require.resolve("onnxruntime-node"); hasOrt = true; } catch {}
  if (!hasOrt) {
    try { await import("onnxruntime-node"); hasOrt = true; } catch {}
  }
  if (!hasOrt) {
    console.log(`\nLevel ${selectedLevel} requires onnxruntime-node and sharp. Install them first:`);
    console.log(`  npm install onnxruntime-node sharp`);
    rl.close();
    return;
  }

  // Ask about optional body-reid for Level 1.
  let includeBodyReid = false;
  if (selectedLevel >= 1) {
    const bodyAnswer = await ask(
      `\nEnable body re-identification? [EXPERIMENTAL]\n` +
      `  Identifies people even without seeing their face,\n` +
      `  using body appearance matching. (+350MB)\n` +
      `  [y/N]: `,
    );
    includeBodyReid = bodyAnswer.toLowerCase().startsWith("y");
  }

  // Determine which models need to be installed
  const requiredModels = getModelsForLevel(selectedLevel);
  if (includeBodyReid) {
    const clipReid = MODEL_MANIFEST["clip-reid-vitb"];
    if (clipReid && !requiredModels.includes(clipReid)) {
      requiredModels.push(clipReid);
    }
  }
  const toInstall = requiredModels.filter(
    (m) => !existsSync(join(modelsDir, m.filename)),
  );

  if (toInstall.length === 0) {
    console.log(`\nAll Level ${selectedLevel} models already installed!`);
    rl.close();
    return;
  }

  const totalMB = toInstall.reduce((sum, m) => sum + m.size_mb, 0);
  console.log(`\nInstalling ${toInstall.length} model(s) (${totalMB}MB) to ${modelsDir}...\n`);

  for (const model of toInstall) {
    const dest = join(modelsDir, model.filename);

    if (model.download_url) {
      console.log(`  Downloading ${model.filename} (${model.size_mb}MB)...`);
      console.log(`    URL: ${model.download_url}`);
      console.log(`    Save to: ${dest}`);
    } else {
      console.log(`  ${model.filename} (${model.size_mb}MB): No download URL configured.`);
      console.log(`    Please manually place the ONNX file at: ${dest}`);
    }
  }

  console.log(`\nDone! Level ${selectedLevel} perception ready.`);
  console.log(`To change level later, run: npx @reflectworld/percept install-models`);
  rl.close();
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
