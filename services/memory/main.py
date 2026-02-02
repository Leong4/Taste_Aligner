"""
Memory Service - Long-term Taste Memory Persistence

FastAPI service for storing and retrieving P5 multimodal memories.
v1: SQLite + cosine similarity + minimal P4 weighting
"""

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, validator
from typing import Optional, List, Dict, Any
import uvicorn
import logging
import math
from datetime import datetime

try:
    from .db import init_database, write_memory, read_memory, load_user_memories, get_database_stats, delete_all_memories
    from .search import search_memories
except ImportError:
    from db import init_database, write_memory, read_memory, load_user_memories, get_database_stats, delete_all_memories
    from search import search_memories

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

app = FastAPI(title="Taste Aligner Memory Service")


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
        f"has_embedding: {payload.data.query_embedding is not None}"
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
