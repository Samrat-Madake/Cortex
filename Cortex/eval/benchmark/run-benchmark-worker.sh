#!/usr/bin/env bash
# Start one isolated lmms-eval benchmark worker.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BENCH_ROOT="$(cd "$REPO_ROOT/.." && pwd)"
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

slugify() {
  printf "%s" "$1" | tr -c "A-Za-z0-9._-" "_" | sed -E "s/_+/_/g; s/^_//; s/_$//"
}

MODE="${MODE:-fresh}"
TASK="${TASK:-videomme_long}"
OFFSET="${OFFSET:-0}"
LIMIT="${LIMIT:-3}"
OFFSET_EXPLICIT=0
LIMIT_EXPLICIT=0
VIDEO_IDS="${VIDEO_IDS:-}"
QUESTION_IDS="${QUESTION_IDS:-}"
LMMS_INCLUDE_PATH="${LMMS_INCLUDE_PATH:-$REPO_ROOT/eval/benchmark/lmms/tasks}"
GPU="${GPU:-auto}"
PORT="${PORT:-8400}"
RUN_ROOT="${RUN_ROOT:-$HOME/.cortex/benchmark_results}"
RUN_DIR="${RUN_DIR:-}"
REUSE_OUTPUT_ROOT="${REUSE_OUTPUT_ROOT:-}"
WORKER_LABEL="${WORKER_LABEL:-}"
SNAPSHOT_VERSION_ARG=""
QA_RUN_VERSION_ARG=""
KEEP_SERVER="${KEEP_SERVER:-0}"
KILL_EXISTING_SERVER="${KILL_EXISTING_SERVER:-1}"
CONDA_ENV="${CONDA_ENV:-lmms-bench}"
REQUEST_TIMEOUT="${REQUEST_TIMEOUT:-14400}"
MAX_DURATION_SEC="${MAX_DURATION_SEC:-}"
DRY_RUN="${DRY_RUN:-0}"

usage() {
  cat <<'USAGE'
Usage: bash eval/benchmark/run-benchmark-worker.sh [options]

Default: run one fresh benchmark worker with isolated Mem/Qdrant.

Options:
  --offset N              lmms-eval offset. Default: 0
  --limit N               lmms-eval limit. Default: 3
  --video-ids IDS         Comma-separated VideoMME video_id list. Auto-selects
                          cortex_videomme_long_subset for default task.
  --question-id ID        Run one VideoMME question_id, e.g. 601-2.
  --question-ids IDS      Comma-separated VideoMME question_id list.
  --include-path DIR      Extra lmms-eval task path. Default: eval/benchmark/lmms/tasks
  --gpu ID|auto           CUDA_VISIBLE_DEVICES. Default: auto
  --port N                eval-server port. Mem/Qdrant ports derive from this. Default: 8400
  --task NAME             lmms-eval task. Default: videomme_long
  --max-duration-sec N    Only run the first N seconds of each video for smoke tests
  --mode fresh|qa-only    fresh runs perception+QA; qa-only reuses prior outputs. Default: fresh
  --snapshot-version ID   Persist outputs under this snapshot version
  --qa-run-version ID     Tag QA outputs with this QA run version
  --reuse-output-root DIR Required for qa-only mode
  --run-dir DIR           Output directory. Default: ../results/<task>_<mode>_...
  --keep-server           Keep eval-server running after lmms-eval exits
  --no-kill-existing      Do not stop an existing eval-server on --port
  --dry-run               Print resolved environment and command, then exit
  -h, --help              Show this help

Common examples:
  bash eval/benchmark/run-benchmark-worker.sh --offset 0 --limit 3 --port 8400
  bash eval/benchmark/run-benchmark-worker.sh --offset 3 --limit 3 --port 8401 --gpu 6
  bash eval/benchmark/run-benchmark-worker.sh --mode qa-only --reuse-output-root /path/to/eval-output

Model/API config is read from shell env first, then .env. Agent-QA endpoint
overrides use QA_BASE_URL/QA_API_KEY, QA_API_BASE/QA_API_KEY,
AGENT_API_BASE/AGENT_API_KEY, BENCH_AGENT_API_BASE/BENCH_AGENT_API_KEY, or
OPENAI_BASE_URL/OPENAI_API_KEY before falling back to VLM_BASE_URL/VLM_API_KEY.
Model selection uses QA_MODEL, LLM_MODEL, then VLM_MODEL. Perception still uses
VLM_PROVIDER, VLM_MODEL, VLM_API_KEY, VLM_BASE_URL, and EMBEDDER_*.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --offset) OFFSET="${2:-}"; [ -n "$OFFSET" ] || die "--offset requires a value"; OFFSET_EXPLICIT=1; shift 2 ;;
    --limit) LIMIT="${2:-}"; [ -n "$LIMIT" ] || die "--limit requires a value"; LIMIT_EXPLICIT=1; shift 2 ;;
    --video-ids) VIDEO_IDS="${2:-}"; [ -n "$VIDEO_IDS" ] || die "--video-ids requires a value"; shift 2 ;;
    --question-id) QUESTION_IDS="${2:-}"; [ -n "$QUESTION_IDS" ] || die "--question-id requires a value"; shift 2 ;;
    --question-ids) QUESTION_IDS="${2:-}"; [ -n "$QUESTION_IDS" ] || die "--question-ids requires a value"; shift 2 ;;
    --include-path) LMMS_INCLUDE_PATH="${2:-}"; [ -n "$LMMS_INCLUDE_PATH" ] || die "--include-path requires a value"; shift 2 ;;
    --gpu) GPU="${2:-}"; [ -n "$GPU" ] || die "--gpu requires a value"; shift 2 ;;
    --port) PORT="${2:-}"; [ -n "$PORT" ] || die "--port requires a value"; shift 2 ;;
    --task) TASK="${2:-}"; [ -n "$TASK" ] || die "--task requires a value"; shift 2 ;;
    --max-duration-sec) MAX_DURATION_SEC="${2:-}"; [ -n "$MAX_DURATION_SEC" ] || die "--max-duration-sec requires a value"; shift 2 ;;
    --mode) MODE="${2:-}"; [ -n "$MODE" ] || die "--mode requires a value"; shift 2 ;;
    --snapshot-version) SNAPSHOT_VERSION_ARG="${2:-}"; [ -n "$SNAPSHOT_VERSION_ARG" ] || die "--snapshot-version requires a value"; shift 2 ;;
    --qa-run-version) QA_RUN_VERSION_ARG="${2:-}"; [ -n "$QA_RUN_VERSION_ARG" ] || die "--qa-run-version requires a value"; shift 2 ;;
    --reuse-output-root) REUSE_OUTPUT_ROOT="${2:-}"; [ -n "$REUSE_OUTPUT_ROOT" ] || die "--reuse-output-root requires a value"; shift 2 ;;
    --run-dir) RUN_DIR="${2:-}"; [ -n "$RUN_DIR" ] || die "--run-dir requires a value"; shift 2 ;;
    --keep-server) KEEP_SERVER=1; shift ;;
    --no-kill-existing) KILL_EXISTING_SERVER=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[ "$MODE" = "fresh" ] || [ "$MODE" = "qa-only" ] || die "--mode must be fresh or qa-only"
[[ "$PORT" =~ ^[0-9]+$ ]] || die "--port must be numeric"
[[ "$OFFSET" =~ ^[0-9]+$ ]] || die "--offset must be numeric"
[[ "$LIMIT" =~ ^[0-9]+$ ]] || die "--limit must be numeric"
if [ -n "$MAX_DURATION_SEC" ]; then
  [[ "$MAX_DURATION_SEC" =~ ^[0-9]+([.][0-9]+)?$ ]] || die "--max-duration-sec must be numeric"
fi
if [ -n "$VIDEO_IDS" ]; then
  [[ "$VIDEO_IDS" =~ ^[A-Za-z0-9._,-]+$ ]] || die "--video-ids may only contain letters, numbers, dot, underscore, dash, and comma"
  if [ "$TASK" = "videomme_long" ]; then
    TASK="cortex_videomme_long_subset"
  fi
fi
if [ -n "$QUESTION_IDS" ]; then
  [[ "$QUESTION_IDS" =~ ^[A-Za-z0-9._,-]+$ ]] || die "--question-ids may only contain letters, numbers, dot, underscore, dash, and comma"
  if [ "$TASK" = "videomme_long" ]; then
    TASK="cortex_videomme_long_subset"
  fi
fi
[ -d "$LMMS_INCLUDE_PATH" ] || die "lmms-eval include path not found: $LMMS_INCLUDE_PATH"

repo_task_yaml_for() {
  case "$1" in
    cortex_videomme_long_subset) printf '%s\n' "$REPO_ROOT/eval/benchmark/lmms/tasks/videomme_subset/cortex_videomme_long_subset.yaml" ;;
    hippovlog) printf '%s\n' "$REPO_ROOT/eval/benchmark/lmms/tasks/hippovlog/hippovlog.yaml" ;;
    hippovlog_smoke) printf '%s\n' "$REPO_ROOT/eval/benchmark/lmms/tasks/hippovlog/hippovlog_smoke.yaml" ;;
    egolife_qa) printf '%s\n' "$REPO_ROOT/eval/benchmark/lmms/tasks/egolife_qa/egolife_qa.yaml" ;;
    egolife_qa_smoke) printf '%s\n' "$REPO_ROOT/eval/benchmark/lmms/tasks/egolife_qa/egolife_qa_smoke.yaml" ;;
    m3_bench_robot) printf '%s\n' "$REPO_ROOT/eval/benchmark/lmms/tasks/m3_bench/m3_bench_robot.yaml" ;;
    m3_bench_web) printf '%s\n' "$REPO_ROOT/eval/benchmark/lmms/tasks/m3_bench/m3_bench_web.yaml" ;;
    *) return 1 ;;
  esac
}

task_name_from_yaml() {
  awk '
    /^[[:space:]]*task:[[:space:]]*/ {
      sub(/^[[:space:]]*task:[[:space:]]*/, "", $0);
      gsub(/["'\'']/, "", $0);
      print $0;
      exit;
    }
  ' "$1"
}

LMMS_TASK_ARG="$TASK"
REPO_TASK_YAML="$(repo_task_yaml_for "$TASK" 2>/dev/null || true)"
if [ -n "$REPO_TASK_YAML" ]; then
  [ -f "$REPO_TASK_YAML" ] || die "repo task yaml not found for $TASK: $REPO_TASK_YAML"
elif [ -f "$TASK" ]; then
  TASK_YAML="$TASK"
  YAML_TASK_NAME="$(task_name_from_yaml "$TASK_YAML")"
  [ -n "$YAML_TASK_NAME" ] || die "could not read task name from yaml: $TASK_YAML"
  LMMS_INCLUDE_PATH="$(cd "$(dirname "$TASK_YAML")" && pwd)"
  TASK="$YAML_TASK_NAME"
  LMMS_TASK_ARG="$YAML_TASK_NAME"
fi

PASS_OFFSET_LIMIT=1
if { [ -n "$VIDEO_IDS" ] || [ -n "$QUESTION_IDS" ]; } && [ "$OFFSET_EXPLICIT" -eq 0 ] && [ "$LIMIT_EXPLICIT" -eq 0 ]; then
  PASS_OFFSET_LIMIT=0
fi

MEM_PORT=$((PORT + 10000))
QDRANT_PORT=$((PORT + 11000))
QDRANT_GRPC_PORT=$((QDRANT_PORT + 1))
if [ -n "$VIDEO_IDS" ] || [ -n "$QUESTION_IDS" ]; then
  DEFAULT_WORKER_LABEL="videomme_${TASK}_port${PORT}"
  [ -z "$VIDEO_IDS" ] || DEFAULT_WORKER_LABEL="${DEFAULT_WORKER_LABEL}_videos${VIDEO_IDS}"
  [ -z "$QUESTION_IDS" ] || DEFAULT_WORKER_LABEL="${DEFAULT_WORKER_LABEL}_questions${QUESTION_IDS}"
else
  DEFAULT_WORKER_LABEL="videomme_${TASK}_port${PORT}_offset${OFFSET}_limit${LIMIT}"
fi
WORKER_LABEL="${WORKER_LABEL:-$DEFAULT_WORKER_LABEL}"
WORKER_SLUG="$(slugify "$WORKER_LABEL")"
DATASET_NAME="${DATASET_NAME:-$TASK}"
GIT_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || printf 'unknown')"
GIT_COMMIT_SHORT="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || printf 'nogit')"
GIT_BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || printf 'unknown')"
VERSION_DATE="${VERSION_DATE:-$(date -u +%Y%m%d)}"
SNAPSHOT_VERSION="${SNAPSHOT_VERSION_ARG:-${EVAL_SNAPSHOT_VERSION:-$(slugify "${DATASET_NAME}_${VERSION_DATE}_${GIT_COMMIT_SHORT}")}}"
QA_RUN_VERSION="${QA_RUN_VERSION_ARG:-${EVAL_QA_RUN_VERSION:-$(slugify "${DATASET_NAME}_${VERSION_DATE}_${GIT_COMMIT_SHORT}")}}"
VERSION_ROOT="${EVAL_VERSION_ROOT:-$RUN_ROOT/$SNAPSHOT_VERSION}"
WORKERS_ROOT="$VERSION_ROOT/workers"
VIDEOS_ROOT="$VERSION_ROOT/videos"
WORKER_ROOT="${EVAL_WORKER_ROOT:-$WORKERS_ROOT/$WORKER_SLUG}"
RUN_NAME="${WORKER_SLUG}_${MODE}_$(date -u +%Y%m%d_%H%M%S)"
RUN_DIR="${RUN_DIR:-$WORKER_ROOT/$RUN_NAME}"
STATE_ROOT="$WORKER_ROOT"
if [ "$MODE" = "qa-only" ]; then
  REUSE_OUTPUT_ROOT="${REUSE_OUTPUT_ROOT:-${EVAL_REUSE_VIDEO_OUTPUT_ROOT:-$VERSION_ROOT}}"
  [ -n "$REUSE_OUTPUT_ROOT" ] || die "--mode qa-only requires --reuse-output-root"
fi
COLLECTION_PREFIX="${EVAL_COLLECTION_PREFIX:-$(slugify "${SNAPSHOT_VERSION}_${WORKER_SLUG}")}"
QDRANT_STATE_DIR="${EVAL_QDRANT_STATE_DIR:-$STATE_ROOT/qdrant-state}"
MEM_STORAGE_DIR="${EVAL_CORTEX_STORAGE_PATH:-$STATE_ROOT/mem-storage}"
EVAL_RUN_ID="eval_$(printf '%s' "$RUN_NAME" | tr -c 'A-Za-z0-9_' '_' | sed -E 's/_+/_/g; s/^_//; s/_$//')"

if [ -z "${CONDA_SH:-}" ]; then
  for _c in "$HOME/miniforge3" "$HOME/miniconda3" "$HOME/anaconda3"; do
    [ -f "$_c/etc/profile.d/conda.sh" ] && CONDA_SH="$_c/etc/profile.d/conda.sh" && break
  done
  if [ -z "${CONDA_SH:-}" ] && command -v conda >/dev/null 2>&1; then
    CONDA_SH="$(conda info --base 2>/dev/null)/etc/profile.d/conda.sh"
  fi
fi
[ -f "${CONDA_SH:-}" ] || die "conda profile not found. Set CONDA_SH or install miniforge3/miniconda3."
source "$CONDA_SH"
conda activate "$CONDA_ENV"

command -v node >/dev/null 2>&1 || die "node not found after activating $CONDA_ENV"
command -v npm >/dev/null 2>&1 || die "npm not found after activating $CONDA_ENV"
command -v python >/dev/null 2>&1 || die "python not found after activating $CONDA_ENV"
[ -d "$REPO_ROOT/node_modules" ] || die "node_modules not found in $REPO_ROOT"
[ -x "$HOME/.cortex/bin/ffmpeg" ] || die "prepared ffmpeg not found at $HOME/.cortex/bin/ffmpeg"
[ -x "$HOME/.cortex/bin/qdrant" ] || die "prepared qdrant not found at $HOME/.cortex/bin/qdrant"

if [ "$GPU" = "auto" ]; then
  command -v nvidia-smi >/dev/null 2>&1 || die "nvidia-smi not found; pass --gpu ID only on a GPU host"
  GPU="$(nvidia-smi --query-gpu=index,memory.used,utilization.gpu --format=csv,noheader,nounits \
    | awk -F, '{
        gsub(/ /, "", $1); gsub(/ /, "", $2); gsub(/ /, "", $3);
        score = ($2 + 0) + (($3 + 0) * 1000);
        if (NR == 1 || score < best) { best = score; gpu = $1; }
      } END { print gpu }')"
  [ -n "$GPU" ] || die "could not auto-select GPU"
fi

source "$REPO_ROOT/eval/benchmark/pipeline/cuda-runtime-env.sh"
if [ "$MODE" = "fresh" ]; then
  cortex_setup_cuda_runtime require || die "CUDA/cuDNN runtime is not ready"
else
  cortex_setup_cuda_runtime warn || true
fi
CUDA_RUNTIME_LIBS="${CORTEX_CUDA_RUNTIME_LIBS:-}"

SERVER_LOG="$RUN_DIR/logs/server.log"
WORKER_LOG="$RUN_DIR/logs/worker.log"
RESULT_PATH="$RUN_DIR/out/results.json"
RUN_ENV="$RUN_DIR/run_env.sh"
CHECKPOINT_MANIFEST="${EVAL_CHECKPOINT_MANIFEST:-}"
if [[ -z "$CHECKPOINT_MANIFEST" && "$TASK" == m3_bench_* ]]; then
  CANDIDATE="$REPO_ROOT/eval/benchmark/lmms/tasks/m3_bench/data/m3_bench_checkpoints.json"
  if [[ -f "$CANDIDATE" ]]; then
    CHECKPOINT_MANIFEST="$CANDIDATE"
  else
    CANDIDATE="$BENCH_ROOT/lmms-eval/lmms_eval/tasks/m3_bench/data/m3_bench_checkpoints.json"
    if [[ -f "$CANDIDATE" ]]; then
      CHECKPOINT_MANIFEST="$CANDIDATE"
    fi
  fi
fi
if [[ -z "$CHECKPOINT_MANIFEST" && "$TASK" == egolife_qa* ]]; then
  CANDIDATE="$REPO_ROOT/eval/benchmark/lmms/tasks/egolife_qa/data/${TASK}_manifest.json"
  if [[ -f "$CANDIDATE" ]]; then
    CHECKPOINT_MANIFEST="$CANDIDATE"
  else
    CANDIDATE="$BENCH_ROOT/lmms-eval/lmms_eval/tasks/egolife_qa/data/${TASK}_manifest.json"
    if [[ -f "$CANDIDATE" ]]; then
      CHECKPOINT_MANIFEST="$CANDIDATE"
    fi
  fi
fi
mkdir -p "$RUN_DIR/logs" "$RUN_DIR/out"

cat > "$RUN_ENV" <<EOF_ENV
export CUDA_VISIBLE_DEVICES=$GPU
export LD_LIBRARY_PATH=${CUDA_RUNTIME_LIBS:+$CUDA_RUNTIME_LIBS:}\${LD_LIBRARY_PATH:-}
export EVAL_RUN_ID=$EVAL_RUN_ID
export EVAL_DATASET_NAME=$DATASET_NAME
export EVAL_SNAPSHOT_VERSION=$SNAPSHOT_VERSION
export EVAL_QA_RUN_VERSION=$QA_RUN_VERSION
export EVAL_VERSION_ROOT=$VERSION_ROOT
export EVAL_WORKER_ROOT=$WORKER_ROOT
export EVAL_VIDEO_OUTPUT_ROOT=$VIDEOS_ROOT
export EVAL_GIT_COMMIT=$GIT_COMMIT
export EVAL_GIT_COMMIT_SHORT=$GIT_COMMIT_SHORT
export EVAL_GIT_BRANCH=$GIT_BRANCH
export EVAL_TASK_NAME=$TASK
export EVAL_WORKER_OFFSET=$OFFSET
export EVAL_WORKER_LIMIT=$LIMIT
export EVAL_MAX_DURATION_SEC=$MAX_DURATION_SEC
export EVAL_WORKER_PASS_OFFSET_LIMIT=$PASS_OFFSET_LIMIT
export VIDEOMME_VIDEO_IDS=$VIDEO_IDS
export VIDEOMME_QUESTION_IDS=$QUESTION_IDS
export LMMS_EVAL_DATASETS_CACHE=\${LMMS_EVAL_DATASETS_CACHE:-\$HOME/.cache/lmms_eval_datasets_cache}
export EVAL_WORKER_GPU=$GPU
export EVAL_WORKER_LABEL=$WORKER_SLUG
export EVAL_OUTPUT_ROOT=$RUN_DIR
export EVAL_CORTEX_PORT=$MEM_PORT
export EVAL_QDRANT_PORT=$QDRANT_PORT
export EVAL_QDRANT_GRPC_PORT=$QDRANT_GRPC_PORT
export EVAL_QDRANT_STATE_DIR=$QDRANT_STATE_DIR
export EVAL_CORTEX_STORAGE_PATH=$MEM_STORAGE_DIR
export EVAL_COLLECTION_PREFIX=$COLLECTION_PREFIX
export EVAL_CHECKPOINT_MANIFEST=$CHECKPOINT_MANIFEST
export EVAL_MEM_CLIENT_TIMEOUT_MS=60000
export BENCH_VLM_SEGMENT_REASONING_EFFORT=${BENCH_VLM_SEGMENT_REASONING_EFFORT:-low}
EOF_ENV

if [ "$MODE" = "qa-only" ]; then
  cat >> "$RUN_ENV" <<EOF_ENV
export EVAL_REUSE_EXISTING_VIDEO_MEMORY=true
export EVAL_REUSE_VIDEO_OUTPUT_ROOT=$REUSE_OUTPUT_ROOT
export EVAL_QDRANT_STATE_DIR=$QDRANT_STATE_DIR
export EVAL_CORTEX_STORAGE_PATH=$MEM_STORAGE_DIR
export EVAL_COLLECTION_PREFIX=$COLLECTION_PREFIX
export STUBS_ONLY=true
unset EVAL_CLEAN_VIDEO_MEMORY_ON_START
unset EVAL_STRICT_VIDEO_MEMORY_CLEANUP
unset EVAL_REQUIRE_NARRATIVE_FLUSH
EOF_ENV
else
  cat >> "$RUN_ENV" <<'EOF_ENV'
unset EVAL_REUSE_EXISTING_VIDEO_MEMORY
unset EVAL_REUSE_VIDEO_OUTPUT_ROOT
export EVAL_CLEAN_VIDEO_MEMORY_ON_START=true
export EVAL_STRICT_VIDEO_MEMORY_CLEANUP=true
export STUBS_ONLY=${EVAL_STUBS_ONLY:-false}
export EVAL_REQUIRE_NARRATIVE_FLUSH=false
EOF_ENV
fi

MODEL_ARGS="endpoint=http://127.0.0.1:$PORT/evaluate,api_key=EMPTY,model_version=cortex,num_concurrent=1,timeout=$REQUEST_TIMEOUT,max_retries=2,retry_backoff_s=3"
WORKER_CMD=(python -m lmms_eval eval
  --include_path "$LMMS_INCLUDE_PATH"
  --model memory_api
  --model_args "$MODEL_ARGS"
  --tasks "$LMMS_TASK_ARG"
  --batch_size 1)
if [ "$PASS_OFFSET_LIMIT" -eq 1 ]; then
  WORKER_CMD+=(--offset "$OFFSET" --limit "$LIMIT")
fi
WORKER_CMD+=(--output_path "$RESULT_PATH" --log_samples)

info "Resolved worker settings"
echo "Repo:        $REPO_ROOT"
echo "Mode:        $MODE"
echo "Task:        $TASK"
echo "Task arg:    $LMMS_TASK_ARG"
echo "Include:     $LMMS_INCLUDE_PATH"
echo "Video IDs:   ${VIDEO_IDS:-all}"
echo "Question IDs: ${QUESTION_IDS:-all}"
echo "Offset:      $OFFSET"
echo "Limit:       $LIMIT"
echo "Max seconds: ${MAX_DURATION_SEC:-full}"
echo "Use range:   $PASS_OFFSET_LIMIT"
echo "GPU:         $GPU"
echo "Server port: $PORT"
echo "Mem port:    $MEM_PORT"
echo "Qdrant:      $QDRANT_PORT/$QDRANT_GRPC_PORT"
echo "Version:     $SNAPSHOT_VERSION"
echo "QA Run:      $QA_RUN_VERSION"
echo "Version dir: $VERSION_ROOT"
echo "Videos dir:  $VIDEOS_ROOT"
echo "Run dir:     $RUN_DIR"
echo "Worker:      $WORKER_SLUG"
echo "State root:  $STATE_ROOT"
echo "Run ID:      $EVAL_RUN_ID"
echo "QA model:    ${QA_MODEL:-${LLM_MODEL:-gpt-5-mini}}"
echo "CUDA libs:   ${CUDA_RUNTIME_LIBS:-not configured}"
echo

printf '%q ' "${WORKER_CMD[@]}" > "$RUN_DIR/worker_command.txt"
printf '\n' >> "$RUN_DIR/worker_command.txt"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "--- $RUN_ENV ---"
  cat "$RUN_ENV"
  echo "--- worker command ---"
  cat "$RUN_DIR/worker_command.txt"
  exit 0
fi

port_in_use() {
  local port="$1"
  ss -ltnp | awk -v port=":$port" '$4 ~ port "$" {found=1} END{exit found ? 0 : 1}'
}

for p in "$MEM_PORT" "$QDRANT_PORT" "$QDRANT_GRPC_PORT"; do
  port_in_use "$p" && die "derived isolated service port $p is already in use; choose another --port"
done

if port_in_use "$PORT"; then
  if [ "$KILL_EXISTING_SERVER" -eq 1 ]; then
    warn "port $PORT is in use; stopping existing eval-server process for this port"
    pkill -TERM -f "eval/benchmark/eval-server.ts --port $PORT" 2>/dev/null || true
    for _ in $(seq 1 30); do
      port_in_use "$PORT" || break
      sleep 0.5
    done
  fi
  port_in_use "$PORT" && die "port $PORT is still in use"
fi

SERVER_PID=""
cleanup() {
  local status=$?
  if [ "$KEEP_SERVER" -eq 0 ] && [ -n "${SERVER_PID:-}" ]; then
    kill -TERM "-$SERVER_PID" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

SERVER_CMD=(npx tsx eval/benchmark/eval-server.ts --port "$PORT")
if [ -n "$MAX_DURATION_SEC" ]; then
  SERVER_CMD+=(--max-duration-sec "$MAX_DURATION_SEC")
fi

bash "$REPO_ROOT/eval/benchmark/pipeline/preflight-build.sh" "$REPO_ROOT" || die "benchmark preflight failed"

info "Starting eval-server"
setsid bash -lc "cd '$REPO_ROOT' && source '$RUN_ENV' && exec $(printf '%q ' "${SERVER_CMD[@]}")" \
  > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$RUN_DIR/server.pid"

for i in $(seq 1 120); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    ok "eval-server healthy on port $PORT"
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    tail -120 "$SERVER_LOG" >&2 || true
    die "eval-server exited before becoming healthy"
  fi
  if [ "$i" -eq 120 ]; then
    tail -120 "$SERVER_LOG" >&2 || true
    die "eval-server did not become healthy"
  fi
  sleep 1
done

info "Running lmms-eval worker"
set +e
(
  source "$RUN_ENV"
  "${WORKER_CMD[@]}"
) 2>&1 | tee "$WORKER_LOG"
WORKER_STATUS=${PIPESTATUS[0]}
set -e

LMMS_EVAL_ERROR=0
RESULTS_FOUND=0
FINAL_STATUS="$WORKER_STATUS"
if [ -f "$WORKER_LOG" ] && grep -Eq \
  'Error during evaluation:|Tasks were not found:|Tasks not found:|Traceback \(most recent call last\):|PermissionError:|ModuleNotFoundError:|ImportError:|ValueError: Tasks not found|Failed to import function' \
  "$WORKER_LOG"; then
  LMMS_EVAL_ERROR=1
fi
if [ -f "$RESULT_PATH" ]; then
  RESULTS_FOUND=1
elif [ -d "$RESULT_PATH" ] && find "$RESULT_PATH" -type f \( -name '*_results.json' -o -name '*_samples_*.jsonl' \) -print -quit | grep -q .; then
  RESULTS_FOUND=1
fi
if [ "$WORKER_STATUS" -eq 0 ] && { [ "$LMMS_EVAL_ERROR" -eq 1 ] || [ "$RESULTS_FOUND" -eq 0 ]; }; then
  FINAL_STATUS=1
fi

SERVER_TMP="$(awk '/Temp Dir:/ {print $3}' "$SERVER_LOG" | tail -1 || true)"
for file in runtime_manifest.json; do
  if [ -n "$SERVER_TMP" ] && [ -f "$SERVER_TMP/$file" ] && [ "$SERVER_TMP/$file" != "$RUN_DIR/$file" ]; then
    cp "$SERVER_TMP/$file" "$RUN_DIR/$file"
  fi
done

echo
if [ "$FINAL_STATUS" -eq 0 ]; then
  ok "worker complete"
else
  warn "worker failed (process_status=$WORKER_STATUS lmms_eval_error=$LMMS_EVAL_ERROR results_found=$RESULTS_FOUND)"
fi
echo "Run dir:     $RUN_DIR"
echo "Server log:  $SERVER_LOG"
echo "Worker log:  $WORKER_LOG"
[ -z "$SERVER_TMP" ] || echo "Server tmp:  $SERVER_TMP"

if [ "$KEEP_SERVER" -eq 1 ]; then
  warn "eval-server left running; process group leader: $SERVER_PID"
else
  info "Stopping eval-server"
fi

exit "$FINAL_STATUS"
