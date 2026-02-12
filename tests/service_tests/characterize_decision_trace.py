#!/usr/bin/env python3
"""
Characterization test for skill-first + decision_trace plumbing.

Run from repo root:
  python3 tests/service_tests/characterize_decision_trace.py
"""

import os
import sys
from pathlib import Path

# Avoid external embedding dependency in this characterization test.
os.environ["MEM_INFLUENCE_MODE"] = "fallback"
REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from services.recommendation.rerank import rerank_candidates  # noqa: E402
from services.recommendation.mix_policy import compute_mix_policy  # noqa: E402
from services.planner.card_builder import select_items_for_cards  # noqa: E402


def main() -> None:
    recall_results = {
        "cz_candidates": [
            {
                "id": "tokyo_ramen_001",
                "city": "tokyo",
                "title": "Tokyo Ramen Shop",
                "tags": ["ramen", "noodles", "food"],
                "excellence": 0.88,
            },
            {
                "id": "tokyo_museum_001",
                "city": "tokyo",
                "title": "Tokyo City Museum",
                "tags": ["museum", "culture", "art"],
                "excellence": 0.83,
            },
        ],
        "ez_candidates": [
            {
                "id": "tokyo_temple_001",
                "city": "tokyo",
                "title": "Tokyo Temple",
                "tags": ["temple", "culture", "history"],
                "excellence": 0.91,
            },
            {
                "id": "tokyo_walk_001",
                "city": "tokyo",
                "title": "Tokyo Riverside Walk",
                "tags": ["walk", "park", "scenic"],
                "excellence": 0.86,
            },
        ],
    }

    rerank = rerank_candidates(
        recall_results=recall_results,
        user_id="u001",
        user_city="tokyo",
        user_tags=["ramen", "walk"],
    )

    assert "decision_trace" in rerank, "rerank should provide decision_trace"
    assert "top_items" in rerank["decision_trace"], "rerank trace must include top_items"

    mix_policy = compute_mix_policy(
        rerank["cz_ranked"],
        rerank["ez_ranked"],
        intent="balanced",
        memory_confidence=0.6,
    )
    assert "decision_trace" in mix_policy, "mix_policy should provide decision_trace"

    reco_payload = {
        "cz_ranked": rerank["cz_ranked"],
        "ez_ranked": rerank["ez_ranked"],
        "mix_policy": {k: v for k, v in mix_policy.items() if k != "decision_trace"},
        "decision_trace": {
            "rerank": rerank["decision_trace"],
            "mix_policy": mix_policy["decision_trace"],
        },
    }

    _, _, selection_debug = select_items_for_cards(
        reco_payload=reco_payload,
        city="tokyo",
        controls={"topk_cz": 2, "topk_ez": 2, "ratio_mode": "auto"},
    )

    planner_trace = selection_debug.get("planner_trace")
    assert planner_trace, "planner_trace should exist"
    assert "selected_cz_ids" in planner_trace
    assert "selected_ez_ids" in planner_trace
    assert "ez_fill_triggered" in planner_trace
    assert "ez_fill_reason" in planner_trace
    assert "ez_fill_source" in planner_trace

    print("characterization_decision_trace: PASS")


if __name__ == "__main__":
    main()
