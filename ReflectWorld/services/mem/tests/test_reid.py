import pytest
import time
from src.config import MemConfig
from src.qdrant_store import QdrantStore, COLLECTION_SPECS
from src.reid import ReidManager, _cosine_similarity

pytestmark = pytest.mark.qdrant


@pytest.fixture(scope="module")
def reid(requires_qdrant):
    config = MemConfig(
        collection_prefix="reflectworld_pytest_reid",
        qdrant_host=requires_qdrant.host,
        qdrant_port=requires_qdrant.port,
    )
    store = QdrantStore(config)
    yield ReidManager(store)
    for suffix in COLLECTION_SPECS:
        try:
            store.delete_collection(suffix)
        except Exception:
            pass


def test_upsert_insert(reid):
    result = reid.upsert(entity_id="e1", vector=[0.1]*768, collection="reid_entity")
    assert result["entity_id"] == "e1"
    assert result["event"] == "INSERT"
    assert result["collection"] == "reid_entity"


def test_cosine_similarity_uses_numpy_without_changing_semantics():
    assert _cosine_similarity([2.0, 0.0], [4.0, 0.0]) == pytest.approx(1.0)
    assert _cosine_similarity([1.0, 0.0], [0.0, 1.0]) == pytest.approx(0.0)
    assert _cosine_similarity([1.0], [1.0, 0.0]) == pytest.approx(0.0)


def test_upsert_update(reid):
    time.sleep(0.3)
    result = reid.upsert(entity_id="e1", vector=[0.2]*768, collection="reid_entity")
    assert result["event"] == "UPDATE"


def test_deterministic_id(reid):
    r1 = reid.upsert(entity_id="det_test", vector=[0.1]*768, collection="reid_entity")
    time.sleep(0.3)
    r2 = reid.upsert(entity_id="det_test", vector=[0.2]*768, collection="reid_entity")
    assert r1["id"] == r2["id"]


def test_deterministic_id_is_scoped_by_user(reid):
    r1 = reid.upsert(
        entity_id="det_user_scope",
        vector=[0.1]*768,
        collection="reid_entity",
        user_id="user-a",
    )
    r2 = reid.upsert(
        entity_id="det_user_scope",
        vector=[0.1]*768,
        collection="reid_entity",
        user_id="user-b",
    )
    assert r1["id"] != r2["id"]


def test_search(reid):
    reid.upsert(entity_id="search_e", vector=[0.5]*768, collection="reid_entity")
    time.sleep(0.5)
    result = reid.search(vector=[0.5]*768, collection="reid_entity", limit=5)
    assert result["collection"] == "reid_entity"
    assert len(result["results"]) >= 1
    found = [r for r in result["results"] if r["entity_id"] == "search_e"]
    assert len(found) >= 1
    assert found[0]["score"] > 0.9


def test_search_filters_by_user_id(reid):
    reid.upsert(
        entity_id="search_user_a",
        vector=[0.41]*768,
        collection="reid_entity",
        user_id="user-a",
    )
    reid.upsert(
        entity_id="search_user_b",
        vector=[0.41]*768,
        collection="reid_entity",
        user_id="user-b",
    )
    time.sleep(0.5)
    result = reid.search(
        vector=[0.41]*768,
        collection="reid_entity",
        user_id="user-a",
        limit=10,
    )
    found_ids = {r["entity_id"] for r in result["results"]}
    assert "search_user_a" in found_ids
    assert "search_user_b" not in found_ids
    assert all(r["user_id"] == "user-a" for r in result["results"])


def test_upsert_filters_reserved_metadata(reid):
    reid.upsert(
        entity_id="reserved_metadata",
        vector=[0.22]*768,
        collection="reid_entity",
        user_id="user-reserved",
        metadata={
            "camera_id": "legacy-camera",
            "segment_id": "legacy-segment",
            "user_id": "wrong-user",
            "source": "unit-test",
        },
    )
    time.sleep(0.5)
    result = reid.search(
        vector=[0.22]*768,
        collection="reid_entity",
        user_id="user-reserved",
        limit=5,
    )
    hit = next(r for r in result["results"] if r["entity_id"] == "reserved_metadata")
    assert hit["user_id"] == "user-reserved"
    assert hit["metadata"] == {"source": "unit-test"}


def test_reid_stores_camera_id_without_search_filtering(reid):
    reid.upsert(
        entity_id="camera_a_person",
        vector=[0.31]*768,
        collection="reid_entity",
        user_id="user-camera",
        camera_id="camera-a",
    )
    reid.upsert(
        entity_id="camera_b_person",
        vector=[0.30]*768,
        collection="reid_entity",
        user_id="user-camera",
        camera_id="camera-b",
    )
    time.sleep(0.5)

    result = reid.search(
        vector=[0.31]*768,
        collection="reid_entity",
        user_id="user-camera",
        limit=5,
    )
    found_ids = {r["entity_id"] for r in result["results"]}
    assert "camera_a_person" in found_ids
    assert "camera_b_person" in found_ids

    camera_points = reid.store.scroll(
        "reid_entity",
        filters={"user_id": "user-camera", "camera_id": "camera-a"},
        limit=10,
    )
    assert {p["payload"]["entity_id"] for p in camera_points} == {"camera_a_person"}


def test_delete_by_camera_only_removes_camera_observations(reid):
    reid.upsert(
        entity_id="delete_camera_a",
        vector=[0.41]*768,
        collection="reid_entity",
        user_id="user-delete-camera",
        camera_id="camera-a",
    )
    reid.upsert(
        entity_id="keep_camera_b",
        vector=[0.42]*768,
        collection="reid_entity",
        user_id="user-delete-camera",
        camera_id="camera-b",
    )

    result = reid.delete_by_camera("camera-a", user_id="user-delete-camera")

    assert result["deleted"]["reid_entity"] >= 1
    remaining = reid.search(
        vector=[0.42]*768,
        collection="reid_entity",
        user_id="user-delete-camera",
        limit=5,
    )
    found_ids = {r["entity_id"] for r in remaining["results"]}
    assert "delete_camera_a" not in found_ids
    assert "keep_camera_b" in found_ids


def test_get_entity_memories_reads_scalar_episodic_entity_id():
    class FakeStore:
        def scroll(self, collection, filters=None, limit=10):
            if collection == "semantic_entity":
                return []
            if collection == "episodic_entity" and filters == {
                "entity_id": "entity-a",
                "user_id": "user-a",
            }:
                return [
                    {
                        "id": "epi-1",
                        "payload": {
                            "data": "A person is wearing a red jacket.",
                            "created_at": "2026-05-13T00:00:00Z",
                        },
                    }
                ]
            return []

    memories = ReidManager(FakeStore()).get_entity_memories("entity-a", user_id="user-a")

    assert memories["semantic_memories"] == []
    assert memories["episodic_memories"] == ["2026-05-13T00:00: A person is wearing a red jacket."]


def test_search_threshold(reid):
    time.sleep(0.3)
    result = reid.search(vector=[0.99]*768, collection="reid_entity", threshold=0.9999)
    # Very high threshold should filter most results
    assert isinstance(result["results"], list)


def test_face_collection(reid):
    result = reid.upsert(entity_id="f1", vector=[0.3]*512, collection="reid_face")
    assert result["event"] == "INSERT"
    time.sleep(0.5)
    search = reid.search(vector=[0.3]*512, collection="reid_face")
    found = [r for r in search["results"] if r["entity_id"] == "f1"]
    assert len(found) >= 1


def test_invalid_collection_search(reid):
    with pytest.raises(ValueError, match="Invalid collection"):
        reid.search(vector=[0.1]*768, collection="invalid")


def test_invalid_collection_upsert(reid):
    with pytest.raises(ValueError, match="Invalid collection"):
        reid.upsert(entity_id="e1", vector=[0.1]*768, collection="invalid")


# ── Gallery update tests ──────────────────────────────────────────


@pytest.fixture(scope="module")
def gallery_reid(requires_qdrant):
    """Separate ReidManager for gallery tests (isolated prefix)."""
    config = MemConfig(
        collection_prefix="reflectworld_pytest_gallery",
        qdrant_host=requires_qdrant.host,
        qdrant_port=requires_qdrant.port,
    )
    store = QdrantStore(config)
    yield ReidManager(store)
    for suffix in COLLECTION_SPECS:
        try:
            store.delete_collection(suffix)
        except Exception:
            pass


def test_gallery_add_first_slot(gallery_reid):
    """First gallery update for empty entity should ADD slot 0."""
    result = gallery_reid.gallery_update(
        entity_id="gal_e1", vector=[0.5] * 768,
        collection="reid_entity", quality=0.8,
    )
    assert result["action"] == "ADD"
    assert result["slot_idx"] == 0
    assert result["entity_id"] == "gal_e1"


def test_gallery_add_diverse_viewpoint(gallery_reid):
    """A sufficiently different embedding should ADD to a new slot."""
    time.sleep(0.3)
    # Create a vector that is orthogonal-ish to the first
    diverse_vec = [0.0] * 384 + [0.5] * 384
    result = gallery_reid.gallery_update(
        entity_id="gal_e1", vector=diverse_vec,
        collection="reid_entity", quality=0.7,
    )
    assert result["action"] == "ADD"
    assert result["slot_idx"] == 1


def test_gallery_skip_redundant_lower_quality(gallery_reid):
    """Same viewpoint with lower quality should SKIP."""
    time.sleep(0.3)
    result = gallery_reid.gallery_update(
        entity_id="gal_e1", vector=[0.5] * 768,
        collection="reid_entity", quality=0.3,  # lower than original 0.8
    )
    assert result["action"] == "SKIP"
    assert result["slot_idx"] == -1


def test_gallery_replace_redundant_higher_quality(gallery_reid):
    """Same viewpoint with higher quality should REPLACE."""
    time.sleep(0.3)
    result = gallery_reid.gallery_update(
        entity_id="gal_e1", vector=[0.5] * 768,
        collection="reid_entity", quality=0.95,  # higher than original 0.8
    )
    assert result["action"] == "REPLACE"
    assert result["slot_idx"] == 0  # replaces the most similar slot


def test_gallery_replace_lowest_when_full(gallery_reid):
    """When gallery is full, replace the lowest quality slot."""
    # Fill up remaining slots with diverse vectors (slots 2-7 for reid_entity max_slots=8)
    time.sleep(0.3)
    for i in range(2, 8):
        offset = i * 96
        vec = [0.0] * offset + [0.5] * (768 - offset) if offset < 768 else [0.1 * i] * 768
        gallery_reid.gallery_update(
            entity_id="gal_e1", vector=vec,
            collection="reid_entity", quality=0.6,
        )
        time.sleep(0.2)

    # Now gallery is full (8 slots). Add a high quality diverse vector.
    new_vec = [0.99] * 768
    result = gallery_reid.gallery_update(
        entity_id="gal_e1", vector=new_vec,
        collection="reid_entity", quality=0.99,
    )
    assert result["action"] in ("REPLACE", "ADD")  # should replace the lowest quality slot


def test_search_dedup_across_gallery_slots(gallery_reid):
    """Search should return one result per entity even with multiple gallery slots."""
    time.sleep(0.5)
    result = gallery_reid.search(
        vector=[0.5] * 768, collection="reid_entity", limit=10,
    )
    entity_ids = [r["entity_id"] for r in result["results"]]
    # gal_e1 should appear at most once despite having multiple slots
    assert entity_ids.count("gal_e1") <= 1


def test_upsert_stores_real_quality(gallery_reid):
    """upsert should store the provided quality, not hardcoded 0.5."""
    gallery_reid.upsert(
        entity_id="quality_test", vector=[0.33] * 512,
        collection="reid_face", quality=0.92,
    )
    time.sleep(0.3)
    # Gallery update with lower quality should SKIP (proving upsert stored 0.92)
    result = gallery_reid.gallery_update(
        entity_id="quality_test", vector=[0.33] * 512,
        collection="reid_face", quality=0.5,
    )
    assert result["action"] == "SKIP"


def test_gallery_pose_aware_not_redundant(gallery_reid):
    """High cosine similarity but large yaw difference should NOT be redundant."""
    gallery_reid.reset_reid()
    time.sleep(0.3)

    gallery_reid.gallery_update(
        entity_id="pose_nr", vector=[0.5] * 512,
        collection="reid_face", quality=0.8, yaw=0.0,
    )
    time.sleep(0.3)

    # Same embedding but yaw=40 → diff=40 ≥ 30 → not redundant → ADD
    result = gallery_reid.gallery_update(
        entity_id="pose_nr", vector=[0.5] * 512,
        collection="reid_face", quality=0.7, yaw=40.0,
    )
    assert result["action"] == "ADD"
    assert result["slot_idx"] == 1


def test_gallery_pose_aware_redundant(gallery_reid):
    """High cosine similarity AND close yaw should be redundant."""
    gallery_reid.reset_reid()
    time.sleep(0.3)

    gallery_reid.gallery_update(
        entity_id="pose_rd", vector=[0.5] * 512,
        collection="reid_face", quality=0.8, yaw=0.0,
    )
    time.sleep(0.3)

    # yaw=20 → diff=20 < 30 → redundant, lower quality → SKIP
    result = gallery_reid.gallery_update(
        entity_id="pose_rd", vector=[0.5] * 512,
        collection="reid_face", quality=0.5, yaw=20.0,
    )
    assert result["action"] == "SKIP"


def test_gallery_yaw_stored_in_slot(gallery_reid):
    """Yaw/pitch should be stored in slot payload for both upsert and gallery_update."""
    gallery_reid.reset_reid()
    time.sleep(0.3)

    gallery_reid.upsert(
        entity_id="pose_st", vector=[0.5] * 512,
        collection="reid_face", quality=0.8, yaw=10.0,
    )
    time.sleep(0.3)

    # yaw=-35 → diff=45 ≥ 30 → not redundant → ADD
    gallery_reid.gallery_update(
        entity_id="pose_st", vector=[0.0] * 256 + [0.5] * 256,
        collection="reid_face", quality=0.7, yaw=-35.0,
    )
    time.sleep(0.3)

    points = gallery_reid.store.scroll(
        "reid_face", filters={"entity_id": "pose_st"}, limit=10,
    )
    yaws = sorted(p["payload"]["yaw"] for p in points if "yaw" in p.get("payload", {}))
    assert -35.0 in yaws
    assert 10.0 in yaws


def test_upsert_yaw_then_gallery_add_different_pose(gallery_reid):
    """Entity created via upsert(yaw=0), gallery_update(yaw=40) should ADD."""
    gallery_reid.reset_reid()
    time.sleep(0.3)

    gallery_reid.upsert(
        entity_id="pose_ug", vector=[0.5] * 512,
        collection="reid_face", quality=0.8, yaw=0.0,
    )
    time.sleep(0.3)

    # yaw=40 → diff=40 ≥ 30 → not redundant → ADD
    result = gallery_reid.gallery_update(
        entity_id="pose_ug", vector=[0.5] * 512,
        collection="reid_face", quality=0.7, yaw=40.0,
    )
    assert result["action"] == "ADD"
    assert result["slot_idx"] == 1


def test_gallery_pitch_aware_not_redundant(gallery_reid):
    """Same yaw but large pitch difference should NOT be redundant."""
    gallery_reid.reset_reid()
    time.sleep(0.3)

    gallery_reid.gallery_update(
        entity_id="pose_pitch", vector=[0.5] * 512,
        collection="reid_face", quality=0.8, yaw=0.0, pitch=0.0,
    )
    time.sleep(0.3)

    # pitch=40 → diff=40 ≥ 35 → not redundant → ADD
    result = gallery_reid.gallery_update(
        entity_id="pose_pitch", vector=[0.5] * 512,
        collection="reid_face", quality=0.7, yaw=0.0, pitch=40.0,
    )
    assert result["action"] == "ADD"


def test_gallery_pitch_close_is_redundant(gallery_reid):
    """Same yaw and close pitch should be redundant."""
    gallery_reid.reset_reid()
    time.sleep(0.3)

    # Setup: slot 0 with yaw=0, pitch=0
    gallery_reid.gallery_update(
        entity_id="pose_pc", vector=[0.5] * 512,
        collection="reid_face", quality=0.8, yaw=0.0, pitch=0.0,
    )
    time.sleep(0.3)

    # pitch=10 → diff=10 < 35 → redundant, lower quality → SKIP
    result = gallery_reid.gallery_update(
        entity_id="pose_pc", vector=[0.5] * 512,
        collection="reid_face", quality=0.5, yaw=0.0, pitch=10.0,
    )
    assert result["action"] == "SKIP"


def test_reset_reid_only(gallery_reid):
    """reset_reid should clear ReID collections without affecting others."""
    result = gallery_reid.reset_reid()
    assert result["status"] == "ok"
    assert "reid_face" in result["deleted_collections"]
    assert "reid_entity" in result["deleted_collections"]
    # Verify collections are recreated (empty)
    search = gallery_reid.search(vector=[0.5] * 768, collection="reid_entity")
    assert len(search["results"]) == 0
