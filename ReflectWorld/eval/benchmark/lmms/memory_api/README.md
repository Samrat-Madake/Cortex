# lmms-memory-plugin: memory_api backend

This is ReflectWorld's custom model backend for `lmms-eval`.

## Purpose

Native `lmms-eval` assumes that one multimodal model directly handles the input video or frames plus the question. ReflectWorld's architecture is different:

```text
long video -> segmented perception -> memory -> agent QA
```

This package provides a lightweight bridge:

```text
lmms-eval
  -> memory_api backend
  -> POST /evaluate
  -> ReflectWorld eval-server
```

The backend does not run a model directly. It converts an `lmms-eval` sample into an HTTP JSON request.

## Install

```bash
cd /path/to/ReflectWorld
source "$(conda info --base)/etc/profile.d/conda.sh"
conda activate lmms-bench
pip install -e eval/benchmark/lmms/memory_api
```

Then use this model in `lmms-eval`:

```bash
--model memory_api
```

## Request Format

The backend sends this JSON to `endpoint`:

```json
{
  "prompt": "question prompt",
  "visual_paths": ["/path/to/video.mp4"],
  "generation_kwargs": {},
  "metadata": {
    "task": "videomme_long",
    "split": "test",
    "doc_id": 0,
    "video_id": "601",
    "question_id": "601-1",
    "answer": "A",
    "domain": "Knowledge",
    "sub_category": "Humanity & History",
    "task_type": "Counting Problem"
  },
  "model": "reflectworld"
}
```

`include_doc_fields` controls which dataset fields are copied into `metadata`. Defaults:

```text
video_id,videoID,question_id,domain,sub_category,task_type,duration,url,group_type,group_structure,level,second_head,third_head,answer,before_clip,query_time_ms,query_time_id,video_start_time_ms,media_time_offset_ms
```

Important VideoMME fields:

```text
video_id, question_id, answer, domain, sub_category, task_type
```

## Response Format

The server should return at least one text field:

```json
{
  "answer": "C"
}
```

Compatible response shapes:

```json
{"text": "C"}
{"response": "C"}
{"output": "C"}
{"choices": [{"message": {"content": "C"}}]}
```

Token usage can be included:

```json
{
  "answer": "C",
  "usage": {
    "prompt_tokens": 123,
    "completion_tokens": 4,
    "reasoning_tokens": 0
  }
}
```

## lmms-eval Example

```bash
python -m lmms_eval eval \
  --model memory_api \
  --model_args endpoint=http://127.0.0.1:8501/evaluate,api_key=EMPTY,model_version=reflectworld,num_concurrent=1,timeout=14400,max_retries=2,retry_backoff_s=3 \
  --tasks videomme_long \
  --batch_size 1 \
  --offset 0 \
  --limit 3 \
  --log_samples
```

Recommended usage is to start through the ReflectWorld runner, which manages the eval server, memory service, Qdrant, CUDA environment, and result directories:

```bash
bash eval/benchmark/run-benchmark-worker.sh \
  --offset 0 \
  --limit 3 \
  --port 8501 \
  --gpu 4 \
  --snapshot-version videomme_long_debug
```

## Important Parameters

`endpoint`: ReflectWorld eval-server endpoint, for example:

```text
http://127.0.0.1:8501/evaluate
```

`timeout`: timeout per question. The first question for a long video may trigger the full pipeline, so a large timeout such as `14400` seconds is recommended.

`max_retries`: request retry count.

`num_concurrent`: concurrent requests. ReflectWorld's pipeline is stateful; currently use `1`.

`model_version`: model version label passed to the server, usually `reflectworld`.

## Notes

- The backend calls once per question, not once per video with all questions.
- Multiple questions for the same video produce multiple eval-server requests; eval-server owns pipeline-result caching by video.
- If eval-server crashes, the backend records connection failure as failed text. Those samples should not be treated as real model answers.
- Do not vendor a full `lmms-eval` fork into the ReflectWorld repo. Maintain only this backend plugin here.
