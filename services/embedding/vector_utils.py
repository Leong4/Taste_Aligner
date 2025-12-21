import hashlib
import json
import random
from typing import Dict, Any, List
from .model_loader import load_model
from ..common.helpers import ensure_dict

_MODEL = load_model()


def _build_fixed_vector(seed: str, dim: int = 512) -> List[float]:
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()
    rng = random.Random(digest)
    return [round(rng.uniform(-1.0, 1.0), 6) for _ in range(dim)]


def generate_embedding(payload: Any) -> Dict[str, Any]:
    data = ensure_dict(payload.data)
    seed_source = json.dumps(data, sort_keys=True)
    vector = _build_fixed_vector(seed_source)
    return {
        "dummy": True,
        "model": _MODEL.name,
        "vector": vector,
        "dimension": len(vector),
        "input": data,
    }

