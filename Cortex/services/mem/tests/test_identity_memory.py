import pytest

from src.memory_manager import AsyncMemoryManager


@pytest.mark.asyncio
async def test_async_set_identity_is_scoped_by_user_id():
    manager = object.__new__(AsyncMemoryManager)
    records: dict[str, dict] = {}
    scroll_calls: list[dict] = []

    async def fake_store_scroll(
        suffix: str,
        filters: dict | None = None,
        limit: int = 100,
        order_by: str | None = None,
    ) -> list[dict]:
        del order_by
        scroll_calls.append(filters or {})
        matches = []
        for record in records.values():
            if record["suffix"] != suffix:
                continue
            payload = record["payload"]
            if all(payload.get(key) == value for key, value in (filters or {}).items()):
                matches.append({"id": record["id"], "payload": payload})
        return matches[:limit]

    async def fake_create_memory(
        collection_suffix: str,
        data: str,
        embedding: list[float] | None = None,
        metadata: dict | None = None,
    ) -> str:
        del embedding
        memory_id = f"mem-{len(records) + 1}"
        records[memory_id] = {
            "id": memory_id,
            "suffix": collection_suffix,
            "payload": {**(metadata or {}), "data": data},
        }
        return memory_id

    async def fake_update_memory(
        collection_suffix: str,
        memory_id: str,
        data: str,
        embedding: list[float] | None = None,
        metadata: dict | None = None,
    ) -> str:
        del collection_suffix, embedding
        records[memory_id]["payload"].update(metadata or {})
        records[memory_id]["payload"]["data"] = data
        return memory_id

    manager._store_scroll = fake_store_scroll
    manager._create_memory = fake_create_memory
    manager._update_memory = fake_update_memory

    first = await manager.set_identity(
        "entity-1",
        "Alice",
        user_id="user-a",
        camera_id="camera-a",
    )
    second = await manager.set_identity(
        "entity-1",
        "Bob",
        user_id="user-b",
        camera_id="camera-b",
    )
    updated = await manager.set_identity(
        "entity-1",
        "Alice Updated",
        user_id="user-a",
        camera_id="camera-a",
    )

    assert first["event"] == "ADD"
    assert second["event"] == "ADD"
    assert updated["event"] == "UPDATE"
    assert updated["memory_id"] == first["memory_id"]
    assert second["memory_id"] != first["memory_id"]

    assert records[first["memory_id"]]["payload"]["user_id"] == "user-a"
    assert records[first["memory_id"]]["payload"]["data"] == (
        "Alice Updated (status: familiar)"
    )
    assert records[second["memory_id"]]["payload"]["user_id"] == "user-b"
    assert scroll_calls == [
        {"entity_id": "entity-1", "category": "identity", "user_id": "user-a"},
        {"entity_id": "entity-1", "category": "identity", "user_id": "user-b"},
        {"entity_id": "entity-1", "category": "identity", "user_id": "user-a"},
    ]
