"""Tests for MemConfig."""

import os
from unittest.mock import patch

from src.config import MemConfig


def test_default_config():
    config = MemConfig.from_env()
    assert config.qdrant_host == "localhost"
    assert config.qdrant_port == 6333
    assert config.collection_prefix == "visionmem_me_production"
    assert config.storage_path.endswith(".reflectworld/memory-state")
    assert config.history_db_path.endswith(".reflectworld/memory-state/mem_op_history.db")
    assert config.llm_provider == "openai"
    assert config.llm_model == "gpt-5-mini"
    assert config.embedder_provider == "openai"
    assert config.port == 8219


def test_custom_config():
    env = {
        "COLLECTION_PREFIX": "reflectworld_test",
        "PORT": "8220",
        "VLM_PROVIDER": "gemini",
        "VLM_API_KEY": "vlm-key",
        "VLM_BASE_URL": "https://litellm.test/v1",
        "LLM_MODEL": "gpt-5-mini",
        "QDRANT_HOST": "qdrant-server",
        "QDRANT_PORT": "6334",
    }
    with patch.dict(os.environ, env):
        config = MemConfig.from_env()
    assert config.collection_prefix == "reflectworld_test"
    assert config.port == 8220
    assert config.llm_provider == "gemini"
    assert config.llm_model == "gpt-5-mini"
    assert config.llm_api_key == "vlm-key"
    assert config.llm_base_url == "https://litellm.test/v1"
    assert config.qdrant_host == "qdrant-server"
    assert config.qdrant_port == 6334


def test_empty_llm_and_embedder_credentials_fall_back_to_vlm():
    env = {
        "VLM_PROVIDER": "openai",
        "VLM_API_KEY": "vlm-key",
        "VLM_BASE_URL": "https://litellm.test/v1",
        "LLM_PROVIDER": "",
        "LLM_API_KEY": "",
        "LLM_BASE_URL": "",
        "EMBEDDER_PROVIDER": "",
        "EMBEDDER_API_KEY": "",
        "EMBEDDER_BASE_URL": "",
    }
    with patch.dict(os.environ, env):
        config = MemConfig.from_env()

    assert config.llm_provider == "openai"
    assert config.llm_api_key == "vlm-key"
    assert config.llm_base_url == "https://litellm.test/v1"
    assert config.embedder_provider == "openai"
    assert config.embedder_api_key == "vlm-key"
    assert config.embedder_base_url == "https://litellm.test/v1"
