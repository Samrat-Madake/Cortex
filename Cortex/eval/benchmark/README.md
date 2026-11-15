# Cortex Benchmark

`eval/benchmark/` contains dataset evaluation entry points and the shared
pipeline used by offline benchmark runs. Product-style E2E video checks live
separately under `eval/video-runner/`.

## Directory Layout

```text
eval/benchmark/
  bootstrap.sh                           # Benchmark bootstrap (supplements CLI setup)
  eval-server.ts                         # HTTP bridge used by lmms-eval memory_api
  run-benchmark-worker.sh                 # Single lmms-eval worker runner

  scripts/
    launch-videomme-16-workers.sh        # Standard VideoMME long 16-worker launcher

  worker_configs/
    videomme_long/standard_16_workers/   # Public worker layout templates

  lmms/
    memory_api/                          # lmms-eval model plugin: --model memory_api

  pipeline/                              # Shared benchmark pipeline support
    video-pipeline.ts                    # Per-video perception + memory pipeline
    session-pipeline.ts                  # Multi-clip session wrapper
    agent-qa.ts                          # Memory-backed QA agent
    memory-dump.ts                       # Export memories for QA-only/replay
    memory-rehydrate.ts                  # Restore memories from dump
    pipeline-memory.ts                   # ReID/entity memory bridge
    frame-stream.ts / frame-extractor.ts # Video frame/audio extraction
    run.sh / runner.ts                   # Standalone JSON dataset runner
```

## lmms-eval Flow

```text
lmms-eval task row
  -> eval/benchmark/lmms/memory_api backend
  -> POST http://127.0.0.1:<port>/evaluate
  -> eval/benchmark/eval-server.ts
  -> eval/benchmark/pipeline/video-pipeline.ts
  -> Percept + memory service + benchmark agent QA
  -> answer returned to lmms-eval
```

`eval/benchmark/eval-server.ts` caches pipeline results by video, so multiple
questions for the same video reuse the same constructed memory state.

## Setup

Run from the root of your own `cortex` checkout. Do not copy machine-specific
absolute paths from another developer's workspace.

```bash
# cd /path/to/your/cortex
source "$(conda info --base)/etc/profile.d/conda.sh"
conda create -n lmms-bench python=3.11 -y
conda activate lmms-bench

python -m pip install -U pip
python -m pip install lmms-eval
python -m pip install -e eval/benchmark/lmms/memory_api
```

The default conda env name is `lmms-bench`, matching
`run-benchmark-worker.sh`. If you use an existing env, skip `conda create` and
activate it directly. `lmms-eval` is the main evaluation framework;
`eval/benchmark/lmms/memory_api` only installs the Cortex custom model
backend plugin. The plugin expects the newer lmms-eval registry v2/model
manifest API. If the PyPI version does not match the team environment, use a
pinned lmms-eval checkout:

```bash
python -m pip install -e /path/to/lmms-eval
```

This replaces `python -m pip install lmms-eval`.

If your env has a different name, set `CONDA_ENV=<your-conda-env>` when
launching workers. If conda is not installed under `~/miniconda3`, also set
`CONDA_SH="$(conda info --base)/etc/profile.d/conda.sh"`. The CLI
(`npx @cortex/cortex setup --level 1 --yes --accept-model-licenses`) prepares local runtime binaries under
`~/.cortex/bin/` and models under `~/.cortex/models/`; benchmark
workers do not require Docker.

Next, configure `.env` and copy local models before running bootstrap. Bootstrap
can create `.env` and warn about missing models, but the recommended path is to
prepare them first so its validation is useful:

```bash
cp .env.example .env
mkdir -p ~/.cortex/models
```

Copy at least the L1 model files to `CORTEX_MODELS_DIR`:

```text
~/.cortex/models/
  yolo26m.onnx
  retinaface-resnet50.onnx
  w600k_mbf.onnx
  sherpa-onnx-moonshine-tiny-en-int8/   # needed for speech/transcript signals
```

Model/API config is read from shell env first, then repo-root `.env`. Confirm at least:

```bash
VLM_PROVIDER=openai
VLM_MODEL=gpt-5-mini
VLM_API_KEY=...
VLM_BASE_URL=...
LLM_MODEL=gpt-5-mini
QA_MODEL=gpt-5-mini
# Optional: route Agent-QA to a different OpenAI-compatible endpoint.
# Explicit shell env takes precedence over these `.env` defaults.
# Legacy benchmark aliases BENCH_AGENT_API_BASE / BENCH_AGENT_API_KEY are also accepted.
QA_API_KEY=...
QA_BASE_URL=...
EMBEDDER_PROVIDER=openai
EMBEDDER_MODEL=text-embedding-3-small
EMBEDDER_API_KEY=...
EMBEDDER_BASE_URL=...
STUBS_ONLY=false
CORTEX_MODELS_DIR=~/.cortex/models
STT_MODEL_DIR=~/.cortex/models/sherpa-onnx-moonshine-tiny-en-int8
```

Then run setup and bootstrap:

```bash
npm install
npm run build
npx @cortex/cortex setup --level 1 --yes --accept-model-licenses
bash eval/benchmark/bootstrap.sh
```

If you use private/custom lmms-eval tasks, point `LMMS_INCLUDE_PATH` at that
task checkout before launching workers:

```bash
export LMMS_INCLUDE_PATH=/path/to/lmms-tasks
python -m lmms_eval --tasks list --include_path "$LMMS_INCLUDE_PATH"
```

Custom benchmark task definitions and prepared dataset JSONL files are internal
evaluation assets and are not shipped in the public repository. The runner still
sets `LMMS_EVAL_DATASETS_CACHE` to
`$HOME/.cache/lmms_eval_datasets_cache` when the variable is not already set;
override it before launching workers if a different writable cache is needed.

Quick smoke:

```bash
bash eval/benchmark/run-benchmark-worker.sh \
  --video-ids 601 \
  --max-duration-sec 120 \
  --port 8501 \
  --gpu 2 \
	  --snapshot-version smoke_videomme_YYYYMMDD_commit
```

## Runner Arguments

Common `run-benchmark-worker.sh` arguments:

- `--task`: lmms-eval task name. This chooses the dataset and evaluation config.
  The default is `videomme_long`.
- `--video-ids`: run only selected videos. Use this for VideoMME subsets,
  HippoVlog, and other video-level worker splits.
- `--question-id` / `--question-ids`: run selected questions, mainly for
  badcase reproduction or QA-only reruns.
- `--offset` / `--limit`: run a row range. Use this for the standard VideoMME
  split or M3-Bench. For VideoMME, keep ranges aligned to multiples of three.
- `--max-duration-sec`: process only the first N seconds of each video. Use it
  for smoke tests only, not for final accuracy. Query-time checkpoints are only
  saved up to the truncated media time.
- `--port`: eval-server port for this worker. Mem service and Qdrant ports are
  derived from it, so every worker needs a unique value.
- `--gpu`: GPU used by local models in this worker.
- `WORKER_LABEL`: stable worker name used in logs and worker output paths.
- `--snapshot-version`: experiment output namespace, not a dataset selector.
  Results are written under
  `~/.cortex/benchmark_results/<snapshot_version>/`. All workers in one
  experiment must use the same value. Prefer names that include dataset, date,
  commit, and important config, such as `videomme_long_20260508_9a75d80`.

## VideoMME Long

Full 16-worker run:

```bash
bash eval/benchmark/scripts/launch-videomme-16-workers.sh start \
  --snapshot-version videomme_long_YYYYMMDD_commit
```

This launcher starts the default 16-worker layout sequentially with `nohup`,
waits for eval-server health, and checks the first pipeline self-check before
moving to the next worker. It does not require manually creating a `tmux`
session.

The default layout is loaded from:

```text
eval/benchmark/worker_configs/videomme_long/standard_16_workers/workers.csv
```

Copy that file and pass `--worker-layout /path/to/workers.csv` when your GPU
IDs, ports, or row ranges differ. The public template keeps the official
offset/limit ranges but uses `gpu=auto` so it is not tied to one host.

Status:

```bash
bash eval/benchmark/scripts/launch-videomme-16-workers.sh status \
  --snapshot-version videomme_long_YYYYMMDD_commit
```

Stop:

```bash
bash eval/benchmark/scripts/launch-videomme-16-workers.sh stop \
  --snapshot-version videomme_long_YYYYMMDD_commit
```

Single range:

```bash
bash eval/benchmark/run-benchmark-worker.sh \
  --task videomme_long \
  --offset 0 \
  --limit 3 \
  --port 8501 \
  --gpu 2 \
  --snapshot-version videomme_long_debug
```

VideoMME uses three questions per video, so complete video ranges should keep
`offset` and `limit` aligned to multiples of three.

Explicit video subset:

```bash
bash eval/benchmark/run-benchmark-worker.sh \
  --video-ids 601,604,646 \
  --port 8501 \
  --gpu 2 \
  --snapshot-version videomme_long_subset_YYYYMMDD_commit
```

With `--video-ids`, the runner switches from `videomme_long` to
`cortex_videomme_long_subset` and runs the full selected videos unless
`--offset` or `--limit` is explicitly provided.

## Multi-worker Allocation

All current benchmark datasets except EgoLife can run with multiple workers.
EgoLife is currently organized as query-time QA over the same life stream and
does not expose a video/question filtering hook in its task, so run EgoLife with
a single worker for now.

There are two common ways to split benchmark work across workers.

### Row-range split

Use this for the standard full VideoMME Long run:

```bash
bash eval/benchmark/scripts/launch-videomme-16-workers.sh start \
  --snapshot-version videomme_long_YYYYMMDD_commit
```

The launcher reads its standard 16-worker `offset` / `limit` ranges from
`worker_configs/videomme_long/standard_16_workers/workers.csv`. VideoMME has
three questions per video, so ranges must stay aligned to multiples of three.
Each worker starts its own eval-server, Mem service, Qdrant state directory, and
collection prefix. Workers share only the snapshot output root:

```text
~/.cortex/benchmark_results/<snapshot_version>/
```

This is the quickest path for a complete VideoMME Long run. The layout is fixed
in `launch-videomme-16-workers.sh`; use explicit video-id split for custom
duration-balanced subsets.

### Explicit video-id split

Use this for VideoMME subsets, HippoVlog, and other video-level datasets where
we want duration-balanced worker groups. Each worker gets a disjoint
comma-separated video list. For custom multi-worker allocations, prefer starting
the workers inside one `tmux` session so they survive SSH disconnects and remain
easy to inspect or stop:

```bash
SNAPSHOT=videomme_subset_YYYYMMDD_commit
tmux new-session -d -s "$SNAPSHOT" -n worker_01 \
  "WORKER_LABEL=worker_01 bash eval/benchmark/run-benchmark-worker.sh \
    --video-ids 601,604,646 \
    --port 8501 \
    --gpu 2 \
    --snapshot-version $SNAPSHOT"

tmux new-window -t "$SNAPSHOT" -n worker_02 \
  "WORKER_LABEL=worker_02 bash eval/benchmark/run-benchmark-worker.sh \
    --video-ids 648,682,698 \
    --port 8511 \
    --gpu 6 \
    --snapshot-version $SNAPSHOT"

tmux attach -t "$SNAPSHOT"
```

Inspect or stop the session:

```bash
tmux ls
tmux attach -t <snapshot_version>
tmux kill-session -t <snapshot_version>
```

Rules:

- Assign a video to exactly one worker. Do not split questions from the same
  video across workers, because perception, memory, QA traces, and narratives
  are video-scoped.
- Give every worker a unique `--port`. Mem and Qdrant ports are derived from it,
  so port collisions will break isolation.
- Reuse the same `--snapshot-version` for all workers in one experiment.
- Use a stable `WORKER_LABEL` so logs and state directories are easy to map back
  to the worker plan.
- Bind `--gpu` or `GPU_LIST` according to available local model capacity. The
  VLM API is usually the main latency bottleneck, but local detection/ReID still
  needs GPU memory.

To keep worker processing time balanced, split by video duration rather than by
video count. Sort videos by duration descending and repeatedly assign the next
longest video to the worker with the smallest current total duration (Longest
Processing Time first). This keeps wall-clock time close across workers while
preserving video-level isolation.

For non-VideoMME tasks that support video filtering, prefer the runner's
`--video-ids` / `--question-ids` flags. HippoVlog accepts the runner-provided
`VIDEOMME_VIDEO_IDS` / `VIDEOMME_QUESTION_IDS` environment variables as a
compatibility path:

```bash
WORKER_LABEL=hippovlog_worker_01 \
  bash eval/benchmark/run-benchmark-worker.sh \
    --task hippovlog \
    --video-ids is-9LX9BHec,NiKqiIYwVAg \
    --port 8501 \
    --gpu 2 \
    --snapshot-version hippovlog_YYYYMMDD_commit
```

### Row-range split for non-video-filtered tasks

Use row ranges for tasks whose rows are independent enough to split but do not
yet expose a video-id filter. M3-Bench can use this path:

```bash
WORKER_LABEL=m3_worker_01 \
  bash eval/benchmark/run-benchmark-worker.sh \
    --task m3_bench_robot \
    --offset 0 \
    --limit 320 \
    --port 8501 \
    --gpu 2 \
    --snapshot-version m3_bench_robot_YYYYMMDD_commit

WORKER_LABEL=m3_worker_02 \
  bash eval/benchmark/run-benchmark-worker.sh \
    --task m3_bench_robot \
    --offset 320 \
    --limit 320 \
    --port 8511 \
    --gpu 6 \
    --snapshot-version m3_bench_robot_YYYYMMDD_commit
```

Do not use this path for EgoLife until the task gets a safe filtering strategy.

When a worker allocation should be shared with teammates, keep it in this repo
under `eval/benchmark/worker_configs/<dataset>/<name>/`. Typical files are
`workers.csv`, per-worker `worker_NN_video_ids.txt`, `summary.json`, and
`run_all.sh`. Local operation directories outside the repo are fine for one-off
runs, but generic documentation must not reference machine-specific paths.

## QA-only

Rerun all QA for one completed VideoMME video:

```bash
bash eval/benchmark/run-benchmark-worker.sh \
  --mode qa-only \
  --reuse-output-root ~/.cortex/benchmark_results/videomme_long_YYYYMMDD_commit \
  --snapshot-version videomme_long_YYYYMMDD_commit \
  --video-ids 601 \
  --port 8501 \
  --gpu 2 \
  --qa-run-version videomme_long_qa_YYYYMMDD_commit
```

Rerun one question:

```bash
bash eval/benchmark/run-benchmark-worker.sh \
  --mode qa-only \
  --reuse-output-root ~/.cortex/benchmark_results/videomme_long_YYYYMMDD_commit \
  --snapshot-version videomme_long_YYYYMMDD_commit \
  --video-ids 601 \
  --question-id 601-2 \
  --port 8501 \
  --gpu 2 \
  --qa-run-version videomme_long_qa_YYYYMMDD_commit
```

## Private/custom lmms-eval tasks

Benchmarks that are not supported upstream by lmms-eval can still be run by
placing task definitions in a separate checkout and passing either
`--include-path /path/to/tasks` or a direct task yaml path to
`run-benchmark-worker.sh`. Keep prepared dataset JSONL/manifests outside the
public repository unless their licenses explicitly allow redistribution.

## Standalone JSON Runner

For ad-hoc local datasets, use the standalone runner instead of lmms-eval:

```bash
bash eval/benchmark/pipeline/run.sh \
  --dataset ~/benchmark-data/dataset.json \
  --videos 681 \
  --max-duration-sec 120 \
  --output /tmp/bench-smoke
```

This runner starts managed Qdrant and Mem services directly and writes a single
output tree at the `--output` directory. It is useful for quick custom tests,
but standard dataset comparison should use the lmms-eval worker path above.

## Results

Default result root:

```text
~/.cortex/benchmark_results/<snapshot_version>/
```

Important subtrees:

```text
version_meta.json
videos/<video_id>/
  video_meta.json
  pipeline_env.json
  db/pipeline.db
  segments/
  keyframes/
  narratives/
  memory_dump.json
  qa_runs/<qa_run_version>/
    env.json
    qa_results.jsonl
    qa_summary.json
    traces/

workers/<worker_label>/<run_name>/
  runtime_manifest.json
  worker_command.txt
  logs/server.log
  logs/worker.log
  out/results.json
```

Use `videos/<video_id>/` for badcase analysis and QA-only reruns; worker
directories are mainly service and lmms-eval logs.

## Agent-QA Benchmark Gates

The public repository keeps the generic benchmark runner and result comparison
tools. Internal cross-benchmark gates are intentionally not included because
they depend on private lmms-eval task definitions, frozen baseline snapshots,
and local run roots.

To reproduce a similar gate, keep the gate script in your own benchmark
workspace and call the public runner scripts with explicit dataset, task, and
baseline paths. Do not rely on repository defaults for private tasks.
