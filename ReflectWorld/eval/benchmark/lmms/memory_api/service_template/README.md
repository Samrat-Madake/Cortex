# Memory Service Template

This template starts a service compatible with the `memory_api` lmms-eval backend.

## Endpoints

- `GET /healthz`
- `POST /v1/lmms_eval/generate`
- `POST /v1/lmms_eval/reset_cache`

## Quick Start

```bash
cd $HOME/reflectworld-benchmark/lmms-memory-plugin/service_template
source "$(conda info --base)/etc/profile.d/conda.sh"
conda activate <your-conda-env>
pip install -r requirements.txt
MEMORY_SERVICE_DRY_RUN=1 bash start_memory_service.sh
```

Alternatively, copy `.env.example` to `.env` and set `CONDA_ENV` plus
`CONDA_SH` there. Leave both unset if the environment is already active.

Then run lmms-eval with:

```bash
cd $HOME/reflectworld-benchmark/lmms-eval
python -m lmms_eval \
  --model memory_api \
  --model_args "endpoint=http://127.0.0.1:8000/v1/lmms_eval/generate,api_key=EMPTY,model_version=your-model" \
  --tasks videomme_v2 \
  --batch_size 1 \
  --limit 8
```

## Integrate Your Pipeline

Edit `pipeline_adapter.py`:

1. `build_state(...)`: build/retrieve video memory state.
2. `answer_question(...)`: answer from memory state + prompt.

In production mode set:

```bash
export MEMORY_SERVICE_DRY_RUN=0
```

## Request/Response Contract

Request JSON fields consumed by template:
- `prompt` (str)
- `visual_paths` (list[str])
- `generation_kwargs` (dict)
- `metadata` (dict)
- `model` (optional str)

Response JSON expected by backend:
- `text` (str, ideally a single letter `A-H`)
- `usage` (optional dict with token fields)
