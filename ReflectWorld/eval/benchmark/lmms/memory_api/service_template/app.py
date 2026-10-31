import hashlib
import json
import os
import re
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from pipeline_adapter import PipelineAdapter


class GenerateRequest(BaseModel):
    model: Optional[str] = None
    prompt: str
    visual_paths: List[str] = Field(default_factory=list)
    generation_kwargs: Dict[str, Any] = Field(default_factory=dict)
    metadata: Dict[str, Any] = Field(default_factory=dict)


class Usage(BaseModel):
    prompt_tokens: Optional[int] = None
    completion_tokens: Optional[int] = None
    reasoning_tokens: Optional[int] = None


class GenerateResponse(BaseModel):
    text: str
    usage: Optional[Usage] = None
    debug: Optional[Dict[str, Any]] = None


class HealthResponse(BaseModel):
    status: str
    cache_size: int
    dry_run: bool


class _StateCache:
    def __init__(self, max_items: int = 256):
        self.max_items = max_items
        self._lock = threading.Lock()
        self._store: "OrderedDict[str, Any]" = OrderedDict()

    def get(self, key: str):
        with self._lock:
            if key in self._store:
                self._store.move_to_end(key)
                return self._store[key]
            return None

    def put(self, key: str, value: Any):
        with self._lock:
            self._store[key] = value
            self._store.move_to_end(key)
            if len(self._store) > self.max_items:
                self._store.popitem(last=False)

    def clear(self):
        with self._lock:
            self._store.clear()

    def size(self) -> int:
        with self._lock:
            return len(self._store)


def _stable_hash(obj: Any) -> str:
    payload = json.dumps(obj, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def _infer_video_id(metadata: Dict[str, Any], visual_paths: List[str]) -> str:
    if metadata.get("video_id") is not None:
        return str(metadata["video_id"])
    if visual_paths:
        return Path(visual_paths[0]).stem
    return "unknown"


def _build_state_key(model: Optional[str], video_id: str, generation_kwargs: Dict[str, Any], metadata: Dict[str, Any]) -> str:
    # Keep key deterministic and tied to decode/sampling config.
    key_obj = {
        "model": model,
        "video_id": video_id,
        "generation_kwargs": generation_kwargs,
        "task": metadata.get("task"),
        "split": metadata.get("split"),
    }
    return f"{video_id}:{_stable_hash(key_obj)}"


def _extract_answer_letter(text: str) -> str:
    if not text:
        return ""
    m = re.search(r"[A-H]", text.upper())
    return m.group(0) if m else ""


def _env_flag(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


DRY_RUN = _env_flag("MEMORY_SERVICE_DRY_RUN", True)
CACHE_MAX_ITEMS = int(os.getenv("MEMORY_SERVICE_CACHE_MAX_ITEMS", "256"))

app = FastAPI(title="LMMS Memory Service Template", version="0.1.0")
adapter = PipelineAdapter(dry_run=DRY_RUN)
cache = _StateCache(max_items=CACHE_MAX_ITEMS)


@app.get("/healthz", response_model=HealthResponse)
def healthz():
    return HealthResponse(status="ok", cache_size=cache.size(), dry_run=DRY_RUN)


@app.post("/v1/lmms_eval/generate", response_model=GenerateResponse)
def generate(req: GenerateRequest):
    try:
        video_id = _infer_video_id(req.metadata, req.visual_paths)
        state_key = _build_state_key(req.model, video_id, req.generation_kwargs, req.metadata)

        state = cache.get(state_key)
        cache_hit = state is not None
        if state is None:
            state = adapter.build_state(
                video_id=video_id,
                visual_paths=req.visual_paths,
                model=req.model,
                generation_kwargs=req.generation_kwargs,
                metadata=req.metadata,
            )
            cache.put(state_key, state)

        raw_answer, usage = adapter.answer_question(
            state=state,
            prompt=req.prompt,
            generation_kwargs=req.generation_kwargs,
            metadata=req.metadata,
        )

        letter = _extract_answer_letter(raw_answer)
        output_text = letter if letter else (raw_answer or "")

        return GenerateResponse(
            text=output_text,
            usage=Usage(**usage) if isinstance(usage, dict) else None,
            debug={
                "video_id": video_id,
                "state_key": state_key,
                "cached": cache_hit,
            },
        )
    except NotImplementedError as e:
        raise HTTPException(status_code=501, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"service_error: {e}")


@app.post("/v1/lmms_eval/reset_cache")
def reset_cache():
    cache.clear()
    return {"status": "ok", "cache_size": 0}
