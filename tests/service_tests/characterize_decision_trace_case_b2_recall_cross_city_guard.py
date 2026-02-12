#!/usr/bin/env python3
"""
Characterization test (Case B2):
Recall cross-city guard should reject intruders before rerank.

Run from repo root:
  python3 tests/service_tests/characterize_decision_trace_case_b2_recall_cross_city_guard.py
"""

import os
import sys
from pathlib import Path

os.environ["MEM_INFLUENCE_MODE"] = "fallback"

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import services.recommendation.recall as recall_mod  # noqa: E402
from services.recommendation.rerank import rerank_candidates  # noqa: E402


def main() -> None:
    city_items = [
        {
            "id": "tokyo_cz_001",
            "city": "tokyo",
            "title": "Tokyo Noodle House",
            "tags": ["ramen", "noodles"],
            "excellence": 0.87,
        },
        {
            "id": "tokyo_ez_001",
            "city": "tokyo",
            "title": "Tokyo Heritage Trail",
            "tags": ["culture", "walk"],
            "excellence": 0.9,
        },
        {
            "id": "osaka_intruder_001",
            "city": "osaka",
            "title": "Osaka Street Eats",
            "tags": ["food", "street"],
            "excellence": 0.95,
        },
    ]

    original_get_items_by_city = recall_mod.get_items_by_city
    try:
        recall_mod.get_items_by_city = lambda _city: list(city_items)
        recall_results = recall_mod.recall_candidates(
            city="tokyo",
            normalized_tags=["ramen"],
            user_id="u_case_b2",
        )
    finally:
        recall_mod.get_items_by_city = original_get_items_by_city

    recall_trace = (recall_results.get("decision_trace") or {}).get("recall", {})
    cross_city_guard = recall_trace.get("cross_city_guard") or {}
    rejected_ids = cross_city_guard.get("rejected_ids") or []
    assert "osaka_intruder_001" in rejected_ids, (
        "Case B2: recall trace cross_city_guard.rejected_ids should include osaka item"
    )
    assert all((item.get("city") or "").lower() == "tokyo" for item in recall_results.get("cz_candidates", [])), (
        "Case B2: recall_results.cz_candidates should be city-strict after recall guard"
    )

    rerank = rerank_candidates(
        recall_results=recall_results,
        user_id="u_case_b2",
        user_city="tokyo",
        user_tags=["ramen"],
    )
    rerank_filters = (rerank.get("decision_trace") or {}).get("filters") or {}
    rerank_guard = rerank_filters.get("cross_city_guard") or {}
    rerank_rejected_count = rerank_guard.get("rejected_count")
    assert rerank_rejected_count in (None, 0), (
        "Case B2: rerank cross_city_guard.rejected_count should be 0/None when recall already filtered intruders"
    )

    print("characterize_decision_trace_case_b2_recall_cross_city_guard: PASS")


if __name__ == "__main__":
    main()
