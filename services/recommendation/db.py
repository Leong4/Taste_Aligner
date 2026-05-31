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
PRIMARY_TABLE_CANDIDATES = ("reco_items", "items")


def get_connection():
    """Get database connection."""
    return sqlite3.connect(DB_PATH)


def _list_tables(conn: sqlite3.Connection) -> List[str]:
    cursor = conn.cursor()
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
    return [row[0] for row in cursor.fetchall()]


def _resolve_primary_items_table(conn: sqlite3.Connection) -> Optional[str]:
    """Resolve runtime candidate source table, preferring reco_items."""
    tables = set(_list_tables(conn))
    for table in PRIMARY_TABLE_CANDIDATES:
        if table in tables:
            return table
    return None


def get_candidate_source_table() -> str:
    """Expose current runtime candidate source table for debug/trace."""
    conn = get_connection()
    try:
        table = _resolve_primary_items_table(conn)
        return table or "unknown"
    finally:
        conn.close()


def _build_items_select_sql(table: str, where_clause: str = "") -> str:
    """Return a canonical SELECT shape regardless of physical table schema."""
    suffix = f" WHERE {where_clause}" if where_clause else ""
    if table == "reco_items":
        return (
            "SELECT item_id AS id, city, type, title, tags_json, excellence, "
            "description, created_at, updated_at, NULL AS embedding_json "
            f"FROM {table}{suffix} ORDER BY excellence DESC"
        )
    return (
        "SELECT id, city, 'unknown' AS type, title, tags_json, excellence, "
        "description, created_at, updated_at, embedding_json "
        f"FROM {table}{suffix} ORDER BY excellence DESC"
    )


def _decode_item_row(row: sqlite3.Row) -> Dict[str, Any]:
    item = dict(row)
    tags_raw = item.get("tags_json", "[]")
    embedding_raw = item.get("embedding_json", "[]")
    item["tags"] = json.loads(tags_raw) if isinstance(tags_raw, str) else []
    item["embedding"] = json.loads(embedding_raw) if isinstance(embedding_raw, str) else []
    item.pop("tags_json", None)
    item.pop("embedding_json", None)
    item.setdefault("type", "unknown")
    return item


def ensure_item_embeddings_table(db_path: Optional[str] = None) -> None:
    """Create or migrate item_embeddings table schema."""
    path = db_path or DB_PATH
    conn = sqlite3.connect(path)
    try:
        cursor = conn.cursor()
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS item_embeddings (
                item_id TEXT PRIMARY KEY,
                embedding_space TEXT NOT NULL DEFAULT 'tes_v1_fallback',
                dim INTEGER NOT NULL,
                vector_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        cursor.execute("PRAGMA table_info(item_embeddings)")
        columns = {row[1].lower() for row in cursor.fetchall()}
        if "embedding_space" not in columns:
            cursor.execute(
                "ALTER TABLE item_embeddings "
                "ADD COLUMN embedding_space TEXT NOT NULL DEFAULT 'tes_v1_fallback'"
            )
        conn.commit()
    finally:
        conn.close()


def get_item_embedding(
    item_id: str,
    embedding_space: str = "tes_v2",
    db_path: Optional[str] = None
) -> Optional[List[float]]:
    """Get cached item embedding vector from SQLite for a specific embedding space."""
    if not item_id:
        return None

    path = db_path or DB_PATH
    ensure_item_embeddings_table(path)
    conn = sqlite3.connect(path)
    cursor = conn.cursor()
    try:
        cursor.execute(
            "SELECT vector_json, embedding_space FROM item_embeddings WHERE item_id = ?",
            (item_id,)
        )
        row = cursor.fetchone()
        if not row:
            return None
        cached_space = row[1] if len(row) > 1 else "tes_v1_fallback"
        if cached_space != embedding_space:
            return None
        return json.loads(row[0])
    finally:
        conn.close()


def upsert_item_embedding(
    item_id: str,
    vector: List[float],
    embedding_space: str = "tes_v2",
    db_path: Optional[str] = None
) -> None:
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
            INSERT INTO item_embeddings (item_id, embedding_space, dim, vector_json, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(item_id) DO UPDATE SET
                embedding_space=excluded.embedding_space,
                dim=excluded.dim,
                vector_json=excluded.vector_json,
                updated_at=excluded.updated_at
            """,
            (
                item_id,
                embedding_space,
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
    tables = _list_tables(conn)
    preferred = _resolve_primary_items_table(conn)
    if preferred:
        return preferred

    for table in tables:
        if table == "item_embeddings":
            continue
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
        table = _resolve_primary_items_table(conn)
        if not table:
            logger.warning("No candidate source table found")
            return []
        cursor.execute(_build_items_select_sql(table))
        rows = cursor.fetchall()

        items = []
        sanitized_count = 0
        sanitized_examples: List[Tuple[str, str]] = []
        for row in rows:
            item = _decode_item_row(row)

            # v1.2: Sanitize title
            original_title = item["title"]
            sanitized_title, was_changed = sanitize_title(item["title"], item["city"])
            if was_changed:
                item["title"] = sanitized_title
                sanitized_count += 1
                if len(sanitized_examples) < _SANITIZATION_EXAMPLE_LIMIT:
                    sanitized_examples.append((original_title, sanitized_title))

            items.append(item)

        logger.info(
            f"Loaded {len(items)} items from database table={table} "
            f"({sanitized_count} titles sanitized)"
        )
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
        table = _resolve_primary_items_table(conn)
        if not table:
            logger.warning("No candidate source table found")
            return []
        cursor.execute(
            _build_items_select_sql(table, "LOWER(city) = LOWER(?)"),
            (city,)
        )
        rows = cursor.fetchall()

        items = []
        sanitized_count = 0
        sanitized_examples: List[Tuple[str, str]] = []
        for row in rows:
            item = _decode_item_row(row)

            # v1.2: Sanitize title
            original_title = item["title"]
            sanitized_title, was_changed = sanitize_title(item["title"], item["city"])
            item["title"] = sanitized_title
            if was_changed:
                sanitized_count += 1
                if len(sanitized_examples) < _SANITIZATION_EXAMPLE_LIMIT:
                    sanitized_examples.append((original_title, sanitized_title))

            items.append(item)

        logger.info(f"Loaded {len(items)} items for city={city} table={table}")
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
        table = _resolve_primary_items_table(conn)
        if not table:
            logger.warning("No candidate source table found")
            return []
        cursor.execute(
            _build_items_select_sql(table, "excellence >= ?"),
            (threshold,)
        )
        rows = cursor.fetchall()

        items = []
        sanitized_count = 0
        sanitized_examples: List[Tuple[str, str]] = []
        for row in rows:
            item = _decode_item_row(row)

            # v1.2: Sanitize title
            original_title = item["title"]
            sanitized_title, was_changed = sanitize_title(item["title"], item["city"])
            item["title"] = sanitized_title
            if was_changed:
                sanitized_count += 1
                if len(sanitized_examples) < _SANITIZATION_EXAMPLE_LIMIT:
                    sanitized_examples.append((original_title, sanitized_title))

            items.append(item)

        logger.info(
            f"Loaded {len(items)} items with excellence>={threshold} table={table}"
        )
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
        table = _resolve_primary_items_table(conn)
        if not table:
            logger.warning("No candidate source table found")
            return None
        key_col = "item_id" if table == "reco_items" else "id"
        cursor.execute(
            _build_items_select_sql(table, f"{key_col} = ?"),
            (item_id,)
        )
        row = cursor.fetchone()

        if not row:
            return None

        return _decode_item_row(row)

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
        table = _resolve_primary_items_table(conn)
        if not table:
            return {
                "total_items": 0,
                "total_cities": 0,
                "city_distribution": {},
                "excellence_stats": {"avg": 0, "min": 0, "max": 0},
                "db_path": DB_PATH,
                "candidate_source_table": "unknown",
            }
        cursor.execute(f"SELECT COUNT(*) FROM {table}")
        total_items = cursor.fetchone()[0]

        cursor.execute(f"SELECT COUNT(DISTINCT city) FROM {table}")
        total_cities = cursor.fetchone()[0]

        cursor.execute(f"SELECT city, COUNT(*) FROM {table} GROUP BY city")
        city_distribution = {row[0]: row[1] for row in cursor.fetchall()}

        cursor.execute(f"SELECT AVG(excellence), MIN(excellence), MAX(excellence) FROM {table}")
        avg_exc, min_exc, max_exc = cursor.fetchone()

        return {
            "total_items": total_items,
            "total_cities": total_cities,
            "city_distribution": city_distribution,
            "candidate_source_table": table,
            "excellence_stats": {
                "avg": round(avg_exc, 3) if avg_exc else 0,
                "min": round(min_exc, 3) if min_exc else 0,
                "max": round(max_exc, 3) if max_exc else 0
            },
            "db_path": DB_PATH
        }

    finally:
        conn.close()
