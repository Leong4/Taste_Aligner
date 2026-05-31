"""
Vision Service v2 — CLIP and cloud-backed image description API.

Backends (set via VISION_BACKEND env var):
  clip_v1  — local CLIP model via open_clip_torch (default)
  cloud_v1 — OpenAI Responses API image understanding
  hybrid   — CLIP first, with cloud replacement for weak or ambiguous results

Environment:
  VISION_BACKEND   clip_v1 | cloud_v1 | hybrid (default: clip_v1)
  VISION_MODEL_ID  open_clip model identifier (default: ViT-B-32/openai)
  OPENAI_VISION_MODEL OpenAI vision model     (default: gpt-4o)
  OPENAI_API_KEY    OpenAI API key             (required for cloud_v1 / hybrid fallback)
  DEVICE           cpu | cuda                 (default: cpu)

Output contract (/describe):
  {
    "ok": true,
    "backend": "clip_v1",
    "vision_type": "food",
    "model_id": "ViT-B-32/openai",
    "device": "cpu",
    "confidence": 0.84,
    "tags": ["ramen", "night_market", ...],
    "raw": { "scores": [{"tag": "...", "score": 0.12}, ...] },
    "meta": { "inputs": {"has_url": true, "has_base64": false, "top_k": 10},
              "latency_ms": 42.1 }
  }

All returned numeric values are guaranteed to be finite JSON numbers.
"""

import math
import time
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional, List, Dict, Any, Literal

from .backends import CloudV1Backend, get_backend

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Startup: eagerly initialise backend for fail-fast behaviour
# ─────────────────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(_app: FastAPI):
    try:
        b = get_backend()
        logger.info(
            "[vision] Backend ready: %s  model_id=%s  device=%s",
            b.name, b.model_id, b.device,
        )
        # For clip_v1, trigger model load at startup so the first request is fast
        if hasattr(b, "warm_up"):
            b.warm_up()
    except Exception as exc:
        logger.error("[vision] Backend initialisation FAILED: %s", exc)
        raise
    yield


app = FastAPI(title="Taste Aligner Vision Service v2", lifespan=lifespan)


# ─────────────────────────────────────────────────────────────────────────────
# Request / Response models
# ─────────────────────────────────────────────────────────────────────────────
class ImageData(BaseModel):
    image_url: Optional[str] = None
    image_base64: Optional[str] = None
    caption_text: Optional[str] = None
    top_k: Optional[int] = 10


class DescribeRequest(BaseModel):
    data: ImageData


class ScoreEntry(BaseModel):
    tag: str
    score: float


class RawOutput(BaseModel):
    scores: List[ScoreEntry]


class VisionMeta(BaseModel):
    inputs: Dict[str, Any]
    latency_ms: float


class VisionModelInfo(BaseModel):
    """Stable model identity fields for deterministic trace evidence."""
    name: Optional[str] = None
    pretrained: Optional[str] = None


class VisionResponse(BaseModel):
    ok: bool
    backend: str
    # V1 structured schema: type + sorted/capped cues for downstream TES
    type: Literal["food", "scenery", "other", "unknown"] = "unknown"
    vision_type: Literal["food", "scenery", "other", "unknown"] = "unknown"
    cues: List[str] = []
    confidence: float = 0.0
    sentiment: float = 0.5
    model: Optional[VisionModelInfo] = None
    # Legacy fields retained for backward compatibility
    model_id: Optional[str] = None
    device: str
    tags: List[str]
    raw: RawOutput
    meta: VisionMeta


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────
def _guard_finite(scores: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Replace non-finite score values so the JSON output is always valid."""
    guarded = []
    for entry in scores:
        score = entry.get("score", 0.0)
        if not isinstance(score, (int, float)) or not math.isfinite(float(score)):
            score = 0.0
        guarded.append({"tag": str(entry["tag"]), "score": round(float(score), 4)})
    return guarded


# ─────────────────────────────────────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────────────────────────────────────
@app.get("/health")
async def health_check() -> Dict[str, Any]:
    """Return backend identity and warm state for health monitoring."""
    b = get_backend()
    return {
        "ok": True,
        "service": "vision",
        "backend": b.name,
        "model_id": b.model_id,
        "device": b.device,
        "warm": b.warm,
    }


@app.post("/describe", response_model=VisionResponse)
async def describe_endpoint(req: DescribeRequest) -> VisionResponse:
    """
    Analyse an image and return normalised tags for downstream TES enrichment.

    Request:
        { "data": { "image_url": "...", "image_base64": "...", "top_k": 10 } }
    At least one of image_url / image_base64 is required.

    Returns: see module docstring for full schema.
    All numbers in the response are guaranteed to be finite JSON values.
    """
    data = req.data

    if not data.image_url and not data.image_base64:
        raise HTTPException(
            status_code=422,
            detail="Either data.image_url or data.image_base64 must be provided",
        )

    top_k = max(1, min(int(data.top_k or 10), 50))  # clamp [1, 50]
    b = get_backend()
    response_backend = b.name
    response_model_id = b.model_id
    response_device = b.device
    started = time.monotonic()

    try:
        result = b.describe(
            image_url=data.image_url,
            image_base64=data.image_base64,
            top_k=top_k,
            caption_text=data.caption_text,
        )
        if b.name == "hybrid":
            try:
                cloud = CloudV1Backend()
                cloud_result = cloud.describe(
                    image_url=data.image_url,
                    image_base64=data.image_base64,
                    top_k=top_k,
                    caption_text=data.caption_text,
                )
                result = cloud_result
                response_model_id = cloud.model_id
                response_device = cloud.device
            except Exception as exc:
                logger.warning("[vision] cloud_v1 fallback failed; using clip_v1 result: %s", exc)
    except ValueError as exc:
        logger.warning("[vision] describe ValueError: %s", exc)
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        logger.error("[vision] describe error: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))

    latency_ms = (time.monotonic() - started) * 1000

    raw_tags: List[str] = [str(t) for t in result.get("tags", []) if t]
    scores: List[Dict[str, Any]] = _guard_finite(result.get("scores", []))

    # V1 structured fields: cues (sorted, capped), type, model
    raw_cues = result.get("cues")
    cues: List[str] = raw_cues[:20] if isinstance(raw_cues, list) else sorted(set(raw_tags))[:20]
    raw_vision_type = result.get("vision_type", result.get("type", "unknown"))
    vision_type: str = (
        raw_vision_type if raw_vision_type in ("food", "scenery", "other", "unknown") else "unknown"
    )
    confidence_raw = result.get("confidence", 0.0)
    confidence = (
        float(confidence_raw)
        if isinstance(confidence_raw, (int, float)) and math.isfinite(float(confidence_raw))
        else 0.0
    )
    sentiment_raw = result.get("sentiment", 0.5)
    sentiment = (
        float(sentiment_raw)
        if isinstance(sentiment_raw, (int, float)) and math.isfinite(float(sentiment_raw))
        else 0.5
    )
    raw_model = result.get("model")
    model_info = VisionModelInfo(**raw_model) if isinstance(raw_model, dict) else None

    logger.info(
        "[vision] describe OK: backend=%s type=%s cues=%d tags=%d latency=%.1fms",
        response_backend, vision_type, len(cues), len(raw_tags), latency_ms,
    )

    return VisionResponse(
        ok=True,
        backend=response_backend,
        type=vision_type,
        vision_type=vision_type,
        cues=cues,
        confidence=round(max(0.0, min(1.0, confidence)), 4),
        sentiment=round(max(0.0, min(1.0, sentiment)), 4),
        model=model_info,
        model_id=response_model_id,
        device=response_device,
        tags=raw_tags,
        raw=RawOutput(scores=[ScoreEntry(**s) for s in scores]),
        meta=VisionMeta(
            inputs={
                "has_url": bool(data.image_url),
                "has_base64": bool(data.image_base64),
                "top_k": top_k,
            },
            latency_ms=round(latency_ms, 1),
        ),
    )


if __name__ == "__main__":
    import uvicorn
    logger.info("Starting Vision Service on port 5002")
    uvicorn.run(app, host="0.0.0.0", port=5002)
