"""Text embedding with multi-provider support."""

import logging
import time
from collections.abc import Callable
from typing import Any

from src.config import MemConfig

logger = logging.getLogger(__name__)


class Embedder:
    """Text to vector embedding."""

    def __init__(self, config: MemConfig, health_observer: Callable[..., None] | None = None) -> None:
        self.provider = config.embedder_provider
        self.model = config.embedder_model
        self.dims = config.embedding_dims
        self._health_observer = health_observer
        self._client = self._create_client(config)

    def _create_client(self, config: MemConfig) -> Any:
        if self.provider == "gemini":
            import google.generativeai as genai
            genai.configure(api_key=config.embedder_api_key)
            return genai
        elif self.provider == "openai":
            from openai import OpenAI
            api_key = config.embedder_api_key or "placeholder"
            kwargs: dict[str, Any] = {"api_key": api_key}
            if config.embedder_base_url:
                kwargs["base_url"] = config.embedder_base_url
            return OpenAI(**kwargs)
        else:
            return None

    def embed(self, text: str) -> list[float]:
        """Return embedding vector for text."""
        started_at = time.monotonic()
        try:
            if self.provider == "gemini":
                import google.generativeai as genai
                result = genai.embed_content(
                    model="models/text-embedding-004",
                    content=text,
                    task_type="retrieval_document"
                )
                embedding = result["embedding"]
                # Adjust dimensions if required by Qdrant collection spec (1536)
                if len(embedding) < self.dims:
                    embedding = embedding + [0.0] * (self.dims - len(embedding))
                elif len(embedding) > self.dims:
                    embedding = embedding[:self.dims]
                self._observe_health("ok", started_at)
                return embedding

            if hasattr(self._client, "embeddings") and self._client.api_key != "placeholder":
                response = self._client.embeddings.create(model=self.model, input=text)
                embedding = response.data[0].embedding
                self._observe_health("ok", started_at)
                return embedding

            # Safe zero-vector fallback for testing when no embedder key is set
            self._observe_health("ok", started_at)
            return [0.0] * self.dims
        except Exception:
            self._observe_health("down", started_at, code="request_failed")
            # Graceful fallback to avoid crashing pipeline
            return [0.0] * self.dims

    def _observe_health(self, status: str, started_at: float, code: str | None = None) -> None:
        if not self._health_observer:
            return
        try:
            self._health_observer(
                component="embedder",
                operation="embed",
                status=status,
                code=code,
                latency_ms=(time.monotonic() - started_at) * 1000,
            )
        except Exception:
            return
