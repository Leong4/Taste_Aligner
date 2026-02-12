from typing import Any, Dict, List, Optional, Tuple


def _dedupe_preserve_order(values: List[str]) -> List[str]:
    seen = set()
    result = []
    for val in values:
        if val in seen:
            continue
        seen.add(val)
        result.append(val)
    return result


def normalize_input(data: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize planner input for deterministic behavior."""
    user_id = (data.get("user_id") or "").strip() or "anonymous"
    city = (data.get("city") or "").strip().lower()

    raw_tags = data.get("tags") or []
    if isinstance(raw_tags, str):
        raw_tags = [raw_tags]
    tags = [
        t.strip().lower()
        for t in raw_tags
        if isinstance(t, str) and t.strip()
    ]
    tags = _dedupe_preserve_order(tags)

    constraints = data.get("constraints") or {}
    controls = data.get("controls") or {}

    normalized_constraints = {
        "days": int(constraints.get("days", 1)),
        "pace": constraints.get("pace", "relaxed"),
        "budget": constraints.get("budget", "mid"),
        "must_have": constraints.get("must_have") or [],
        "avoid": constraints.get("avoid") or []
    }

    normalized_controls = {
        "topk_cz": int(controls.get("topk_cz", 3)),
        "topk_ez": int(controls.get("topk_ez", 2)),
        "ratio_mode": controls.get("ratio_mode", "auto"),
        "explain_level": controls.get("explain_level", "full")
    }

    return {
        "user_id": user_id,
        "city": city,
        "tags": tags,
        "constraints": normalized_constraints,
        "controls": normalized_controls
    }


def _parse_ratio(ratio: str) -> Tuple[int, int]:
    try:
        left, right = ratio.split(":")
        return max(0, int(left)), max(0, int(right))
    except Exception:
        return 3, 1


def apply_ratio_policy(
    cz_items: List[Dict[str, Any]],
    ez_items: List[Dict[str, Any]],
    controls: Dict[str, Any],
    reco_mix_policy: Optional[Dict[str, Any]]
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    ratio_mode = controls.get("ratio_mode", "auto")

    ratio_map = {
        "cz_strong": "3:1",
        "balanced": "2:1",
        "ez_more": "1:2"
    }

    if ratio_mode == "auto":
        ratio = (reco_mix_policy or {}).get("ratio", "3:1")
    else:
        ratio = ratio_map.get(ratio_mode, "3:1")

    cz_target, ez_target = _parse_ratio(ratio)

    cz_selected = cz_items[:min(len(cz_items), cz_target)]
    ez_selected = ez_items[:min(len(ez_items), ez_target)]

    topk_cz = int(controls.get("topk_cz", 3))
    topk_ez = int(controls.get("topk_ez", 2))

    if len(cz_selected) < topk_cz:
        remaining = cz_items[len(cz_selected):]
        need = topk_cz - len(cz_selected)
        cz_selected.extend(remaining[:need])

    if len(ez_selected) < topk_ez:
        remaining = ez_items[len(ez_selected):]
        need = topk_ez - len(ez_selected)
        ez_selected.extend(remaining[:need])

    cz_selected = cz_selected[:topk_cz]
    ez_selected = ez_selected[:topk_ez]

    return cz_selected, ez_selected


def _stable_sort(items: List[Dict[str, Any]], score_key: str) -> List[Dict[str, Any]]:
    def score(item: Dict[str, Any]) -> float:
        raw = item.get(score_key)
        return float(raw) if raw is not None else 0.0

    return sorted(items, key=lambda x: (-score(x), _item_key(x)))


def _filter_city(items: List[Dict[str, Any]], city: str) -> List[Dict[str, Any]]:
    city_lower = (city or "").lower()
    return [item for item in items if (item.get("city") or "").lower() == city_lower]


def _item_key(item: Dict[str, Any]) -> str:
    return str(
        item.get("id")
        or item.get("item_id")
        or item.get("title")
        or ""
    )


def _mark_fill_reason(item: Dict[str, Any], reason: str) -> None:
    item["_planner_fill_reason"] = reason


def select_items_for_cards(
    reco_payload: Dict[str, Any],
    city: str,
    controls: Dict[str, Any]
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], Dict[str, Any]]:
    requested_topk_cz = int(controls.get("topk_cz", 3))
    requested_topk_ez = int(controls.get("topk_ez", 2))

    raw_cz = reco_payload.get("cz_ranked", [])
    raw_ez = reco_payload.get("ez_ranked", [])

    cz_items = _stable_sort(_filter_city(raw_cz, city), "score_CZ")
    ez_items = _stable_sort(_filter_city(raw_ez, city), "score_EZ")

    selected_cz = cz_items[:requested_topk_cz]
    selected_ez = ez_items[:requested_topk_ez]

    ez_fill_method_used = "none"
    ez_fill_triggered = False
    ez_fill_reason = "sufficient_ez_candidates"
    ez_fill_source = "ez_pool"
    pool_size_before_fill = {
        "ez_pool": len(ez_items),
        "cz_pool": len(cz_items)
    }
    fill_item_ids: List[str] = []
    fill_steps: List[Dict[str, Any]] = []
    selected_ids = {_item_key(item) for item in selected_cz + selected_ez}

    if len(selected_ez) < requested_topk_ez:
        pool = _filter_city(raw_cz + raw_ez, city)
        pool = [item for item in pool if _item_key(item) not in selected_ids]
        pool = sorted(
            pool,
            key=lambda x: (-float(x.get("excellence", 0.0)), _item_key(x))
        )

        needed = requested_topk_ez - len(selected_ez)
        fill = pool[:needed]
        if fill:
            ez_fill_triggered = True
            ez_fill_method_used = "same_city_excellence_fallback"
            ez_fill_reason = "insufficient_ez_candidates"
            ez_fill_source = "excellence_fallback"
            for item in fill:
                item_id = _item_key(item)
                _mark_fill_reason(item, "ez_fill_same_city_excellence_fallback")
                selected_ez.append(item)
                selected_ids.add(item_id)
                fill_item_ids.append(item_id)
                fill_steps.append({
                    "source": "excellence_fallback",
                    "item_id": item_id,
                    "reason": "insufficient_ez_candidates"
                })

    if len(selected_ez) < requested_topk_ez:
        remaining_cz = [item for item in cz_items if _item_key(item) not in selected_ids]
        needed = requested_topk_ez - len(selected_ez)
        fill = remaining_cz[:needed]
        if fill:
            ez_fill_triggered = True
            ez_fill_method_used = "from_cz_due_to_insufficient_ez"
            ez_fill_reason = "insufficient_ez_after_excellence_fallback"
            ez_fill_source = "cz_pool"
            for item in fill:
                item_id = _item_key(item)
                _mark_fill_reason(item, "ez_fill_from_cz_due_to_insufficient_ez")
                selected_ez.append(item)
                selected_ids.add(item_id)
                fill_item_ids.append(item_id)
                fill_steps.append({
                    "source": "cz_pool",
                    "item_id": item_id,
                    "reason": "insufficient_ez_after_excellence_fallback"
                })

    if len(selected_ez) < requested_topk_ez and not ez_fill_triggered:
        ez_fill_reason = "insufficient_candidates_after_fallback"

    planner_trace = {
        "rule_id": "planner_select_v1",
        "selected_cz_ids": [_item_key(item) for item in selected_cz],
        "selected_ez_ids": [_item_key(item) for item in selected_ez],
        "ez_fill_triggered": ez_fill_triggered,
        "ez_fill_reason": ez_fill_reason,
        "ez_fill_source": ez_fill_source,
        "pool_size_before_fill": pool_size_before_fill,
        "fill_item_ids": fill_item_ids,
        "fill_steps": fill_steps
    }

    return selected_cz, selected_ez, {
        "requested_topk_cz": requested_topk_cz,
        "requested_topk_ez": requested_topk_ez,
        "actual_cz_count": len(selected_cz),
        "actual_ez_count": len(selected_ez),
        "ez_fill_method_used": ez_fill_method_used,
        "planner_trace": planner_trace
    }


def _derive_type(tags: List[str], title: str) -> str:
    tokens = set((t or "").lower().strip() for t in (tags or []) if t)
    title_tokens = []
    for part in (title or "").lower().replace("-", " ").replace("/", " ").split():
        title_tokens.append(part.strip("()[],."))
    tokens |= set(t for t in title_tokens if t)

    food = {"ramen", "sushi", "noodles", "coffee", "dumplings", "hotpot", "pasta", "pizza"}
    culture = {"temple", "museum", "art", "gallery", "bookstore", "theater", "shrine"}
    nightlife = {"nightlife", "bar", "bars", "drinks", "cocktail", "club"}
    walk = {"walk", "park", "district", "garden", "neighborhood", "street", "market"}

    if tokens & food:
        return "food"
    if tokens & culture:
        return "culture"
    if tokens & nightlife:
        return "nightlife"
    if tokens & walk:
        return "walk"
    return "other"


def make_one_liner(item: Dict[str, Any], zone: str) -> str:
    if zone == "CZ":
        comp = item.get("components", {})
        if comp.get("tag_similarity", 0) >= 0.6:
            return "Strong taste match with your preferences."
        if comp.get("memory_influence", 1.0) >= 1.1:
            return "Resonates with your past memories."
        return "Comfortable local choice."

    comp = item.get("components", {})
    if comp.get("taste_distance", 0) >= 0.5:
        return "High-quality, different from your usual picks."
    if comp.get("global_excellence", 0) >= 0.9:
        return "World-class option worth exploring."
    return "A gentle exploration pick."


def assemble_cards(
    reco_payload: Dict[str, Any],
    anchors_by_item: Dict[str, List[Dict[str, Any]]],
    normalized_input: Dict[str, Any],
    controls: Dict[str, Any]
) -> List[Dict[str, Any]]:
    cz_items = reco_payload.get("cz_ranked", [])
    ez_items = reco_payload.get("ez_ranked", [])

    cards = []

    cz_card_items = []
    for item in cz_items:
        item_id = item.get("id") or item.get("item_id") or item.get("title")
        cz_card_items.append({
            "item_id": item_id,
            "name": item.get("title"),
            "city": item.get("city"),
            "type": item.get("kind") or _derive_type(item.get("tags", []), item.get("title", "")),
            "tags": item.get("tags", []),
            "scores": {"cz": item.get("score_CZ")},
            "score_breakdown": {
                "tag_similarity": item.get("components", {}).get("tag_similarity"),
                "memory_influence": item.get("components", {}).get("memory_influence"),
                "location_relevance": item.get("components", {}).get("location_relevance")
            },
            "explain": {
                "one_liner": make_one_liner(item, "CZ"),
                "reasons": [item.get("reason")] if item.get("reason") else []
            },
            "memory_anchors": anchors_by_item.get(item_id, [])
        })

    if cz_card_items:
        cards.append({
            "zone": "CZ",
            "title": "Your Comfort Zone",
            "items": cz_card_items
        })

    ez_card_items = []
    for item in ez_items:
        item_id = item.get("id") or item.get("item_id") or item.get("title")
        ez_card_items.append({
            "item_id": item_id,
            "name": item.get("title"),
            "city": item.get("city"),
            "type": item.get("kind") or _derive_type(item.get("tags", []), item.get("title", "")),
            "tags": item.get("tags", []),
            "scores": {"ez": item.get("score_EZ")},
            "score_breakdown": {
                "global_excellence": item.get("components", {}).get("global_excellence"),
                "taste_distance": item.get("components", {}).get("taste_distance")
            },
            "explain": {
                "one_liner": make_one_liner(item, "EZ"),
                "reasons": [
                    r for r in [
                        item.get("why_explore"),
                        item.get("_planner_fill_reason")
                    ] if r
                ]
            },
            "memory_anchors": anchors_by_item.get(item_id, [])
        })

    if ez_card_items:
        cards.append({
            "zone": "EZ",
            "title": "Exploration Zone",
            "items": ez_card_items
        })

    return cards
