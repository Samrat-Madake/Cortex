"""Integration tests for the new episodic_schema and semantic_context endpoints.

Requires a writable Qdrant instance. Configure with QDRANT_TEST_URL or
REFLECTWORLD_TEST_QDRANT_HOST/PORT.
Tests validate the POST /memories/schema, PUT /memories/context endpoints,
and the POST /memories guard that rejects schema/context memory types.
"""

import asyncio
import importlib
import os
import sys
from unittest.mock import patch

import pytest
from httpx import ASGITransport, AsyncClient

pytestmark = pytest.mark.qdrant

TEST_ENV = {
    "COLLECTION_PREFIX": "reflectworld_newep_test",
    "PORT": "8222",
    "STORAGE_PATH": "/tmp/reflectworld_newep_test",
    "HISTORY_DB_PATH": "/tmp/reflectworld_newep_test/history.db",
}


@pytest.fixture(scope="module")
def _initialized_app(requires_qdrant):
    """Import (or reload) the app module with test env and run startup.

    Mirrors the pattern in test_api.py: set env vars before loading
    src.main so MemConfig.from_env() picks up the test prefix, then
    manually trigger startup() to initialise the async_manager.
    """
    saved_config = sys.modules.get("src.config")
    saved_main = sys.modules.get("src.main")

    env = {
        **TEST_ENV,
        "QDRANT_HOST": requires_qdrant.host,
        "QDRANT_PORT": str(requires_qdrant.port),
    }

    with patch.dict(os.environ, env):
        if "src.main" in sys.modules:
            importlib.reload(sys.modules["src.config"])
            main_mod = importlib.reload(sys.modules["src.main"])
        else:
            import src.main as main_mod  # type: ignore[import-untyped]

        loop = asyncio.new_event_loop()
        loop.run_until_complete(main_mod.startup())
        loop.close()

        yield main_mod.app

        # Cleanup: delete test collections so they don't leak.
        if main_mod.async_manager is not None:
            store = main_mod.async_manager.store
            from src.qdrant_store import COLLECTION_SPECS

            for suffix in COLLECTION_SPECS:
                coll = f"reflectworld_newep_test_{suffix}"
                try:
                    store.client.delete_collection(coll)
                except Exception:
                    pass

    if saved_config is not None:
        importlib.reload(saved_config)
    if saved_main is not None:
        importlib.reload(saved_main)


@pytest.fixture
async def client(_initialized_app):
    """Create an async test client backed by the initialised ASGI app."""
    transport = ASGITransport(app=_initialized_app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


# ---------------------------------------------------------------------------
# POST /memories/schema — episodic schema creation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_add_episodic_schema(client):
    """POST /memories/schema with valid payload returns 200 and correct shape."""
    payload = {
        "summary": "Person arrives home, unloads groceries, enters through front door.",
        "event_ids": ["evt_001", "evt_002", "evt_003"],
        "time_range": {"start_ms": 1000, "end_ms": 5000},
        "camera_id": "cam_front_door",
    }
    resp = await client.post("/memories/schema", json=payload)
    assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"

    data = resp.json()
    assert data["collection"] == "episodic_schema"
    assert data["event"] == "ADD"
    assert "id" in data and len(data["id"]) > 0


# ---------------------------------------------------------------------------
# PUT /memories/context — semantic context upsert idempotency
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_upsert_semantic_context_idempotent(client):
    """PUT /memories/context twice with same (camera_id, user_id) returns same point ID.

    This proves upsert semantics: the deterministic uuid5 ensures that
    updating the same camera's context overwrites rather than duplicates.
    """
    base_payload = {
        "camera_id": "cam_backyard",
        "known_entities": "dog, mail carrier",
        "daily_routine": "dog goes out at 7am and 5pm",
        "anomaly_baseline": "no nighttime activity expected",
        "user_id": "test_user",
    }

    # First upsert
    payload_1 = {**base_payload, "scene_description": "Backyard with fence and garden"}
    resp_1 = await client.put("/memories/context", json=payload_1)
    assert resp_1.status_code == 200, f"First upsert failed: {resp_1.text}"
    data_1 = resp_1.json()
    assert data_1["collection"] == "semantic_context"
    assert data_1["event"] == "UPSERT"

    # Second upsert with different scene_description
    payload_2 = {**base_payload, "scene_description": "Backyard with new shed and pool"}
    resp_2 = await client.put("/memories/context", json=payload_2)
    assert resp_2.status_code == 200, f"Second upsert failed: {resp_2.text}"
    data_2 = resp_2.json()
    assert data_2["collection"] == "semantic_context"
    assert data_2["event"] == "UPSERT"

    # Same (camera_id, user_id) must produce the same deterministic point ID
    assert data_1["id"] == data_2["id"], (
        f"Expected identical point IDs for same (camera_id, user_id), "
        f"got {data_1['id']} vs {data_2['id']}"
    )


# ---------------------------------------------------------------------------
# POST /memories rejects episodic_schema / semantic_context memory types
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_post_memories_rejects_episodic_schema(client):
    """POST /memories with memory_type='episodic_schema' must return 400."""
    payload = {
        "video_data": {"summary": "test"},
        "user_id": "test_user",
        "camera_id": "cam_front_door",
        "memory_type": "episodic_schema",
    }
    resp = await client.post("/memories", json=payload)
    assert resp.status_code == 400, f"Expected 400, got {resp.status_code}: {resp.text}"
    assert "dedicated endpoint" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_post_memories_rejects_semantic_context(client):
    """POST /memories with memory_type='semantic_context' must return 400."""
    payload = {
        "video_data": {"summary": "test"},
        "user_id": "test_user",
        "camera_id": "cam_front_door",
        "memory_type": "semantic_context",
    }
    resp = await client.post("/memories", json=payload)
    assert resp.status_code == 400, f"Expected 400, got {resp.status_code}: {resp.text}"
    assert "dedicated endpoint" in resp.json()["detail"].lower()
