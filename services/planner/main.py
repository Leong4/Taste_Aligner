"""
Planner Service v1 - Trip Card Composer
"""

from fastapi import FastAPI
from pydantic import BaseModel, Field
from typing import Any, Dict, List, Optional
import math
import os
import uuid
import time
import requests

from .card_builder import normalize_input, select_items_for_cards, assemble_cards


PLANNER_VERSION = "v1"
PLANNER_PORT = int(os.getenv("PLANNER_PORT", "5006"))
RECO_URL = os.getenv("RECO_URL", "http://localhost:5005")
MEMORY_URL = os.getenv("MEMORY_URL", "http://localhost:5001")
EMBEDDING_URL = os.getenv("EMBEDDING_TES_V2_URL", "http://localhost:5004/tes/build")
REQUEST_TIMEOUT_MS = int(os.getenv("REQUEST_TIMEOUT_MS", "2000"))


app = FastAPI(title=f"Taste Aligner Planner Service {PLANNER_VERSION}")


class ComposeRequestData(BaseModel):
    user_id: Optional[str] = None
    city: Optional[str] = None
    tags: Optional[List[str]] = None
    constraints: Optional[Dict[str, Any]] = None
    controls: Optional[Dict[str, Any]] = None
    cz_ranked: Optional[List[Dict[str, Any]]] = None
    ez_ranked: Optional[List[Dict[str, Any]]] = None
    mix_policy: Optional[Dict[str, Any]] = None
    decision_trace: Optional[Dict[str, Any]] = None


class ComposeRequest(BaseModel):
    data: ComposeRequestData = Field(...)


def _timeout_sec() -> float:
    return max(0.2, REQUEST_TIMEOUT_MS / 1000.0)


def _build_memory_anchor(result: Dict[str, Any]) -> Dict[str, Any]:
    memory_id = result.get("memory_id")
    weight = result.get("score")
    city_boost = result.get("city_boost", 1.0)
    tag_boost = result.get("tag_boost", 1.0)

    reasons = []
    if city_boost and city_boost > 1.0:
        reasons.append("same_city")
    if tag_boost and tag_boost > 1.0:
        reasons.append("tag_overlap")
    why = "_".join(reasons) if reasons else "memory_match"

    return {
        "memory_id": memory_id,
        "weight": weight,
        "why": why
    }


def _merge_trace_dict(base: Dict[str, Any], extra: Dict[str, Any]) -> Dict[str, Any]:
    merged = dict(base or {})
    for key, value in (extra or {}).items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _merge_trace_dict(merged[key], value)
        else:
            merged[key] = value
    return merged


def _is_ranked_list(value: Any) -> bool:
    if not isinstance(value, list):
        return False
    return all(isinstance(item, dict) for item in value)


def _coerce_trace(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return value
    return {}


def _fetch_recommendation_payload(
    user_id: str,
    city: str,
    tags: List[str],
    headers: Dict[str, str],
) -> tuple[Optional[Dict[str, Any]], int, Optional[str]]:
    reco_start = time.time()
    try:
        reco_resp = requests.post(
            f"{RECO_URL}/score",
            json={
                "data": {
                    "user_id": user_id,
                    "city": city,
                    "tags": tags
                }
            },
            timeout=_timeout_sec(),
            headers=headers
        )
    except Exception as e:
        return None, int((time.time() - reco_start) * 1000), f"recommendation_service_error: {e}"

    reco_latency = int((time.time() - reco_start) * 1000)
    if reco_resp.status_code != 200:
        return None, reco_latency, f"recommendation_service_status_{reco_resp.status_code}"

    return reco_resp.json(), reco_latency, None


@app.get("/health")
async def health():
    return {"ok": True, "service": "planner", "version": PLANNER_VERSION}


@app.post("/compose")
async def compose(payload: ComposeRequest):
    trace_id = f"p_{uuid.uuid4().hex[:8]}"
    start_total = time.time()

    normalized = normalize_input(payload.data.dict(exclude_none=True))
    user_id = normalized["user_id"]
    city = normalized["city"]
    tags = normalized["tags"]
    controls = normalized["controls"]

    headers = {"X-Trace-Id": trace_id}
    payload_data = payload.data

    upstream_cz = payload_data.cz_ranked
    upstream_ez = payload_data.ez_ranked
    upstream_mix_policy = payload_data.mix_policy
    upstream_trace = _coerce_trace(payload_data.decision_trace)

    planner_mode = "trust_upstream"
    used_upstream_rankings = True
    rescored = False
    fallback_reason: Optional[str] = None
    reco_latency: Optional[int] = None
    reco_payload: Optional[Dict[str, Any]] = None

    upstream_fields_present = (
        upstream_cz is not None and
        upstream_ez is not None and
        upstream_mix_policy is not None
    )

    if not upstream_fields_present:
        planner_mode = "fallback_rescore"
        used_upstream_rankings = False
        rescored = True
        fallback_reason = "missing_upstream_rankings"
    elif not _is_ranked_list(upstream_cz) or not _is_ranked_list(upstream_ez) or not isinstance(upstream_mix_policy, dict):
        planner_mode = "fallback_rescore"
        used_upstream_rankings = False
        rescored = True
        fallback_reason = "invalid_upstream_structure"

    if planner_mode == "trust_upstream":
        reco_payload = {
            "cz_ranked": upstream_cz or [],
            "ez_ranked": upstream_ez or [],
            "mix_policy": upstream_mix_policy or {},
            "decision_trace": upstream_trace,
            "version": "upstream_passthrough"
        }

        selected_cz, selected_ez, selection_debug = select_items_for_cards(
            reco_payload, city, controls
        )

        if len(selected_cz) + len(selected_ez) == 0:
            planner_mode = "fallback_rescore"
            used_upstream_rankings = False
            rescored = True
            fallback_reason = "upstream_empty_after_selection"
    else:
        selected_cz, selected_ez, selection_debug = [], [], {}

    if planner_mode == "fallback_rescore":
        reco_payload, reco_latency, reco_error = _fetch_recommendation_payload(
            user_id=user_id,
            city=city,
            tags=tags,
            headers=headers
        )
        if reco_payload is None:
            return {
                "ok": False,
                "service": "planner",
                "version": PLANNER_VERSION,
                "trace_id": trace_id,
                "detail": reco_error
            }

        selected_cz, selected_ez, selection_debug = select_items_for_cards(
            reco_payload, city, controls
        )

    # Memory anchors
    anchors_by_item: Dict[str, List[Dict[str, Any]]] = {}
    memory_latency = None
    memory_version = "unknown"
    memory_health_ok = False
    memory_start = time.time()

    try:
        health_resp = requests.get(
            f"{MEMORY_URL}/health",
            timeout=_timeout_sec(),
            headers=headers
        )
        if health_resp.status_code == 200:
            memory_health = health_resp.json()
            memory_version = memory_health.get("version", "unknown")
            memory_health_ok = True
    except Exception:
        memory_health_ok = False

    if memory_health_ok:
        max_requests = min(len(selected_cz), 5)
        for item in selected_cz[:max_requests]:
            item_id = item.get("id")
            query_tags = item.get("tags") or tags
            if not query_tags:
                anchors_by_item[item_id] = []
                continue
            try:
                embedding_resp = requests.post(
                    EMBEDDING_URL,
                    json={
                        "tags": query_tags,
                        "normalize": True
                    },
                    timeout=_timeout_sec(),
                    headers=headers
                )
                query_embedding = embedding_resp.json().get("vector") if embedding_resp.status_code == 200 else None
                if (
                    not isinstance(query_embedding, list) or
                    len(query_embedding) != 512 or
                    not all(isinstance(value, (int, float)) and math.isfinite(value) for value in query_embedding)
                ):
                    anchors_by_item[item_id] = []
                    continue
                mem_resp = requests.post(
                    f"{MEMORY_URL}/search",
                    json={
                        "data": {
                            "user_id": user_id,
                            "query_embedding": query_embedding,
                            "query_tags": query_tags,
                            "city": city,
                            "top_k": 1
                        }
                    },
                    timeout=_timeout_sec(),
                    headers=headers
                )
                if mem_resp.status_code == 200:
                    results = mem_resp.json().get("results", [])
                    if results:
                        anchors_by_item[item_id] = [_build_memory_anchor(results[0])]
                    else:
                        anchors_by_item[item_id] = []
                else:
                    anchors_by_item[item_id] = []
            except Exception:
                anchors_by_item[item_id] = []

        memory_latency = int((time.time() - memory_start) * 1000)
    else:
        memory_latency = int((time.time() - memory_start) * 1000)

    cards = assemble_cards(
        {
            "cz_ranked": selected_cz,
            "ez_ranked": selected_ez
        },
        anchors_by_item,
        normalized,
        controls
    )

    planner_trace = selection_debug.get("planner_trace", {})
    planner_trace = _merge_trace_dict(
        planner_trace,
        {
            "planner_mode": planner_mode,
            "used_upstream_rankings": used_upstream_rankings,
            "rescored": rescored,
            "upstream_cz_count": len(upstream_cz) if isinstance(upstream_cz, list) else 0,
            "upstream_ez_count": len(upstream_ez) if isinstance(upstream_ez, list) else 0,
            "cards_generated": len(cards),
            "compose": {
                "rule_id": "planner_compose_v1",
                "cards_count": len(cards),
                "cz_count": len(selected_cz),
                "ez_count": len(selected_ez)
            }
        }
    )
    if fallback_reason:
        planner_trace["fallback_reason"] = fallback_reason

    reco_trace = _coerce_trace(reco_payload.get("decision_trace", {}) if reco_payload else {})
    decision_trace = _merge_trace_dict(reco_trace, {"planner": planner_trace})

    response = {
        "ok": True,
        "service": "planner",
        "version": PLANNER_VERSION,
        "trace_id": trace_id,
        "input_echo": normalized,
        "mix_policy": reco_payload.get("mix_policy"),
        "cards": cards,
        "decision_trace": decision_trace,
        "debug": {
            "services": {
                "recommendation": {
                    "url": RECO_URL,
                    "latency_ms": reco_latency,
                    "version": reco_payload.get("version", "unknown") if reco_payload else "unknown"
                },
                "memory": {
                    "url": MEMORY_URL,
                    "latency_ms": memory_latency,
                    "version": memory_version
                }
            },
            "selection": selection_debug,
            "planner_mode": planner_mode,
            "used_upstream_rankings": used_upstream_rankings,
            "rescored": rescored
        }
    }

    response["debug"]["total_latency_ms"] = int((time.time() - start_total) * 1000)
    return response


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PLANNER_PORT)
