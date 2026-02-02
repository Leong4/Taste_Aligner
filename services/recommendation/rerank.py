"""
Recommendation Service v1.3 - Stage 2: RERANK

Goal: Transform recall candidates into ranked recommendations
with explicit, explainable CZ and EZ scoring.

v1.3 Changes:
- EZ diversity rerank for tags=[]
- Embedding-based memory_influence (item-discriminative)

v1.2 Changes:
- Enhanced item-discriminative memory_influence with local tag-based fallback
- EZ now city-strict (same as CZ)
- Taste distance emphasis increased with SIM_CAP=0.7 enforcement
- memory_similarity exposed in components for interpretability

v1.1 Changes:
- memory_influence is now item-dependent (calls Memory Service)
- EZ scoring uses taste_distance with similarity capping
- Separate reranking for CZ and EZ candidates
- Enhanced explainability with anchor_memory_ids

Rerank responsibilities:
1. Compute CZ score for CZ candidates
2. Compute EZ score for EZ candidates
3. Attach score decomposition for explainability
4. Preserve ranking metadata for Planner usage
"""

from typing import List, Dict, Any, Optional, Tuple
import logging
import re

try:
    from .config import (
        CZ_ALPHA, CZ_BETA, CZ_GAMMA,
        EZ_MU, EZ_NU, SIM_CAP, EZ_TASTE_DISTANCE_MAX,
        TOP_K_CZ, TOP_K_EZ,
        MEMORY_INFLUENCE_BASE_WEIGHT,
        EZ_DIVERSITY_ENABLED, EZ_DIVERSITY_METHOD, EZ_LAMBDA_DIVERSITY,
        MEM_INFLUENCE_MODE, MEM_BETA
    )
    from .embedding_client import generate_embedding_with_error
    from .db import get_item_embedding, upsert_item_embedding
except ImportError:
    from config import (
        CZ_ALPHA, CZ_BETA, CZ_GAMMA,
        EZ_MU, EZ_NU, SIM_CAP, EZ_TASTE_DISTANCE_MAX,
        TOP_K_CZ, TOP_K_EZ,
        MEMORY_INFLUENCE_BASE_WEIGHT,
        EZ_DIVERSITY_ENABLED, EZ_DIVERSITY_METHOD, EZ_LAMBDA_DIVERSITY,
        MEM_INFLUENCE_MODE, MEM_BETA
    )
    from embedding_client import generate_embedding_with_error
    from db import get_item_embedding, upsert_item_embedding

logger = logging.getLogger(__name__)


def cosine_similarity(vec1: List[float], vec2: List[float]) -> float:
    """Compute cosine similarity between two vectors."""
    if len(vec1) != len(vec2):
        return 0.0
    dot_product = sum(a * b for a, b in zip(vec1, vec2))
    return max(-1.0, min(1.0, dot_product))  # Clamp to [-1, 1]


def compute_tag_similarity(item_tags: List[str], user_tags: List[str]) -> float:
    """
    Compute tag similarity using Jaccard similarity.

    Args:
        item_tags: Item's tags
        user_tags: User's tags

    Returns:
        Jaccard similarity in [0, 1]
    """
    if not item_tags or not user_tags:
        return 0.0

    item_set = set(tag.lower().strip() for tag in item_tags if tag)
    user_set = set(tag.lower().strip() for tag in user_tags if tag)

    if not item_set or not user_set:
        return 0.0

    intersection = len(item_set & user_set)
    union = len(item_set | user_set)

    if union == 0:
        return 0.0

    return intersection / union


def _normalize_tokens(tokens: List[str]) -> List[str]:
    return [t.lower().strip() for t in tokens if t and t.strip()]


def _title_to_tokens(title: str) -> List[str]:
    if not title:
        return []
    return re.findall(r"[A-Za-z0-9]+", title.lower())


def compute_jaccard_similarity(a_tags: List[str], b_tags: List[str]) -> float:
    """Compute Jaccard similarity between two tag lists."""
    a_set = set(_normalize_tokens(a_tags))
    b_set = set(_normalize_tokens(b_tags))
    if not a_set or not b_set:
        return 0.0
    intersection = len(a_set & b_set)
    union = len(a_set | b_set)
    if union == 0:
        return 0.0
    return intersection / union


def compute_memory_influence_local_fallback(
    item_tags: List[str],
    user_tags: List[str]
) -> Dict[str, Any]:
    """
    Local fallback for memory influence when Memory Service is unavailable.

    v1.2: Uses tag-based similarity to provide item-discriminative scores.

    Formula:
        memory_influence = 1.0 + MEMORY_INFLUENCE_BASE_WEIGHT * tag_similarity

    Args:
        item_tags: Item's tags
        user_tags: User's tags

    Returns:
        {
            "score": float,
            "method": str,
            "memory_similarity": float,
            "anchor_memory_ids": [],
            "top_similarities": []
        }
    """
    tag_sim = compute_tag_similarity(item_tags, user_tags)

    # memory_influence = 1.0 + w * similarity
    # This gives range [1.0, 1.6] with default w=0.6
    influence_score = 1.0 + MEMORY_INFLUENCE_BASE_WEIGHT * tag_sim

    return {
        "score": round(influence_score, 4),
        "method": "local_tag_fallback",
        "memory_similarity": round(tag_sim, 4),
        "anchor_memory_ids": [],
        "top_similarities": []
    }


def _get_or_create_item_embedding(
    item_id: str,
    title: str,
    tags: List[str]
) -> Tuple[Optional[List[float]], Optional[str]]:
    cached = get_item_embedding(item_id)
    if cached:
        return cached, None

    vision_tags = _title_to_tokens(title)
    normalized_tags = _normalize_tokens(tags)
    vector, error = generate_embedding_with_error(
        vision_tags=vision_tags,
        normalized_tags=normalized_tags
    )
    if vector:
        upsert_item_embedding(item_id, vector)
    return vector, error


def _get_user_embedding(user_tags: List[str], user_city: str) -> Tuple[Optional[List[float]], Optional[str]]:
    vision_tags = [user_city] if user_city else []
    normalized_tags = _normalize_tokens(user_tags)
    return generate_embedding_with_error(
        vision_tags=vision_tags,
        normalized_tags=normalized_tags
    )


def compute_memory_influence(
    item_id: str,
    item_title: str,
    item_tags: List[str],
    user_id: str,
    user_city: str,
    user_tags: List[str]
) -> Dict[str, Any]:
    """
    Compute memory influence score for CZ (v1.3: embedding-based, item-discriminative).

    Uses embedding cosine between user embedding and item embedding.
    Falls back to local tag-based similarity when embeddings are unavailable.
    """
    if MEM_INFLUENCE_MODE != "embedding":
        return compute_memory_influence_local_fallback(item_tags, user_tags)

    try:
        item_vec, item_err = _get_or_create_item_embedding(item_id, item_title, item_tags)
        user_vec, user_err = _get_user_embedding(user_tags, user_city)
        embed_error = item_err or user_err

        if not item_vec or not user_vec or len(item_vec) != len(user_vec):
            fallback = compute_memory_influence_local_fallback(item_tags, user_tags)
            fallback["embedding_error"] = embed_error or "embedding_unavailable"
            return fallback

        cosine = cosine_similarity(item_vec, user_vec)
        sim01 = (cosine + 1.0) / 2.0
        influence_score = 1.0 + MEM_BETA * sim01

        return {
            "score": round(influence_score, 4),
            "method": "embedding_cosine",
            "memory_similarity": round(sim01, 4),
            "anchor_memory_ids": [],
            "top_similarities": [],
            "embedding_error": None
        }
    except Exception as e:
        logger.warning(f"Embedding memory influence failed: {e}, using local tag fallback")
        fallback = compute_memory_influence_local_fallback(item_tags, user_tags)
        fallback["embedding_error"] = str(e)
        return fallback


def compute_location_relevance(item_city: str, user_city: str) -> float:
    """
    Compute location relevance score.

    Args:
        item_city: Item's city
        user_city: User's query city

    Returns:
        1.0 if same city, 0.5 otherwise
    """
    if not item_city or not user_city:
        return 0.5

    if item_city.lower().strip() == user_city.lower().strip():
        return 1.0

    return 0.5


def compute_cz_score(
    item: Dict[str, Any],
    user_city: str,
    user_tags: List[str],
    user_id: str
) -> Dict[str, Any]:
    """
    Compute Comfort Zone (CZ) score with explainability.

    CZ formula:
        score_CZ = α * tag_similarity + β * memory_influence + γ * location_relevance

    v1.1: memory_influence is item-dependent via Memory Service

    Args:
        item: Candidate item
        user_city: User's city context
        user_tags: User's normalized tags
        user_id: User ID

    Returns:
        {
            "id": str,
            "city": str,
            "title": str,
            "tags": List[str],
            "excellence": float,
            "score_CZ": float,
            "components": {...},
            "reason": str,
            "anchor_memory_ids": List[str],
            "memory_influence_detail": {...}
        }
    """
    item_id = item.get("id")
    item_tags = item.get("tags", [])
    item_city = item.get("city", "")

    # Compute components
    tag_sim = compute_tag_similarity(item_tags, user_tags)

    memory_inf_data = compute_memory_influence(
        item_id, item.get("title", ""), item_tags, user_id, user_city, user_tags
    )
    memory_inf = memory_inf_data["score"]
    memory_sim = memory_inf_data.get("memory_similarity", 0.0)  # v1.2

    location_rel = compute_location_relevance(item_city, user_city)

    # Final CZ score
    score_cz = (
        CZ_ALPHA * tag_sim +
        CZ_BETA * memory_inf +
        CZ_GAMMA * location_rel
    )

    # Generate reason string
    reason = _generate_cz_reason(tag_sim, memory_inf, location_rel)

    return {
        "id": item_id,
        "city": item_city,
        "title": item.get("title", ""),
        "tags": item_tags,
        "excellence": item.get("excellence", 0.0),
        "score_CZ": round(score_cz, 4),
        "components": {
            "tag_similarity": round(tag_sim, 4),
            "memory_influence": round(memory_inf, 4),
            "memory_similarity": round(memory_sim, 4),
            "memory_method": memory_inf_data.get("method", "none"),
            "location_relevance": round(location_rel, 4)
        },
        "weights": {
            "alpha": CZ_ALPHA,
            "beta": CZ_BETA,
            "gamma": CZ_GAMMA
        },
        "reason": reason,
        "anchor_memory_ids": memory_inf_data["anchor_memory_ids"],
        "memory_influence_detail": memory_inf_data
    }


def compute_ez_score(
    item: Dict[str, Any],
    user_city: str,
    user_tags: List[str],
    user_id: str
) -> Optional[Dict[str, Any]]:
    """
    Compute Exploration Zone (EZ) score with explainability.

    v1.2: EZ formula with strong taste_distance emphasis (ν=0.8):
        taste_similarity = tag_similarity (or embedding if available)
        taste_similarity_capped = min(taste_similarity, SIM_CAP=0.7)
        taste_distance = 1 - taste_similarity_capped
        score_EZ = μ * global_excellence + ν * taste_distance

    When user_tags is empty:
        - taste_similarity = 0
        - taste_distance = 1
        - score_EZ = μ * excellence + ν * taste_distance
        - Ensures EZ is never empty

    Args:
        item: Candidate item
        user_city: User's city context
        user_tags: User's normalized tags
        user_id: User ID

    Returns:
        EZ score dict, or None if taste_distance > EZ_TASTE_DISTANCE_MAX
    """
    item_id = item.get("id")
    item_tags = item.get("tags", [])
    excellence = item.get("excellence", 0.0)

    # Check if tags are empty (excellence fallback mode)
    tags_empty = not user_tags or all(not tag.strip() for tag in user_tags)

    if tags_empty:
        # FIX: Excellence fallback when tags=[]
        # Skip taste_distance filtering to ensure EZ is never empty
        taste_sim_raw = 0.0
        taste_sim_capped = 0.0
        taste_distance = 1.0  # Max distance when no tags

        # Score based on excellence + distance (v1.2)
        score_ez = (
            EZ_MU * excellence +
            EZ_NU * taste_distance
        )

        logger.debug(f"EZ excellence fallback for {item_id}: score={score_ez:.4f}")
    else:
        # Normal EZ scoring with taste_distance
        # Compute taste similarity (using tags for now)
        taste_sim_raw = compute_tag_similarity(item_tags, user_tags)

        # Apply similarity cap (v1.1)
        taste_sim_capped = min(taste_sim_raw, SIM_CAP)

        # Compute taste distance
        taste_distance = 1.0 - taste_sim_capped

        # Filter: taste_distance must be reasonable (skip if tags empty)
        if taste_distance > EZ_TASTE_DISTANCE_MAX:
            return None  # Too far, discard

        # Final EZ score (v1.1: increased ν weight)
        score_ez = (
            EZ_MU * excellence +
            EZ_NU * taste_distance
        )

    # Generate reason
    if tags_empty:
        reason = "excellence_fallback_no_tags"
        rerank_stage = "excellence_fallback_no_tags"
    else:
        reason = _generate_ez_reason(excellence, taste_sim_raw, taste_distance)
        rerank_stage = "ez_standard"

        # Log if capping was applied
        if taste_sim_raw > SIM_CAP:
            logger.debug(
                f"Item {item_id}: similarity capped {taste_sim_raw:.4f} -> {taste_sim_capped:.4f}"
            )

    return {
        "id": item_id,
        "city": item.get("city", ""),
        "title": item.get("title", ""),
        "tags": item_tags,
        "excellence": excellence,
        "score_EZ": round(score_ez, 4),
        "components": {
            "global_excellence": round(excellence, 4),
            "excellence": round(excellence, 4),
            "taste_similarity_raw": round(taste_sim_raw, 4),
            "taste_similarity_capped": round(taste_sim_capped, 4),
            "taste_distance": round(taste_distance, 4),
            "distance_contrib": round(EZ_NU * taste_distance, 4)
        },
        "weights": {
            "mu": EZ_MU,
            "nu": EZ_NU
        },
        "sim_cap": SIM_CAP,
        "why_explore": reason,
        "rerank_stage": rerank_stage
    }


def _generate_cz_reason(tag_sim: float, memory_inf: float, location_rel: float) -> str:
    """Generate human-readable reason for CZ score."""
    reasons = []

    if tag_sim >= 0.7:
        reasons.append("strong taste match")
    elif tag_sim >= 0.4:
        reasons.append("moderate taste match")
    else:
        reasons.append("weak taste match")

    if memory_inf >= 1.2:
        reasons.append("strong memory match")
    elif memory_inf >= 0.8:
        reasons.append("some memory match")

    if location_rel >= 0.9:
        reasons.append("same location")

    if not reasons:
        reasons.append("baseline recommendation")

    return " + ".join(reasons)


def _generate_ez_reason(excellence: float, taste_sim: float, taste_dist: float) -> str:
    """Generate human-readable reason for EZ exploration."""
    if excellence >= 0.9 and taste_dist >= 0.4:
        return "exceptional_quality_low_overlap"
    elif excellence >= 0.9:
        return "world_class_slightly_different"
    elif taste_dist >= 0.5:
        return "novel_discovery_high_quality"
    else:
        return "quality_adjacent_exploration"


def _item_similarity(a: Dict[str, Any], b: Dict[str, Any]) -> float:
    """Cheap similarity for diversity rerank (Jaccard + kind bonus)."""
    jaccard = compute_jaccard_similarity(a.get("tags", []), b.get("tags", []))
    kind_a = a.get("kind")
    kind_b = b.get("kind")
    kind_bonus = 0.1 if kind_a and kind_b and kind_a == kind_b else 0.0
    return min(1.0, jaccard + kind_bonus)


def rerank_ez_with_diversity(
    ez_items: List[Dict[str, Any]],
    top_k: int,
    lambda_diversity: float
) -> List[Dict[str, Any]]:
    """
    MMR-style diversity rerank for EZ when tags=[].

    relevance = global_excellence
    diversity = max_jaccard_with_selected
    mmr = lambda * relevance - (1 - lambda) * diversity
    """
    selected: List[Dict[str, Any]] = []
    remaining = list(ez_items)

    while remaining and len(selected) < top_k:
        best_item = None
        best_mmr = -1e9
        best_max_sim = 0.0

        for item in remaining:
            relevance = float(item.get("excellence", item.get("components", {}).get("global_excellence", 0.0)))
            max_sim = 0.0
            for chosen in selected:
                max_sim = max(max_sim, _item_similarity(item, chosen))

            mmr_score = (lambda_diversity * relevance) - ((1.0 - lambda_diversity) * max_sim)
            if mmr_score > best_mmr:
                best_mmr = mmr_score
                best_item = item
                best_max_sim = max_sim

        if best_item is None:
            break

        best_item["rerank_stage"] = "ez_diversity_mmr"
        best_item["diversity"] = {
            "lambda": round(lambda_diversity, 4),
            "jaccard_with_prev_selected_max": round(best_max_sim, 4),
            "mmr_score": round(best_mmr, 4)
        }

        selected.append(best_item)
        remaining.remove(best_item)

    return selected


def rerank_candidates(
    recall_results: Dict[str, Any],
    user_id: str,
    user_city: str,
    user_tags: List[str]
) -> Dict[str, Any]:
    """
    Stage 2: Rerank recall candidates into CZ and EZ ranked lists.

    v1.1: Separates CZ and EZ candidates from recall for independent reranking.

    Args:
        recall_results: Output from recall stage
        user_id: User ID
        user_city: User's city context
        user_tags: User's normalized tags

    Returns:
        {
            "cz_ranked": List[scored items sorted by score_CZ],
            "ez_ranked": List[scored items sorted by score_EZ],
            "stats": {...}
        }
    """
    cz_candidates = recall_results.get("cz_candidates", [])
    ez_candidates = recall_results.get("ez_candidates", [])

    cz_scored = []
    ez_scored = []

    tags_empty = not user_tags or all(not tag.strip() for tag in user_tags)
    diversity_enabled = (
        EZ_DIVERSITY_ENABLED and
        tags_empty and
        EZ_DIVERSITY_METHOD.lower() == "mmr"
    )

    embedding_ok_count = 0
    embedding_fail_count = 0
    embedding_last_error = None

    # FIX: Defensive filter - ensure CZ candidates are strictly city-only
    user_city_lower = user_city.lower().strip() if user_city else ""
    cz_filtered = []
    cross_city_rejected = 0

    for item in cz_candidates:
        item_city = item.get("city", "").lower().strip()
        if item_city == user_city_lower:
            cz_filtered.append(item)
        else:
            cross_city_rejected += 1
            logger.warning(
                f"CZ LEAK PREVENTED: Rejected {item.get('id')} "
                f"(city={item.get('city')}) from CZ for user_city={user_city}"
            )

    if cross_city_rejected > 0:
        logger.error(
            f"CZ CONTAMINATION: Rejected {cross_city_rejected} cross-city items "
            f"from CZ candidates. This should not happen - check recall stage!"
        )

    # Rerank CZ candidates (using filtered list)
    for item in cz_filtered:
        cz_result = compute_cz_score(item, user_city, user_tags, user_id)
        mem_detail = cz_result.get("memory_influence_detail", {})
        if mem_detail.get("method") == "embedding_cosine":
            embedding_ok_count += 1
        else:
            embedding_fail_count += 1
            if mem_detail.get("embedding_error"):
                embedding_last_error = mem_detail.get("embedding_error")
        cz_scored.append(cz_result)

    # Rerank EZ candidates
    for item in ez_candidates:
        ez_result = compute_ez_score(item, user_city, user_tags, user_id)
        if ez_result is not None:  # May be filtered by taste_distance
            ez_scored.append(ez_result)

    # Sort CZ by score_CZ DESC
    cz_ranked = sorted(cz_scored, key=lambda x: x["score_CZ"], reverse=True)
    cz_ranked = cz_ranked[:TOP_K_CZ]

    # Sort EZ by score_EZ DESC or apply diversity rerank when tags=[]
    if diversity_enabled:
        ez_ranked = rerank_ez_with_diversity(ez_scored, TOP_K_EZ, EZ_LAMBDA_DIVERSITY)
    else:
        ez_ranked = sorted(ez_scored, key=lambda x: x["score_EZ"], reverse=True)
        ez_ranked = ez_ranked[:TOP_K_EZ]

    logger.info(
        f"Rerank: {len(cz_ranked)} CZ items (filtered {len(cz_candidates)} → {len(cz_filtered)}), "
        f"{len(ez_ranked)} EZ items"
    )

    # v1.1: Log memory_influence variance for CZ
    if cz_ranked:
        mem_influences = [item["components"]["memory_influence"] for item in cz_ranked[:5]]
        logger.info(f"Top 5 CZ memory_influence: {mem_influences}")

    # v1.1: Log taste_distance for EZ
    if ez_ranked:
        taste_distances = [item["components"]["taste_distance"] for item in ez_ranked[:5]]
        logger.info(f"Top 5 EZ taste_distance: {taste_distances}")

    return {
        "cz_ranked": cz_ranked,
        "ez_ranked": ez_ranked,
        "stats": {
            "cz_count": len(cz_ranked),
            "ez_count": len(ez_ranked),
            "cz_candidates": len(cz_candidates),
            "cz_filtered": len(cz_filtered),
            "cz_cross_city_rejected": cross_city_rejected,
            "ez_candidates": len(ez_candidates),
            "ez_diversity_enabled": diversity_enabled,
            "ez_diversity_method": EZ_DIVERSITY_METHOD if diversity_enabled else None,
            "ez_lambda_diversity": EZ_LAMBDA_DIVERSITY if diversity_enabled else None,
            "embedding_ok_count": embedding_ok_count,
            "embedding_fail_count": embedding_fail_count,
            "embedding_last_error": embedding_last_error
        }
    }
