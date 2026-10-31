#!/usr/bin/env bash
# Thin wrapper around eval/benchmark/pipeline/runner.ts with safer defaults for teammates.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

if [ -t 1 ]; then
  GRN='\033[0;32m'; YLW='\033[1;33m'; RED='\033[0;31m'; BLU='\033[0;34m'; RST='\033[0m'
else
  GRN=''; YLW=''; RED=''; BLU=''; RST=''
fi

info() { printf "${BLU}==>${RST} %s\n" "$*"; }
ok() { printf "    ${GRN}OK${RST} %s\n" "$*"; }
warn() { printf "    ${YLW}WARN${RST} %s\n" "$*"; }
die() { printf "${RED}FAILED:${RST} %s\n" "$*" >&2; exit 1; }

DATASET=""
VIDEOS=""
OUTPUT="${BENCH_OUTPUT_DIR:-$HOME/.reflectworld/benchmark/manual_$(date +%Y%m%d_%H%M%S)}"
FPS="1"
FRAMES_PER_SEGMENT="15"
MAX_DURATION=""
REUSE_RUN=""
CLEANUP=0
EXTRA_ARGS=()

usage() {
  cat <<'EOF'
Usage: bash eval/benchmark/pipeline/run.sh --dataset PATH [options]

Required:
  --dataset PATH          Benchmark dataset JSON

Common options:
  --videos id1,id2        Only run selected video IDs
  --output DIR            Output directory (default: ~/.reflectworld/benchmark/manual_TIMESTAMP)
  --smoke                 Run only the first 60 seconds
  --max-duration-sec N    Run only the first N seconds
  --reuse-run DIR         Skip perception and rerun QA against an existing run
  --cleanup               Delete benchmark Qdrant collections after the run

Tuning:
  --fps N                 Base sampling FPS (default: 1)
  --frames-per-segment N  Segment size cap (default: 15)

Examples:
  bash eval/benchmark/pipeline/run.sh --dataset ~/benchmark-data/dataset.json --videos 681 --smoke
  bash eval/benchmark/pipeline/run.sh --dataset ~/benchmark-data/dataset.json --videos 681 --output /data/bench-runs/681-full
  bash eval/benchmark/pipeline/run.sh --dataset ~/benchmark-data/dataset.json --videos 681 --reuse-run /data/bench-runs/681-full --output /data/bench-runs/681-qa
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dataset)
      DATASET="${2:-}"; [ -n "$DATASET" ] || die "--dataset requires a value"; shift 2 ;;
    --videos)
      VIDEOS="${2:-}"; [ -n "$VIDEOS" ] || die "--videos requires a value"; shift 2 ;;
    --output)
      OUTPUT="${2:-}"; [ -n "$OUTPUT" ] || die "--output requires a value"; shift 2 ;;
    --fps)
      FPS="${2:-}"; [ -n "$FPS" ] || die "--fps requires a value"; shift 2 ;;
    --frames-per-segment)
      FRAMES_PER_SEGMENT="${2:-}"; [ -n "$FRAMES_PER_SEGMENT" ] || die "--frames-per-segment requires a value"; shift 2 ;;
    --max-duration-sec)
      MAX_DURATION="${2:-}"; [ -n "$MAX_DURATION" ] || die "--max-duration-sec requires a value"; shift 2 ;;
    --smoke)
      MAX_DURATION="${MAX_DURATION:-60}"; shift ;;
    --reuse-run)
      REUSE_RUN="${2:-}"; [ -n "$REUSE_RUN" ] || die "--reuse-run requires a value"; shift 2 ;;
    --cleanup)
      CLEANUP=1; shift ;;
    --)
      shift
      EXTRA_ARGS+=("$@")
      break ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      die "unknown option: $1" ;;
  esac
done

[ -n "$DATASET" ] || { usage; exit 2; }
[ -f "$DATASET" ] || die "dataset not found: $DATASET"
[ -f "$REPO_ROOT/.env" ] || warn ".env not found. Run: bash eval/benchmark/bootstrap.sh"
[ -d "$REPO_ROOT/node_modules" ] || die "node_modules not found. Run: npm install && npx reflectworld setup --level 1 --yes --accept-model-licenses"
[ -x "$HOME/.reflectworld/bin/ffmpeg" ] || die "prepared ffmpeg not found at $HOME/.reflectworld/bin/ffmpeg. Run: npx reflectworld setup --level 1 --yes --accept-model-licenses"

bash "$SCRIPT_DIR/preflight-build.sh" "$REPO_ROOT" || die "benchmark preflight failed"

source "$SCRIPT_DIR/cuda-runtime-env.sh"
if [ -z "$REUSE_RUN" ]; then
  reflectworld_setup_cuda_runtime require || die "CUDA/cuDNN runtime is not ready for benchmark perception"
else
  reflectworld_setup_cuda_runtime warn || true
fi

if [ -n "$REUSE_RUN" ] && [ "$CLEANUP" -eq 1 ]; then
  warn "--cleanup with --reuse-run will delete collections needed by future QA reruns."
fi

mkdir -p "$OUTPUT"

CMD=(npx tsx eval/benchmark/pipeline/runner.ts
  --dataset "$DATASET"
  --fps "$FPS"
  --frames-per-segment "$FRAMES_PER_SEGMENT"
  --output "$OUTPUT")

[ -z "$VIDEOS" ] || CMD+=(--videos "$VIDEOS")
[ -z "$MAX_DURATION" ] || CMD+=(--max-duration-sec "$MAX_DURATION")
[ -z "$REUSE_RUN" ] || CMD+=(--reuse-run "$REUSE_RUN")
[ "$CLEANUP" -eq 0 ] || CMD+=(--cleanup)
if [ "${#EXTRA_ARGS[@]}" -gt 0 ]; then
  CMD+=("${EXTRA_ARGS[@]}")
fi

info "Running benchmark"
echo "Dataset: $DATASET"
echo "Videos:  ${VIDEOS:-all}"
echo "Output:  $OUTPUT"
echo "CUDA:    ${REFLECTWORLD_CUDA_RUNTIME_LIBS:-not configured}"
echo "Command: ${CMD[*]}"
echo

"${CMD[@]}"

echo
ok "benchmark complete"
echo "Results: $OUTPUT/results.json"
echo "Meta:    $OUTPUT/run_meta.json"
