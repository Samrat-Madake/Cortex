"""API integration tests for key scenarios.

Requires a writable Qdrant instance. Configure with QDRANT_TEST_URL or
REFLECTWORLD_TEST_QDRANT_HOST/PORT.
Tests that require real LLM/Embedder are marked and may be skipped in CI.
Tests that only need Qdrant run against the local instance.
"""

import asyncio
import importlib
import os
import sys
import time
from unittest.mock import patch

import pytest
from httpx import ASGITransport, AsyncClient

pytestmark = pytest.mark.qdrant

TEST_ENV = {
    "COLLECTION_PREFIX": "reflectworld_apitest",
    "PORT": "8221",
    "STORAGE_PATH": "/tmp/reflectworld_apitest",
    "HISTORY_DB_PATH": "/tmp/reflectworld_apitest/history.db",
}


@pytest.fixture(scope="module")
def _initialized_app(requires_qdrant):
    """Import (or reload) the app module with test env and run startup.

    Because ``src.main`` builds ``config`` at module level on first import,
    we must ensure the test environment variables are set *before* the module
    is (re-)loaded.  After loading we call ``startup()`` so that
    ``async_manager`` and ``reid`` are initialised against the local Qdrant.
    """
    # Save original module references so we can restore them after tests
    saved_config = sys.modules.get("src.config")
    saved_main = sys.modules.get("src.main")

    env = {
        **TEST_ENV,
        "QDRANT_HOST": requires_qdrant.host,
        "QDRANT_PORT": str(requires_qdrant.port),
    }

    with patch.dict(os.environ, env):
        # Force a fresh module load so MemConfig.from_env() picks up TEST_ENV.
        if "src.main" in sys.modules:
            importlib.reload(sys.modules["src.config"])
            main_mod = importlib.reload(sys.modules["src.main"])
        else:
            import src.main as main_mod  # type: ignore[import-untyped]

        # Trigger the on_event("startup") handler manually.
        loop = asyncio.new_event_loop()
        loop.run_until_complete(main_mod.startup())
        loop.close()

        yield main_mod.app

        # Cleanup: delete test collections so they don't leak.
        if main_mod.async_manager is not None:
            store = main_mod.async_manager.store
            from src.qdrant_store import COLLECTION_SPECS

            for suffix in COLLECTION_SPECS:
                coll = f"reflectworld_apitest_{suffix}"
                try:
                    store.client.delete_collection(coll)
                except Exception:
                    pass

    # Restore original modules so other test files get clean state
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
# Health / Status
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_health(client):
    resp = await client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "healthy"
    assert data["service"] == "ReflectWorld Memory"
    assert "episodic_trace" in data["memory_types"]
    assert "reid_entity" in data["reid_collections"]
    assert data["vector_store"] == "qdrant"


@pytest.mark.asyncio
async def test_status(client):
    resp = await client.get("/status")
    assert resp.status_code == 200
    data = resp.json()
    assert "initialized" in data
    assert data["service"] == "ReflectWorld Memory"


# ---------------------------------------------------------------------------
# Error paths (validation / not-found)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_e1_no_identifier_add(client):
    """E1: POST /memories without any identifier -> 400."""
    resp = await client.post("/memories", json={"video_data": {"summary": "test"}})
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_e3_nonexistent_id(client):
    """E3: GET /memories/nonexistent -> 404."""
    resp = await client.get("/memories/nonexistent-uuid-12345")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_b6_invalid_reid_collection(client):
    """B6: POST /reid/search with invalid collection -> 400."""
    resp = await client.post("/reid/search", json={
        "vector": [0.1] * 768,
        "collection": "invalid",
    })
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# ReID upsert / search
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_b1_reid_face_upsert(client):
    """B1: POST /reid/upsert with 512d vector to reid_face."""
    resp = await client.post("/reid/upsert", json={
        "entity_id": "test_face_e1",
        "vector": [0.1] * 512,
        "collection": "reid_face",
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["entity_id"] == "test_face_e1"
    assert data["event"] in ("INSERT", "UPDATE")
    assert data["collection"] == "reid_face"


@pytest.mark.asyncio
async def test_b3_reid_entity_upsert(client):
    """B3: POST /reid/upsert with 768d vector to reid_entity."""
    resp = await client.post("/reid/upsert", json={
        "entity_id": "test_body_e1",
        "vector": [0.2] * 768,
        "collection": "reid_entity",
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["event"] in ("INSERT", "UPDATE")


@pytest.mark.asyncio
async def test_b2_reid_face_search(client):
    """B2: Search reid_face after upsert."""
    # Upsert first
    await client.post("/reid/upsert", json={
        "entity_id": "search_face_e1",
        "vector": [0.5] * 512,
        "collection": "reid_face",
    })
    time.sleep(0.5)

    resp = await client.post("/reid/search", json={
        "vector": [0.5] * 512,
        "collection": "reid_face",
        "limit": 5,
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["collection"] == "reid_face"
    assert len(data["results"]) >= 1
