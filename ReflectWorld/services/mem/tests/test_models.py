from src.models import (
    MemoryCreateRequest, SearchRequest, UpdateMemoryRequest,
    ExpireMediaRequest, ReidSearchRequest, ReidUpsertRequest, SetIdentityRequest,
)


def test_memory_create_minimal():
    req = MemoryCreateRequest(camera_id="cam1")
    assert req.camera_id == "cam1"
    assert req.infer is True


def test_memory_create_full():
    req = MemoryCreateRequest(
        video_data={"summary": "test"},
        camera_id="cam1",
        mode="stream",
        event_id="evt_1",
        entity_data=[{"entity_id": "e1", "class_name": "person"}],
    )
    assert req.mode == "stream"
    assert len(req.entity_data) == 1


def test_search_request_fields():
    req = SearchRequest(query="person walking", camera_id="cam1", limit=10)
    assert req.query == "person walking"
    assert req.limit == 10
    assert req.threshold is None


def test_reid_search_defaults():
    req = ReidSearchRequest(vector=[0.1] * 512, collection="reid_face")
    assert req.include_history is False
    assert req.limit == 10
    assert req.user_id is None


def test_reid_upsert():
    req = ReidUpsertRequest(
        entity_id="e1",
        vector=[0.1] * 768,
        collection="reid_entity",
        user_id="user-1",
    )
    assert req.user_id == "user-1"


def test_expire_media():
    req = ExpireMediaRequest(segment_id="seg_123")
    assert req.camera_id is None


def test_set_identity_user_scope():
    req = SetIdentityRequest(
        entity_id="entity-1",
        identity="Alice",
        user_id="user-1",
        camera_id="camera-a",
    )
    assert req.user_id == "user-1"
    assert req.camera_id == "camera-a"


def test_update_memory_defaults():
    req = UpdateMemoryRequest(data="new content")
    assert req.data_type == "txt"
