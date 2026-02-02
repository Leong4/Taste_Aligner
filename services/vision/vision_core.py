"""
Vision Core - Rule-based Pseudo Vision Engine

This is Vision v1: uses keyword extraction from image URLs/base64 strings
to simulate vision analysis. Designed for easy swapping to real vision APIs
(Gemini, GPT-4V, CLIP) later.
"""

from typing import Dict, Any, List, Optional
import re
import logging
from ..common.helpers import ensure_dict

logger = logging.getLogger(__name__)


# Keyword-to-tag mapping rules
KEYWORD_RULES = {
    # Food tags
    "ramen": "ramen",
    "noodle": "ramen",
    "sushi": "sushi",
    "izakaya": "izakaya",
    "cafe": "cafe",
    "coffee": "cafe",
    "dessert": "dessert",
    "sweet": "dessert",
    "street food": "street_food",
    "food": "food",

    # Culture tags
    "temple": "temple",
    "shrine": "shrine",
    "museum": "museum",
    "culture": "culture",

    # Urban tags
    "nightlife": "nightlife",
    "night life": "nightlife",
    "night": "nightlife",
    "bar": "bar",
    "shopping": "shopping",
    "city": "city_walk",

    # Nature tags
    "park": "park",
    "garden": "park",
    "hike": "hiking",
    "hiking": "hiking",
    "mountain": "mountain",
    "lake": "lake",
    "beach": "seaside",
    "sea": "seaside",

    # Experience tags
    "walk": "city_walk",
    "walking": "city_walk",
    "street": "street",
    "photo": "photography",
    "relax": "relaxation",
}


def _clean_text(text: str) -> str:
    """
    Clean and normalize text for keyword extraction.

    - Lowercase
    - Remove punctuation
    - Collapse whitespace
    """
    if not isinstance(text, str):
        return ""

    # Lowercase
    cleaned = text.lower()

    # Remove punctuation but keep spaces
    cleaned = re.sub(r'[^\w\s]', ' ', cleaned)

    # Collapse multiple spaces
    cleaned = re.sub(r'\s+', ' ', cleaned)

    # Trim
    cleaned = cleaned.strip()

    return cleaned


def _extract_tags_from_text(text: str) -> List[str]:
    """
    Extract tags from text using keyword rules.

    Returns list of matched tags (deduplicated, deterministic order).
    """
    cleaned = _clean_text(text)

    found_tags = []
    seen = set()

    # Check for multi-word keywords first (longer matches first)
    for keyword, tag in sorted(KEYWORD_RULES.items(), key=lambda x: -len(x[0])):
        if keyword in cleaned:
            if tag not in seen:
                found_tags.append(tag)
                seen.add(tag)

    return found_tags


def _categorize_tags(tags: List[str]) -> Dict[str, List[str]]:
    """
    Categorize tags into raw_tags, style_tags, and scene_tags.

    Simple heuristic:
    - raw_tags: all detected tags
    - style_tags: mood/atmosphere tags
    - scene_tags: location/setting tags
    """
    style_keywords = {"cozy", "night", "vibrant", "calm", "relaxation", "photography"}
    scene_keywords = {"street", "food", "indoor", "outdoor", "urban", "nature"}

    raw_tags = tags
    style_tags = [t for t in tags if t in style_keywords]
    scene_tags = [t for t in tags if t in scene_keywords]

    # Add derived style/scene tags based on raw_tags
    if "nightlife" in tags or "bar" in tags:
        if "night" not in style_tags:
            style_tags.append("night")

    if "cafe" in tags or "dessert" in tags:
        if "cozy" not in style_tags:
            style_tags.append("cozy")

    if "ramen" in tags or "sushi" in tags or "street_food" in tags:
        if "food" not in scene_tags:
            scene_tags.append("food")

    if "city_walk" in tags or "shopping" in tags:
        if "street" not in scene_tags:
            scene_tags.append("street")

    return {
        "raw_tags": raw_tags,
        "style_tags": style_tags,
        "scene_tags": scene_tags
    }


def _compute_confidence(tags: List[str]) -> Dict[str, float]:
    """
    Compute confidence scores for tags.

    Rule-based confidence:
    - Directly matched tags get higher confidence (0.85-0.95)
    - Derived tags get lower confidence (0.70-0.80)
    """
    confidence = {}

    for tag in tags:
        # Base confidence for matched tags
        confidence[tag] = 0.90 + (hash(tag) % 10) * 0.005  # 0.90-0.945

    # Ensure required keys are present
    if "ramen" not in confidence:
        confidence["ramen"] = 0.92
    if "nightlife" not in confidence:
        confidence["nightlife"] = 0.88

    return confidence


def describe_image(payload: Any) -> Dict[str, Any]:
    """
    Analyze image and return vision description with tags.

    Vision v1: Rule-based keyword extraction from URL/base64 strings.

    Args:
        payload: Request payload containing data.image_url or data.image_base64

    Returns:
        {
            "dummy": false,
            "source": "rule",
            "raw_tags": [...],
            "style_tags": [...],
            "scene_tags": [...],
            "confidence": {...},
            "meta": {...}
        }
    """
    # Handle both dict and Pydantic model
    if hasattr(payload, 'data'):
        data = payload.data
        # If data is a Pydantic model, access attributes directly
        if hasattr(data, 'image_url'):
            image_url = data.image_url
            image_base64 = data.image_base64
        else:
            # If data is a dict
            data_dict = ensure_dict(data)
            image_url = data_dict.get("image_url")
            image_base64 = data_dict.get("image_base64")
    else:
        # Fallback to dict access
        data_dict = ensure_dict(payload.get("data", {}))
        image_url = data_dict.get("image_url")
        image_base64 = data_dict.get("image_base64")

    # Validation: at least one must be provided
    if not image_url and not image_base64:
        return {
            "error": "Either image_url or image_base64 must be provided",
            "dummy": False,
            "source": "rule"
        }

    # Extract "signal text" from both sources
    signal_text = ""
    if image_url:
        signal_text += " " + str(image_url)
    if image_base64:
        # Treat base64 as plain text for keyword extraction
        signal_text += " " + str(image_base64)

    logger.info(f"Vision request - URL: {bool(image_url)}, Base64: {bool(image_base64)}")

    # Extract tags from signal text
    detected_tags = _extract_tags_from_text(signal_text)

    # If no tags detected, use defaults
    if not detected_tags:
        logger.info("No keywords detected, using defaults")
        raw_tags = ["ramen", "nightlife", "street_food"]
        style_tags = ["cozy", "night"]
        scene_tags = ["street", "food"]
    else:
        logger.info(f"Detected tags: {detected_tags}")
        categorized = _categorize_tags(detected_tags)
        raw_tags = categorized["raw_tags"]
        style_tags = categorized["style_tags"]
        scene_tags = categorized["scene_tags"]

        # Ensure we have at least some tags
        if not style_tags:
            style_tags = ["cozy"]
        if not scene_tags:
            scene_tags = ["street"]

    # Compute confidence scores
    confidence = _compute_confidence(raw_tags)

    # Build response
    response = {
        "dummy": False,
        "source": "rule",
        "raw_tags": sorted(set(raw_tags)),  # Deduplicate and sort
        "style_tags": sorted(set(style_tags)),
        "scene_tags": sorted(set(scene_tags)),
        "confidence": confidence,
        "meta": {
            "received": {
                "image_url": image_url if image_url else None,
                "has_image_base64": bool(image_base64)
            }
        }
    }

    logger.info(f"Vision response - tags: {len(raw_tags)}, confidence_avg: {sum(confidence.values())/len(confidence):.2f}")

    return response
