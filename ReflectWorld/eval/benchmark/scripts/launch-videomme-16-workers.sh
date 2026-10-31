#!/usr/bin/env bash
# Manage the standard 16-worker VideoMME-long run layout.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RUNNER="$REPO_ROOT/eval/benchmark/run-benchmark-worker.sh"
RUN_ROOT="${RUN_ROOT:-$HOME/.reflectworld/benchmark_results}"
DEFAULT_WORKER_LAYOUT_FILE="$REPO_ROOT/eval/benchmark/worker_configs/videomme_long/standard_16_workers/workers.csv"
WORKER_LAYOUT_FILE="${WORKER_LAYOUT_FILE:-$DEFAULT_WORKER_LAYOUT_FILE}"
TASK="videomme_long"
SNAPSHOT_VERSION=""
QA_RUN_VERSION=""
ACTION="start"
STAGGER_SEC="${STAGGER_SEC:-30}"
HEALTH_TIMEOUT_SEC="${HEALTH_TIMEOUT_SEC:-180}"
SELF_CHECK_TIMEOUT_SEC="${SELF_CHECK_TIMEOUT_SEC:-360}"
WAIT_SELF_CHECK=1
DRY_RUN=0

if [ -t 1 ]; then
  GRN='\033[0;32m'; YLW='\033[1;33m'; RED='\033[0;31m'; BLU='\033[0;34m'; RST='\033[0m'
else
  GRN=''; YLW=''; RED=''; BLU=''; RST=''
fi

info() { printf "${BLU}==>${RST} %s\n" "$*"; }
ok() { printf "    ${GRN}OK${RST} %s\n" "$*"; }
warn() { printf "    ${YLW}WARN${RST} %s\n" "$*"; }
die() { printf "${RED}FAILED:${RST} %s\n" "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Usage:
  bash eval/benchmark/scripts/launch-videomme-16-workers.sh start --snapshot-version ID [options]
  bash eval/benchmark/scripts/launch-videomme-16-workers.sh status --snapshot-version ID
  bash eval/benchmark/scripts/launch-videomme-16-workers.sh stop --snapshot-version ID

Actions:
  start                  Launch 16 standard VideoMME-long workers sequentially.
  status                 Print worker process/health/progress summary.
  stop                   Stop processes for this snapshot and standard worker ports.

Required:
  --snapshot-version ID  Result snapshot directory name under ~/.reflectworld/benchmark_results.

Options:
  --qa-run-version ID    QA run version. Default: same as snapshot version.
  --stagger-sec N        Delay between workers after readiness check. Default: 30.
  --health-timeout N     Seconds to wait for eval-server health. Default: 180.
  --self-check-timeout N Seconds to wait for first pipeline self-check. Default: 360.
  --worker-layout FILE   CSV worker layout. Default:
                         eval/benchmark/worker_configs/videomme_long/standard_16_workers/workers.csv
  --no-wait-self-check   Only wait for /health; do not wait for first self-check.
  --dry-run              Print commands without launching/stopping.
  -h, --help             Show help.

Layout CSV columns:
  idx,offset,limit,port,gpu

Default layout:
  01 offset=0   limit=54 port=8501 gpu=auto
  02 offset=54  limit=60 port=8511 gpu=auto
  ...
  16 offset=843 limit=57 port=8651 gpu=auto

Notes:
  - This script intentionally starts workers one by one instead of launching all at once.
  - It fails fast if a worker does not become healthy or self-check reports fatal/CPU fallback.
  - Per-worker logs are written to $RUN_ROOT/$SNAPSHOT_VERSION/launch_worker_XX.log.
USAGE
}

if [ $# -gt 0 ]; then
  case "$1" in
    start|status|stop) ACTION="$1"; shift ;;
  esac
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --snapshot-version) SNAPSHOT_VERSION="${2:-}"; [ -n "$SNAPSHOT_VERSION" ] || die "--snapshot-version requires a value"; shift 2 ;;
    --qa-run-version) QA_RUN_VERSION="${2:-}"; [ -n "$QA_RUN_VERSION" ] || die "--qa-run-version requires a value"; shift 2 ;;
    --stagger-sec) STAGGER_SEC="${2:-}"; [ -n "$STAGGER_SEC" ] || die "--stagger-sec requires a value"; shift 2 ;;
    --health-timeout) HEALTH_TIMEOUT_SEC="${2:-}"; [ -n "$HEALTH_TIMEOUT_SEC" ] || die "--health-timeout requires a value"; shift 2 ;;
    --self-check-timeout) SELF_CHECK_TIMEOUT_SEC="${2:-}"; [ -n "$SELF_CHECK_TIMEOUT_SEC" ] || die "--self-check-timeout requires a value"; shift 2 ;;
    --worker-layout) WORKER_LAYOUT_FILE="${2:-}"; [ -n "$WORKER_LAYOUT_FILE" ] || die "--worker-layout requires a value"; shift 2 ;;
    --no-wait-self-check) WAIT_SELF_CHECK=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[ -n "$SNAPSHOT_VERSION" ] || die "--snapshot-version is required"
QA_RUN_VERSION="${QA_RUN_VERSION:-$SNAPSHOT_VERSION}"
[[ "$STAGGER_SEC" =~ ^[0-9]+$ ]] || die "--stagger-sec must be numeric"
[[ "$HEALTH_TIMEOUT_SEC" =~ ^[0-9]+$ ]] || die "--health-timeout must be numeric"
[[ "$SELF_CHECK_TIMEOUT_SEC" =~ ^[0-9]+$ ]] || die "--self-check-timeout must be numeric"
[ -x "$RUNNER" ] || die "worker runner not executable: $RUNNER"
[ -f "$WORKER_LAYOUT_FILE" ] || die "worker layout file not found: $WORKER_LAYOUT_FILE"

VERSION_ROOT="$RUN_ROOT/$SNAPSHOT_VERSION"
if [ "$ACTION" = "start" ] && [ "$DRY_RUN" -eq 0 ]; then
  mkdir -p "$VERSION_ROOT"
fi

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

load_worker_layout() {
  local file="$1"
  local line idx offset limit port gpu extra
  WORKERS=()
  while IFS= read -r line || [ -n "$line" ]; do
    line="$(trim "$line")"
    [ -n "$line" ] || continue
    [[ "$line" == \#* ]] && continue
    IFS=, read -r idx offset limit port gpu extra <<<"$line"
    idx="$(trim "${idx:-}")"
    offset="$(trim "${offset:-}")"
    limit="$(trim "${limit:-}")"
    port="$(trim "${port:-}")"
    gpu="$(trim "${gpu:-}")"
    extra="$(trim "${extra:-}")"
    if [ "$idx" = "idx" ]; then
      continue
    fi
    [ -z "$extra" ] || die "too many columns in worker layout row: $line"
    [[ "$idx" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid worker idx in layout: $idx"
    [[ "$offset" =~ ^[0-9]+$ ]] || die "invalid offset for worker $idx: $offset"
    [[ "$limit" =~ ^[0-9]+$ ]] || die "invalid limit for worker $idx: $limit"
    [[ "$port" =~ ^[0-9]+$ ]] || die "invalid port for worker $idx: $port"
    [[ "$gpu" =~ ^([0-9]+|auto)$ ]] || die "invalid gpu for worker $idx: $gpu"
    WORKERS+=("$idx $offset $limit $port $gpu")
  done < "$file"
  [ "${#WORKERS[@]}" -gt 0 ] || die "worker layout contains no workers: $file"
}

worker_ports_regex() {
  local item idx offset limit port gpu ports=()
  for item in "${WORKERS[@]}"; do
    read -r idx offset limit port gpu <<<"$item"
    ports+=("$port")
  done
  local IFS='|'
  printf '%s' "${ports[*]}"
}

load_worker_layout "$WORKER_LAYOUT_FILE"

port_healthy() {
  local port="$1"
  curl -fsS --max-time 2 "http://127.0.0.1:$port/health" >/dev/null 2>&1
}

launch_log_for() {
  local idx="$1"
  printf '%s/launch_worker_%s.log' "$VERSION_ROOT" "$idx"
}

run_dir_from_log() {
  local log="$1"
  awk -F': *' '/^Run dir:/ {print $2; exit}' "$log" 2>/dev/null || true
}

server_log_from_launch_log() {
  local log="$1" run_dir
  run_dir="$(run_dir_from_log "$log")"
  if [ -n "$run_dir" ]; then
    printf '%s/logs/server.log' "$run_dir"
  fi
  return 0
}

wait_for_health() {
  local idx="$1" port="$2" log="$3"
  local start now
  start="$(date +%s)"
  while true; do
    if port_healthy "$port"; then
      ok "worker $idx eval-server healthy on port $port"
      return 0
    fi
    if grep -qE 'FAILED:|eval-server exited before becoming healthy|eval-server did not become healthy' "$log" 2>/dev/null; then
      tail -80 "$log" >&2 || true
      return 1
    fi
    now="$(date +%s)"
    if [ $((now - start)) -ge "$HEALTH_TIMEOUT_SEC" ]; then
      tail -80 "$log" >&2 || true
      return 1
    fi
    sleep 2
  done
}

wait_for_self_check() {
  local idx="$1" log="$2" server_log=""
  local start now
  start="$(date +%s)"
  while true; do
    server_log="$(server_log_from_launch_log "$log")"
    if [ -n "$server_log" ] && [ -f "$server_log" ]; then
      if grep -q 'ReflectWorld Pipeline Self-Check' "$server_log"; then
        if rg -q '\[ERROR\]|fatal=[1-9]|cpu_models=|loaded with cpu EP|CUDA EP failed' "$server_log"; then
          warn "worker $idx self-check/model log contains ERROR/fatal/CPU fallback"
          tail -120 "$server_log" >&2 || true
          return 1
        fi
        ok "worker $idx first self-check passed"
        return 0
      fi
      if rg -q 'Pipeline failed|FAILED:|CUBLAS_STATUS_ALLOC_FAILED' "$server_log"; then
        tail -120 "$server_log" >&2 || true
        return 1
      fi
    fi
    now="$(date +%s)"
    if [ $((now - start)) -ge "$SELF_CHECK_TIMEOUT_SEC" ]; then
      warn "worker $idx did not reach self-check within ${SELF_CHECK_TIMEOUT_SEC}s; continuing after health check"
      return 0
    fi
    sleep 5
  done
}

start_workers() {
  info "Launching ${#WORKERS[@]} workers"
  echo "Snapshot: $SNAPSHOT_VERSION"
  echo "QA run:   $QA_RUN_VERSION"
  echo "Root:     $VERSION_ROOT"
  echo "Layout:   $WORKER_LAYOUT_FILE"
  echo "Stagger:  ${STAGGER_SEC}s"
  echo

  local item idx offset limit port gpu log i
  for i in "${!WORKERS[@]}"; do
    item="${WORKERS[$i]}"
    read -r idx offset limit port gpu <<<"$item"
    log="$(launch_log_for "$idx")"
    info "Launching worker $idx offset=$offset limit=$limit port=$port gpu=$gpu"
    if [ "$DRY_RUN" -eq 1 ]; then
      printf 'nohup bash %q --offset %q --limit %q --port %q --gpu %q --snapshot-version %q --qa-run-version %q > %q 2>&1 &\n' \
        "$RUNNER" "$offset" "$limit" "$port" "$gpu" "$SNAPSHOT_VERSION" "$QA_RUN_VERSION" "$log"
      continue
    fi
    if port_healthy "$port"; then
      die "port $port already has a healthy eval-server; stop it before launching worker $idx"
    fi
    nohup bash "$RUNNER" \
      --offset "$offset" \
      --limit "$limit" \
      --port "$port" \
      --gpu "$gpu" \
      --snapshot-version "$SNAPSHOT_VERSION" \
      --qa-run-version "$QA_RUN_VERSION" \
      > "$log" 2>&1 &
    echo $! > "$VERSION_ROOT/launch_worker_${idx}.pid"
    wait_for_health "$idx" "$port" "$log" || die "worker $idx failed to become healthy"
    if [ "$WAIT_SELF_CHECK" -eq 1 ]; then
      wait_for_self_check "$idx" "$log" || die "worker $idx failed self-check"
    fi
    if [ "$i" -lt $((${#WORKERS[@]} - 1)) ] && [ "$STAGGER_SEC" -gt 0 ]; then
      sleep "$STAGGER_SEC"
    fi
  done
  ok "launch sequence complete"
}

status_workers() {
  info "Worker status for $SNAPSHOT_VERSION"
  local item idx offset limit port gpu log run_dir server_log health pid alive done started last_line
  printf '%-4s %-6s %-6s %-6s %-4s %-8s %-8s %-8s %s\n' IDX OFFSET LIMIT PORT GPU HEALTH PID DONE RUN_DIR
  for item in "${WORKERS[@]}"; do
    read -r idx offset limit port gpu <<<"$item"
    log="$(launch_log_for "$idx")"
    run_dir="$(run_dir_from_log "$log")"
    server_log="$(server_log_from_launch_log "$log")"
    health=down
    port_healthy "$port" && health=healthy
    pid="-"
    [ -f "$VERSION_ROOT/launch_worker_${idx}.pid" ] && pid="$(cat "$VERSION_ROOT/launch_worker_${idx}.pid" 2>/dev/null || printf '-')"
    alive=no
    if [ "$pid" != "-" ] && kill -0 "$pid" 2>/dev/null; then alive=yes; fi
    done="-"
    if [ -n "$server_log" ] && [ -f "$server_log" ]; then
      done="$(grep -c 'Pipeline done for' "$server_log" || true)"
    fi
    printf '%-4s %-6s %-6s %-6s %-4s %-8s %-8s %-8s %s\n' "$idx" "$offset" "$limit" "$port" "$gpu" "$health" "$alive/$pid" "$done" "${run_dir:-none}"
  done
}

stop_workers() {
  info "Stopping workers for $SNAPSHOT_VERSION"
  local ports_regex
  ports_regex="$(worker_ports_regex)"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "Would terminate processes matching snapshot=$SNAPSHOT_VERSION or layout eval ports: $ports_regex"
    return 0
  fi
  python - <<'PY' "$SNAPSHOT_VERSION" "$ports_regex"
import os, re, signal, subprocess, sys, time
snapshot=sys.argv[1]
ports=set(sys.argv[2].split('|'))
me=os.getpid()
rows=[]
for line in subprocess.check_output(['ps','-eo','pid=,ppid=,args='], text=True).splitlines():
    parts=line.strip().split(None,2)
    if len(parts)<3:
        continue
    rows.append((int(parts[0]), int(parts[1]), parts[2]))
byppid={}
for pid,ppid,args in rows:
    byppid.setdefault(ppid,[]).append(pid)
seed=set()
for pid,ppid,args in rows:
    if pid == me:
        continue
    if snapshot in args:
        seed.add(pid)
        continue
    m=re.search(r'eval/benchmark/eval-server\.ts --port\s+(\d+)', args)
    if m and m.group(1) in ports:
        seed.add(pid)
    m=re.search(r'endpoint=http://127\.0\.0\.1:(\d+)/evaluate', args)
    if m and m.group(1) in ports:
        seed.add(pid)
allp=set(seed)
stack=list(seed)
while stack:
    p=stack.pop()
    for c in byppid.get(p,[]):
        if c not in allp and c != me:
            allp.add(c)
            stack.append(c)
allp={p for p in allp if p not in (me, os.getppid())}
print('TERM pids:', ' '.join(map(str, sorted(allp))) or 'none')
for p in sorted(allp, reverse=True):
    try:
        os.kill(p, signal.SIGTERM)
    except ProcessLookupError:
        pass
time.sleep(5)
left=[]
for p in sorted(allp):
    try:
        os.kill(p, 0)
        left.append(p)
    except ProcessLookupError:
        pass
if left:
    print('KILL pids:', ' '.join(map(str, left)))
    for p in left:
        try:
            os.kill(p, signal.SIGKILL)
        except ProcessLookupError:
            pass
PY
  ok "stop requested"
}

case "$ACTION" in
  start) start_workers ;;
  status) status_workers ;;
  stop) stop_workers ;;
  *) die "unknown action: $ACTION" ;;
esac
