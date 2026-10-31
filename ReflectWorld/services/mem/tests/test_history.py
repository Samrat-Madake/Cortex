import os
import tempfile

from src.history import HistoryStore


def test_add_and_get_history():
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        db_path = f.name
    try:
        store = HistoryStore(db_path)
        store.add_history("mem-1", None, "new fact", "ADD")
        store.add_history("mem-1", "new fact", "updated fact", "UPDATE")
        history = store.get_history("mem-1")
        assert len(history) == 2
        assert history[0]["event"] == "ADD"
        assert history[0]["new_memory"] == "new fact"
        assert history[1]["event"] == "UPDATE"
        assert history[1]["old_memory"] == "new fact"
        assert history[1]["new_memory"] == "updated fact"
    finally:
        os.unlink(db_path)


def test_get_history_empty():
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        db_path = f.name
    try:
        store = HistoryStore(db_path)
        assert store.get_history("nonexistent") == []
    finally:
        os.unlink(db_path)


def test_increment_entity_observation_persists_count():
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        db_path = f.name
    try:
        store = HistoryStore(db_path)
        assert store.increment_entity_observation("scope-a", "entity-1") == 1
        assert store.increment_entity_observation("scope-a", "entity-1") == 2

        reopened = HistoryStore(db_path)
        assert reopened.increment_entity_observation("scope-a", "entity-1") == 3
        assert reopened.increment_entity_observation("scope-b", "entity-1") == 1
    finally:
        os.unlink(db_path)


def test_reset():
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        db_path = f.name
    try:
        store = HistoryStore(db_path)
        store.add_history("mem-1", None, "data", "ADD")
        store.increment_entity_observation("scope-a", "entity-1")
        store.reset()
        assert store.get_history("mem-1") == []
        assert store.increment_entity_observation("scope-a", "entity-1") == 1
    finally:
        os.unlink(db_path)


def test_delete_event():
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        db_path = f.name
    try:
        store = HistoryStore(db_path)
        store.add_history("mem-1", "old data", None, "DELETE", is_deleted=1)
        history = store.get_history("mem-1")
        assert len(history) == 1
        assert history[0]["is_deleted"] == 1
        assert history[0]["new_memory"] is None
    finally:
        os.unlink(db_path)
