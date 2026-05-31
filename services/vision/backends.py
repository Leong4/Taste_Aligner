"""
Vision backends for the Taste Aligner Vision Service.

Supported backends:
  clip_v1   - CLIP-based image understanding (open_clip_torch, local model)
  cloud_v1  - OpenAI Responses API image understanding
  hybrid    - CLIP first, with cloud fallback for weak or ambiguous results

Rule-based vision backends are intentionally removed. Vision inference comes
from CLIP locally or the OpenAI Responses API.
"""

from __future__ import annotations

import base64
import io
import json
import math
import os
import re
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Sequence, Tuple

from PIL import Image

import logging

logger = logging.getLogger(__name__)


# Vocabulary includes required semantic probes for food/scenery typing.
VISION_VOCABULARY: List[str] = [
    "food",
    "dish",
    "restaurant",
    "seafood",
    "beach",
    "seaside",
    "coast",
    "landscape",
    "architecture",
    "cityscape",
    "mountain",
    "nature",
    # Additional taste-friendly labels
    "ramen",
    "sushi",
    "izakaya",
    "cafe",
    "coffee",
    "dessert",
    "pastry",
    "street_food",
    "noodles",
    "rice",
    "temple",
    "shrine",
    "museum",
    "art",
    "culture",
    "garden",
    "park",
    "lake",
    "forest",
    "outdoor",
    "urban",
    "modern",
    "night_market",
    "market",
]

FOOD_LABELS: frozenset[str] = frozenset({
    "food",
    "dish",
    "restaurant",
    "seafood",
    "ramen",
    "sushi",
    "izakaya",
    "cafe",
    "coffee",
    "dessert",
    "pastry",
    "street_food",
    "noodles",
    "rice",
})

SCENERY_LABELS: frozenset[str] = frozenset({
    "beach",
    "seaside",
    "coast",
    "landscape",
    "architecture",
    "cityscape",
    "mountain",
    "nature",
    "temple",
    "shrine",
    "museum",
    "art",
    "culture",
    "garden",
    "park",
    "lake",
    "forest",
    "outdoor",
    "urban",
})

CAPTION_STOPWORDS: frozenset[str] = frozenset({
    "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with",
    "my", "your", "our", "their", "this", "that", "these", "those", "is",
    "are", "was", "were", "be", "been", "being", "it", "its", "at", "from",
    "as", "by", "about", "into", "over", "after", "before", "through",
    "during", "without", "under", "again", "further", "then", "once",
    "so", "very", "really", "just", "such", "want", "love", "like",
})

CAPTION_PHRASES: Sequence[Tuple[str, str]] = (
    ("spanish food", "spanish food"),
    ("sea side", "seaside"),
    ("city skyline", "cityscape"),
    ("night market", "night market"),
)


def _safe_score(score: float) -> float:
    if not isinstance(score, (int, float)) or not math.isfinite(float(score)):
        return 0.0
    return float(score)


def _score01(score: float) -> float:
    return max(0.0, min(1.0, (_safe_score(score) + 1.0) / 2.0))


def _dedup_keep_order(values: Sequence[str]) -> List[str]:
    out: List[str] = []
    seen: set[str] = set()
    for raw in values:
        if not isinstance(raw, str):
            continue
        cleaned = raw.strip().lower()
        if not cleaned or cleaned in seen:
            continue
        seen.add(cleaned)
        out.append(cleaned)
    return out


def _extract_caption_terms(caption_text: Optional[str]) -> List[str]:
    if not isinstance(caption_text, str) or not caption_text.strip():
        return []
    caption = caption_text.strip().lower()
    phrases: List[str] = []
    for needle, tag in CAPTION_PHRASES:
        if needle in caption:
            phrases.append(tag)

    tokens = re.findall(r"[a-z][a-z0-9_-]{2,}", caption)
    nouns: List[str] = []
    for tok in tokens:
        if tok in CAPTION_STOPWORDS:
            continue
        nouns.append(tok.replace("_", " "))
    return _dedup_keep_order([*phrases, *nouns])[:8]


def _classify_vision_type(scores: Sequence[Dict[str, Any]]) -> str:
    # Use the strongest score per pool, then compare with a fixed margin.
    food_best = max((_safe_score(s.get("score", 0.0)) for s in scores if s.get("tag") in FOOD_LABELS), default=-1.0)
    scenery_best = max((_safe_score(s.get("score", 0.0)) for s in scores if s.get("tag") in SCENERY_LABELS), default=-1.0)
    best = max(food_best, scenery_best)
    if best < 0.05:
        return "other"
    if food_best >= scenery_best + 0.03:
        return "food"
    if scenery_best >= food_best + 0.03:
        return "scenery"
    return "other"


def _decode_image_bytes(image_base64: str) -> bytes:
    raw = image_base64.strip()
    # Accept both raw base64 and data URL payloads.
    if raw.startswith("data:"):
        if "," not in raw:
            raise ValueError("invalid_data_url")
        _head, raw = raw.split(",", 1)
    try:
        return base64.b64decode(raw, validate=True)
    except Exception as exc:
        raise ValueError(f"Failed to decode image_base64: {exc}") from exc


class ClipV1Backend:
    """CLIP-based zero-shot image tagging backend."""

    name: str = "clip_v1"

    def __init__(self, model_id: str, device: str) -> None:
        self._model_id = model_id
        self._device = device
        parts = model_id.split("/", 1)
        self._arch = parts[0]
        self._pretrained = parts[1] if len(parts) > 1 else "openai"
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

        logger.info("[clip_v1] Loading CLIP model: %s on %s", self._model_id, self._device)
        parts = self._model_id.split("/", 1)
        arch = parts[0]
        pretrained = parts[1] if len(parts) > 1 else "openai"
        try:
            model, _, preprocess = open_clip.create_model_and_transforms(
                arch,
                pretrained=pretrained,
                device=self._device,
            )
        except Exception as exc:
            raise RuntimeError(f"Failed to load CLIP model '{self._model_id}': {exc}") from exc

        tokenizer = open_clip.get_tokenizer(arch)
        model.eval()

        prompts = [f"a photo of {tag.replace('_', ' ')}" for tag in VISION_VOCABULARY]
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
        self._ensure_loaded()

    def describe(
        self,
        image_url: Optional[str],
        image_base64: Optional[str],
        top_k: int,
        caption_text: Optional[str] = None,
    ) -> Dict[str, Any]:
        self._ensure_loaded()

        import numpy as np
        import torch
        import urllib.request

        if image_base64:
            image_bytes = _decode_image_bytes(image_base64)
            try:
                image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
            except Exception as exc:
                raise ValueError(f"Failed to parse decoded image bytes: {exc}") from exc
        elif image_url:
            try:
                with urllib.request.urlopen(image_url, timeout=10) as resp:  # noqa: S310
                    image = Image.open(io.BytesIO(resp.read())).convert("RGB")
            except Exception as exc:
                raise ValueError(f"Failed to fetch image_url: {exc}") from exc
        else:
            raise ValueError("Either image_url or image_base64 must be provided")

        img_tensor = self._preprocess(image).unsqueeze(0).to(self._device)
        with torch.no_grad():
            img_features = self._model.encode_image(img_tensor)
            img_norm = img_features.norm(dim=-1, keepdim=True)
            img_norm = torch.where(img_norm < 1e-10, torch.ones_like(img_norm), img_norm)
            img_features = img_features / img_norm
            similarity = (img_features @ self._text_features.T).squeeze(0)

        sim_np = similarity.detach().cpu().numpy()
        finite_mask = np.isfinite(sim_np)
        if not np.all(finite_mask):
            logger.warning("[clip_v1] Non-finite similarities detected; clamping to 0")
            sim_np = np.where(finite_mask, sim_np, 0.0)

        k = max(1, min(int(top_k), len(VISION_VOCABULARY)))
        indices = np.argsort(sim_np)[::-1][:k]
        scores: List[Dict[str, Any]] = []
        for idx in indices:
            tag = VISION_VOCABULARY[int(idx)]
            score = round(_safe_score(float(sim_np[idx])), 4)
            scores.append({"tag": tag, "score": score})

        clip_cues = [entry["tag"] for entry in scores[:8]]
        caption_terms = _extract_caption_terms(caption_text)
        merged_tags = _dedup_keep_order([*clip_cues, *caption_terms, *(entry["tag"] for entry in scores)])
        if not merged_tags:
            merged_tags = [scores[0]["tag"]] if scores else ["image"]
        tags = merged_tags[:5]
        cues = _dedup_keep_order([*clip_cues, *caption_terms])[:20]
        vision_type = _classify_vision_type(scores)

        top1 = _score01(scores[0]["score"]) if scores else 0.0
        top2 = _score01(scores[1]["score"]) if len(scores) > 1 else 0.0
        confidence = round(max(0.0, min(1.0, (0.8 * top1) + (0.2 * abs(top1 - top2)))), 4)

        return {
            "tags": tags,
            "scores": scores,
            "cues": cues,
            "type": vision_type,
            "vision_type": vision_type,
            "confidence": confidence,
            "model": {"name": self._arch, "pretrained": self._pretrained},
        }


class HybridV1Backend(ClipV1Backend):
    """CLIP-first backend; cloud escalation is handled by the service route."""

    name: str = "hybrid"


class CloudV1Backend:
    """OpenAI Responses API image understanding backend."""

    name: str = "cloud_v1"

    def __init__(self) -> None:
        self._model_id = os.getenv("OPENAI_VISION_MODEL", "gpt-4o")

    @property
    def model_id(self) -> str:
        return self._model_id

    @property
    def device(self) -> str:
        return "remote"

    @property
    def warm(self) -> bool:
        return True

    def describe(
        self,
        image_url: Optional[str],
        image_base64: Optional[str],
        top_k: int,
        caption_text: Optional[str] = None,
    ) -> Dict[str, Any]:
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError("OPENAI_API_KEY is required for cloud_v1")

        if image_base64:
            cloud_image_url = image_base64.strip()
            if not cloud_image_url.startswith("data:"):
                cloud_image_url = f"data:image/jpeg;base64,{cloud_image_url}"
        elif image_url:
            cloud_image_url = image_url.strip()
        else:
            raise ValueError("Either image_url or image_base64 must be provided")

        caption = caption_text.strip() if isinstance(caption_text, str) else ""
        prompt = (
            "Analyze this travel photo for a personalized recommendation memory. "
            "Return concise lowercase tags and visual cues. Prefer specific concepts "
            "such as cuisine, landmark type, architecture style, landscape, activity, "
            "and atmosphere over generic labels. Use vision_type food, scenery, other, "
            "or unknown. Scores and confidence must be numbers from 0 to 1. "
            "Also score the user's caption sentiment from 0.0 to 1.0, where 0.0 is very "
            "negative, 0.5 is neutral, and 1.0 is very positive. Use approximately 0.55 "
            "for 'just so so...but it is interesting', 0.85 for 'nice!!', 0.80 for "
            "'beautiful place', and 0.10 for 'terrible'."
        )
        if caption:
            prompt += f"\nUser caption: {caption}"
        else:
            prompt += "\nNo user caption was provided. Return sentiment 0.5 exactly."

        schema = {
            "type": "object",
            "properties": {
                "tags": {"type": "array", "items": {"type": "string"}},
                "cues": {"type": "array", "items": {"type": "string"}},
                "vision_type": {
                    "type": "string",
                    "enum": ["food", "scenery", "other", "unknown"],
                },
                "confidence": {"type": "number"},
                "sentiment": {"type": "number", "minimum": 0.0, "maximum": 1.0},
                "scores": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "tag": {"type": "string"},
                            "score": {"type": "number"},
                        },
                        "required": ["tag", "score"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["tags", "cues", "vision_type", "confidence", "sentiment", "scores"],
            "additionalProperties": False,
        }
        payload = {
            "model": self._model_id,
            "input": [
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": prompt},
                        {"type": "input_image", "image_url": cloud_image_url},
                    ],
                }
            ],
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "taste_aligner_vision",
                    "strict": True,
                    "schema": schema,
                }
            },
        }
        request = urllib.request.Request(
            "https://api.openai.com/v1/responses",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
                response_payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"OpenAI Responses API error {exc.code}: {detail[:500]}") from exc
        except Exception as exc:
            raise RuntimeError(f"OpenAI Responses API request failed: {exc}") from exc

        output_text = self._extract_output_text(response_payload)
        try:
            result = json.loads(output_text)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"OpenAI Responses API returned invalid JSON: {exc}") from exc

        tags = _dedup_keep_order(result.get("tags", []))[:5]
        cues = _dedup_keep_order(result.get("cues", []))[:10]
        vision_type = result.get("vision_type", "unknown")
        if vision_type not in ("food", "scenery", "other", "unknown"):
            vision_type = "unknown"
        confidence = round(max(0.0, min(1.0, _safe_score(result.get("confidence", 0.0)))), 4)
        sentiment = (
            0.5
            if not caption
            else round(max(0.0, min(1.0, _safe_score(result.get("sentiment", 0.5)))), 4)
        )

        scores: List[Dict[str, Any]] = []
        for entry in result.get("scores", []):
            if not isinstance(entry, dict) or not isinstance(entry.get("tag"), str):
                continue
            scores.append({
                "tag": entry["tag"].strip().lower(),
                "score": round(max(0.0, min(1.0, _safe_score(entry.get("score", 0.0)))), 4),
            })
        if not scores:
            scores = [{"tag": tag, "score": confidence} for tag in tags]

        return {
            "tags": tags,
            "scores": scores[:max(1, min(int(top_k), 50))],
            "cues": cues,
            "type": vision_type,
            "vision_type": vision_type,
            "confidence": confidence,
            "sentiment": sentiment,
            "model": {"name": self._model_id, "pretrained": None},
        }

    @staticmethod
    def _extract_output_text(response_payload: Dict[str, Any]) -> str:
        for item in response_payload.get("output", []):
            if not isinstance(item, dict):
                continue
            for content in item.get("content", []):
                if not isinstance(content, dict):
                    continue
                if content.get("type") == "refusal":
                    raise RuntimeError(f"OpenAI Responses API refused image analysis: {content.get('refusal', '')}")
                if content.get("type") == "output_text" and isinstance(content.get("text"), str):
                    return content["text"]
        raise RuntimeError("OpenAI Responses API response did not contain output_text")


_instance: Optional[Any] = None


def get_backend() -> Any:
    """
    Return the module-level backend singleton, creating it on first call.

    Reads VISION_BACKEND, VISION_MODEL_ID, DEVICE, and OPENAI_VISION_MODEL from
    environment at call time so tests can patch os.environ before calling.
    """
    global _instance
    if _instance is not None:
        return _instance

    backend_name = os.getenv("VISION_BACKEND", "clip_v1")
    model_id = os.getenv("VISION_MODEL_ID", "ViT-B-32/openai")
    device = os.getenv("DEVICE", "cpu")

    if backend_name in ("clip_v1", "hybrid"):
        try:
            import open_clip  # noqa: F401
        except ImportError as exc:
            raise RuntimeError(
                f"VISION_BACKEND={backend_name} requires open_clip_torch. "
                "Install it with: pip install open_clip_torch"
            ) from exc
        backend_class = HybridV1Backend if backend_name == "hybrid" else ClipV1Backend
        _instance = backend_class(model_id=model_id, device=device)
        logger.info("[vision] Backend selected: %s  model=%s  device=%s", backend_name, model_id, device)
        return _instance

    if backend_name == "cloud_v1":
        _instance = CloudV1Backend()
        logger.info("[vision] Backend selected: cloud_v1  model=%s", _instance.model_id)
        return _instance

    raise ValueError(
        f"Unknown VISION_BACKEND='{backend_name}'. Supported values: clip_v1, cloud_v1, hybrid"
    )
