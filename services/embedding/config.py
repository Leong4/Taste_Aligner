"""
Embedding Service Configuration

Reads backend selection and model configuration from environment variables.
All validation is done at first call to get_config() to allow test-time patching.
"""

import os


def get_config() -> dict:
    """
    Read and validate embedding configuration from environment variables.

    Returns a dict with keys:
        backend   - "hash_v2" | "st_v1"
        model_id  - sentence-transformers model id (st_v1 only)
        device    - "cpu" | "cuda"
    """
    backend = os.getenv("EMBEDDING_BACKEND", "hash_v2")
    model_id = os.getenv("ST_MODEL_ID", "sentence-transformers/all-MiniLM-L6-v2")
    device = os.getenv("DEVICE", "cpu")

    if backend not in ("hash_v2", "st_v1"):
        raise ValueError(
            f"EMBEDDING_BACKEND must be 'hash_v2' or 'st_v1', got '{backend}'"
        )
    if device not in ("cpu", "cuda"):
        raise ValueError(
            f"DEVICE must be 'cpu' or 'cuda', got '{device}'"
        )

    return {"backend": backend, "model_id": model_id, "device": device}
