# ReflectWorld Eval Overview

`eval/` contains runnable evaluation and validation entry points. It is split by purpose:

| Directory | Purpose |
|---|---|
| `benchmark/` | Dataset benchmarks, lmms-eval integration, VideoMME workers, and offline video QA pipeline support. |
| `video-runner/` | Product-path E2E video validation, including fixtures, assertions, and reports. |

## Benchmark

Use `eval/benchmark` for Video-MME and external custom lmms-eval tasks.

Main entry points:

```bash
# Single-machine offline benchmark runner.
bash eval/benchmark/pipeline/run.sh --dataset <dataset.json> --videos <video_id>

# One Video-MME long worker.
bash eval/benchmark/run-benchmark-worker.sh --offset 0 --limit 3 --port 8501 --snapshot-version <snapshot_id>

# Launch Video-MME long multi-worker run.
bash eval/benchmark/scripts/launch-videomme-16-workers.sh start --snapshot-version <snapshot_id>
```

Important subdirectories:

- `pipeline/`: shared benchmark support, including frame extraction, segment processing, memory dump/rehydrate, and Agent QA.
- `lmms/`: lmms-eval memory API bridge. Custom tasks/data are not published with the public repository; point `LMMS_INCLUDE_PATH` to an external directory.
- `datasets/`: dataset-specific run notes.
- `fixtures/`: optional local smoke-test data. Do not commit private videos or prepared dataset manifests.

## Video Runner

Use `eval/video-runner` for product-level E2E video validation. It is not a dataset benchmark.

Main entry point:

```bash
npx tsx eval/video-runner/runner.ts
```

Important subdirectories:

- `fixtures/`: local test videos, ground truth, and E2E reports.
