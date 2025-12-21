from typing import Any, Dict, List
from datetime import datetime, timezone
from ..common.helpers import ensure_dict


def _default_itinerary() -> List[Dict[str, Any]]:
    return [
        {"day": 1, "title": "Arrival and local bites", "highlights": ["Check-in", "Ramen dinner"]},
        {"day": 2, "title": "Culture walk", "highlights": ["Morning shrine", "City stroll"]},
    ]


def compose_cards(payload: Any) -> Dict[str, Any]:
    """
    MVP Journey Card Format (dummy version)
    Input payload example:
    {
        "city": "kyoto",
        "cz": ["ramen_shop", "izakaya"],
        "ez": ["temple", "park"],
        "user_id": "u001"
    }
    """
    data = ensure_dict(payload.data)

    city = data.get("city", "kyoto")
    cz = data.get("cz", ["ramen_shop", "izakaya"])
    ez = data.get("ez", ["temple", "park"])

    # build card sequence, prefer CZ first then EZ
    steps: List[Dict[str, Any]] = []
    step_counter = 1

    for place in cz:
        steps.append({"step": step_counter, "place": place})
        step_counter += 1

    for place in ez:
        steps.append({"step": step_counter, "place": place})
        step_counter += 1

    return {
        "dummy": True,
        "city": city,
        "cz_used": cz,
        "ez_used": ez,
        "cards": steps,
    }

