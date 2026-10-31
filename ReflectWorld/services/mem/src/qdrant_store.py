"""Qdrant vector store wrapper for all 9 memory collections."""

import logging
import uuid

from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    FieldCondition,
    Filter,
    MatchAny,
    MatchExcept,
    MatchValue,
    OrderBy,
    PayloadSchemaType,
    PointStruct,
    VectorParams,
)

from src.config import MemConfig

logger = logging.getLogger(__name__)

COLLECTION_SPECS: dict[str, int] = {
    # Episodic (three time scales)
    "episodic_trace":   1536,   # segment-level video summary
    "episodic_entity":  1536,   # segment-level per-entity observation
    "episodic_schema":  1536,   # chapter-level narrative summary
    "episodic_visual":  1024,   # video frame embedding (reserved)
    # Semantic (long-term knowledge)
    "semantic_entity":  1536,   # entity-level knowledge + identity
    "semantic_context": 1536,   # camera-level scene patterns
    # Procedural
    "procedural":       1536,   # user rules
    # ReID
    "reid_face":        512,
    "reid_entity":      768,
}


class QdrantStore:
    """Manages 9 Qdrant collections for ReflectWorld memory storage.

    Handles collection lifecycle (create, recreate on dim mismatch),
    payload indexing, CRUD operations, vector search, and filtered scroll.
    """

    def __init__(self, config: MemConfig) -> None:
        self.client = QdrantClient(host=config.qdrant_host, port=config.qdrant_port)
        self.prefix = config.collection_prefix
        self._ensure_collections()
        self._ensure_payload_indexes()

    def collection_name(self, suffix: str) -> str:
        """Return full collection name from prefix and suffix."""
        return f"{self.prefix}_{suffix}"

    def _ensure_collections(self) -> None:
        """Create missing collections or recreate if dimension mismatches."""
        for suffix, dim in COLLECTION_SPECS.items():
            name = self.collection_name(suffix)
            try:
                info = self.client.get_collection(name)
                actual_dim = info.config.params.vectors.size
                if actual_dim != dim:
                    logger.warning(
                        "Collection %s dim=%d, expected %d. Recreating.",
                        name, actual_dim, dim,
                    )
                    self.client.delete_collection(name)
                else:
                    continue  # collection exists with correct dimension
            except Exception as exc:
                logger.debug("Collection %s not found or needs recreation: %s", name, exc)
            logger.info("Creating collection %s (dim=%d)", name, dim)
            self.client.create_collection(
                name,
                vectors_config=VectorParams(size=dim, distance=Distance.COSINE),
            )

    def _ensure_payload_indexes(self) -> None:
        """Create payload indexes for efficient filtering on all relevant collections."""
        text_collections = [
            "episodic_trace", "episodic_entity", "episodic_schema",
            "semantic_entity", "semantic_context", "procedural",
        ]
        common_fields: list[tuple[str, PayloadSchemaType]] = [
            ("created_at", PayloadSchemaType.DATETIME),
            ("updated_at", PayloadSchemaType.DATETIME),
            ("user_id", PayloadSchemaType.KEYWORD),
            ("agent_id", PayloadSchemaType.KEYWORD),
            ("run_id", PayloadSchemaType.KEYWORD),
            ("video_id", PayloadSchemaType.KEYWORD),
            ("camera_id", PayloadSchemaType.KEYWORD),
            ("role", PayloadSchemaType.KEYWORD),
        ]
        extra_indexes: dict[str, list[tuple[str, PayloadSchemaType]]] = {
            "episodic_trace": [
                ("entity_ids", PayloadSchemaType.KEYWORD),
                ("segment_id", PayloadSchemaType.KEYWORD),
            ],
            "episodic_entity": [
                ("entity_id", PayloadSchemaType.KEYWORD),
                ("video_ids", PayloadSchemaType.KEYWORD),
            ],
            "episodic_schema": [
                ("time_range_start_ms", PayloadSchemaType.FLOAT),
            ],
            "semantic_entity": [
                ("entity_id", PayloadSchemaType.KEYWORD),
                ("importance", PayloadSchemaType.FLOAT),
                ("video_ids", PayloadSchemaType.KEYWORD),
                ("category", PayloadSchemaType.KEYWORD),
            ],
        }
        reid_fields: list[tuple[str, PayloadSchemaType]] = [
            ("entity_id", PayloadSchemaType.KEYWORD),
            ("user_id", PayloadSchemaType.KEYWORD),
            ("camera_id", PayloadSchemaType.KEYWORD),
            ("subject_index", PayloadSchemaType.INTEGER),
        ]

        for suffix in text_collections:
            name = self.collection_name(suffix)
            try:
                info = self.client.get_collection(name)
                existing = set(info.payload_schema.keys()) if info.payload_schema else set()
            except Exception:
                continue
            for field, schema_type in common_fields + extra_indexes.get(suffix, []):
                if field not in existing:
                    try:
                        self.client.create_payload_index(name, field, schema_type)
                    except Exception:
                        logger.warning(
                            "Failed to create index %s on %s", field, name, exc_info=True,
                        )

        for suffix in ["reid_entity", "reid_face"]:
            name = self.collection_name(suffix)
            try:
                info = self.client.get_collection(name)
                existing = set(info.payload_schema.keys()) if info.payload_schema else set()
            except Exception:
                continue
            for field, schema_type in reid_fields:
                if field not in existing:
                    try:
                        self.client.create_payload_index(name, field, schema_type)
                    except Exception:
                        logger.warning(
                            "Failed to create index %s on %s", field, name, exc_info=True,
                        )

    def build_qdrant_filter(self, filters: dict | None) -> Filter | None:
        """Convert a simple filter dict to a Qdrant Filter.

        Supports:
            match_any:   {"entity_ids": {"match_any": ["e1", "e2"]}}
            not_equal:   {"video_id": {"not_equal": "vid123"}}
            exact match: {"camera_id": "cam1"}
        """
        if not filters:
            return None
        conditions: list[FieldCondition] = []
        for key, value in filters.items():
            if isinstance(value, dict):
                if "match_any" in value:
                    conditions.append(
                        FieldCondition(key=key, match=MatchAny(any=value["match_any"]))
                    )
                elif "not_equal" in value:
                    not_equal_value = value["not_equal"]
                    if not_equal_value is not None:
                        conditions.append(
                            FieldCondition(
                                key=key,
                                match=MatchExcept(**{"except": [not_equal_value]}),
                            )
                        )
            else:
                conditions.append(
                    FieldCondition(key=key, match=MatchValue(value=value))
                )
        return Filter(must=conditions) if conditions else None

    def upsert(
        self,
        collection_suffix: str,
        point_id: str,
        vector: list[float],
        payload: dict,
    ) -> None:
        """Insert or overwrite a point by ID. Qdrant native upsert."""
        name = self.collection_name(collection_suffix)
        self.client.upsert(
            collection_name=name,
            points=[PointStruct(id=point_id, vector=vector, payload=payload)],
        )

    def insert(
        self,
        collection_suffix: str,
        vector: list[float],
        payload: dict,
        point_id: str | None = None,
    ) -> str:
        """Insert a point into a collection. Returns the point ID."""
        pid = point_id or str(uuid.uuid4())
        self.client.upsert(
            collection_name=self.collection_name(collection_suffix),
            points=[PointStruct(id=pid, vector=vector, payload=payload)],
        )
        return pid

    def update(
        self,
        collection_suffix: str,
        point_id: str,
        vector: list[float] | None,
        payload: dict,
    ) -> None:
        """Update a point's vector and/or payload."""
        name = self.collection_name(collection_suffix)
        if vector is not None:
            self.client.upsert(
                collection_name=name,
                points=[PointStruct(id=point_id, vector=vector, payload=payload)],
            )
        else:
            self.client.set_payload(
                collection_name=name, payload=payload, points=[point_id]
            )

    def set_payload(
        self, collection_suffix: str, point_id: str, payload: dict
    ) -> None:
        """Set (merge) payload fields on an existing point."""
        self.client.set_payload(
            collection_name=self.collection_name(collection_suffix),
            payload=payload,
            points=[point_id],
        )

    def get(self, collection_suffix: str, point_id: str, with_vectors: bool = False) -> dict | None:
        """Retrieve a single point by ID. Returns None if not found."""
        results = self.client.retrieve(
            collection_name=self.collection_name(collection_suffix),
            ids=[point_id],
            with_payload=True,
            with_vectors=with_vectors,
        )
        if not results:
            return None
        point = results[0]
        result = {"id": str(point.id), "payload": dict(point.payload)}
        if with_vectors:
            result["vector"] = point.vector
        return result

    def delete(self, collection_suffix: str, point_id: str) -> dict | None:
        """Delete a point by ID. Returns the deleted point data, or None."""
        existing = self.get(collection_suffix, point_id)
        if existing:
            self.client.delete(
                collection_name=self.collection_name(collection_suffix),
                points_selector=[point_id],
            )
        return existing

    def delete_batch(self, collection_suffix: str, point_ids: list[str]) -> int:
        """Delete multiple points. Returns count of IDs submitted for deletion."""
        if not point_ids:
            return 0
        self.client.delete(
            collection_name=self.collection_name(collection_suffix),
            points_selector=point_ids,
        )
        return len(point_ids)

    def search(
        self,
        collection_suffix: str,
        vector: list[float],
        filters: dict | None = None,
        limit: int = 100,
    ) -> list[dict]:
        """Vector similarity search with optional payload filters."""
        qdrant_filter = self.build_qdrant_filter(filters)
        results = self.client.query_points(
            collection_name=self.collection_name(collection_suffix),
            query=vector,
            query_filter=qdrant_filter,
            limit=limit,
            with_payload=True,
        ).points
        return [
            {"id": str(r.id), "score": r.score, "payload": dict(r.payload)}
            for r in results
        ]

    def scroll(
        self,
        collection_suffix: str,
        filters: dict | None = None,
        limit: int = 100,
        order_by: str | OrderBy | None = None,
        with_vectors: bool = False,
    ) -> list[dict]:
        """Scroll through points with optional filters and ordering."""
        qdrant_filter = self.build_qdrant_filter(filters)
        col_name = self.collection_name(collection_suffix)
        kwargs: dict = {
            "collection_name": col_name,
            "scroll_filter": qdrant_filter,
            "limit": limit,
            "with_payload": True,
            "with_vectors": with_vectors,
        }
        if order_by:
            kwargs["order_by"] = order_by
        points, _ = self.client.scroll(**kwargs)
        result = []
        for p in points:
            entry: dict = {"id": str(p.id), "payload": dict(p.payload)}
            if with_vectors and p.vector is not None:
                entry["vector"] = list(p.vector) if not isinstance(p.vector, list) else p.vector
            result.append(entry)
        logger.info(
            "scroll: collection=%s filters=%s qdrant_filter=%s points=%d",
            col_name, filters, qdrant_filter, len(result),
        )
        return result

    def delete_collection(self, collection_suffix: str) -> None:
        """Delete an entire collection."""
        self.client.delete_collection(self.collection_name(collection_suffix))

    def get_collection_info(self, collection_suffix: str) -> dict | None:
        """Return collection metadata, or None if it doesn't exist."""
        try:
            info = self.client.get_collection(self.collection_name(collection_suffix))
            return {
                "name": self.collection_name(collection_suffix),
                "vector_size": info.config.params.vectors.size,
                "points_count": info.points_count,
            }
        except Exception:
            return None
