"""Tests for POST /reid/batch-init and body diversity in gallery_update.

Uses unittest.mock.MagicMock for the QdrantStore to isolate ReidManager logic.
"""

from unittest.mock import MagicMock

import pytest

from src.reid import ReidManager, GALLERY_CONFIG


def _make_store() -> MagicMock:
    """Create a mock QdrantStore with default no-op behavior."""
    store = MagicMock()
    store.get.return_value = None
    store.upsert.return_value = None
    store.delete_batch.return_value = 0
    return store


class _FakeReidStore:
    """Small in-memory store for identity metadata tests."""

    def __init__(self):
        self.points = {"reid_entity": {}, "reid_face": {}}

    def get(self, collection, point_id, with_vectors=False):
        point = self.points.get(collection, {}).get(point_id)
        if not point:
            return None
        if with_vectors:
            return point
        return {"id": point["id"], "payload": dict(point["payload"])}

    def insert(self, collection, vector, payload, point_id=None):
        self.points[collection][point_id] = {
            "id": point_id,
            "vector": list(vector),
            "payload": dict(payload),
        }

    def update(self, collection, point_id, vector, payload):
        self.points[collection][point_id] = {
            "id": point_id,
            "vector": list(vector),
            "payload": dict(payload),
        }

    def scroll(self, collection, filters=None, limit=100):
        filters = filters or {}
        out = []
        for point in self.points.get(collection, {}).values():
            payload = point["payload"]
            if all(payload.get(key) == value for key, value in filters.items()):
                out.append({"id": point["id"], "payload": dict(payload)})
        return out[:limit]

    def set_payload(self, collection, point_id, payload):
        self.points[collection][point_id]["payload"].update(payload)


def test_identity_subject_index_is_client_supplied_and_preserved():
    store = _FakeReidStore()
    mgr = ReidManager(store)

    first_body = mgr.upsert(
        entity_id="entity-1",
        vector=[0.1] * 768,
        collection="reid_entity",
        user_id="user-a",
        camera_id="cam-a",
        subject_index=7,
    )
    same_entity_face = mgr.upsert(
        entity_id="entity-1",
        vector=[0.2] * 512,
        collection="reid_face",
        user_id="user-a",
        camera_id="cam-a",
    )
    second_entity = mgr.upsert(
        entity_id="entity-2",
        vector=[0.3] * 768,
        collection="reid_entity",
        user_id="user-a",
        camera_id="cam-a",
    )
    other_user = mgr.upsert(
        entity_id="entity-3",
        vector=[0.4] * 768,
        collection="reid_entity",
        user_id="user-b",
        camera_id="cam-b",
        subject_index=1,
    )

    assert first_body["subject_index"] == 7
    assert same_entity_face["subject_index"] == 7
    assert second_entity.get("subject_index") is None
    assert other_user["subject_index"] == 1


def test_update_identity_preserves_subject_index_and_writes_name_to_slots():
    store = _FakeReidStore()
    mgr = ReidManager(store)

    initial = mgr.upsert(
        entity_id="entity-1",
        vector=[0.1] * 768,
        collection="reid_entity",
        user_id="user-a",
        camera_id="cam-a",
        subject_index=11,
    )
    updated = mgr.update_identity("entity-1", "Lily", user_id="user-a")

    assert updated["subject_index"] == initial["subject_index"]
    assert updated["name"] == "Lily"
    assert updated["updated"] == 1
    payloads = [
        point["payload"]
        for points in store.points.values()
        for point in points.values()
        if point["payload"].get("entity_id") == "entity-1"
    ]
    assert payloads
    assert all(payload["subject_index"] == initial["subject_index"] for payload in payloads)
    assert all(payload["name"] == "Lily" for payload in payloads)


def test_update_identity_uses_client_subject_index_without_allocating():
    store = _FakeReidStore()
    mgr = ReidManager(store)

    named = mgr.update_identity("entity-named", "Alex", user_id="user-a", subject_index=5)
    unnamed = mgr.update_identity("entity-unnumbered", "Taylor", user_id="user-a")

    assert named["subject_index"] == 5
    assert named["updated"] == 0
    assert unnamed["subject_index"] is None
    assert unnamed["updated"] == 0


# ---------------------------------------------------------------------------
# 1. Face-only: 2 vectors -> 2 slots written, store.upsert called 2x
# ---------------------------------------------------------------------------


def test_face_only_two_vectors():
    store = _make_store()
    mgr = ReidManager(store)

    result = mgr.batch_init(
        entity_id="e1",
        face_vectors=[
            {"vector": [0.1] * 512, "quality": 0.9},
            {"vector": [0.2] * 512, "quality": 0.7},
        ],
    )

    assert result["entity_id"] == "e1"
    assert result["event"] == "BATCH_INIT"
    assert result["face_slots_written"] == 2
    assert result["body_slots_written"] == 0
    assert store.upsert.call_count == 2

    # Verify slot ordering: highest quality first (slot 0)
    first_call_payload = store.upsert.call_args_list[0][0][3]
    assert first_call_payload["slot_idx"] == 0
    assert first_call_payload["quality"] == 0.9

    second_call_payload = store.upsert.call_args_list[1][0][3]
    assert second_call_payload["slot_idx"] == 1
    assert second_call_payload["quality"] == 0.7


# ---------------------------------------------------------------------------
# 2. Face+body: 1 face + 2 body -> 3 upserts total.
#    Body payload contains body_yaw_ratio and visibility.
# ---------------------------------------------------------------------------


def test_face_and_body_vectors():
    store = _make_store()
    mgr = ReidManager(store)

    result = mgr.batch_init(
        entity_id="e2",
        face_vectors=[
            {"vector": [0.1] * 512, "quality": 0.85},
        ],
        body_vectors=[
            {"vector": [0.3] * 768, "quality": 0.8, "body_yaw_ratio": 0.9, "visibility": "full"},
            {"vector": [0.4] * 768, "quality": 0.6, "body_yaw_ratio": 0.1, "visibility": "upper"},
        ],
    )

    assert result["face_slots_written"] == 1
    assert result["body_slots_written"] == 2
    assert store.upsert.call_count == 3

    # Body calls are index 1 and 2 (face is index 0)
    # Sorted by quality desc: 0.8 first, 0.6 second
    body_payload_0 = store.upsert.call_args_list[1][0][3]
    assert body_payload_0["body_yaw_ratio"] == 0.9
    assert body_payload_0["visibility"] == "full"
    assert body_payload_0["slot_idx"] == 0

    body_payload_1 = store.upsert.call_args_list[2][0][3]
    assert body_payload_1["body_yaw_ratio"] == 0.1
    assert body_payload_1["visibility"] == "upper"
    assert body_payload_1["slot_idx"] == 1


# ---------------------------------------------------------------------------
# 3. Idempotent: same entity_id twice -> same number of upserts (overwrites)
# ---------------------------------------------------------------------------


def test_idempotent_overwrites():
    store = _make_store()
    mgr = ReidManager(store)

    vectors = [
        {"vector": [0.1] * 512, "quality": 0.9},
        {"vector": [0.2] * 512, "quality": 0.7},
    ]

    result1 = mgr.batch_init(entity_id="e3", face_vectors=vectors)
    first_run_count = store.upsert.call_count

    result2 = mgr.batch_init(entity_id="e3", face_vectors=vectors)
    second_run_count = store.upsert.call_count - first_run_count

    assert result1["face_slots_written"] == result2["face_slots_written"]
    assert first_run_count == second_run_count


# ---------------------------------------------------------------------------
# 4. Slots capped: 10 face vectors -> only 5 written
# ---------------------------------------------------------------------------


def test_face_slots_capped_at_max():
    store = _make_store()
    mgr = ReidManager(store)

    face_vectors = [
        {"vector": [0.1 * i] * 512, "quality": 0.5 + i * 0.01}
        for i in range(10)
    ]

    result = mgr.batch_init(entity_id="e4", face_vectors=face_vectors)

    max_face_slots = GALLERY_CONFIG["reid_face"]["max_slots"]
    assert result["face_slots_written"] == max_face_slots
    assert store.upsert.call_count == max_face_slots


# ---------------------------------------------------------------------------
# 5. Face failure blocks body: store.upsert raises on first call
# ---------------------------------------------------------------------------


def test_face_failure_blocks_body():
    store = _make_store()
    store.upsert.side_effect = RuntimeError("Qdrant connection lost")
    mgr = ReidManager(store)

    with pytest.raises(RuntimeError, match="Qdrant connection lost"):
        mgr.batch_init(
            entity_id="e5",
            face_vectors=[{"vector": [0.1] * 512, "quality": 0.9}],
            body_vectors=[{"vector": [0.3] * 768, "quality": 0.8}],
        )

    # Only 1 call attempted (the face call that failed); body never attempted
    assert store.upsert.call_count == 1


# ---------------------------------------------------------------------------
# 6. Body failure after face success: partial success
# ---------------------------------------------------------------------------


def test_body_failure_after_face_success():
    store = _make_store()
    call_count = 0

    def _side_effect(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        # First call (face) succeeds; second call (body) fails
        if call_count == 2:
            raise RuntimeError("Body write failed")
        return None

    store.upsert.side_effect = _side_effect
    mgr = ReidManager(store)

    result = mgr.batch_init(
        entity_id="e6",
        face_vectors=[{"vector": [0.1] * 512, "quality": 0.9}],
        body_vectors=[{"vector": [0.3] * 768, "quality": 0.8}],
    )

    # Partial success: face written, body failed
    assert result["face_slots_written"] == 1
    assert result["body_slots_written"] == 0


# ---------------------------------------------------------------------------
# 7. Body-only failure: no face, body fails -> exception raised
# ---------------------------------------------------------------------------


def test_body_only_failure_raises():
    store = _make_store()
    store.upsert.side_effect = RuntimeError("Qdrant down")
    mgr = ReidManager(store)

    with pytest.raises(RuntimeError, match="Qdrant down"):
        mgr.batch_init(
            entity_id="e7",
            body_vectors=[{"vector": [0.3] * 768, "quality": 0.8}],
        )

    store.delete_batch.assert_not_called()


def test_body_only_partial_failure_rolls_back_written_slots():
    store = _make_store()
    call_count = 0

    def _side_effect(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 2:
            raise RuntimeError("second body failed")
        return None

    store.upsert.side_effect = _side_effect
    mgr = ReidManager(store)

    with pytest.raises(RuntimeError, match="second body failed"):
        mgr.batch_init(
            entity_id="e8",
            body_vectors=[
                {"vector": [0.3] * 768, "quality": 0.9},
                {"vector": [0.4] * 768, "quality": 0.8},
            ],
        )

    first_body_id = store.upsert.call_args_list[0][0][1]
    store.delete_batch.assert_called_once_with("reid_entity", [first_body_id])


def test_body_only_partial_failure_restores_overwritten_slot():
    store = _make_store()
    existing_point = {
        "id": "old",
        "vector": [0.9] * 768,
        "payload": {"entity_id": "e9", "slot_idx": 0, "quality": 0.4},
    }
    store.get.side_effect = [existing_point, None]
    call_count = 0

    def _side_effect(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 2:
            raise RuntimeError("second body failed")
        return None

    store.upsert.side_effect = _side_effect
    mgr = ReidManager(store)

    with pytest.raises(RuntimeError, match="second body failed"):
        mgr.batch_init(
            entity_id="e9",
            body_vectors=[
                {"vector": [0.3] * 768, "quality": 0.9},
                {"vector": [0.4] * 768, "quality": 0.8},
            ],
        )

    first_body_id = store.upsert.call_args_list[0][0][1]
    store.upsert.assert_any_call(
        "reid_entity",
        first_body_id,
        existing_point["vector"],
        existing_point["payload"],
    )
    store.delete_batch.assert_not_called()
