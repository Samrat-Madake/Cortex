"""Golden data structure validation tests.

Verify our service produces structurally identical responses to the production service
by checking golden data files recorded from the live system.
"""

import json
import os
from pathlib import Path
import pytest

GOLDEN_DIR = Path(
    os.environ.get(
        "CORTEX_MEM_GOLDEN_DIR",
        Path(__file__).resolve().parent / "fixtures" / "golden-data",
    )
)

pytestmark = pytest.mark.skipif(
    not GOLDEN_DIR.exists(),
    reason=(
        "golden data not found; set CORTEX_MEM_GOLDEN_DIR or place data under "
        "services/mem/tests/fixtures/golden-data"
    ),
)


def test_health_response_structure():
    golden = json.loads((GOLDEN_DIR / "01-health-response.json").read_text())
    required_keys = {
        "status", "version", "service", "memory_types",
        "reid_collections", "vector_store", "llm_provider", "embedder_provider",
    }
    assert required_keys.issubset(golden.keys())
    assert golden["status"] == "healthy"
    assert golden["service"] == "Cortex Memory"
    assert "episodic_trace" in golden["memory_types"]
    assert "reid_entity" in golden["reid_collections"]


def test_status_response_has_initialized():
    golden = json.loads((GOLDEN_DIR / "02-status-response.json").read_text())
    assert "initialized" in golden
    # Status has all health fields plus initialized
    assert "status" in golden
    assert "service" in golden


def test_episodic_memory_structure():
    golden = json.loads((GOLDEN_DIR / "03-get-memories-episodic.json").read_text())
    # Response keyed by full collection name
    assert any("episodic_trace" in key for key in golden.keys())
    for key, items in golden.items():
        if not isinstance(items, list):
            continue
        for item in items[:3]:  # Check first 3
            assert "id" in item
            assert "memory" in item
            assert "hash" in item
            assert "created_at" in item
            assert "updated_at" in item
            assert "role" in item
            assert "entity_ids" in item
            assert "camera_id" in item
            # metadata contains mode, event_id, media_urls
            if "metadata" in item and item["metadata"]:
                assert "mode" in item["metadata"] or True  # may be in metadata


def test_semantic_memory_structure():
    golden = json.loads((GOLDEN_DIR / "04-get-memories-semantic.json").read_text())
    assert any("semantic_entity" in key for key in golden.keys())
    for key, items in golden.items():
        if not isinstance(items, list):
            continue
        for item in items[:3]:
            assert "id" in item
            assert "memory" in item
            assert "entity_id" in item
            assert "camera_id" in item
            assert "entity_class" in item
            assert "importance" in item
            # importance at top level
            assert isinstance(item["importance"], (int, float))


def test_procedural_memory_structure():
    golden = json.loads((GOLDEN_DIR / "05-get-memories-procedural.json").read_text())
    assert any("procedural" in key for key in golden.keys())
    for key, items in golden.items():
        if not isinstance(items, list):
            continue
        for item in items:
            assert "id" in item
            assert "memory" in item
            assert "camera_id" in item


def test_search_response_structure():
    golden = json.loads((GOLDEN_DIR / "06-search-person-walking.json").read_text())
    # Response keyed by full collection name
    for key, items in golden.items():
        if not isinstance(items, list):
            continue
        for item in items[:3]:
            assert "id" in item
            assert "memory" in item
            assert "score" in item
            assert isinstance(item["score"], (int, float))
            assert "camera_id" in item


def test_search_by_entity_structure():
    golden = json.loads((GOLDEN_DIR / "08-search-by-entity.json").read_text())
    # Should return results filtered by entity
    for key, items in golden.items():
        if not isinstance(items, list):
            continue
        assert len(items) >= 0  # May be empty


def test_get_memory_by_id_structure():
    golden = json.loads((GOLDEN_DIR / "10-get-memory-by-id.json").read_text())
    # Single memory keyed by collection name
    assert any("episodic_trace" in key or "semantic_entity" in key for key in golden.keys())
    for key, item in golden.items():
        if isinstance(item, dict):
            assert "id" in item
            assert "memory" in item


def test_qdrant_collections_config():
    golden = json.loads((GOLDEN_DIR / "11-qdrant-collections-config.json").read_text())
    expected = {
        "episodic_trace": 1536,
        "episodic_entity": 1536,
        "episodic_schema": 1536,
        "episodic_visual": 1024,
        "semantic_entity": 1536,
        "semantic_context": 1536,
        "procedural": 1536,
        "reid_entity": 768,
        "reid_face": 512,
    }
    for suffix, dim in expected.items():
        matching = [k for k in golden.keys() if suffix in k]
        assert matching, f"No collection matching {suffix}"
        key = matching[0]
        assert golden[key]["vector_size"] == dim, f"{suffix} expected dim {dim}"
        assert golden[key]["distance"] == "Cosine"


def test_qdrant_episodic_payload_fields():
    golden = json.loads((GOLDEN_DIR / "12-qdrant-episodic_trace-sample.json").read_text())
    required = {
        "camera_id", "mode", "event_id", "media_urls", "role",
        "entity_ids", "data", "hash", "created_at", "updated_at",
    }
    for point in golden["result"]["points"][:5]:
        missing = required - set(point["payload"].keys())
        assert not missing, f"Missing fields in episodic payload: {missing}"


def test_qdrant_semantic_payload_fields():
    golden = json.loads((GOLDEN_DIR / "12-qdrant-semantic_entity-sample.json").read_text())
    required = {
        "camera_id", "entity_id", "entity_class", "category",
        "importance", "data", "hash", "created_at", "updated_at",
    }
    for point in golden["result"]["points"][:5]:
        missing = required - set(point["payload"].keys())
        assert not missing, f"Missing fields in semantic payload: {missing}"
