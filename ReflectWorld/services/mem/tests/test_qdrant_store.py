"""Integration tests for QdrantStore against a live Qdrant instance."""

import time

import pytest

from src.config import MemConfig
from src.qdrant_store import COLLECTION_SPECS, QdrantStore

pytestmark = pytest.mark.qdrant


@pytest.fixture(scope="module")
def store(requires_qdrant):
    config = MemConfig(
        collection_prefix="reflectworld_pytest",
        qdrant_host=requires_qdrant.host,
        qdrant_port=requires_qdrant.port,
    )
    s = QdrantStore(config)
    yield s
    for suffix in COLLECTION_SPECS:
        try:
            s.delete_collection(suffix)
        except Exception:
            pass


def test_collections_created(store: QdrantStore) -> None:
    for suffix, dim in COLLECTION_SPECS.items():
        info = store.get_collection_info(suffix)
        assert info is not None, f"Collection {suffix} not created"
        assert info["vector_size"] == dim, f"Collection {suffix} wrong dim"


def test_insert_and_get(store: QdrantStore) -> None:
    pid = store.insert(
        "episodic_trace",
        vector=[0.1] * 1536,
        payload={"data": "test memory", "camera_id": "cam1"},
    )
    time.sleep(0.5)
    result = store.get("episodic_trace", pid)
    assert result is not None
    assert result["payload"]["data"] == "test memory"
    assert result["payload"]["camera_id"] == "cam1"


def test_search(store: QdrantStore) -> None:
    store.insert(
        "semantic_entity",
        vector=[0.3] * 1536,
        payload={"data": "person pattern", "camera_id": "cam1", "entity_id": "e1"},
    )
    time.sleep(0.5)
    results = store.search("semantic_entity", vector=[0.3] * 1536, limit=5)
    assert len(results) >= 1
    assert results[0]["score"] > 0.9


def test_search_with_filter(store: QdrantStore) -> None:
    store.insert(
        "episodic_trace",
        vector=[0.4] * 1536,
        payload={"data": "a", "camera_id": "filter_cam1"},
    )
    store.insert(
        "episodic_trace",
        vector=[0.5] * 1536,
        payload={"data": "b", "camera_id": "filter_cam2"},
    )
    time.sleep(0.5)
    results = store.search(
        "episodic_trace",
        vector=[0.4] * 1536,
        filters={"camera_id": "filter_cam1"},
        limit=5,
    )
    assert all(r["payload"]["camera_id"] == "filter_cam1" for r in results)


def test_scroll(store: QdrantStore) -> None:
    store.insert(
        "procedural",
        vector=[0.6] * 1536,
        payload={"data": "rule 1", "camera_id": "scroll_cam"},
    )
    store.insert(
        "procedural",
        vector=[0.7] * 1536,
        payload={"data": "rule 2", "camera_id": "scroll_cam"},
    )
    time.sleep(0.5)
    results = store.scroll(
        "procedural", filters={"camera_id": "scroll_cam"}, limit=10
    )
    assert len(results) >= 2


def test_delete(store: QdrantStore) -> None:
    pid = store.insert(
        "episodic_trace",
        vector=[0.8] * 1536,
        payload={"data": "to delete", "camera_id": "del_cam"},
    )
    time.sleep(0.5)
    deleted = store.delete("episodic_trace", pid)
    assert deleted is not None
    time.sleep(0.5)
    assert store.get("episodic_trace", pid) is None


def test_get_with_vectors(store: QdrantStore) -> None:
    vector = [0.85] * 1536
    pid = store.insert(
        "episodic_trace",
        vector=vector,
        payload={"data": "with vector", "camera_id": "get_vec_cam"},
    )
    time.sleep(0.5)

    point = store.get("episodic_trace", pid, with_vectors=True)

    assert point is not None
    assert point["payload"]["data"] == "with vector"
    assert isinstance(point["vector"], list)
    assert len(point["vector"]) == len(vector)


def test_set_payload(store: QdrantStore) -> None:
    pid = store.insert(
        "episodic_trace",
        vector=[0.9] * 1536,
        payload={"data": "x", "media_urls": ["url1"]},
    )
    time.sleep(0.5)
    store.set_payload("episodic_trace", pid, {"media_urls": None})
    time.sleep(0.5)
    result = store.get("episodic_trace", pid)
    assert result is not None
    # Qdrant removes keys set to None from the payload
    assert "media_urls" not in result["payload"]


def test_entity_ids_match_any(store: QdrantStore) -> None:
    store.insert(
        "episodic_trace",
        vector=[0.11] * 1536,
        payload={
            "data": "a",
            "entity_ids": ["e_match1", "e_match2"],
            "camera_id": "match_cam",
        },
    )
    store.insert(
        "episodic_trace",
        vector=[0.12] * 1536,
        payload={
            "data": "b",
            "entity_ids": ["e_match3"],
            "camera_id": "match_cam",
        },
    )
    time.sleep(0.5)
    results = store.scroll(
        "episodic_trace",
        filters={"entity_ids": {"match_any": ["e_match1"]}},
        limit=10,
    )
    assert len(results) >= 1
    assert any(
        "e_match1" in r["payload"].get("entity_ids", []) for r in results
    )


def test_collection_specs_has_nine_collections():
    from src.qdrant_store import COLLECTION_SPECS
    assert len(COLLECTION_SPECS) == 9
    assert "episodic_trace" in COLLECTION_SPECS
    assert "episodic_entity" in COLLECTION_SPECS
    assert "episodic_schema" in COLLECTION_SPECS
    assert "episodic_visual" in COLLECTION_SPECS
    assert "semantic_entity" in COLLECTION_SPECS
    assert "semantic_context" in COLLECTION_SPECS
    assert "procedural" in COLLECTION_SPECS
    assert "reid_face" in COLLECTION_SPECS
    assert "reid_entity" in COLLECTION_SPECS
    assert "episodic_txt" not in COLLECTION_SPECS
    assert "semantic_txt" not in COLLECTION_SPECS
    assert "procedural_txt" not in COLLECTION_SPECS
    assert "semantic_face" not in COLLECTION_SPECS
    assert "semantic_body" not in COLLECTION_SPECS


def test_reid_collections(store: QdrantStore) -> None:
    store.insert(
        "reid_entity", vector=[0.1] * 768, payload={"entity_id": "re1"}
    )
    store.insert(
        "reid_face", vector=[0.1] * 512, payload={"entity_id": "rf1"}
    )
    time.sleep(0.5)
    re = store.scroll("reid_entity", limit=1)
    rf = store.scroll("reid_face", limit=1)
    assert len(re) >= 1
    assert len(rf) >= 1
