"""Shared fixtures for ReflectWorld memory service tests."""

from __future__ import annotations

import os
import uuid
from dataclasses import dataclass
from urllib.parse import urlparse

import pytest
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams


@dataclass(frozen=True)
class QdrantTestEndpoint:
    host: str
    port: int


def _qdrant_endpoint_from_env() -> QdrantTestEndpoint:
    raw_url = os.getenv("QDRANT_TEST_URL") or os.getenv("REFLECTWORLD_TEST_QDRANT_URL")
    if raw_url:
        parsed = urlparse(raw_url)
        return QdrantTestEndpoint(
            host=parsed.hostname or "localhost",
            port=parsed.port or 6333,
        )
    return QdrantTestEndpoint(
        host=os.getenv("REFLECTWORLD_TEST_QDRANT_HOST", os.getenv("QDRANT_TEST_HOST", "localhost")),
        port=int(os.getenv("REFLECTWORLD_TEST_QDRANT_PORT", os.getenv("QDRANT_TEST_PORT", "6333"))),
    )


@pytest.fixture(scope="session")
def qdrant_test_endpoint() -> QdrantTestEndpoint:
    return _qdrant_endpoint_from_env()


@pytest.fixture(scope="session")
def requires_qdrant(qdrant_test_endpoint: QdrantTestEndpoint) -> QdrantTestEndpoint:
    """Skip Qdrant integration tests unless the configured Qdrant is writable."""
    timeout = float(os.getenv("REFLECTWORLD_TEST_QDRANT_TIMEOUT", "3"))
    client = QdrantClient(
        host=qdrant_test_endpoint.host,
        port=qdrant_test_endpoint.port,
        timeout=timeout,
    )
    probe_collection = f"reflectworld_pytest_probe_{uuid.uuid4().hex}"
    try:
        client.get_collections()
        client.create_collection(
            probe_collection,
            vectors_config=VectorParams(size=4, distance=Distance.COSINE),
        )
        client.delete_collection(probe_collection)
    except Exception as exc:
        pytest.skip(
            "Qdrant integration tests require a writable Qdrant instance. "
            "Set QDRANT_TEST_URL or REFLECTWORLD_TEST_QDRANT_HOST/PORT. "
            f"Current target: {qdrant_test_endpoint.host}:{qdrant_test_endpoint.port}. "
            f"Probe failed: {exc}"
        )
    return qdrant_test_endpoint
