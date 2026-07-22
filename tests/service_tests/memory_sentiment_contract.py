#!/usr/bin/env python3
"""Regression contract for canonical signed memory sentiment."""

from __future__ import annotations

import json
import math
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

from fastapi.testclient import TestClient

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from services.memory import db as memory_db  # noqa: E402
from services.memory import main as memory_main  # noqa: E402
from services.memory.search import compute_sentiment_weight, search_memories  # noqa: E402


def _unit_vector() -> list[float]:
    return [1.0] + [0.0] * 511


def _write_payload(memory_id: str, sentiment: object) -> dict[str, object]:
    return {
        "data": {
            "memory_id": memory_id,
            "user_id": "sentiment_contract_user",
            "timestamp": "2026-07-22T00:00:00Z",
            "raw_tags": ["test"],
            "normalized_tags": ["test"],
            "sentiment": sentiment,
            "sentiment_scale": "signed_v1",
            "sentiment_source": "contract_explicit",
            "sentiment_confidence": 1.0,
            "sentiment_available": True,
            "embedding": _unit_vector(),
            "source": "contract_test",
        }
    }


def _create_legacy_database(path: Path) -> None:
    conn = sqlite3.connect(path)
    try:
        conn.execute(
            """
            CREATE TABLE p5_memories (
                memory_id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                city TEXT,
                raw_tags TEXT,
                normalized_tags TEXT,
                taxonomy TEXT,
                sentiment REAL,
                embedding TEXT NOT NULL,
                source TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        rows = [
            ("legacy_negative", 0.0, "upload"),
            ("legacy_neutral", 0.5, "upload"),
            ("legacy_positive", 1.0, "upload"),
            # A non-vision legacy writer already followed the signed API. Its
            # overlapping positive value must be marked, not transformed.
            ("legacy_signed", 0.5, "manual_signed_source"),
        ]
        for memory_id, sentiment, source in rows:
            conn.execute(
                """
                INSERT INTO p5_memories (
                    memory_id, user_id, timestamp, raw_tags, normalized_tags,
                    taxonomy, sentiment, embedding, source
                ) VALUES (?, 'legacy_user', '2026-01-01T00:00:00Z', '[]', '[]',
                          '{}', ?, ?, ?)
                """,
                (memory_id, sentiment, json.dumps(_unit_vector()), source),
            )
        conn.commit()
    finally:
        conn.close()


def _assert_migration_is_idempotent(path: Path) -> None:
    _create_legacy_database(path)
    memory_db.init_database()

    conn = sqlite3.connect(path)
    try:
        first_pass = dict(
            conn.execute(
                "SELECT memory_id, sentiment FROM p5_memories ORDER BY memory_id"
            ).fetchall()
        )
        scales = {
            row[0]
            for row in conn.execute("SELECT DISTINCT sentiment_scale FROM p5_memories")
        }
        provenance = {
            row[0]: (row[1], row[2], row[3])
            for row in conn.execute(
                "SELECT memory_id, sentiment_source, sentiment_confidence, sentiment_available "
                "FROM p5_memories ORDER BY memory_id"
            )
        }
    finally:
        conn.close()

    assert first_pass == {
        "legacy_negative": -1.0,
        "legacy_neutral": 0.0,
        "legacy_positive": 1.0,
        "legacy_signed": 0.5,
    }, first_pass
    assert scales == {"signed_v1"}, scales
    assert all(value == ("legacy_unknown", 0.0, 0) for value in provenance.values()), provenance

    memory_db.init_database()
    conn = sqlite3.connect(path)
    try:
        second_pass = dict(
            conn.execute(
                "SELECT memory_id, sentiment FROM p5_memories ORDER BY memory_id"
            ).fetchall()
        )
    finally:
        conn.close()
    assert second_pass == first_pass, "sentiment migration must not run twice"


def main() -> None:
    temp_dir = Path(tempfile.mkdtemp(prefix="taste_aligner_sentiment_"))
    original_db_path = memory_db.DB_PATH

    try:
        migration_db = temp_dir / "legacy.db"
        memory_db.DB_PATH = migration_db
        _assert_migration_is_idempotent(migration_db)

        api_db = temp_dir / "api.db"
        memory_db.DB_PATH = api_db
        memory_db.init_database()
        client = TestClient(memory_main.app)

        valid_cases = ((-1.0, -1.0), (None, 0.0), (0.0, 0.0), (1.0, 1.0))
        for index, (sentiment, expected) in enumerate(valid_cases):
            response = client.post(
                "/write", json=_write_payload(f"valid_{index}", sentiment)
            )
            assert response.status_code == 200, response.text
            stored = memory_db.read_memory(f"valid_{index}")
            assert stored is not None
            assert stored["sentiment"] == expected
            assert stored["sentiment_scale"] == "signed_v1"

        for index, sentiment in enumerate((-1.01, 1.01, True, "0.5")):
            response = client.post(
                "/write", json=_write_payload(f"invalid_{index}", sentiment)
            )
            assert response.status_code == 422, (sentiment, response.text)

        assert math.isclose(compute_sentiment_weight(-1.0), 0.5)
        assert math.isclose(compute_sentiment_weight(-0.5), 0.75)
        assert math.isclose(compute_sentiment_weight(0.0), 1.0)
        assert math.isclose(compute_sentiment_weight(0.5), 1.25)
        assert math.isclose(compute_sentiment_weight(1.0), 1.5)
        assert math.isclose(compute_sentiment_weight(1.0, confidence=0.4), 1.2)
        assert math.isclose(compute_sentiment_weight(-1.0, confidence=0.4), 0.8)
        assert math.isclose(compute_sentiment_weight(1.0, confidence=1.0, available=False), 1.0)
        assert math.isclose(compute_sentiment_weight(None), 1.0)  # type: ignore[arg-type]
        assert math.isclose(compute_sentiment_weight(math.nan), 1.0)

        ranked = search_memories(
            memories=[
                {
                    "memory_id": "negative",
                    "embedding": _unit_vector(),
                    "normalized_tags": ["test"],
                    "timestamp": "2026-07-22T00:00:00Z",
                    "city": "tokyo",
                    "sentiment": -1.0,
                },
                {
                    "memory_id": "neutral",
                    "embedding": _unit_vector(),
                    "normalized_tags": ["test"],
                    "timestamp": "2026-07-22T00:00:00Z",
                    "city": "tokyo",
                    "sentiment": 0.0,
                },
                {
                    "memory_id": "positive",
                    "embedding": _unit_vector(),
                    "normalized_tags": ["test"],
                    "timestamp": "2026-07-22T00:00:00Z",
                    "city": "tokyo",
                    "sentiment": 1.0,
                },
            ],
            query_embedding=_unit_vector(),
            query_tags=["test"],
            query_city="tokyo",
            now_ts="2026-07-22T00:00:00Z",
            top_k=3,
        )
        assert [item["memory_id"] for item in ranked] == [
            "positive",
            "neutral",
            "negative",
        ], ranked
        assert [item["w_sent"] for item in ranked] == [1.5, 1.0, 0.5], ranked

        print("memory_sentiment_contract: PASS")
    finally:
        memory_db.DB_PATH = original_db_path
        shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
