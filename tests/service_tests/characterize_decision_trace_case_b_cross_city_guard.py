#!/usr/bin/env python3
"""
Characterization test (Case B):
Rerank fallback guard should reject cross-city intruders in contaminated CZ input.

Run from repo root:
  python3 tests/service_tests/characterize_decision_trace_case_b_cross_city_guard.py
"""

import os
import sys
from pathlib import Path

# Avoid external embedding dependency in characterization tests.
os.environ["MEM_INFLUENCE_MODE"] = "fallback"

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from services.recommendation.rerank import rerank_candidates  # noqa: E402


def main() -> None:
    # Intentionally feed contaminated recall-like input to verify rerank fallback guard.
    # This test does NOT treat rerank warning logs as failure.
    recall_results = {
        "cz_candidates": [
            {
                "id": "tokyo_cz_001",
                "city": "tokyo",
                "title": "Tokyo Noodle House",
                "tags": ["ramen", "noodles"],
                "excellence": 0.87,
            },
            {
                "id": "osaka_cz_intruder_001",
                "city": "osaka",
                "title": "Osaka Street Eats",
                "tags": ["food", "street"],
                "excellence": 0.95,
            },
        ],
        "ez_candidates": [
            {
                "id": "tokyo_ez_001",
                "city": "tokyo",
                "title": "Tokyo Heritage Trail",
                "tags": ["culture", "walk"],
                "excellence": 0.9,
            }
        ],
    }

    rerank = rerank_candidates(
        recall_results=recall_results,
        user_id="u_case_b",
        user_city="tokyo",
        user_tags=["ramen"],
    )

    cz_ranked = rerank.get("cz_ranked", [])
    cz_ids = {item.get("id") for item in cz_ranked}
    assert "osaka_cz_intruder_001" not in cz_ids, (
        "Case B: contaminated intruder should be filtered out by rerank cross-city guard"
    )
    assert all((item.get("city") or "").lower() == "tokyo" for item in cz_ranked), (
        "Case B: all CZ ranked items should match user_city=tokyo"
    )

    trace = rerank.get("decision_trace") or {}
    filters = trace.get("filters") or {}
    assert "cz_cross_city_rejected" in filters, (
        "Case B TODO(trace gap): decision_trace.filters.cz_cross_city_rejected missing"
    )
    assert filters.get("cz_cross_city_rejected", 0) >= 1, (
        "Case B: expected decision_trace.filters.cz_cross_city_rejected >= 1"
    )
    cross_city_guard = filters.get("cross_city_guard") or {}
    assert cross_city_guard.get("rule_id") == "cross_city_guard_v1", (
        "Case B: decision_trace.filters.cross_city_guard.rule_id should be cross_city_guard_v1"
    )
    rejected_ids = cross_city_guard.get("rejected_ids") or []
    assert "osaka_cz_intruder_001" in rejected_ids, (
        "Case B: rerank trace cross_city_guard.rejected_ids should include intruder id"
    )
    rejected_cities = cross_city_guard.get("rejected_cities") or {}
    assert rejected_cities.get("osaka_cz_intruder_001") == "osaka", (
        "Case B: rerank trace cross_city_guard.rejected_cities should keep city evidence"
    )

    print(f"{Path(__file__).stem}: PASS")


if __name__ == "__main__":
    main()
