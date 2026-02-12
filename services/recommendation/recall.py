"""
Recommendation Service v1.2 - Stage 1: RECALL

Goal: Maximize recall, avoid false negatives.
Cheap, rule-based filtering.

v1.2 Changes:
- BOTH CZ and EZ candidates MUST be city-only (same city as request)
- EZ explores within the same city (high excellence + taste distance)
- Cross-city recommendations deferred to future "weekend trip" mode

v1.1 Changes:
- CZ candidates MUST be city-only (same city as request)
- EZ candidates can be global (for exploration)
- Excellence fallback ensures EZ is never empty
- Uses SQLite database instead of hardcoded dataset

FORBIDDEN in recall stage:
- embedding cosine
- sentiment weighting
- time decay
"""

from typing import List, Dict, Any, Tuple
import logging

try:
    from .config import RECALL_EZ_EXCELLENCE_THRESHOLD, MAX_RECALL_CANDIDATES
    from .db import get_items_by_city, get_items_by_excellence_threshold, get_all_items
except ImportError:
    from config import RECALL_EZ_EXCELLENCE_THRESHOLD, MAX_RECALL_CANDIDATES
    from db import get_items_by_city, get_items_by_excellence_threshold, get_all_items

logger = logging.getLogger(__name__)
TRACE_SAMPLE_LIMIT = 100


def _item_id(item: Dict[str, Any]) -> str:
    return str(item.get("id") or item.get("item_id") or item.get("title") or "")


def _sample(values: List[Any], limit: int = TRACE_SAMPLE_LIMIT) -> Tuple[List[Any], bool]:
    sampled = values[:limit]
    return sampled, len(values) > limit


def recall_candidates(
    city: str,
    normalized_tags: List[str],
    user_id: str = None
) -> Dict[str, Any]:
    """
    Stage 1: Recall candidates based on simple rules.

    v1.2 Logic:
    - CZ candidates: ONLY items where item.city == request.city
    - EZ candidates: ONLY items where item.city == request.city AND excellence >= threshold
    - Both CZ and EZ are city-strict (no cross-city recommendations)

    Args:
        city: User's city context
        normalized_tags: User's normalized preference tags
        user_id: User ID (optional, for logging)

    Returns:
        {
            "cz_candidates": List[Dict],  # v1.2: city-only
            "ez_candidates": List[Dict],  # v1.2: city-only, excellence-based
            "total_candidates": int,
            "recall_rules": List[str],
            "stats": {...}
        }
    """
    cz_candidates = []
    ez_candidates = []
    recall_rules_used = set()

    # Normalize inputs
    city_lower = city.lower().strip() if city else ""
    tag_set = set(tag.lower().strip() for tag in normalized_tags if tag)
    city_items = get_items_by_city(city_lower) if city_lower else []

    # Statistics
    cz_city_matches = 0
    cz_tag_matches = 0
    ez_fallback_matches = 0
    cz_rejected: List[Dict[str, Any]] = []
    ez_rejected: List[Dict[str, Any]] = []
    cross_city_rejected: List[Dict[str, Any]] = []

    # ========================================
    # CZ RECALL: CITY-ONLY (v1.1)
    # ========================================
    # CZ is "safe, high hit-rate" - restrict to same city only

    for item in city_items:
        item_city_raw = item.get("city", "")
        item_city = item_city_raw.lower().strip()
        item_id = _item_id(item)

        if item_city != city_lower:
            reject = {"id": item_id, "reason": "city_mismatch", "city": item_city_raw}
            cz_rejected.append(reject)
            cross_city_rejected.append({"id": item_id, "city": item_city_raw})
            continue

        item_tags = item.get("tags", [])
        item_tag_set = set(tag.lower().strip() for tag in item_tags if tag)

        # Rule 1: City match (mandatory for CZ)
        cz_city_matches += 1
        recall_rules_used.add("cz_city_match")

        # Rule 2: Tag overlap (optional boost for CZ)
        if tag_set and item_tag_set:
            overlap = tag_set & item_tag_set
            if len(overlap) >= 1:
                cz_tag_matches += 1
                recall_rules_used.add("cz_tag_overlap")

        # Add to CZ candidates
        item_copy = item.copy()
        item_copy["recall_source"] = "cz"
        item_copy["recall_reasons"] = ["city_match"]
        if tag_set and item_tag_set and len(tag_set & item_tag_set) >= 1:
            item_copy["recall_reasons"].append("tag_overlap")
        cz_candidates.append(item_copy)

    # ========================================
    # EZ RECALL: CITY-STRICT EXCELLENCE (v1.2)
    # ========================================
    # v1.2: EZ explores within the same city after excellence filtering.

    for item in city_items:
        item_city_raw = item.get("city", "")
        item_city = item_city_raw.lower().strip()
        item_id = _item_id(item)

        if item_city != city_lower:
            ez_rejected.append({"id": item_id, "reason": "city_mismatch", "city": item_city_raw})
            continue

        item_excellence = item.get("excellence", 0.0)
        if item_excellence >= RECALL_EZ_EXCELLENCE_THRESHOLD:
            ez_fallback_matches += 1
            recall_rules_used.add("ez_city_excellence")
            item_copy = item.copy()
            item_copy["recall_source"] = "ez"
            item_copy["recall_reasons"] = ["city_excellence"]
            ez_candidates.append(item_copy)
        else:
            ez_rejected.append(
                {
                    "id": item_id,
                    "reason": "excellence_below_threshold",
                    "excellence": item_excellence
                }
            )

    # Limit to max candidates per zone
    cz_before_cap = len(cz_candidates)
    ez_before_cap = len(ez_candidates)

    cz_cap_truncated_ids: List[str] = []
    ez_cap_truncated_ids: List[str] = []

    if cz_before_cap > MAX_RECALL_CANDIDATES:
        logger.warning(
            f"CZ recall returned {cz_before_cap} candidates, "
            f"limiting to {MAX_RECALL_CANDIDATES}"
        )
        cz_cap_truncated_ids = [_item_id(item) for item in cz_candidates[MAX_RECALL_CANDIDATES:]]
        cz_candidates = cz_candidates[:MAX_RECALL_CANDIDATES]

    if ez_before_cap > MAX_RECALL_CANDIDATES:
        logger.warning(
            f"EZ recall returned {ez_before_cap} candidates, "
            f"limiting to {MAX_RECALL_CANDIDATES}"
        )
        ez_cap_truncated_ids = [_item_id(item) for item in ez_candidates[MAX_RECALL_CANDIDATES:]]
        ez_candidates = ez_candidates[:MAX_RECALL_CANDIDATES]

    total_candidates = len(cz_candidates) + len(ez_candidates)

    logger.info(
        f"Recall: CZ={len(cz_candidates)} (city-only), "
        f"EZ={len(ez_candidates)} (city-only, excellence >= {RECALL_EZ_EXCELLENCE_THRESHOLD})"
    )

    # Safety verification: both CZ and EZ must remain city-only after filtering.
    if cz_candidates:
        cz_cities = set(item["city"] for item in cz_candidates)
        if len(cz_cities) > 1 or (len(cz_cities) == 1 and list(cz_cities)[0].lower() != city_lower):
            logger.error(f"CZ LEAK: Found cities {cz_cities} but expected only {city_lower}")

    if ez_candidates:
        ez_cities = set(item["city"] for item in ez_candidates)
        if len(ez_cities) > 1 or (len(ez_cities) == 1 and list(ez_cities)[0].lower() != city_lower):
            logger.error(f"EZ LEAK: Found cities {ez_cities} but expected only {city_lower}")

    accepted_cz_ids = [_item_id(item) for item in cz_candidates]
    accepted_ez_ids = [_item_id(item) for item in ez_candidates]
    accepted_cz_ids_sample, accepted_cz_truncated = _sample(accepted_cz_ids)
    accepted_ez_ids_sample, accepted_ez_truncated = _sample(accepted_ez_ids)

    rejected_cz_sample, rejected_cz_truncated = _sample(cz_rejected)
    rejected_ez_sample, rejected_ez_truncated = _sample(ez_rejected)

    cz_cap_ids_sample, cz_cap_ids_truncated = _sample(cz_cap_truncated_ids)
    ez_cap_ids_sample, ez_cap_ids_truncated = _sample(ez_cap_truncated_ids)

    cross_city_ids = [entry["id"] for entry in cross_city_rejected]
    cross_city_ids_sample, cross_city_ids_truncated = _sample(cross_city_ids)

    recall_trace = {
        "rule_id": "recall_v1_city_strict",
        "rules_used": sorted(list(recall_rules_used)),
        "thresholds": {
            "recall_ez_excellence_threshold": RECALL_EZ_EXCELLENCE_THRESHOLD,
            "max_recall_candidates": MAX_RECALL_CANDIDATES
        },
        "candidate_counts": {
            "cz_in": len(city_items),
            "cz_out": len(cz_candidates),
            "ez_in": len(city_items),
            "ez_out": len(ez_candidates)
        },
        "accepted_ids": {
            "cz": accepted_cz_ids_sample,
            "ez": accepted_ez_ids_sample,
            "truncated": {"cz": accepted_cz_truncated, "ez": accepted_ez_truncated}
        },
        "rejected": {
            "cz": rejected_cz_sample,
            "ez": rejected_ez_sample,
            "truncated": {"cz": rejected_cz_truncated, "ez": rejected_ez_truncated}
        },
        "cap": {
            "applied": (cz_before_cap > MAX_RECALL_CANDIDATES) or (ez_before_cap > MAX_RECALL_CANDIDATES),
            "cz": {
                "applied": cz_before_cap > MAX_RECALL_CANDIDATES,
                "before": cz_before_cap,
                "after": len(cz_candidates),
                "truncated_ids": cz_cap_ids_sample,
                "truncated": cz_cap_ids_truncated
            },
            "ez": {
                "applied": ez_before_cap > MAX_RECALL_CANDIDATES,
                "before": ez_before_cap,
                "after": len(ez_candidates),
                "truncated_ids": ez_cap_ids_sample,
                "truncated": ez_cap_ids_truncated
            }
        },
        "cross_city_guard": {
            "rule_id": "recall_cross_city_guard_v1",
            "rejected_count": len(cross_city_rejected),
            "rejected_ids": cross_city_ids_sample,
            "truncated": cross_city_ids_truncated
        }
    }

    return {
        "cz_candidates": cz_candidates,
        "ez_candidates": ez_candidates,
        "total_candidates": total_candidates,
        "recall_rules": sorted(list(recall_rules_used)),
        "stats": {
            "cz_city_matches": cz_city_matches,
            "cz_tag_matches": cz_tag_matches,
            "ez_fallback_matches": ez_fallback_matches,
            "cross_city_rejected": len(cross_city_rejected),
            "total_items_scanned": "sqlite_query"
        },
        "decision_trace": {
            "recall": recall_trace
        }
    }
