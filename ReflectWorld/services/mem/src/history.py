"""SQLite-based memory change history tracking.

Schema matches the production database created by the original mem0 implementation.
"""

import logging
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)


class HistoryStore:
    """Tracks memory changes (ADD/UPDATE/DELETE) in SQLite."""

    def __init__(self, db_path: str) -> None:
        self.db_path = db_path
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _init_db(self) -> None:
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS history (
                    id           TEXT PRIMARY KEY,
                    memory_id    TEXT,
                    old_memory   TEXT,
                    new_memory   TEXT,
                    event        TEXT,
                    created_at   DATETIME,
                    updated_at   DATETIME,
                    is_deleted   INTEGER DEFAULT 0,
                    actor_id     TEXT,
                    role         TEXT
                )
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_history_memory_id ON history(memory_id)")
            conn.execute("""
                CREATE TABLE IF NOT EXISTS entity_observation_counters (
                    scope_key         TEXT NOT NULL,
                    entity_id         TEXT NOT NULL,
                    observation_count INTEGER NOT NULL DEFAULT 0,
                    updated_at        DATETIME,
                    PRIMARY KEY (scope_key, entity_id)
                )
            """)

    def add_history(
        self,
        memory_id: str,
        prev_value: str | None,
        new_value: str | None,
        event: str,
        is_deleted: int = 0,
        created_at: str | None = None,
        updated_at: str | None = None,
        actor_id: str | None = None,
        role: str | None = None,
    ) -> None:
        """Record a memory change event."""
        now = datetime.now(timezone.utc).isoformat()
        row_id = str(uuid.uuid4())
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "INSERT INTO history (id, memory_id, old_memory, new_memory, event, created_at, updated_at, is_deleted, actor_id, role) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (row_id, memory_id, prev_value, new_value, event,
                 created_at or now, updated_at or now, is_deleted, actor_id, role),
            )

    def get_history(self, memory_id: str) -> list[dict]:
        """Get all change records for a memory_id, ordered chronologically."""
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                "SELECT id, memory_id, old_memory, new_memory, event, created_at, updated_at, is_deleted, actor_id, role "
                "FROM history WHERE memory_id = ? ORDER BY created_at ASC",
                (memory_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def increment_entity_observation(self, scope_key: str, entity_id: str) -> int:
        """Increment and return the persisted observation count for an entity."""
        now = datetime.now(timezone.utc).isoformat()
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                INSERT INTO entity_observation_counters
                    (scope_key, entity_id, observation_count, updated_at)
                VALUES (?, ?, 1, ?)
                ON CONFLICT(scope_key, entity_id) DO UPDATE SET
                    observation_count = observation_count + 1,
                    updated_at = excluded.updated_at
                """,
                (scope_key, entity_id, now),
            )
            row = conn.execute(
                """
                SELECT observation_count
                FROM entity_observation_counters
                WHERE scope_key = ? AND entity_id = ?
                """,
                (scope_key, entity_id),
            ).fetchone()
        return int(row[0]) if row else 0

    def reset(self) -> None:
        """Clear all history records."""
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("DELETE FROM history")
            conn.execute("DELETE FROM entity_observation_counters")
