from typing import Any, Dict, List, Tuple
import logging
import math

logger = logging.getLogger(__name__)


def is_finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and math.isfinite(float(value))


def ensure_finite_float(
    value: Any,
    *,
    default: float = 0.0,
    item_id: str = "",
    field: str = "",
    counters: Dict[str, Any] | None = None
) -> float:
    """
    Guard a computed numeric value. Non-finite values become default.
    Optionally updates counters with count + sampled fields.
    """
    if is_finite_number(value):
        return float(value)

    if counters is not None:
        counters["non_finite_count"] = int(counters.get("non_finite_count", 0)) + 1
        sample_limit = int(counters.get("sample_limit", 20))
        samples = counters.setdefault("sample_fields", [])
        if len(samples) < sample_limit:
            samples.append(f"{item_id}:{field}" if item_id else field)

    logger.info(
        "non_finite_value_sanitized item_id=%s field=%s raw=%r default=%s",
        item_id or "<none>",
        field or "<unknown>",
        value,
        default
    )
    return float(default)


def sanitize_floats(
    obj: Any,
    *,
    sample_limit: int = 20
) -> Tuple[Any, int, List[str]]:
    """
    Recursively sanitize non-finite floats in arbitrary JSON-like object.
    Returns (sanitized_obj, sanitized_count, sample_paths).
    """
    sample_paths: List[str] = []
    count = 0

    def _walk(value: Any, path: str) -> Any:
        nonlocal count

        if isinstance(value, float):
            if math.isfinite(value):
                return value
            count += 1
            if len(sample_paths) < sample_limit:
                sample_paths.append(path)
            return 0.0

        if isinstance(value, list):
            return [_walk(v, f"{path}[{idx}]") for idx, v in enumerate(value)]

        if isinstance(value, dict):
            out: Dict[str, Any] = {}
            for k, v in value.items():
                next_path = f"{path}.{k}" if path else str(k)
                out[k] = _walk(v, next_path)
            return out

        return value

    return _walk(obj, ""), count, sample_paths
