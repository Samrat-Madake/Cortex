#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# scripts/verify.sh — run all fast, offline verification checks
#
# Runs everything that can be checked without external services, API keys,
# camera streams, or model downloads. Designed to be run before every
# `git push` / merge request as a pre-flight safety net.
#
# Usage:
#   bash scripts/verify.sh              # fast mode (~30s), default
#   bash scripts/verify.sh --quiet      # suppress per-step success output
#
# Exit code is 0 on success, non-zero on first failure.
#
# What this does NOT cover (must be run manually when relevant):
#   - Real VLM smoke tests (tests/benchmark/run-vlm-benchmark.ts)
#     require GEMINI_API_KEY and cost money per invocation.
#   - Livestream / phone / RTSP benchmarks require real hardware.
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

# Resolve repo root regardless of where the script is invoked from
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# ── Args ────────────────────────────────────────────────────────────────
QUIET=0
for arg in "$@"; do
    case "$arg" in
        --quiet) QUIET=1 ;;
        -h|--help)
            sed -n '3,28p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
            exit 0
            ;;
        *)
            echo "unknown arg: $arg (try --help)" >&2
            exit 2
            ;;
    esac
done

# ── Colours ─────────────────────────────────────────────────────────────
if [ -t 1 ]; then
    GRN='\033[0;32m'; RED='\033[0;31m'; YLW='\033[1;33m'; BLU='\033[0;34m'; RST='\033[0m'
else
    GRN=''; RED=''; YLW=''; BLU=''; RST=''
fi
step() { printf "${BLU}==>${RST} %s\n" "$*"; }
ok()   { [ "$QUIET" -eq 1 ] || printf "    ${GRN}✓${RST} %s\n" "$*"; }
warn() { printf "    ${YLW}!${RST} %s\n" "$*"; }
die()  { printf "${RED}✗ FAILED:${RST} %s\n" "$*" >&2; exit 1; }

start=$(date +%s)

# ── Step 1: TypeScript typecheck ────────────────────────────────────────
step "TypeScript typecheck (tsc --build)"
if ! npx --no-install tsc --build >/dev/null 2>&1; then
    # Re-run with output visible for debugging
    npx --no-install tsc --build || die "TypeScript typecheck failed"
fi
ok "typecheck passed"

# ── Step 2: TypeScript unit + E2E tests (632 tests, mocked VLM) ─────────
step "TypeScript tests (vitest, 632+ tests, mocked VLM)"
if [ "$QUIET" -eq 1 ]; then
    npx --no-install vitest run --reporter=dot >/dev/null 2>&1 || die "TypeScript tests failed"
else
    npx --no-install vitest run --reporter=dot || die "TypeScript tests failed"
fi
ok "vitest passed"

# ── Summary ─────────────────────────────────────────────────────────────
elapsed=$(($(date +%s) - start))
printf "\n${GRN}✅ all verification checks passed${RST} in %ds\n" "$elapsed"
