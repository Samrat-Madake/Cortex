"""Unit tests for ReID route event-loop offloading."""

import json

import pytest
from fastapi.responses import JSONResponse

from src import main
from src.models import (
    ReidBatchInitRequest,
    ReidGalleryUpdateRequest,
    ReidSearchRequest,
    ReidUpdateIdentityRequest,
    ReidUpsertRequest,
)


class FakeReid:
    def search(self, **kwargs):
        return {
            "collection": kwargs["collection"],
            "results": [{"entity_id": "entity-1", "score": 1.0}],
        }

    def get_entity_memories(self, entity_id, user_id=None):
        return {
            "semantic_memories": [f"semantic:{entity_id}:{user_id}"],
            "episodic_memories": [f"episodic:{entity_id}:{user_id}"],
        }

    def upsert(self, **kwargs):
        return {"entity_id": kwargs["entity_id"], "event": "INSERT"}

    def update_identity(self, **kwargs):
        return {"entity_id": kwargs["entity_id"], "updated": 1}

    def gallery_update(self, **kwargs):
        return {"entity_id": kwargs["entity_id"], "action": "ADD"}

    def batch_init(self, **kwargs):
        return {"entity_id": kwargs["entity_id"], "event": "BATCH_INIT"}

    def delete_by_camera(self, **kwargs):
        return {"deleted": {"camera_id": kwargs["camera_id"]}}

    def reset_reid(self):
        return {"deleted_collections": ["reid_entity", "reid_face"]}


def response_json(response: JSONResponse) -> dict:
    return json.loads(response.body.decode("utf-8"))


@pytest.mark.asyncio
async def test_reid_routes_run_manager_work_in_thread(monkeypatch):
    fake = FakeReid()
    calls: list[str] = []

    async def fake_to_thread(func, /, *args, **kwargs):
        assert func is main._call_sync_reid_serialized
        calls.append(getattr(args[0], "__name__", repr(args[0])))
        return func(*args, **kwargs)

    monkeypatch.setattr(main, "_ensure_initialized", lambda: object())
    monkeypatch.setattr(main, "reid", fake)
    monkeypatch.setattr(main.asyncio, "to_thread", fake_to_thread)

    search = await main.reid_search(
        ReidSearchRequest(
            vector=[1.0, 0.0],
            collection="reid_face",
            include_history=True,
            user_id="user-1",
        )
    )
    assert response_json(search)["results"][0]["semantic_memories"] == ["semantic:entity-1:user-1"]

    await main.reid_upsert(
        ReidUpsertRequest(entity_id="entity-1", vector=[1.0], collection="reid_face")
    )
    await main.reid_update_identity(
        ReidUpdateIdentityRequest(entity_id="entity-1", name="Alex")
    )
    await main.reid_gallery_update(
        ReidGalleryUpdateRequest(entity_id="entity-1", vector=[1.0], collection="reid_face")
    )
    await main.reid_batch_init_route(
        ReidBatchInitRequest(
            entity_id="entity-1",
            face_vectors=[{"vector": [1.0], "quality": 0.9}],
        )
    )
    await main.reid_delete(camera_id="cam-1", user_id="user-1")
    await main.reid_reset()

    assert calls == [
        "_search_with_optional_history",
        "upsert",
        "update_identity",
        "gallery_update",
        "batch_init",
        "delete_by_camera",
        "reset_reid",
    ]
