#!/usr/bin/env python3
"""
Characterization test (Case A):
EZ candidates insufficient/empty should trigger planner ez_fill fallback.

Run from repo root:
  python3 tests/service_tests/characterize_decision_trace_case_a_ez_fallback.py
"""

import os
import sys
from pathlib import Path

# Avoid external embedding dependency in characterization tests.
os.environ["MEM_INFLUENCE_MODE"] = "fallback"

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from services.planner.card_builder import select_items_for_cards  # noqa: E402
from services.recommendation.mix_policy import compute_mix_policy  # noqa: E402
from services.recommendation.rerank import rerank_candidates  # noqa: E402


def main() -> None:
    recall_results = {
        "cz_candidates": [
            {
                "id": "tokyo_food_001",
                "city": "tokyo",
                "title": "Tokyo Ramen Alley",
                "tags": ["ramen", "food"],
                "excellence": 0.88,
            },
            {
                "id": "tokyo_walk_001",
                "city": "tokyo",
                "title": "Tokyo Garden Walk",
                "tags": ["walk", "park"],
                "excellence": 0.84,
            },
            {
                "id": "tokyo_culture_001",
                "city": "tokyo",
                "title": "Tokyo Craft Museum",
                "tags": ["museum", "culture"],
                "excellence": 0.92,
            },
        ],
        "ez_candidates": [],
    }

    rerank = rerank_candidates(
        recall_results=recall_results,
        user_id="u_case_a",
        user_city="tokyo",
        user_tags=["ramen", "walk"],
    )

    rerank_trace = rerank.get("decision_trace")
    assert rerank_trace, "Case A: rerank decision_trace missing"
    assert "top_items" in rerank_trace, "Case A: rerank trace missing top_items"
    assert rerank_trace["top_items"], "Case A: rerank trace top_items should not be empty"
    assert any(item.get("zone") == "cz" for item in rerank_trace["top_items"]), (
        "Case A: rerank trace top_items must include at least one CZ item"
    )

    mix_policy = compute_mix_policy(
        rerank["cz_ranked"],
        rerank["ez_ranked"],
        intent="balanced",
        memory_confidence=0.6,
    )
    mix_trace = mix_policy.get("decision_trace")
    assert mix_trace, "Case A: mix_policy decision_trace missing"

    reco_payload = {
        "cz_ranked": rerank["cz_ranked"],
        "ez_ranked": rerank["ez_ranked"],
        "mix_policy": {k: v for k, v in mix_policy.items() if k != "decision_trace"},
        "decision_trace": {
            "rerank": rerank_trace,
            "mix_policy": mix_trace,
        },
    }

    _, _, selection_debug = select_items_for_cards(
        reco_payload=reco_payload,
        city="tokyo",
        controls={"topk_cz": 1, "topk_ez": 2, "ratio_mode": "auto"},
    )

    planner_trace = selection_debug.get("planner_trace")
    assert planner_trace, "Case A: planner_trace missing"
    assert planner_trace.get("ez_fill_triggered") is True, (
        "Case A: expected ez_fill_triggered=True when EZ candidates are empty"
    )
    assert planner_trace.get("ez_fill_source") in {"excellence_fallback", "cz_pool"}, (
        "Case A: ez_fill_source should be excellence_fallback or cz_pool"
    )
    ez_fill_reason = planner_trace.get("ez_fill_reason")
    assert isinstance(ez_fill_reason, str) and ez_fill_reason.strip(), (
        "Case A: ez_fill_reason must be a non-empty string"
    )
    assert "pool_size_before_fill" in planner_trace, (
        "Case A: planner_trace.pool_size_before_fill missing"
    )
    pool_size_before_fill = planner_trace.get("pool_size_before_fill", {})
    assert "ez_pool" in pool_size_before_fill and "cz_pool" in pool_size_before_fill, (
        "Case A: planner_trace.pool_size_before_fill must include ez_pool and cz_pool"
    )
    assert "fill_item_ids" in planner_trace, "Case A: planner_trace.fill_item_ids missing"
    assert planner_trace["fill_item_ids"], (
        "Case A: planner_trace.fill_item_ids should contain fallback-filled item ids"
    )

    print(f"{Path(__file__).stem}: PASS")


if __name__ == "__main__":
    main()
