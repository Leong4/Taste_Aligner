"""
Recommendation Service v1.3 - Agent-friendly, Explainable, Configurable

Two-stage architecture:
  1. RECALL: Maximize recall with cheap rules (BOTH CZ and EZ city-strict)
  2. RERANK: Score CZ/EZ with explainability (item-discriminative memory_influence)

v1.3 Changes:
- EZ diversity rerank for tags=[]
- Embedding-based memory influence (item-discriminative)
- Item embedding cache (SQLite)

v1.2 Changes:
- EZ is now city-strict (no cross-city recommendations)
- Title sanitization for semantic consistency
- Enhanced item-discriminative memory_influence with local tag fallback
- Stronger EZ exploration emphasis (ν=0.8, SIM_CAP=0.7)

v1.1 Changes:
- SQLite persistence for dataset
- CZ candidates are city-only (no cross-city leak)
- EZ never empty (excellence fallback)
- memory_influence is item-dependent (calls Memory Service)
- EZ scoring with taste_distance and similarity cap
- Controllable mix policy via intent and memory_confidence

Agent-friendly design:
  - Simple semantic input (user_id, city, tags)
  - Optional intent and memory_confidence for mix policy control
  - Structured explainable output
  - Separated CZ/EZ zones for Planner consumption

Port: 5005
"""

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any
import uvicorn
import logging
import uuid

try:
    from .recall import recall_candidates
    from .rerank import rerank_candidates
    from .mix_policy import compute_mix_policy
    from .db import get_database_stats, sanitize_titles_in_db, ensure_item_embeddings_table
    from .config import (
        CZ_ALPHA, CZ_BETA, CZ_GAMMA,
        EZ_MU, EZ_NU, SIM_CAP,
        T_HIGH, T_MID,
        RECALL_EZ_EXCELLENCE_THRESHOLD,
        TOP_K_CZ, TOP_K_EZ,
        RECO_DB_PATH,
        RECO_SERVICE_VERSION,
        MEM_INFLUENCE_MODE,
        EMBEDDING_URL
    )
except ImportError:
    from recall import recall_candidates
    from rerank import rerank_candidates
    from mix_policy import compute_mix_policy
    from db import get_database_stats, sanitize_titles_in_db, ensure_item_embeddings_table
    from config import (
        CZ_ALPHA, CZ_BETA, CZ_GAMMA,
        EZ_MU, EZ_NU, SIM_CAP,
        T_HIGH, T_MID,
        RECALL_EZ_EXCELLENCE_THRESHOLD,
        TOP_K_CZ, TOP_K_EZ,
        RECO_DB_PATH,
        RECO_SERVICE_VERSION,
        MEM_INFLUENCE_MODE,
        EMBEDDING_URL
    )

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

app = FastAPI(title="Taste Aligner Recommendation Service v1.3")


# ============================================================
# Pydantic Models
# ============================================================

class ScoreRequestData(BaseModel):
    """Data for recommendation scoring request."""
    user_id: str = Field(..., description="User ID")
    city: str = Field(..., description="User's city context")
    tags: List[str] = Field(default_factory=list, description="User's preference tags")

    # v1.1: Optional mix policy control
    intent: Optional[str] = Field(None, description="User intent: 'comfort', 'explore', or 'balanced'")
    memory_confidence: Optional[float] = Field(None, description="Confidence in memory data [0, 1]")


class ScoreRequest(BaseModel):
    """Request payload for /score endpoint."""
    data: ScoreRequestData


# ============================================================
# Endpoints
# ============================================================

@app.on_event("startup")
async def startup_event():
    """Initialize service on startup."""
    logger.info(f"Recommendation Service {RECO_SERVICE_VERSION} started on port 5005")
    try:
        sanitize_titles_in_db()
        ensure_item_embeddings_table()
        stats = get_database_stats()
        logger.info(f"Database: {stats['total_items']} items across {stats['total_cities']} cities")
        logger.info(f"City distribution: {stats['city_distribution']}")
    except Exception as e:
        logger.error(f"Database initialization error: {e}")


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    try:
        stats = get_database_stats()
        return {
            "ok": True,
            "service": "recommendation",
            "version": RECO_SERVICE_VERSION,
            "dataset_source": "sqlite",
            "total_items": stats["total_items"],
            "total_cities": stats["total_cities"],
            "city_distribution": stats["city_distribution"],
            "db_path": stats["db_path"]
        }
    except Exception as e:
        return {
            "ok": False,
            "service": "recommendation",
            "version": RECO_SERVICE_VERSION,
            "error": str(e)
        }


@app.post("/score")
async def score_endpoint(request: ScoreRequest):
    """
    Agent-friendly recommendation scoring endpoint (v1.3).

    Two-stage architecture:
      1. RECALL: Cheap rule-based filtering (CZ city-only, EZ global)
      2. RERANK: CZ/EZ scoring with explainability (item-dependent memory_influence)

    Request body:
        {
            "data": {
                "user_id": "u001",
                "city": "tokyo",
                "tags": ["ramen", "nightlife", "walk"],
                "intent": "comfort",              // Optional: "comfort", "explore", "balanced"
                "memory_confidence": 0.8          // Optional: [0, 1]
            }
        }

    Returns:
        {
            "dummy": false,
            "trace_id": "t_xxx",
            "input": {...},
            "recall": {
                "cz_candidates": 11,
                "ez_candidates": 18,
                "recall_rules": [...]
            },
            "cz_ranked": [
                {
                    "id": "...",
                    "city": "tokyo",  // v1.1: always same as request city
                    "title": "...",
                    "tags": [...],
                    "excellence": 0.85,
                    "score_CZ": 1.87,
                    "components": {
                        "tag_similarity": 0.5,
                        "memory_influence": 1.2,  // v1.1: item-dependent
                        "location_relevance": 1.0
                    },
                    "anchor_memory_ids": [...],   // v1.1: from Memory Service
                    "memory_influence_detail": {...}
                }
            ],
            "ez_ranked": [
                {
                    "id": "...",
                    "city": "...",  // Can be any city
                    "score_EZ": 1.43,
                    "components": {
                        "global_excellence": 0.98,
                        "taste_similarity_raw": 0.8,
                        "taste_similarity_capped": 0.7,  // v1.1: capped
                        "taste_distance": 0.3
                    },
                    "sim_cap": 0.7,  // v1.1: cap value
                    "why_explore": "..."
                }
            ],
            "mix_policy": {
                "ratio": "3:1",                   // v1.1: discrete ratios only
                "rule": "comfort_high_confidence",
                "inputs_used": {
                    "intent": "comfort",
                    "memory_confidence": 0.8,
                    "delta": 0.44
                }
            },
            "debug": {
                "top_k_cz": 10,
                "top_k_ez": 5,
                "sim_cap": 0.7,
                "dataset_source": "sqlite",
                "db_path": "..."
            }
        }
    """
    trace_id = f"t_{uuid.uuid4().hex[:8]}"
    logger.info(
        f"[{trace_id}] POST /score - "
        f"user_id={request.data.user_id}, "
        f"city={request.data.city}, "
        f"tags={request.data.tags}, "
        f"intent={request.data.intent}, "
        f"memory_confidence={request.data.memory_confidence}"
    )

    try:
        # Extract inputs
        user_id = request.data.user_id
        city = request.data.city
        tags = request.data.tags
        intent = request.data.intent
        memory_confidence = request.data.memory_confidence

        # TODO: In production, call Ontology Service to normalize tags
        normalized_tags = tags

        # ========================================
        # STAGE 1: RECALL (v1.1)
        # ========================================

        logger.info(f"[{trace_id}] Stage 1: Recall (CZ city-only, EZ global)")
        recall_results = recall_candidates(
            city=city,
            normalized_tags=normalized_tags,
            user_id=user_id
        )

        logger.info(
            f"[{trace_id}] Recall: "
            f"CZ={len(recall_results['cz_candidates'])} (city-only), "
            f"EZ={len(recall_results['ez_candidates'])} (global)"
        )

        # ========================================
        # STAGE 2: RERANK (v1.1)
        # ========================================

        logger.info(f"[{trace_id}] Stage 2: Rerank (v1.3)")

        rerank_results = rerank_candidates(
            recall_results=recall_results,
            user_id=user_id,
            user_city=city,
            user_tags=normalized_tags
        )

        cz_ranked = rerank_results["cz_ranked"]
        ez_ranked = rerank_results["ez_ranked"]

        logger.info(
            f"[{trace_id}] Rerank: {len(cz_ranked)} CZ, {len(ez_ranked)} EZ"
        )

        # ========================================
        # MIX POLICY (v1.1)
        # ========================================

        mix_policy = compute_mix_policy(
            cz_ranked,
            ez_ranked,
            intent=intent,
            memory_confidence=memory_confidence
        )

        logger.info(
            f"[{trace_id}] Mix policy: {mix_policy['rule']} "
            f"(ratio={mix_policy['ratio']}, conf={mix_policy['confidence']:.2f})"
        )

        # ========================================
        # BUILD RESPONSE (v1.1)
        # ========================================

        response = {
            "dummy": False,
            "trace_id": trace_id,
            "version": RECO_SERVICE_VERSION,

            "input": {
                "user_id": user_id,
                "city": city,
                "tags": tags,
                "normalized_tags": normalized_tags,
                "intent": intent,
                "memory_confidence": memory_confidence
            },

            "recall": {
                "cz_candidates": len(recall_results["cz_candidates"]),
                "ez_candidates": len(recall_results["ez_candidates"]),
                "total_candidates": recall_results["total_candidates"],
                "recall_rules": recall_results["recall_rules"],
                "stats": recall_results["stats"]
            },

            "mix_policy": mix_policy,

            "cz_ranked": cz_ranked,
            "ez_ranked": ez_ranked,

            "debug": {
                "top_k_cz": TOP_K_CZ,
                "top_k_ez": TOP_K_EZ,
                "sim_cap": SIM_CAP,
                "weights": {
                    "cz": {
                        "alpha": CZ_ALPHA,
                        "beta": CZ_BETA,
                        "gamma": CZ_GAMMA
                    },
                    "ez": {
                        "mu": EZ_MU,
                        "nu": EZ_NU
                    }
                },
                "thresholds": {
                    "t_high": T_HIGH,
                    "t_mid": T_MID,
                    "recall_ez_excellence": RECALL_EZ_EXCELLENCE_THRESHOLD
                },
                "ez": {
                    "diversity_enabled": rerank_results["stats"].get("ez_diversity_enabled"),
                    "diversity_method": rerank_results["stats"].get("ez_diversity_method"),
                    "lambda_diversity": rerank_results["stats"].get("ez_lambda_diversity")
                },
                "mem_influence_mode": MEM_INFLUENCE_MODE,
                "embedding_url": EMBEDDING_URL,
                "embedding_ok_count": rerank_results["stats"].get("embedding_ok_count"),
                "embedding_fail_count": rerank_results["stats"].get("embedding_fail_count"),
                "embedding_last_error": rerank_results["stats"].get("embedding_last_error"),
                "dataset_source": "sqlite",
                "db_path": str(RECO_DB_PATH),
                "rerank_stats": rerank_results["stats"]
            }
        }

        logger.info(f"[{trace_id}] Response ready")
        return response

    except Exception as e:
        logger.error(f"[{trace_id}] Error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    logger.info("Starting Recommendation Service v1.3 on port 5005")
    uvicorn.run(app, host="0.0.0.0", port=5005)
