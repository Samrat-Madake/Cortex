#!/usr/bin/env node
// Post-install script for @cortex/cortex
// Prints perception level info — NO downloads, NO installs (safe)
"use strict";

const { existsSync, readFileSync } = require("fs");
const { join } = require("path");
const { homedir } = require("os");

function expandHome(p) {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

const vmHome = expandHome(process.env.CORTEX_HOME || join(homedir(), ".cortex"));
const modelsDir = process.env.CORTEX_MODELS_DIR
  ? expandHome(process.env.CORTEX_MODELS_DIR)
  : join(vmHome, "models");
const packageRoot = join(__dirname, "..");
const localCliCandidates = [
  join(packageRoot, "bundle", "src", "cli", "index.js"),
  join(packageRoot, "dist", "src", "cli", "index.js"),
];
const localCliPath = localCliCandidates.find(existsSync);
const cli = localCliPath ? `node ${JSON.stringify(localCliPath)}` : "npx @cortex/cortex";
const pluginLevel1Command = localCliPath
  ? `${cli} enable-level1 --package-dir ${JSON.stringify(packageRoot)}`
  : `${cli} enable-level1`;

// Read setup manifest instead of checking individual model files
const setupJsonPath = join(vmHome, ".setup.json");
let currentLevel = 0;
try {
  const manifest = JSON.parse(readFileSync(setupJsonPath, "utf8"));
  currentLevel = manifest.level ?? 0;
} catch { /* no manifest = level 0 */ }

const hasBodyReid = existsSync(join(modelsDir, "clip-reid-vitb.onnx"));

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";

if (currentLevel >= 1) {
  const extras = hasBodyReid ? ` + body ReID ${YELLOW}[experimental]${RESET}` : "";
  console.log(`
${BOLD}${GREEN}Cortex installed!${RESET} ${DIM}Perception Level ${currentLevel}${extras}${RESET}
`);
} else {
  console.log(`
${BOLD}${CYAN}Cortex installed!${RESET}

  Current: ${BOLD}Level 0${RESET} — Cloud VLM Only
  Scene description + safety analysis via Gemini

  ${DIM}Want smarter local perception?${RESET}

  ${BOLD}Level 1${RESET} — Detection + Face Recognition (~130MB)
    Detect people, cars, pets ${DIM}•${RESET} Recognize faces
    Structured data enhances VLM analysis

  ${BOLD}Level 2${RESET} — Full Perception (same models + tracking)
    Multi-object tracking across frames

  ${DIM}To upgrade:${RESET}
    ${CYAN}${pluginLevel1Command}${RESET} ${DIM}# add --with-stt for local VAD/STT runtime${RESET}
    ${CYAN}${cli} setup --level 1 --yes --accept-model-licenses${RESET} ${DIM}# accepts the models' AGPL / non-commercial licenses${RESET}
`);
}

console.log(`
  ${DIM}OpenClaw plugin mode:${RESET}
    ${CYAN}${cli} configure${RESET}
    ${DIM}Level 1 native deps:${RESET} ${CYAN}${pluginLevel1Command}${RESET}
`);
