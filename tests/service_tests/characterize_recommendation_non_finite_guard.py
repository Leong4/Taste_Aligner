#!/usr/bin/env python3
"""
Characterization test: recommendation response must never contain non-finite floats.

Run from repo root:
  python3 tests/service_tests/characterize_recommendation_non_finite_guard.py
"""

import asyncio
import math
import os
import sys
from pathlib import Path

os.environ["MEM_INFLUENCE_MODE"] = "fallback"
REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import services.recommendation.main as reco_main  # noqa: E402


def assert_all_finite(obj, path=""):
    if isinstance(obj, float):
        assert math.isfinite(obj), f"non-finite float at {path}: {obj!r}"
        return
    if isinstance(obj, list):
        for idx, item in enumerate(obj):
            assert_all_finite(item, f"{path}[{idx}]")
        return
    if isinstance(obj, dict):
        for key, value in obj.items():
            next_path = f"{path}.{key}" if path else str(key)
            assert_all_finite(value, next_path)


async def main_async() -> None:
    original_recall = reco_main.recall_candidates

    def fake_recall_candidates(city, normalized_tags, user_id):  # noqa: ARG001
        return {
            "cz_candidates": [
                {
                    "id": "tokyo_bad_cz",
                    "city": city,
                    "title": "Bad CZ",
                    "tags": ["ramen"],
                    "excellence": float("inf"),
                }
            ],
            "ez_candidates": [
                {
                    "id": "tokyo_bad_ez",
                    "city": city,
                    "title": "Bad EZ",
                    "tags": ["izakaya"],
                    "excellence": float("nan"),
                }
            ],
            "total_candidates": 2,
            "recall_rules": ["test_injected_non_finite"],
            "stats": {"test_mode": True},
            "decision_trace": {"recall": {"rule_id": "test_recall_non_finite"}},
        }

    reco_main.recall_candidates = fake_recall_candidates
    try:
        request = reco_main.ScoreRequest(
            data=reco_main.ScoreRequestData(
                user_id="u001",
                city="tokyo",
                tags=["ramen", "izakaya"],
                intent="balanced",
                memory_confidence=0.6,
            )
        )
        response = await reco_main.score_endpoint(request)
    finally:
        reco_main.recall_candidates = original_recall

    assert isinstance(response, dict), "response must be dict"
    assert_all_finite(response)

    response_sanitizer = (
        (response.get("decision_trace") or {}).get("response_sanitizer") or {}
    )
    count = response_sanitizer.get("sanitized_non_finite_count", 0)
    assert count >= 0, "response_sanitizer.sanitized_non_finite_count must exist"

    rerank_guard = ((response.get("decision_trace") or {}).get("rerank") or {}).get(
        "non_finite_guard",
        {}
    )
    assert rerank_guard.get("sanitized_non_finite_count", 0) > 0, (
        "expected rerank.non_finite_guard.sanitized_non_finite_count > 0"
    )

    print("characterize_recommendation_non_finite_guard: PASS")


if __name__ == "__main__":
    asyncio.run(main_async())
