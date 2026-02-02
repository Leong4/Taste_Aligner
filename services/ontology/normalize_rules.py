"""
Tag Normalization Engine for Taste Aligner Ontology Service

This module provides deterministic, explainable tag normalization using
a pre-populated tag dictionary with multilingual support.
"""

from typing import Dict, Any, List, Optional
import yaml
import re
from pathlib import Path
from ..common.helpers import ensure_dict


# Load tag dictionary at module initialization
TAG_DICTIONARY: Dict[str, Dict[str, Any]] = {}
ALIAS_TO_CANONICAL: Dict[str, str] = {}


def _load_tag_dictionary() -> None:
    """Load tag_dictionary.yaml and build reverse alias lookup."""
    global TAG_DICTIONARY, ALIAS_TO_CANONICAL

    dict_path = Path(__file__).parent / "tag_dictionary.yaml"

    if not dict_path.exists():
        raise FileNotFoundError(f"Tag dictionary not found at {dict_path}")

    with open(dict_path, "r", encoding="utf-8") as f:
        TAG_DICTIONARY = yaml.safe_load(f) or {}

    # Build reverse mapping: alias -> canonical tag
    for canonical_tag, metadata in TAG_DICTIONARY.items():
        # The canonical tag itself maps to itself
        ALIAS_TO_CANONICAL[canonical_tag] = canonical_tag

        # Each alias maps to the canonical tag
        aliases = metadata.get("aliases", [])
        for alias in aliases:
            # Clean the alias using the same robust cleaning function
            normalized_alias = _clean_tag(alias)
            if normalized_alias:  # Only add non-empty cleaned aliases
                ALIAS_TO_CANONICAL[normalized_alias] = canonical_tag


def _clean_tag(tag: str) -> str:
    """
    Robust tag cleaning function.

    Pipeline:
    1. Trim whitespace
    2. Remove leading '#' if present
    3. Convert ASCII letters to lowercase
    4. Keep only: a-z, 0-9, Chinese characters (U+4E00-U+9FFF), and spaces
    5. Collapse multiple spaces to single space
    6. Trim again; return empty string if result is empty

    Examples:
        " Ramen!!! " -> "ramen"
        "#夜生活" -> "夜生活"
        "WALKING" -> "walking"
        "未知标签 xyz" -> "未知标签 xyz"
    """
    if not isinstance(tag, str):
        return ""

    # Step 1: Trim whitespace
    cleaned = tag.strip()

    # Step 2: Remove leading '#'
    if cleaned.startswith('#'):
        cleaned = cleaned[1:]

    # Step 3: Convert ASCII letters to lowercase
    cleaned = cleaned.lower()

    # Step 4: Keep only allowed characters
    # - a-z (lowercase ASCII letters)
    # - 0-9 (digits)
    # - Chinese characters (U+4E00-U+9FFF)
    # - spaces
    def is_allowed_char(char: str) -> bool:
        # Check if lowercase ASCII letter
        if 'a' <= char <= 'z':
            return True
        # Check if digit
        if '0' <= char <= '9':
            return True
        # Check if Chinese character
        if '\u4e00' <= char <= '\u9fff':
            return True
        # Check if space
        if char == ' ':
            return True
        return False

    cleaned = ''.join(char for char in cleaned if is_allowed_char(char))

    # Step 5: Collapse multiple spaces to single space
    cleaned = re.sub(r'\s+', ' ', cleaned)

    # Step 6: Final trim
    cleaned = cleaned.strip()

    return cleaned


def _map_to_canonical(cleaned_tag: str) -> Optional[str]:
    """
    Map a cleaned tag to its canonical form.

    Priority:
    1. Check if it's a known alias (exact match)
    2. Check with spaces converted to underscores
    3. Check if it's already a canonical tag
    4. Return None if unknown

    Note: This handles both "city walk" and "city_walk" forms.
    """
    # Try exact alias lookup first
    if cleaned_tag in ALIAS_TO_CANONICAL:
        return ALIAS_TO_CANONICAL[cleaned_tag]

    # Try with spaces converted to underscores
    tag_with_underscores = cleaned_tag.replace(' ', '_')
    if tag_with_underscores in ALIAS_TO_CANONICAL:
        return ALIAS_TO_CANONICAL[tag_with_underscores]

    # Check if it's already a canonical tag
    if cleaned_tag in TAG_DICTIONARY:
        return cleaned_tag
    if tag_with_underscores in TAG_DICTIONARY:
        return tag_with_underscores

    return None


def normalize_tags(payload: Any) -> Dict[str, Any]:
    """
    Normalize tags from noisy input to canonical system tags.

    Separates recognized tags (in ontology) from unknown tags.

    Args:
        payload: Request payload containing data.tags (string or list)

    Returns:
        {
            "dummy": false,
            "raw": [...],
            "normalized": [...],  # ONLY recognized canonical tags
            "unknown": [...],     # Unrecognized cleaned tags
            "taxonomy": {...},    # ONLY for normalized tags
            "mapping_used": {...}
        }
    """
    # Extract tags from payload
    data = ensure_dict(payload.data)
    raw_input = data.get("tags")

    # Handle both string and list input
    if isinstance(raw_input, str):
        raw_tags = [raw_input]
    elif isinstance(raw_input, list):
        raw_tags = [str(t) for t in raw_input]
    else:
        raw_tags = []

    # Track mappings and results
    normalized_tags: List[str] = []
    unknown_tags: List[str] = []
    mapping_used: Dict[str, str] = {}
    taxonomy: Dict[str, Dict[str, str]] = {}

    # Track seen tags to maintain order while deduplicating
    seen_normalized = set()
    seen_unknown = set()

    for raw_tag in raw_tags:
        # Clean the tag
        cleaned = _clean_tag(raw_tag)

        if not cleaned:
            continue

        # Map to canonical
        canonical = _map_to_canonical(cleaned)

        if canonical:
            # Tag is recognized - add to normalized list
            if canonical not in seen_normalized:
                normalized_tags.append(canonical)
                seen_normalized.add(canonical)

            # Record mapping if transformation occurred
            if cleaned != canonical:
                mapping_used[cleaned] = canonical

            # Add taxonomy information
            if canonical in TAG_DICTIONARY:
                metadata = TAG_DICTIONARY[canonical]
                taxonomy[canonical] = {
                    "category": metadata.get("category", "unknown"),
                    "subcategory": metadata.get("subcategory", "unknown")
                }
        else:
            # Tag is unknown - add to unknown list
            if cleaned not in seen_unknown:
                unknown_tags.append(cleaned)
                seen_unknown.add(cleaned)

    # Sort for deterministic output
    normalized_tags.sort()
    unknown_tags.sort()

    return {
        "dummy": False,
        "raw": raw_tags,
        "normalized": normalized_tags,
        "unknown": unknown_tags,
        "taxonomy": taxonomy,
        "mapping_used": mapping_used
    }


# Initialize dictionary on module load
try:
    _load_tag_dictionary()
except Exception as e:
    # Log error but don't crash the service
    print(f"Warning: Failed to load tag dictionary: {e}")
    TAG_DICTIONARY = {}
    ALIAS_TO_CANONICAL = {}
