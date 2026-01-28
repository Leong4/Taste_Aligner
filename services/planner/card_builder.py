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
    data: Dict[str, Any] = {}
    if hasattr(payload, "data"):
        data = ensure_dict(getattr(payload, "data"))
    if not data and hasattr(payload, "dict"):
        raw = ensure_dict(payload.dict(exclude_none=True))
        data = {k: v for k, v in raw.items() if k != "data"}

    city = data.get("city")
    cz = data.get("cz", [])
    ez = data.get("ez", [])
    cz_list = cz if isinstance(cz, list) else []
    ez_list = ez if isinstance(ez, list) else []

    # build card sequence, prefer CZ first then EZ
    steps: List[Dict[str, Any]] = []
    step_counter = 1

    for place in cz_list:
        steps.append({"step": step_counter, "place": place})
        step_counter += 1

    for place in ez_list:
        steps.append({"step": step_counter, "place": place})
        step_counter += 1

    return {
        "dummy": True,
        "city": city,
        "cz_used": cz_list,
        "ez_used": ez_list,
        "cards": steps,
    }
