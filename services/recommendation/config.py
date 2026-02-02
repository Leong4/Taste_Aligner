"""
Recommendation Service v1.3 - Configuration

All weights, thresholds, and parameters are centralized here
for easy tuning and explainability.

v1.3 Changes:
- EZ diversity rerank controls
- Embedding client configuration
- Memory influence mode/weight configuration

v1.2 Changes:
- EZ is now city-strict (no cross-city recommendations)
- Increased EZ_NU to 0.8 for stronger exploration emphasis
- Added MEMORY_INFLUENCE_BASE_WEIGHT for item-discriminative memory scoring
- SIM_CAP enforced at 0.7 for taste similarity capping

v1.1 Changes:
- Added SIM_CAP for taste similarity capping
- Increased EZ_NU for stronger taste_distance emphasis
- Added TOP_K_CZ and TOP_K_EZ configuration
- Added service integration URLs with env var support
"""

import os


def _env_bool(name: str, default: str = "false") -> bool:
    return os.getenv(name, default).strip().lower() in {"1", "true", "yes", "y", "on"}

# ============================================================
# DATABASE
# ============================================================

# Recommendation database path
RECO_DB_PATH = os.getenv("RECO_DB_PATH", "services/recommendation/data/reco.db")

# Service version
RECO_SERVICE_VERSION = os.getenv("RECO_SERVICE_VERSION", "v1.3")


# ============================================================
# RECALL STAGE
# ============================================================

# Global excellence threshold for EZ fallback in recall
RECALL_EZ_EXCELLENCE_THRESHOLD = float(os.getenv("RECALL_EZ_EXCELLENCE_THRESHOLD", "0.8"))

# Maximum recall candidates to pass to rerank stage
MAX_RECALL_CANDIDATES = int(os.getenv("MAX_RECALL_CANDIDATES", "50"))


# ============================================================
# OUTPUT LIMITS
# ============================================================

# Maximum items in final cz_ranked list
TOP_K_CZ = int(os.getenv("TOP_K_CZ", "10"))

# Maximum items in final ez_ranked list
TOP_K_EZ = int(os.getenv("TOP_K_EZ", "5"))


# ============================================================
# CZ (COMFORT ZONE) SCORING WEIGHTS
# ============================================================

# CZ formula: score_CZ = α * tag_sim + β * memory_inf + γ * location_rel
CZ_ALPHA = float(os.getenv("CZ_ALPHA", "1.0"))   # Tag similarity weight (dominant)
CZ_BETA = float(os.getenv("CZ_BETA", "0.6"))     # Memory influence weight
CZ_GAMMA = float(os.getenv("CZ_GAMMA", "0.3"))   # Location relevance weight


# ============================================================
# EZ (EXPLORATION ZONE) SCORING WEIGHTS
# ============================================================

# EZ formula: score_EZ = μ * global_excellence + ν * taste_distance
EZ_MU = float(os.getenv("EZ_MU", "1.0"))         # Global excellence weight (dominant)
EZ_NU = float(os.getenv("EZ_NU", "0.8"))         # Taste distance weight (v1.2: kept at 0.8 for strong exploration)

# Taste similarity cap (v1.1: NEW)
# Raw similarity is capped to this value before computing taste_distance
# This ensures exploration emphasizes distance properly
SIM_CAP = float(os.getenv("SIM_CAP", "0.7"))

# Taste distance upper bound (exploration must be reasonable)
# Items with taste_distance > this are discarded from EZ
EZ_TASTE_DISTANCE_MAX = float(os.getenv("EZ_TASTE_DISTANCE_MAX", "0.7"))

# EZ diversity rerank (v1.3)
EZ_DIVERSITY_ENABLED = _env_bool("EZ_DIVERSITY_ENABLED", "true")
EZ_DIVERSITY_METHOD = os.getenv("EZ_DIVERSITY_METHOD", "mmr")
EZ_LAMBDA_DIVERSITY = float(os.getenv("EZ_LAMBDA_DIVERSITY", "0.7"))


# ============================================================
# MIX POLICY THRESHOLDS
# ============================================================

# Let Δ = top_CZ_score - top_EZ_score

# If Δ > T_HIGH: CZ is very strong → ratio depends on intent
T_HIGH = float(os.getenv("MIX_T_HIGH", "0.5"))

# If |Δ| <= T_MID: Balanced → ratio depends on intent
T_MID = float(os.getenv("MIX_T_MID", "0.2"))

# v1.1: Mix policy now considers intent and memory_confidence
# Discrete ratios only: {"3:1", "2:1", "1:1", "1:2", "1:3", "3:0"}


# ============================================================
# MEMORY SERVICE INTEGRATION
# ============================================================

# Memory service endpoint (for memory_influence)
MEMORY_SERVICE_URL = os.getenv("MEMORY_SERVICE_URL", "http://localhost:5001")

# Number of top memories to fetch for influence calculation
MEMORY_TOP_K = int(os.getenv("MEMORY_TOP_K", "5"))

# Weight for memory final_score aggregation in CZ scoring
MEMORY_INFLUENCE_WEIGHT = float(os.getenv("MEMORY_INFLUENCE_WEIGHT", "1.0"))

# v1.2: Item-discriminative memory influence
# memory_influence = 1.0 + MEMORY_INFLUENCE_BASE_WEIGHT * cosine_similarity(memory_profile, item)
MEMORY_INFLUENCE_BASE_WEIGHT = float(os.getenv("MEMORY_INFLUENCE_BASE_WEIGHT", "0.6"))

# v1.3: embedding-based memory influence
MEM_INFLUENCE_MODE = os.getenv("MEM_INFLUENCE_MODE", "embedding")  # embedding | fallback
MEM_BETA = float(os.getenv("MEM_BETA", "0.3"))


# ============================================================
# ONTOLOGY SERVICE INTEGRATION
# ============================================================

# Ontology service endpoint (for tag normalization)
ONTOLOGY_SERVICE_URL = os.getenv("ONTOLOGY_SERVICE_URL", "http://localhost:5003")


# ============================================================
# EMBEDDING SERVICE INTEGRATION
# ============================================================

# Embedding service endpoint (for semantic similarity)
EMBEDDING_SERVICE_URL = os.getenv("EMBEDDING_SERVICE_URL", "http://localhost:5002")

# v1.3: Embedding generation endpoint (item/user embeddings)
EMBEDDING_URL = os.getenv("EMBEDDING_URL", "http://localhost:5004/generate")
EMBEDDING_TIMEOUT_MS = int(os.getenv("EMBEDDING_TIMEOUT_MS", "1500"))
