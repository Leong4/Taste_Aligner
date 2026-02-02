"""
Vision Service - Image Analysis API

FastAPI service for analyzing images and extracting tags.
Vision v1: Rule-based keyword extraction (no external API calls).
"""

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional, Dict, Any, List
import uvicorn
import logging
from .vision_core import describe_image

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

app = FastAPI(title="Taste Aligner Vision Service")


class ImageData(BaseModel):
    """Image data for analysis."""
    image_url: Optional[str] = None
    image_base64: Optional[str] = None


class DescribePayload(BaseModel):
    """Request payload for /describe endpoint."""
    data: ImageData


class VisionResponse(BaseModel):
    """Response schema for vision analysis."""
    dummy: bool
    source: str
    raw_tags: List[str]
    style_tags: List[str]
    scene_tags: List[str]
    confidence: Dict[str, float]
    meta: Dict[str, Any]


@app.get("/health")
async def health_check():
    """Health check endpoint for service monitoring."""
    return {
        "ok": True,
        "service": "vision"
    }


@app.post("/describe", response_model=VisionResponse)
async def describe_endpoint(payload: DescribePayload):
    """
    Analyze image and return tags with confidence scores.

    Vision v1: Rule-based keyword extraction from image_url or image_base64.

    Request body:
        {
            "data": {
                "image_url": "http://example.com/image.jpg",  // optional
                "image_base64": "base64_string_here"          // optional
            }
        }

    At least one of image_url or image_base64 must be provided.

    Returns:
        {
            "dummy": false,
            "source": "rule",
            "raw_tags": ["tag1", "tag2", ...],
            "style_tags": ["style1", ...],
            "scene_tags": ["scene1", ...],
            "confidence": {"tag1": 0.92, "tag2": 0.88, ...},
            "meta": {
                "received": {
                    "image_url": "...",
                    "has_image_base64": true/false
                }
            }
        }
    """
    # Log request
    logger.info(f"POST /describe - URL: {bool(payload.data.image_url)}, Base64: {bool(payload.data.image_base64)}")

    # Validate input
    if not payload.data.image_url and not payload.data.image_base64:
        logger.warning("Request missing both image_url and image_base64")
        raise HTTPException(
            status_code=422,
            detail="Either image_url or image_base64 must be provided"
        )

    # Process request
    try:
        result = describe_image(payload)
        logger.info(f"Vision analysis complete - {len(result.get('raw_tags', []))} tags detected")
        return result
    except Exception as e:
        logger.error(f"Error processing vision request: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    logger.info("Starting Vision Service on port 5002")
    uvicorn.run(app, host="0.0.0.0", port=5002)
