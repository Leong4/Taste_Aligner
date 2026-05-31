#!/usr/bin/env python3
"""
Contract test for memory.search pool filtering:
  - memory_pool=food returns only vision_type=food
  - memory_pool=scenery returns only vision_type=scenery
  - memory_pool=all does not filter

Run from repo root:
  python3 tests/service_tests/memory_pooling_contract.py
"""

from __future__ import annotations

import sys
import uuid
from pathlib import Path

from fastapi.testclient import TestClient

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from services.memory import db as memory_db  # noqa: E402
from services.memory import main as memory_main  # noqa: E402


def _unit_vector(index: int) -> list[float]:
    vec = [0.0] * 512
    vec[index] = 1.0
    return vec


def _write_memory(user_id: str, memory_id: str, vision_type: str, embedding_index: int) -> None:
    memory_db.write_memory(
        {
            "memory_id": memory_id,
            "user_id": user_id,
            "timestamp": "2026-03-01T00:00:00Z",
            "city": "tokyo",
            "raw_tags": ["test"],
            "normalized_tags": ["test"],
            "taxonomy": {},
            "sentiment": 0.0,
            "embedding": _unit_vector(embedding_index),
            "source": "contract_test",
            "vision_type": vision_type,
        }
    )


def _search(client: TestClient, user_id: str, memory_pool: str) -> list[str]:
    payload = {
        "data": {
            "user_id": user_id,
            "query_embedding": _unit_vector(0),
            "query_tags": ["test"],
            "city": "tokyo",
            "now_ts": "2026-03-10T00:00:00Z",
            "top_k": 10,
            "memory_pool": memory_pool,
        }
    }
    resp = client.post("/search", json=payload)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    return [item["memory_id"] for item in body.get("results", [])]


def main() -> None:
    suffix = uuid.uuid4().hex[:8]
    memory_dir = Path(memory_main.__file__).resolve().parent
    test_db_path = memory_dir / f"memory_pooling_test_{suffix}.db"

    original_db_path = memory_db.DB_PATH
    memory_db.DB_PATH = test_db_path

    try:
        memory_db.init_database()
        user_id = f"pool_user_{suffix}"
        food_id = f"food_{suffix}"
        scenery_id = f"scenery_{suffix}"
        unknown_id = f"unknown_{suffix}"

        _write_memory(user_id, food_id, "food", 0)
        _write_memory(user_id, scenery_id, "scenery", 1)
        _write_memory(user_id, unknown_id, "unknown", 2)

        client = TestClient(memory_main.app)

        food_results = _search(client, user_id, "food")
        scenery_results = _search(client, user_id, "scenery")
        all_results = _search(client, user_id, "all")

        assert food_results == [food_id], f"food pool must only return food memory, got {food_results}"
        assert scenery_results == [scenery_id], (
            f"scenery pool must only return scenery memory, got {scenery_results}"
        )
        assert set(all_results) == {food_id, scenery_id, unknown_id}, (
            f"all pool must not filter, got {all_results}"
        )

        print("memory_pooling_contract: PASS")
    finally:
        memory_db.DB_PATH = original_db_path
        if test_db_path.exists():
            test_db_path.unlink()


if __name__ == "__main__":
    main()
