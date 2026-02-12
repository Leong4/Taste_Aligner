#!/usr/bin/env python3
"""
Characterization test:
Recall decision_trace should include accepted/rejected evidence and guard data.

Run from repo root:
  python3 tests/service_tests/characterize_decision_trace_recall_trace.py
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import services.recommendation.recall as recall_mod  # noqa: E402


def main() -> None:
    fake_city_items = [
        {
            "id": "tokyo_accept_001",
            "city": "tokyo",
            "title": "Tokyo Accepted",
            "tags": ["ramen", "food"],
            "excellence": 0.92,
        },
        {
            "id": "tokyo_reject_ez_001",
            "city": "tokyo",
            "title": "Tokyo Low Excellence",
            "tags": ["walk"],
            "excellence": 0.1,
        },
        {
            "id": "osaka_intruder_001",
            "city": "osaka",
            "title": "Osaka Intruder",
            "tags": ["food"],
            "excellence": 0.99,
        },
    ]

    original_get_items_by_city = recall_mod.get_items_by_city
    try:
        recall_mod.get_items_by_city = lambda _city: list(fake_city_items)

        result = recall_mod.recall_candidates(
            city="tokyo",
            normalized_tags=["ramen"],
            user_id="u_recall_trace",
        )
    finally:
        recall_mod.get_items_by_city = original_get_items_by_city

    trace_root = result.get("decision_trace") or {}
    recall_trace = trace_root.get("recall") or {}
    assert recall_trace, "Recall trace missing at decision_trace.recall"

    accepted = recall_trace.get("accepted_ids") or {}
    assert accepted.get("cz"), "Recall trace accepted_ids.cz should be non-empty"
    assert accepted.get("ez"), "Recall trace accepted_ids.ez should be non-empty"

    rejected = recall_trace.get("rejected") or {}
    assert rejected.get("cz"), "Recall trace rejected.cz should include city_mismatch evidence"
    assert rejected.get("ez"), "Recall trace rejected.ez should include rejection evidence"
    assert any(item.get("reason") == "excellence_below_threshold" for item in rejected.get("ez", [])), (
        "Recall trace rejected.ez should include excellence_below_threshold"
    )

    cross_city_guard = recall_trace.get("cross_city_guard") or {}
    assert cross_city_guard.get("rejected_count", 0) >= 1, (
        "Recall trace cross_city_guard.rejected_count should be >= 1 for intruder item"
    )
    assert "osaka_intruder_001" in (cross_city_guard.get("rejected_ids") or []), (
        "Recall trace cross_city_guard.rejected_ids should include osaka intruder id"
    )

    print(f"{Path(__file__).stem}: PASS")


if __name__ == "__main__":
    main()
