

"""
Embedding Core - Taste Embedding Space (TES) v1 / v2

Orchestrates the generation of deterministic, component-based embeddings
for the Taste Aligner system.

TES v2 now supports two backends (selected via EMBEDDING_BACKEND env var):
    hash_v2  – original deterministic hash embedding (default)
    st_v1    – Sentence-Transformers + deterministic random projection to 512d
"""

from typing import Dict, Any, List, Optional
import logging
import math
from ..common.helpers import ensure_dict
from .vector_utils import (
    hash_to_float,
    tags_to_vector,
    scalar_to_vector,
    l2_normalize,
    concatenate_components,
)

logger = logging.getLogger(__name__)

# TES v1 / v2 Configuration
VISION_DIM = 128
TAG_DIM = 256
SCALAR_DIM = 128
TOTAL_DIM = VISION_DIM + TAG_DIM + SCALAR_DIM  # 512

MODEL_NAME = "tes-v1-hash"
VERSION = "v1"
TES_V2_VERSION = "2.0"


def generate_embedding(payload: Any, normalize: bool = True) -> Dict[str, Any]:
    """
    Generate a Taste Embedding Space (TES) v1 vector.

    Args:
        payload: Request payload containing data
        normalize: Whether to apply L2 normalization (default: True)

    Returns:
        {
            "dummy": false,
            "model": "tes-v1-hash",
            "dim": 512,
            "normalized": true,
            "components": {...},
            "vector": [...],
            "meta": {...}
        }
    """
    # Extract data (handle both dict and Pydantic models)
    if hasattr(payload, 'data'):
        data = payload.data
        if hasattr(data, 'dict'):
            data_dict = data.dict() if hasattr(data, 'dict') else dict(data)
        elif isinstance(data, dict):
            data_dict = data
        else:
            data_dict = ensure_dict(data)
    else:
        data_dict = ensure_dict(payload)

    # Extract input fields (all optional)
    vision_tags = data_dict.get("vision_tags", [])
    normalized_tags = data_dict.get("normalized_tags", [])
    emotion = data_dict.get("emotion")
    recency_days = data_dict.get("recency_days")

    if vision_tags is None:
        vision_tags = []
    elif isinstance(vision_tags, str):
        vision_tags = [vision_tags]

    if normalized_tags is None:
        normalized_tags = []
    elif isinstance(normalized_tags, str):
        normalized_tags = [normalized_tags]

    logger.info(
        "Generating embedding – vision_tags: %d, normalized_tags: %d, "
        "emotion: %s, recency_days: %s",
        len(vision_tags),
        len(normalized_tags),
        emotion,
        recency_days,
    )

    # Component 1: Vision tags (128 dims)
    vision_component = tags_to_vector(vision_tags, VISION_DIM, seed="vision")
    # Component 2: Normalized tags (256 dims)
    tag_component = tags_to_vector(normalized_tags, TAG_DIM, seed="tags")
    # Component 3: Scalar features (128 dims)
    scalar_component = scalar_to_vector(
        emotion=emotion, recency_days=recency_days, dim=SCALAR_DIM
    )

    full_vector = concatenate_components(vision_component, tag_component, scalar_component)

    assert len(full_vector) == TOTAL_DIM, (
        f"Vector dimension mismatch: expected {TOTAL_DIM}, got {len(full_vector)}"
    )

    if normalize:
        full_vector = l2_normalize(full_vector)

    full_vector = [round(v, 6) for v in full_vector]

    logger.info("Embedding generated – dim: %d, normalized: %s", len(full_vector), normalize)

    return {
        "dummy": False,
        "model": MODEL_NAME,
        "dim": TOTAL_DIM,
        "normalized": normalize,
        "components": {
            "vision_dim": VISION_DIM,
            "tag_dim": TAG_DIM,
            "scalar_dim": SCALAR_DIM,
        },
        "vector": full_vector,
        "meta": {
            "version": VERSION,
            "note": "hash-based placeholder, no dimensionality reduction",
            "inputs": {
                "vision_tags_count": len(vision_tags) if vision_tags else 0,
                "normalized_tags_count": len(normalized_tags) if normalized_tags else 0,
                "has_emotion": emotion is not None,
                "has_recency": recency_days is not None,
            },
        },
    }


# ---------------------------------------------------------------------------
# Contract helpers
# ---------------------------------------------------------------------------

def _is_finite_vector(vector: List[float]) -> bool:
    return all(isinstance(v, (int, float)) and math.isfinite(v) for v in vector)


def _is_l2_normalized(vector: List[float], tolerance: float = 1e-3) -> bool:
    if not vector:
        return False
    norm = math.sqrt(sum(float(v) * float(v) for v in vector))
    return abs(norm - 1.0) <= tolerance


def _normalize_string_list(values: Optional[List[str]]) -> List[str]:
    if not values:
        return []
    return [str(v).strip() for v in values if str(v).strip()]


# ---------------------------------------------------------------------------
# TES v2 scalar component builder (hash_v2 path)
# ---------------------------------------------------------------------------

def _build_scalar_vector_v2(
    sentiment: Optional[float],
    recency_days: Optional[float],
    location: Optional[str],
    dim: int = SCALAR_DIM,
) -> List[float]:
    """
    Build TES v2 scalar component:
      - sentiment  (dims 0..31)
      - recency    (dims 32..63)
      - location   (dims 64..127)
    """
    vec = [0.0] * dim

    if sentiment is not None:
        sentiment_clamped = max(-1.0, min(1.0, float(sentiment)))
        for i in range(min(32, dim)):
            vec[i] = sentiment_clamped * hash_to_float("sentiment", i, "tes_v2")

    if recency_days is not None:
        days = max(0.0, float(recency_days))
        recency_weight = math.exp(-days / 30.0)
        for i in range(32, min(64, dim)):
            vec[i] = recency_weight * hash_to_float(f"recency:{days}", i - 32, "tes_v2")

    location_clean = (location or "").strip().lower()
    if location_clean:
        location_dim = max(0, dim - 64)
        if location_dim > 0:
            location_vec = tags_to_vector([location_clean], location_dim, seed="location_v2")
            for idx, value in enumerate(location_vec):
                target_idx = 64 + idx
                if target_idx < dim:
                    vec[target_idx] = value

    return vec


# ---------------------------------------------------------------------------
# TES v2 main entry point
# ---------------------------------------------------------------------------

def build_tes_vector_v2(
    vision_features: Optional[List[str]],
    tags: Optional[List[str]],
    sentiment: Optional[float],
    recency_days: Optional[float],
    location: Optional[str],
    normalize: bool = True,
) -> Dict[str, Any]:
    """
    Build TES v2 vector with strict contract validation.

    Supports hash_v2 (default) and st_v1 backends via EMBEDDING_BACKEND env var.

    Contract (both backends):
        vector    – list of 512 floats
        dim       – 512
        normalized – bool (true only if actually unit-norm)
        components – {vision_dim: 128, tag_dim: 256, scalar_dim: 128}
        meta       – {tes_version, backend, model_id, device, warm, inputs_summary}

    Raises:
        ValueError: propagated as HTTP 422 by the caller.
    """
    from .backends import get_backend

    backend = get_backend()

    vision_list = _normalize_string_list(vision_features)
    tag_list = _normalize_string_list(tags)
    location_clean = (location or "").strip().lower() or None

    # ------------------------------------------------------------------
    # Build raw (un-normalised) 512-dim vector
    # ------------------------------------------------------------------
    if backend.name == "st_v1":
        # Sentence-Transformers path
        raw_np = backend.encode_to_512(
            tags=tag_list,
            vision_features=vision_list,
            location=location_clean,
            sentiment=sentiment,
            recency_days=recency_days,
        )
        full_vector: List[float] = raw_np.tolist()
    else:
        # hash_v2 path (existing deterministic logic)
        vision_vector = tags_to_vector(vision_list, VISION_DIM, seed="vision_v2")
        tag_vector = tags_to_vector(tag_list, TAG_DIM, seed="tags_v2")
        scalar_vector = _build_scalar_vector_v2(
            sentiment=sentiment,
            recency_days=recency_days,
            location=location_clean,
            dim=SCALAR_DIM,
        )
        full_vector = concatenate_components(vision_vector, tag_vector, scalar_vector)

    # ------------------------------------------------------------------
    # Pre-normalisation checks
    # ------------------------------------------------------------------
    if len(full_vector) != TOTAL_DIM:
        raise ValueError(
            f"TES v2 dimension mismatch: expected {TOTAL_DIM}, got {len(full_vector)}"
        )
    if not _is_finite_vector(full_vector):
        raise ValueError("TES v2 vector contains non-finite values before normalisation")

    # ------------------------------------------------------------------
    # Normalisation
    # ------------------------------------------------------------------
    normalized_flag = False
    if normalize:
        norm = math.sqrt(sum(float(v) * float(v) for v in full_vector))
        if norm < 1e-10:
            raise ValueError(
                "TES v2 vector norm is too small to normalise (norm < 1e-10). "
                "Input produces a near-zero vector – check that at least one "
                "non-trivial field is provided."
            )
        full_vector = l2_normalize(full_vector)
        normalized_flag = True

    # ------------------------------------------------------------------
    # Post-normalisation checks
    # ------------------------------------------------------------------
    full_vector = [round(float(v), 6) for v in full_vector]

    if len(full_vector) != TOTAL_DIM:
        raise ValueError(
            f"TES v2 output dimension mismatch: expected {TOTAL_DIM}, got {len(full_vector)}"
        )
    if not _is_finite_vector(full_vector):
        raise ValueError("TES v2 vector contains non-finite values after normalisation")

    is_unit = _is_l2_normalized(full_vector)
    if normalized_flag and not is_unit:
        raise ValueError("TES v2 normalised flag inconsistent with actual vector norm")
    if not normalized_flag and is_unit and normalize:
        raise ValueError(
            "TES v2 normalised flag inconsistent (unit vector marked non-normalised)"
        )

    # ------------------------------------------------------------------
    # Response
    # ------------------------------------------------------------------
    return {
        "vector": full_vector,
        "dim": TOTAL_DIM,
        "normalized": normalized_flag,
        "components": {
            "vision_dim": VISION_DIM,
            "tag_dim": TAG_DIM,
            "scalar_dim": SCALAR_DIM,
        },
        "meta": {
            "tes_version": TES_V2_VERSION,
            "backend": backend.name,
            "model_id": backend.model_id,
            "device": backend.device,
            "warm": backend.warm,
            "inputs_summary": {
                "vision_count": len(vision_list),
                "tag_count": len(tag_list),
                "has_sentiment": sentiment is not None,
                "has_recency": recency_days is not None,
                "has_location": location_clean is not None,
            },
        },
    }
