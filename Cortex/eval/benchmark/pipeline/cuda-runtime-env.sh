#!/usr/bin/env bash
# Configure CUDA/cuDNN dynamic-library paths for Linux benchmark Node processes.
#
# onnxruntime-node provides the ONNX Runtime CUDA backend when the package and
# host support it, but Linux still resolves CUDA/cuDNN shared libraries through
# the process loader path. When CUDA runtime wheels are installed inside a conda
# env, `conda activate` alone does not expose those directories to Node.

_vm_cuda_msg() {
  local level="$1"; shift
  case "$level" in
    ok) if declare -F ok >/dev/null 2>&1; then ok "$*"; else printf 'OK %s\n' "$*"; fi ;;
    warn) if declare -F warn >/dev/null 2>&1; then warn "$*"; else printf 'WARN %s\n' "$*" >&2; fi ;;
    info) if declare -F info >/dev/null 2>&1; then info "$*"; else printf '==> %s\n' "$*"; fi ;;
  esac
}

_vm_cuda_path_contains() {
  local needle="$1"
  local haystack=":${2:-}:"
  [[ "$haystack" == *":$needle:"* ]]
}

_vm_cuda_join_unique_paths() {
  local joined=""
  local p=""
  for p in "$@"; do
    [ -n "$p" ] || continue
    [ -d "$p" ] || continue
    if ! _vm_cuda_path_contains "$p" "$joined"; then
      joined="${joined:+$joined:}$p"
    fi
  done
  printf '%s' "$joined"
}

_vm_cuda_python_lib_paths() {
  command -v python >/dev/null 2>&1 || return 0
  python - <<'PY'
import pathlib
import site

roots = []
try:
    roots.extend(site.getsitepackages())
except Exception:
    pass
try:
    roots.append(site.getusersitepackages())
except Exception:
    pass

# Keep high-priority dependencies first. ORT CUDA provider needs cudnn/cublas/
# cudart immediately; the rest keep PyTorch/other native users consistent when
# they share this startup shell.
components = [
    "cudnn",
    "cublas",
    "cuda_runtime",
    "curand",
    "cufft",
    "cusparse",
    "cusolver",
    "nvjitlink",
    "cuda_cupti",
    "nccl",
    "nvtx",
]
seen = set()
for component in components:
    for base in roots:
        candidate = pathlib.Path(base) / "nvidia" / component / "lib"
        if candidate in seen:
            continue
        if candidate.is_dir() and any(candidate.glob("*.so*")):
            print(candidate)
            seen.add(candidate)
            break
PY
}

_vm_cuda_node_reports_cuda() {
  LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-}" node - <<'JS'
import("onnxruntime-node").then(async (ort) => {
  if (typeof ort.listSupportedBackends !== "function") {
    console.error("onnxruntime-node does not expose listSupportedBackends()");
    process.exit(1);
  }
  const backends = await ort.listSupportedBackends();
  const names = Array.isArray(backends)
    ? backends.map((backend) => backend && backend.name).filter(Boolean)
    : [];
  if (names.includes("cuda")) {
    process.exit(0);
  }
  console.error(`onnxruntime-node supported backends: ${names.join(", ") || "none"}`);
  process.exit(1);
}).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
JS
}

cortex_setup_cuda_runtime() {
  local mode="${1:-warn}" # warn | require | quiet
  CORTEX_CUDA_RUNTIME_LIBS=""
  export CORTEX_CUDA_RUNTIME_LIBS

  if [ "$(uname -s)" != "Linux" ]; then
    return 0
  fi

  if ! command -v nvidia-smi >/dev/null 2>&1 || ! nvidia-smi >/dev/null 2>&1; then
    [ "$mode" = "quiet" ] || _vm_cuda_msg warn "NVIDIA GPU is not visible; local ONNX models will not use CUDA."
    [ "$mode" = "require" ] && return 1 || return 0
  fi

  local py_paths=()
  local line=""
  while IFS= read -r line; do
    [ -n "$line" ] && py_paths+=("$line")
  done < <(_vm_cuda_python_lib_paths)

  local system_paths=(
    /usr/local/cuda-12.4/targets/x86_64-linux/lib
    /usr/local/cuda/targets/x86_64-linux/lib
    /usr/local/cuda/lib64
    /usr/local/cuda/lib
  )

  local explicit_paths=()
  if [ -n "${CORTEX_CUDNN_LIB_DIR:-}" ]; then
    if [ -d "$CORTEX_CUDNN_LIB_DIR" ]; then
      explicit_paths+=("$CORTEX_CUDNN_LIB_DIR")
    else
      [ "$mode" = "quiet" ] || _vm_cuda_msg warn "CORTEX_CUDNN_LIB_DIR does not exist: $CORTEX_CUDNN_LIB_DIR"
    fi
  fi

  local joined
  joined="$(_vm_cuda_join_unique_paths "${explicit_paths[@]}" "${py_paths[@]}" "${system_paths[@]}")"
  if [ -n "$joined" ]; then
    LD_LIBRARY_PATH="$joined:${LD_LIBRARY_PATH:-}"
    export LD_LIBRARY_PATH
    CORTEX_CUDA_RUNTIME_LIBS="$joined"
    export CORTEX_CUDA_RUNTIME_LIBS
  fi

  local has_cudnn=0
  local p=""
  IFS=':' read -r -a _vm_cuda_parts <<< "${LD_LIBRARY_PATH:-}"
  for p in "${_vm_cuda_parts[@]}"; do
    if [ -f "$p/libcudnn.so.9" ]; then
      has_cudnn=1
      break
    fi
  done
  unset _vm_cuda_parts

  if [ "$has_cudnn" -ne 1 ]; then
    [ "$mode" = "quiet" ] || _vm_cuda_msg warn "libcudnn.so.9 was not found in LD_LIBRARY_PATH; ONNX CUDA EP will fail."
    [ "$mode" = "require" ] && return 1 || return 0
  fi

  local backend_probe=""
  if ! backend_probe="$(_vm_cuda_node_reports_cuda 2>&1)"; then
    [ "$mode" = "quiet" ] || _vm_cuda_msg warn "onnxruntime-node did not report CUDA backend. ${backend_probe}"
    [ "$mode" = "require" ] && return 1 || return 0
  fi

  [ "$mode" = "quiet" ] || _vm_cuda_msg ok "CUDA runtime library path configured for onnxruntime-node"
  return 0
}
