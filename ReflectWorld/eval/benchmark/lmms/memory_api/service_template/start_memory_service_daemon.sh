#!/usr/bin/env bash
set -euo pipefail

SERVICE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SERVICE_DIR}/.env"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8000}"
WORKERS="${WORKERS:-1}"
CONDA_ENV="${CONDA_ENV:-}"
CONDA_SH="${CONDA_SH:-}"
MEMORY_SERVICE_LOG_DIR="${MEMORY_SERVICE_LOG_DIR:-/tmp}"
MEMORY_SERVICE_PID_FILE="${MEMORY_SERVICE_PID_FILE:-${MEMORY_SERVICE_LOG_DIR}/memory_service.pid}"
MEMORY_SERVICE_LOG_FILE="${MEMORY_SERVICE_LOG_FILE:-${MEMORY_SERVICE_LOG_DIR}/memory_service.log}"
MEMORY_SERVICE_HEALTH_URL="${MEMORY_SERVICE_HEALTH_URL:-http://127.0.0.1:${PORT}/healthz}"
MEMORY_SERVICE_WAIT_SECONDS="${MEMORY_SERVICE_WAIT_SECONDS:-30}"

mkdir -p "${MEMORY_SERVICE_LOG_DIR}"

if [[ -f "${MEMORY_SERVICE_PID_FILE}" ]]; then
  old_pid="$(cat "${MEMORY_SERVICE_PID_FILE}" || true)"
  if [[ -n "${old_pid}" ]] && kill -0 "${old_pid}" 2>/dev/null; then
    echo "[INFO] memory service already running (pid=${old_pid})"
    exit 0
  fi
  rm -f "${MEMORY_SERVICE_PID_FILE}"
fi

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
missing = [m for m in ("fastapi", "uvicorn", "pydantic") if importlib.util.find_spec(m) is None]
if missing:
    raise SystemExit("Missing deps: " + ", ".join(missing) + ". Install with: pip install -r requirements.txt")
print("Dependency check passed.")
PY

cd "${SERVICE_DIR}"
nohup python -m uvicorn app:app --host "${HOST}" --port "${PORT}" --workers "${WORKERS}" > "${MEMORY_SERVICE_LOG_FILE}" 2>&1 &
pid="$!"
echo "${pid}" > "${MEMORY_SERVICE_PID_FILE}"
echo "[INFO] started memory service (pid=${pid})"
echo "[INFO] log: ${MEMORY_SERVICE_LOG_FILE}"

python - "${MEMORY_SERVICE_HEALTH_URL}" "${MEMORY_SERVICE_WAIT_SECONDS}" <<'PY'
import json
import sys
import time
import urllib.request
import urllib.error

url = sys.argv[1]
timeout = int(sys.argv[2])
deadline = time.time() + timeout
last_err = "unknown"

while time.time() < deadline:
    try:
        with urllib.request.urlopen(url, timeout=3) as resp:
            if resp.status == 200:
                payload = json.loads(resp.read().decode("utf-8"))
                status = payload.get("status")
                if status == "ok":
                    print(f"[INFO] health check passed: {url}")
                    sys.exit(0)
                last_err = f"unexpected payload: {payload}"
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        last_err = str(exc)
    time.sleep(1)

print(f"[ERROR] health check failed: {last_err}", file=sys.stderr)
sys.exit(1)
PY
