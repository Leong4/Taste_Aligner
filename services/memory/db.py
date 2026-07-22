"""
Database Module - SQLite Persistence for P5 Memories

Handles all database operations for the Memory Service.
"""

import sqlite3
import json
import uuid
from pathlib import Path
from typing import Dict, Any, List, Optional
from datetime import datetime
import logging

logger = logging.getLogger(__name__)

SIGNED_SENTIMENT_SCALE = "signed_v1"
LEGACY_ZERO_ONE_SENTIMENT_SOURCES = (
    "upload",
    "audit",
    "audit_seed",
    "audit_embedding_unify",
)

# Database file path
DB_PATH = Path(__file__).parent / "memory.db"


def init_database():
    """
    Initialize SQLite database and create tables if they don't exist.
    """
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS p5_memories (
            memory_id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            city TEXT,
            raw_tags TEXT,
            normalized_tags TEXT,
            taxonomy TEXT,
            sentiment REAL,
            sentiment_scale TEXT NOT NULL DEFAULT 'signed_v1',
            sentiment_source TEXT NOT NULL DEFAULT 'explicit_api',
            sentiment_confidence REAL NOT NULL DEFAULT 1.0,
            sentiment_available INTEGER NOT NULL DEFAULT 1,
            embedding TEXT NOT NULL,
            source TEXT,
            image_path TEXT,
            thumbnail_path TEXT,
            caption_text TEXT,
            vision_type TEXT,
            image_original_path TEXT,
            image_preview_path TEXT,
            image_thumbnail_path TEXT,
            image_vision_input_path TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Lightweight migration for existing DBs that predate image/caption fields.
    cursor.execute("PRAGMA table_info(p5_memories)")
    existing_cols = {row[1] for row in cursor.fetchall()}
    alter_columns = [
        ("image_path", "TEXT"),
        ("thumbnail_path", "TEXT"),
        ("caption_text", "TEXT"),
        ("vision_type", "TEXT"),
        ("image_original_path", "TEXT"),
        ("image_preview_path", "TEXT"),
        ("image_thumbnail_path", "TEXT"),
        ("image_vision_input_path", "TEXT"),
        ("sentiment_scale", "TEXT"),
        ("sentiment_source", "TEXT"),
        ("sentiment_confidence", "REAL"),
        ("sentiment_available", "INTEGER"),
    ]
    for col_name, col_type in alter_columns:
        if col_name not in existing_cols:
            cursor.execute(f"ALTER TABLE p5_memories ADD COLUMN {col_name} {col_type}")

    # Rows produced by the legacy vision upload chain stored [0, 1] values even
    # though memory.search has always consumed signed [-1, 1] sentiment. The
    # per-row scale marker makes this migration safe and idempotent: new signed
    # writes are never converted again on a later startup.
    source_placeholders = ", ".join("?" for _ in LEGACY_ZERO_ONE_SENTIMENT_SOURCES)
    cursor.execute(
        f"""
        UPDATE p5_memories
        SET sentiment = ROUND(2.0 * sentiment - 1.0, 4),
            sentiment_scale = ?
        WHERE sentiment_scale IS NULL
          AND source IN ({source_placeholders})
          AND sentiment BETWEEN 0.0 AND 1.0
        """,
        (SIGNED_SENTIMENT_SCALE, *LEGACY_ZERO_ONE_SENTIMENT_SOURCES),
    )
    migrated_sentiment_rows = cursor.rowcount

    # Other legacy rows were written through the documented signed API. Mark
    # their existing values without transforming the overlapping positive range.
    cursor.execute(
        """
        UPDATE p5_memories
        SET sentiment_scale = ?
        WHERE sentiment_scale IS NULL
        """,
        (SIGNED_SENTIMENT_SCALE,),
    )

    # Provenance columns were introduced after the original sentiment field.
    # Existing rows cannot prove that their value came from caption analysis,
    # so mark them unavailable instead of mislabelling them as measured neutral.
    cursor.execute(
        """
        UPDATE p5_memories
        SET sentiment_source = COALESCE(sentiment_source, 'legacy_unknown'),
            sentiment_confidence = COALESCE(sentiment_confidence, 0.0),
            sentiment_available = COALESCE(sentiment_available, 0)
        """
    )

    # Create index for user_id for faster queries
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_user_id ON p5_memories(user_id)
    """)

    conn.commit()
    conn.close()

    logger.info(f"Database initialized at {DB_PATH}")
    if migrated_sentiment_rows:
        logger.info(
            "Migrated %s legacy [0, 1] sentiment rows to signed [-1, 1]",
            migrated_sentiment_rows,
        )


def write_memory(memory: Dict[str, Any]) -> Dict[str, Any]:
    """
    Write a P5 memory to the database.

    Args:
        memory: Memory data dict

    Returns:
        Written memory with memory_id
    """
    # Generate memory_id if not provided
    if "memory_id" not in memory or not memory["memory_id"]:
        memory["memory_id"] = str(uuid.uuid4())

    # Convert lists/dicts to JSON strings
    raw_tags_json = json.dumps(memory.get("raw_tags", []))
    normalized_tags_json = json.dumps(memory.get("normalized_tags", []))
    taxonomy_json = json.dumps(memory.get("taxonomy", {}))
    embedding_json = json.dumps(memory.get("embedding", []))

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    try:
        cursor.execute("""
            INSERT INTO p5_memories (
                memory_id, user_id, timestamp, city,
                raw_tags, normalized_tags, taxonomy,
                sentiment, sentiment_scale, sentiment_source,
                sentiment_confidence, sentiment_available, embedding, source,
                image_path, thumbnail_path, caption_text, vision_type,
                image_original_path, image_preview_path, image_thumbnail_path, image_vision_input_path
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            memory["memory_id"],
            memory.get("user_id", ""),
            memory.get("timestamp", datetime.utcnow().isoformat() + "Z"),
            memory.get("city", ""),
            raw_tags_json,
            normalized_tags_json,
            taxonomy_json,
            memory.get("sentiment", 0.0),
            memory.get("sentiment_scale", SIGNED_SENTIMENT_SCALE) or SIGNED_SENTIMENT_SCALE,
            memory.get("sentiment_source", "explicit_api") or "explicit_api",
            memory.get("sentiment_confidence", 1.0),
            1 if memory.get("sentiment_available", True) else 0,
            embedding_json,
            memory.get("source", "unknown"),
            memory.get("image_path", ""),
            memory.get("thumbnail_path", ""),
            memory.get("caption_text", ""),
            memory.get("vision_type", ""),
            memory.get("image_original_path", memory.get("image_path", "")),
            memory.get("image_preview_path", memory.get("thumbnail_path", "")),
            memory.get("image_thumbnail_path", memory.get("thumbnail_path", "")),
            memory.get("image_vision_input_path", ""),
        ))

        conn.commit()
        logger.info(f"Memory written: {memory['memory_id']}")

        return {
            "ok": True,
            "memory_id": memory["memory_id"],
            "written": memory
        }

    except sqlite3.IntegrityError:
        conn.rollback()
        cursor.execute(
            "SELECT user_id FROM p5_memories WHERE memory_id = ?",
            (memory["memory_id"],),
        )
        existing = cursor.fetchone()
        if existing and existing[0] == memory.get("user_id", ""):
            logger.info("Idempotent replay for memory: %s", memory["memory_id"])
            return {
                "ok": True,
                "memory_id": memory["memory_id"],
                "written": memory,
                "idempotent_replay": True,
            }
        logger.error(f"Memory ID collision: {memory['memory_id']}")
        raise ValueError(f"Memory with id {memory['memory_id']} already exists")
    except Exception as e:
        logger.error(f"Error writing memory: {e}")
        raise
    finally:
        conn.close()


def read_memory(memory_id: str) -> Optional[Dict[str, Any]]:
    """
    Read a single memory by ID.

    Args:
        memory_id: Memory ID

    Returns:
        Memory dict or None if not found
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    try:
        cursor.execute("""
            SELECT * FROM p5_memories WHERE memory_id = ?
        """, (memory_id,))

        row = cursor.fetchone()
        if not row:
            return None

        memory = dict(row)

        # Parse JSON fields
        memory["raw_tags"] = json.loads(memory["raw_tags"]) if memory["raw_tags"] else []
        memory["normalized_tags"] = json.loads(memory["normalized_tags"]) if memory["normalized_tags"] else []
        memory["taxonomy"] = json.loads(memory["taxonomy"]) if memory["taxonomy"] else {}
        memory["embedding"] = json.loads(memory["embedding"]) if memory["embedding"] else []

        return memory

    finally:
        conn.close()


def delete_memory(memory_id: str) -> bool:
    """Delete a single memory by ID."""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    try:
        cursor.execute("DELETE FROM p5_memories WHERE memory_id = ?", (memory_id,))
        conn.commit()
        return cursor.rowcount > 0
    finally:
        conn.close()


def load_user_memories(user_id: str) -> List[Dict[str, Any]]:
    """
    Load all memories for a given user.

    Args:
        user_id: User ID

    Returns:
        List of memory dicts
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    try:
        cursor.execute("""
            SELECT * FROM p5_memories WHERE user_id = ? ORDER BY timestamp DESC
        """, (user_id,))

        rows = cursor.fetchall()
        memories = []

        for row in rows:
            memory = dict(row)

            # Parse JSON fields
            memory["raw_tags"] = json.loads(memory["raw_tags"]) if memory["raw_tags"] else []
            memory["normalized_tags"] = json.loads(memory["normalized_tags"]) if memory["normalized_tags"] else []
            memory["taxonomy"] = json.loads(memory["taxonomy"]) if memory["taxonomy"] else {}
            memory["embedding"] = json.loads(memory["embedding"]) if memory["embedding"] else []

            memories.append(memory)

        logger.info(f"Loaded {len(memories)} memories for user {user_id}")
        return memories

    finally:
        conn.close()


def get_database_stats() -> Dict[str, Any]:
    """
    Get database statistics.

    Returns:
        Stats dict
    """
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    try:
        cursor.execute("SELECT COUNT(*) FROM p5_memories")
        total_memories = cursor.fetchone()[0]

        cursor.execute("SELECT COUNT(DISTINCT user_id) FROM p5_memories")
        total_users = cursor.fetchone()[0]

        return {
            "total_memories": total_memories,
            "total_users": total_users,
            "db_path": str(DB_PATH)
        }

    finally:
        conn.close()


def delete_all_memories() -> Dict[str, Any]:
    """
    DEVELOPMENT ONLY - Delete all memories from the database.

    WARNING: This operation is irreversible and should ONLY be used
    during testing and development. NEVER use in production.

    Returns:
        Dict with deletion stats
    """
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    try:
        # Count memories before deletion
        cursor.execute("SELECT COUNT(*) FROM p5_memories")
        count_before = cursor.fetchone()[0]

        # Delete all memories
        cursor.execute("DELETE FROM p5_memories")
        conn.commit()

        # Count after (should be 0)
        cursor.execute("SELECT COUNT(*) FROM p5_memories")
        count_after = cursor.fetchone()[0]

        deleted_count = count_before - count_after

        logger.warning(
            f"🔥 DEV ONLY: Deleted {deleted_count} memories from database"
        )

        return {
            "ok": True,
            "deleted_count": deleted_count,
            "remaining_count": count_after
        }

    except Exception as e:
        logger.error(f"Error deleting memories: {e}")
        raise
    finally:
        conn.close()
