"""
Recommendation Service v1.3 - Embedding Client

Primary path: TES v2 (/tes/build).
Fallback path: TES v1 (/generate) only when v2 fails.
"""

from typing import Any, Dict, List, Optional, Tuple
import logging
import math
import time
import requests

from .config import (
    EMBEDDING_EXPECTED_DIM,
    EMBEDDING_TES_V1_URL,
    EMBEDDING_TES_V2_URL,
    EMBEDDING_TIMEOUT_MS,
)

logger = logging.getLogger(__name__)

TES_V2_SPACE = "tes_v2"
TES_V1_FALLBACK_SPACE = "tes_v1_fallback"
TES_NONE_SPACE = "none"

_EMOTION_TO_SENTIMENT = {
    "positive": 0.8,
    "neutral": 0.0,
    "negative": -0.8,
}


def _vector_norm(vector: List[float]) -> float:
    return math.sqrt(sum(float(v) * float(v) for v in vector))


def _normalize(vector: List[float]) -> Optional[List[float]]:
    norm = _vector_norm(vector)
    if norm <= 1e-10:
        return None
    return [float(v) / norm for v in vector]


def _validate_and_normalize_vector(
    vector: Any,
    expected_dim: int = EMBEDDING_EXPECTED_DIM
) -> Tuple[Optional[List[float]], Optional[str]]:
    if not isinstance(vector, list):
        return None, "vector_not_list"
    if len(vector) != expected_dim:
        return None, f"vector_dim_{len(vector)}"
    if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in vector):
        return None, "vector_non_finite"
    normalized = _normalize([float(v) for v in vector])
    if normalized is None:
        return None, "vector_norm_too_small"
    return normalized, None


def _post_json(
    url: str,
    payload: Dict[str, Any],
    timeout_sec: float,
    retries: int
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    last_error: Optional[str] = None
    for attempt in range(retries):
        try:
            resp = requests.post(url, json=payload, timeout=timeout_sec)
            if resp.status_code != 200:
                raise RuntimeError(f"http_{resp.status_code}")
            return resp.json(), None
        except Exception as e:
            last_error = str(e)
            if attempt == retries - 1:
                return None, last_error
            time.sleep(0.05)
    return None, last_error


def _emotion_to_sentiment(emotion: Optional[str]) -> Optional[float]:
    if emotion is None:
        return None
    key = str(emotion).strip().lower()
    if not key:
        return None
    return _EMOTION_TO_SENTIMENT.get(key)


def generate_embedding_with_error(
    vision_tags: Optional[List[str]] = None,
    normalized_tags: Optional[List[str]] = None,
    emotion: Optional[str] = None,
    recency_days: Optional[float] = None,
    location: Optional[str] = None,
    retries: int = 2
) -> Tuple[Optional[List[float]], Optional[str], str, Optional[str]]:
    """
    Generate embedding in unified TES space for recommendation.

    Returns:
        vector, error, embedding_space, fallback_reason
    """
    timeout_sec = max(0.1, EMBEDDING_TIMEOUT_MS / 1000.0)

    # Primary path: TES v2.
    tes_payload = {
        "vision_features": vision_tags or [],
        "tags": normalized_tags or [],
        "sentiment": _emotion_to_sentiment(emotion),
        "recency_days": recency_days,
        "location": location,
        "normalize": True,
    }
    tes_resp, tes_err = _post_json(
        EMBEDDING_TES_V2_URL,
        tes_payload,
        timeout_sec=timeout_sec,
        retries=retries,
    )
    if tes_resp is not None:
        vector, vector_err = _validate_and_normalize_vector(tes_resp.get("vector"))
        if vector is not None:
            return vector, None, TES_V2_SPACE, None
        tes_err = f"tes_v2_{vector_err}"
    else:
        tes_err = f"tes_v2_{tes_err or 'request_failed'}"

    # Deterministic fallback: TES v1.
    legacy_payload = {
        "data": {
            "vision_tags": vision_tags or [],
            "normalized_tags": normalized_tags or [],
            "emotion": emotion,
            "recency_days": recency_days
        }
    }
    legacy_resp, legacy_err = _post_json(
        EMBEDDING_TES_V1_URL,
        legacy_payload,
        timeout_sec=timeout_sec,
        retries=retries,
    )
    if legacy_resp is not None:
        vector, vector_err = _validate_and_normalize_vector(legacy_resp.get("vector"))
        if vector is not None:
            logger.warning("TES v2 embedding failed; using TES v1 fallback")
            return vector, None, TES_V1_FALLBACK_SPACE, tes_err
        legacy_err = f"tes_v1_{vector_err}"
    else:
        legacy_err = f"tes_v1_{legacy_err or 'request_failed'}"

    last_error = f"{tes_err}; {legacy_err}"
    logger.warning(f"Embedding request failed on v2 and fallback v1: {last_error}")
    return None, last_error, TES_NONE_SPACE, tes_err


def generate_embedding(
    vision_tags: Optional[List[str]] = None,
    normalized_tags: Optional[List[str]] = None,
    emotion: Optional[str] = None,
    recency_days: Optional[float] = None,
    location: Optional[str] = None,
    retries: int = 2
) -> Optional[List[float]]:
    vector, _, _, _ = generate_embedding_with_error(
        vision_tags=vision_tags,
        normalized_tags=normalized_tags,
        emotion=emotion,
        recency_days=recency_days,
        location=location,
        retries=retries
    )
    return vector
