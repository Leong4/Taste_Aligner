from typing import Any, Dict, List
from ..common.helpers import ensure_dict
from .formula import cz_score, ez_score, combined_score


def _default_candidates() -> List[Dict[str, Any]]:
    return [
        {"id": "journey_tokyo_food", "title": "Tokyo ramen crawl"},
        {"id": "journey_kyoto_culture", "title": "Kyoto temple morning"},
    ]


def score_recommendations(payload: Any) -> Dict[str, Any]:
    data = ensure_dict(payload.data)
    candidates = data.get("candidates") or _default_candidates()

    scored = []
    for idx, candidate in enumerate(candidates):
        item_id = candidate.get("id") if isinstance(candidate, dict) else str(candidate)
        cz = cz_score(item_id, idx)
        ez = ez_score(item_id, idx)
        scored.append(
            {
                "id": item_id,
                "cz": cz,
                "ez": ez,
                "score": combined_score(cz, ez),
            }
        )

    return {
        "dummy": True,
        "input": data,
        "scores": scored,
    }

