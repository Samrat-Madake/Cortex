#!/usr/bin/env node
const args = process.argv.slice(2);
const command = args[0];

function printHelp(): void {
  console.log(`ReflectWorld CLI

Usage: npx @reflectworld/reflectworld <command>

Commands:
  setup [--yes] [--level 0|1] [--home-dir DIR] [--accept-model-licenses]
                                                 Download binaries + models.
                                                 --accept-model-licenses acknowledges the AGPL /
                                                 non-commercial licenses of Level 1 models; required
                                                 (or interactive confirmation) to install them.
  enable-level1 [--gpu] [--with-stt]              Install native Level 1 peer deps
                                                   (--gpu is compatibility-only; CUDA is auto-detected)
  start [--dev] [--port N] [--home-dir DIR]       Start ReflectWorld
  configure                                      Configure OpenClaw plugin providers
`);
}

async function main(): Promise<void> {
  switch (command) {
    case "setup":
      await import("./setup.js").then((m) => m.runSetup(args.slice(1)));
      break;
    case "enable-level1":
      await import("./enable-level1.js").then((m) => m.runEnableLevel1(args.slice(1)));
      break;
    case "start":
      await import("./start.js").then((m) => m.runStart(args.slice(1)));
      break;
    case "configure":
      await import("./configure.js").then((m) => m.runConfigure(args.slice(1)));
      break;
    case "-h":
    case "--help":
    case undefined:
      printHelp();
      process.exit(0);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
