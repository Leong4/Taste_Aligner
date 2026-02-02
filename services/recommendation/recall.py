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

from typing import List, Dict, Any, Set
import logging

try:
    from .config import RECALL_EZ_EXCELLENCE_THRESHOLD, MAX_RECALL_CANDIDATES
    from .db import get_items_by_city, get_items_by_excellence_threshold, get_all_items
except ImportError:
    from config import RECALL_EZ_EXCELLENCE_THRESHOLD, MAX_RECALL_CANDIDATES
    from db import get_items_by_city, get_items_by_excellence_threshold, get_all_items

logger = logging.getLogger(__name__)


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

    # Statistics
    cz_city_matches = 0
    cz_tag_matches = 0
    ez_fallback_matches = 0

    # ========================================
    # CZ RECALL: CITY-ONLY (v1.1)
    # ========================================
    # CZ is "safe, high hit-rate" - restrict to same city only

    if city_lower:
        city_items = get_items_by_city(city_lower)

        for item in city_items:
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
    # v1.2: EZ is now city-strict - explores within the same city
    # Filter city items by excellence threshold

    if city_lower:
        # Get city items and filter by excellence
        for item in city_items:
            item_excellence = item.get("excellence", 0.0)
            if item_excellence >= RECALL_EZ_EXCELLENCE_THRESHOLD:
                ez_fallback_matches += 1
                recall_rules_used.add("ez_city_excellence")

                # Add to EZ candidates
                item_copy = item.copy()
                item_copy["recall_source"] = "ez"
                item_copy["recall_reasons"] = ["city_excellence"]
                ez_candidates.append(item_copy)

    # Limit to max candidates per zone
    if len(cz_candidates) > MAX_RECALL_CANDIDATES:
        logger.warning(
            f"CZ recall returned {len(cz_candidates)} candidates, "
            f"limiting to {MAX_RECALL_CANDIDATES}"
        )
        cz_candidates = cz_candidates[:MAX_RECALL_CANDIDATES]

    if len(ez_candidates) > MAX_RECALL_CANDIDATES:
        logger.warning(
            f"EZ recall returned {len(ez_candidates)} candidates, "
            f"limiting to {MAX_RECALL_CANDIDATES}"
        )
        ez_candidates = ez_candidates[:MAX_RECALL_CANDIDATES]

    total_candidates = len(cz_candidates) + len(ez_candidates)

    logger.info(
        f"Recall: CZ={len(cz_candidates)} (city-only), "
        f"EZ={len(ez_candidates)} (city-only, excellence >= {RECALL_EZ_EXCELLENCE_THRESHOLD})"
    )

    # v1.2: Verify both CZ and EZ are city-only
    if cz_candidates:
        cz_cities = set(item["city"] for item in cz_candidates)
        if len(cz_cities) > 1 or (len(cz_cities) == 1 and list(cz_cities)[0].lower() != city_lower):
            logger.error(f"CZ LEAK: Found cities {cz_cities} but expected only {city_lower}")

    if ez_candidates:
        ez_cities = set(item["city"] for item in ez_candidates)
        if len(ez_cities) > 1 or (len(ez_cities) == 1 and list(ez_cities)[0].lower() != city_lower):
            logger.error(f"EZ LEAK: Found cities {ez_cities} but expected only {city_lower}")

    return {
        "cz_candidates": cz_candidates,
        "ez_candidates": ez_candidates,
        "total_candidates": total_candidates,
        "recall_rules": sorted(list(recall_rules_used)),
        "stats": {
            "cz_city_matches": cz_city_matches,
            "cz_tag_matches": cz_tag_matches,
            "ez_fallback_matches": ez_fallback_matches,
            "total_items_scanned": "sqlite_query"
        }
    }
