"""FastAPI application for the Cortex memory service.

All endpoints are async and delegate to AsyncMemoryManager.
Startup event builds config, creates components, and injects them.
"""

import asyncio
import logging
import os
import threading
from datetime import datetime
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, RedirectResponse

from src.config import MemConfig
from src.embedder import Embedder
from src.history import HistoryStore
from src.llm import LLMClient
from src.memory_manager import AsyncMemoryManager
from src.models import (
    AddSchemaRequest,
    ExpireMediaRequest,
    MemoryCreateRequest,
    ReidBatchInitRequest,
    ReidGalleryUpdateRequest,
    ReidSearchRequest,
    ReidUpdateIdentityRequest,
    ReidUpsertRequest,
    SearchRequest,
    SetIdentityRequest,
    UpdateMemoryRequest,
    UpsertContextRequest,
)
from src.qdrant_store import COLLECTION_SPECS, QdrantStore
from src.reid import ReidManager
from src.runtime_health import RuntimeHealthReporter


# ---------------------------------------------------------------------------
# Logging setup
# ---------------------------------------------------------------------------

def setup_logging(config: MemConfig) -> str:
    """Configure structured logging with RotatingFileHandler."""
    log_dir = config.log_path or str(Path.home() / ".cortex" / "logs")
    os.makedirs(log_dir, exist_ok=True)

    log_file = os.path.join(
        log_dir, f"cortex_memory_server_{datetime.now().strftime('%Y%m%d')}.log"
    )

    formatter = logging.Formatter(
        "%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    root_logger = logging.getLogger()
    root_logger.setLevel(logging.INFO)

    for handler in root_logger.handlers[:]:
        root_logger.removeHandler(handler)

    console_handler = logging.StreamHandler()
    console_handler.setLevel(logging.INFO)
    console_handler.setFormatter(formatter)
    root_logger.addHandler(console_handler)

    file_handler = RotatingFileHandler(
        log_file, maxBytes=10 * 1024 * 1024, backupCount=5, encoding="utf-8"
    )
    file_handler.setLevel(logging.INFO)
    file_handler.setFormatter(formatter)
    root_logger.addHandler(file_handler)

    return log_file


# ---------------------------------------------------------------------------
# Module-level state
# ---------------------------------------------------------------------------

config: MemConfig = MemConfig.from_env()
log_file_path: str = setup_logging(config)
logger = logging.getLogger(__name__)

async_manager: Optional[AsyncMemoryManager] = None
reid: Optional[ReidManager] = None
runtime_health: Optional[RuntimeHealthReporter] = None
_reid_call_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Monitor webhook
# ---------------------------------------------------------------------------

def notify_monitor(event_type: str, data: dict[str, Any]) -> None:
    """Fire-and-forget POST to Monitor server."""
    def _send() -> None:
        try:
            httpx.post(
                config.monitor_webhook_url,
                json={"type": event_type, "data": data},
                headers={"X-Cortex-Internal-Token": config.internal_webhook_token}
                if config.internal_webhook_token
                else None,
                timeout=2.0,
            )
        except Exception as exc:
            logger.debug("Monitor webhook failed (non-fatal): %s", exc)
    threading.Thread(target=_send, daemon=True).start()


def notify_memory_result(result: dict[str, Any], metadata: dict[str, Any]) -> None:
    """Publish monitor updates for memory results that should hydrate Dashboard."""
    collection = result.get("collection", "")
    if "_episodic_" in collection:
        return
    if "_semantic_" in collection:
        mem_type = "semantic"
    elif "_procedural" in collection:
        mem_type = "procedural"
    else:
        return
    notify_monitor("memory:memory_added", {
        "memory_id": result.get("id"),
        "memory_type": mem_type,
        "event": result.get("event", "ADD"),
        "camera_id": metadata.get("camera_id"),
        "entity_id": result.get("entity_id"),
        "importance": result.get("importance"),
        "summary_preview": str(result.get("memory", ""))[:200],
    })


# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Cortex Memory API Server",
    description="Cortex memory service for multimodal visual memory management",
    version="1.1.0",
)


@app.on_event("startup")
async def startup() -> None:
    """Build all components and inject into AsyncMemoryManager."""
    global async_manager, reid, runtime_health

    logger.info("Initializing Cortex Memory service")

    try:
        runtime_health = RuntimeHealthReporter(
            config.monitor_webhook_url, config.internal_webhook_token
        )
    except Exception as exc:
        runtime_health = None
        logger.warning("Runtime health reporter disabled (non-fatal): %s", exc)
    health_observer = runtime_health.observe if runtime_health is not None else None
    store = QdrantStore(config)
    llm = LLMClient(config)
    embedder = Embedder(config, health_observer)
    history = HistoryStore(config.history_db_path)
    reid = ReidManager(store)

    async_manager = AsyncMemoryManager(
        store=store, llm=llm, embedder=embedder,
        reid=reid, history=history, config=config,
        on_background_memory_result=notify_memory_result,
        on_runtime_health=health_observer,
    )
    logger.info("Cortex Memory initialized successfully")


@app.on_event("shutdown")
async def shutdown() -> None:
    """Release manager-owned background tasks."""
    global async_manager, runtime_health
    if async_manager is not None:
        await async_manager.aclose()
        async_manager = None
    if runtime_health is not None:
        try:
            runtime_health.close()
        except Exception:
            logger.debug("Runtime health reporter shutdown failed (non-fatal)", exc_info=True)
    runtime_health = None


def _ensure_initialized() -> AsyncMemoryManager:
    """Return the manager or raise 503."""
    if async_manager is None:
        raise HTTPException(status_code=503, detail="Service not initialized")
    return async_manager


def _call_sync_reid_serialized(func, /, *args, **kwargs) -> Any:
    """Run one synchronous ReID manager call while preserving manager serialization."""
    with _reid_call_lock:
        return func(*args, **kwargs)


async def _run_sync_reid_call(func, /, *args, **kwargs) -> Any:
    """Run synchronous ReID manager work off the FastAPI event loop."""
    return await asyncio.to_thread(_call_sync_reid_serialized, func, *args, **kwargs)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/", include_in_schema=False)
async def home() -> RedirectResponse:
    """Redirect to the OpenAPI documentation."""
    return RedirectResponse(url="/docs")


@app.post("/memories", summary="Create memories")
async def add_memory(request: MemoryCreateRequest) -> JSONResponse:
    """Store new memories from video/entity data or messages."""
    mgr = _ensure_initialized()
    if request.memory_type in ("episodic_schema", "semantic_context"):
        raise HTTPException(
            status_code=400,
            detail=f"Use dedicated endpoint for {request.memory_type}",
        )
    try:
        response = await mgr.add_memory(
            video_data=request.video_data,
            entity_data=request.entity_data,
            messages=request.messages,
            user_id=request.user_id,
            agent_id=request.agent_id,
            run_id=request.run_id,
            video_id=request.video_id,
            camera_id=request.camera_id,
            metadata=request.metadata,
            infer=request.infer if request.infer is not None else True,
            memory_type=request.memory_type,
            prompt=request.prompt,
            semantic_mode=request.semantic_mode or "inline",
            mode=request.mode,
            event_id=request.event_id,
        )

        for r in response.get("results", []):
            notify_memory_result(r, {"camera_id": request.camera_id})

        return JSONResponse(content=response)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.exception("Error in add_memory:")
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/memories", summary="Get all memories")
async def get_all_memories(
    user_id: Optional[str] = None,
    agent_id: Optional[str] = None,
    run_id: Optional[str] = None,
    video_id: Optional[str] = None,
    entity_id: Optional[str] = None,
    camera_id: Optional[str] = None,
    memory_type: Optional[str] = None,
    limit: int = 100,
    sort_order: Optional[str] = None,
) -> Any:
    """Retrieve stored memories. sort_order: 'asc' for oldest-first, 'desc' (default) for newest-first."""
    mgr = _ensure_initialized()
    if not any([user_id, agent_id, run_id, video_id, entity_id, camera_id]):
        raise HTTPException(status_code=400, detail="At least one identifier is required.")
    try:
        return await mgr.get_all_memories(
            user_id=user_id, agent_id=agent_id, run_id=run_id,
            video_id=video_id, entity_id=entity_id, camera_id=camera_id,
            memory_type=memory_type, limit=limit, sort_order=sort_order,
        )
    except Exception as exc:
        logger.exception("Error in get_all_memories:")
        raise HTTPException(status_code=500, detail=str(exc))


@app.patch("/memories/expire_media", summary="Expire media URLs for a segment")
async def expire_media(req: ExpireMediaRequest) -> JSONResponse:
    """Marks media_urls as expired (null) for episodic memories of a segment."""
    mgr = _ensure_initialized()
    try:
        result = await mgr.expire_media(
            segment_id=req.segment_id, camera_id=req.camera_id,
        )
        return JSONResponse(content=result)
    except Exception as exc:
        logger.exception("Error in expire_media:")
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/identity/set", summary="Set entity identity")
async def set_identity(req: "SetIdentityRequest") -> JSONResponse:
    """Create or update an identity memory (category=identity, importance=1.0, LLM-protected)."""
    mgr = _ensure_initialized()
    try:
        result = await mgr.set_identity(
            entity_id=req.entity_id,
            identity=req.identity,
            status=req.status,
            user_id=req.user_id,
            camera_id=req.camera_id,
        )
        return JSONResponse(content=result)
    except Exception as exc:
        logger.exception("Error in set_identity:")
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/memories/schema", summary="Add episodic schema entry")
async def add_episodic_schema(req: AddSchemaRequest) -> JSONResponse:
    """Create an episodic schema entry aggregating multiple events."""
    mgr = _ensure_initialized()
    try:
        result = await mgr.add_episodic_schema(
            summary=req.summary,
            event_ids=req.event_ids,
            time_range=req.time_range,
            camera_id=req.camera_id,
            user_id=req.user_id or "default",
        )
        return JSONResponse(content=result)
    except Exception as exc:
        logger.exception("Error in add_episodic_schema:")
        raise HTTPException(status_code=500, detail=str(exc))


@app.put("/memories/context", summary="Upsert semantic context")
async def upsert_semantic_context(req: UpsertContextRequest) -> JSONResponse:
    """Create or update the semantic context for a camera."""
    mgr = _ensure_initialized()
    try:
        result = await mgr.upsert_semantic_context(
            camera_id=req.camera_id,
            scene_description=req.scene_description,
            known_entities=req.known_entities,
            daily_routine=req.daily_routine,
            anomaly_baseline=req.anomaly_baseline,
            user_notes=req.user_notes or "",
            user_id=req.user_id or "default",
            last_llm_update=req.last_llm_update,
            last_update_segment_count=req.last_update_segment_count,
            last_agent_consult=req.last_agent_consult,
            last_consult_segment_count=req.last_consult_segment_count,
            consecutive_no_updates=req.consecutive_no_updates,
        )
        return JSONResponse(content=result)
    except Exception as exc:
        logger.exception("Error in upsert_semantic_context:")
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/memories/{memory_id}/history", summary="Get memory history")
async def memory_history(memory_id: str) -> Any:
    """Retrieve memory history."""
    mgr = _ensure_initialized()
    try:
        history = await mgr.get_history(memory_id)
        if not history:
            raise HTTPException(
                status_code=404, detail=f"No history found for memory ID {memory_id}"
            )
        return history
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Error in memory_history:")
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/memories/{memory_id}", summary="Get a memory")
async def get_memory(
    memory_id: str,
    memory_type: Optional[str] = None,
    return_all_matches: bool = False,
) -> Any:
    """Retrieve a specific memory by ID."""
    mgr = _ensure_initialized()
    try:
        memory = await mgr.get_memory(
            memory_id, memory_type=memory_type, return_all_matches=return_all_matches,
        )
        if memory is None:
            raise HTTPException(
                status_code=404, detail=f"Memory with ID {memory_id} not found"
            )
        return memory
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Error in get_memory:")
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/search", summary="Search memories")
async def search_memories(search_req: SearchRequest) -> Any:
    """Search for memories based on query."""
    mgr = _ensure_initialized()
    try:
        return await mgr.search_memories(
            query=search_req.query,
            user_id=search_req.user_id,
            agent_id=search_req.agent_id,
            run_id=search_req.run_id,
            video_id=search_req.video_id,
            entity_id=search_req.entity_id,
            camera_id=search_req.camera_id,
            mode=search_req.mode,
            memory_type=search_req.memory_type,
            limit=search_req.limit or 100,
            threshold=search_req.threshold,
            filters=search_req.filters,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.exception("Error in search_memories:")
        raise HTTPException(status_code=500, detail=str(exc))


@app.put("/memories/{memory_id}", summary="Update a memory")
async def update_memory(
    memory_id: str,
    update_req: UpdateMemoryRequest,
    memory_type: Optional[str] = None,
) -> Any:
    """Update an existing memory."""
    mgr = _ensure_initialized()
    try:
        return await mgr.update_memory(
            memory_id=memory_id,
            data=update_req.data,
            memory_type=memory_type,
            data_type=update_req.data_type or "txt",
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        logger.exception("Error in update_memory:")
        raise HTTPException(status_code=500, detail=str(exc))


@app.delete("/memories/{memory_id}", summary="Delete a memory")
async def delete_memory(
    memory_id: str,
    memory_type: Optional[str] = None,
    data_type: Optional[str] = "txt",
) -> Any:
    """Delete a specific memory by ID."""
    mgr = _ensure_initialized()
    try:
        return await mgr.delete_memory(
            memory_id=memory_id,
            memory_type=memory_type,
            data_type=data_type or "txt",
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        logger.exception("Error in delete_memory:")
        raise HTTPException(status_code=500, detail=str(exc))


@app.delete("/memories", summary="Delete all memories")
async def delete_all_memories(
    user_id: Optional[str] = None,
    agent_id: Optional[str] = None,
    run_id: Optional[str] = None,
    video_id: Optional[str] = None,
    entity_id: Optional[str] = None,
    camera_id: Optional[str] = None,
    memory_type: Optional[str] = None,
    data_type: Optional[str] = None,
) -> Any:
    """Delete all memories for given identifiers."""
    mgr = _ensure_initialized()
    if not any([user_id, agent_id, run_id, video_id, entity_id, camera_id]):
        raise HTTPException(status_code=400, detail="At least one identifier is required.")
    try:
        return await mgr.delete_all_memories(
            user_id=user_id, agent_id=agent_id, run_id=run_id,
            video_id=video_id, entity_id=entity_id, camera_id=camera_id,
            memory_type=memory_type, data_type=data_type,
        )
    except Exception as exc:
        logger.exception("Error in delete_all_memories:")
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/reid/search", summary="Search ReID feature vectors")
async def reid_search(req: ReidSearchRequest) -> JSONResponse:
    """Search for the most similar feature vectors in a ReID collection."""
    _ensure_initialized()
    if reid is None:
        raise HTTPException(status_code=503, detail="ReID manager not initialized")
    manager = reid

    valid_collections = {"reid_entity", "reid_face"}
    if req.collection not in valid_collections:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid collection '{req.collection}'. Must be one of: {valid_collections}",
        )

    try:
        def _search_with_optional_history() -> dict[str, Any]:
            result = manager.search(
                vector=req.vector, collection=req.collection,
                limit=req.limit, threshold=req.threshold,
                user_id=req.user_id,
            )
            if req.include_history and result.get("results"):
                best = result["results"][0]
                eid = best.get("entity_id")
                if eid:
                    memories = manager.get_entity_memories(eid, user_id=req.user_id)
                    best["semantic_memories"] = memories["semantic_memories"]
                    best["episodic_memories"] = memories["episodic_memories"]
            return result

        result = await _run_sync_reid_call(_search_with_optional_history)
        return JSONResponse(content=result)
    except Exception as exc:
        logger.exception("Error in reid_search:")
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/reid/upsert", summary="Upsert ReID feature vector")
async def reid_upsert(req: ReidUpsertRequest) -> JSONResponse:
    """Insert or update a feature vector for an entity in a ReID collection."""
    _ensure_initialized()
    if reid is None:
        raise HTTPException(status_code=503, detail="ReID manager not initialized")
    manager = reid

    valid_collections = {"reid_entity", "reid_face"}
    if req.collection not in valid_collections:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid collection '{req.collection}'. Must be one of: {valid_collections}",
        )

    try:
        result = await _run_sync_reid_call(
            manager.upsert,
            entity_id=req.entity_id, vector=req.vector,
            collection=req.collection, quality=req.quality,
            yaw=req.yaw, pitch=req.pitch, user_id=req.user_id,
            camera_id=req.camera_id, metadata=req.metadata,
            category=req.category, subject_index=req.subject_index,
            name=req.name, first_seen=req.first_seen,
        )
        return JSONResponse(content=result)
    except Exception as exc:
        logger.exception("Error in reid_upsert:")
        raise HTTPException(status_code=500, detail=str(exc))


@app.patch("/reid/identity", summary="Update ReID identity metadata")
async def reid_update_identity(req: ReidUpdateIdentityRequest) -> JSONResponse:
    """Update a ReID entity's real-world name across all gallery slots."""
    _ensure_initialized()
    if reid is None:
        raise HTTPException(status_code=503, detail="ReID manager not initialized")
    manager = reid

    try:
        result = await _run_sync_reid_call(
            manager.update_identity,
            entity_id=req.entity_id,
            name=req.name,
            user_id=req.user_id,
            subject_index=req.subject_index,
        )
        return JSONResponse(content=result)
    except Exception as exc:
        logger.exception("Error in reid_update_identity:")
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/reid/gallery-update", summary="Gallery-aware ReID feature update")
async def reid_gallery_update(req: ReidGalleryUpdateRequest) -> JSONResponse:
    """Diversity-aware gallery update for an existing entity.

    Adds new viewpoints, refreshes higher-quality versions of existing
    viewpoints, or skips if the gallery already has a better version.
    """
    _ensure_initialized()
    if reid is None:
        raise HTTPException(status_code=503, detail="ReID manager not initialized")
    manager = reid

    valid_collections = {"reid_entity", "reid_face"}
    if req.collection not in valid_collections:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid collection '{req.collection}'. Must be one of: {valid_collections}",
        )

    try:
        result = await _run_sync_reid_call(
            manager.gallery_update,
            entity_id=req.entity_id, vector=req.vector,
            collection=req.collection, quality=req.quality,
            yaw=req.yaw, pitch=req.pitch,
            body_yaw_ratio=req.body_yaw_ratio, visibility=req.visibility,
            user_id=req.user_id, camera_id=req.camera_id,
        )
        return JSONResponse(content=result)
    except Exception as exc:
        logger.exception("Error in reid_gallery_update:")
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/reid/batch-init", summary="Batch-initialize ReID entity gallery")
async def reid_batch_init_route(req: ReidBatchInitRequest) -> JSONResponse:
    """Initialize a ReID entity gallery with multiple embedding slots in one request.

    Face vectors are written first; body vectors follow.
    Partial success (face OK, body failed) returns HTTP 200.
    """
    _ensure_initialized()
    if reid is None:
        raise HTTPException(status_code=503, detail="ReID manager not initialized")
    manager = reid

    if not req.face_vectors and not req.body_vectors:
        raise HTTPException(status_code=400, detail="At least one of face_vectors or body_vectors is required")

    try:
        result = await _run_sync_reid_call(
            manager.batch_init,
            entity_id=req.entity_id,
            face_vectors=[v.model_dump() for v in req.face_vectors] if req.face_vectors else None,
            body_vectors=[v.model_dump() for v in req.body_vectors] if req.body_vectors else None,
            user_id=req.user_id,
            camera_id=req.camera_id,
            category=req.category,
            subject_index=req.subject_index,
            name=req.name,
            first_seen=req.first_seen,
        )
        return JSONResponse(content=result)
    except Exception as exc:
        logger.exception("Error in reid_batch_init:")
        raise HTTPException(status_code=500, detail=str(exc))


@app.delete("/reid", summary="Delete ReID vectors for a camera/source")
async def reid_delete(camera_id: str, user_id: Optional[str] = None) -> JSONResponse:
    """Delete ReID vectors tagged with camera_id.

    This is source lifecycle cleanup only. ReID search remains scoped by user_id
    and does not filter by camera_id.
    """
    _ensure_initialized()
    if reid is None:
        raise HTTPException(status_code=503, detail="ReID manager not initialized")
    manager = reid
    try:
        result = await _run_sync_reid_call(manager.delete_by_camera, camera_id=camera_id, user_id=user_id)
        return JSONResponse(content=result)
    except Exception as exc:
        logger.exception("Error in reid_delete:")
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/reid/reset", summary="Reset ReID collections only")
async def reid_reset() -> JSONResponse:
    """Delete and recreate reid_face and reid_entity collections.

    Does NOT touch episodic/semantic/procedural memory.
    """
    _ensure_initialized()
    if reid is None:
        raise HTTPException(status_code=503, detail="ReID manager not initialized")
    manager = reid
    try:
        result = await _run_sync_reid_call(manager.reset_reid)
        return JSONResponse(content=result)
    except Exception as exc:
        logger.exception("Error in reid_reset:")
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/reset", summary="Reset all memories")
async def reset_memory() -> dict[str, str]:
    """Completely reset stored memories."""
    mgr = _ensure_initialized()
    try:
        await mgr.reset()
        return {"message": "All memories reset successfully"}
    except Exception as exc:
        logger.exception("Error in reset_memory:")
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/ensure-collections", summary="Ensure all Qdrant collections exist")
async def ensure_collections() -> dict[str, Any]:
    """Re-run collection creation for the current prefix.

    Idempotent: creates missing collections without touching existing ones.
    Useful when a managed service outlives its original collections (e.g. after
    E2E cleanup deletes them while the Python process stays alive).
    """
    mgr = _ensure_initialized()
    store = mgr.store
    await asyncio.to_thread(store._ensure_collections)
    await asyncio.to_thread(store._ensure_payload_indexes)
    return {
        "status": "ok",
        "prefix": store.prefix,
        "collections": [store.collection_name(s) for s in COLLECTION_SPECS],
    }


@app.get("/health", summary="Health check", include_in_schema=False)
async def health_check() -> dict[str, Any]:
    """Health check endpoint."""
    return {
        "status": "healthy",
        "version": "1.1.0",
        "service": "Cortex Memory",
        "collection_prefix": config.collection_prefix,
        "memory_types": [
            "episodic_trace", "episodic_entity", "episodic_schema",
            "episodic_visual", "semantic_entity", "semantic_context",
            "procedural",
        ],
        "reid_collections": ["reid_entity", "reid_face"],
        "vector_store": "qdrant",
        "llm_provider": config.llm_provider,
        "embedder_provider": config.embedder_provider,
    }


@app.get("/status", summary="Get memory manager status")
async def get_status() -> dict[str, Any]:
    """Get memory manager status and statistics."""
    is_initialized = async_manager is not None
    return {
        "status": "healthy" if is_initialized else "not_initialized",
        "version": "1.1.0",
        "service": "Cortex Memory",
        "memory_types": [
            "episodic_trace", "episodic_entity", "episodic_schema",
            "episodic_visual", "semantic_entity", "semantic_context",
            "procedural",
        ],
        "reid_collections": ["reid_entity", "reid_face"],
        "vector_store": "qdrant",
        "llm_provider": config.llm_provider,
        "embedder_provider": config.embedder_provider,
        "initialized": is_initialized,
    }
