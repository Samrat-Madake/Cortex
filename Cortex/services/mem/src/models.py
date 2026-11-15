"""Pydantic request/response models for the Cortex memory service.

These models mirror the TypeScript types defined in ts-client-types.ts
and maintain backwards compatibility with fields from current-main.py.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


class MemoryCreateRequest(BaseModel):
    """Request body for POST /memories — matches TS AddMemoryRequest."""

    video_data: Optional[dict[str, Any]] = Field(
        None, description="Structured video analysis payload (summary, targets, etc.)."
    )
    entity_data: Optional[list[dict[str, Any]]] = Field(
        None,
        description="Per-entity data driving episodic + semantic memory creation.",
    )
    messages: Optional[Any] = Field(
        None, description="Raw input: str, dict, or list[dict]."
    )

    # Identifiers
    user_id: Optional[str] = None
    agent_id: Optional[str] = None
    run_id: Optional[str] = None
    video_id: Optional[str] = None
    camera_id: Optional[str] = None

    # Parameters
    metadata: Optional[dict[str, Any]] = None
    infer: Optional[bool] = Field(True, description="Whether to run LLM inference on the input.")
    memory_type: Optional[str] = Field(
        None,
        description="Memory type: semantic_entity | procedural "
                    "(trace/entity auto-routed by data; schema/context use dedicated endpoints).",
    )
    prompt: Optional[str] = None
    semantic_mode: Optional[Literal["inline", "background"]] = Field(
        "inline",
        description="Entity semantic memory mode. 'inline' waits for semantic updates; "
                    "'background' returns after episodic writes and updates semantic memory asynchronously.",
    )

    # Dataflow context
    mode: Optional[str] = Field(
        None, description="Capture mode: snapshot | event | stream."
    )
    event_id: Optional[str] = Field(None, description="Event ID when mode='event'.")


class SearchRequest(BaseModel):
    """Request body for POST /search — matches TS SearchRequest.

    """

    query: str = Field(..., description="Search query text or base64-encoded embedding.")

    # Filter parameters
    user_id: Optional[str] = None
    agent_id: Optional[str] = None
    run_id: Optional[str] = None
    entity_id: Optional[str] = None
    camera_id: Optional[str] = None
    mode: Optional[str] = Field(
        None, description="Capture mode filter: snapshot | event | stream."
    )

    # Search parameters
    memory_type: Optional[str] = Field(
        None,
        description="Collection name or group alias: episodic_trace, episodic_entity, "
                    "episodic_schema, semantic_entity, semantic_context, procedural, "
                    "episodic, semantic, all.",
    )
    limit: Optional[int] = Field(100, description="Maximum number of results.")
    threshold: Optional[float] = Field(None, description="Minimum similarity score.")
    filters: Optional[dict[str, Any]] = Field(
        None, description="Additional key-value filters passed to the vector store."
    )

    video_id: Optional[str] = Field(
        None, description="Filter by video_id (maps to video_ids match_any on semantic collections)."
    )


class UpdateMemoryRequest(BaseModel):
    """Request body for PUT /memories/{memory_id}."""

    data: str = Field(..., description="New memory content or base64-encoded embedding.")
    data_type: Optional[str] = Field(
        "txt", description="Data format: 'txt' or embedding format."
    )


class ExpireMediaRequest(BaseModel):
    """Request body for PATCH /memories/expire_media."""

    segment_id: str = Field(
        ..., description="Segment ID (video_id) whose media_urls should be expired."
    )
    camera_id: Optional[str] = Field(
        None, description="Optional camera_id to narrow the filter."
    )


class SetIdentityRequest(BaseModel):
    """Request body for POST /identity/set — create or update an identity memory."""

    entity_id: str = Field(..., description="Entity identifier (e.g. 'person_5').")
    identity: str = Field(..., description="Identity description (e.g. 'neighbor Alex, familiar').")
    status: str = Field(
        "familiar",
        description="Identity status: 'familiar', 'unfamiliar', or 'admin'.",
    )
    user_id: Optional[str] = Field(None, description="User scope for the identity.")
    camera_id: Optional[str] = Field(None, description="Camera where entity was identified.")


class ReidSearchRequest(BaseModel):
    """Request body for POST /reid/search."""

    vector: list[float] = Field(..., description="Query feature vector.")
    collection: str = Field(..., description="ReID collection: 'reid_entity' or 'reid_face'.")
    limit: int = Field(10, description="Max results to return.")
    threshold: Optional[float] = Field(None, description="Minimum cosine similarity score.")
    user_id: Optional[str] = Field(None, description="Optional user_id filter.")
    include_history: bool = Field(
        False,
        description="If true, return semantic/episodic memories for matched entities.",
    )


class ReidUpsertRequest(BaseModel):
    """Request body for POST /reid/upsert."""

    entity_id: str = Field(..., description="Entity identifier.")
    vector: list[float] = Field(..., description="Feature vector to store.")
    collection: str = Field(..., description="ReID collection: 'reid_entity' or 'reid_face'.")
    quality: float = Field(0.5, description="Detection quality score (higher = more reliable).")
    yaw: Optional[float] = Field(None, description="Face yaw angle in degrees (stored in slot 0 payload).")
    pitch: Optional[float] = Field(None, description="Face pitch angle in degrees (stored in slot 0 payload).")
    user_id: Optional[str] = Field(None, description="User where feature was observed.")
    camera_id: Optional[str] = Field(None, description="Camera/source where feature was observed. Stored for cleanup; not used by default search.")
    category: Optional[str] = Field(None, description="Subject category used for display indexing.")
    subject_index: Optional[int] = Field(None, description="Stable subject index allocated by the host runtime.")
    name: Optional[str] = Field(None, description="Resolved real-world identity name.")
    first_seen: Optional[Any] = Field(None, description="First-seen timestamp allocated by the host runtime.")
    metadata: Optional[dict[str, Any]] = Field(None, description="Additional metadata.")


class ReidGalleryUpdateRequest(BaseModel):
    """Request body for POST /reid/gallery-update.

    Diversity-aware gallery update: adds new viewpoints or refreshes
    existing ones for a previously matched entity.
    """

    entity_id: str = Field(..., description="Entity identifier (from a prior match).")
    vector: list[float] = Field(..., description="New feature vector.")
    collection: str = Field(..., description="ReID collection: 'reid_entity' or 'reid_face'.")
    quality: float = Field(0.5, description="Detection quality score (higher = more reliable).")
    yaw: Optional[float] = Field(None, description="Face yaw angle in degrees (for pose-aware gallery diversity).")
    pitch: Optional[float] = Field(None, description="Face pitch angle in degrees (for pose-aware gallery diversity).")
    body_yaw_ratio: Optional[float] = Field(None, description="Body yaw ratio for body diversity (>0.7=front, 0.15-0.7=side, <0.15=back).")
    visibility: Optional[str] = Field(None, description="Visibility category (e.g. 'full', 'upper', 'partial').")
    user_id: Optional[str] = Field(None, description="User scope.")
    camera_id: Optional[str] = Field(None, description="Camera/source where feature was observed. Stored for cleanup; not used by default search.")


class ReidBatchInitVectorEntry(BaseModel):
    """Single embedding entry for batch-init."""

    vector: list[float] = Field(..., description="Feature vector.")
    quality: float = Field(0.5, description="Detection quality score.")
    yaw: Optional[float] = Field(None, description="Face yaw angle in degrees.")
    pitch: Optional[float] = Field(None, description="Face pitch angle in degrees.")
    body_yaw_ratio: Optional[float] = Field(None, description="Body yaw ratio (front/back orientation).")
    visibility: Optional[str] = Field(None, description="Visibility category (e.g. 'full', 'upper', 'partial').")


class ReidBatchInitRequest(BaseModel):
    """Request body for POST /reid/batch-init.

    Initializes a ReID entity gallery with multiple embedding slots in one request.
    Face vectors are written first; body vectors follow.
    """

    entity_id: str = Field(..., description="Entity identifier.")
    face_vectors: Optional[list[ReidBatchInitVectorEntry]] = Field(
        None, description="Face embedding entries to write to reid_face."
    )
    body_vectors: Optional[list[ReidBatchInitVectorEntry]] = Field(
        None, description="Body embedding entries to write to reid_entity."
    )
    user_id: Optional[str] = Field(None, description="User scope.")
    camera_id: Optional[str] = Field(None, description="Camera/source where features were observed. Stored for cleanup; not used by default search.")
    category: Optional[str] = Field(None, description="Subject category used for display indexing.")
    subject_index: Optional[int] = Field(None, description="Stable subject index allocated by the host runtime.")
    name: Optional[str] = Field(None, description="Resolved real-world identity name.")
    first_seen: Optional[Any] = Field(None, description="First-seen timestamp allocated by the host runtime.")


class ReidUpdateIdentityRequest(BaseModel):
    """Request body for PATCH /reid/identity."""

    entity_id: str = Field(..., description="ReID entity identifier.")
    user_id: Optional[str] = Field(None, description="User scope.")
    name: str = Field(..., description="Resolved real-world identity name.")
    subject_index: Optional[int] = Field(None, description="Stable subject index allocated by the host runtime.")


class AddSchemaRequest(BaseModel):
    """Request body for POST /memories/schema — add an episodic schema entry."""

    summary: str = Field(..., description="Schema-level summary aggregating multiple events.")
    event_ids: list[str] = Field(..., description="List of episodic event IDs composing this schema.")
    time_range: dict[str, int] = Field(
        ..., description="Time range dict with 'start_ms' and 'end_ms' keys."
    )
    camera_id: str = Field(..., description="Camera where the schema was observed.")
    user_id: Optional[str] = Field(None, description="User scope.")


class UpsertContextRequest(BaseModel):
    """Request body for PUT /memories/context — upsert semantic context."""

    camera_id: str = Field(..., description="Camera this context describes.")
    scene_description: str = Field(..., description="High-level scene description.")
    known_entities: str = Field(..., description="Known entities in the scene.")
    daily_routine: str = Field(..., description="Typical daily routine observed.")
    anomaly_baseline: str = Field(..., description="Baseline for anomaly detection.")
    user_notes: Optional[str] = Field(None, description="User-provided notes.")
    user_id: Optional[str] = Field(None, description="User scope.")
    # Semantic context state fields — persisted so cold-start hydration restores them.
    last_llm_update: Optional[str] = Field(None, description="ISO timestamp of last LLM update.")
    last_update_segment_count: Optional[int] = Field(None, description="Segment count at last LLM update.")
    last_agent_consult: Optional[str] = Field(None, description="ISO timestamp of last agent consultation.")
    last_consult_segment_count: Optional[int] = Field(None, description="Segment count at last agent consultation.")
    consecutive_no_updates: Optional[int] = Field(None, description="Consecutive no-update LLM cycles.")
