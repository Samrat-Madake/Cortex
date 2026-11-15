#!/usr/bin/env bash
set -euo pipefail

# Service template launcher for memory_api backend.
#
# Usage:
#   bash start_memory_service.sh
#   HOST=0.0.0.0 PORT=8000 MEMORY_SERVICE_DRY_RUN=1 bash start_memory_service.sh

SERVICE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8000}"
WORKERS="${WORKERS:-1}"
CONDA_ENV="${CONDA_ENV:-}"
CONDA_SH="${CONDA_SH:-}"

activate_conda_env() {
  [ -n "${CONDA_ENV}" ] || return 0
  if [ -z "${CONDA_SH}" ]; then
    for candidate in \
      "$HOME/miniforge3/etc/profile.d/conda.sh" \
      "$HOME/miniconda3/etc/profile.d/conda.sh" \
      "$HOME/anaconda3/etc/profile.d/conda.sh"; do
      if [ -f "$candidate" ]; then
        CONDA_SH="$candidate"
        break
      fi
    done
  fi
  [ -f "${CONDA_SH:-}" ] || {
    echo "CONDA_ENV is set but conda profile was not found. Set CONDA_SH or activate the env before launching." >&2
    exit 1
  }
  # shellcheck disable=SC1090
  source "$CONDA_SH"
  conda activate "$CONDA_ENV"
}

activate_conda_env

python - <<'PY'
import importlib.util
missing = [m for m in ("fastapi", "uvicorn") if importlib.util.find_spec(m) is None]
if missing:
    raise SystemExit("Missing deps: " + ", ".join(missing) + ". Install with: pip install -r requirements.txt")
print("Dependency check passed.")
PY

cd "${SERVICE_DIR}"
exec python -m uvicorn app:app --host "${HOST}" --port "${PORT}" --workers "${WORKERS}"
