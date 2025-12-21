from typing import Dict, Any, List
from ..common.helpers import ensure_dict

LABEL_MAP: Dict[str, str] = {
    "ramen": "ramen",
    "noodles": "ramen",
    "sushi": "sushi",
    "temple": "culture",
    "shrine": "culture",
    "walk": "walking",
    "hike": "walking",
    "city": "urban",
    "nightlife": "urban",
}


def _normalize_single(label: str) -> str:
    key = label.lower().strip()
    return LABEL_MAP.get(key, key)


def normalize_tags(payload: Any) -> Dict[str, Any]:
    data = ensure_dict(payload.data)
    raw_tags: List[str] = data.get("tags") or []
    normalized = [_normalize_single(tag) for tag in raw_tags]
    deduped = sorted(set(normalized))
    return {
        "dummy": True,
        "raw": raw_tags,
        "normalized": deduped,
        "mapping_used": LABEL_MAP,
    }

