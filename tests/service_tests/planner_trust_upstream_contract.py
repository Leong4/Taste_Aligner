#!/usr/bin/env python3
"""
Planner trust_upstream contract characterization.

Run from repo root:
  python3 tests/service_tests/planner_trust_upstream_contract.py
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Dict, List

from fastapi.testclient import TestClient

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from services.planner import main as planner_main  # noqa: E402


class FakeResponse:
    def __init__(self, status_code: int, body: Dict[str, Any]):
        self.status_code = status_code
        self._body = body

    def json(self) -> Dict[str, Any]:
        return self._body


def _flatten_item_ids(cards: List[Dict[str, Any]]) -> List[str]:
    ids: List[str] = []
    for card in cards:
        for item in card.get("items", []):
            item_id = item.get("item_id")
            if item_id:
                ids.append(item_id)
    return ids


def _assert_trust_upstream_no_rescore_and_order() -> None:
    calls: List[str] = []

    def fake_post(url: str, *args: Any, **kwargs: Any) -> FakeResponse:
        calls.append(url)
        if url.endswith("/score"):
            raise AssertionError("trust_upstream path must not call recommendation /score")
        if url.endswith("/search"):
            return FakeResponse(200, {"results": []})
        return FakeResponse(500, {})

    def fake_get(url: str, *args: Any, **kwargs: Any) -> FakeResponse:
        # Force memory_health_ok=False to avoid memory.search calls.
        if url.endswith("/health"):
            return FakeResponse(503, {"ok": False})
        return FakeResponse(500, {})

    original_post = planner_main.requests.post
    original_get = planner_main.requests.get
    planner_main.requests.post = fake_post
    planner_main.requests.get = fake_get
    try:
        client = TestClient(planner_main.app)
        payload = {
            "data": {
                "user_id": "u_trust",
                "city": "tokyo",
                "tags": ["ramen"],
                "controls": {"topk_cz": 3, "topk_ez": 2},
                "cz_ranked": [
                    {
                        "id": "cz_1",
                        "city": "tokyo",
                        "title": "CZ 1",
                        "tags": ["ramen"],
                        "score_CZ": 3.0,
                        "components": {"tag_similarity": 0.9, "memory_influence": 1.1, "location_relevance": 1.0},
                    },
                    {
                        "id": "cz_2",
                        "city": "tokyo",
                        "title": "CZ 2",
                        "tags": ["ramen"],
                        "score_CZ": 2.0,
                        "components": {"tag_similarity": 0.8, "memory_influence": 1.0, "location_relevance": 1.0},
                    },
                    {
                        "id": "cz_3",
                        "city": "tokyo",
                        "title": "CZ 3",
                        "tags": ["ramen"],
                        "score_CZ": 1.0,
                        "components": {"tag_similarity": 0.7, "memory_influence": 1.0, "location_relevance": 1.0},
                    },
                ],
                "ez_ranked": [
                    {
                        "id": "ez_1",
                        "city": "tokyo",
                        "title": "EZ 1",
                        "tags": ["sightseeing"],
                        "score_EZ": 2.0,
                        "components": {"global_excellence": 0.95, "taste_distance": 0.4},
                    },
                    {
                        "id": "ez_2",
                        "city": "tokyo",
                        "title": "EZ 2",
                        "tags": ["culture"],
                        "score_EZ": 1.0,
                        "components": {"global_excellence": 0.9, "taste_distance": 0.3},
                    },
                ],
                "mix_policy": {"ratio": "3:2", "rule": "test_upstream"},
                "decision_trace": {"rerank": {"rule_id": "rerank_upstream_test"}},
            }
        }
        resp = client.post("/compose", json=payload)
        assert resp.status_code == 200
        body = resp.json()
        trace = body["decision_trace"]["planner"]

        assert trace["planner_mode"] == "trust_upstream"
        assert trace["used_upstream_rankings"] is True
        assert trace["rescored"] is False

        assert not any(url.endswith("/score") for url in calls)

        item_ids = _flatten_item_ids(body.get("cards", []))
        expected_top5 = ["cz_1", "cz_2", "cz_3", "ez_1", "ez_2"]
        overlap = len(set(item_ids[:5]) & set(expected_top5)) / float(len(expected_top5))
        assert overlap >= 0.9, f"expected top5 overlap >= 0.9, got {overlap:.2f}"
    finally:
        planner_main.requests.post = original_post
        planner_main.requests.get = original_get


def _assert_missing_upstream_fallbacks_to_rescore() -> None:
    score_calls: List[str] = []

    reco_payload = {
        "version": "v1.3",
        "cz_ranked": [
            {"id": "fallback_cz_1", "city": "tokyo", "title": "Fallback CZ 1", "tags": ["ramen"], "score_CZ": 2.0, "components": {}}
        ],
        "ez_ranked": [
            {"id": "fallback_ez_1", "city": "tokyo", "title": "Fallback EZ 1", "tags": ["walk"], "score_EZ": 1.0, "components": {}}
        ],
        "mix_policy": {"ratio": "1:1", "rule": "fallback_rule"},
        "decision_trace": {"rerank": {"rule_id": "rerank_v1_3"}},
    }

    def fake_post(url: str, *args: Any, **kwargs: Any) -> FakeResponse:
        if url.endswith("/score"):
            score_calls.append(url)
            return FakeResponse(200, reco_payload)
        if url.endswith("/search"):
            return FakeResponse(200, {"results": []})
        return FakeResponse(500, {})

    def fake_get(url: str, *args: Any, **kwargs: Any) -> FakeResponse:
        if url.endswith("/health"):
            return FakeResponse(503, {"ok": False})
        return FakeResponse(500, {})

    original_post = planner_main.requests.post
    original_get = planner_main.requests.get
    planner_main.requests.post = fake_post
    planner_main.requests.get = fake_get
    try:
        client = TestClient(planner_main.app)
        payload = {
            "data": {
                "user_id": "u_fallback_missing",
                "city": "tokyo",
                "tags": ["ramen"],
            }
        }
        resp = client.post("/compose", json=payload)
        assert resp.status_code == 200
        body = resp.json()
        trace = body["decision_trace"]["planner"]

        assert len(score_calls) == 1
        assert trace["planner_mode"] == "fallback_rescore"
        assert trace["used_upstream_rankings"] is False
        assert trace["rescored"] is True
        assert trace["fallback_reason"] == "missing_upstream_rankings"
    finally:
        planner_main.requests.post = original_post
        planner_main.requests.get = original_get


def _assert_empty_upstream_fallbacks_to_rescore() -> None:
    score_calls: List[str] = []

    reco_payload = {
        "version": "v1.3",
        "cz_ranked": [
            {"id": "fallback2_cz_1", "city": "tokyo", "title": "Fallback2 CZ 1", "tags": ["ramen"], "score_CZ": 2.5, "components": {}}
        ],
        "ez_ranked": [],
        "mix_policy": {"ratio": "3:0", "rule": "fallback_rule_empty"},
        "decision_trace": {"rerank": {"rule_id": "rerank_v1_3"}},
    }

    def fake_post(url: str, *args: Any, **kwargs: Any) -> FakeResponse:
        if url.endswith("/score"):
            score_calls.append(url)
            return FakeResponse(200, reco_payload)
        if url.endswith("/search"):
            return FakeResponse(200, {"results": []})
        return FakeResponse(500, {})

    def fake_get(url: str, *args: Any, **kwargs: Any) -> FakeResponse:
        if url.endswith("/health"):
            return FakeResponse(503, {"ok": False})
        return FakeResponse(500, {})

    original_post = planner_main.requests.post
    original_get = planner_main.requests.get
    planner_main.requests.post = fake_post
    planner_main.requests.get = fake_get
    try:
        client = TestClient(planner_main.app)
        payload = {
            "data": {
                "user_id": "u_fallback_empty",
                "city": "tokyo",
                "tags": ["ramen"],
                "cz_ranked": [],
                "ez_ranked": [],
                "mix_policy": {"ratio": "3:0"},
                "decision_trace": {"rerank": {"rule_id": "rerank_upstream_empty"}},
            }
        }
        resp = client.post("/compose", json=payload)
        assert resp.status_code == 200
        body = resp.json()
        trace = body["decision_trace"]["planner"]

        assert len(score_calls) == 1
        assert trace["planner_mode"] == "fallback_rescore"
        assert trace["used_upstream_rankings"] is False
        assert trace["rescored"] is True
        assert trace["fallback_reason"] == "upstream_empty_after_selection"
    finally:
        planner_main.requests.post = original_post
        planner_main.requests.get = original_get


def main() -> None:
    _assert_trust_upstream_no_rescore_and_order()
    _assert_missing_upstream_fallbacks_to_rescore()
    _assert_empty_upstream_fallbacks_to_rescore()
    print(f"{Path(__file__).stem}: PASS")


if __name__ == "__main__":
    main()
