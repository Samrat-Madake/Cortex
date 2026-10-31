"""Core MemoryManager — sync and async implementations.

Orchestrates episodic, semantic, and procedural memory creation, retrieval,
search, update, and deletion across multiple Qdrant collections.

Ported from the legacy ReflectWorld reference implementation.
"""

import asyncio
import base64
import concurrent.futures
import hashlib
import json
import logging
import re
import threading
import uuid
from contextlib import nullcontext
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any, Callable

import numpy as np
from qdrant_client.models import Direction, OrderBy

from src.config import MemConfig
from src.embedder import Embedder
from src.history import HistoryStore
from src.llm import LLMClient
from src.prompts import (
    PROCEDURAL_MEMORY_SYSTEM_PROMPT,
    build_semantic_analysis_prompt,
)
from src.profiling import (
    attach_profile,
    current_profiler,
    reset_memory_profile,
    start_memory_profile,
)
from src.qdrant_store import COLLECTION_SPECS, QdrantStore
from src.reid import ReidManager

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Module-level utility functions
# ---------------------------------------------------------------------------

def utc_now_iso() -> str:
    """Return current UTC time as ISO-8601 string."""
    return datetime.now(timezone.utc).isoformat()


PROMOTED_KEYS = [
    "user_id", "agent_id", "run_id", "video_id", "video_ids", "actor_id",
    "role", "entity_id", "entity_ids", "camera_id", "category",
    "entity_class",
]

# Keys that are either core fields or promoted — everything else is metadata.
_CORE_AND_PROMOTED = {"data", "hash", "created_at", "updated_at", "id", *PROMOTED_KEYS}

# Flat collection lists — replaces the old _MEMORY_SUFFIXES 3D matrix.
_TEXT_COLLECTIONS = [
    "episodic_trace", "episodic_entity", "episodic_schema",
    "semantic_entity", "semantic_context", "procedural",
]

_VISUAL_COLLECTIONS = ["episodic_visual"]

_GROUP_ALIASES: dict[str, list[str]] = {
    "episodic": ["episodic_trace", "episodic_entity", "episodic_schema"],
    "semantic": ["semantic_entity", "semantic_context"],
    "all":      list(_TEXT_COLLECTIONS),
}

# Entity semantic analysis is expensive. Run it only after every N persisted
# observations for the same scoped entity.
ENTITY_SEMANTIC_UPDATE_INTERVAL = 5
SEMANTIC_BACKGROUND_CONCURRENCY = 15
SEMANTIC_MODE_INLINE = "inline"
SEMANTIC_MODE_BACKGROUND = "background"
SEMANTIC_MODES = {SEMANTIC_MODE_INLINE, SEMANTIC_MODE_BACKGROUND}
MemoryResultCallback = Callable[[dict[str, Any], dict[str, Any]], None]
RuntimeHealthCallback = Callable[..., None]


def _observe_runtime_health(
    callback: RuntimeHealthCallback | None,
    *,
    status: str,
    code: str | None = None,
    scope: dict[str, str] | None = None,
) -> None:
    if callback is None:
        return
    try:
        callback(
            component="memory",
            operation="semantic_update",
            status=status,
            code=code,
            scope=scope,
        )
    except Exception:
        return

_SEMANTIC_CONFIDENCE_IMPORTANCE = {
    "high": 0.8,
    "medium": 0.5,
    "low": 0.3,
}


def _semantic_runtime_health_scope(
    filters: dict[str, Any], metadata: dict[str, Any]
) -> dict[str, str] | None:
    try:
        values = {
            "user_id": filters.get("user_id") or metadata.get("user_id"),
            "session_id": filters.get("session_id") or metadata.get("session_id"),
            "source_id": metadata.get("camera_id"),
        }
        scope = {key: str(value) for key, value in values.items() if value}
        return scope or None
    except Exception:
        return None


def entity_semantic_counter_scope(filters: dict[str, Any]) -> str:
    """Scope entity counters by user only."""
    return str(filters.get("user_id") or "global")


def should_update_entity_semantic_memory(observation_count: int) -> bool:
    """Return true when this entity observation should trigger semantic analysis."""
    return observation_count > 0 and observation_count % ENTITY_SEMANTIC_UPDATE_INTERVAL == 0


def build_metadata(
    *,
    user_id: str | None = None,
    agent_id: str | None = None,
    run_id: str | None = None,
    video_id: str | None = None,
    camera_id: str | None = None,
    input_metadata: dict[str, Any] | None = None,
    **kwargs: Any,
) -> dict[str, Any]:
    """Build metadata from session IDs. At least one ID required."""
    meta: dict[str, Any] = deepcopy(input_metadata) if input_metadata else {}
    provided: list[str] = []

    if user_id:
        meta["user_id"] = user_id
        provided.append("user_id")
    if agent_id:
        meta["agent_id"] = agent_id
        provided.append("agent_id")
    if run_id:
        meta["run_id"] = run_id
        provided.append("run_id")
    if video_id:
        meta["video_id"] = video_id
        provided.append("video_id")
    if camera_id:
        meta["camera_id"] = camera_id
        provided.append("camera_id")

    if not provided:
        raise ValueError(
            "At least one of 'user_id', 'agent_id', 'run_id', 'video_id', "
            "or 'camera_id' must be provided."
        )
    return meta


def build_filters(
    *,
    user_id: str | None = None,
    agent_id: str | None = None,
    run_id: str | None = None,
    video_id: str | None = None,
    camera_id: str | None = None,
    entity_id: str | None = None,
    mode: str | None = None,
    input_filters: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build query filters. At least one ID required."""
    filters: dict[str, Any] = deepcopy(input_filters) if input_filters else {}
    provided: list[str] = []

    if user_id:
        filters["user_id"] = user_id
        provided.append("user_id")
    if agent_id:
        filters["agent_id"] = agent_id
        provided.append("agent_id")
    if run_id:
        filters["run_id"] = run_id
        provided.append("run_id")
    if video_id:
        filters["video_id"] = video_id
        provided.append("video_id")
    if camera_id:
        filters["camera_id"] = camera_id
        provided.append("camera_id")
    if entity_id:
        filters["entity_id"] = entity_id
        provided.append("entity_id")
    if mode:
        filters["mode"] = mode

    if not provided:
        raise ValueError(
            "At least one of 'user_id', 'agent_id', 'run_id', 'video_id', "
            "'camera_id', or 'entity_id' must be provided."
        )
    return filters


def normalize_video_ids(*values: Any) -> list[str]:
    """Normalize one or more scalar/list video id sources into a deduped list."""
    video_ids: list[str] = []
    for value in values:
        if value is None:
            continue
        candidates = value if isinstance(value, (list, tuple, set)) else [value]
        for candidate in candidates:
            if candidate is None:
                continue
            video_id = str(candidate).strip()
            if video_id and video_id not in video_ids:
                video_ids.append(video_id)
    return video_ids


def normalize_string_ids(*values: Any) -> list[str]:
    """Normalize one or more scalar/list id sources into a deduped list."""
    ids: list[str] = []
    for value in values:
        if value is None:
            continue
        candidates = value if isinstance(value, (list, tuple, set)) else [value]
        for candidate in candidates:
            if candidate is None:
                continue
            text = str(candidate).strip()
            if text and text not in ids:
                ids.append(text)
    return ids


def get_collections(
    memory_type: str | None,
    *,
    allow_groups: bool = True,
    allow_visual: bool = False,
) -> list[str]:
    """Map memory_type to one or more collection suffixes.

    Accepts:
      - Exact collection name: "episodic_trace", "semantic_entity", "procedural", ...
      - Group alias: "episodic", "semantic", "all"
      - None: same as "all"

    Keyword args:
      allow_groups: When False (write paths), reject group aliases and None.
      allow_visual: When False (default), reject visual collections
                    (different embedding dimension).
    """
    if memory_type is None:
        if not allow_groups:
            raise ValueError("memory_type is required for writes.")
        return list(_TEXT_COLLECTIONS)

    if memory_type in _GROUP_ALIASES:
        if not allow_groups:
            raise ValueError(
                f"Group alias '{memory_type}' not allowed for writes. "
                f"Use exact collection name: {_GROUP_ALIASES[memory_type]}"
            )
        return list(_GROUP_ALIASES[memory_type])

    if memory_type in _TEXT_COLLECTIONS:
        return [memory_type]

    if memory_type in _VISUAL_COLLECTIONS:
        if not allow_visual:
            raise ValueError(
                f"'{memory_type}' uses non-text embeddings (1024d). "
                f"Use GET /memories for scroll access, not POST /search."
            )
        return [memory_type]

    raise ValueError(
        f"Unknown memory_type '{memory_type}'. "
        f"Valid text: {_TEXT_COLLECTIONS}, groups: {list(_GROUP_ALIASES.keys())}, "
        f"visual: {_VISUAL_COLLECTIONS}"
    )


def format_memory_result(point_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Format Qdrant point into API response dict."""
    result: dict[str, Any] = {
        "id": point_id,
        "memory": payload.get("data", ""),
        "hash": payload.get("hash"),
        "created_at": payload.get("created_at"),
        "updated_at": payload.get("updated_at"),
    }

    # Promote known keys to top level
    for key in PROMOTED_KEYS:
        if key in payload:
            result[key] = payload[key]

    # Remaining payload → metadata (importance is NOT in PROMOTED_KEYS,
    # so it falls into additional_metadata naturally, matching old service)
    additional: dict[str, Any] = {
        k: v for k, v in payload.items() if k not in _CORE_AND_PROMOTED
    }
    if additional:
        result["metadata"] = additional

    return result


def compute_importance(old_importance: float, growth_rate: float = 0.2) -> float:
    """Asymptotic importance growth: old + (1-old) * rate, rounded to 4 decimals."""
    return round(old_importance + (1.0 - old_importance) * growth_rate, 4)


def semantic_update_category(update: dict[str, Any]) -> str:
    """Read the prompt's singular category field, with legacy fallback."""
    value = update.get("category")
    if value in (None, ""):
        value = update.get("categories", "")
    if value is None:
        return ""
    if isinstance(value, list):
        return ",".join(str(item).strip() for item in value if str(item).strip())
    return str(value).strip()


def semantic_update_importance(update: dict[str, Any], default: float = 0.5) -> float:
    """Map prompt confidence to numeric importance, with legacy numeric fallback."""
    raw_importance = update.get("importance")
    if isinstance(raw_importance, (int, float)) and not isinstance(raw_importance, bool):
        return max(0.0, min(1.0, float(raw_importance)))
    if isinstance(raw_importance, str):
        try:
            return max(0.0, min(1.0, float(raw_importance)))
        except ValueError:
            pass

    confidence = update.get("confidence")
    if isinstance(confidence, str):
        return _SEMANTIC_CONFIDENCE_IMPORTANCE.get(confidence.strip().lower(), default)
    return default


def remove_code_blocks(text: str) -> str:
    """Strip ```json ... ``` wrapper if present."""
    cleaned = re.sub(r"^```(?:json)?\s*\n?", "", text.strip())
    cleaned = re.sub(r"\n?```\s*$", "", cleaned)
    return cleaned.strip()


# ---------------------------------------------------------------------------
# MemoryManager (Sync)
# ---------------------------------------------------------------------------


class MemoryManager:
    """Synchronous memory manager orchestrating all memory operations."""

    def __init__(
        self,
        store: QdrantStore,
        llm: LLMClient,
        embedder: Embedder,
        reid: ReidManager,
        history: HistoryStore,
        config: MemConfig,
        on_background_memory_result: MemoryResultCallback | None = None,
        on_runtime_health: RuntimeHealthCallback | None = None,
    ) -> None:
        self.store = store
        self.llm = llm
        self.embedder = embedder
        self.reid = reid
        self.history = history
        self.config = config
        self.on_background_memory_result = on_background_memory_result
        self.on_runtime_health = on_runtime_health
        self._semantic_background_executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=SEMANTIC_BACKGROUND_CONCURRENCY,
            thread_name_prefix="mem-semantic-bg",
        )
        self._semantic_background_futures: set[concurrent.futures.Future[None]] = set()
        self._semantic_background_futures_guard = threading.Lock()
        self._semantic_entity_locks: dict[str, threading.Lock] = {}
        self._semantic_entity_locks_guard = threading.Lock()

    # ------------------------------------------------------------------ #
    # Public API                                                          #
    # ------------------------------------------------------------------ #

    def add_memory(
        self,
        video_data: dict[str, Any] | None = None,
        entity_data: list[dict[str, Any]] | None = None,
        messages: Any = None,
        *,
        user_id: str | None = None,
        agent_id: str | None = None,
        run_id: str | None = None,
        video_id: str | None = None,
        camera_id: str | None = None,
        metadata: dict[str, Any] | None = None,
        infer: bool = True,
        memory_type: str | None = None,
        prompt: str | None = None,
        semantic_mode: str = SEMANTIC_MODE_INLINE,
        mode: str | None = None,
        event_id: str | None = None,
    ) -> dict[str, Any]:
        """Main entry point for creating memories."""
        profiler, token = start_memory_profile("mem.add", {
            "memory_type": memory_type or "default",
            "infer": bool(infer),
            "camera_id": camera_id,
            "video_id": video_id,
        })
        try:
            response = self._add_memory_impl(
                video_data=video_data,
                entity_data=entity_data,
                messages=messages,
                user_id=user_id,
                agent_id=agent_id,
                run_id=run_id,
                video_id=video_id,
                camera_id=camera_id,
                metadata=metadata,
                infer=infer,
                memory_type=memory_type,
                prompt=prompt,
                semantic_mode=semantic_mode,
                mode=mode,
                event_id=event_id,
            )
            return attach_profile(response, profiler)
        finally:
            reset_memory_profile(token)

    def _add_memory_impl(
        self,
        video_data: dict[str, Any] | None = None,
        entity_data: list[dict[str, Any]] | None = None,
        messages: Any = None,
        *,
        user_id: str | None = None,
        agent_id: str | None = None,
        run_id: str | None = None,
        video_id: str | None = None,
        camera_id: str | None = None,
        metadata: dict[str, Any] | None = None,
        infer: bool = True,
        memory_type: str | None = None,
        prompt: str | None = None,
        semantic_mode: str = SEMANTIC_MODE_INLINE,
        mode: str | None = None,
        event_id: str | None = None,
    ) -> dict[str, Any]:
        processed_metadata = build_metadata(
            user_id=user_id,
            agent_id=agent_id,
            run_id=run_id,
            video_id=video_id,
            camera_id=camera_id,
            input_metadata=metadata,
        )
        effective_filters = build_filters(
            user_id=user_id,
            agent_id=agent_id,
            run_id=run_id,
            video_id=video_id,
            camera_id=camera_id,
        )

        # Propagate dataflow context
        if mode is not None:
            processed_metadata["mode"] = mode
            effective_filters["mode"] = mode
        if event_id is not None:
            processed_metadata["event_id"] = event_id

        # Propagate media_urls from video_data
        if video_data:
            media_urls = video_data.get("media_urls")
            if media_urls:
                processed_metadata["media_urls"] = media_urls

        # -- Branch on memory_type --
        if memory_type is not None:
            if memory_type == "procedural":
                if isinstance(messages, str):
                    messages = [{"role": "user", "content": messages}]
                elif isinstance(messages, dict):
                    messages = [messages]
                elif not isinstance(messages, list):
                    raise ValueError("messages must be str, dict, or list[dict]")
                if video_data is not None or entity_data is not None:
                    raise ValueError(
                        "For procedural memory type, 'video_data' and 'entity_data' "
                        "must be None. Only 'messages' should be provided."
                    )
                if camera_id is None and agent_id is None:
                    raise ValueError(
                        "For procedural memory type, 'camera_id' or 'agent_id' must be provided."
                    )
                return self._create_procedural_memory(
                    messages, metadata=processed_metadata, prompt=prompt
                )

            elif memory_type in ("semantic", "semantic_entity"):
                if entity_data is None or len(entity_data) == 0:
                    raise ValueError("For semantic memory type, 'entity_data' must be provided.")
                entity_id_val = entity_data[0].get("entity_id")
                entity_message = entity_data[0].get("message")
                if not entity_id_val or not entity_message:
                    raise ValueError(
                        "For semantic memory type, 'entity_id' and 'message' must be provided."
                    )

                payload = deepcopy(processed_metadata)
                payload["entity_id"] = entity_id_val
                payload["entity_class"] = entity_data[0].get("class_name", "")

                category = entity_data[0].get("category", "user_added")
                payload["category"] = category
                importance = 1.0 if category == "identity" else entity_data[0].get("importance", 0.5)
                payload["importance"] = importance

                payload["video_ids"] = normalize_video_ids(
                    entity_data[0].get("video_ids"),
                    processed_metadata.get("video_ids"),
                    processed_metadata.get("video_id"),
                )
                payload.pop("video_id", None)

                mem_id = self._create_memory("semantic_entity", entity_message, metadata=payload)
                return {
                    "results": [
                        {
                            "id": mem_id,
                            "memory": entity_message,
                            "event": "ADD",
                            "collection": self.store.collection_name("semantic_entity"),
                            "entity_id": entity_id_val,
                            "entity_class": payload["entity_class"],
                            "category": category,
                            "importance": importance,
                        }
                    ]
                }
            else:
                raise ValueError(
                    "Invalid 'memory_type'. Default creates episodic and semantic memories. "
                    "'procedural', 'semantic', or 'semantic_entity' can be passed explicitly."
                )

        # Default: episodic + semantic
        if video_data is None and entity_data is None:
            raise ValueError(
                "When 'memory_type' is not specified, at least one of "
                "'video_data' or 'entity_data' must be provided."
            )
        video_data = video_data or {}
        entity_data = entity_data or []

        vector_store_result = self._add_to_vector_store(
            video_data, entity_data, processed_metadata, effective_filters, infer, semantic_mode
        )
        return {"results": vector_store_result, "relations": []}

    def search_memories(
        self,
        query: str,
        *,
        user_id: str | None = None,
        agent_id: str | None = None,
        run_id: str | None = None,
        video_id: str | None = None,
        entity_id: str | None = None,
        camera_id: str | None = None,
        mode: str | None = None,
        memory_type: str | None = None,
        limit: int = 100,
        threshold: float | None = None,
        filters: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Search across text collections. Returns {full_collection_name: [results]}."""
        effective_filters = build_filters(
            user_id=user_id,
            agent_id=agent_id,
            run_id=run_id,
            video_id=video_id,
            entity_id=entity_id,
            camera_id=camera_id,
            mode=mode,
            input_filters=filters,
        )

        collections = get_collections(memory_type, allow_visual=False)
        embedding = self.embedder.embed(query)

        results: dict[str, Any] = {}

        def _search_one(suffix: str) -> tuple[str, list[dict[str, Any]]]:
            adjusted = self._adjust_filters_for_collection(suffix, effective_filters)
            raw = self.store.search(suffix, embedding, filters=adjusted, limit=limit)
            formatted: list[dict[str, Any]] = []
            for hit in raw:
                mem_dict = format_memory_result(hit["id"], hit["payload"])
                mem_dict["score"] = hit["score"]
                if threshold is None or hit["score"] >= threshold:
                    formatted.append(mem_dict)
            return self.store.collection_name(suffix), formatted

        with concurrent.futures.ThreadPoolExecutor() as executor:
            futures = {
                executor.submit(_search_one, suffix): suffix for suffix in collections
            }
            concurrent.futures.wait(futures)
            for future in futures:
                full_name, hits = future.result()
                if hits:
                    results[full_name] = hits

        return results

    def get_all_memories(
        self,
        *,
        user_id: str | None = None,
        agent_id: str | None = None,
        run_id: str | None = None,
        video_id: str | None = None,
        entity_id: str | None = None,
        camera_id: str | None = None,
        memory_type: str | None = None,
        limit: int = 100,
        filters: dict[str, Any] | None = None,
        sort_order: str | None = None,
    ) -> dict[str, Any]:
        """List memories. Returns {full_collection_name: [memories]}."""
        effective_filters = build_filters(
            user_id=user_id,
            agent_id=agent_id,
            run_id=run_id,
            video_id=video_id,
            entity_id=entity_id,
            camera_id=camera_id,
            input_filters=filters,
        )
        collections = get_collections(memory_type, allow_visual=True)

        results: dict[str, Any] = {}

        def _list_one(suffix: str) -> tuple[str, list[dict[str, Any]]]:
            adjusted = self._adjust_filters_for_collection(suffix, effective_filters)
            sort_field = _sort_key_for_collection(suffix)
            if sort_order == "asc":
                order_by_field = OrderBy(key=sort_field, direction=Direction.ASC)
            elif sort_order == "desc" or sort_order is None:
                order_by_field = OrderBy(key=sort_field, direction=Direction.DESC)
            else:
                order_by_field = None
            raw = self.store.scroll(suffix, filters=adjusted, limit=limit, order_by=order_by_field)
            formatted: list[dict[str, Any]] = []
            for point in raw:
                mem_dict = format_memory_result(point["id"], point["payload"])
                # Promote importance to top level for get_all (matches old service)
                importance = point["payload"].get("importance", 0.5)
                mem_dict["importance"] = importance
                formatted.append(mem_dict)
            # Sort semantic by importance desc
            if "semantic" in suffix:
                formatted.sort(key=lambda x: x.get("importance", 0.5), reverse=True)
            return self.store.collection_name(suffix), formatted

        with concurrent.futures.ThreadPoolExecutor() as executor:
            futures = {
                executor.submit(_list_one, suffix): suffix for suffix in collections
            }
            concurrent.futures.wait(futures)
            for future in futures:
                full_name, mems = future.result()
                if mems:
                    results[full_name] = mems

        return results

    def get_memory(
        self,
        memory_id: str,
        memory_type: str | None = None,
        return_all_matches: bool = False,
    ) -> dict[str, Any] | None:
        """Get single memory by ID. Returns {full_collection_name: memory} or None."""
        collections = get_collections(memory_type)
        matches: dict[str, Any] = {}

        for suffix in collections:
            point = self.store.get(suffix, memory_id)
            if point:
                result = format_memory_result(point["id"], point["payload"])
                full_name = self.store.collection_name(suffix)
                matches[full_name] = result
                if not return_all_matches:
                    return matches

        return matches if matches else None

    def update_memory(
        self,
        memory_id: str,
        data: str,
        memory_type: str | None = None,
        data_type: str = "txt",
    ) -> dict[str, Any]:
        """Update memory. Reject episodic. Returns result dict."""
        collections = get_collections(memory_type)

        if memory_type and "episodic" in memory_type:
            raise ValueError("Episodic memories are immutable and cannot be updated.")

        # Pre-process embedding
        if data_type == "txt":
            embedding = self.embedder.embed(data)
            update_data = data
        else:
            embedding = np.frombuffer(base64.b64decode(data), dtype=np.float32).tolist()
            update_data = ""

        for suffix in collections:
            if "episodic" in suffix:
                continue
            try:
                self._update_memory(suffix, memory_id, update_data, embedding=embedding)
                return {
                    "message": f"{self.store.collection_name(suffix)} memory updated successfully!"
                }
            except ValueError:
                continue

        raise ValueError(f"Memory with ID {memory_id} not found in any collection.")

    def delete_memory(
        self,
        memory_id: str,
        memory_type: str | None = None,
        data_type: str = "txt",
    ) -> dict[str, Any]:
        """Delete single memory. Returns {message: ...}."""
        collections = get_collections(memory_type)

        for suffix in collections:
            point = self.store.get(suffix, memory_id)
            if point:
                self._delete_memory(suffix, memory_id)
                return {
                    "message": f"{self.store.collection_name(suffix)} memory deleted successfully!",
                    "deleted_memory": {
                        "id": memory_id,
                        "memory": point["payload"].get("data"),
                    },
                }

        raise ValueError(f"Memory with ID {memory_id} not found in any collection.")

    def delete_all_memories(
        self,
        *,
        user_id: str | None = None,
        agent_id: str | None = None,
        run_id: str | None = None,
        video_id: str | None = None,
        entity_id: str | None = None,
        camera_id: str | None = None,
        memory_type: str | None = None,
        data_type: str | None = None,
    ) -> dict[str, Any]:
        """Batch delete with filters."""
        effective_filters = build_filters(
            user_id=user_id,
            agent_id=agent_id,
            run_id=run_id,
            video_id=video_id,
            entity_id=entity_id,
            camera_id=camera_id,
        )
        if not effective_filters:
            raise ValueError(
                "At least one filter is required. Use reset() to delete everything."
            )

        collections = get_collections(memory_type)
        total_deleted = 0
        deleted_counts: dict[str, int] = {
            self.store.collection_name(s): 0 for s in collections
        }

        for suffix in collections:
            full_name = self.store.collection_name(suffix)
            adjusted = self._adjust_filters_for_collection(suffix, effective_filters)
            while True:
                points = self.store.scroll(suffix, filters=adjusted, limit=1000)
                if not points:
                    break

                batch_deleted = 0
                for point in points:
                    self._delete_memory(suffix, point["id"])
                    deleted_counts[full_name] += 1
                    total_deleted += 1
                    batch_deleted += 1

                if batch_deleted == 0:
                    break

        if total_deleted == 0:
            return {
                "message": "No memories found to delete!",
                "total_deleted": 0,
                "deleted_by_type": deleted_counts,
            }
        return {
            "message": "Memories deleted successfully!",
            "total_deleted": total_deleted,
            "deleted_by_type": deleted_counts,
        }

    def get_history(self, memory_id: str) -> list[dict[str, Any]]:
        """Get change history for a memory."""
        return self.history.get_history(memory_id)

    def expire_media(
        self, segment_id: str, camera_id: str | None = None
    ) -> dict[str, Any]:
        """Set media_urls=None for episodic memories matching video_id=segment_id."""
        filters: dict[str, Any] = {"video_id": segment_id}
        if camera_id:
            filters["camera_id"] = camera_id

        points = self.store.scroll("episodic_trace", filters=filters, limit=1000)
        updated_count = 0
        for point in points:
            self.store.set_payload(
                "episodic_trace",
                point["id"],
                {
                    "media_urls": None,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                },
            )
            updated_count += 1

        logger.info(
            "expire_media: nullified media_urls for %d records, segment_id=%s",
            updated_count, segment_id,
        )
        return {
            "segment_id": segment_id,
            "updated_count": updated_count,
            "status": "ok",
        }

    def set_identity(
        self, entity_id: str, identity: str, status: str = "familiar",
        user_id: str | None = None, camera_id: str | None = None,
    ) -> dict[str, Any]:
        """Create or update an identity memory for an entity.

        Identity memories are stored in semantic_entity with category='identity'
        and importance=1.0. They are protected from LLM UPDATE/DELETE.
        If an identity memory already exists for this scoped entity_id, it is updated.
        """
        identity_filters = {"entity_id": entity_id, "category": "identity"}
        if user_id:
            identity_filters["user_id"] = user_id

        # Check for existing identity memory
        existing = self.store.scroll(
            "semantic_entity",
            filters=identity_filters,
            limit=1,
        )

        text = f"{identity} (status: {status})"
        payload: dict[str, Any] = {
            "entity_id": entity_id,
            "category": "identity",
            "importance": 1.0,
            "identity_status": status,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        if user_id:
            payload["user_id"] = user_id
        if camera_id:
            payload["camera_id"] = camera_id

        if existing:
            # Update existing identity memory
            mem_id = existing[0]["id"]
            self._update_memory("semantic_entity", mem_id, text, metadata=payload)
            logger.info(
                "Updated identity for entity %s user=%s: %s (%s)",
                entity_id, user_id, identity, status,
            )
            return {
                "entity_id": entity_id,
                "user_id": user_id,
                "memory_id": mem_id,
                "event": "UPDATE",
                "identity": text,
            }
        else:
            # Create new identity memory
            mem_id = self._create_memory("semantic_entity", text, metadata=payload)
            logger.info(
                "Created identity for entity %s user=%s: %s (%s)",
                entity_id, user_id, identity, status,
            )
            return {
                "entity_id": entity_id,
                "user_id": user_id,
                "memory_id": mem_id,
                "event": "ADD",
                "identity": text,
            }

    def reset(self) -> None:
        """Delete and recreate all collections, reset history."""
        logger.warning("Resetting all ReflectWorld memory stores")
        for suffix in COLLECTION_SPECS:
            try:
                self.store.delete_collection(suffix)
            except Exception as exc:
                logger.error("Error deleting collection %s: %s", suffix, exc)
        # Recreate
        self.store._ensure_collections()
        self.store._ensure_payload_indexes()
        self.history.reset()

    def close(self) -> None:
        """Release background resources owned by the synchronous manager."""
        self._semantic_background_executor.shutdown(wait=False, cancel_futures=True)

    # ------------------------------------------------------------------ #
    # Internal: Episodic                                                  #
    # ------------------------------------------------------------------ #

    def _add_to_vector_store(
        self,
        video_data: dict[str, Any],
        entity_data: list[dict[str, Any]],
        metadata: dict[str, Any],
        filters: dict[str, Any],
        infer: bool,
        semantic_mode: str = SEMANTIC_MODE_INLINE,
    ) -> list[dict[str, Any]]:
        """Orchestrate episodic + semantic creation."""
        returned_memories: list[dict[str, Any]] = []
        profiler = current_profiler()
        if semantic_mode not in SEMANTIC_MODES:
            raise ValueError(f"semantic_mode must be one of {sorted(SEMANTIC_MODES)}")
        if profiler:
            profiler.add_counter("entity_data_count", len(entity_data))
            profiler.add_counter("infer_enabled", 1 if infer else 0)
            profiler.add_counter(f"semantic_mode_{semantic_mode}", 1)

        # 1. Episodic
        with (profiler.span("mem.episodic_entity.total") if profiler else nullcontext()):
            entity_memories, entity_ids = self._create_episodic_entity(
                entity_data, metadata
            )
        with (profiler.span("mem.episodic_trace.total") if profiler else nullcontext()):
            video_memories = self._create_episodic_trace(
                video_data, metadata, entity_ids
            )
        returned_memories.extend(entity_memories)
        returned_memories.extend(video_memories)

        # 2. Semantic inference
        if infer:
            if semantic_mode == SEMANTIC_MODE_BACKGROUND:
                self._enqueue_background_semantic_memory(video_data, entity_data, filters, metadata)
                if profiler:
                    profiler.add_counter("semantic_background_enqueued", 1)
                return returned_memories
            with (profiler.span("mem.semantic.total") if profiler else nullcontext()):
                semantic_results = self._process_entity_semantic_memory(
                    video_data, entity_data, filters, metadata
                )
            returned_memories.extend(semantic_results)

        return returned_memories

    def _semantic_entity_lock(self, key: str) -> threading.Lock:
        if not hasattr(self, "_semantic_entity_locks_guard"):
            self._semantic_entity_locks_guard = threading.Lock()
            self._semantic_entity_locks = {}
        with self._semantic_entity_locks_guard:
            lock = self._semantic_entity_locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._semantic_entity_locks[key] = lock
            return lock

    def _enqueue_background_semantic_memory(
        self,
        video_data: dict[str, Any],
        entity_data: list[dict[str, Any]],
        filters: dict[str, Any],
        metadata: dict[str, Any],
    ) -> None:
        """Run expensive sync entity semantic updates out of the request path."""
        video_data_copy = deepcopy(video_data)
        entity_data_copy = deepcopy(entity_data)
        filters_copy = deepcopy(filters)
        metadata_copy = deepcopy(metadata)

        if not hasattr(self, "_semantic_background_executor"):
            self._semantic_background_executor = concurrent.futures.ThreadPoolExecutor(
                max_workers=SEMANTIC_BACKGROUND_CONCURRENCY,
                thread_name_prefix="mem-semantic-bg",
            )
            self._semantic_background_futures = set()
            self._semantic_background_futures_guard = threading.Lock()

        def _runner() -> None:
            health_scope = _semantic_runtime_health_scope(filters_copy, metadata_copy)
            profiler, token = start_memory_profile(
                "mem.semantic.background",
                {
                    "camera_id": metadata_copy.get("camera_id"),
                    "video_id": metadata_copy.get("video_id"),
                    "entity_count": len([e for e in entity_data_copy if e.get("entity_id")]),
                },
            )
            try:
                with profiler.span("mem.semantic.total"):
                    results = self._process_entity_semantic_memory(
                        video_data_copy,
                        entity_data_copy,
                        filters_copy,
                        metadata_copy,
                    )
                profiler.add_counter("semantic_background_results", len(results))
                _observe_runtime_health(
                    getattr(self, "on_runtime_health", None),
                    status="ok",
                    scope=health_scope,
                )
                if self.on_background_memory_result:
                    for result in results:
                        self.on_background_memory_result(result, metadata_copy)
            except Exception:
                _observe_runtime_health(
                    getattr(self, "on_runtime_health", None),
                    status="down",
                    code="background_update_failed",
                    scope=health_scope,
                )
                logger.exception(
                    "Background semantic memory update failed camera_id=%s video_id=%s",
                    metadata_copy.get("camera_id"),
                    metadata_copy.get("video_id"),
                )
            finally:
                logger.info(
                    "[memory-profile] semantic_background %s",
                    json.dumps(profiler.to_dict(), ensure_ascii=False),
                )
                reset_memory_profile(token)

        future = self._semantic_background_executor.submit(_runner)
        with self._semantic_background_futures_guard:
            self._semantic_background_futures.add(future)

        def _discard_future(done: concurrent.futures.Future[None]) -> None:
            with self._semantic_background_futures_guard:
                self._semantic_background_futures.discard(done)

        future.add_done_callback(_discard_future)

    def _create_episodic_entity(
        self,
        entity_data: list[dict[str, Any]],
        metadata: dict[str, Any],
    ) -> tuple[list[dict[str, Any]], list[str]]:
        """Per-entity episodic observation → episodic_entity collection."""
        returned_memories: list[dict[str, Any]] = []
        entity_ids: list[str] = []

        def _entity_observation_text(entity: dict[str, Any]) -> str:
            class_name = str(entity.get("class_name") or "entity").strip()
            appearance = str(entity.get("appearance") or "").strip()
            behavior = str(entity.get("behavior") or "").strip()
            interaction = str(entity.get("interaction") or "").strip()
            message = str(entity.get("message") or "").strip()

            parts: list[str] = []
            if appearance and behavior:
                parts.append(f"A {class_name} is shown with {appearance}; it {behavior}.")
            elif appearance:
                parts.append(f"A {class_name} is shown with {appearance}.")
            elif behavior:
                parts.append(f"A {class_name} {behavior}.")
            if interaction:
                parts.append(f"It interacts by {interaction}.")
            # Fallback to message when structured fields are empty (rehydrate / manual add)
            if not parts and message:
                return message
            return " ".join(parts).strip()

        for entity in entity_data:
            entity_id = entity.get("entity_id")
            if not entity_id:
                continue
            entity_ids.append(entity_id)

            content = _entity_observation_text(entity)
            if not content:
                continue

            payload = deepcopy(metadata)
            payload["role"] = "user"
            payload["entity_id"] = entity_id
            payload["class_name"] = entity.get("class_name", "")
            payload["video_ids"] = normalize_video_ids(
                metadata.get("video_ids"),
                metadata.get("video_id"),
            )
            payload.pop("video_id", None)

            embedding = self.embedder.embed(content)
            mem_id = self._create_memory(
                "episodic_entity", content, embedding=embedding, metadata=payload
            )
            returned_memories.append(
                {
                    "id": mem_id,
                    "memory": content,
                    "event": "ADD",
                    "collection": self.store.collection_name("episodic_entity"),
                }
            )
        return returned_memories, entity_ids

    def _create_episodic_trace(
        self,
        video_data: dict[str, Any],
        metadata: dict[str, Any],
        entity_ids: list[str],
    ) -> list[dict[str, Any]]:
        """Segment-level video summary → episodic_trace collection."""
        returned_memories: list[dict[str, Any]] = []
        payload = deepcopy(metadata)
        payload["role"] = "user"
        payload["entity_ids"] = normalize_string_ids(
            entity_ids,
            metadata.get("entity_ids"),
        )

        summary = str(video_data.get("summary") or "").strip()
        detailed_summary = str(video_data.get("detailed_summary") or "").strip()
        transcript = str(video_data.get("transcript") or "").strip()
        speech_events_text = str(video_data.get("speech_events_text") or "").strip()
        speech_text = str(video_data.get("speech_text") or metadata.get("speech_text") or "").strip()
        retrieval_compact = _normalize_retrieval_compact(
            video_data.get("retrieval_compact") or metadata.get("retrieval_compact")
        )
        if summary:
            payload["summary"] = summary
        if detailed_summary:
            payload["detailed_summary"] = detailed_summary
        if retrieval_compact:
            payload["retrieval_compact"] = retrieval_compact
        if transcript:
            payload["transcript"] = transcript
        if speech_events_text:
            payload["speech_events_text"] = speech_events_text
        if speech_text:
            payload["speech_text"] = speech_text

        content_parts = [detailed_summary or summary]
        if speech_events_text:
            content_parts.append(speech_events_text)
        if retrieval_compact:
            content_parts.append(f"Retrieval compact: {'; '.join(retrieval_compact)}")
        content = " ".join(part for part in content_parts if part).strip()
        if content:
            embedding = self.embedder.embed(content)
            txt_mem_id = self._create_memory(
                "episodic_trace", content, embedding=embedding, metadata=payload
            )
            returned_memories.append(
                {
                    "id": txt_mem_id,
                    "memory": content,
                    "event": "ADD",
                    "collection": self.store.collection_name("episodic_trace"),
                }
            )

        # Video embedding episodic (base64 → float32 vector)
        embed_data = video_data.get("embed")
        if embed_data:
            try:
                embed_vector = np.frombuffer(
                    base64.b64decode(embed_data), dtype=np.float32
                ).tolist()
                vid_mem_id = self._create_memory(
                    "episodic_visual", "", embedding=embed_vector, metadata=payload
                )
                returned_memories.append(
                    {
                        "id": vid_mem_id,
                        "memory": "",
                        "event": "ADD",
                        "collection": self.store.collection_name("episodic_visual"),
                    }
                )
            except Exception as exc:
                logger.error("Error processing video embed data: %s", exc)

        return returned_memories

    # ------------------------------------------------------------------ #
    # Internal: Semantic Inference                                        #
    # ------------------------------------------------------------------ #

    def _process_entity_semantic_memory(
        self,
        video_data: dict[str, Any],
        entity_data: list[dict[str, Any]],
        filters: dict[str, Any],
        metadata: dict[str, Any],
    ) -> list[dict[str, Any]]:
        """Per-entity semantic inference."""
        returned_memories: list[dict[str, Any]] = []

        new_video_data = {
            **{k: v for k, v in video_data.items() if k != "embed"},
            "entities": [
                {k: v for k, v in entity.items() if k != "embed"}
                for entity in entity_data
            ],
        }
        counter_scope = entity_semantic_counter_scope(filters)
        profiler = current_profiler()
        if profiler:
            profiler.add_counter("semantic_entity_count", len([e for e in entity_data if e.get("entity_id")]))

        for entity_item in entity_data:
            entity_id = entity_item.get("entity_id")
            if not entity_id:
                continue
            lock_key = f"{counter_scope}:{entity_id}"
            lock = self._semantic_entity_lock(lock_key)
            with lock:
                try:
                    with (profiler.span("mem.semantic.counter") if profiler else nullcontext()):
                        observation_count = self.history.increment_entity_observation(
                            counter_scope, entity_id
                        )
                    should_update_semantic = should_update_entity_semantic_memory(
                        observation_count
                    )
                    logger.info(
                        "Entity semantic update gate: scope=%s entity_id=%s "
                        "observation_count=%d interval=%d should_update=%s",
                        counter_scope,
                        entity_id,
                        observation_count,
                        ENTITY_SEMANTIC_UPDATE_INTERVAL,
                        should_update_semantic,
                    )
                    if not should_update_semantic:
                        continue

                    current_video_id = metadata.get("video_id")
                    with (profiler.span("mem.semantic.history.total") if profiler else nullcontext()):
                        historical = self._get_entity_complete_history(
                            entity_id, filters, exclude_video_id=current_video_id
                        )
                    if not historical["episodic"] and not historical["semantic"]:
                        logger.info(
                            "No historical memories for entity %s, skipping semantic", entity_id
                        )
                        continue

                    with (profiler.span("mem.semantic.merge.total") if profiler else nullcontext()):
                        semantic_results, has_add_or_update = self._merge_entity_semantic_memory(
                            entity_id, new_video_data, historical, metadata
                        )
                    returned_memories.extend(semantic_results)

                    if has_add_or_update:
                        visual_results = self._entity_semantic_visual_embed(
                            entity_item, entity_id, metadata
                        )
                        returned_memories.extend(visual_results)
                except Exception as exc:
                    logger.error(
                        "Error processing semantic memory for entity %s: %s", entity_id, exc
                    )
                    continue

        return returned_memories

    def _get_entity_complete_history(
        self,
        entity_id: str,
        filters: dict[str, Any],
        exclude_video_id: str | None = None,
    ) -> dict[str, list[dict[str, Any]]]:
        """Get episodic(20) + semantic(10) history.

        Remove camera_id, video_id, run_id and mode from filters for broader history.
        """
        profiler = current_profiler()
        entity_filters = deepcopy(filters)
        entity_filters.pop("camera_id", None)
        entity_filters.pop("video_id", None)
        entity_filters.pop("run_id", None)
        entity_filters.pop("mode", None)

        historical: dict[str, list[dict[str, Any]]] = {"episodic": [], "semantic": []}

        # Episodic entity uses scalar entity_id and entity-level video_ids.
        try:
            epi_filters = deepcopy(entity_filters)
            epi_filters["entity_id"] = entity_id
            with (profiler.span("mem.semantic.history.episodic_scroll") if profiler else nullcontext()):
                raw = self.store.scroll("episodic_entity", filters=epi_filters, limit=50)
            for point in raw:
                p = point["payload"]
                video_ids = normalize_video_ids(p.get("video_ids"))
                if exclude_video_id and exclude_video_id in video_ids:
                    continue
                historical["episodic"].append(
                    {
                        "id": point["id"],
                        "content": p.get("data", {}),
                        "created_at": p.get("created_at", ""),
                        "camera_id": p.get("camera_id", ""),
                    }
                )
                if len(historical["episodic"]) >= 20:
                    break
        except Exception as exc:
            logger.error("Error getting episodic memories for entity %s: %s", entity_id, exc)

        # Semantic: entity_id exact match
        try:
            sem_filters = deepcopy(entity_filters)
            sem_filters["entity_id"] = entity_id
            with (profiler.span("mem.semantic.history.semantic_scroll") if profiler else nullcontext()):
                raw = self.store.scroll("semantic_entity", filters=sem_filters, limit=10)
            for point in raw:
                p = point["payload"]
                historical["semantic"].append(
                    {
                        "id": point["id"],
                        "content": p.get("data", ""),
                        "category": p.get("category", ""),
                        "entity_class": p.get("entity_class", ""),
                        "created_at": p.get("created_at", ""),
                    }
                )
        except Exception as exc:
            logger.error("Error getting semantic memories for entity %s: %s", entity_id, exc)

        logger.info(
            "Retrieved historical memories for entity %s: %d episodic, %d semantic "
            "(excluded video_id: %s)",
            entity_id,
            len(historical["episodic"]),
            len(historical["semantic"]),
            exclude_video_id,
        )
        return historical

    def _merge_entity_semantic_memory(
        self,
        entity_id: str,
        current_video_data: dict[str, Any],
        historical_memories: dict[str, list[dict[str, Any]]],
        metadata: dict[str, Any],
    ) -> tuple[list[dict[str, Any]], bool]:
        """LLM decision on semantic memory.

        CRITICAL: UUID mapping — replace real UUIDs with integers in prompt, map back.
        """
        temp_uuid_mapping: dict[str, str] = {}
        historical_semantic = historical_memories["semantic"]
        for idx, item in enumerate(historical_semantic):
            temp_uuid_mapping[str(idx)] = item["id"]
            historical_semantic[idx]["id"] = str(idx)
        profiler = current_profiler()

        try:
            prompt_text = build_semantic_analysis_prompt(
                entity_id,
                current_video_data,
                historical_memories["episodic"],
                historical_memories["semantic"],
            )
            with (profiler.span("mem.semantic.llm") if profiler else nullcontext()):
                response = self.llm.complete(
                    messages=[{"role": "user", "content": prompt_text}],
                    response_format={"type": "json_object"},
                )
        except Exception as exc:
            logger.error("Error in semantic pattern analysis response: %s", exc)
            response = ""

        try:
            response = remove_code_blocks(response)
            semantic_updates = json.loads(response)
        except Exception as exc:
            logger.error("Invalid JSON response in semantic analysis: %s", exc)
            semantic_updates = {}

        returned_memories: list[dict[str, Any]] = []
        has_add_or_update = False

        try:
            for resp in semantic_updates.get("semantic_memory_updates", []):
                logger.info("Processing semantic memory update: %s", resp)

                action_text = resp.get("text")
                if not action_text:
                    logger.info("Skipping empty text semantic memory entry.")
                    continue

                event_type = resp.get("event", "NONE")
                category = semantic_update_category(resp)

                if event_type == "ADD":
                    video_ids = normalize_video_ids(
                        metadata.get("video_ids"),
                        metadata.get("video_id"),
                    )
                    payload = deepcopy(metadata)
                    payload["entity_id"] = entity_id
                    payload["entity_class"] = resp.get("entity_class", "")
                    payload["category"] = category
                    payload["video_ids"] = video_ids
                    payload.pop("video_id", None)
                    importance = semantic_update_importance(resp)
                    payload["importance"] = importance

                    mem_id = self._create_memory("semantic_entity", action_text, metadata=payload)
                    returned_memories.append(
                        {
                            "id": mem_id,
                            "memory": action_text,
                            "memory_type": "semantic",
                            "event": "ADD",
                            "collection": self.store.collection_name("semantic_entity"),
                            "entity_id": entity_id,
                            "entity_class": resp.get("entity_class", ""),
                            "category": category,
                            "categories": category,
                            "video_ids": video_ids,
                            "importance": importance,
                        }
                    )
                    has_add_or_update = True

                elif event_type == "UPDATE":
                    memory_id = resp.get("id")
                    if memory_id and memory_id in temp_uuid_mapping:
                        real_id = temp_uuid_mapping[memory_id]

                        # Identity protection: skip LLM UPDATE on identity memories
                        try:
                            old_point = self.store.get("semantic_entity", real_id)
                            if old_point and old_point["payload"].get("category") == "identity":
                                logger.info(
                                    "Skipping UPDATE on identity memory %s (protected).", memory_id
                                )
                                continue
                            old_importance = (
                                old_point["payload"].get("importance", 0.5)
                                if old_point
                                else 0.5
                            )
                        except Exception:
                            old_importance = 0.5

                        video_ids = normalize_video_ids(
                            metadata.get("video_ids"),
                            metadata.get("video_id"),
                        )
                        payload = deepcopy(metadata)
                        payload["entity_id"] = entity_id
                        payload["entity_class"] = resp.get("entity_class", "")
                        payload["category"] = category
                        payload["video_ids"] = video_ids
                        payload.pop("video_id", None)

                        importance = compute_importance(old_importance)
                        payload["importance"] = importance

                        self._update_memory(
                            "semantic_entity", real_id, action_text, metadata=payload
                        )
                        returned_memories.append(
                            {
                                "id": real_id,
                                "memory": action_text,
                                "memory_type": "semantic",
                                "event": "UPDATE",
                                "collection": self.store.collection_name("semantic_entity"),
                                "entity_id": entity_id,
                                "entity_class": resp.get("entity_class", ""),
                                "category": category,
                                "categories": category,
                                "video_ids": video_ids,
                                "importance": importance,
                            }
                        )
                        has_add_or_update = True

                elif event_type == "DELETE":
                    memory_id = resp.get("id")
                    if memory_id and memory_id in temp_uuid_mapping:
                        real_id = temp_uuid_mapping[memory_id]

                        # Identity protection: skip LLM DELETE on identity memories
                        try:
                            check = self.store.get("semantic_entity", real_id)
                            if check and check["payload"].get("category") == "identity":
                                logger.info(
                                    "Skipping DELETE on identity memory %s (protected).", memory_id
                                )
                                continue
                        except Exception as exc:
                            logger.warning(
                                "Could not verify category for deletion candidate %s: %s",
                                memory_id, exc,
                            )

                        existing_payload = self._delete_memory("semantic_entity", real_id)
                        returned_memories.append(
                            {
                                "id": real_id,
                                "memory": existing_payload.get("data") if existing_payload else "",
                                "memory_type": "semantic",
                                "event": "DELETE",
                                "collection": self.store.collection_name("semantic_entity"),
                                "entity_id": entity_id,
                                "entity_class": (
                                    existing_payload.get("entity_class", "")
                                    if existing_payload
                                    else ""
                                ),
                                "category": (
                                    existing_payload.get("category", existing_payload.get("categories", ""))
                                    if existing_payload
                                    else ""
                                ),
                                "categories": (
                                    existing_payload.get("category", existing_payload.get("categories", ""))
                                    if existing_payload
                                    else ""
                                ),
                                "video_ids": (
                                    existing_payload.get("video_ids", [])
                                    if existing_payload
                                    else []
                                ),
                            }
                        )

                elif event_type == "NONE":
                    logger.info("No semantic memory changes needed.")

        except Exception as exc:
            logger.error(
                "Error processing semantic memory updates for entity %s: %s", entity_id, exc
            )

        return returned_memories, has_add_or_update

    def _entity_semantic_visual_embed(
        self,
        entity_item: dict[str, Any],
        entity_id: str,
        metadata: dict[str, Any],
    ) -> list[dict[str, Any]]:
        """Store face/body embeddings for the entity."""
        embed_data = entity_item.get("embed", {})
        if not embed_data:
            return []

        returned_memories: list[dict[str, Any]] = []

        for embed_key, embed_value in embed_data.items():
            suffix = f"semantic_{embed_key}"
            if suffix not in COLLECTION_SPECS:
                logger.warning("Collection suffix %s not found, skipping.", suffix)
                continue

            try:
                embed_vector = np.frombuffer(
                    base64.b64decode(embed_value), dtype=np.float32
                ).tolist()
                payload = deepcopy(metadata)
                payload["entity_id"] = entity_id
                if "class_name" in entity_item:
                    payload["entity_class"] = entity_item["class_name"]
                payload["video_ids"] = normalize_video_ids(
                    metadata.get("video_ids"),
                    metadata.get("video_id"),
                )
                payload.pop("video_id", None)

                embed_mem_id = self._create_memory(
                    suffix, "", embedding=embed_vector, metadata=payload
                )
                returned_memories.append(
                    {
                        "id": embed_mem_id,
                        "memory": "",
                        "event": "ADD",
                        "collection": self.store.collection_name(suffix),
                        "entity_id": entity_id,
                        "embed_type": embed_key,
                    }
                )
                logger.info(
                    "Stored %s embed for entity %s in %s",
                    embed_key, entity_id, suffix,
                )
            except Exception as exc:
                logger.error(
                    "Error processing %s embed for entity %s: %s", embed_key, entity_id, exc
                )
                raise

        return returned_memories

    # ------------------------------------------------------------------ #
    # Internal: Procedural                                                #
    # ------------------------------------------------------------------ #

    def _create_procedural_memory(
        self,
        messages: list[dict[str, str]],
        metadata: dict[str, Any] | None = None,
        prompt: str | None = None,
    ) -> dict[str, Any]:
        """Create a procedural memory."""
        if metadata is None:
            raise ValueError("Metadata cannot be None for procedural memory.")

        logger.info("Creating procedural memory")

        if metadata.get("camera_id"):
            procedural_memory = messages[0].get("content", "")
        else:
            parsed_messages = [
                {"role": "system", "content": prompt or PROCEDURAL_MEMORY_SYSTEM_PROMPT},
                *messages,
                {
                    "role": "user",
                    "content": "Create procedural memory of the above conversation.",
                },
            ]
            procedural_memory = self.llm.complete(messages=parsed_messages)

        embedding = self.embedder.embed(procedural_memory)
        mem_id = self._create_memory(
            "procedural",
            procedural_memory,
            embedding=embedding,
            metadata=metadata,
        )
        return {"results": [{"id": mem_id, "memory": procedural_memory, "event": "ADD"}]}

    # ------------------------------------------------------------------ #
    # Episodic Schema + Semantic Context (new write paths)                #
    # ------------------------------------------------------------------ #

    def add_episodic_schema(
        self,
        *,
        summary: str,
        event_ids: list[str],
        time_range: dict[str, int],
        camera_id: str,
        user_id: str = "default",
    ) -> dict[str, Any]:
        """Store a chapter-level narrative summary in episodic_schema."""
        embedding = self.embedder.embed(summary)
        now = utc_now_iso()
        payload = {
            "data": summary,
            "camera_id": camera_id,
            "user_id": user_id,
            "event_ids": event_ids,
            "time_range_start_ms": time_range["start_ms"],
            "time_range_end_ms": time_range["end_ms"],
            "created_at": now,
            "updated_at": now,
        }
        point_id = str(uuid.uuid4())
        self.store.upsert("episodic_schema", point_id, embedding, payload)
        return {"id": point_id, "collection": "episodic_schema", "event": "ADD"}

    def upsert_semantic_context(
        self,
        *,
        camera_id: str,
        scene_description: str,
        known_entities: str,
        daily_routine: str,
        anomaly_baseline: str,
        user_notes: str = "",
        user_id: str = "default",
        last_llm_update: str | None = None,
        last_update_segment_count: int | None = None,
        last_agent_consult: str | None = None,
        last_consult_segment_count: int | None = None,
        consecutive_no_updates: int | None = None,
    ) -> dict[str, Any]:
        """Upsert camera-level context. One record per camera, deterministic ID."""
        from uuid import uuid5, NAMESPACE_URL

        combined = " ".join(filter(None, [
            scene_description, known_entities, daily_routine, anomaly_baseline,
        ]))
        embedding = self.embedder.embed(combined)
        point_id = str(uuid5(NAMESPACE_URL, f"semantic_context:{user_id}:{camera_id}"))

        # Preserve original created_at on update
        existing_created_at = None
        try:
            existing = self.store.get("semantic_context", point_id)
            if existing:
                existing_created_at = existing["payload"].get("created_at")
        except Exception:
            pass

        now = utc_now_iso()
        payload: dict[str, Any] = {
            "data": combined,
            "camera_id": camera_id,
            "user_id": user_id,
            "category": "semantic_context",
            "scene_description": scene_description,
            "known_entities": known_entities,
            "daily_routine": daily_routine,
            "anomaly_baseline": anomaly_baseline,
            "user_notes": user_notes,
            "created_at": existing_created_at or now,
            "updated_at": now,
        }
        # Semantic context state fields (omitted when None to avoid polluting legacy payloads)
        if last_llm_update is not None:
            payload["last_llm_update"] = last_llm_update
        if last_update_segment_count is not None:
            payload["last_update_segment_count"] = last_update_segment_count
        if last_agent_consult is not None:
            payload["last_agent_consult"] = last_agent_consult
        if last_consult_segment_count is not None:
            payload["last_consult_segment_count"] = last_consult_segment_count
        if consecutive_no_updates is not None:
            payload["consecutive_no_updates"] = consecutive_no_updates
        self.store.upsert("semantic_context", point_id, embedding, payload)
        return {"id": point_id, "collection": "semantic_context", "event": "UPSERT"}

    # ------------------------------------------------------------------ #
    # Internal: Vector Store Operations                                   #
    # ------------------------------------------------------------------ #

    def _create_memory(
        self,
        collection_suffix: str,
        data: str,
        embedding: list[float] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        """Create a point. Compute embedding if not provided. Set hash, timestamps. Write history."""
        logger.debug("Creating memory with data=%s", data[:100] if data else "")
        profiler = current_profiler()

        if embedding is None:
            with (profiler.span("mem.embed.total") if profiler else nullcontext()):
                embedding = self.embedder.embed(data)

        memory_id = str(uuid.uuid4())
        payload = deepcopy(metadata) if metadata else {}
        payload["data"] = data
        payload["hash"] = hashlib.md5(data.encode()).hexdigest()

        now = datetime.now(timezone.utc).isoformat()
        payload["created_at"] = now
        payload["updated_at"] = now

        with (profiler.span(f"mem.qdrant.insert.{collection_suffix}") if profiler else nullcontext()):
            self.store.insert(collection_suffix, embedding, payload, point_id=memory_id)

        with (profiler.span("mem.history.add") if profiler else nullcontext()):
            self.history.add_history(
                memory_id, None, data, "ADD",
                created_at=payload.get("created_at"),
                actor_id=payload.get("actor_id"),
                role=payload.get("role"),
            )
        logger.info("Created memory %s in %s", memory_id, collection_suffix)
        return memory_id

    def _update_memory(
        self,
        collection_suffix: str,
        memory_id: str,
        data: str,
        embedding: list[float] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        """Update point. Preserve created_at, merge session IDs from existing payload.

        CRITICAL: Merge video_ids (append new, no duplicates). Write history.
        """
        logger.info("Updating memory %s with data=%s", memory_id, data[:100] if data else "")
        profiler = current_profiler()

        with (profiler.span(f"mem.qdrant.get.{collection_suffix}") if profiler else nullcontext()):
            existing = self.store.get(collection_suffix, memory_id)
        if existing is None:
            raise ValueError(f"Memory with ID {memory_id} not found in {collection_suffix}")

        existing_payload = existing["payload"]
        prev_value = existing_payload.get("data")

        new_payload = deepcopy(metadata) if metadata else {}
        new_payload["data"] = data
        new_payload["hash"] = hashlib.md5(data.encode()).hexdigest()
        new_payload["created_at"] = existing_payload.get("created_at")
        new_payload["updated_at"] = datetime.now(timezone.utc).isoformat()

        # Merge session IDs from existing payload
        for key in ("user_id", "agent_id", "run_id", "video_id", "actor_id",
                     "entity_id", "entity_ids", "camera_id", "role"):
            if key in existing_payload:
                new_payload[key] = existing_payload[key]

        # Merge video_ids: append new, no duplicates
        if "video_ids" in existing_payload:
            prev_video_ids = existing_payload.get("video_ids", [])
            current_video_ids = metadata.get("video_ids", []) if metadata else []
            new_payload["video_ids"] = prev_video_ids + [
                vid for vid in current_video_ids if vid not in prev_video_ids
            ]

        if embedding is None:
            with (profiler.span("mem.embed.total") if profiler else nullcontext()):
                embedding = self.embedder.embed(data)

        with (profiler.span(f"mem.qdrant.update.{collection_suffix}") if profiler else nullcontext()):
            self.store.update(collection_suffix, memory_id, embedding, new_payload)

        with (profiler.span("mem.history.add") if profiler else nullcontext()):
            self.history.add_history(
                memory_id, prev_value, data, "UPDATE",
                created_at=new_payload.get("created_at"),
                updated_at=new_payload.get("updated_at"),
                actor_id=new_payload.get("actor_id"),
                role=new_payload.get("role"),
            )
        return memory_id

    def _delete_memory(
        self, collection_suffix: str, memory_id: str
    ) -> dict[str, Any] | None:
        """Delete point. Write history with is_deleted=1. Return existing payload."""
        logger.info("Deleting memory %s from %s", memory_id, collection_suffix)
        profiler = current_profiler()

        with (profiler.span(f"mem.qdrant.get.{collection_suffix}") if profiler else nullcontext()):
            existing = self.store.get(collection_suffix, memory_id)
        if existing is None:
            raise ValueError(f"Memory with ID {memory_id} not found in {collection_suffix}")

        prev_value = existing["payload"].get("data")
        with (profiler.span(f"mem.qdrant.delete.{collection_suffix}") if profiler else nullcontext()):
            self.store.delete(collection_suffix, memory_id)

        with (profiler.span("mem.history.add") if profiler else nullcontext()):
            self.history.add_history(
                memory_id, prev_value, None, "DELETE", is_deleted=1,
                actor_id=existing["payload"].get("actor_id"),
                role=existing["payload"].get("role"),
            )
        return existing["payload"]

    def _adjust_filters_for_collection(
        self, suffix: str, filters: dict[str, Any]
    ) -> dict[str, Any]:
        """Delegate to module-level _adjust_filters."""
        return _adjust_filters(suffix, filters)


# ---------------------------------------------------------------------------
# AsyncMemoryManager
# ---------------------------------------------------------------------------


class AsyncMemoryManager:
    """Independent async memory manager. Uses asyncio.gather for concurrency."""

    def __init__(
        self,
        store: QdrantStore,
        llm: LLMClient,
        embedder: Embedder,
        reid: ReidManager,
        history: HistoryStore,
        config: MemConfig,
        on_background_memory_result: MemoryResultCallback | None = None,
        on_runtime_health: RuntimeHealthCallback | None = None,
    ) -> None:
        self.store = store
        self.llm = llm
        self.embedder = embedder
        self.reid = reid
        self.history = history
        self.config = config
        self.on_background_memory_result = on_background_memory_result
        self.on_runtime_health = on_runtime_health
        self._semantic_background_semaphore = asyncio.Semaphore(SEMANTIC_BACKGROUND_CONCURRENCY)
        self._semantic_background_tasks: set[asyncio.Task[None]] = set()
        self._semantic_entity_locks: dict[str, asyncio.Lock] = {}
        self._semantic_entity_locks_guard = asyncio.Lock()

    # ------------------------------------------------------------------ #
    # Async I/O wrappers                                                  #
    # ------------------------------------------------------------------ #

    async def _embed(self, text: str) -> list[float]:
        profiler = current_profiler()
        with (profiler.span("mem.embed.total") if profiler else nullcontext()):
            return await asyncio.to_thread(self.embedder.embed, text)

    async def _llm_complete(
        self,
        messages: list[dict[str, str]],
        response_format: dict[str, str] | None = None,
    ) -> str:
        profiler = current_profiler()
        with (profiler.span("mem.semantic.llm") if profiler else nullcontext()):
            return await asyncio.to_thread(self.llm.complete, messages, response_format)

    async def _store_insert(
        self,
        suffix: str,
        vector: list[float],
        payload: dict[str, Any],
        point_id: str | None = None,
    ) -> str:
        profiler = current_profiler()
        with (profiler.span(f"mem.qdrant.insert.{suffix}") if profiler else nullcontext()):
            return await asyncio.to_thread(
                self.store.insert, suffix, vector, payload, point_id
            )

    async def _store_search(
        self,
        suffix: str,
        vector: list[float],
        filters: dict[str, Any] | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        profiler = current_profiler()
        with (profiler.span(f"mem.qdrant.search.{suffix}") if profiler else nullcontext()):
            return await asyncio.to_thread(self.store.search, suffix, vector, filters, limit)

    async def _store_scroll(
        self,
        suffix: str,
        filters: dict[str, Any] | None = None,
        limit: int = 100,
        order_by: str | OrderBy | None = None,
    ) -> list[dict[str, Any]]:
        profiler = current_profiler()
        with (profiler.span(f"mem.qdrant.scroll.{suffix}") if profiler else nullcontext()):
            return await asyncio.to_thread(self.store.scroll, suffix, filters, limit, order_by)

    async def _store_get(
        self, suffix: str, point_id: str
    ) -> dict[str, Any] | None:
        profiler = current_profiler()
        with (profiler.span(f"mem.qdrant.get.{suffix}") if profiler else nullcontext()):
            return await asyncio.to_thread(self.store.get, suffix, point_id)

    async def _store_update(
        self,
        suffix: str,
        point_id: str,
        vector: list[float] | None,
        payload: dict[str, Any],
    ) -> None:
        profiler = current_profiler()
        with (profiler.span(f"mem.qdrant.update.{suffix}") if profiler else nullcontext()):
            return await asyncio.to_thread(
                self.store.update, suffix, point_id, vector, payload
            )

    async def _store_delete(
        self, suffix: str, point_id: str
    ) -> dict[str, Any] | None:
        profiler = current_profiler()
        with (profiler.span(f"mem.qdrant.delete.{suffix}") if profiler else nullcontext()):
            return await asyncio.to_thread(self.store.delete, suffix, point_id)

    async def _store_set_payload(
        self, suffix: str, point_id: str, payload: dict[str, Any]
    ) -> None:
        profiler = current_profiler()
        with (profiler.span(f"mem.qdrant.set_payload.{suffix}") if profiler else nullcontext()):
            return await asyncio.to_thread(
                self.store.set_payload, suffix, point_id, payload
            )

    async def _store_upsert(
        self, collection: str, point_id: str, vector: list[float], payload: dict[str, Any]
    ) -> None:
        """Async wrapper for store.upsert."""
        profiler = current_profiler()
        with (profiler.span(f"mem.qdrant.upsert.{collection}") if profiler else nullcontext()):
            await asyncio.to_thread(self.store.upsert, collection, point_id, vector, payload)

    # ------------------------------------------------------------------ #
    # Public API                                                          #
    # ------------------------------------------------------------------ #

    async def add_memory(
        self,
        video_data: dict[str, Any] | None = None,
        entity_data: list[dict[str, Any]] | None = None,
        messages: Any = None,
        *,
        user_id: str | None = None,
        agent_id: str | None = None,
        run_id: str | None = None,
        video_id: str | None = None,
        camera_id: str | None = None,
        metadata: dict[str, Any] | None = None,
        infer: bool = True,
        memory_type: str | None = None,
        prompt: str | None = None,
        semantic_mode: str = SEMANTIC_MODE_INLINE,
        mode: str | None = None,
        event_id: str | None = None,
    ) -> dict[str, Any]:
        """Main entry point for creating memories (async)."""
        profiler, token = start_memory_profile("mem.add", {
            "memory_type": memory_type or "default",
            "infer": bool(infer),
            "camera_id": camera_id,
            "video_id": video_id,
        })
        try:
            response = await self._add_memory_impl(
                video_data=video_data,
                entity_data=entity_data,
                messages=messages,
                user_id=user_id,
                agent_id=agent_id,
                run_id=run_id,
                video_id=video_id,
                camera_id=camera_id,
                metadata=metadata,
                infer=infer,
                memory_type=memory_type,
                prompt=prompt,
                semantic_mode=semantic_mode,
                mode=mode,
                event_id=event_id,
            )
            return attach_profile(response, profiler)
        finally:
            reset_memory_profile(token)

    async def _add_memory_impl(
        self,
        video_data: dict[str, Any] | None = None,
        entity_data: list[dict[str, Any]] | None = None,
        messages: Any = None,
        *,
        user_id: str | None = None,
        agent_id: str | None = None,
        run_id: str | None = None,
        video_id: str | None = None,
        camera_id: str | None = None,
        metadata: dict[str, Any] | None = None,
        infer: bool = True,
        memory_type: str | None = None,
        prompt: str | None = None,
        semantic_mode: str = SEMANTIC_MODE_INLINE,
        mode: str | None = None,
        event_id: str | None = None,
    ) -> dict[str, Any]:
        processed_metadata = build_metadata(
            user_id=user_id,
            agent_id=agent_id,
            run_id=run_id,
            video_id=video_id,
            camera_id=camera_id,
            input_metadata=metadata,
        )
        effective_filters = build_filters(
            user_id=user_id,
            agent_id=agent_id,
            run_id=run_id,
            video_id=video_id,
            camera_id=camera_id,
        )

        if mode is not None:
            processed_metadata["mode"] = mode
            effective_filters["mode"] = mode
        if event_id is not None:
            processed_metadata["event_id"] = event_id

        if video_data:
            media_urls = video_data.get("media_urls")
            if media_urls:
                processed_metadata["media_urls"] = media_urls

        # -- Branch on memory_type --
        if memory_type is not None:
            if memory_type == "procedural":
                if isinstance(messages, str):
                    messages = [{"role": "user", "content": messages}]
                elif isinstance(messages, dict):
                    messages = [messages]
                elif not isinstance(messages, list):
                    raise ValueError("messages must be str, dict, or list[dict]")
                if video_data is not None or entity_data is not None:
                    raise ValueError(
                        "For procedural memory type, 'video_data' and 'entity_data' "
                        "must be None. Only 'messages' should be provided."
                    )
                if camera_id is None and agent_id is None:
                    raise ValueError(
                        "For procedural memory type, 'camera_id' or 'agent_id' must be provided."
                    )
                return await self._create_procedural_memory(
                    messages, metadata=processed_metadata, prompt=prompt
                )

            elif memory_type in ("semantic", "semantic_entity"):
                if entity_data is None or len(entity_data) == 0:
                    raise ValueError("For semantic memory type, 'entity_data' must be provided.")
                entity_id_val = entity_data[0].get("entity_id")
                entity_message = entity_data[0].get("message")
                if not entity_id_val or not entity_message:
                    raise ValueError(
                        "For semantic memory type, 'entity_id' and 'message' must be provided."
                    )

                payload = deepcopy(processed_metadata)
                payload["entity_id"] = entity_id_val
                payload["entity_class"] = entity_data[0].get("class_name", "")

                category = entity_data[0].get("category", "user_added")
                payload["category"] = category
                importance = 1.0 if category == "identity" else entity_data[0].get("importance", 0.5)
                payload["importance"] = importance

                payload["video_ids"] = normalize_video_ids(
                    entity_data[0].get("video_ids"),
                    processed_metadata.get("video_ids"),
                    processed_metadata.get("video_id"),
                )
                payload.pop("video_id", None)

                mem_id = await self._create_memory("semantic_entity", entity_message, metadata=payload)
                return {
                    "results": [
                        {
                            "id": mem_id,
                            "memory": entity_message,
                            "event": "ADD",
                            "collection": self.store.collection_name("semantic_entity"),
                            "entity_id": entity_id_val,
                            "entity_class": payload["entity_class"],
                            "category": category,
                            "importance": importance,
                        }
                    ]
                }
            else:
                raise ValueError(
                    "Invalid 'memory_type'. Default creates episodic and semantic memories. "
                    "'procedural', 'semantic', or 'semantic_entity' can be passed explicitly."
                )

        if video_data is None and entity_data is None:
            raise ValueError(
                "When 'memory_type' is not specified, at least one of "
                "'video_data' or 'entity_data' must be provided."
            )
        video_data = video_data or {}
        entity_data = entity_data or []

        vector_store_result = await self._add_to_vector_store(
            video_data, entity_data, processed_metadata, effective_filters, infer, semantic_mode
        )
        return {"results": vector_store_result, "relations": []}

    async def search_memories(
        self,
        query: str,
        *,
        user_id: str | None = None,
        agent_id: str | None = None,
        run_id: str | None = None,
        video_id: str | None = None,
        entity_id: str | None = None,
        camera_id: str | None = None,
        mode: str | None = None,
        memory_type: str | None = None,
        limit: int = 100,
        threshold: float | None = None,
        filters: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Search across text collections with gather concurrency."""
        effective_filters = build_filters(
            user_id=user_id,
            agent_id=agent_id,
            run_id=run_id,
            video_id=video_id,
            entity_id=entity_id,
            camera_id=camera_id,
            mode=mode,
            input_filters=filters,
        )

        collections = get_collections(memory_type, allow_visual=False)
        embedding = await self._embed(query)

        async def _search_one(suffix: str) -> tuple[str, list[dict[str, Any]]]:
            adjusted = _adjust_filters(suffix, effective_filters)
            raw = await self._store_search(suffix, embedding, filters=adjusted, limit=limit)
            formatted: list[dict[str, Any]] = []
            for hit in raw:
                mem_dict = format_memory_result(hit["id"], hit["payload"])
                mem_dict["score"] = hit["score"]
                if threshold is None or hit["score"] >= threshold:
                    formatted.append(mem_dict)
            return self.store.collection_name(suffix), formatted

        tasks = [_search_one(s) for s in collections]
        results_list = await asyncio.gather(*tasks, return_exceptions=True)

        results: dict[str, Any] = {}
        for r in results_list:
            if isinstance(r, Exception):
                logger.error("Error searching collection: %s", r)
                continue
            full_name, hits = r
            if hits:
                results[full_name] = hits
        return results

    async def get_all_memories(
        self,
        *,
        user_id: str | None = None,
        agent_id: str | None = None,
        run_id: str | None = None,
        video_id: str | None = None,
        entity_id: str | None = None,
        camera_id: str | None = None,
        memory_type: str | None = None,
        limit: int = 100,
        filters: dict[str, Any] | None = None,
        sort_order: str | None = None,
    ) -> dict[str, Any]:
        """List memories with gather concurrency."""
        effective_filters = build_filters(
            user_id=user_id,
            agent_id=agent_id,
            run_id=run_id,
            video_id=video_id,
            entity_id=entity_id,
            camera_id=camera_id,
            input_filters=filters,
        )
        collections = get_collections(memory_type, allow_visual=True)
        logger.info(
            "get_all_memories: memory_type=%s camera_id=%s collections=%s filters=%s",
            memory_type, camera_id, collections, effective_filters,
        )

        async def _list_one(suffix: str) -> tuple[str, list[dict[str, Any]]]:
            adjusted = _adjust_filters(suffix, effective_filters)
            sort_field = _sort_key_for_collection(suffix)
            if sort_order == "asc":
                order_by_field = OrderBy(key=sort_field, direction=Direction.ASC)
            elif sort_order == "desc" or sort_order is None:
                order_by_field = OrderBy(key=sort_field, direction=Direction.DESC)
            else:
                order_by_field = None
            raw = await self._store_scroll(suffix, filters=adjusted, limit=limit, order_by=order_by_field)
            logger.info(
                "get_all_memories._list_one: suffix=%s adjusted=%s raw_count=%d first_payload=%s",
                suffix, adjusted, len(raw),
                {k: v for k, v in raw[0]["payload"].items() if k in ("camera_id", "run_id", "event_id")} if raw else "EMPTY",
            )
            formatted: list[dict[str, Any]] = []
            for point in raw:
                mem_dict = format_memory_result(point["id"], point["payload"])
                # Promote importance to top level for get_all (matches old service)
                importance = point["payload"].get("importance", 0.5)
                mem_dict["importance"] = importance
                formatted.append(mem_dict)
            if "semantic" in suffix:
                formatted.sort(key=lambda x: x.get("importance", 0.5), reverse=True)
            return self.store.collection_name(suffix), formatted

        tasks = [_list_one(s) for s in collections]
        results_list = await asyncio.gather(*tasks, return_exceptions=True)

        results: dict[str, Any] = {}
        for r in results_list:
            if isinstance(r, Exception):
                logger.error("Error listing collection: %s", r)
                continue
            full_name, mems = r
            if mems:
                results[full_name] = mems
        return results

    async def get_memory(
        self,
        memory_id: str,
        memory_type: str | None = None,
        return_all_matches: bool = False,
    ) -> dict[str, Any] | None:
        """Get single memory by ID."""
        collections = get_collections(memory_type)

        async def _fetch(suffix: str) -> tuple[str, dict[str, Any] | None]:
            point = await self._store_get(suffix, memory_id)
            if point:
                return self.store.collection_name(suffix), format_memory_result(
                    point["id"], point["payload"]
                )
            return self.store.collection_name(suffix), None

        tasks = [_fetch(s) for s in collections]
        results_list = await asyncio.gather(*tasks, return_exceptions=True)

        matches: dict[str, Any] = {}
        for r in results_list:
            if isinstance(r, Exception):
                continue
            full_name, result = r
            if result:
                matches[full_name] = result
                if not return_all_matches:
                    return {full_name: result}
        return matches if matches else None

    async def update_memory(
        self,
        memory_id: str,
        data: str,
        memory_type: str | None = None,
        data_type: str = "txt",
    ) -> dict[str, Any]:
        """Update memory. Reject episodic."""
        collections = get_collections(memory_type)

        if memory_type and "episodic" in memory_type:
            raise ValueError("Episodic memories are immutable and cannot be updated.")

        if data_type == "txt":
            embedding = await self._embed(data)
            update_data = data
        else:
            embedding = np.frombuffer(base64.b64decode(data), dtype=np.float32).tolist()
            update_data = ""

        for suffix in collections:
            if "episodic" in suffix:
                continue
            try:
                await self._update_memory(suffix, memory_id, update_data, embedding=embedding)
                return {
                    "message": f"{self.store.collection_name(suffix)} memory updated successfully!"
                }
            except ValueError:
                continue

        raise ValueError(f"Memory with ID {memory_id} not found in any collection.")

    async def delete_memory(
        self,
        memory_id: str,
        memory_type: str | None = None,
        data_type: str = "txt",
    ) -> dict[str, Any]:
        """Delete single memory."""
        collections = get_collections(memory_type)

        for suffix in collections:
            point = await self._store_get(suffix, memory_id)
            if point:
                await self._delete_memory(suffix, memory_id)
                return {
                    "message": f"{self.store.collection_name(suffix)} memory deleted successfully!",
                    "deleted_memory": {
                        "id": memory_id,
                        "memory": point["payload"].get("data"),
                    },
                }

        raise ValueError(f"Memory with ID {memory_id} not found in any collection.")

    async def delete_all_memories(
        self,
        *,
        user_id: str | None = None,
        agent_id: str | None = None,
        run_id: str | None = None,
        video_id: str | None = None,
        entity_id: str | None = None,
        camera_id: str | None = None,
        memory_type: str | None = None,
        data_type: str | None = None,
    ) -> dict[str, Any]:
        """Batch delete with filters and gather concurrency."""
        effective_filters = build_filters(
            user_id=user_id,
            agent_id=agent_id,
            run_id=run_id,
            video_id=video_id,
            entity_id=entity_id,
            camera_id=camera_id,
        )
        if not effective_filters:
            raise ValueError(
                "At least one filter is required. Use reset() to delete everything."
            )

        collections = get_collections(memory_type)
        total_deleted = 0
        deleted_counts: dict[str, int] = {
            self.store.collection_name(s): 0 for s in collections
        }

        for suffix in collections:
            full_name = self.store.collection_name(suffix)
            adjusted = _adjust_filters(suffix, effective_filters)
            while True:
                points = await self._store_scroll(suffix, filters=adjusted, limit=1000)
                if not points:
                    break

                delete_tasks = [self._delete_memory(suffix, p["id"]) for p in points]
                results = await asyncio.gather(*delete_tasks, return_exceptions=True)

                batch_deleted = 0
                for r in results:
                    if not isinstance(r, Exception):
                        batch_deleted += 1
                        deleted_counts[full_name] += 1
                        total_deleted += 1

                if batch_deleted == 0:
                    break

        if total_deleted == 0:
            return {
                "message": "No memories found to delete!",
                "total_deleted": 0,
                "deleted_by_type": deleted_counts,
            }
        return {
            "message": "Memories deleted successfully!",
            "total_deleted": total_deleted,
            "deleted_by_type": deleted_counts,
        }

    async def get_history(self, memory_id: str) -> list[dict[str, Any]]:
        """Get change history for a memory."""
        return await asyncio.to_thread(self.history.get_history, memory_id)

    async def expire_media(
        self, segment_id: str, camera_id: str | None = None
    ) -> dict[str, Any]:
        """Set media_urls=None for episodic memories matching video_id=segment_id."""
        filters_dict: dict[str, Any] = {"video_id": segment_id}
        if camera_id:
            filters_dict["camera_id"] = camera_id

        points = await self._store_scroll("episodic_trace", filters=filters_dict, limit=1000)

        async def _expire_one(point: dict[str, Any]) -> bool:
            await self._store_set_payload(
                "episodic_trace",
                point["id"],
                {
                    "media_urls": None,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                },
            )
            return True

        tasks = [_expire_one(p) for p in points]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        updated_count = sum(1 for r in results if r is True)

        logger.info(
            "expire_media: nullified media_urls for %d/%d records, segment_id=%s",
            updated_count, len(points), segment_id,
        )
        return {
            "segment_id": segment_id,
            "updated_count": updated_count,
            "status": "ok",
        }

    async def set_identity(
        self, entity_id: str, identity: str, status: str = "familiar",
        user_id: str | None = None, camera_id: str | None = None,
    ) -> dict[str, Any]:
        """Create or update an identity memory for a scoped entity."""
        identity_filters = {"entity_id": entity_id, "category": "identity"}
        if user_id:
            identity_filters["user_id"] = user_id

        existing = await self._store_scroll(
            "semantic_entity",
            filters=identity_filters,
            limit=1,
        )

        text = f"{identity} (status: {status})"
        payload: dict[str, Any] = {
            "entity_id": entity_id,
            "category": "identity",
            "importance": 1.0,
            "identity_status": status,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        if user_id:
            payload["user_id"] = user_id
        if camera_id:
            payload["camera_id"] = camera_id

        if existing:
            mem_id = existing[0]["id"]
            await self._update_memory("semantic_entity", mem_id, text, metadata=payload)
            logger.info(
                "Updated identity for entity %s user=%s: %s (%s)",
                entity_id, user_id, identity, status,
            )
            return {
                "entity_id": entity_id,
                "user_id": user_id,
                "memory_id": mem_id,
                "event": "UPDATE",
                "identity": text,
            }

        mem_id = await self._create_memory("semantic_entity", text, metadata=payload)
        logger.info(
            "Created identity for entity %s user=%s: %s (%s)",
            entity_id, user_id, identity, status,
        )
        return {
            "entity_id": entity_id,
            "user_id": user_id,
            "memory_id": mem_id,
            "event": "ADD",
            "identity": text,
        }

    async def reset(self) -> None:
        """Delete and recreate all collections, reset history."""
        logger.warning("Resetting all ReflectWorld memory stores (async)")
        for suffix in COLLECTION_SPECS:
            try:
                await asyncio.to_thread(self.store.delete_collection, suffix)
            except Exception as exc:
                logger.error("Error deleting collection %s: %s", suffix, exc)
        await asyncio.to_thread(self.store._ensure_collections)
        await asyncio.to_thread(self.store._ensure_payload_indexes)
        await asyncio.to_thread(self.history.reset)

    async def aclose(self, timeout_sec: float = 5.0) -> None:
        """Drain or cancel background semantic tasks before service shutdown."""
        tasks = list(self._semantic_background_tasks)
        if not tasks:
            return
        done, pending = await asyncio.wait(tasks, timeout=timeout_sec)
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        logger.info(
            "Closed async memory manager background tasks: completed=%d cancelled=%d",
            len(done),
            len(pending),
        )

    # ------------------------------------------------------------------ #
    # Episodic Schema + Semantic Context (new write paths, async)          #
    # ------------------------------------------------------------------ #

    async def add_episodic_schema(
        self,
        *,
        summary: str,
        event_ids: list[str],
        time_range: dict[str, int],
        camera_id: str,
        user_id: str = "default",
    ) -> dict[str, Any]:
        """Store a chapter-level narrative summary in episodic_schema (async)."""
        embedding = await self._embed(summary)
        now = utc_now_iso()
        payload = {
            "data": summary,
            "camera_id": camera_id,
            "user_id": user_id,
            "event_ids": event_ids,
            "time_range_start_ms": time_range["start_ms"],
            "time_range_end_ms": time_range["end_ms"],
            "created_at": now,
            "updated_at": now,
        }
        point_id = str(uuid.uuid4())
        await self._store_upsert("episodic_schema", point_id, embedding, payload)
        return {"id": point_id, "collection": "episodic_schema", "event": "ADD"}

    async def upsert_semantic_context(
        self,
        *,
        camera_id: str,
        scene_description: str,
        known_entities: str,
        daily_routine: str,
        anomaly_baseline: str,
        user_notes: str = "",
        user_id: str = "default",
        last_llm_update: str | None = None,
        last_update_segment_count: int | None = None,
        last_agent_consult: str | None = None,
        last_consult_segment_count: int | None = None,
        consecutive_no_updates: int | None = None,
    ) -> dict[str, Any]:
        """Upsert camera-level context. One record per camera, deterministic ID (async)."""
        from uuid import uuid5, NAMESPACE_URL

        combined = " ".join(filter(None, [
            scene_description, known_entities, daily_routine, anomaly_baseline,
        ]))
        embedding = await self._embed(combined)
        point_id = str(uuid5(NAMESPACE_URL, f"semantic_context:{user_id}:{camera_id}"))

        # Preserve original created_at on update
        existing_created_at = None
        try:
            existing = await self._store_get("semantic_context", point_id)
            if existing:
                existing_created_at = existing["payload"].get("created_at")
        except Exception:
            pass

        now = utc_now_iso()
        payload: dict[str, Any] = {
            "data": combined,
            "camera_id": camera_id,
            "user_id": user_id,
            "category": "semantic_context",
            "scene_description": scene_description,
            "known_entities": known_entities,
            "daily_routine": daily_routine,
            "anomaly_baseline": anomaly_baseline,
            "user_notes": user_notes,
            "created_at": existing_created_at or now,
            "updated_at": now,
        }
        # Semantic context state fields (omitted when None to avoid polluting legacy payloads)
        if last_llm_update is not None:
            payload["last_llm_update"] = last_llm_update
        if last_update_segment_count is not None:
            payload["last_update_segment_count"] = last_update_segment_count
        if last_agent_consult is not None:
            payload["last_agent_consult"] = last_agent_consult
        if last_consult_segment_count is not None:
            payload["last_consult_segment_count"] = last_consult_segment_count
        if consecutive_no_updates is not None:
            payload["consecutive_no_updates"] = consecutive_no_updates
        await self._store_upsert("semantic_context", point_id, embedding, payload)
        return {"id": point_id, "collection": "semantic_context", "event": "UPSERT"}

    # ------------------------------------------------------------------ #
    # Internal: async memory operations                                   #
    # ------------------------------------------------------------------ #

    async def _add_to_vector_store(
        self,
        video_data: dict[str, Any],
        entity_data: list[dict[str, Any]],
        metadata: dict[str, Any],
        filters: dict[str, Any],
        infer: bool,
        semantic_mode: str = SEMANTIC_MODE_INLINE,
    ) -> list[dict[str, Any]]:
        """Orchestrate episodic + semantic creation with gather."""
        returned_memories: list[dict[str, Any]] = []
        profiler = current_profiler()
        if semantic_mode not in SEMANTIC_MODES:
            raise ValueError(f"semantic_mode must be one of {sorted(SEMANTIC_MODES)}")
        if profiler:
            profiler.add_counter("entity_data_count", len(entity_data))
            profiler.add_counter("infer_enabled", 1 if infer else 0)
            profiler.add_counter(f"semantic_mode_{semantic_mode}", 1)

        # Entity episodic must complete first to get entity_ids
        with (profiler.span("mem.episodic_entity.total") if profiler else nullcontext()):
            entity_memories, entity_ids = await self._create_episodic_entity(
                entity_data, metadata
            )
        returned_memories.extend(entity_memories)

        # Video episodic + semantic in parallel
        async def _profiled_video() -> list[dict[str, Any]]:
            with (profiler.span("mem.episodic_trace.total") if profiler else nullcontext()):
                return await self._create_episodic_trace(video_data, metadata, entity_ids)

        video_task = asyncio.create_task(_profiled_video())

        if infer and semantic_mode == SEMANTIC_MODE_BACKGROUND:
            video_memory = await video_task
            returned_memories.extend(video_memory)
            self._enqueue_background_semantic_memory(video_data, entity_data, filters, metadata)
            if profiler:
                profiler.add_counter("semantic_background_enqueued", 1)
        elif infer:
            async def _profiled_semantic() -> list[dict[str, Any]]:
                with (profiler.span("mem.semantic.total") if profiler else nullcontext()):
                    return await self._process_entity_semantic_memory(video_data, entity_data, filters, metadata)

            semantic_task = asyncio.create_task(_profiled_semantic())
            video_memory, semantic_results = await asyncio.gather(video_task, semantic_task)
            returned_memories.extend(video_memory)
            returned_memories.extend(semantic_results)
        else:
            video_memory = await video_task
            returned_memories.extend(video_memory)

        return returned_memories

    async def _semantic_entity_lock(self, key: str) -> asyncio.Lock:
        if not hasattr(self, "_semantic_entity_locks_guard"):
            self._semantic_entity_locks_guard = asyncio.Lock()
            self._semantic_entity_locks = {}
        async with self._semantic_entity_locks_guard:
            lock = self._semantic_entity_locks.get(key)
            if lock is None:
                lock = asyncio.Lock()
                self._semantic_entity_locks[key] = lock
            return lock

    def _enqueue_background_semantic_memory(
        self,
        video_data: dict[str, Any],
        entity_data: list[dict[str, Any]],
        filters: dict[str, Any],
        metadata: dict[str, Any],
    ) -> None:
        """Run expensive entity semantic updates out of the request path."""
        video_data_copy = deepcopy(video_data)
        entity_data_copy = deepcopy(entity_data)
        filters_copy = deepcopy(filters)
        metadata_copy = deepcopy(metadata)
        if not hasattr(self, "_semantic_background_tasks"):
            self._semantic_background_tasks = set()
        if not hasattr(self, "_semantic_background_semaphore"):
            self._semantic_background_semaphore = asyncio.Semaphore(SEMANTIC_BACKGROUND_CONCURRENCY)

        async def _runner() -> None:
            health_scope = _semantic_runtime_health_scope(filters_copy, metadata_copy)
            profiler, token = start_memory_profile(
                "mem.semantic.background",
                {
                    "camera_id": metadata_copy.get("camera_id"),
                    "video_id": metadata_copy.get("video_id"),
                    "entity_count": len([e for e in entity_data_copy if e.get("entity_id")]),
                },
            )
            try:
                with profiler.span("mem.semantic.total"):
                    results = await self._process_entity_semantic_memory(
                        video_data_copy,
                        entity_data_copy,
                        filters_copy,
                        metadata_copy,
                        use_background_limiter=True,
                    )
                profiler.add_counter("semantic_background_results", len(results))
                _observe_runtime_health(
                    getattr(self, "on_runtime_health", None),
                    status="ok",
                    scope=health_scope,
                )
                if self.on_background_memory_result:
                    for result in results:
                        self.on_background_memory_result(result, metadata_copy)
            except Exception:
                _observe_runtime_health(
                    getattr(self, "on_runtime_health", None),
                    status="down",
                    code="background_update_failed",
                    scope=health_scope,
                )
                logger.exception(
                    "Background semantic memory update failed camera_id=%s video_id=%s",
                    metadata_copy.get("camera_id"),
                    metadata_copy.get("video_id"),
                )
            finally:
                logger.info(
                    "[memory-profile] semantic_background %s",
                    json.dumps(profiler.to_dict(), ensure_ascii=False),
                )
                reset_memory_profile(token)

        task = asyncio.create_task(_runner())
        self._semantic_background_tasks.add(task)
        task.add_done_callback(self._semantic_background_tasks.discard)

    async def _create_episodic_entity(
        self,
        entity_data: list[dict[str, Any]],
        metadata: dict[str, Any],
    ) -> tuple[list[dict[str, Any]], list[str]]:
        """Per-entity episodic observation → episodic_entity collection (async)."""

        def _entity_observation_text(entity: dict[str, Any]) -> str:
            class_name = str(entity.get("class_name") or "entity").strip()
            appearance = str(entity.get("appearance") or "").strip()
            behavior = str(entity.get("behavior") or "").strip()
            interaction = str(entity.get("interaction") or "").strip()
            message = str(entity.get("message") or "").strip()

            parts: list[str] = []
            if appearance and behavior:
                parts.append(f"A {class_name} is shown with {appearance}; it {behavior}.")
            elif appearance:
                parts.append(f"A {class_name} is shown with {appearance}.")
            elif behavior:
                parts.append(f"A {class_name} {behavior}.")
            if interaction:
                parts.append(f"It interacts by {interaction}.")
            # Fallback to message when structured fields are empty (rehydrate / manual add)
            if not parts and message:
                return message
            return " ".join(parts).strip()

        async def _process_one(entity: dict[str, Any]) -> tuple[str | None, dict[str, Any] | None]:
            entity_id = entity.get("entity_id")
            if not entity_id:
                return None, None

            content = _entity_observation_text(entity)
            if not content:
                return entity_id, None

            payload = deepcopy(metadata)
            payload["role"] = "user"
            payload["entity_id"] = entity_id
            payload["class_name"] = entity.get("class_name", "")
            payload["video_ids"] = normalize_video_ids(
                metadata.get("video_ids"),
                metadata.get("video_id"),
            )
            payload.pop("video_id", None)

            embedding = await self._embed(content)
            mem_id = await self._create_memory(
                "episodic_entity", content, embedding=embedding, metadata=payload
            )
            return entity_id, {
                "id": mem_id,
                "memory": content,
                "event": "ADD",
                "collection": self.store.collection_name("episodic_entity"),
            }

        tasks = [_process_one(e) for e in entity_data]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        returned_memories: list[dict[str, Any]] = []
        entity_ids: list[str] = []
        for r in results:
            if isinstance(r, Exception):
                logger.error("Error processing entity: %s", r)
                continue
            eid, memory = r
            if eid:
                entity_ids.append(eid)
            if memory:
                returned_memories.append(memory)
        return returned_memories, entity_ids

    async def _create_episodic_trace(
        self,
        video_data: dict[str, Any],
        metadata: dict[str, Any],
        entity_ids: list[str],
    ) -> list[dict[str, Any]]:
        """Segment-level video summary → episodic_trace collection (async)."""
        returned_memories: list[dict[str, Any]] = []
        payload = deepcopy(metadata)
        payload["role"] = "user"
        payload["entity_ids"] = normalize_string_ids(
            entity_ids,
            metadata.get("entity_ids"),
        )

        summary = str(video_data.get("summary") or "").strip()
        detailed_summary = str(video_data.get("detailed_summary") or "").strip()
        transcript = str(video_data.get("transcript") or "").strip()
        speech_events_text = str(video_data.get("speech_events_text") or "").strip()
        speech_text = str(video_data.get("speech_text") or metadata.get("speech_text") or "").strip()
        retrieval_compact = _normalize_retrieval_compact(
            video_data.get("retrieval_compact") or metadata.get("retrieval_compact")
        )
        if summary:
            payload["summary"] = summary
        if detailed_summary:
            payload["detailed_summary"] = detailed_summary
        if retrieval_compact:
            payload["retrieval_compact"] = retrieval_compact
        if transcript:
            payload["transcript"] = transcript
        if speech_events_text:
            payload["speech_events_text"] = speech_events_text
        if speech_text:
            payload["speech_text"] = speech_text

        content_parts = [detailed_summary or summary]
        if speech_events_text:
            content_parts.append(speech_events_text)
        if retrieval_compact:
            content_parts.append(f"Retrieval compact: {'; '.join(retrieval_compact)}")
        content = " ".join(part for part in content_parts if part).strip()
        embed_data = video_data.get("embed")

        tasks: list[Any] = []

        if content:
            async def _handle_text() -> list[dict[str, Any]]:
                embedding = await self._embed(content)
                mem_id = await self._create_memory(
                    "episodic_trace", content, embedding=embedding, metadata=payload
                )
                return [
                    {
                        "id": mem_id,
                        "memory": content,
                        "event": "ADD",
                        "collection": self.store.collection_name("episodic_trace"),
                    }
                ]

            tasks.append(_handle_text())

        if embed_data:
            async def _handle_video() -> list[dict[str, Any]]:
                embed_vector = np.frombuffer(
                    base64.b64decode(embed_data), dtype=np.float32
                ).tolist()
                mem_id = await self._create_memory(
                    "episodic_visual", "", embedding=embed_vector, metadata=payload
                )
                return [
                    {
                        "id": mem_id,
                        "memory": "",
                        "event": "ADD",
                        "collection": self.store.collection_name("episodic_visual"),
                    }
                ]

            tasks.append(_handle_video())

        if tasks:
            results = await asyncio.gather(*tasks, return_exceptions=True)
            for r in results:
                if isinstance(r, Exception):
                    logger.error("Error creating video episodic memory: %s", r)
                    continue
                returned_memories.extend(r)

        return returned_memories

    async def _process_entity_semantic_memory(
        self,
        video_data: dict[str, Any],
        entity_data: list[dict[str, Any]],
        filters: dict[str, Any],
        metadata: dict[str, Any],
        *,
        use_background_limiter: bool = False,
    ) -> list[dict[str, Any]]:
        """Multi-entity semantic with gather."""
        new_video_data = {
            **{k: v for k, v in video_data.items() if k != "embed"},
            "entities": [
                {k: v for k, v in entity.items() if k != "embed"}
                for entity in entity_data
            ],
        }
        counter_scope = entity_semantic_counter_scope(filters)
        profiler = current_profiler()
        if profiler:
            profiler.add_counter("semantic_entity_count", len([e for e in entity_data if e.get("entity_id")]))

        async def _process_one_locked(entity_item: dict[str, Any]) -> list[dict[str, Any]]:
            entity_id = entity_item.get("entity_id")
            if not entity_id:
                return []

            with (profiler.span("mem.semantic.counter") if profiler else nullcontext()):
                observation_count = await asyncio.to_thread(
                    self.history.increment_entity_observation, counter_scope, entity_id
                )
            should_update_semantic = should_update_entity_semantic_memory(
                observation_count
            )
            logger.info(
                "Entity semantic update gate: scope=%s entity_id=%s "
                "observation_count=%d interval=%d should_update=%s",
                counter_scope,
                entity_id,
                observation_count,
                ENTITY_SEMANTIC_UPDATE_INTERVAL,
                should_update_semantic,
            )
            if not should_update_semantic:
                return []

            current_video_id = metadata.get("video_id")
            with (profiler.span("mem.semantic.history.total") if profiler else nullcontext()):
                historical = await self._get_entity_complete_history(
                    entity_id, filters, exclude_video_id=current_video_id
                )
            if not historical["episodic"] and not historical["semantic"]:
                logger.info("No historical memories for entity %s", entity_id)
                return []

            with (profiler.span("mem.semantic.merge.total") if profiler else nullcontext()):
                semantic_results, has_add_or_update = await self._merge_entity_semantic_memory(
                    entity_id, new_video_data, historical, metadata
                )

            if has_add_or_update:
                visual_results = await self._entity_semantic_visual_embed(
                    entity_item, entity_id, metadata
                )
                semantic_results.extend(visual_results)

            return semantic_results

        async def _process_one(entity_item: dict[str, Any]) -> list[dict[str, Any]]:
            entity_id = entity_item.get("entity_id")
            if not entity_id:
                return []
            lock_key = f"{counter_scope}:{entity_id}"
            lock = await self._semantic_entity_lock(lock_key)
            async with lock:
                if use_background_limiter:
                    async with self._semantic_background_semaphore:
                        return await _process_one_locked(entity_item)
                return await _process_one_locked(entity_item)

        entity_tasks = [_process_one(e) for e in entity_data]
        results_list = await asyncio.gather(*entity_tasks, return_exceptions=True)

        returned_memories: list[dict[str, Any]] = []
        for r in results_list:
            if isinstance(r, Exception):
                logger.error("Error processing entity semantic memory: %s", r)
                continue
            returned_memories.extend(r)
        return returned_memories

    async def _get_entity_complete_history(
        self,
        entity_id: str,
        filters: dict[str, Any],
        exclude_video_id: str | None = None,
    ) -> dict[str, list[dict[str, Any]]]:
        """Get episodic + semantic history with gather."""
        profiler = current_profiler()
        entity_filters = deepcopy(filters)
        entity_filters.pop("camera_id", None)
        entity_filters.pop("video_id", None)
        entity_filters.pop("run_id", None)
        entity_filters.pop("mode", None)

        async def _fetch_episodic() -> list[dict[str, Any]]:
            epi_filters = deepcopy(entity_filters)
            epi_filters["entity_id"] = entity_id
            with (profiler.span("mem.semantic.history.episodic_scroll") if profiler else nullcontext()):
                raw = await self._store_scroll("episodic_entity", filters=epi_filters, limit=50)
            result: list[dict[str, Any]] = []
            for p in raw:
                payload = p["payload"]
                video_ids = normalize_video_ids(payload.get("video_ids"))
                if exclude_video_id and exclude_video_id in video_ids:
                    continue
                result.append(
                    {
                        "id": p["id"],
                        "content": payload.get("data", {}),
                        "created_at": payload.get("created_at", ""),
                        "camera_id": payload.get("camera_id", ""),
                    }
                )
                if len(result) >= 20:
                    break
            return result

        async def _fetch_semantic() -> list[dict[str, Any]]:
            sem_filters = deepcopy(entity_filters)
            sem_filters["entity_id"] = entity_id
            with (profiler.span("mem.semantic.history.semantic_scroll") if profiler else nullcontext()):
                raw = await self._store_scroll("semantic_entity", filters=sem_filters, limit=10)
            return [
                {
                    "id": p["id"],
                    "content": p["payload"].get("data", ""),
                    "category": p["payload"].get("category", ""),
                    "entity_class": p["payload"].get("entity_class", ""),
                    "created_at": p["payload"].get("created_at", ""),
                }
                for p in raw
            ]

        epi_result, sem_result = await asyncio.gather(
            _fetch_episodic(), _fetch_semantic(), return_exceptions=True
        )

        historical: dict[str, list[dict[str, Any]]] = {"episodic": [], "semantic": []}
        if not isinstance(epi_result, Exception):
            historical["episodic"] = epi_result
        else:
            logger.error("Error fetching episodic: %s", epi_result)
        if not isinstance(sem_result, Exception):
            historical["semantic"] = sem_result
        else:
            logger.error("Error fetching semantic: %s", sem_result)

        logger.info(
            "Retrieved historical memories for entity %s: %d episodic, %d semantic",
            entity_id, len(historical["episodic"]), len(historical["semantic"]),
        )
        return historical

    async def _merge_entity_semantic_memory(
        self,
        entity_id: str,
        current_video_data: dict[str, Any],
        historical_memories: dict[str, list[dict[str, Any]]],
        metadata: dict[str, Any],
    ) -> tuple[list[dict[str, Any]], bool]:
        """LLM decision on semantic memory with gather for write operations."""
        temp_uuid_mapping: dict[str, str] = {}
        historical_semantic = historical_memories["semantic"]
        for idx, item in enumerate(historical_semantic):
            temp_uuid_mapping[str(idx)] = item["id"]
            historical_semantic[idx]["id"] = str(idx)

        try:
            prompt_text = build_semantic_analysis_prompt(
                entity_id,
                current_video_data,
                historical_memories["episodic"],
                historical_memories["semantic"],
            )
            response = await self._llm_complete(
                messages=[{"role": "user", "content": prompt_text}],
                response_format={"type": "json_object"},
            )
        except Exception as exc:
            logger.error("Error in semantic pattern analysis: %s", exc)
            return [], False

        try:
            response = remove_code_blocks(response)
            semantic_updates = json.loads(response)
        except Exception as exc:
            logger.error("Invalid JSON in semantic analysis: %s", exc)
            return [], False

        returned_memories: list[dict[str, Any]] = []
        has_add_or_update = False
        async_tasks: list[tuple[Any, dict[str, Any], str, str | None, float | None, list[str], str]] = []

        for resp in semantic_updates.get("semantic_memory_updates", []):
            action_text = resp.get("text")
            if not action_text:
                continue

            event_type = resp.get("event", "NONE")
            video_ids = normalize_video_ids(
                metadata.get("video_ids"),
                metadata.get("video_id"),
            )
            payload = deepcopy(metadata)
            payload["entity_id"] = entity_id
            payload["entity_class"] = resp.get("entity_class", "")
            category = semantic_update_category(resp)
            payload["category"] = category
            payload["video_ids"] = video_ids
            payload.pop("video_id", None)

            if event_type == "ADD":
                importance = semantic_update_importance(resp)
                payload["importance"] = importance
                task = asyncio.create_task(
                    self._create_memory("semantic_entity", action_text, metadata=payload)
                )
                async_tasks.append((task, resp, "ADD", None, importance, video_ids, category))
                has_add_or_update = True

            elif event_type == "UPDATE":
                memory_id = resp.get("id")
                if memory_id and memory_id in temp_uuid_mapping:
                    real_id = temp_uuid_mapping[memory_id]
                    try:
                        old_point = await self._store_get("semantic_entity", real_id)
                        if old_point and old_point["payload"].get("category") == "identity":
                            logger.info("Skipping UPDATE on identity memory %s", memory_id)
                            continue
                        old_importance = (
                            old_point["payload"].get("importance", 0.5) if old_point else 0.5
                        )
                    except Exception:
                        old_importance = 0.5

                    importance = compute_importance(old_importance)
                    payload["importance"] = importance

                    task = asyncio.create_task(
                        self._update_memory("semantic_entity", real_id, action_text, metadata=payload)
                    )
                    async_tasks.append((task, resp, "UPDATE", real_id, importance, video_ids, category))
                    has_add_or_update = True

            elif event_type == "DELETE":
                memory_id = resp.get("id")
                if memory_id and memory_id in temp_uuid_mapping:
                    real_id = temp_uuid_mapping[memory_id]
                    try:
                        check = await self._store_get("semantic_entity", real_id)
                        if check and check["payload"].get("category") == "identity":
                            logger.info("Skipping DELETE on identity memory %s", memory_id)
                            continue
                    except Exception as exc:
                        logger.warning("Could not verify category for %s: %s", memory_id, exc)

                    task = asyncio.create_task(
                        self._delete_memory("semantic_entity", real_id)
                    )
                    async_tasks.append((task, resp, "DELETE", real_id, None, video_ids, category))

            elif event_type == "NONE":
                logger.info("No semantic memory changes needed.")

        if async_tasks:
            results = await asyncio.gather(
                *[t[0] for t in async_tasks], return_exceptions=True
            )
            for result, (_, resp, evt, mem_id, importance, video_ids, category) in zip(results, async_tasks):
                if isinstance(result, Exception):
                    logger.error("[ASYNC TASK ERROR] %s failed: %s", evt, result)
                    continue

                if evt == "ADD":
                    returned_memories.append(
                        {
                            "id": result,
                            "memory": resp.get("text"),
                            "memory_type": "semantic",
                            "event": "ADD",
                            "collection": self.store.collection_name("semantic_entity"),
                            "entity_id": entity_id,
                            "entity_class": resp.get("entity_class", ""),
                            "category": category,
                            "categories": category,
                            "video_ids": video_ids,
                            "importance": importance,
                        }
                    )
                elif evt == "UPDATE":
                    returned_memories.append(
                        {
                            "id": result,
                            "memory": resp.get("text"),
                            "memory_type": "semantic",
                            "event": "UPDATE",
                            "collection": self.store.collection_name("semantic_entity"),
                            "entity_id": entity_id,
                            "entity_class": resp.get("entity_class", ""),
                            "category": category,
                            "categories": category,
                            "video_ids": video_ids,
                            "importance": importance,
                        }
                    )
                elif evt == "DELETE":
                    returned_memories.append(
                        {
                            "id": mem_id,
                            "memory_type": "semantic",
                            "memory": result.get("data") if isinstance(result, dict) else "",
                            "event": "DELETE",
                            "collection": self.store.collection_name("semantic_entity"),
                            "entity_id": entity_id,
                            "entity_class": (
                                result.get("entity_class", "") if isinstance(result, dict) else ""
                            ),
                            "category": (
                                result.get("category", result.get("categories", ""))
                                if isinstance(result, dict)
                                else ""
                            ),
                            "categories": (
                                result.get("category", result.get("categories", ""))
                                if isinstance(result, dict)
                                else ""
                            ),
                            "video_ids": (
                                result.get("video_ids", []) if isinstance(result, dict) else []
                            ),
                        }
                    )

        return returned_memories, has_add_or_update

    async def _entity_semantic_visual_embed(
        self,
        entity_item: dict[str, Any],
        entity_id: str,
        metadata: dict[str, Any],
    ) -> list[dict[str, Any]]:
        """Store face/body embeddings with gather."""
        embed_data = entity_item.get("embed", {})
        if not embed_data:
            return []

        async def _store_one(embed_key: str, embed_value: str) -> dict[str, Any]:
            suffix = f"semantic_{embed_key}"
            embed_vector = np.frombuffer(
                base64.b64decode(embed_value), dtype=np.float32
            ).tolist()
            payload = deepcopy(metadata)
            payload["entity_id"] = entity_id
            if "class_name" in entity_item:
                payload["entity_class"] = entity_item["class_name"]
            payload["video_ids"] = normalize_video_ids(
                metadata.get("video_ids"),
                metadata.get("video_id"),
            )
            payload.pop("video_id", None)

            mem_id = await self._create_memory(
                suffix, "", embedding=embed_vector, metadata=payload
            )
            logger.info("Stored %s embed for entity %s", embed_key, entity_id)
            return {
                "id": mem_id,
                "memory": "",
                "event": "ADD",
                "collection": self.store.collection_name(suffix),
                "entity_id": entity_id,
                "embed_type": embed_key,
            }

        tasks = [_store_one(k, v) for k, v in embed_data.items()]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        returned_memories: list[dict[str, Any]] = []
        for r in results:
            if isinstance(r, Exception):
                logger.error("Error storing visual embed for entity %s: %s", entity_id, r)
                continue
            returned_memories.append(r)
        return returned_memories

    async def _create_procedural_memory(
        self,
        messages: list[dict[str, str]],
        metadata: dict[str, Any] | None = None,
        prompt: str | None = None,
    ) -> dict[str, Any]:
        """Create a procedural memory (async)."""
        if metadata is None:
            raise ValueError("Metadata cannot be None for procedural memory.")

        logger.info("Creating procedural memory (async)")

        if metadata.get("camera_id"):
            procedural_memory = messages[0].get("content", "")
        else:
            parsed_messages = [
                {"role": "system", "content": prompt or PROCEDURAL_MEMORY_SYSTEM_PROMPT},
                *messages,
                {
                    "role": "user",
                    "content": "Create procedural memory of the above conversation.",
                },
            ]
            procedural_memory = await self._llm_complete(messages=parsed_messages)

        embedding = await self._embed(procedural_memory)
        mem_id = await self._create_memory(
            "procedural",
            procedural_memory,
            embedding=embedding,
            metadata=metadata,
        )
        return {"results": [{"id": mem_id, "memory": procedural_memory, "event": "ADD"}]}

    async def _create_memory(
        self,
        collection_suffix: str,
        data: str,
        embedding: list[float] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        """Create a point (async). Compute embedding if not provided."""
        if embedding is None:
            embedding = await self._embed(data)

        memory_id = str(uuid.uuid4())
        payload = deepcopy(metadata) if metadata else {}
        payload["data"] = data
        payload["hash"] = hashlib.md5(data.encode()).hexdigest()

        now = datetime.now(timezone.utc).isoformat()
        payload["created_at"] = now
        payload["updated_at"] = now

        await self._store_insert(collection_suffix, embedding, payload, point_id=memory_id)
        profiler = current_profiler()
        with (profiler.span("mem.history.add") if profiler else nullcontext()):
            await asyncio.to_thread(
                self.history.add_history, memory_id, None, data, "ADD",
                0, payload.get("created_at"), None, payload.get("actor_id"), payload.get("role"),
            )

        logger.info("Created memory %s in %s (async)", memory_id, collection_suffix)
        return memory_id

    async def _update_memory(
        self,
        collection_suffix: str,
        memory_id: str,
        data: str,
        embedding: list[float] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        """Update point (async). Preserve created_at, merge session IDs."""
        existing = await self._store_get(collection_suffix, memory_id)
        if existing is None:
            raise ValueError(f"Memory with ID {memory_id} not found in {collection_suffix}")

        existing_payload = existing["payload"]
        prev_value = existing_payload.get("data")

        new_payload = deepcopy(metadata) if metadata else {}
        new_payload["data"] = data
        new_payload["hash"] = hashlib.md5(data.encode()).hexdigest()
        new_payload["created_at"] = existing_payload.get("created_at")
        new_payload["updated_at"] = datetime.now(timezone.utc).isoformat()

        for key in ("user_id", "agent_id", "run_id", "video_id", "actor_id",
                     "entity_id", "entity_ids", "camera_id", "role"):
            if key in existing_payload:
                new_payload[key] = existing_payload[key]

        if "video_ids" in existing_payload:
            prev_video_ids = existing_payload.get("video_ids", [])
            current_video_ids = metadata.get("video_ids", []) if metadata else []
            new_payload["video_ids"] = prev_video_ids + [
                vid for vid in current_video_ids if vid not in prev_video_ids
            ]

        if embedding is None:
            embedding = await self._embed(data)

        await self._store_update(collection_suffix, memory_id, embedding, new_payload)
        profiler = current_profiler()
        with (profiler.span("mem.history.add") if profiler else nullcontext()):
            await asyncio.to_thread(
                self.history.add_history, memory_id, prev_value, data, "UPDATE",
                0, new_payload.get("created_at"), new_payload.get("updated_at"),
                new_payload.get("actor_id"), new_payload.get("role"),
            )
        return memory_id

    async def _delete_memory(
        self, collection_suffix: str, memory_id: str
    ) -> dict[str, Any] | None:
        """Delete point (async). Write history with is_deleted=1."""
        existing = await self._store_get(collection_suffix, memory_id)
        if existing is None:
            raise ValueError(f"Memory with ID {memory_id} not found in {collection_suffix}")

        prev_value = existing["payload"].get("data")
        await self._store_delete(collection_suffix, memory_id)
        profiler = current_profiler()
        with (profiler.span("mem.history.add") if profiler else nullcontext()):
            await asyncio.to_thread(
                self.history.add_history, memory_id, prev_value, None, "DELETE", 1,
                None, None, existing["payload"].get("actor_id"), existing["payload"].get("role"),
            )
        return existing["payload"]


# ---------------------------------------------------------------------------
# Shared helper (used by async manager to avoid duplication)
# ---------------------------------------------------------------------------


def _adjust_filters(collection_suffix: str, filters: dict[str, Any]) -> dict[str, Any]:
    """Per-collection filter adjustment. Clean rules, no substring matching."""
    adjusted = deepcopy(filters)

    # Entity-level collections store segment provenance as video_ids arrays.
    if collection_suffix in {"episodic_entity", "semantic_entity"} and "video_id" in adjusted:
        vid = adjusted.pop("video_id")
        adjusted["video_ids"] = {"match_any": [vid]}

    # episodic_entity uses entity_id (single value), not entity_ids array.
    # No entity_id adjustment needed -- entity_id filter works directly.

    # episodic_trace uses entity_ids (array); translate entity_id -> match_any
    if collection_suffix == "episodic_trace" and "entity_id" in adjusted:
        eid = adjusted.pop("entity_id")
        adjusted["entity_ids"] = {"match_any": [eid]}

    return adjusted


def _sort_key_for_collection(suffix: str) -> str:
    """episodic_schema sorts by event time, not insertion time."""
    if suffix == "episodic_schema":
        return "time_range_start_ms"
    return "created_at"


def _normalize_retrieval_compact(value: Any) -> list[str]:
    if isinstance(value, str):
        raw_items = [p.strip() for p in re.split(r"[;\n]", value)]
    elif isinstance(value, list):
        raw_items = [str(p).strip() for p in value]
    else:
        raw_items = []
    items = [" ".join(item.split()[:8]) for item in raw_items if item]
    return items[:8]
