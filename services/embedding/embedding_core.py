"""
Embedding Core - Taste Embedding Space (TES) v1

Orchestrates the generation of deterministic, component-based embeddings
for the Taste Aligner system.
"""

from typing import Dict, Any, List
import logging
from ..common.helpers import ensure_dict
from .vector_utils import (
    tags_to_vector,
    scalar_to_vector,
    l2_normalize,
    concatenate_components
)

logger = logging.getLogger(__name__)

# TES v1 Configuration
VISION_DIM = 128
TAG_DIM = 256
SCALAR_DIM = 128
TOTAL_DIM = VISION_DIM + TAG_DIM + SCALAR_DIM  # 512

MODEL_NAME = "tes-v1-hash"
VERSION = "v1"


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
            # Pydantic model
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

    # Ensure tags are lists (handle None values)
    if vision_tags is None:
        vision_tags = []
    elif isinstance(vision_tags, str):
        vision_tags = [vision_tags]

    if normalized_tags is None:
        normalized_tags = []
    elif isinstance(normalized_tags, str):
        normalized_tags = [normalized_tags]

    logger.info(
        f"Generating embedding - vision_tags: {len(vision_tags)}, "
        f"normalized_tags: {len(normalized_tags)}, "
        f"emotion: {emotion}, recency_days: {recency_days}"
    )

    # Component 1: Vision tags (128 dims)
    vision_component = tags_to_vector(vision_tags, VISION_DIM, seed="vision")

    # Component 2: Normalized tags (256 dims)
    tag_component = tags_to_vector(normalized_tags, TAG_DIM, seed="tags")

    # Component 3: Scalar features (128 dims)
    scalar_component = scalar_to_vector(
        emotion=emotion,
        recency_days=recency_days,
        dim=SCALAR_DIM
    )

    # Concatenate components in fixed order: [vision | tags | scalars]
    full_vector = concatenate_components(
        vision_component,
        tag_component,
        scalar_component
    )

    # Verify dimension
    assert len(full_vector) == TOTAL_DIM, \
        f"Vector dimension mismatch: expected {TOTAL_DIM}, got {len(full_vector)}"

    # Apply L2 normalization if requested
    if normalize:
        full_vector = l2_normalize(full_vector)

    # Round to 6 decimal places for consistency
    full_vector = [round(v, 6) for v in full_vector]

    logger.info(f"Embedding generated - dim: {len(full_vector)}, normalized: {normalize}")

    # Build response
    response = {
        "dummy": False,
        "model": MODEL_NAME,
        "dim": TOTAL_DIM,
        "normalized": normalize,
        "components": {
            "vision_dim": VISION_DIM,
            "tag_dim": TAG_DIM,
            "scalar_dim": SCALAR_DIM
        },
        "vector": full_vector,
        "meta": {
            "version": VERSION,
            "note": "hash-based placeholder, no dimensionality reduction",
            "inputs": {
                "vision_tags_count": len(vision_tags) if vision_tags else 0,
                "normalized_tags_count": len(normalized_tags) if normalized_tags else 0,
                "has_emotion": emotion is not None,
                "has_recency": recency_days is not None
            }
        }
    }

    return response
