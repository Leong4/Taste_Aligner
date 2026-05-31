"""
Memory Service - Long-term Taste Memory Persistence

FastAPI service for storing and retrieving P5 multimodal memories.
v1: SQLite + cosine similarity + minimal P4 weighting
"""

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, validator
from typing import Optional, List, Dict, Any
import uvicorn
import logging
import math
from datetime import datetime
from pathlib import Path
import base64
import io
import uuid
import re

from .db import init_database, write_memory, read_memory, delete_memory, load_user_memories, get_database_stats, delete_all_memories
from .search import search_memories

try:
    from PIL import Image  # type: ignore
except Exception:
    Image = None

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

app = FastAPI(title="Taste Aligner Memory Service")
UPLOAD_ROOT = Path(__file__).parent / "uploads"
UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
PREVIEW_MAX_WIDTH = 1200
THUMB_MAX_WIDTH = 256
VISION_INPUT_MAX_WIDTH = 1024


def _safe_user_dir(user_id: str) -> Path:
    cleaned = re.sub(r"[^a-zA-Z0-9._-]", "_", user_id or "unknown")
    cleaned = cleaned[:64] if cleaned else "unknown"
    user_dir = UPLOAD_ROOT / cleaned
    user_dir.mkdir(parents=True, exist_ok=True)
    return user_dir


def _memory_asset_dir(user_id: str, memory_id: str) -> Path:
    user_dir = _safe_user_dir(user_id)
    mem_dir = user_dir / memory_id
    mem_dir.mkdir(parents=True, exist_ok=True)
    return mem_dir


def _parse_data_url(data_url: str) -> tuple[str, bytes]:
    if "," not in data_url:
        raise ValueError("invalid_data_url")
    head, payload = data_url.split(",", 1)
    if ";base64" not in head:
        raise ValueError("data_url_must_be_base64")
    mime = "application/octet-stream"
    if head.startswith("data:"):
        mime = head[5:].split(";")[0] or mime
    try:
        content = base64.b64decode(payload, validate=True)
    except Exception as e:
        raise ValueError(f"invalid_base64: {e}") from e
    return mime, content


def _ext_from_mime(mime: str) -> str:
    if mime == "image/png":
        return ".png"
    if mime == "image/webp":
        return ".webp"
    return ".jpg"


def _ensure_rgb(img: "Image.Image") -> "Image.Image":
    if img.mode == "RGBA":
        return img.convert("RGB")
    if img.mode not in ("RGB",):
        return img.convert("RGB")
    return img


def _resize_max_width(img: "Image.Image", max_width: int) -> "Image.Image":
    width = img.width or 1
    if width <= max_width:
        return img
    height = max(1, int(img.height * (float(max_width) / float(width))))
    resampling = getattr(Image, "Resampling", None)
    lanczos = resampling.LANCZOS if resampling is not None else Image.LANCZOS
    return img.resize((max_width, height), lanczos)


def _save_webp_variant(
    src_img: "Image.Image",
    out_path: Path,
    max_width: int,
    quality: int,
) -> None:
    img = _ensure_rgb(src_img)
    img = _resize_max_width(img, max_width)
    img.save(out_path, format="WEBP", quality=quality, method=6)


def _save_image_assets(memory_data: Dict[str, Any]) -> None:
    image_base64 = memory_data.get("image_base64")
    if not isinstance(image_base64, str) or not image_base64.strip():
        return

    if not memory_data.get("memory_id"):
        memory_data["memory_id"] = str(uuid.uuid4())

    mime, content = _parse_data_url(image_base64.strip())
    ext = _ext_from_mime(mime)
    user_id = str(memory_data.get("user_id", "unknown"))
    memory_id = str(memory_data["memory_id"])
    asset_dir = _memory_asset_dir(user_id, memory_id)
    original_abs = asset_dir / f"original{ext}"
    preview_abs = asset_dir / "preview.webp"
    thumb_abs = asset_dir / "thumb.webp"
    vision_input_abs = asset_dir / "vision_input.webp"
    original_abs.write_bytes(content)

    preview_path = original_abs
    thumb_path = original_abs
    vision_input_path = original_abs
    if Image is not None:
        try:
            with Image.open(original_abs) as img:
                _save_webp_variant(img.copy(), preview_abs, PREVIEW_MAX_WIDTH, quality=85)
                preview_path = preview_abs
                _save_webp_variant(img.copy(), thumb_abs, THUMB_MAX_WIDTH, quality=80)
                thumb_path = thumb_abs
                _save_webp_variant(img.copy(), vision_input_abs, VISION_INPUT_MAX_WIDTH, quality=82)
                vision_input_path = vision_input_abs
        except Exception as e:
            logger.warning(f"Failed to generate image variants from original for {memory_id}: {e}")

        vision_input_override = memory_data.get("image_vision_input_base64")
        if isinstance(vision_input_override, str) and vision_input_override.strip():
            try:
                _mime_override, vision_bytes = _parse_data_url(vision_input_override.strip())
                with Image.open(io.BytesIO(vision_bytes)) as img:
                    _save_webp_variant(img.copy(), vision_input_abs, VISION_INPUT_MAX_WIDTH, quality=82)
                    vision_input_path = vision_input_abs
            except Exception as e:
                logger.warning(f"Failed to apply explicit vision_input for {memory_id}: {e}")
    else:
        logger.warning("Pillow unavailable: derived variants fallback to original")

    original_rel = str(original_abs.relative_to(Path(__file__).parent))
    preview_rel = str(preview_path.relative_to(Path(__file__).parent))
    thumb_rel = str(thumb_path.relative_to(Path(__file__).parent))
    vision_rel = str(vision_input_path.relative_to(Path(__file__).parent))

    # Canonical split fields
    memory_data["image_original_path"] = original_rel
    memory_data["image_preview_path"] = preview_rel
    memory_data["image_thumbnail_path"] = thumb_rel
    memory_data["image_vision_input_path"] = vision_rel

    # Legacy compatibility fields
    memory_data["image_path"] = original_rel
    memory_data["thumbnail_path"] = thumb_rel
    memory_data.pop("image_base64", None)
    memory_data.pop("image_vision_input_base64", None)


def _resolve_upload_path(stored_path: str) -> Optional[Path]:
    if not stored_path:
        return None
    base = Path(__file__).parent.resolve()
    candidate = (base / stored_path).resolve()
    upload_root = UPLOAD_ROOT.resolve()
    if not str(candidate).startswith(str(upload_root)):
        return None
    return candidate


def _delete_image_assets(memory: Dict[str, Any]) -> None:
    asset_keys = (
        "image_path",
        "thumbnail_path",
        "image_original_path",
        "image_preview_path",
        "image_thumbnail_path",
        "image_vision_input_path",
    )
    asset_dirs = set()
    for key in asset_keys:
        stored_path = memory.get(key)
        if not isinstance(stored_path, str) or not stored_path.strip():
            continue
        file_path = _resolve_upload_path(stored_path)
        if file_path is None:
            continue
        asset_dirs.add(file_path.parent)
        if file_path.exists():
            file_path.unlink()

    upload_root = UPLOAD_ROOT.resolve()
    for asset_dir in sorted(asset_dirs, key=lambda path: len(path.parts), reverse=True):
        if asset_dir != upload_root and asset_dir.exists():
            asset_dir.rmdir()


# Pydantic Models

class WriteData(BaseModel):
    """Data for writing a memory."""
    user_id: str
    timestamp: Optional[str] = None
    city: Optional[str] = None
    raw_tags: Optional[List[str]] = None
    normalized_tags: Optional[List[str]] = None
    taxonomy: Optional[Dict[str, Any]] = None
    sentiment: Optional[float] = 0.0
    embedding: List[float]
    source: Optional[str] = "unknown"
    memory_id: Optional[str] = None
    image_path: Optional[str] = None
    thumbnail_path: Optional[str] = None
    image_original_path: Optional[str] = None
    image_preview_path: Optional[str] = None
    image_thumbnail_path: Optional[str] = None
    image_vision_input_path: Optional[str] = None
    caption_text: Optional[str] = None
    vision_type: Optional[str] = None
    # Upload-only transient field: used to persist image to local storage.
    image_base64: Optional[str] = None
    image_vision_input_base64: Optional[str] = None
    image_url: Optional[str] = None

    @validator('embedding')
    def validate_embedding(cls, v):
        if len(v) != 512:
            raise ValueError(f"Embedding must be 512 dimensions, got {len(v)}")

        # Check L2 normalization
        norm = math.sqrt(sum(x * x for x in v))
        if not (0.98 <= norm <= 1.02):
            raise ValueError(f"Embedding must be L2 normalized (norm ≈ 1.0), got {norm:.4f}")

        return v


class WritePayload(BaseModel):
    """Request payload for /write endpoint."""
    data: WriteData


class SearchData(BaseModel):
    """Data for searching memories."""
    user_id: str
    query_embedding: Optional[List[float]] = None
    query_tags: Optional[List[str]] = None
    top_k: Optional[int] = 10
    city: Optional[str] = None
    now_ts: Optional[str] = None
    memory_pool: Optional[str] = None


class SearchPayload(BaseModel):
    """Request payload for /search endpoint."""
    data: SearchData


# Endpoints

@app.on_event("startup")
async def startup_event():
    """Initialize database on startup."""
    init_database()
    logger.info("Memory Service started on port 5001")


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    stats = get_database_stats()
    return {
        "ok": True,
        "service": "memory",
        "stats": stats
    }


@app.post("/write")
async def write_endpoint(payload: WritePayload):
    """
    Write a P5 memory to the database.

    Request body:
        {
            "data": {
                "user_id": "u001",
                "timestamp": "2024-01-01T10:00:00Z",  // optional
                "city": "london",                      // optional
                "raw_tags": ["ramen", "nightlife"],    // optional
                "normalized_tags": ["ramen", ...],     // optional
                "taxonomy": {...},                     // optional
                "sentiment": 0.8,                      // optional, range [-1, 1]
                "embedding": [512 floats],             // REQUIRED, L2 normalized
                "source": "embedding_v1",              // optional
                "memory_id": "..."                     // optional, auto-generated if missing
            }
        }

    Returns:
        {
            "ok": true,
            "memory_id": "...",
            "written": {...}
        }
    """
    logger.info(f"POST /write - user_id: {payload.data.user_id}")

    try:
        # Convert Pydantic model to dict
        memory_data = payload.data.dict()
        _save_image_assets(memory_data)
        memory_data.pop("image_url", None)

        # Write to database
        result = write_memory(memory_data)

        logger.info(f"Memory written: {result['memory_id']}")
        return result

    except ValueError as e:
        logger.error(f"Validation error: {e}")
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.error(f"Error writing memory: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/read/{memory_id}")
async def read_endpoint(memory_id: str):
    """
    Read a single memory by ID.

    Args:
        memory_id: Memory ID

    Returns:
        Memory dict or 404 if not found
    """
    logger.info(f"GET /read/{memory_id}")

    memory = read_memory(memory_id)

    if not memory:
        raise HTTPException(status_code=404, detail=f"Memory {memory_id} not found")

    return memory


@app.delete("/memories/{memory_id}")
async def delete_endpoint(memory_id: str):
    """Delete a single memory and its associated image files."""
    logger.info(f"DELETE /memories/{memory_id}")
    memory = read_memory(memory_id)
    if not memory:
        raise HTTPException(status_code=404, detail=f"Memory {memory_id} not found")

    try:
        _delete_image_assets(memory)
        delete_memory(memory_id)
        return {"ok": True, "memory_id": memory_id}
    except Exception as e:
        logger.error(f"Error deleting memory {memory_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


def _variant_candidates(memory: Dict[str, Any], variant: str) -> List[str]:
    if variant == "original":
        return ["image_original_path", "image_path"]
    if variant == "preview":
        return ["image_preview_path", "image_thumbnail_path", "thumbnail_path", "image_original_path", "image_path"]
    if variant == "vision_input":
        return ["image_vision_input_path", "image_preview_path", "image_thumbnail_path", "thumbnail_path", "image_original_path", "image_path"]
    # default thumb
    return ["image_thumbnail_path", "thumbnail_path", "image_preview_path", "image_original_path", "image_path"]


@app.get("/files/{memory_id}")
async def read_memory_file(
    memory_id: str,
    variant: str = Query("thumb", regex="^(thumb|preview|original|vision_input)$"),
):
    """
    Return memory thumbnail (preferred) or original upload file.
    """
    logger.info(f"GET /files/{memory_id}?variant={variant}")
    memory = read_memory(memory_id)
    if not memory:
        raise HTTPException(status_code=404, detail=f"Memory {memory_id} not found")

    for key in _variant_candidates(memory, variant):
        stored = memory.get(key)
        if not isinstance(stored, str) or not stored.strip():
            continue
        file_path = _resolve_upload_path(stored)
        if file_path is None or not file_path.exists():
            continue
        media_type = "application/octet-stream"
        suffix = file_path.suffix.lower()
        if suffix in (".jpg", ".jpeg"):
            media_type = "image/jpeg"
        elif suffix == ".png":
            media_type = "image/png"
        elif suffix == ".webp":
            media_type = "image/webp"
        return FileResponse(str(file_path), media_type=media_type)

    raise HTTPException(status_code=404, detail=f"No file assets for memory {memory_id}")


@app.post("/search")
async def search_endpoint(payload: SearchPayload):
    """
    Search memories with cosine similarity + P4 weighting.

    Request body:
        {
            "data": {
                "user_id": "u001",                    // REQUIRED
                "query_embedding": [512 floats],      // optional (primary method)
                "query_tags": ["ramen"],              // optional (fallback)
                "top_k": 10,                          // optional, default 10
                "city": "london",                     // optional (for city boost)
                "now_ts": "2024-01-10T00:00:00Z"      // optional (for time decay)
            }
        }

    At least one of query_embedding or query_tags must be provided.

    Returns:
        {
            "dummy": false,
            "results": [
                {
                    "memory_id": "...",
                    "score": 0.123,         // final weighted score
                    "sim": 0.456,           // base cosine similarity
                    "w_time": 0.91,         // time decay weight
                    "w_sent": 1.4,          // sentiment boost
                    "w_city": 1.2,          // city match boost
                    "timestamp": "...",
                    "city": "...",
                    "normalized_tags": [...],
                    "sentiment": 0.8
                }
            ]
        }
    """
    logger.info(
        f"POST /search - user_id: {payload.data.user_id}, "
        f"top_k: {payload.data.top_k}, "
        f"has_embedding: {payload.data.query_embedding is not None}, "
        f"memory_pool: {payload.data.memory_pool or 'all'}"
    )

    # Validate inputs
    if not payload.data.query_embedding and not payload.data.query_tags:
        raise HTTPException(
            status_code=422,
            detail="Either query_embedding or query_tags must be provided"
        )

    # Default now_ts to current time if not provided
    now_ts = payload.data.now_ts
    if not now_ts:
        now_ts = datetime.utcnow().isoformat() + "Z"

    try:
        # Load all memories for the user
        memories = load_user_memories(payload.data.user_id)

        if not memories:
            logger.info(f"No memories found for user {payload.data.user_id}")
            return {
                "dummy": False,
                "results": []
            }

        # Search with cosine similarity + P4 weighting
        results = search_memories(
            memories=memories,
            query_embedding=payload.data.query_embedding,
            query_tags=payload.data.query_tags,
            query_city=payload.data.city,
            now_ts=now_ts,
            memory_pool=payload.data.memory_pool,
            top_k=payload.data.top_k
        )

        logger.info(f"Search returned {len(results)} results")

        return {
            "dummy": False,
            "results": results
        }

    except Exception as e:
        logger.error(f"Error searching memories: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================
# DEVELOPMENT ONLY ENDPOINTS
# ============================================================

@app.post("/debug/reset")
async def debug_reset_endpoint():
    """
    🔥 DEVELOPMENT ONLY - Delete all memories from database 🔥

    WARNING: This endpoint is for testing and development ONLY.
    It permanently deletes ALL memories from the database.
    NEVER expose this endpoint in production environments.

    Usage:
        curl -X POST http://localhost:5001/debug/reset

    Returns:
        {
            "ok": true,
            "deleted_count": 123,
            "remaining_count": 0,
            "warning": "All memories deleted - DEVELOPMENT ONLY"
        }
    """
    logger.warning("🔥 POST /debug/reset - Deleting all memories (DEV ONLY)")

    try:
        result = delete_all_memories()

        return {
            **result,
            "warning": "All memories deleted - DEVELOPMENT ONLY"
        }

    except Exception as e:
        logger.error(f"Error in debug reset: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    logger.info("Starting Memory Service on port 5001")
    uvicorn.run(app, host="0.0.0.0", port=5001)
