#!/usr/bin/env python3
"""Contract for idempotent Memory Service writes and sentiment provenance."""

from __future__ import annotations

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
from services.memory.search import search_memories  # noqa: E402


def _vector() -> list[float]:
    return [1.0] + [0.0] * 511


def _payload(user_id: str = "persist_user") -> dict[str, object]:
    return {
        "data": {
            "memory_id": "stable-persist-id",
            "user_id": user_id,
            "timestamp": "2026-07-22T00:00:00Z",
            "city": "tokyo",
            "raw_tags": ["ramen"],
            "normalized_tags": ["ramen"],
            "sentiment": -0.8,
            "sentiment_scale": "signed_v1",
            "sentiment_source": "caption_lexicon_v1",
            "sentiment_confidence": 0.75,
            "sentiment_available": True,
            "embedding": _vector(),
            "source": "upload",
        }
    }


def main() -> None:
    temp_dir = Path(tempfile.mkdtemp(prefix="taste_aligner_persist_"))
    original_db = memory_db.DB_PATH
    original_upload_root = memory_main.UPLOAD_ROOT
    try:
        memory_db.DB_PATH = temp_dir / "memory.db"
        memory_main.UPLOAD_ROOT = temp_dir / "uploads"
        memory_main.UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
        memory_db.init_database()
        client = TestClient(memory_main.app)

        first = client.post("/write", json=_payload())
        assert first.status_code == 200, first.text
        assert first.json()["memory_id"] == "stable-persist-id"
        assert first.json().get("idempotent_replay") is not True

        replay = client.post("/write", json=_payload())
        assert replay.status_code == 200, replay.text
        assert replay.json()["memory_id"] == "stable-persist-id"
        assert replay.json()["idempotent_replay"] is True

        conn = sqlite3.connect(memory_db.DB_PATH)
        try:
            count = conn.execute(
                "SELECT COUNT(*) FROM p5_memories WHERE memory_id='stable-persist-id'"
            ).fetchone()[0]
        finally:
            conn.close()
        assert count == 1, count

        stored = memory_db.read_memory("stable-persist-id")
        assert stored is not None
        assert stored["sentiment"] == -0.8
        assert stored["sentiment_source"] == "caption_lexicon_v1"
        assert stored["sentiment_confidence"] == 0.75
        assert stored["sentiment_available"] == 1

        ranked = search_memories(
            memories=[stored],
            query_embedding=_vector(),
            query_tags=["ramen"],
            query_city="tokyo",
            now_ts="2026-07-22T00:00:00Z",
            top_k=1,
        )
        assert len(ranked) == 1, ranked
        assert ranked[0]["w_sent"] == 0.7, ranked
        assert ranked[0]["sentiment_source"] == "caption_lexicon_v1", ranked

        collision = client.post("/write", json=_payload(user_id="other_user"))
        assert collision.status_code == 409, collision.text

        invalid_id = _payload()
        invalid_id["data"]["memory_id"] = "../escape"
        rejected = client.post("/write", json=invalid_id)
        assert rejected.status_code == 422, rejected.text

        print("memory_persistence_contract: PASS")
    finally:
        memory_db.DB_PATH = original_db
        memory_main.UPLOAD_ROOT = original_upload_root
        shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
