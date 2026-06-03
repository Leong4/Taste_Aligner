"""
Search Module - Cosine Similarity + Unified Weighting (v1.3)

Implements retrieval with:
- Cosine similarity (primary)
- v1.1: Time decay (w_time)
- v1.2: Sentiment weight (w_sent)
- v1.3: Context boost (w_context = city_boost * tag_boost)

Final score = cosine * w_time * w_sent * w_context
"""

import math
from datetime import datetime
from typing import Dict, Any, List, Optional
import logging

logger = logging.getLogger(__name__)

# Weighting parameters (Memory v1.1 - v1.3)
LAMBDA_TIME = 0.03  # Time decay: exp(-λ * Δdays)
ALPHA_SENT = 0.5  # Sentiment: w_sent = 1 + α * sentiment
CITY_MATCH_BOOST = 1.2  # City boost if match
TAG_MATCH_BOOST = 1.1  # Tag boost if overlap >= 1


def cosine_similarity(vec1: List[float], vec2: List[float]) -> float:
    """
    Compute cosine similarity between two vectors.

    Assumes both vectors are L2 normalized (norm ≈ 1).
    For normalized vectors: cosine = dot product

    Args:
        vec1: First vector
        vec2: Second vector

    Returns:
        Cosine similarity in [-1, 1]
    """
    if len(vec1) != len(vec2):
        raise ValueError(f"Vector dimension mismatch: {len(vec1)} vs {len(vec2)}")

    # Dot product (since vectors are normalized)
    dot_product = sum(a * b for a, b in zip(vec1, vec2))

    return dot_product


def compute_time_weight(memory_ts: str, now_ts: str) -> float:
    """
    Memory v1.1 - Time Decay Weight

    w_time = exp(-λ * Δdays)

    Args:
        memory_ts: Memory timestamp (ISO 8601)
        now_ts: Current timestamp (ISO 8601)

    Returns:
        Time weight in (0, 1], defaults to 1.0 if timestamp missing
    """
    try:
        # Parse timestamps
        memory_dt = datetime.fromisoformat(memory_ts.replace('Z', '+00:00'))
        now_dt = datetime.fromisoformat(now_ts.replace('Z', '+00:00'))

        # Compute delta in days
        delta_days = (now_dt - memory_dt).total_seconds() / 86400.0

        # Ensure non-negative
        delta_days = max(0, delta_days)

        # Exponential decay
        w_time = math.exp(-LAMBDA_TIME * delta_days)

        return w_time

    except Exception as e:
        logger.warning(f"Error computing time weight: {e}, defaulting to 1.0")
        return 1.0


def compute_sentiment_weight(sentiment: float) -> float:
    """
    Memory v1.2 - Sentiment Weight

    w_sent = 1 + α * sentiment

    Args:
        sentiment: Sentiment value in [-1, 1], defaults to 0.0

    Returns:
        Sentiment weight in [0.5, 1.5]
    """
    # Clamp sentiment to [-1, 1]
    sentiment = max(-1.0, min(1.0, sentiment))

    w_sent = 1.0 + ALPHA_SENT * sentiment

    # Clamp to safe range
    w_sent = max(0.5, min(1.5, w_sent))

    return w_sent


def compute_city_boost(memory_city: str, query_city: str) -> float:
    """
    Memory v1.3 - City Boost (component of w_context)

    city_boost = 1.2 if cities match (case-insensitive), else 1.0

    Args:
        memory_city: Memory city
        query_city: Query city

    Returns:
        City boost (1.0 or 1.2)
    """
    if not memory_city or not query_city:
        return 1.0

    if memory_city.lower().strip() == query_city.lower().strip():
        return CITY_MATCH_BOOST
    else:
        return 1.0


def compute_tag_boost(query_tags: Optional[List[str]], memory_tags: List[str]) -> float:
    """
    Memory v1.3 - Tag Boost (component of w_context)

    tag_boost = 1.1 if overlap >= 1, else 1.0

    Args:
        query_tags: Query tags (normalized)
        memory_tags: Memory tags (normalized)

    Returns:
        Tag boost (1.0 or 1.1)
    """
    if not query_tags or not memory_tags:
        return 1.0

    # Normalize tags to lowercase for comparison
    query_set = set(tag.lower().strip() for tag in query_tags if tag)
    memory_set = set(tag.lower().strip() for tag in memory_tags if tag)

    if not query_set or not memory_set:
        return 1.0

    # Check for overlap
    overlap_count = len(query_set & memory_set)

    if overlap_count >= 1:
        return TAG_MATCH_BOOST
    else:
        return 1.0


def compute_context_weight(
    memory_city: str,
    query_city: Optional[str],
    memory_tags: List[str],
    query_tags: Optional[List[str]]
) -> tuple[float, float, float]:
    """
    Memory v1.3 - Context Weight

    w_context = city_boost * tag_boost

    Args:
        memory_city: Memory city
        query_city: Query city
        memory_tags: Memory normalized tags
        query_tags: Query tags

    Returns:
        Tuple of (w_context, city_boost, tag_boost) for explainability
    """
    city_boost = compute_city_boost(memory_city, query_city)
    tag_boost = compute_tag_boost(query_tags, memory_tags)

    w_context = city_boost * tag_boost

    return w_context, city_boost, tag_boost


def tag_overlap_score(query_tags: List[str], memory_tags: List[str]) -> float:
    """
    Fallback: compute tag overlap score (Jaccard similarity).

    Args:
        query_tags: Query tags
        memory_tags: Memory tags

    Returns:
        Jaccard similarity in [0, 1]
    """
    if not query_tags or not memory_tags:
        return 0.0

    # Normalize tags to lowercase
    query_set = set(tag.lower().strip() for tag in query_tags if tag)
    memory_set = set(tag.lower().strip() for tag in memory_tags if tag)

    if not query_set or not memory_set:
        return 0.0

    intersection = len(query_set & memory_set)
    union = len(query_set | memory_set)

    if union == 0:
        return 0.0

    return intersection / union


def search_memories(
    memories: List[Dict[str, Any]],
    query_embedding: Optional[List[float]],
    query_tags: Optional[List[str]],
    query_city: Optional[str],
    now_ts: str,
    memory_pool: Optional[str] = None,
    top_k: int = 10
) -> List[Dict[str, Any]]:
    """
    Memory v1.3 - Search with Unified Weighting

    final_score = cosine * w_time * w_sent * w_context

    Args:
        memories: List of all user memories
        query_embedding: Query embedding vector (512 dims)
        query_tags: Query tags (fallback if no embedding)
        query_city: Query city (for context boost)
        now_ts: Current timestamp (for time decay)
        memory_pool: Optional pool filter (food|scenery|all)
        top_k: Number of results to return

    Returns:
        List of search results sorted by final_score DESC, each with full explainability
    """
    results = []
    normalized_pool = (memory_pool or "all").strip().lower()
    pool_filter_enabled = normalized_pool in {"food", "scenery"}

    use_embedding = query_embedding is not None and len(query_embedding) > 0

    for memory in memories:
        if pool_filter_enabled:
            memory_type = str(memory.get("vision_type", "")).strip().lower()
            if memory_type != normalized_pool:
                continue

        memory_id = memory["memory_id"]
        memory_embedding = memory.get("embedding", [])
        memory_tags = memory.get("normalized_tags", [])
        memory_city = memory.get("city", "")
        memory_ts = memory.get("timestamp", "")
        sentiment = memory.get("sentiment", 0.0)

        if query_city:
            if memory_city.lower().strip() != query_city.lower().strip():
                continue

        # Compute base similarity (cosine or tag overlap fallback)
        if use_embedding and len(memory_embedding) == 512:
            # Primary: Cosine similarity
            try:
                cosine = cosine_similarity(query_embedding, memory_embedding)
            except Exception as e:
                logger.warning(f"Error computing cosine for {memory_id}: {e}")
                cosine = 0.0
        elif query_tags:
            # Fallback: Tag overlap (Jaccard)
            cosine = tag_overlap_score(query_tags, memory_tags)
        else:
            # No query embedding or tags, skip this memory
            continue

        # Compute weighting factors (v1.1 - v1.3)
        w_time = compute_time_weight(memory_ts, now_ts)
        w_sent = compute_sentiment_weight(sentiment)
        w_context, city_boost, tag_boost = compute_context_weight(
            memory_city, query_city, memory_tags, query_tags
        )

        # Final score
        final_score = cosine * w_time * w_sent * w_context

        # Append result with full explainability
        results.append({
            "memory_id": memory_id,
            "score": round(final_score, 6),
            "cosine": round(cosine, 6),
            "w_time": round(w_time, 6),
            "w_sent": round(w_sent, 6),
            "w_context": round(w_context, 6),
            "city_boost": round(city_boost, 6),
            "tag_boost": round(tag_boost, 6),
            "timestamp": memory_ts,
            "city": memory_city,
            "vision_type": memory.get("vision_type"),
            "normalized_tags": memory_tags,
            "sentiment": sentiment,
            "image_url": f"/files/{memory_id}?variant=thumb",
            "preview_url": f"/files/{memory_id}?variant=preview"
        })

    # Sort by final_score DESC
    results.sort(key=lambda x: x["score"], reverse=True)

    # Return top_k
    return results[:top_k]
