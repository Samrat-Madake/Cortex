#!/usr/bin/env bash
# Ensure benchmark package imports resolve to fresh workspace build artifacts.
set -euo pipefail

ROOT="${1:-}"
if [ -z "$ROOT" ]; then
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
fi

cd "$ROOT"

echo "==> Benchmark preflight: refreshing TypeScript build"
npx --no-install tsc --build

node --input-type=module <<'NODE'
const cam = await import("@reflectworld/cam");
if (typeof cam.LocalFileMediaSource !== "function") {
  throw new Error(
    `@reflectworld/cam.LocalFileMediaSource is ${typeof cam.LocalFileMediaSource}; ` +
    "run npm run build and retry",
  );
}
NODE
