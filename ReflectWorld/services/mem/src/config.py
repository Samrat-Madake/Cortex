"""Unified configuration from environment variables."""

import os
import logging
from dataclasses import dataclass
from pathlib import Path
from dotenv import load_dotenv

# Load root .env file if present
root_env = Path(__file__).resolve().parents[3] / ".env"
if root_env.exists():
    load_dotenv(root_env)
else:
    load_dotenv()

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class MemConfig:
    """All configuration for the memory service, built from environment variables."""

    # Qdrant
    qdrant_host: str = "localhost"
    qdrant_port: int = 6333
    # Stable storage namespace kept from the original memory module name.
    # The product was renamed to ReflectWorld, but changing this default would
    # make migrated Qdrant collections invisible to existing local installs.
    collection_prefix: str = "visionmem_me_production"

    # Text LLM. Only LLM_MODEL is normally configured; provider/key/base URL
    # reuse VLM_* so text work stays on the same API gateway.
    llm_provider: str = "openai"
    llm_model: str = "gpt-5-mini"
    llm_api_key: str = ""
    llm_base_url: str = ""
    llm_temperature: float = 0.1
    llm_max_tokens: int = 2048

    # Embedder
    embedder_provider: str = "openai"
    embedder_model: str = "text-embedding-3-small"
    embedder_api_key: str = ""
    embedder_base_url: str = ""
    embedding_dims: int = 1536

    # Storage
    storage_path: str = ""
    history_db_path: str = ""

    # Server
    port: int = 8219

    # Monitor
    monitor_webhook_url: str = "http://localhost:3211/api/memory-event"
    internal_webhook_token: str = ""

    # Logging
    log_path: str = ""

    @classmethod
    def from_env(cls) -> "MemConfig":
        """Build config from environment variables."""
        default_storage = str(Path.home() / ".reflectworld" / "memory-state")
        storage_path = os.getenv("STORAGE_PATH", default_storage)
        vlm_provider = os.getenv("VLM_PROVIDER", "openai")
        vlm_api_key = os.getenv("VLM_API_KEY", "")
        vlm_base_url = os.getenv("VLM_BASE_URL", "")
        return cls(
            qdrant_host=os.getenv("QDRANT_HOST", "localhost"),
            qdrant_port=int(os.getenv("QDRANT_PORT", "6333")),
            collection_prefix=os.getenv("COLLECTION_PREFIX", "visionmem_me_production"),
            llm_provider=os.getenv("LLM_PROVIDER") or vlm_provider,
            llm_model=os.getenv("LLM_MODEL", "gpt-5-mini"),
            llm_api_key=os.getenv("LLM_API_KEY") or vlm_api_key,
            llm_base_url=os.getenv("LLM_BASE_URL") or vlm_base_url,
            llm_temperature=float(os.getenv("LLM_TEMPERATURE", "0.1")),
            llm_max_tokens=int(os.getenv("LLM_MAX_TOKENS", "2048")),
            embedder_provider=os.getenv("EMBEDDER_PROVIDER") or "openai",
            embedder_model=os.getenv("EMBEDDER_MODEL", "text-embedding-3-small"),
            embedder_api_key=os.getenv("EMBEDDER_API_KEY") or vlm_api_key,
            embedder_base_url=os.getenv("EMBEDDER_BASE_URL") or vlm_base_url,
            embedding_dims=int(os.getenv("EMBEDDING_DIMS", "1536")),
            storage_path=storage_path,
            history_db_path=os.getenv(
                "HISTORY_DB_PATH", str(Path(storage_path) / "mem_op_history.db")
            ),
            port=int(os.getenv("PORT", "8219")),
            monitor_webhook_url=os.getenv(
                "MONITOR_WEBHOOK_URL", "http://localhost:3211/api/memory-event"
            ),
            internal_webhook_token=os.getenv("REFLECTWORLD_INTERNAL_WEBHOOK_TOKEN", ""),
            log_path=os.getenv("LOG_PATH", str(Path.home() / ".reflectworld" / "logs")),
        )
