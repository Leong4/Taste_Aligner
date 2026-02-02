"""
Recommendation Service v1.2 - SQLite Database Layer

Provides access to the recommendation items database.

v1.2 Changes:
- Added title sanitization to fix city/title semantic mismatches
"""

import sqlite3
import json
import os
import re
from typing import List, Dict, Any, Optional, Tuple
from pathlib import Path
from datetime import datetime
import logging

logger = logging.getLogger(__name__)

# v1.2: Title sanitization rules
# Maps conflicting city tokens to generic replacements
CITY_TOKEN_REPLACEMENTS = {
    r'\(Modena trip\)': '(day trip)',
    r'\(Modena\)': '(day trip)',
    r'Modena trip': 'day trip',
    r'Modena': 'day trip',
}

_SANITIZATION_EXAMPLE_LIMIT = 3


def _log_title_sanitization_summary(context: str, count: int, examples: List[Tuple[str, str]]):
    """Log a concise sanitization summary with a few before/after examples."""
    if count == 0:
        logger.info(f"Title sanitization: changed=0 ({context})")
        return

    logger.info(f"Title sanitization: changed={count} ({context})")
    for before, after in examples[:_SANITIZATION_EXAMPLE_LIMIT]:
        logger.info(f"Title sanitization example: '{before}' -> '{after}'")

def sanitize_title(title: str, item_city: str) -> Tuple[str, bool]:
    """
    Sanitize item title to remove conflicting city tokens.

    v1.2: Prevents semantic confusion when title mentions a different city
    than item.city.

    Args:
        title: Item title
        item_city: Item's actual city

    Returns:
        (sanitized_title, was_changed)
    """
    original = title
    changed = False

    for pattern, replacement in CITY_TOKEN_REPLACEMENTS.items():
        if re.search(pattern, title, re.IGNORECASE):
            title = re.sub(pattern, replacement, title, flags=re.IGNORECASE)
            changed = True

    if changed:
        logger.info(f"Title sanitized: '{original}' -> '{title}' (city={item_city})")

    return title, changed

# Database path (configurable via env var)
DEFAULT_DB_PATH = Path(__file__).parent / "data/reco.db"
DB_PATH = os.getenv("RECO_DB_PATH", str(DEFAULT_DB_PATH))


def get_connection():
    """Get database connection."""
    return sqlite3.connect(DB_PATH)


def ensure_item_embeddings_table(db_path: Optional[str] = None) -> None:
    """Create item_embeddings table if it doesn't exist."""
    path = db_path or DB_PATH
    conn = sqlite3.connect(path)
    try:
        cursor = conn.cursor()
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS item_embeddings (
                item_id TEXT PRIMARY KEY,
                dim INTEGER NOT NULL,
                vector_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.commit()
    finally:
        conn.close()


def get_item_embedding(item_id: str, db_path: Optional[str] = None) -> Optional[List[float]]:
    """Get cached item embedding vector from SQLite."""
    if not item_id:
        return None

    path = db_path or DB_PATH
    ensure_item_embeddings_table(path)
    conn = sqlite3.connect(path)
    cursor = conn.cursor()
    try:
        cursor.execute(
            "SELECT vector_json FROM item_embeddings WHERE item_id = ?",
            (item_id,)
        )
        row = cursor.fetchone()
        if not row:
            return None
        return json.loads(row[0])
    finally:
        conn.close()


def upsert_item_embedding(item_id: str, vector: List[float], db_path: Optional[str] = None) -> None:
    """Insert or update cached item embedding vector in SQLite."""
    if not item_id or not vector:
        return

    path = db_path or DB_PATH
    ensure_item_embeddings_table(path)
    conn = sqlite3.connect(path)
    cursor = conn.cursor()
    try:
        cursor.execute(
            """
            INSERT INTO item_embeddings (item_id, dim, vector_json, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(item_id) DO UPDATE SET
                dim=excluded.dim,
                vector_json=excluded.vector_json,
                updated_at=excluded.updated_at
            """,
            (
                item_id,
                len(vector),
                json.dumps(vector),
                datetime.utcnow().isoformat() + "Z"
            )
        )
        conn.commit()
    finally:
        conn.close()


def _find_items_table(conn: sqlite3.Connection) -> Optional[str]:
    """Find the items table by name or schema inspection."""
    cursor = conn.cursor()
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = [row[0] for row in cursor.fetchall()]

    if "items" in tables:
        return "items"

    for table in tables:
        cursor.execute(f"PRAGMA table_info({table})")
        columns = [row[1].lower() for row in cursor.fetchall()]
        if "title" in columns and "city" in columns:
            return table

    return None


def sanitize_titles_in_db(db_path: Optional[str] = None) -> None:
    """
    Sanitize titles in SQLite DB to remove conflicting city tokens (e.g., Modena).

    Runs a deterministic update and logs verification results.
    """
    path = db_path or DB_PATH
    conn = sqlite3.connect(path)
    try:
        table = _find_items_table(conn)
        if not table:
            logger.error("Title sanitization verification: FAIL, remaining_modena_titles=-1")
            return

        cursor = conn.cursor()
        cursor.execute(f"PRAGMA table_info({table})")
        columns = [row[1].lower() for row in cursor.fetchall()]
        id_column = "id" if "id" in columns else None

        cursor.execute(f"SELECT rowid, title, city{', id' if id_column else ''} "
                       f"FROM {table} WHERE title LIKE '%Modena%'")
        rows = cursor.fetchall()

        sanitized_count = 0
        examples: List[Tuple[str, str]] = []
        for row in rows:
            rowid = row[0]
            title = row[1]
            city = row[2]
            row_id = row[3] if id_column else None

            sanitized_title, was_changed = sanitize_title(title, city)
            if not was_changed:
                continue

            sanitized_count += 1
            if len(examples) < _SANITIZATION_EXAMPLE_LIMIT:
                examples.append((title, sanitized_title))

            if id_column:
                cursor.execute(
                    f"UPDATE {table} SET title = ? WHERE {id_column} = ?",
                    (sanitized_title, row_id)
                )
            else:
                cursor.execute(
                    f"UPDATE {table} SET title = ? WHERE rowid = ?",
                    (sanitized_title, rowid)
                )

        conn.commit()

        _log_title_sanitization_summary("db_update", sanitized_count, examples)

        cursor.execute(f"SELECT COUNT(*) FROM {table} WHERE title LIKE '%Modena%'")
        remaining = cursor.fetchone()[0]
        status = "PASS" if remaining == 0 else "FAIL"
        logger.info(
            f"Title sanitization verification: {status}, remaining_modena_titles={remaining}"
        )
    finally:
        conn.close()


def get_all_items() -> List[Dict[str, Any]]:
    """
    Get all items from the database.

    v1.2: Applies title sanitization on load.

    Returns:
        List of item dicts with parsed JSON fields
    """
    conn = get_connection()
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    try:
        cursor.execute("SELECT * FROM items ORDER BY excellence DESC")
        rows = cursor.fetchall()

        items = []
        sanitized_count = 0
        sanitized_examples: List[Tuple[str, str]] = []
        for row in rows:
            item = dict(row)
            # Parse JSON fields
            item["tags"] = json.loads(item["tags_json"])
            item["embedding"] = json.loads(item["embedding_json"])
            # Remove json string fields (keep parsed versions)
            del item["tags_json"]
            del item["embedding_json"]

            # v1.2: Sanitize title
            original_title = item["title"]
            sanitized_title, was_changed = sanitize_title(item["title"], item["city"])
            if was_changed:
                item["title"] = sanitized_title
                sanitized_count += 1
                if len(sanitized_examples) < _SANITIZATION_EXAMPLE_LIMIT:
                    sanitized_examples.append((original_title, sanitized_title))

            items.append(item)

        logger.info(f"Loaded {len(items)} items from database ({sanitized_count} titles sanitized)")
        _log_title_sanitization_summary("all_items", sanitized_count, sanitized_examples)
        return items

    finally:
        conn.close()


def get_items_by_city(city: str) -> List[Dict[str, Any]]:
    """
    Get items filtered by city.

    v1.2: Applies title sanitization on load.

    Args:
        city: City name (case-insensitive)

    Returns:
        List of item dicts
    """
    conn = get_connection()
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    try:
        cursor.execute(
            "SELECT * FROM items WHERE LOWER(city) = LOWER(?) ORDER BY excellence DESC",
            (city,)
        )
        rows = cursor.fetchall()

        items = []
        sanitized_count = 0
        sanitized_examples: List[Tuple[str, str]] = []
        for row in rows:
            item = dict(row)
            item["tags"] = json.loads(item["tags_json"])
            item["embedding"] = json.loads(item["embedding_json"])
            del item["tags_json"]
            del item["embedding_json"]

            # v1.2: Sanitize title
            original_title = item["title"]
            sanitized_title, was_changed = sanitize_title(item["title"], item["city"])
            item["title"] = sanitized_title
            if was_changed:
                sanitized_count += 1
                if len(sanitized_examples) < _SANITIZATION_EXAMPLE_LIMIT:
                    sanitized_examples.append((original_title, sanitized_title))

            items.append(item)

        logger.info(f"Loaded {len(items)} items for city: {city}")
        _log_title_sanitization_summary(f"city={city}", sanitized_count, sanitized_examples)
        return items

    finally:
        conn.close()


def get_items_by_excellence_threshold(threshold: float) -> List[Dict[str, Any]]:
    """
    Get items with excellence >= threshold.

    v1.2: Applies title sanitization on load.

    Args:
        threshold: Minimum excellence score

    Returns:
        List of item dicts
    """
    conn = get_connection()
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    try:
        cursor.execute(
            "SELECT * FROM items WHERE excellence >= ? ORDER BY excellence DESC",
            (threshold,)
        )
        rows = cursor.fetchall()

        items = []
        sanitized_count = 0
        sanitized_examples: List[Tuple[str, str]] = []
        for row in rows:
            item = dict(row)
            item["tags"] = json.loads(item["tags_json"])
            item["embedding"] = json.loads(item["embedding_json"])
            del item["tags_json"]
            del item["embedding_json"]

            # v1.2: Sanitize title
            original_title = item["title"]
            sanitized_title, was_changed = sanitize_title(item["title"], item["city"])
            item["title"] = sanitized_title
            if was_changed:
                sanitized_count += 1
                if len(sanitized_examples) < _SANITIZATION_EXAMPLE_LIMIT:
                    sanitized_examples.append((original_title, sanitized_title))

            items.append(item)

        logger.info(f"Loaded {len(items)} items with excellence >= {threshold}")
        _log_title_sanitization_summary(f"excellence>={threshold}", sanitized_count, sanitized_examples)
        return items

    finally:
        conn.close()


def get_item_by_id(item_id: str) -> Optional[Dict[str, Any]]:
    """
    Get a single item by ID.

    Args:
        item_id: Item ID

    Returns:
        Item dict or None if not found
    """
    conn = get_connection()
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    try:
        cursor.execute("SELECT * FROM items WHERE id = ?", (item_id,))
        row = cursor.fetchone()

        if not row:
            return None

        item = dict(row)
        item["tags"] = json.loads(item["tags_json"])
        item["embedding"] = json.loads(item["embedding_json"])
        del item["tags_json"]
        del item["embedding_json"]

        return item

    finally:
        conn.close()


def get_database_stats() -> Dict[str, Any]:
    """
    Get database statistics.

    Returns:
        Stats dict
    """
    conn = get_connection()
    cursor = conn.cursor()

    try:
        cursor.execute("SELECT COUNT(*) FROM items")
        total_items = cursor.fetchone()[0]

        cursor.execute("SELECT COUNT(DISTINCT city) FROM items")
        total_cities = cursor.fetchone()[0]

        cursor.execute("SELECT city, COUNT(*) FROM items GROUP BY city")
        city_distribution = {row[0]: row[1] for row in cursor.fetchall()}

        cursor.execute("SELECT AVG(excellence), MIN(excellence), MAX(excellence) FROM items")
        avg_exc, min_exc, max_exc = cursor.fetchone()

        return {
            "total_items": total_items,
            "total_cities": total_cities,
            "city_distribution": city_distribution,
            "excellence_stats": {
                "avg": round(avg_exc, 3) if avg_exc else 0,
                "min": round(min_exc, 3) if min_exc else 0,
                "max": round(max_exc, 3) if max_exc else 0
            },
            "db_path": DB_PATH
        }

    finally:
        conn.close()
