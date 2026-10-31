import pytest
from qdrant_client.models import Direction, OrderBy

from src.memory_manager import AsyncMemoryManager


class FakeStore:
    def collection_name(self, suffix: str) -> str:
        return f"test_{suffix}"


@pytest.mark.asyncio
async def test_async_get_all_memories_orders_latest_by_created_at_desc():
    manager = object.__new__(AsyncMemoryManager)
    manager.store = FakeStore()
    order_by_calls: list[OrderBy | None] = []

    async def fake_store_scroll(
        suffix: str,
        filters: dict | None = None,
        limit: int = 100,
        order_by: OrderBy | None = None,
    ) -> list[dict]:
        del suffix, filters, limit
        order_by_calls.append(order_by)
        return []

    manager._store_scroll = fake_store_scroll

    await manager.get_all_memories(
        user_id="user-1",
        camera_id="camera-1",
        memory_type="episodic",
        sort_order="desc",
    )

    # "episodic" group now maps to 3 collections: episodic_trace, episodic_entity, episodic_schema
    assert len(order_by_calls) == 3
    # episodic_trace and episodic_entity sort by created_at
    assert order_by_calls[0] == OrderBy(key="created_at", direction=Direction.DESC)
    assert order_by_calls[1] == OrderBy(key="created_at", direction=Direction.DESC)
    # episodic_schema sorts by time_range_start_ms
    assert order_by_calls[2] == OrderBy(key="time_range_start_ms", direction=Direction.DESC)


@pytest.mark.asyncio
async def test_async_get_all_memories_orders_earliest_by_created_at_asc():
    manager = object.__new__(AsyncMemoryManager)
    manager.store = FakeStore()
    order_by_calls: list[OrderBy | None] = []

    async def fake_store_scroll(
        suffix: str,
        filters: dict | None = None,
        limit: int = 100,
        order_by: OrderBy | None = None,
    ) -> list[dict]:
        del suffix, filters, limit
        order_by_calls.append(order_by)
        return []

    manager._store_scroll = fake_store_scroll

    await manager.get_all_memories(
        user_id="user-1",
        camera_id="camera-1",
        memory_type="episodic",
        sort_order="asc",
    )

    # "episodic" group now maps to 3 collections
    assert len(order_by_calls) == 3
    assert order_by_calls[0] == OrderBy(key="created_at", direction=Direction.ASC)
    assert order_by_calls[1] == OrderBy(key="created_at", direction=Direction.ASC)
    assert order_by_calls[2] == OrderBy(key="time_range_start_ms", direction=Direction.ASC)
