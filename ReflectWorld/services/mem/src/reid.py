"""ReID vector search and upsert for entity re-identification.

Supports gallery mode: each entity can hold up to K embedding slots
per collection, enabling multi-view matching and continuous feature updates.
"""

import logging
import threading
import uuid
from datetime import datetime, timezone

import numpy as np

from src.qdrant_store import QdrantStore

logger = logging.getLogger(__name__)

REID_NAMESPACE = uuid.NAMESPACE_DNS
VALID_COLLECTIONS = {"reid_entity", "reid_face"}
REID_RESERVED_PAYLOAD_KEYS = {
    "entity_id",
    "user_id",
    "camera_id",
    "segment_id",
    "updated_at",
    "first_seen",
    "subject_index",
    "name",
    "category",
    "slot_idx",
    "quality",
    "yaw",
    "pitch",
    "vector",
}

# Gallery configuration per collection
GALLERY_CONFIG: dict[str, dict] = {
    "reid_face": {
        "max_slots": 5,
        "redundancy_threshold": 0.95,
        "ttl_days": 365,
    },
    "reid_entity": {
        "max_slots": 8,
        "redundancy_threshold": 0.92,
        "ttl_days": 365,
    },
}


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    """Compute cosine similarity between two vectors using vectorized math."""
    if len(a) != len(b):
        return 0.0
    vec_a = np.asarray(a, dtype=np.float32)
    vec_b = np.asarray(b, dtype=np.float32)
    dot = float(np.dot(vec_a, vec_b))
    mag_a = float(np.linalg.norm(vec_a))
    mag_b = float(np.linalg.norm(vec_b))
    if mag_a < 1e-9 or mag_b < 1e-9:
        return 0.0
    return dot / (mag_a * mag_b)


def _body_yaw_bin(yaw_ratio: float) -> str:
    """Bin body_yaw_ratio into discrete orientation categories.

    >0.7 = "front", 0.15-0.7 = "side", <0.15 = "back".
    """
    if yaw_ratio > 0.7:
        return "front"
    elif yaw_ratio >= 0.15:
        return "side"
    else:
        return "back"


class ReidManager:
    """Manages ReID feature vectors in reid_entity and reid_face collections."""

    def __init__(self, store: QdrantStore) -> None:
        self.store = store
        self._identity_lock = threading.Lock()

    def _make_id(
        self, collection: str, entity_id: str, user_id: str | None = None, slot_idx: int = 0,
    ) -> str:
        """Deterministic UUID5 for a given collection + user + entity + slot."""
        scope = user_id or "global"
        return str(uuid.uuid5(REID_NAMESPACE, f"{collection}:{scope}:{entity_id}:{slot_idx}"))

    def _user_filter(self, user_id: str | None) -> dict:
        return {"user_id": user_id} if user_id else {}

    def _identity_points(self, entity_id: str, user_id: str | None) -> list[dict]:
        filters = {"entity_id": entity_id}
        if user_id:
            filters["user_id"] = user_id
        points: list[dict] = []
        for collection in ["reid_entity", "reid_face"]:
            for point in self.store.scroll(collection, filters=filters, limit=100):
                points.append({"collection": collection, **point})
        return points

    def _read_identity(self, entity_id: str, user_id: str | None) -> dict | None:
        for point in self._identity_points(entity_id, user_id):
            payload = point.get("payload", {})
            subject_index = payload.get("subject_index")
            first_seen = payload.get("first_seen")
            if isinstance(subject_index, int) or first_seen:
                return {
                    "subject_index": subject_index if isinstance(subject_index, int) and subject_index > 0 else None,
                    "name": payload.get("name"),
                    "first_seen": first_seen,
                }
        return None

    def _ensure_identity(
        self,
        entity_id: str,
        user_id: str | None,
        now: str,
        subject_index: int | None = None,
        first_seen: str | int | float | None = None,
    ) -> dict:
        identity = self._read_identity(entity_id, user_id)
        if identity:
            if isinstance(subject_index, int) and subject_index > 0 and not identity.get("subject_index"):
                identity["subject_index"] = subject_index
            return identity
        identity = {
            "subject_index": subject_index if isinstance(subject_index, int) and subject_index > 0 else None,
            "name": None,
            "first_seen": first_seen if first_seen is not None else now,
        }
        return identity

    def _merge_identity(
        self,
        entity_id: str,
        user_id: str | None,
        now: str,
        subject_index: int | None = None,
        name: str | None = None,
        first_seen: str | int | float | None = None,
    ) -> dict:
        identity = self._read_identity(entity_id, user_id)
        if identity is None:
            identity = {
                "subject_index": subject_index if isinstance(subject_index, int) and subject_index > 0 else None,
                "name": None,
                "first_seen": first_seen if first_seen is not None else now,
            }
        elif isinstance(subject_index, int) and subject_index > 0 and not identity.get("subject_index"):
            identity["subject_index"] = subject_index
        clean_name = name.strip() if isinstance(name, str) else ""
        if clean_name:
            identity["name"] = clean_name
        if first_seen is not None and not identity.get("first_seen"):
            identity["first_seen"] = first_seen
        return identity

    def _identity_payload(self, identity: dict) -> dict:
        payload = {}
        subject_index = identity.get("subject_index")
        if isinstance(subject_index, int) and subject_index > 0:
            payload["subject_index"] = subject_index
        first_seen = identity.get("first_seen")
        if first_seen is not None:
            payload["first_seen"] = first_seen
        name = identity.get("name")
        if isinstance(name, str) and name.strip():
            payload["name"] = name.strip()
        return payload

    def update_identity(
        self,
        entity_id: str,
        name: str,
        user_id: str | None = None,
        subject_index: int | None = None,
    ) -> dict:
        """Persist a resolved real-world name on every gallery slot for this ReID entity."""
        clean_name = name.strip()
        if not clean_name:
            raise ValueError("name must be non-empty")
        now = datetime.now(timezone.utc).isoformat()
        with self._identity_lock:
            identity = self._merge_identity(entity_id, user_id, now, subject_index, clean_name)
            payload = {**self._identity_payload(identity), "updated_at": now}
            points = self._identity_points(entity_id, user_id)
            updated = 0
            for point in points:
                self.store.set_payload(point["collection"], point["id"], payload)
                updated += 1
            return {
                "entity_id": entity_id,
                "user_id": user_id,
                "name": clean_name,
                "subject_index": identity.get("subject_index"),
                "first_seen": identity.get("first_seen"),
                "updated": updated,
            }

    def search(
        self,
        vector: list[float],
        collection: str,
        limit: int = 10,
        threshold: float | None = None,
        user_id: str | None = None,
    ) -> dict:
        """Vector similarity search in a ReID collection.

        Gallery-aware: multiple slots per entity are deduplicated by keeping
        the highest-scoring hit per entity_id.
        """
        if collection not in VALID_COLLECTIONS:
            raise ValueError(f"Invalid collection '{collection}'. Must be one of: {VALID_COLLECTIONS}")

        filters = {}
        if user_id:
            filters["user_id"] = user_id

        # Over-fetch to account for multiple gallery slots per entity
        config = GALLERY_CONFIG.get(collection, {})
        max_slots = config.get("max_slots", 1)
        fetch_limit = limit * max_slots
        raw = self.store.search(collection, vector, filters=filters or None, limit=fetch_limit)

        # Group by entity_id, keep best score per entity
        best_per_entity: dict[str, dict] = {}
        for hit in raw:
            if threshold is not None and hit["score"] < threshold:
                continue
            payload = hit["payload"]
            eid = payload.get("entity_id", hit["id"])
            entry = {
                "entity_id": eid,
                "score": hit["score"],
                "user_id": payload.get("user_id"),
                "subject_index": payload.get("subject_index"),
                "name": payload.get("name"),
                "first_seen": payload.get("first_seen"),
                "updated_at": payload.get("updated_at"),
                "metadata": {
                    k: v for k, v in payload.items()
                    if k not in REID_RESERVED_PAYLOAD_KEYS
                },
            }
            existing = best_per_entity.get(eid)
            if existing is None or hit["score"] > existing["score"]:
                best_per_entity[eid] = entry

        results = sorted(best_per_entity.values(), key=lambda r: r["score"], reverse=True)
        return {"collection": collection, "results": results[:limit]}

    def upsert(
        self,
        entity_id: str,
        vector: list[float],
        collection: str,
        quality: float = 0.5,
        yaw: float | None = None,
        pitch: float | None = None,
        user_id: str | None = None,
        camera_id: str | None = None,
        metadata: dict | None = None,
        category: str | None = None,
        subject_index: int | None = None,
        name: str | None = None,
        first_seen: str | int | float | None = None,
    ) -> dict:
        """Insert or update the initial (slot 0) ReID feature vector."""
        if collection not in VALID_COLLECTIONS:
            raise ValueError(f"Invalid collection '{collection}'. Must be one of: {VALID_COLLECTIONS}")

        record_id = self._make_id(collection, entity_id, user_id=user_id, slot_idx=0)
        now = datetime.now(timezone.utc).isoformat()

        with self._identity_lock:
            identity = self._merge_identity(entity_id, user_id, now, subject_index, name, first_seen)

        payload: dict = {
            "entity_id": entity_id,
            "slot_idx": 0,
            "quality": quality,
            "updated_at": now,
            **self._identity_payload(identity),
        }
        if yaw is not None:
            payload["yaw"] = yaw
        if pitch is not None:
            payload["pitch"] = pitch
        if user_id:
            payload["user_id"] = user_id
        if camera_id:
            payload["camera_id"] = camera_id
        if category:
            payload["category"] = category
        if metadata:
            payload.update({
                key: value
                for key, value in metadata.items()
                if key not in REID_RESERVED_PAYLOAD_KEYS
            })

        existing = self.store.get(collection, record_id)
        if existing:
            self.store.update(collection, record_id, vector, payload)
            event = "UPDATE"
        else:
            self.store.insert(collection, vector, payload, point_id=record_id)
            event = "INSERT"

        return {
            "id": record_id,
            "entity_id": entity_id,
            "collection": collection,
            "event": event,
            **self._identity_payload(identity),
        }

    def batch_init(
        self,
        entity_id: str,
        face_vectors: list[dict] | None = None,
        body_vectors: list[dict] | None = None,
        user_id: str | None = None,
        camera_id: str | None = None,
        category: str | None = None,
        subject_index: int | None = None,
        name: str | None = None,
        first_seen: str | int | float | None = None,
    ) -> dict:
        """Initialize a ReID entity gallery with multiple embedding slots in one request.

        Face-first write order: face_vectors written before body_vectors.
        Face failure raises immediately (blocks body).
        Body failure after face success returns partial success (HTTP 200).
        Body-only failure (no face) re-raises.

        Args:
            entity_id: Entity identifier.
            face_vectors: List of dicts with keys: vector, quality, yaw, pitch.
            body_vectors: List of dicts with keys: vector, quality, body_yaw_ratio, visibility.
            user_id: Optional user scope.

        Returns:
            Dict with entity_id, face_slots_written, body_slots_written, event.
        """
        now = datetime.now(timezone.utc).isoformat()
        with self._identity_lock:
            identity = self._merge_identity(entity_id, user_id, now, subject_index, name, first_seen)
        identity_payload = self._identity_payload(identity)
        face_config = GALLERY_CONFIG["reid_face"]
        body_config = GALLERY_CONFIG["reid_entity"]

        face_slots_written = 0
        body_slots_written = 0
        written_body_ids: list[str] = []
        previous_body_points: dict[str, dict | None] = {}

        # --- Face vectors (written first) ---
        if face_vectors:
            sorted_face = sorted(face_vectors, key=lambda v: v.get("quality", 0.5), reverse=True)
            max_face = face_config["max_slots"]
            for slot_idx, entry in enumerate(sorted_face[:max_face]):
                record_id = self._make_id("reid_face", entity_id, user_id=user_id, slot_idx=slot_idx)
                payload: dict = {
                    "entity_id": entity_id,
                    "slot_idx": slot_idx,
                    "quality": entry.get("quality", 0.5),
                    "updated_at": now,
                    **identity_payload,
                }
                if entry.get("yaw") is not None:
                    payload["yaw"] = entry["yaw"]
                if entry.get("pitch") is not None:
                    payload["pitch"] = entry["pitch"]
                if user_id:
                    payload["user_id"] = user_id
                if camera_id:
                    payload["camera_id"] = camera_id
                if category:
                    payload["category"] = category
                # Face failure raises — blocks body
                self.store.upsert("reid_face", record_id, entry["vector"], payload)
                face_slots_written += 1

        # --- Body vectors (written second) ---
        if body_vectors:
            sorted_body = sorted(body_vectors, key=lambda v: v.get("quality", 0.5), reverse=True)
            max_body = body_config["max_slots"]
            try:
                for slot_idx, entry in enumerate(sorted_body[:max_body]):
                    record_id = self._make_id("reid_entity", entity_id, user_id=user_id, slot_idx=slot_idx)
                    if face_slots_written == 0:
                        previous_body_points[record_id] = self.store.get(
                            "reid_entity", record_id, with_vectors=True
                        )
                    payload = {
                        "entity_id": entity_id,
                        "slot_idx": slot_idx,
                        "quality": entry.get("quality", 0.5),
                        "updated_at": now,
                        **identity_payload,
                    }
                    if entry.get("body_yaw_ratio") is not None:
                        payload["body_yaw_ratio"] = entry["body_yaw_ratio"]
                    if entry.get("visibility") is not None:
                        payload["visibility"] = entry["visibility"]
                    if user_id:
                        payload["user_id"] = user_id
                    if camera_id:
                        payload["camera_id"] = camera_id
                    if category:
                        payload["category"] = category
                    self.store.upsert("reid_entity", record_id, entry["vector"], payload)
                    body_slots_written += 1
                    written_body_ids.append(record_id)
            except Exception:
                if face_slots_written > 0:
                    # Partial success: face written, body failed
                    logger.warning(
                        "batch_init: body write failed for %s after %d face slots written",
                        entity_id, face_slots_written,
                    )
                else:
                    # Body-only must be atomic: restore overwritten slots and remove newly created ones.
                    try:
                        delete_body_ids: list[str] = []
                        for record_id in written_body_ids:
                            previous = previous_body_points.get(record_id)
                            if previous and previous.get("vector") is not None:
                                self.store.upsert(
                                    "reid_entity",
                                    record_id,
                                    previous["vector"],
                                    previous.get("payload", {}),
                                )
                            else:
                                delete_body_ids.append(record_id)
                        if delete_body_ids:
                            self.store.delete_batch("reid_entity", delete_body_ids)
                    except Exception:
                        logger.warning(
                            "batch_init: failed to roll back body-only writes for %s",
                            entity_id,
                            exc_info=True,
                        )
                    raise

        return {
            "entity_id": entity_id,
            "face_slots_written": face_slots_written,
            "body_slots_written": body_slots_written,
            "event": "BATCH_INIT",
            **identity_payload,
        }

    def gallery_update(
        self,
        entity_id: str,
        vector: list[float],
        collection: str,
        quality: float = 0.5,
        yaw: float | None = None,
        pitch: float | None = None,
        body_yaw_ratio: float | None = None,
        visibility: str | None = None,
        user_id: str | None = None,
        camera_id: str | None = None,
    ) -> dict:
        """Diversity-aware gallery update for an existing entity.

        Strategy:
        1. Fetch all existing slots (with vectors) for this entity.
        2. Find the most similar existing slot.
        3. Redundancy check (both must hold for reid_face):
           - similarity >= redundancy_threshold AND |yaw_diff| < 15°
           - If redundant: replace if higher quality, skip otherwise.
        4. If not redundant (new viewpoint):
           - Add to empty slot if gallery not full.
           - Replace lowest-quality slot if gallery is full.

        Returns: {entity_id, collection, action: "ADD"|"REPLACE"|"SKIP", slot_idx}
        """
        if collection not in VALID_COLLECTIONS:
            raise ValueError(f"Invalid collection '{collection}'. Must be one of: {VALID_COLLECTIONS}")

        config = GALLERY_CONFIG.get(collection, {})
        max_slots: int = config.get("max_slots", 5)
        redundancy_threshold: float = config.get("redundancy_threshold", 0.95)

        # Fetch existing gallery slots with vectors
        filters: dict = {"entity_id": entity_id}
        if user_id:
            filters["user_id"] = user_id
        existing_points = self.store.scroll(
            collection, filters=filters, limit=max_slots, with_vectors=True,
        )

        now = datetime.now(timezone.utc).isoformat()
        with self._identity_lock:
            identity = self._ensure_identity(entity_id, user_id, now)
        base_payload: dict = {
            "entity_id": entity_id,
            "quality": quality,
            "updated_at": now,
            **self._identity_payload(identity),
        }
        if yaw is not None:
            base_payload["yaw"] = yaw
        if pitch is not None:
            base_payload["pitch"] = pitch
        if body_yaw_ratio is not None:
            base_payload["body_yaw_ratio"] = body_yaw_ratio
        if visibility is not None:
            base_payload["visibility"] = visibility
        if user_id:
            base_payload["user_id"] = user_id
        if camera_id:
            base_payload["camera_id"] = camera_id

        # Migrate legacy points: backfill slot_idx/quality if missing
        existing_points = self._backfill_legacy_slots(existing_points, collection, entity_id, user_id)

        # Empty gallery — write slot 0
        if not existing_points:
            slot_idx = 0
            record_id = self._make_id(collection, entity_id, user_id=user_id, slot_idx=slot_idx)
            payload = {**base_payload, "slot_idx": slot_idx}
            self.store.insert(collection, vector, payload, point_id=record_id)
            return {"entity_id": entity_id, "collection": collection, "action": "ADD", "slot_idx": slot_idx}

        # Compute similarity against each existing slot
        # (idx, sim, quality, slot_idx, slot_yaw, slot_pitch)
        similarities: list[tuple[int, float, float, int, float | None, float | None]] = []
        for i, pt in enumerate(existing_points):
            pt_vector = pt.get("vector")
            if not pt_vector:
                continue
            sim = _cosine_similarity(vector, pt_vector)
            pt_quality = pt["payload"].get("quality", 0.5)
            pt_slot = pt["payload"].get("slot_idx", 0)
            pt_yaw = pt["payload"].get("yaw")
            pt_pitch = pt["payload"].get("pitch")
            similarities.append((i, sim, pt_quality, pt_slot, pt_yaw, pt_pitch))

        if not similarities:
            # All existing points lack vectors (shouldn't happen); add to next slot
            slot_idx = len(existing_points)
            record_id = self._make_id(collection, entity_id, user_id=user_id, slot_idx=slot_idx)
            payload = {**base_payload, "slot_idx": slot_idx}
            self.store.insert(collection, vector, payload, point_id=record_id)
            return {"entity_id": entity_id, "collection": collection, "action": "ADD", "slot_idx": slot_idx}

        # Find the most similar slot overall
        best_entry = max(similarities, key=lambda x: x[1])

        # Pose-aware redundancy only applies to face collections.
        # Body gallery uses body diversity (yaw_ratio bin + visibility) when available.
        # For face: both yaw AND pitch must be close for redundancy.
        yaw_redundancy_deg = 30.0
        pitch_redundancy_deg = 35.0
        use_pose = collection == "reid_face" and (yaw is not None or pitch is not None)
        use_body_diversity = (
            collection == "reid_entity"
            and body_yaw_ratio is not None
            and visibility is not None
        )
        redundant_slot: tuple[int, float, float, int, float | None, float | None] | None = None

        if best_entry[1] >= redundancy_threshold:
            if use_body_diversity:
                # Body diversity: bin yaw_ratio and compare (bin, visibility)
                new_bin = _body_yaw_bin(body_yaw_ratio)
                for s in similarities:
                    s_sim = s[1]
                    if s_sim < redundancy_threshold:
                        continue
                    pt_payload = existing_points[s[0]]["payload"]
                    s_body_yaw = pt_payload.get("body_yaw_ratio")
                    s_visibility = pt_payload.get("visibility")
                    if s_body_yaw is None or s_visibility is None:
                        # Existing slot lacks body diversity metadata → fallback to pure cosine
                        if redundant_slot is None or s_sim > redundant_slot[1]:
                            redundant_slot = s
                    else:
                        # Both have metadata: same bin → cosine redundancy, different bin → new viewpoint
                        existing_bin = _body_yaw_bin(s_body_yaw)
                        if existing_bin == new_bin and s_visibility == visibility:
                            if redundant_slot is None or s_sim > redundant_slot[1]:
                                redundant_slot = s
            elif use_pose:
                # Find the best-matching slot that is ALSO close in pose (yaw + pitch)
                for s in similarities:
                    s_sim, s_yaw, s_pitch = s[1], s[4], s[5]
                    if s_sim < redundancy_threshold:
                        continue
                    yaw_close = yaw is None or s_yaw is None or abs(yaw - s_yaw) < yaw_redundancy_deg
                    pitch_close = pitch is None or s_pitch is None or abs(pitch - s_pitch) < pitch_redundancy_deg
                    if yaw_close and pitch_close:
                        if redundant_slot is None or s_sim > redundant_slot[1]:
                            redundant_slot = s
            else:
                redundant_slot = best_entry

        if redundant_slot is not None:
            best_sim = redundant_slot[1]
            best_quality = redundant_slot[2]
            best_slot = redundant_slot[3]
            # Redundant viewpoint — only replace if higher quality
            if quality > best_quality:
                record_id = self._make_id(collection, entity_id, user_id=user_id, slot_idx=best_slot)
                payload = {**base_payload, "slot_idx": best_slot}
                self.store.update(collection, record_id, vector, payload)
                logger.info(
                    "gallery_update: REPLACE redundant slot %d for %s (sim=%.3f, q=%.3f→%.3f)",
                    best_slot, entity_id, best_sim, best_quality, quality,
                )
                return {"entity_id": entity_id, "collection": collection, "action": "REPLACE", "slot_idx": best_slot}
            logger.debug(
                "gallery_update: SKIP for %s (sim=%.3f, existing q=%.3f >= new q=%.3f)",
                entity_id, best_sim, best_quality, quality,
            )
            return {"entity_id": entity_id, "collection": collection, "action": "SKIP", "slot_idx": -1}

        # New viewpoint (different embedding or different pose angle)
        best_sim = best_entry[1]
        used_slots = {s[3] for s in similarities}
        if len(existing_points) < max_slots:
            # Gallery not full — find next available slot index
            slot_idx = 0
            while slot_idx in used_slots:
                slot_idx += 1
            record_id = self._make_id(collection, entity_id, user_id=user_id, slot_idx=slot_idx)
            payload = {**base_payload, "slot_idx": slot_idx}
            self.store.insert(collection, vector, payload, point_id=record_id)
            logger.info(
                "gallery_update: ADD new viewpoint slot %d for %s (best_sim=%.3f)",
                slot_idx, entity_id, best_sim,
            )
            return {"entity_id": entity_id, "collection": collection, "action": "ADD", "slot_idx": slot_idx}

        # Gallery full — replace lowest quality slot
        worst_entry = min(similarities, key=lambda x: x[2])
        worst_quality, worst_slot = worst_entry[2], worst_entry[3]
        if quality > worst_quality:
            record_id = self._make_id(collection, entity_id, user_id=user_id, slot_idx=worst_slot)
            payload = {**base_payload, "slot_idx": worst_slot}
            self.store.update(collection, record_id, vector, payload)
            logger.info(
                "gallery_update: REPLACE lowest-quality slot %d for %s (q=%.3f→%.3f)",
                worst_slot, entity_id, worst_quality, quality,
            )
            return {"entity_id": entity_id, "collection": collection, "action": "REPLACE", "slot_idx": worst_slot}

        logger.debug(
            "gallery_update: SKIP for %s (gallery full, new q=%.3f <= worst q=%.3f)",
            entity_id, quality, worst_quality,
        )
        return {"entity_id": entity_id, "collection": collection, "action": "SKIP", "slot_idx": -1}

    def _backfill_legacy_slots(
        self,
        points: list[dict],
        collection: str,
        entity_id: str,
        user_id: str | None,
    ) -> list[dict]:
        """Migrate legacy points that lack slot_idx/quality to gallery format.

        Legacy points (pre-gallery) have no slot_idx field. If no slot 0
        exists yet, adopt the legacy point as slot 0. If slot 0 already
        exists (from a newer write), delete the legacy point instead to
        avoid overwriting.
        """
        # Check which slot indices already exist
        existing_slot_ids: set[int] = set()
        for pt in points:
            s = pt.get("payload", {}).get("slot_idx")
            if s is not None:
                existing_slot_ids.add(int(s))

        to_remove: list[int] = []
        for i, pt in enumerate(points):
            payload = pt.get("payload", {})
            if "slot_idx" in payload:
                continue

            old_id = pt["id"]

            # If slot 0 already occupied by a proper gallery point, the legacy
            # point is stale — delete it rather than overwriting slot 0.
            if 0 in existing_slot_ids:
                self.store.delete(collection, old_id)
                to_remove.append(i)
                logger.info("gallery: deleted stale legacy point %s for %s (slot 0 already exists)", old_id, entity_id)
                continue

            # Adopt legacy point as slot 0
            now = datetime.now(timezone.utc).isoformat()
            backfill = {"slot_idx": 0, "quality": 0.5, "updated_at": now}
            new_id = self._make_id(collection, entity_id, user_id=user_id, slot_idx=0)
            if old_id != new_id:
                vector = pt.get("vector")
                merged_payload = {**payload, **backfill}
                if vector:
                    self.store.insert(collection, vector, merged_payload, point_id=new_id)
                    self.store.delete(collection, old_id)
                    pt["id"] = new_id
                else:
                    self.store.set_payload(collection, old_id, backfill)
            else:
                self.store.set_payload(collection, pt["id"], backfill)
            pt["payload"].update(backfill)
            existing_slot_ids.add(0)
            logger.info("gallery: backfilled legacy point %s → slot 0 for %s", old_id, entity_id)

        # Remove deleted legacy points from list (reverse order to keep indices stable)
        for idx in reversed(to_remove):
            points.pop(idx)
        return points

    def reset_reid(self) -> dict:
        """Delete and recreate only the ReID collections (reid_face, reid_entity).

        Does NOT touch episodic/semantic/procedural memory.
        """
        deleted = []
        for suffix in VALID_COLLECTIONS:
            try:
                self.store.delete_collection(suffix)
                deleted.append(suffix)
            except Exception:
                logger.warning("Failed to delete collection %s", suffix, exc_info=True)
        # Recreate with correct dimensions
        self.store._ensure_collections()
        self.store._ensure_payload_indexes()
        return {"deleted_collections": deleted, "status": "ok"}

    def delete_by_camera(self, camera_id: str, user_id: str | None = None) -> dict:
        """Delete ReID vectors observed from a camera/source.

        Search is not camera-filtered by default; camera_id is payload metadata
        used for lifecycle cleanup when a source is deleted.
        """
        if not camera_id:
            raise ValueError("camera_id is required")
        filters = {"camera_id": camera_id}
        if user_id:
            filters["user_id"] = user_id
        deleted: dict[str, int] = {}
        for collection in ["reid_entity", "reid_face"]:
            total = 0
            while True:
                points = self.store.scroll(collection, filters=filters, limit=256)
                ids = [point["id"] for point in points]
                if not ids:
                    break
                total += self.store.delete_batch(collection, ids)
                if len(ids) < 256:
                    break
            deleted[collection] = total
        return {"deleted": deleted, "total_deleted": sum(deleted.values())}

    def get_entity_memories(self, entity_id: str, user_id: str | None = None) -> dict:
        """Fetch semantic + episodic memories for include_history.

        Returns:
            {"semantic_memories": [...top 3 text by importance],
             "episodic_memories": [...top 2 "time: summary" by recency]}
        """
        # Semantic: top 3 by importance, text only
        try:
            sem_raw = self.store.scroll(
                "semantic_entity",
                filters={
                    "entity_id": entity_id,
                    **({"user_id": user_id} if user_id else {}),
                },
                limit=10,
            )
            sem_items = [
                (p["payload"].get("data", ""), p["payload"].get("importance", 0.5))
                for p in sem_raw
            ]
            sem_items.sort(key=lambda x: x[1], reverse=True)
            semantic_memories = [text for text, _ in sem_items[:3]]
        except Exception:
            semantic_memories = []

        # Episodic: top 2 by recency, only time + summary
        try:
            epi_filters = {
                "entity_id": entity_id,
                **({"user_id": user_id} if user_id else {}),
            }
            epi_raw = self.store.scroll(
                "episodic_entity",
                filters=epi_filters,
                limit=5,
            )
            epi_items: list[tuple[str, str]] = []
            for p in epi_raw:
                payload = p["payload"]
                created_at = payload.get("created_at", "")
                data = payload.get("data", "")
                # Extract only the summary line from episodic text
                summary = ""
                for line in data.split("\n"):
                    if line.lower().startswith("summary:"):
                        summary = line.split(":", 1)[1].strip()
                        break
                if not summary:
                    # Fallback: use first line, truncated
                    summary = data.split("\n")[0][:80] if data else ""
                # Format timestamp as short time
                time_str = created_at[:16] if len(created_at) >= 16 else created_at
                epi_items.append((f"{time_str}: {summary}", created_at))
            epi_items.sort(key=lambda x: x[1], reverse=True)
            episodic_memories = [text for text, _ in epi_items[:2]]
        except Exception:
            episodic_memories = []

        return {
            "semantic_memories": semantic_memories,
            "episodic_memories": episodic_memories,
        }
