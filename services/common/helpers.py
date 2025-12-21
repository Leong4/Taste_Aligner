from typing import Any, Dict
from datetime import datetime, timezone


def ensure_dict(value: Any) -> Dict[str, Any]:
    """Return a dict if value is dict-like, otherwise empty dict."""
    return value if isinstance(value, dict) else {}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def slugify(text: str) -> str:
    return "".join(ch.lower() if ch.isalnum() else "-" for ch in text).strip("-")

