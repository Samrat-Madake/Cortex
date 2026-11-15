#!/usr/bin/env bash
# Backward-compatible entrypoint. The worker runner is now dataset-agnostic.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$SCRIPT_DIR/run-benchmark-worker.sh" "$@"
