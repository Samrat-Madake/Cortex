#!/usr/bin/env bash
# Cortex Benchmark Setup — one script to prepare everything for benchmark runs.
#
# Prerequisites: Node.js >= 22, npm install already done in repo root.
#
# What this script does:
#   1. Verify cortex setup is complete (binaries + models + Python mem service)
#   2. Create conda env "lmms-bench" with Python 3.11 + lmms-eval + memory_api plugin
#   3. Install onnxruntime-node (CPU/CoreML/CUDA backend selected at runtime)
#   4. Configure .env with benchmark-specific defaults
#   5. Validate models and show next steps
#
# Usage:
#   bash eval/benchmark/setup.sh
#   bash eval/benchmark/setup.sh --cpu-only
#   bash eval/benchmark/setup.sh --conda-env my-env --skip-conda
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
ok()   { printf "    ${GRN}✓${RST} %s\n" "$*"; }
warn() { printf "    ${YLW}!${RST} %s\n" "$*"; }
die()  { printf "${RED}✗${RST} %s\n" "$*" >&2; exit 1; }

# ── Options ──
CONDA_ENV="${CONDA_ENV:-lmms-bench}"
MODELS_DIR="${CORTEX_MODELS_DIR:-$HOME/.cortex/models}"
STATE_DIR="${CORTEX_STATE_DIR:-$HOME/.cortex}"
ENV_FILE="$REPO_ROOT/.env"
CPU_ONLY=0
SKIP_CONDA=0
SKIP_CORTEX_SETUP=0

usage() {
  cat <<'EOF'
Usage: bash eval/benchmark/setup.sh [options]

Options:
  --conda-env NAME       Conda env name (default: lmms-bench)
  --models-dir PATH      Model directory (default: ~/.cortex/models)
  --env-file PATH        Env file path (default: ./.env)
  --cpu-only             Do not require CUDA even if nvidia-smi is present
  --skip-conda           Skip conda env creation (use existing env)
  --skip-cortex-setup Skip cortex setup step (assume already done)
  -h, --help             Show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --conda-env)        CONDA_ENV="${2:-}"; shift 2 ;;
    --models-dir)       MODELS_DIR="${2:-}"; shift 2 ;;
    --env-file)         ENV_FILE="${2:-}"; shift 2 ;;
    --cpu-only)         CPU_ONLY=1; shift ;;
    --skip-conda)       SKIP_CONDA=1; shift ;;
    --skip-cortex-setup) SKIP_CORTEX_SETUP=1; shift ;;
    -h|--help)          usage; exit 0 ;;
    *)                  die "unknown option: $1" ;;
  esac
done

ensure_env_value() {
  local key="$1" value="$2"
  if ! grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

missing_env_value() {
  ! grep -Eq "^${key}=.+" "$ENV_FILE" 2>/dev/null
}

echo ""
echo "  Cortex Benchmark Setup"
echo ""
echo "  Repo:       $REPO_ROOT"
echo "  Conda env:  $CONDA_ENV"
echo "  Models:     $MODELS_DIR"
echo "  State:      $STATE_DIR"

# ── Step 1: Cortex core setup ──
step "Step 1/5: Cortex core setup"

if [ "$SKIP_CORTEX_SETUP" -eq 1 ]; then
  warn "Skipped (--skip-cortex-setup)"
elif [ -f "$STATE_DIR/.setup.json" ]; then
  SETUP_VER="$(node -p "JSON.parse(require('fs').readFileSync('$STATE_DIR/.setup.json','utf8')).version" 2>/dev/null || echo "unknown")"
  ok "Cortex already set up (version: $SETUP_VER)"

  # Check if Level 1 — benchmark needs local models
  SETUP_LEVEL="$(node -p "JSON.parse(require('fs').readFileSync('$STATE_DIR/.setup.json','utf8')).level" 2>/dev/null || echo "-1")"
  if [ "$SETUP_LEVEL" -lt 1 ]; then
    warn "Current setup is Level $SETUP_LEVEL. Benchmark needs Level 1 for local models."
    warn "Running: npx tsx packages/cortex/src/cli/index.ts setup --level 1 --yes --accept-model-licenses"
    npx tsx packages/cortex/src/cli/index.ts setup --level 1 --yes --accept-model-licenses
  fi
else
  echo "    Running Cortex setup (Level 1)..."
  npx tsx packages/cortex/src/cli/index.ts setup --level 1 --yes --accept-model-licenses
fi

# Verify key binaries
for bin in qdrant go2rtc ffmpeg; do
  [ -f "$STATE_DIR/bin/$bin" ] || die "Missing binary: $STATE_DIR/bin/$bin — run cortex setup first"
done
ok "Binaries verified (qdrant, go2rtc, ffmpeg)"

# ── Step 2: ONNX Runtime ──
step "Step 2/5: ONNX Runtime"

HAS_GPU=0
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
  HAS_GPU=1
  GPU_NAME="$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || true)"
  ok "NVIDIA GPU detected: ${GPU_NAME:-unknown}"
fi

if npm ls onnxruntime-node --depth=0 >/dev/null 2>&1; then
  ok "onnxruntime-node already installed"
else
  echo "    Installing onnxruntime-node..."
  npm install --no-save onnxruntime-node
  ok "onnxruntime-node installed"
fi

if [ "$HAS_GPU" -eq 1 ] && [ "$CPU_ONLY" -eq 0 ]; then
  warn "CUDA is auto-detected by onnxruntime-node; ensure CUDA 12 runtime + cuDNN 9 are on LD_LIBRARY_PATH"
elif [ "$CPU_ONLY" -eq 1 ]; then
  warn "CPU-only mode requested; CUDA availability will not be required"
fi

# ── Step 3: Conda + lmms-eval ──
step "Step 3/5: Conda environment ($CONDA_ENV)"

# Find conda
CONDA_SH=""
for candidate in \
  "$HOME/miniforge3/etc/profile.d/conda.sh" \
  "$HOME/miniconda3/etc/profile.d/conda.sh" \
  "$HOME/anaconda3/etc/profile.d/conda.sh" \
  "/opt/homebrew/Caskroom/miniconda/base/etc/profile.d/conda.sh"; do
  if [ -f "$candidate" ]; then
    CONDA_SH="$candidate"
    break
  fi
done

if [ -z "$CONDA_SH" ]; then
  # Try conda info as fallback
  if command -v conda >/dev/null 2>&1; then
    CONDA_SH="$(conda info --base 2>/dev/null)/etc/profile.d/conda.sh"
    [ -f "$CONDA_SH" ] || die "conda found but profile script missing at $CONDA_SH"
  else
    die "conda not found. Install miniforge3 or miniconda3 first:
    https://github.com/conda-forge/miniforge"
  fi
fi

source "$CONDA_SH"
ok "conda found: $CONDA_SH"

if [ "$SKIP_CONDA" -eq 1 ]; then
  warn "Skipped conda env creation (--skip-conda)"
  conda activate "$CONDA_ENV" || die "Cannot activate $CONDA_ENV"
else
  if conda env list | grep -q "^${CONDA_ENV} "; then
    ok "Conda env $CONDA_ENV already exists"
    conda activate "$CONDA_ENV"
  else
    echo "    Creating conda env $CONDA_ENV (Python 3.11)..."
    conda create -n "$CONDA_ENV" python=3.11 -y -q
    conda activate "$CONDA_ENV"
    ok "Conda env $CONDA_ENV created"
  fi
fi

# Install lmms-eval
if python -c "import lmms_eval" 2>/dev/null; then
  ok "lmms-eval already installed"
else
  echo "    Installing lmms-eval..."
  python -m pip install -U pip -q
  python -m pip install lmms-eval -q
  ok "lmms-eval installed"
fi

# Install memory_api plugin
echo "    Installing lmms-memory-plugin..."
python -m pip install -e "$REPO_ROOT/eval/benchmark/lmms/memory_api" -q
ok "lmms-memory-plugin installed"

# Verify optional custom task registration
if [ -n "${LMMS_INCLUDE_PATH:-}" ]; then
  echo "    Verifying custom task registration..."
  TASK_COUNT="$(python -m lmms_eval --tasks list --include_path "$LMMS_INCLUDE_PATH" 2>/dev/null | grep -cE "videomme|hippovlog|egolife|m3_bench" || echo 0)"
  if [ "$TASK_COUNT" -gt 0 ]; then
    ok "$TASK_COUNT custom benchmark tasks registered"
  else
    warn "No custom benchmark tasks found under LMMS_INCLUDE_PATH=$LMMS_INCLUDE_PATH"
  fi
else
  warn "LMMS_INCLUDE_PATH not set; skipping private/custom task registration check"
fi

# ── Step 4: .env configuration ──
step "Step 4/5: Benchmark .env"

if [ ! -f "$ENV_FILE" ]; then
  cp "$REPO_ROOT/.env.example" "$ENV_FILE"
  ok "Created $ENV_FILE from .env.example"
else
  ok "$ENV_FILE exists"
fi

mkdir -p "$MODELS_DIR"
ensure_env_value "STUBS_ONLY" "false"
ensure_env_value "CORTEX_MODELS_DIR" "$MODELS_DIR"
ensure_env_value "STT_MODEL_DIR" "$MODELS_DIR/sherpa-onnx-moonshine-tiny-en-int8"
ensure_env_value "BENCH_CORTEX_PORT" "18219"

MISSING_KEYS=0
for key in VLM_API_KEY VLM_BASE_URL EMBEDDER_API_KEY; do
  if ! grep -Eq "^${key}=.+" "$ENV_FILE" 2>/dev/null; then
    warn "Missing: $key — fill in $ENV_FILE before running benchmarks"
    MISSING_KEYS=1
  fi
done
if [ "$MISSING_KEYS" -eq 0 ]; then
  ok "API keys configured"
fi

# ── Step 5: Model validation ──
step "Step 5/5: Model files"

ALL_MODELS_OK=1
for f in yolo26m.onnx retinaface-resnet50.onnx w600k_mbf.onnx silero_vad.onnx; do
  if [ -f "$MODELS_DIR/$f" ]; then
    ok "$f"
  else
    warn "Missing: $MODELS_DIR/$f"
    ALL_MODELS_OK=0
  fi
done

if [ -d "$MODELS_DIR/sherpa-onnx-moonshine-tiny-en-int8" ]; then
  ok "sherpa-onnx-moonshine-tiny-en-int8/"
else
  warn "Missing: STT model dir (optional for non-audio benchmarks)"
fi

# ── Summary ──
echo ""
echo "  ────────────────────────────────────────"
echo "  Benchmark setup complete!"
echo ""
echo "  Conda env: $CONDA_ENV"
echo "  Activate:  conda activate $CONDA_ENV"
echo ""
echo "  Smoke test:"
echo "    bash eval/benchmark/run-benchmark-worker.sh \\"
echo "      --video-ids 601 --max-duration-sec 120 \\"
echo "      --port 8501 --gpu 0 \\"
echo "      --snapshot-version smoke_test"
echo ""

if [ "$ALL_MODELS_OK" -eq 0 ]; then
  echo "  ⚠ Some models are missing. Copy them before running:"
  echo "    rsync -av /path/to/models/ $MODELS_DIR/"
  echo ""
fi

if [ "$MISSING_KEYS" -eq 1 ]; then
  echo "  ⚠ Some API keys are missing. Edit $ENV_FILE before running."
  echo ""
fi
