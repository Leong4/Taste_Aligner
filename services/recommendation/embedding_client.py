"""
Recommendation Service v1.3 - Embedding Client

Lightweight client for the Embedding Service (/generate).
"""

from typing import List, Optional, Tuple
import logging
import time
import requests

try:
    from .config import EMBEDDING_URL, EMBEDDING_TIMEOUT_MS
except ImportError:
    from config import EMBEDDING_URL, EMBEDDING_TIMEOUT_MS

logger = logging.getLogger(__name__)


def generate_embedding_with_error(
    vision_tags: Optional[List[str]] = None,
    normalized_tags: Optional[List[str]] = None,
    emotion: Optional[str] = None,
    recency_days: Optional[float] = None,
    retries: int = 2
) -> Tuple[Optional[List[float]], Optional[str]]:
    """
    Call Embedding Service /generate.

    Returns:
        vector (List[float]) or None if request fails.
    """
    payload = {
        "data": {
            "vision_tags": vision_tags or [],
            "normalized_tags": normalized_tags or [],
            "emotion": emotion,
            "recency_days": recency_days
        }
    }

    timeout_sec = max(0.1, EMBEDDING_TIMEOUT_MS / 1000.0)

    last_error: Optional[str] = None
    for attempt in range(retries):
        try:
            resp = requests.post(EMBEDDING_URL, json=payload, timeout=timeout_sec)
            if resp.status_code != 200:
                raise RuntimeError(f"Embedding service returned {resp.status_code}")

            data = resp.json()
            vector = data.get("vector")
            if isinstance(vector, list) and len(vector) > 0:
                return vector, None

            raise RuntimeError("Embedding response missing vector")
        except Exception as e:
            last_error = str(e)
            if attempt == retries - 1:
                logger.warning(f"Embedding request failed: {e}")
                return None, last_error
            time.sleep(0.05)

    return None, last_error


def generate_embedding(
    vision_tags: Optional[List[str]] = None,
    normalized_tags: Optional[List[str]] = None,
    emotion: Optional[str] = None,
    recency_days: Optional[float] = None,
    retries: int = 2
) -> Optional[List[float]]:
    vector, _ = generate_embedding_with_error(
        vision_tags=vision_tags,
        normalized_tags=normalized_tags,
        emotion=emotion,
        recency_days=recency_days,
        retries=retries
    )
    return vector
