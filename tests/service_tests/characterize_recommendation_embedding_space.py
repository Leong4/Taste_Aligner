#!/usr/bin/env python3
"""
Characterization tests for recommendation embedding space unification.

Run from repo root:
  python3 tests/service_tests/characterize_recommendation_embedding_space.py
"""

from __future__ import annotations

import asyncio
import math
import sys
from pathlib import Path
from typing import Any, Dict, List

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from services.recommendation import embedding_client, rerank  # noqa: E402
import services.recommendation.main as reco_main  # noqa: E402


class FakeResponse:
    def __init__(self, status_code: int, body: Dict[str, Any]):
        self.status_code = status_code
        self._body = body

    def json(self) -> Dict[str, Any]:
        return self._body


def _unit_vector(dim: int = 512, active_index: int = 0) -> List[float]:
    vec = [0.0] * dim
    vec[active_index] = 1.0
    return vec


def _assert_unit(vec: List[float]) -> None:
    assert len(vec) == 512, f"expected dim=512, got {len(vec)}"
    norm = math.sqrt(sum(float(v) * float(v) for v in vec))
    assert abs(norm - 1.0) < 1e-6, f"expected normalized vector, got norm={norm}"


def _test_embedding_client_prefers_tes_v2() -> None:
    calls: List[str] = []

    def fake_post(url: str, json: Dict[str, Any], timeout: float):  # noqa: ARG001
        calls.append(url)
        if url.endswith("/tes/build"):
            return FakeResponse(200, {"vector": _unit_vector()})
        if url.endswith("/generate"):
            raise AssertionError("TES v1 /generate must not be called on healthy TES v2")
        return FakeResponse(500, {})

    original_post = embedding_client.requests.post
    embedding_client.requests.post = fake_post
    try:
        vec, err, space, fallback_reason = embedding_client.generate_embedding_with_error(
            vision_tags=["ramen", "tokyo"],
            normalized_tags=["ramen", "japanese"],
            location="tokyo",
            retries=1,
        )
    finally:
        embedding_client.requests.post = original_post

    assert err is None, f"unexpected error: {err}"
    assert fallback_reason is None
    assert space == "tes_v2", f"expected tes_v2, got {space}"
    assert vec is not None
    _assert_unit(vec)
    assert any(url.endswith("/tes/build") for url in calls)
    assert not any(url.endswith("/generate") for url in calls)


def _test_embedding_client_fallback_to_tes_v1() -> None:
    calls: List[str] = []

    def fake_post(url: str, json: Dict[str, Any], timeout: float):  # noqa: ARG001
        calls.append(url)
        if url.endswith("/tes/build"):
            return FakeResponse(500, {"detail": "upstream error"})
        if url.endswith("/generate"):
            return FakeResponse(200, {"vector": _unit_vector(active_index=1)})
        return FakeResponse(500, {})

    original_post = embedding_client.requests.post
    embedding_client.requests.post = fake_post
    try:
        vec, err, space, fallback_reason = embedding_client.generate_embedding_with_error(
            vision_tags=["ramen"],
            normalized_tags=["noodle"],
            location="tokyo",
            retries=1,
        )
    finally:
        embedding_client.requests.post = original_post

    assert err is None, f"unexpected error: {err}"
    assert space == "tes_v1_fallback", f"expected tes_v1_fallback, got {space}"
    assert isinstance(fallback_reason, str) and fallback_reason.startswith("tes_v2_")
    assert vec is not None
    _assert_unit(vec)
    assert any(url.endswith("/tes/build") for url in calls)
    assert any(url.endswith("/generate") for url in calls)


def _test_rerank_trace_exposes_embedding_space() -> None:
    original_gen = rerank.generate_embedding_with_error
    original_get = rerank.get_item_embedding
    original_upsert = rerank.upsert_item_embedding

    try:
        rerank.get_item_embedding = lambda item_id, embedding_space="tes_v2": None
        rerank.upsert_item_embedding = lambda item_id, vector, embedding_space="tes_v2": None

        rerank.generate_embedding_with_error = (
            lambda **kwargs: (_unit_vector(), None, "tes_v1_fallback", "tes_v2_http_500")
        )
        recall_results = {
            "cz_candidates": [
                {
                    "id": "tokyo_ramen_1",
                    "city": "tokyo",
                    "title": "Ramen Spot",
                    "tags": ["ramen", "noodle"],
                    "excellence": 0.9,
                }
            ],
            "ez_candidates": [],
        }
        out = rerank.rerank_candidates(recall_results, "u1", "tokyo", ["ramen", "noodle"])
    finally:
        rerank.generate_embedding_with_error = original_gen
        rerank.get_item_embedding = original_get
        rerank.upsert_item_embedding = original_upsert

    stats = out["stats"]
    assert stats["embedding_space"] == "tes_v1_fallback"
    assert stats["embedding_fallback_reason"] == "tes_v2_http_500"
    detail = out["cz_ranked"][0]["memory_influence_detail"]
    assert detail["embedding_space"] == "tes_v1_fallback"
    assert detail["fallback_reason"] == "tes_v2_http_500"
    assert out["decision_trace"]["embedding"]["embedding_space"] == "tes_v1_fallback"


async def _test_score_debug_fields_present() -> None:
    original_recall = reco_main.recall_candidates
    original_rerank = reco_main.rerank_candidates
    try:
        reco_main.recall_candidates = lambda city, normalized_tags, user_id: {
            "cz_candidates": [],
            "ez_candidates": [],
            "total_candidates": 0,
            "recall_rules": [],
            "stats": {},
        }
        reco_main.rerank_candidates = lambda **kwargs: {
            "cz_ranked": [],
            "ez_ranked": [],
            "stats": {
                "embedding_space": "tes_v2",
                "embedding_space_counts": {"tes_v2": 0, "tes_v1_fallback": 0, "none": 0},
                "embedding_fallback_reason": None,
                "embedding_ok_count": 0,
                "embedding_fail_count": 0,
                "embedding_last_error": None,
                "ez_diversity_enabled": False,
                "ez_diversity_method": None,
                "ez_lambda_diversity": None,
            },
            "decision_trace": {"rule_id": "rerank_v1_3", "embedding": {"embedding_space": "tes_v2"}},
        }

        req = reco_main.ScoreRequest(
            data=reco_main.ScoreRequestData(
                user_id="u_embed_trace",
                city="tokyo",
                tags=["ramen"],
            )
        )
        response = await reco_main.score_endpoint(req)
    finally:
        reco_main.recall_candidates = original_recall
        reco_main.rerank_candidates = original_rerank

    debug = response.get("debug", {})
    assert debug.get("embedding_space") == "tes_v2"
    assert "embedding_tes_v2_url" in debug
    assert "embedding_tes_v1_fallback_url" in debug


def main() -> None:
    _test_embedding_client_prefers_tes_v2()
    _test_embedding_client_fallback_to_tes_v1()
    _test_rerank_trace_exposes_embedding_space()
    asyncio.run(_test_score_debug_fields_present())
    print(f"{Path(__file__).stem}: PASS")


if __name__ == "__main__":
    main()
