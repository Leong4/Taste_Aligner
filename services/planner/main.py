"""
Planner Service v1 - Trip Card Composer
"""

from fastapi import FastAPI
from pydantic import BaseModel, Field
from typing import Any, Dict, List, Optional
import os
import uuid
import time
import requests

from .card_builder import normalize_input, select_items_for_cards, assemble_cards


PLANNER_VERSION = "v1"
PLANNER_PORT = int(os.getenv("PLANNER_PORT", "5006"))
RECO_URL = os.getenv("RECO_URL", "http://localhost:5005")
MEMORY_URL = os.getenv("MEMORY_URL", "http://localhost:5001")
REQUEST_TIMEOUT_MS = int(os.getenv("REQUEST_TIMEOUT_MS", "2000"))


app = FastAPI(title=f"Taste Aligner Planner Service {PLANNER_VERSION}")


class ComposeRequestData(BaseModel):
    user_id: Optional[str] = None
    city: Optional[str] = None
    tags: Optional[List[str]] = None
    constraints: Optional[Dict[str, Any]] = None
    controls: Optional[Dict[str, Any]] = None


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

    # Call Recommendation Service
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
        return {
            "ok": False,
            "service": "planner",
            "version": PLANNER_VERSION,
            "trace_id": trace_id,
            "detail": f"Recommendation service error: {e}"
        }
    reco_latency = int((time.time() - reco_start) * 1000)
    if reco_resp.status_code != 200:
        return {
            "ok": False,
            "service": "planner",
            "version": PLANNER_VERSION,
            "trace_id": trace_id,
            "detail": f"Recommendation service returned {reco_resp.status_code}"
        }

    reco_payload = reco_resp.json()

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
                mem_resp = requests.post(
                    f"{MEMORY_URL}/search",
                    json={
                        "data": {
                            "user_id": user_id,
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
            "compose": {
                "rule_id": "planner_compose_v1",
                "cards_count": len(cards),
                "cz_count": len(selected_cz),
                "ez_count": len(selected_ez)
            }
        }
    )
    reco_trace = reco_payload.get("decision_trace", {})
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
                    "version": reco_payload.get("version", "unknown")
                },
                "memory": {
                    "url": MEMORY_URL,
                    "latency_ms": memory_latency,
                    "version": memory_version
                }
            },
            "selection": selection_debug
        }
    }

    response["debug"]["total_latency_ms"] = int((time.time() - start_total) * 1000)
    return response


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PLANNER_PORT)
