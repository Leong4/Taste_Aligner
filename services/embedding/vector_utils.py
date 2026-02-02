"""
Vector Utils - Deterministic Hash-based Vector Generation

Provides utilities for creating deterministic, hash-based vectors
for the Taste Embedding Space (TES) v1.
"""

import hashlib
import numpy as np
from typing import List, Set


def hash_to_float(text: str, index: int, seed: str = "") -> float:
    """
    Convert text to a deterministic float at a given index position.

    Args:
        text: Input text to hash
        index: Position index in the vector
        seed: Optional seed for variation

    Returns:
        Float in range [-1.0, 1.0]
    """
    # Combine text, index, and seed for unique hash
    combined = f"{text}:{index}:{seed}"
    hash_bytes = hashlib.sha256(combined.encode('utf-8')).digest()

    # Use first 8 bytes as integer, normalize to [-1, 1]
    int_value = int.from_bytes(hash_bytes[:8], byteorder='big')
    normalized = (int_value % 2000000) / 1000000.0 - 1.0  # Maps to [-1.0, 1.0)

    return normalized


def tags_to_vector(tags: List[str], dim: int, seed: str = "vision") -> List[float]:
    """
    Convert a list of tags to a deterministic vector.

    Order-independent: same tags in different order produce same vector.

    Args:
        tags: List of tag strings
        dim: Target dimension
        seed: Seed for differentiation (e.g., "vision" vs "tags")

    Returns:
        List of floats with length dim
    """
    if not tags:
        # Return zero vector for empty input
        return [0.0] * dim

    # Sort tags for order-independence
    sorted_tags = sorted(set(tag.lower().strip() for tag in tags if tag))

    # Initialize vector
    vector = [0.0] * dim

    # Each tag contributes to multiple dimensions via hashing
    for tag in sorted_tags:
        for i in range(dim):
            # Add contribution from this tag to this dimension
            contribution = hash_to_float(tag, i, seed)
            vector[i] += contribution

    # Normalize contributions by number of tags (avoid magnitude growth)
    if sorted_tags:
        vector = [v / len(sorted_tags) for v in vector]

    return vector


def scalar_to_vector(
    emotion: str = None,
    recency_days: float = None,
    dim: int = 128
) -> List[float]:
    """
    Encode scalar features into a vector.

    Args:
        emotion: Emotion label (e.g., "positive", "negative", "neutral")
        recency_days: Number of days since event (0 = today)
        dim: Target dimension

    Returns:
        List of floats with length dim
    """
    vector = [0.0] * dim

    # Emotion encoding (first 64 dims)
    if emotion:
        emotion_map = {
            "positive": 1.0,
            "neutral": 0.0,
            "negative": -1.0,
        }
        emotion_value = emotion_map.get(emotion.lower(), 0.0)

        # Spread emotion across first 64 dimensions
        for i in range(min(64, dim)):
            vector[i] = emotion_value * hash_to_float(emotion, i, "emotion")

    # Recency encoding (next 64 dims)
    if recency_days is not None:
        # Decay function: more recent = higher value
        # recency_value = exp(-recency_days / 30) maps to [0, 1]
        import math
        recency_value = math.exp(-recency_days / 30.0)

        # Spread recency across dimensions 64-127
        for i in range(64, min(128, dim)):
            base = hash_to_float(str(recency_days), i - 64, "recency")
            vector[i] = recency_value * base

    return vector


def l2_normalize(vector: List[float]) -> List[float]:
    """
    Apply L2 normalization to a vector.

    Args:
        vector: Input vector

    Returns:
        L2-normalized vector (unit length)
    """
    vec_array = np.array(vector, dtype=np.float32)
    norm = np.linalg.norm(vec_array)

    if norm < 1e-10:  # Avoid division by zero
        return vector

    normalized = vec_array / norm
    return normalized.tolist()


def concatenate_components(
    vision_vec: List[float],
    tag_vec: List[float],
    scalar_vec: List[float]
) -> List[float]:
    """
    Concatenate component vectors in fixed order.

    Order: [vision | tags | scalars]

    Args:
        vision_vec: Vision component vector
        tag_vec: Tag component vector
        scalar_vec: Scalar component vector

    Returns:
        Concatenated vector
    """
    return vision_vec + tag_vec + scalar_vec
