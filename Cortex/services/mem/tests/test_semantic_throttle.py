import json

import pytest

from src.memory_manager import (
    AsyncMemoryManager,
    MemoryManager,
    normalize_string_ids,
    normalize_video_ids,
)


class FakeHistory:
    def __init__(self, next_count: int) -> None:
        self.next_count = next_count
        self.calls: list[tuple[str, str]] = []

    def increment_entity_observation(self, scope_key: str, entity_id: str) -> int:
        self.calls.append((scope_key, entity_id))
        return self.next_count


class FakeStore:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def scroll(self, collection, filters=None, limit=100, order_by=None, with_vectors=False):
        self.calls.append((collection, filters, limit))
        if self.responses:
            return self.responses.pop(0)
        return []


class FakeCollectionStore:
    def collection_name(self, suffix):
        return suffix


class FakeSemanticStore(FakeCollectionStore):
    def __init__(self, points=None):
        self.points = points or {}

    def get(self, collection, point_id):
        return self.points.get(point_id)


class FakeLlm:
    def __init__(self, payload):
        self.payload = payload

    def complete(self, **_kwargs):
        return json.dumps(self.payload)


def test_normalize_video_ids_dedupes_scalar_and_list_sources():
    assert normalize_video_ids(["seg-a", None, "seg-b"], "seg-a", ["", "seg-c"]) == [
        "seg-a",
        "seg-b",
        "seg-c",
    ]


def test_normalize_string_ids_dedupes_scalar_and_list_sources():
    assert normalize_string_ids(["entity-a", None, "entity-b"], "entity-a", ["", "entity-c"]) == [
        "entity-a",
        "entity-b",
        "entity-c",
    ]


def test_sync_episodic_trace_preserves_restored_entity_ids():
    manager = object.__new__(MemoryManager)
    manager.store = FakeCollectionStore()
    manager.embedder = type("FakeEmbedder", (), {"embed": lambda self, _text: [0.0] * 1536})()
    captured = {}

    def fake_create_memory(collection_suffix, data, embedding=None, metadata=None):
        captured["collection_suffix"] = collection_suffix
        captured["data"] = data
        captured["metadata"] = metadata
        return "trace-1"

    manager._create_memory = fake_create_memory

    result = manager._create_episodic_trace(
        {"summary": "segment summary"},
        {"camera_id": "camera-a", "user_id": "user-1", "entity_ids": ["entity-a", "entity-b"]},
        [],
    )

    assert result[0]["id"] == "trace-1"
    assert captured["collection_suffix"] == "episodic_trace"
    assert captured["metadata"]["entity_ids"] == ["entity-a", "entity-b"]


def test_sync_episodic_trace_prefers_current_entity_ids_before_restored_ids():
    manager = object.__new__(MemoryManager)
    manager.store = FakeCollectionStore()
    manager.embedder = type("FakeEmbedder", (), {"embed": lambda self, _text: [0.0] * 1536})()
    captured = {}

    def fake_create_memory(collection_suffix, data, embedding=None, metadata=None):
        captured["metadata"] = metadata
        return "trace-1"

    manager._create_memory = fake_create_memory

    manager._create_episodic_trace(
        {"summary": "segment summary"},
        {"camera_id": "camera-a", "user_id": "user-1", "entity_ids": ["entity-b", "entity-c"]},
        ["entity-a", "entity-b"],
    )

    assert captured["metadata"]["entity_ids"] == ["entity-a", "entity-b", "entity-c"]


def test_sync_episodic_trace_embeds_speech_events_text():
    manager = object.__new__(MemoryManager)
    manager.store = FakeCollectionStore()
    manager.embedder = type("FakeEmbedder", (), {"embed": lambda self, _text: [0.0] * 1536})()
    captured = {}
    speech = 'Speech:\n- 00:01.50: the person with a gray hoodie said: "hello".'

    def fake_create_memory(collection_suffix, data, embedding=None, metadata=None):
        captured["collection_suffix"] = collection_suffix
        captured["data"] = data
        captured["metadata"] = metadata
        return "trace-1"

    manager._create_memory = fake_create_memory

    manager._create_episodic_trace(
        {
            "summary": "segment summary",
            "transcript": "hello",
            "speech_events_text": speech,
            "retrieval_compact": ["prior hallway context"],
        },
        {"camera_id": "camera-a", "user_id": "user-1"},
        [],
    )

    assert captured["collection_suffix"] == "episodic_trace"
    assert captured["data"] == f"segment summary {speech} Retrieval compact: prior hallway context"
    assert captured["data"].count(speech) == 1
    assert "The transcript says: hello" not in captured["data"]
    assert captured["metadata"]["transcript"] == "hello"
    assert captured["metadata"]["speech_events_text"] == speech


@pytest.mark.asyncio
async def test_async_episodic_trace_embeds_speech_events_text():
    manager = object.__new__(AsyncMemoryManager)
    manager.store = FakeCollectionStore()
    captured = {}
    speech = 'Speech:\n- 00:01.50: the person with a gray hoodie said: "hello".'

    async def fake_embed(_text):
        return [0.0] * 1536

    async def fake_create_memory(collection_suffix, data, embedding=None, metadata=None):
        captured["collection_suffix"] = collection_suffix
        captured["data"] = data
        captured["metadata"] = metadata
        return "trace-1"

    manager._embed = fake_embed
    manager._create_memory = fake_create_memory

    await manager._create_episodic_trace(
        {
            "summary": "segment summary",
            "transcript": "hello",
            "speech_events_text": speech,
            "retrieval_compact": ["prior hallway context"],
        },
        {"camera_id": "camera-a", "user_id": "user-1"},
        [],
    )

    assert captured["collection_suffix"] == "episodic_trace"
    assert captured["data"] == f"segment summary {speech} Retrieval compact: prior hallway context"
    assert captured["data"].count(speech) == 1
    assert "The transcript says: hello" not in captured["data"]
    assert captured["metadata"]["transcript"] == "hello"
    assert captured["metadata"]["speech_events_text"] == speech


def test_sync_episodic_entity_uses_entity_level_video_ids():
    manager = object.__new__(MemoryManager)
    manager.store = FakeCollectionStore()
    manager.embedder = type("FakeEmbedder", (), {"embed": lambda self, _text: [0.0] * 1536})()
    captured = {}

    def fake_create_memory(collection_suffix, data, embedding=None, metadata=None):
        captured["collection_suffix"] = collection_suffix
        captured["metadata"] = metadata
        return "entity-observation-1"

    manager._create_memory = fake_create_memory

    result, entity_ids = manager._create_episodic_entity(
        [{"entity_id": "entity-a", "class_name": "person", "message": "waving"}],
        {"camera_id": "camera-a", "user_id": "user-1", "video_id": "seg-a"},
    )

    assert entity_ids == ["entity-a"]
    assert result[0]["id"] == "entity-observation-1"
    assert captured["collection_suffix"] == "episodic_entity"
    assert captured["metadata"]["entity_id"] == "entity-a"
    assert captured["metadata"]["video_ids"] == ["seg-a"]
    assert "video_id" not in captured["metadata"]


def test_sync_explicit_semantic_add_preserves_restored_video_ids():
    manager = object.__new__(MemoryManager)
    manager.store = FakeCollectionStore()
    captured = {}

    def fake_create_memory(collection_suffix, data, embedding=None, metadata=None):
        captured["collection_suffix"] = collection_suffix
        captured["data"] = data
        captured["metadata"] = metadata
        return "semantic-1"

    manager._create_memory = fake_create_memory

    result = manager.add_memory(
        entity_data=[
            {
                "entity_id": "entity-1",
                "message": "prefers the left side of the court",
                "video_ids": ["seg-a", "seg-b"],
            }
        ],
        user_id="user-1",
        camera_id="camera-a",
        video_id="seg-a",
        metadata={"video_ids": ["seg-b", "seg-c"]},
        memory_type="semantic_entity",
        infer=False,
    )

    assert captured["collection_suffix"] == "semantic_entity"
    assert captured["metadata"]["video_ids"] == ["seg-a", "seg-b", "seg-c"]
    assert "video_id" not in captured["metadata"]
    assert result["results"][0]["id"] == "semantic-1"
    assert result["results"][0]["entity_id"] == "entity-1"
    assert result["results"][0]["entity_class"] == ""
    assert result["results"][0]["category"] == "user_added"


@pytest.mark.asyncio
async def test_async_explicit_semantic_add_returns_entity_fields_for_monitor_webhook():
    manager = object.__new__(AsyncMemoryManager)
    manager.store = FakeCollectionStore()
    captured = {}

    async def fake_create_memory(collection_suffix, data, embedding=None, metadata=None):
        captured["collection_suffix"] = collection_suffix
        captured["data"] = data
        captured["metadata"] = metadata
        return "semantic-async-1"

    manager._create_memory = fake_create_memory

    result = await manager.add_memory(
        entity_data=[
            {
                "entity_id": "entity-async-1",
                "class_name": "person",
                "message": "often checks the side door",
                "category": "behavior",
            }
        ],
        user_id="user-1",
        camera_id="camera-a",
        video_id="seg-a",
        memory_type="semantic_entity",
        infer=False,
    )

    assert captured["collection_suffix"] == "semantic_entity"
    assert captured["metadata"]["entity_id"] == "entity-async-1"
    assert result["results"][0]["id"] == "semantic-async-1"
    assert result["results"][0]["entity_id"] == "entity-async-1"
    assert result["results"][0]["entity_class"] == "person"
    assert result["results"][0]["category"] == "behavior"


def test_sync_semantic_merge_add_uses_prompt_category_and_confidence_importance():
    manager = object.__new__(MemoryManager)
    manager.store = FakeCollectionStore()
    manager.llm = FakeLlm(
        {
            "analysis_summary": "Repeated behavior found",
            "semantic_memory_updates": [
                {
                    "id": "new",
                    "text": "The person repeatedly walks near the entrance.",
                    "event": "ADD",
                    "category": "behavior",
                    "entity_class": "person",
                    "confidence": "high",
                }
            ],
        }
    )
    captured = {}

    def fake_create_memory(collection_suffix, data, embedding=None, metadata=None):
        captured["collection_suffix"] = collection_suffix
        captured["data"] = data
        captured["metadata"] = metadata
        return "semantic-1"

    manager._create_memory = fake_create_memory

    result, has_add_or_update = manager._merge_entity_semantic_memory(
        "entity-1",
        {"summary": "current segment"},
        {"episodic": [{"content": "prior walk"}], "semantic": []},
        {"camera_id": "camera-a", "user_id": "user-1", "video_id": "seg-5"},
    )

    assert has_add_or_update is True
    assert captured["collection_suffix"] == "semantic_entity"
    assert captured["metadata"]["category"] == "behavior"
    assert captured["metadata"]["importance"] == 0.8
    assert captured["metadata"]["video_ids"] == ["seg-5"]
    assert "video_id" not in captured["metadata"]
    assert result[0]["category"] == "behavior"
    assert result[0]["categories"] == "behavior"
    assert result[0]["importance"] == 0.8


def test_sync_semantic_merge_update_uses_prompt_category_and_grows_existing_importance():
    manager = object.__new__(MemoryManager)
    manager.store = FakeSemanticStore(
        {
            "semantic-real-1": {
                "payload": {
                    "category": "behavior",
                    "importance": 0.5,
                }
            }
        }
    )
    manager.llm = FakeLlm(
        {
            "analysis_summary": "Existing pattern refined",
            "semantic_memory_updates": [
                {
                    "id": "0",
                    "text": "The person usually stays near the entrance.",
                    "event": "UPDATE",
                    "category": "location",
                    "entity_class": "person",
                    "confidence": "low",
                }
            ],
        }
    )
    captured = {}

    def fake_update_memory(collection_suffix, memory_id, data, embedding=None, metadata=None):
        captured["collection_suffix"] = collection_suffix
        captured["memory_id"] = memory_id
        captured["data"] = data
        captured["metadata"] = metadata
        return memory_id

    manager._update_memory = fake_update_memory

    result, has_add_or_update = manager._merge_entity_semantic_memory(
        "entity-1",
        {"summary": "current segment"},
        {
            "episodic": [{"content": "prior entrance stay"}],
            "semantic": [
                {
                    "id": "semantic-real-1",
                    "content": "The person often stays at the entrance.",
                    "category": "behavior",
                    "entity_class": "person",
                }
            ],
        },
        {"camera_id": "camera-a", "user_id": "user-1", "video_id": "seg-6"},
    )

    assert has_add_or_update is True
    assert captured["collection_suffix"] == "semantic_entity"
    assert captured["memory_id"] == "semantic-real-1"
    assert captured["metadata"]["category"] == "location"
    assert captured["metadata"]["importance"] == 0.6
    assert result[0]["category"] == "location"
    assert result[0]["categories"] == "location"
    assert result[0]["importance"] == 0.6


@pytest.mark.asyncio
async def test_async_semantic_merge_add_uses_prompt_category_and_confidence_importance():
    manager = object.__new__(AsyncMemoryManager)
    manager.store = FakeCollectionStore()
    captured = {}

    async def fake_llm_complete(**_kwargs):
        return json.dumps(
            {
                "analysis_summary": "Repeated appearance found",
                "semantic_memory_updates": [
                    {
                        "id": "new",
                        "text": "The person consistently wears a red jacket.",
                        "event": "ADD",
                        "category": "appearance",
                        "entity_class": "person",
                        "confidence": "low",
                    }
                ],
            }
        )

    async def fake_create_memory(collection_suffix, data, embedding=None, metadata=None):
        captured["collection_suffix"] = collection_suffix
        captured["data"] = data
        captured["metadata"] = metadata
        return "semantic-async-1"

    manager._llm_complete = fake_llm_complete
    manager._create_memory = fake_create_memory

    result, has_add_or_update = await manager._merge_entity_semantic_memory(
        "entity-1",
        {"summary": "current segment"},
        {"episodic": [{"content": "prior red jacket"}], "semantic": []},
        {"camera_id": "camera-a", "user_id": "user-1", "video_id": "seg-7"},
    )

    assert has_add_or_update is True
    assert captured["collection_suffix"] == "semantic_entity"
    assert captured["metadata"]["category"] == "appearance"
    assert captured["metadata"]["importance"] == 0.3
    assert result[0]["category"] == "appearance"
    assert result[0]["categories"] == "appearance"
    assert result[0]["importance"] == 0.3


@pytest.mark.asyncio
async def test_async_semantic_skips_non_interval_observations():
    manager = object.__new__(AsyncMemoryManager)
    manager.history = FakeHistory(next_count=4)

    async def fake_get_history(*_args, **_kwargs):
        raise AssertionError("history lookup should be skipped")

    async def fake_merge(*_args, **_kwargs):
        raise AssertionError("semantic merge should be skipped")

    manager._get_entity_complete_history = fake_get_history
    manager._merge_entity_semantic_memory = fake_merge

    result = await manager._process_entity_semantic_memory(
        {"summary": "current segment"},
        [{"entity_id": "entity-1"}],
        {"user_id": "user-1", "camera_id": "camera-a"},
        {"video_id": "segment-4"},
    )

    assert result == []
    assert manager.history.calls == [("user-1", "entity-1")]


@pytest.mark.asyncio
async def test_async_semantic_runs_on_every_fifth_observation():
    manager = object.__new__(AsyncMemoryManager)
    manager.history = FakeHistory(next_count=5)
    history_calls: list[tuple[str, dict, str | None]] = []
    merge_calls: list[str] = []

    async def fake_get_history(entity_id, filters, exclude_video_id=None):
        history_calls.append((entity_id, filters, exclude_video_id))
        return {"episodic": [{"content": "prior segment"}], "semantic": []}

    async def fake_merge(entity_id, *_args, **_kwargs):
        merge_calls.append(entity_id)
        return ([{"id": "semantic-1", "event": "ADD"}], False)

    manager._get_entity_complete_history = fake_get_history
    manager._merge_entity_semantic_memory = fake_merge

    result = await manager._process_entity_semantic_memory(
        {"summary": "current segment"},
        [{"entity_id": "entity-1"}],
        {"user_id": "user-1", "camera_id": "camera-a"},
        {"video_id": "segment-5"},
    )

    assert result == [{"id": "semantic-1", "event": "ADD"}]
    assert manager.history.calls == [("user-1", "entity-1")]
    assert history_calls == [
        ("entity-1", {"user_id": "user-1", "camera_id": "camera-a"}, "segment-5")
    ]
    assert merge_calls == ["entity-1"]


def test_sync_entity_history_uses_scalar_entity_id_for_episodic_entity():
    manager = object.__new__(MemoryManager)
    manager.store = FakeStore([
        [
            {
                "id": "current-episodic",
                "payload": {
                    "data": "current entity observation",
                    "created_at": "2026-05-13T00:01:00Z",
                    "camera_id": "camera-a",
                    "video_ids": ["segment-5"],
                },
            },
            {
                "id": "episodic-1",
                "payload": {
                    "data": "prior entity observation",
                    "created_at": "2026-05-13T00:00:00Z",
                    "camera_id": "camera-a",
                    "video_ids": ["segment-4"],
                },
            }
        ],
        [],
    ])

    history = manager._get_entity_complete_history(
        "entity-1",
        {"user_id": "user-1", "camera_id": "camera-a"},
        exclude_video_id="segment-5",
    )

    assert history["episodic"] == [
        {
            "id": "episodic-1",
            "content": "prior entity observation",
            "created_at": "2026-05-13T00:00:00Z",
            "camera_id": "camera-a",
        }
    ]
    assert manager.store.calls[0] == (
        "episodic_entity",
        {
            "user_id": "user-1",
            "entity_id": "entity-1",
        },
        50,
    )
