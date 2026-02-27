"""
Vision backends for the Taste Aligner Vision Service.

Supported backends:
  rule_v0   - keyword extraction from URL/filename (offline, no model needed)
  clip_v1   - CLIP-based image understanding (open_clip_torch, local model, CPU default)
  cloud_v1  - Reserved for future cloud API provider (NOT implemented yet)

Extension point: to add cloud_v1, implement a CloudV1Backend class and register
it in get_backend() under the "cloud_v1" key. The backend must expose:
  .name: str
  .model_id: str | None
  .device: str
  .warm: bool
  .describe(image_url, image_base64, top_k) -> {"tags": [...], "scores": [...]}
"""

import os
import math
import logging
from typing import Dict, Any, List, Optional

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# Vocabulary for tag classification
# ─────────────────────────────────────────────────────────────────────────────
VISION_VOCABULARY: List[str] = [
    # food & drink
    "ramen", "sushi", "izakaya", "cafe", "coffee", "dessert", "pastry",
    "street_food", "food", "restaurant", "noodles", "rice",
    "seafood", "grilled", "spicy", "hotpot",
    # culture & sights
    "temple", "shrine", "museum", "art", "culture", "traditional",
    "architecture", "landmark", "garden",
    # urban & lifestyle
    "nightlife", "bar", "shopping", "city_walk", "market", "night_market",
    "urban", "modern", "vintage", "fashion",
    # nature & outdoors
    "park", "nature", "mountain", "lake", "seaside", "beach",
    "hiking", "outdoor", "forest",
    # ambience
    "cozy", "relaxation", "photography", "street", "alley",
    "vibrant", "calm", "lively",
]

# Keyword rules for rule_v0 backend
_KEYWORD_MAP: Dict[str, str] = {
    "ramen": "ramen", "noodle": "ramen", "sushi": "sushi",
    "izakaya": "izakaya", "cafe": "cafe", "coffee": "cafe",
    "dessert": "dessert", "sweet": "dessert",
    "street food": "street_food", "street_food": "street_food",
    "food": "food", "temple": "temple", "shrine": "shrine",
    "museum": "museum", "culture": "culture",
    "nightlife": "nightlife", "night": "nightlife",
    "bar": "bar", "shopping": "shopping",
    "city": "city_walk", "walk": "city_walk", "walking": "city_walk",
    "park": "park", "garden": "park",
    "hiking": "hiking", "mountain": "mountain",
    "beach": "seaside", "sea": "seaside",
    "photo": "photography", "relax": "relaxation",
    "market": "market", "street": "street",
}


# ─────────────────────────────────────────────────────────────────────────────
# rule_v0 backend
# ─────────────────────────────────────────────────────────────────────────────
class RuleV0Backend:
    """
    Pure keyword extraction from image URL / base64 string tokens.
    No model required. Always warm. Deterministic, fully offline.
    """

    name: str = "rule_v0"
    model_id: Optional[str] = None
    device: str = "cpu"
    warm: bool = True

    def describe(
        self,
        image_url: Optional[str],
        image_base64: Optional[str],
        top_k: int,
    ) -> Dict[str, Any]:
        import re

        text = ""
        if image_url:
            text += " " + str(image_url)
        if image_base64:
            # Treat base64 string as plain text — keyword matching only
            text += " " + str(image_base64)

        cleaned = re.sub(r"[^\w\s]", " ", text.lower())
        cleaned = re.sub(r"\s+", " ", cleaned).strip()

        found: List[str] = []
        seen: set = set()
        # Longer keywords first to avoid partial matches overwriting longer ones
        for keyword, tag in sorted(_KEYWORD_MAP.items(), key=lambda x: -len(x[0])):
            if keyword in cleaned and tag not in seen:
                found.append(tag)
                seen.add(tag)

        if not found:
            # Deterministic default when no keywords are detected
            found = ["ramen", "nightlife", "street_food"]

        found = found[:top_k]
        scores = [
            {"tag": t, "score": round(0.90 + (hash(t) % 10) * 0.005, 4)}
            for t in found
        ]
        return {"tags": sorted(set(found)), "scores": scores}


# ─────────────────────────────────────────────────────────────────────────────
# clip_v1 backend
# ─────────────────────────────────────────────────────────────────────────────
class ClipV1Backend:
    """
    CLIP-based zero-shot image tagging.

    Uses open_clip_torch to classify images against VISION_VOCABULARY.
    Model is loaded lazily on first describe() call (or explicitly via warm_up()).
    Requires: open_clip_torch, Pillow, torch.

    VISION_MODEL_ID env format: "ViT-B-32" or "ViT-B-32/openai".
    Default pretrained is "openai" when no "/" is present.
    """

    name: str = "clip_v1"

    def __init__(self, model_id: str, device: str) -> None:
        self._model_id = model_id
        self._device = device
        self._model = None
        self._preprocess = None
        self._text_features = None
        self._warm = False

    @property
    def model_id(self) -> str:
        return self._model_id

    @property
    def device(self) -> str:
        return self._device

    @property
    def warm(self) -> bool:
        return self._warm

    def _ensure_loaded(self) -> None:
        if self._warm:
            return
        import open_clip
        import torch
        import numpy as np

        logger.info(
            "[clip_v1] Loading CLIP model: %s on %s", self._model_id, self._device
        )
        parts = self._model_id.split("/", 1)
        arch = parts[0]
        pretrained = parts[1] if len(parts) > 1 else "openai"

        try:
            model, _, preprocess = open_clip.create_model_and_transforms(
                arch, pretrained=pretrained, device=self._device
            )
        except Exception as exc:
            raise RuntimeError(
                f"Failed to load CLIP model '{self._model_id}': {exc}"
            ) from exc

        tokenizer = open_clip.get_tokenizer(arch)
        model.eval()

        logger.info(
            "[clip_v1] Precomputing text embeddings for %d vocabulary tags",
            len(VISION_VOCABULARY),
        )
        prompts = [
            f"a photo of {tag.replace('_', ' ')}" for tag in VISION_VOCABULARY
        ]
        texts = tokenizer(prompts).to(self._device)

        with torch.no_grad():
            text_features = model.encode_text(texts)
            norm = text_features.norm(dim=-1, keepdim=True)
            norm = torch.where(norm < 1e-10, torch.ones_like(norm), norm)
            text_features = text_features / norm

        self._model = model
        self._preprocess = preprocess
        self._text_features = text_features
        self._warm = True
        logger.info("[clip_v1] Model loaded and warm")

    def warm_up(self) -> None:
        """Explicitly preload the model (called at startup for fail-fast behaviour)."""
        self._ensure_loaded()

    def describe(
        self,
        image_url: Optional[str],
        image_base64: Optional[str],
        top_k: int,
    ) -> Dict[str, Any]:
        self._ensure_loaded()

        import torch
        import numpy as np
        from PIL import Image
        import io

        # ── Load image ────────────────────────────────────────────────────────
        if image_base64:
            import base64 as _b64
            try:
                img_bytes = _b64.b64decode(image_base64)
                image = Image.open(io.BytesIO(img_bytes)).convert("RGB")
            except Exception as exc:
                raise ValueError(f"Failed to decode image_base64: {exc}") from exc
        elif image_url:
            try:
                import urllib.request
                with urllib.request.urlopen(image_url, timeout=10) as resp:  # noqa: S310
                    img_bytes = resp.read()
                image = Image.open(io.BytesIO(img_bytes)).convert("RGB")
            except Exception as exc:
                raise ValueError(f"Failed to fetch image_url: {exc}") from exc
        else:
            raise ValueError("Either image_url or image_base64 must be provided")

        # ── Encode image ──────────────────────────────────────────────────────
        img_tensor = self._preprocess(image).unsqueeze(0).to(self._device)
        with torch.no_grad():
            img_features = self._model.encode_image(img_tensor)
            img_norm = img_features.norm(dim=-1, keepdim=True)
            img_norm = torch.where(img_norm < 1e-10, torch.ones_like(img_norm), img_norm)
            img_features = img_features / img_norm

        # ── Cosine similarities ───────────────────────────────────────────────
        with torch.no_grad():
            similarity = (img_features @ self._text_features.T).squeeze(0)

        sim_np = similarity.cpu().numpy()

        # Guard against non-finite values
        finite_mask = np.isfinite(sim_np)
        if not np.all(finite_mask):
            logger.warning("[clip_v1] Non-finite similarities detected; clamping to 0")
            sim_np = np.where(finite_mask, sim_np, 0.0)

        # Top-k by similarity
        k = min(top_k, len(VISION_VOCABULARY))
        indices = np.argsort(sim_np)[::-1][:k]
        scores: List[Dict[str, Any]] = []
        for idx in indices:
            score = float(sim_np[idx])
            if not math.isfinite(score):
                score = 0.0
            scores.append({"tag": VISION_VOCABULARY[int(idx)], "score": round(score, 4)})

        tags = [s["tag"] for s in scores]
        return {"tags": sorted(set(tags)), "scores": scores}


# ─────────────────────────────────────────────────────────────────────────────
# cloud_v1 stub — extension point for future cloud providers
# ─────────────────────────────────────────────────────────────────────────────
# To implement cloud_v1:
#   1. Create a CloudV1Backend class with the same interface as above.
#   2. Register it under the "cloud_v1" key in get_backend() below.
#   3. Add required env vars (API_KEY, etc.) and document them.
# Example:
#
#   class CloudV1Backend:
#       name = "cloud_v1"
#       model_id = "gemini-pro-vision"
#       device = "remote"
#       warm = True
#       def describe(self, image_url, image_base64, top_k): ...


# ─────────────────────────────────────────────────────────────────────────────
# Singleton factory
# ─────────────────────────────────────────────────────────────────────────────
_instance: Optional[object] = None


def get_backend() -> Any:
    """
    Return the module-level backend singleton, creating it on first call.

    Reads VISION_BACKEND, VISION_MODEL_ID, DEVICE from environment at call time
    (not at import time) so tests can patch os.environ before calling.

    Raises RuntimeError / NotImplementedError / ValueError on misconfiguration.
    """
    global _instance
    if _instance is not None:
        return _instance

    backend_name = os.getenv("VISION_BACKEND", "clip_v1")
    model_id = os.getenv("VISION_MODEL_ID", "ViT-B-32/openai")
    device = os.getenv("DEVICE", "cpu")

    if backend_name == "rule_v0":
        _instance = RuleV0Backend()
        logger.info("[vision] Backend selected: rule_v0 (no model)")

    elif backend_name == "clip_v1":
        # Fail-fast if open_clip_torch is not installed
        try:
            import open_clip  # noqa: F401
        except ImportError as exc:
            raise RuntimeError(
                "VISION_BACKEND=clip_v1 requires open_clip_torch. "
                "Install it with: pip install open_clip_torch\n"
                "Or switch to the keyword backend: VISION_BACKEND=rule_v0"
            ) from exc
        _instance = ClipV1Backend(model_id=model_id, device=device)
        logger.info("[vision] Backend selected: clip_v1  model=%s  device=%s", model_id, device)

    elif backend_name == "cloud_v1":
        # Extension point reserved for future implementation
        raise NotImplementedError(
            "VISION_BACKEND=cloud_v1 is reserved for a future cloud provider. "
            "Use rule_v0 (offline keywords) or clip_v1 (local CLIP model)."
        )
    else:
        raise ValueError(
            f"Unknown VISION_BACKEND='{backend_name}'. "
            "Supported values: rule_v0, clip_v1"
        )

    return _instance
