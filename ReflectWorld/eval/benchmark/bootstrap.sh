#!/usr/bin/env bash
# ReflectWorld benchmark bootstrap — supplements `npx reflectworld setup`.
# Run this AFTER: npm install && npm run build && npx reflectworld setup --level 1 --yes --accept-model-licenses
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

# ── Colors ──
if [ -t 1 ]; then
  GRN='\033[0;32m'; YLW='\033[1;33m'; RED='\033[0;31m'; BLU='\033[0;34m'; RST='\033[0m'
else
  GRN=''; YLW=''; RED=''; BLU=''; RST=''
fi

step() { printf "\n${BLU}==>${RST} %s\n" "$*"; }
ok()   { printf "    ${GRN}OK${RST} %s\n" "$*"; }
warn() { printf "    ${YLW}WARN${RST} %s\n" "$*"; }
die()  { printf "${RED}FAILED:${RST} %s\n" "$*" >&2; exit 1; }

REFLECTWORLD_HOME="${REFLECTWORLD_HOME:-$HOME/.reflectworld}"
MODELS_DIR="$REFLECTWORLD_HOME/models"
DATA_DIR="${BENCH_DATA_DIR:-$HOME/benchmark-data}"
ENV_FILE="$REPO_ROOT/.env"
CPU_ONLY=0
SKIP_TYPECHECK=0

usage() {
  cat <<'EOF'
Usage: bash eval/benchmark/bootstrap.sh [options]

This script supplements `npx reflectworld setup --level 1 --yes --accept-model-licenses`. It handles
benchmark-specific concerns that the CLI does not cover:
  - prerequisite checks (node, python3, npm, reflectworld CLI)
  - onnxruntime-node native runtime (CPU/CoreML/CUDA)
  - benchmark .env defaults
  - model file validation
  - data directory validation
  - API key checks
  - TypeScript typecheck

Options:
  --data-dir PATH      Directory for dataset.json/videos (default: ~/benchmark-data)
  --env-file PATH      Env file to create/update (default: ./.env)
  --cpu-only           Do not require CUDA even if nvidia-smi is present
  --skip-typecheck     Skip TypeScript typecheck
  -h, --help           Show this help

After setup:
  bash eval/benchmark/pipeline/run.sh --dataset ~/benchmark-data/dataset.json --videos <id> --smoke
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --data-dir)
      DATA_DIR="${2:-}"; [ -n "$DATA_DIR" ] || die "--data-dir requires a value"; shift 2 ;;
    --env-file)
      ENV_FILE="${2:-}"; [ -n "$ENV_FILE" ] || die "--env-file requires a value"; shift 2 ;;
    --cpu-only)
      CPU_ONLY=1; shift ;;
    --skip-typecheck)
      SKIP_TYPECHECK=1; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      die "unknown option: $1" ;;
  esac
done

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "$1 not found. Install it first."
}

ensure_env_value() {
  local key="$1"
  local value="$2"
  if ! grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

missing_env_value() {
  local key="$1"
  ! grep -Eq "^${key}=.+" "$ENV_FILE" 2>/dev/null
}

echo ""
echo "  ReflectWorld Benchmark Bootstrap"
echo ""
echo "  Repo:           $REPO_ROOT"
echo "  REFLECTWORLD_HOME: $REFLECTWORLD_HOME"
echo "  Models:         $MODELS_DIR"
echo "  Data dir:       $DATA_DIR"
echo "  Env file:       $ENV_FILE"

# ── Step 1: Prerequisites ──
step "Step 1/6: Prerequisites"

require_cmd node
require_cmd npm
require_cmd python3

NODE_MAJOR="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
[ "$NODE_MAJOR" -ge 22 ] || warn "Node.js 22+ recommended; current $(node -v)"

if npx reflectworld --help >/dev/null 2>&1; then
  ok "npx reflectworld available"
else
  die "npx reflectworld not available. Run: npm install && npm run build"
fi

if [ -f "$REFLECTWORLD_HOME/.setup.json" ]; then
  SETUP_LEVEL="$(node -p "JSON.parse(require('fs').readFileSync('$REFLECTWORLD_HOME/.setup.json','utf8')).level" 2>/dev/null || echo "-1")"
  if [ "$SETUP_LEVEL" -lt 1 ]; then
    die "ReflectWorld setup is Level $SETUP_LEVEL. Benchmark needs Level 1. Run: npx reflectworld setup --level 1 --yes --accept-model-licenses"
  fi
  ok "ReflectWorld setup complete (Level $SETUP_LEVEL)"
else
  die "ReflectWorld setup not found. Run: npx reflectworld setup --level 1 --yes --accept-model-licenses"
fi

ok "node $(node -v), npm $(npm -v), $(python3 --version)"

# ── Step 2: ONNX Runtime ──
step "Step 2/6: ONNX Runtime"

if npm ls onnxruntime-node --depth=0 >/dev/null 2>&1; then
  ok "onnxruntime-node already installed"
else
  echo "    Installing onnxruntime-node..."
  npm install --no-save onnxruntime-node
  ok "onnxruntime-node installed"
fi

if [ "$(uname -s)" = "Darwin" ]; then
  ok "macOS detected — CoreML is selected by onnxruntime-node when available"
elif [ "$CPU_ONLY" -eq 1 ]; then
  warn "CPU-only mode requested; CUDA availability will not be required"
elif command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
  GPU_NAME="$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || true)"
  ok "NVIDIA GPU detected: ${GPU_NAME:-unknown}"
  warn "CUDA is auto-detected by onnxruntime-node; ensure CUDA 12 runtime + cuDNN 9 are on LD_LIBRARY_PATH"
else
  warn "No NVIDIA GPU detected; local models will use CPU inference"
fi

# ── Step 3: Benchmark .env ──
step "Step 3/6: Benchmark .env"

if [ ! -f "$ENV_FILE" ]; then
  if [ -f "$REPO_ROOT/.env.example" ]; then
    cp "$REPO_ROOT/.env.example" "$ENV_FILE"
    ok "Created $ENV_FILE from .env.example"
  else
    touch "$ENV_FILE"
    ok "Created empty $ENV_FILE"
  fi
else
  ok "$ENV_FILE already exists"
fi

ensure_env_value "STUBS_ONLY" "false"
ensure_env_value "BENCH_REFLECTWORLD_PORT" "18219"
ok "Benchmark defaults present in $ENV_FILE"

# ── Step 4: Model files ──
step "Step 4/6: Model files"

missing_models=0
for f in yolo26m.onnx retinaface-resnet50.onnx w600k_mbf.onnx; do
  if [ -f "$MODELS_DIR/$f" ]; then
    ok "$f"
  else
    warn "Missing: $MODELS_DIR/$f"
    missing_models=1
  fi
done

if [ "$missing_models" -eq 1 ]; then
  warn "Required L1 models are missing. Re-run: npx reflectworld setup --level 1 --yes --accept-model-licenses"
  warn "Or copy model files manually:"
  warn "  rsync -av /path/to/models/ $MODELS_DIR/"
fi

# ── Step 5: Data directory ──
step "Step 5/6: Data directory"

mkdir -p "$DATA_DIR"
if [ -f "$DATA_DIR/dataset.json" ]; then
  ok "dataset.json found in $DATA_DIR"
else
  warn "No dataset.json in $DATA_DIR — place dataset files before running benchmarks"
fi

# ── Step 6: API keys ──
step "Step 6/6: API keys"

MISSING_KEYS=0
for key in VLM_API_KEY VLM_BASE_URL EMBEDDER_API_KEY; do
  if missing_env_value "$key"; then
    warn "Missing: $key — fill in $ENV_FILE before running benchmarks"
    MISSING_KEYS=1
  fi
done
if [ "$MISSING_KEYS" -eq 0 ]; then
  ok "API keys configured"
fi

# ── TypeScript typecheck ──
if [ "$SKIP_TYPECHECK" -eq 0 ]; then
  step "TypeScript typecheck"
  npx --no-install tsc --build
  ok "Typecheck passed"
else
  step "TypeScript typecheck"
  warn "Skipped (--skip-typecheck)"
fi

# ── Summary ──
echo ""
echo "  ────────────────────────────────────────"
echo "  Benchmark bootstrap complete."
echo ""
echo "  Data dir: $DATA_DIR"
echo ""
echo "  Smoke test:"
echo "    bash eval/benchmark/pipeline/run.sh \\"
echo "      --dataset $DATA_DIR/dataset.json \\"
echo "      --videos <video_id> --smoke"
echo ""
