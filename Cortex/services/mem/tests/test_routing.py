"""Tests for get_collections() routing logic."""

import pytest

from src.memory_manager import _adjust_filters, get_collections


def test_exact_collection_name():
    assert get_collections("episodic_trace") == ["episodic_trace"]
    assert get_collections("semantic_context") == ["semantic_context"]
    assert get_collections("procedural") == ["procedural"]


def test_group_alias_episodic():
    result = get_collections("episodic")
    assert set(result) == {"episodic_trace", "episodic_entity", "episodic_schema"}


def test_group_alias_semantic():
    result = get_collections("semantic")
    assert set(result) == {"semantic_entity", "semantic_context"}


def test_group_alias_all():
    result = get_collections("all")
    assert len(result) == 6


def test_none_returns_all():
    result = get_collections(None)
    assert len(result) == 6


def test_invalid_raises():
    with pytest.raises(ValueError):
        get_collections("nonexistent")


def test_group_alias_rejected_on_write():
    with pytest.raises(ValueError, match="not allowed for writes"):
        get_collections("semantic", allow_groups=False)
    with pytest.raises(ValueError, match="not allowed for writes"):
        get_collections("episodic", allow_groups=False)
    with pytest.raises(ValueError, match="not allowed for writes"):
        get_collections("all", allow_groups=False)
    with pytest.raises(ValueError, match="required for writes"):
        get_collections(None, allow_groups=False)
    assert get_collections("semantic_entity", allow_groups=False) == ["semantic_entity"]


def test_visual_blocked_by_default():
    with pytest.raises(ValueError, match="non-text embeddings"):
        get_collections("episodic_visual")
    assert get_collections("episodic_visual", allow_visual=True) == ["episodic_visual"]


def test_segment_video_id_filter_maps_to_entity_video_ids():
    assert _adjust_filters("episodic_entity", {"video_id": "seg-a"}) == {
        "video_ids": {"match_any": ["seg-a"]}
    }
    assert _adjust_filters("semantic_entity", {"video_id": "seg-a"}) == {
        "video_ids": {"match_any": ["seg-a"]}
    }


def test_entity_id_filter_maps_to_trace_entity_ids_only():
    assert _adjust_filters("episodic_trace", {"entity_id": "entity-a"}) == {
        "entity_ids": {"match_any": ["entity-a"]}
    }
    assert _adjust_filters("episodic_entity", {"entity_id": "entity-a"}) == {
        "entity_id": "entity-a"
    }
