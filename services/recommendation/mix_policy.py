"""
Recommendation Service v1.1 - CZ/EZ Mix Policy

Determines the ratio of Comfort Zone vs Exploration Zone items
based on:
- Score differences (delta)
- User intent ("comfort", "explore", "balanced")
- Memory confidence (0..1)

v1.1 Changes:
- Discrete ratios only: {"3:1", "2:1", "1:1", "1:2", "1:3", "3:0"}
- Intent-driven policy with memory_confidence modulation
- Explicit, explainable decision logic
"""

from typing import Dict, Any, List, Optional
import logging

try:
    from .config import T_HIGH, T_MID
except ImportError:
    from config import T_HIGH, T_MID

logger = logging.getLogger(__name__)

# Discrete ratio set (v1.1)
VALID_RATIOS = ["3:0", "3:1", "2:1", "1:1", "1:2", "1:3"]


def parse_ratio(ratio_str: str) -> tuple:
    """Parse ratio string to (cz, ez) tuple."""
    parts = ratio_str.split(":")
    return (int(parts[0]), int(parts[1]))


def compute_mix_policy(
    cz_ranked: List[Dict[str, Any]],
    ez_ranked: List[Dict[str, Any]],
    intent: Optional[str] = None,
    memory_confidence: Optional[float] = None
) -> Dict[str, Any]:
    """
    Compute CZ/EZ mix policy based on scores, intent, and memory_confidence.

    v1.1 Logic:
    1. Compute delta = top_CZ - top_EZ
    2. Consider intent ("comfort", "explore", "balanced")
    3. Modulate by memory_confidence (0..1)
    4. Return discrete ratio from VALID_RATIOS only

    Args:
        cz_ranked: CZ items sorted by score_CZ DESC
        ez_ranked: EZ items sorted by score_EZ DESC
        intent: User intent ("comfort", "explore", "balanced") - optional
        memory_confidence: Confidence in user's memory data [0, 1] - optional

    Returns:
        {
            "ratio": str,               # Discrete ratio from VALID_RATIOS
            "cz": int,                  # CZ count
            "ez": int,                  # EZ count
            "rule": str,                # Policy rule name
            "confidence": float,        # Confidence in decision [0, 1]
            "inputs_used": {...},       # What inputs were considered
            "delta": float,             # Score difference
            "top_cz_score": float,
            "top_ez_score": float
        }
    """
    # Default values
    if intent not in ["comfort", "explore", "balanced"]:
        intent = "balanced"  # Default

    if memory_confidence is None:
        memory_confidence = 0.5  # Neutral default

    # Clamp memory_confidence to [0, 1]
    memory_confidence = max(0.0, min(1.0, memory_confidence))

    # Handle empty cases
    if not cz_ranked and not ez_ranked:
        return {
            "ratio": "1:1",
            "cz": 0,
            "ez": 0,
            "rule": "no_candidates",
            "confidence": 0.0,
            "inputs_used": {"intent": intent, "memory_confidence": memory_confidence},
            "delta": 0.0,
            "top_cz_score": 0.0,
            "top_ez_score": 0.0
        }

    if not cz_ranked:
        # Only EZ available
        return {
            "ratio": "0:3",  # Note: not in VALID_RATIOS, but special case
            "cz": 0,
            "ez": min(3, len(ez_ranked)),
            "rule": "only_ez_available",
            "confidence": 1.0,
            "inputs_used": {"intent": intent, "memory_confidence": memory_confidence},
            "delta": float('-inf'),
            "top_cz_score": 0.0,
            "top_ez_score": ez_ranked[0]["score_EZ"] if ez_ranked else 0.0
        }

    if not ez_ranked:
        # Only CZ available
        return {
            "ratio": "3:0",
            "cz": min(3, len(cz_ranked)),
            "ez": 0,
            "rule": "only_cz_available",
            "confidence": 1.0,
            "inputs_used": {"intent": intent, "memory_confidence": memory_confidence},
            "delta": float('inf'),
            "top_cz_score": cz_ranked[0]["score_CZ"],
            "top_ez_score": 0.0
        }

    # Get top scores
    top_cz_score = cz_ranked[0]["score_CZ"]
    top_ez_score = ez_ranked[0]["score_EZ"]

    # Compute delta
    delta = top_cz_score - top_ez_score

    # ========================================
    # v1.1 Decision Logic
    # ========================================

    ratio_str, rule, confidence = _decide_ratio(
        delta, intent, memory_confidence
    )

    # Parse ratio to counts
    cz_count, ez_count = parse_ratio(ratio_str)

    # Adjust counts if insufficient candidates
    cz_count = min(cz_count, len(cz_ranked))
    ez_count = min(ez_count, len(ez_ranked))

    logger.info(
        f"Mix policy: {cz_count} CZ + {ez_count} EZ "
        f"(ratio={ratio_str}, rule={rule}, delta={delta:.4f}, "
        f"intent={intent}, mem_conf={memory_confidence:.2f})"
    )

    return {
        "ratio": ratio_str,
        "cz": cz_count,
        "ez": ez_count,
        "rule": rule,
        "confidence": round(confidence, 4),
        "inputs_used": {
            "intent": intent,
            "memory_confidence": memory_confidence,
            "delta": round(delta, 4)
        },
        "delta": round(delta, 4),
        "top_cz_score": round(top_cz_score, 4),
        "top_ez_score": round(top_ez_score, 4)
    }


def _decide_ratio(
    delta: float,
    intent: str,
    memory_confidence: float
) -> tuple:
    """
    Core decision logic for ratio selection.

    Args:
        delta: Score difference (top_CZ - top_EZ)
        intent: "comfort", "explore", or "balanced"
        memory_confidence: [0, 1]

    Returns:
        (ratio_str, rule_name, confidence)
    """
    # ========================================
    # Intent-driven decision (primary)
    # ========================================

    if intent == "comfort":
        # User wants comfort zone
        if memory_confidence >= 0.8:
            # High confidence in user's history → strong CZ
            if delta > T_HIGH or delta > 0:
                # CZ is strong OR any positive delta → 3:0 (pure comfort)
                return ("3:0", "comfort_high_confidence", 0.9)
            else:
                # CZ weaker but still comfort intent → 3:1
                return ("3:1", "comfort_high_confidence_weak_cz", 0.75)
        elif memory_confidence >= 0.5:
            # Medium confidence → 3:1 or 2:1
            if delta > T_HIGH:
                return ("3:1", "comfort_medium_confidence_strong_cz", 0.8)
            else:
                return ("2:1", "comfort_medium_confidence", 0.7)
        else:
            # Low confidence → be cautious, 2:1
            return ("2:1", "comfort_low_confidence", 0.6)

    elif intent == "explore":
        # User wants exploration
        if memory_confidence >= 0.7:
            # High confidence → can safely explore more
            if delta < -T_MID:
                # EZ is very attractive → 1:3
                return ("1:3", "explore_high_confidence_strong_ez", 0.9)
            else:
                # Balanced exploration → 1:2
                return ("1:2", "explore_high_confidence", 0.8)
        elif memory_confidence >= 0.4:
            # Medium confidence → moderate exploration
            if delta < -T_MID:
                return ("1:2", "explore_medium_confidence_strong_ez", 0.75)
            else:
                return ("1:1", "explore_medium_confidence", 0.7)
        else:
            # Low confidence → cautious exploration
            return ("1:1", "explore_low_confidence", 0.6)

    else:  # intent == "balanced" (default)
        # Balanced approach - use delta + memory_confidence

        # High memory confidence → trust CZ more
        if memory_confidence >= 0.7:
            if delta > T_HIGH:
                return ("3:1", "balanced_high_conf_strong_cz", 0.8)
            elif abs(delta) <= T_MID:
                return ("2:1", "balanced_high_conf_neutral", 0.7)
            else:
                return ("1:1", "balanced_high_conf_weak_cz", 0.65)

        # Medium memory confidence → truly balanced
        elif memory_confidence >= 0.4:
            if delta > T_HIGH:
                return ("2:1", "balanced_medium_conf_strong_cz", 0.75)
            elif abs(delta) <= T_MID:
                return ("1:1", "balanced_medium_conf_neutral", 0.7)
            else:
                return ("1:2", "balanced_medium_conf_weak_cz", 0.65)

        # Low memory confidence → explore more
        else:
            if delta > T_HIGH:
                return ("2:1", "balanced_low_conf_strong_cz", 0.6)
            elif abs(delta) <= T_MID:
                return ("1:1", "balanced_low_conf_neutral", 0.6)
            else:
                return ("1:2", "balanced_low_conf_weak_cz", 0.65)


def apply_mix_policy(
    cz_ranked: List[Dict[str, Any]],
    ez_ranked: List[Dict[str, Any]],
    policy: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Apply mix policy to create final mixed recommendation list.

    This is optional - by default we return separated CZ/EZ lists
    and let the Agent/Planner decide how to mix them.

    Args:
        cz_ranked: CZ items sorted by score
        ez_ranked: EZ items sorted by score
        policy: Mix policy from compute_mix_policy

    Returns:
        {
            "mixed": List[Dict],  # Interleaved CZ/EZ items
            "order": List[str]    # ["CZ", "CZ", "EZ", "CZ", ...]
        }
    """
    cz_count = policy["cz"]
    ez_count = policy["ez"]

    selected_cz = cz_ranked[:cz_count]
    selected_ez = ez_ranked[:ez_count]

    # Simple interleaving strategy
    mixed = []
    order = []

    cz_idx = 0
    ez_idx = 0

    total = cz_count + ez_count
    for i in range(total):
        # Decide whether to pick CZ or EZ next
        if cz_idx < cz_count and ez_idx < ez_count:
            # Both available, use ratio
            cz_ratio = cz_count / total if total > 0 else 0.5
            current_cz_ratio = len([x for x in order if x == "CZ"]) / (i + 1) if i > 0 else 1.0

            if current_cz_ratio < cz_ratio:
                mixed.append(selected_cz[cz_idx])
                order.append("CZ")
                cz_idx += 1
            else:
                mixed.append(selected_ez[ez_idx])
                order.append("EZ")
                ez_idx += 1
        elif cz_idx < cz_count:
            # Only CZ left
            mixed.append(selected_cz[cz_idx])
            order.append("CZ")
            cz_idx += 1
        elif ez_idx < ez_count:
            # Only EZ left
            mixed.append(selected_ez[ez_idx])
            order.append("EZ")
            ez_idx += 1

    return {
        "mixed": mixed,
        "order": order
    }
