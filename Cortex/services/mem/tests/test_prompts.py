from src.prompts import (
    SEMANTIC_PATTERN_ANALYSIS_PROMPT,
    PROCEDURAL_MEMORY_SYSTEM_PROMPT,
    build_semantic_analysis_prompt,
)


def test_semantic_prompt_has_placeholders():
    # entity_id is tracked in metadata, not embedded in the prompt text.
    assert "{current_observation}" in SEMANTIC_PATTERN_ANALYSIS_PROMPT
    assert "{historical_episodic_memory}" in SEMANTIC_PATTERN_ANALYSIS_PROMPT
    assert "{historical_semantic_memory}" in SEMANTIC_PATTERN_ANALYSIS_PROMPT


def test_build_semantic_prompt_fills_placeholders():
    result = build_semantic_analysis_prompt(
        entity_id="entity_test_123",
        current_observation={"behavior": "walking"},
        episodic_history=[{"memory": "was standing"}],
        semantic_history=[{"memory": "often walks"}],
    )
    assert "walking" in result
    assert "was standing" in result
    # entity_id is not rendered into the prompt text (tracked in metadata).
    assert "{current_observation}" not in result


def test_procedural_prompt_not_empty():
    assert len(PROCEDURAL_MEMORY_SYSTEM_PROMPT) > 100
