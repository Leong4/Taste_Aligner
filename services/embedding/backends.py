"""
Embedding Backends for the Taste Embedding Space.

hash_v2 (default)
    Deterministic hash-based embeddings.  No model required; always warm.
    Real work is done by the existing vector_utils / embedding_core helpers.
    This class is a thin metadata holder.

st_v1
    Sentence-Transformers model + deterministic random projection to 512 dims.
    Text is built from TES v2 inputs (tags, vision_features, location,
    sentiment, recency_days) and encoded with the configured ST model, then
    projected to exactly 512 dimensions.

Backend selection is read from EMBEDDING_BACKEND env var at first call to
get_backend(), allowing test-time patching via os.environ + singleton reset.
"""

import logging
import math
import os
from typing import List, Optional

import numpy as np

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# hash_v2 backend
# ---------------------------------------------------------------------------

class HashV2Backend:
    """Thin metadata holder – real embedding is done in embedding_core.py."""

    name: str = "hash_v2"

    @property
    def warm(self) -> bool:
        return True  # No model to load

    @property
    def model_id(self) -> Optional[str]:
        return None

    @property
    def device(self) -> str:
        return "cpu"


# ---------------------------------------------------------------------------
# st_v1 backend
# ---------------------------------------------------------------------------

class STBackend:
    """Sentence-Transformers backend with deterministic projection to 512 dims."""

    name: str = "st_v1"

    def __init__(self, model_id: str, device: str):
        self._model_id = model_id
        self._device = device
        self._model = None
        self._warm: bool = False

    # ------------------------------------------------------------------
    # Properties
    # ------------------------------------------------------------------

    @property
    def warm(self) -> bool:
        return self._warm

    @property
    def model_id(self) -> str:
        return self._model_id

    @property
    def device(self) -> str:
        return self._device

    # ------------------------------------------------------------------
    # Model loading (lazy)
    # ------------------------------------------------------------------

    def _ensure_loaded(self) -> None:
        if self._model is not None:
            return
        logger.info(
            "Loading SentenceTransformer '%s' on device '%s'",
            self._model_id,
            self._device,
        )
        from sentence_transformers import SentenceTransformer

        self._model = SentenceTransformer(self._model_id, device=self._device)
        self._warm = True
        logger.info(
            "SentenceTransformer loaded – native embedding_dim=%d",
            self._model.get_sentence_embedding_dimension(),
        )

    # ------------------------------------------------------------------
    # Text construction
    # ------------------------------------------------------------------

    @staticmethod
    def build_text(
        tags: Optional[List[str]],
        vision_features: Optional[List[str]],
        location: Optional[str],
        sentiment: Optional[float],
        recency_days: Optional[float],
    ) -> str:
        """
        Build a plain-text representation of TES v2 inputs.

        Layout (sorted for order-independence):
            <tags> <vision_features> <location> sentiment:<v> recency:<d>
        """
        parts: List[str] = []

        if tags:
            cleaned = sorted(t.strip() for t in tags if t.strip())
            if cleaned:
                parts.append(" ".join(cleaned))

        if vision_features:
            cleaned = sorted(v.strip() for v in vision_features if v.strip())
            if cleaned:
                parts.append(" ".join(cleaned))

        if location and location.strip():
            parts.append(location.strip())

        if sentiment is not None and math.isfinite(sentiment):
            parts.append(f"sentiment:{sentiment:.2f}")

        if recency_days is not None and math.isfinite(recency_days):
            parts.append(f"recency:{int(recency_days)}")

        return " ".join(parts) if parts else "default"

    # ------------------------------------------------------------------
    # Encoding
    # ------------------------------------------------------------------

    def encode_to_512(
        self,
        tags: Optional[List[str]],
        vision_features: Optional[List[str]],
        location: Optional[str],
        sentiment: Optional[float],
        recency_days: Optional[float],
    ) -> np.ndarray:
        """
        Encode TES v2 inputs into a raw (un-normalised) 512-dim float32 vector.

        Steps:
            1. Build text from inputs.
            2. Encode with SentenceTransformer -> (d,) vector.
            3. Project to 512 dims via deterministic random matrix.

        Returns:
            np.ndarray of shape (512,), dtype float32 (not yet normalised).

        Raises:
            ValueError: if the model or projection returns non-finite values.
        """
        self._ensure_loaded()

        text = self.build_text(tags, vision_features, location, sentiment, recency_days)
        logger.debug("ST encoding text (len=%d): %.80s", len(text), text)

        raw: np.ndarray = self._model.encode(text, convert_to_numpy=True)

        if not np.all(np.isfinite(raw)):
            raise ValueError("SentenceTransformer returned non-finite values")

        from .projection import project_to_512

        projected = project_to_512(raw)

        if not np.all(np.isfinite(projected)):
            raise ValueError("Random projection produced non-finite values")

        return projected  # shape (512,), float32


# ---------------------------------------------------------------------------
# Singleton factory
# ---------------------------------------------------------------------------

_instance: Optional[object] = None


def get_backend():
    """
    Return the configured backend singleton (lazy-initialised).

    Reads EMBEDDING_BACKEND, ST_MODEL_ID, and DEVICE from env at first call.
    Reset _instance = None to force re-initialisation (useful in tests).
    """
    global _instance
    if _instance is not None:
        return _instance

    cfg = {
        "backend": os.getenv("EMBEDDING_BACKEND", "hash_v2"),
        "model_id": os.getenv("ST_MODEL_ID", "sentence-transformers/all-MiniLM-L6-v2"),
        "device": os.getenv("DEVICE", "cpu"),
    }

    if cfg["backend"] not in ("hash_v2", "st_v1"):
        raise ValueError(
            f"EMBEDDING_BACKEND must be 'hash_v2' or 'st_v1', got '{cfg['backend']}'"
        )
    if cfg["device"] not in ("cpu", "cuda"):
        raise ValueError(
            f"DEVICE must be 'cpu' or 'cuda', got '{cfg['device']}'"
        )

    if cfg["backend"] == "st_v1":
        _instance = STBackend(model_id=cfg["model_id"], device=cfg["device"])
    else:
        _instance = HashV2Backend()

    logger.info("Embedding backend ready: %s", cfg["backend"])
    return _instance
