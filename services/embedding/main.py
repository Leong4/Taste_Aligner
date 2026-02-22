"""
Embedding Service - Taste Embedding Space (TES) API

FastAPI service for generating deterministic, component-based embeddings.
TES v1: Hash-based placeholder with stable output format.
"""

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
import math
import uvicorn
import logging
from .embedding_core import generate_embedding, build_tes_vector_v2

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

app = FastAPI(title="Taste Aligner Embedding Service")


class EmbeddingData(BaseModel):
    """Input data for embedding generation."""
    vision_tags: Optional[List[str]] = None
    normalized_tags: Optional[List[str]] = None
    emotion: Optional[str] = None
    recency_days: Optional[float] = None


class EmbeddingPayload(BaseModel):
    """Request payload for /generate endpoint."""
    data: EmbeddingData


class ComponentInfo(BaseModel):
    """Component dimension information."""
    vision_dim: int
    tag_dim: int
    scalar_dim: int


class MetaInfo(BaseModel):
    """Metadata about the embedding."""
    version: str
    note: str
    inputs: Dict[str, Any]


class EmbeddingResponse(BaseModel):
    """Response schema for embedding generation."""
    dummy: bool
    model: str
    dim: int
    normalized: bool
    components: ComponentInfo
    vector: List[float]
    meta: MetaInfo


class TesBuildRequest(BaseModel):
    """Request payload for /tes/build endpoint."""
    vision_features: Optional[List[str]] = None
    tags: Optional[List[str]] = None
    sentiment: Optional[float] = None
    recency_days: Optional[float] = None
    location: Optional[str] = None
    normalize: bool = True


@app.get("/health")
async def health_check():
    """Health check endpoint for service monitoring."""
    return {
        "ok": True,
        "service": "embedding"
    }


@app.post("/generate", response_model=EmbeddingResponse)
async def generate_endpoint(payload: EmbeddingPayload):
    """
    Generate Taste Embedding Space (TES) v1 vector.

    Request body:
        {
            "data": {
                "vision_tags": ["ramen", "nightlife"],     // optional
                "normalized_tags": ["ramen", "city_walk"], // optional
                "emotion": "positive",                      // optional
                "recency_days": 3                           // optional
            }
        }

    All fields are optional. Missing fields use neutral defaults.

    Returns:
        {
            "dummy": false,
            "model": "tes-v1-hash",
            "dim": 512,
            "normalized": true,
            "components": {
                "vision_dim": 128,
                "tag_dim": 256,
                "scalar_dim": 128
            },
            "vector": [0.0123, -0.4567, ...],
            "meta": {
                "version": "v1",
                "note": "hash-based placeholder, no dimensionality reduction",
                "inputs": {...}
            }
        }
    """
    logger.info(
        f"POST /generate - vision_tags: {len(payload.data.vision_tags or [])}, "
        f"normalized_tags: {len(payload.data.normalized_tags or [])}"
    )

    try:
        result = generate_embedding(payload, normalize=True)
        logger.info(f"Embedding generated - dim: {result['dim']}")
        return result
    except Exception as e:
        logger.error(f"Error generating embedding: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/tes/build")
async def tes_build_endpoint(payload: TesBuildRequest):
    """
    Build TES v2 vector with strict contract validation.
    """
    try:
        vision_features = [v for v in (payload.vision_features or []) if str(v).strip()]
        tags = [t for t in (payload.tags or []) if str(t).strip()]
        location = (payload.location or "").strip()
        has_any = bool(
            vision_features
            or tags
            or location
            or payload.sentiment is not None
            or payload.recency_days is not None
        )
        if not has_any:
            raise HTTPException(
                status_code=422,
                detail="At least one non-empty input is required for /tes/build"
            )

        if payload.sentiment is not None and not math.isfinite(payload.sentiment):
            raise HTTPException(status_code=422, detail="sentiment must be a finite number")
        if payload.recency_days is not None and not math.isfinite(payload.recency_days):
            raise HTTPException(status_code=422, detail="recency_days must be a finite number")

        result = build_tes_vector_v2(
            vision_features=payload.vision_features,
            tags=payload.tags,
            sentiment=payload.sentiment,
            recency_days=payload.recency_days,
            location=payload.location,
            normalize=payload.normalize
        )
        return result
    except HTTPException:
        raise
    except ValueError as e:
        logger.warning(f"TES v2 validation failed: {e}")
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.error(f"TES v2 build failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    logger.info("Starting Embedding Service on port 5004")
    uvicorn.run(app, host="0.0.0.0", port=5004)
