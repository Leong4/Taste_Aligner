#!/usr/bin/env bash
set -euo pipefail

MEMORY_URL="${MEMORY_URL:-http://localhost:5001}"
EMBED_URL="${EMBED_URL:-http://localhost:5004}"
RECO_URL="${RECO_URL:-http://localhost:5005}"
PLANNER_URL="${PLANNER_URL:-http://localhost:5006}"
GATEWAY_URL="${GATEWAY_URL:-http://localhost:8080}"
AGENT_URL="${AGENT_URL:-http://localhost:8787}"

echo "== Check required ports =="
python3 - <<'PY'
import socket, sys
targets = [
    ("memory", "127.0.0.1", 5001),
    ("embedding", "127.0.0.1", 5004),
    ("recommendation", "127.0.0.1", 5005),
    ("planner", "127.0.0.1", 5006),
    ("gateway", "127.0.0.1", 8080),
    ("agent_runtime", "127.0.0.1", 8787),
]
failed = []
for name, host, port in targets:
    s = socket.socket()
    s.settimeout(1.0)
    try:
        s.connect((host, port))
        print(f"  OK: {name} {host}:{port}")
    except Exception as e:
        failed.append((name, host, port, str(e)))
    finally:
        s.close()
if failed:
    for name, host, port, err in failed:
        print(f"  FAIL: {name} {host}:{port} ({err})")
    sys.exit(1)
PY

call_tool_and_assert_200() {
  local tool="$1"
  local payload="$2"
  local url="${GATEWAY_URL}/tool/${tool}"
  local tmp
  tmp="$(mktemp)"
  local code
  code="$(curl -sS -o "${tmp}" -w '%{http_code}' -X POST "${url}" -H 'Content-Type: application/json' -d "${payload}")"
  if [[ "${code}" != "200" ]]; then
    echo "FAIL: ${tool} returned HTTP ${code}"
    echo "URL: ${url}"
    echo "Body:"
    cat "${tmp}"
    rm -f "${tmp}"
    exit 1
  fi
  echo "  OK: ${tool} -> 200"
  cat "${tmp}" | python3 -c 'import json,sys; json.load(sys.stdin); print("    JSON: valid")'
  rm -f "${tmp}"
}

echo "== Gateway tool checks =="
# Warm-up embedding directly to avoid first-call gateway timeout on cold model load.
curl -sS -X POST "${EMBED_URL}/tes/build" \
  -H 'Content-Type: application/json' \
  -d '{"tags":["warmup"],"normalize":true}' >/dev/null

call_tool_and_assert_200 "memory.search" '{"data":{"user_id":"u001","query_tags":["ramen"],"city":"tokyo","top_k":3}}'
call_tool_and_assert_200 "recommendation.score" '{"data":{"user_id":"u001","city":"tokyo","tags":["ramen","food"],"intent":"balanced","memory_confidence":0.7}}'
call_tool_and_assert_200 "embedding.tes_build" '{"tags":["ramen","izakaya"],"vision_features":["night"],"sentiment":0.4,"recency_days":2,"location":"tokyo","normalize":true}'
call_tool_and_assert_200 "planner.compose" '{"data":{"user_id":"u001","city":"tokyo","tags":["ramen"],"controls":{"topk_cz":1,"topk_ez":1}}}'

echo "== Agent /run check =="
RUN_TMP="$(mktemp)"
RUN_CODE="$(curl -sS -o "${RUN_TMP}" -w '%{http_code}' -X POST "${AGENT_URL}/run" -H 'Content-Type: application/json' -d '{"text":"I want to travel to tokyo for food and ramen.","user_id":"u001"}')"
if [[ "${RUN_CODE}" != "200" ]]; then
  echo "FAIL: /run returned HTTP ${RUN_CODE}"
  cat "${RUN_TMP}"
  rm -f "${RUN_TMP}"
  exit 1
fi

python3 - "${RUN_TMP}" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as f:
    d = json.load(f)
dt = d.get("decision_trace")
assert isinstance(dt, dict), "decision_trace missing"

fr = dt.get("fetch_recommendation") or {}
assert not (fr.get("fallback_used") is True and fr.get("fallback_reason") == "tool_error"), \
    f"fetch_recommendation tool_error fallback: {fr}"

rr = dt.get("rerank") or {}
assert rr.get("tes_used") is True, f"rerank.tes_used != true: {rr.get('tes_used')}"

tb = dt.get("tes_builder") or {}
tb_backend = tb.get("backend")
rr_backend = rr.get("tes_backend")
assert tb_backend == "st_v1" or rr_backend == "st_v1", \
    f"missing st_v1 backend evidence: tes_builder.backend={tb_backend}, rerank.tes_backend={rr_backend}"

if tb.get("fallback_used") is True:
    assert tb.get("fallback_reason"), "tes_builder fallback_used=true but fallback_reason missing"

print("  OK: /run decision_trace checks passed")
print(f"    tes_builder.backend={tb_backend}")
print(f"    rerank.tes_backend={rr_backend}")
print(f"    rerank.tes_used={rr.get('tes_used')}")
PY

rm -f "${RUN_TMP}"
echo "verify_run_e2e: PASS"
