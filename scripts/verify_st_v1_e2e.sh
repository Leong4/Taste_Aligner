#!/usr/bin/env bash
set -euo pipefail

# Strict E2E verification for st_v1 path:
# embedding /health -> embedding warmup -> gateway /tool/embedding.tes_build -> agent_runtime /run

EMBED_BASE_URL="${EMBED_BASE_URL:-http://localhost:5004}"
GATEWAY_BASE_URL="${GATEWAY_BASE_URL:-http://localhost:8080}"
AGENT_RUNTIME_BASE_URL="${AGENT_RUNTIME_BASE_URL:-http://localhost:8787}"

# Optional override, otherwise derived from AGENT_RUNTIME_BASE_URL
if [ -n "${AGENT_RUN_URL:-}" ]; then
  AGENT_RUN_URL="$AGENT_RUN_URL"
else
  AGENT_RUN_URL="${AGENT_RUNTIME_BASE_URL}/run"
fi

TES_REQ='{"tags":["ramen","izakaya"],"vision_features":["night"],"sentiment":0.4,"recency_days":3,"location":"tokyo","normalize":true}'

echo "=== Step 1: embedding /health ==="
curl -sS "${EMBED_BASE_URL}/health" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("ok") is True, f"/health not ok: {d}"; assert d.get("backend") == "st_v1", f"backend is not st_v1: {d.get('"'"'backend'"'"')}"; print(f"health: backend={d.get('"'"'backend'"'"')} model_id={d.get('"'"'model_id'"'"')} device={d.get('"'"'device'"'"')} warm={d.get('"'"'warm'"'"')}")'

echo "=== Step 2: warm-up embedding /tes/build (direct) ==="
curl -sS -X POST "${EMBED_BASE_URL}/tes/build" -H 'Content-Type: application/json' -d "${TES_REQ}" \
  | python3 -c 'import json,math,sys; d=json.load(sys.stdin); v=d.get("vector"); assert isinstance(v,list), "vector is not list"; assert len(v)==512, f"vector len={len(v)}"; assert d.get("dim")==512, f"dim={d.get('"'"'dim'"'"')}"; assert d.get("normalized") is True, f"normalized={d.get('"'"'normalized'"'"')}"; meta=d.get("meta",{}); assert meta.get("backend")=="st_v1", f"meta.backend={meta.get('"'"'backend'"'"')}"; n=math.sqrt(sum(float(x)*float(x) for x in v)); assert abs(n-1.0)<1e-3, f"norm={n}"; print(f"warmup: backend={meta.get('"'"'backend'"'"')} model_id={meta.get('"'"'model_id'"'"')}")'

echo "=== Step 3: gateway /tool/embedding.tes_build ==="
curl -sS -X POST "${GATEWAY_BASE_URL}/tool/embedding.tes_build" -H 'Content-Type: application/json' -d "${TES_REQ}" \
  | python3 -c 'import json,math,sys; d=json.load(sys.stdin); v=d.get("vector"); assert isinstance(v,list), "vector is not list"; assert len(v)==512, f"vector len={len(v)}"; assert d.get("dim")==512, f"dim={d.get('"'"'dim'"'"')}"; assert d.get("normalized") is True, f"normalized={d.get('"'"'normalized'"'"')}"; meta=d.get("meta",{}); assert meta.get("backend")=="st_v1", f"meta.backend={meta.get('"'"'backend'"'"')}"; assert meta.get("tes_version")=="2.0", f"tes_version={meta.get('"'"'tes_version'"'"')}"; assert isinstance(meta.get("model_id"),str) and meta.get("model_id"), "meta.model_id missing"; n=math.sqrt(sum(float(x)*float(x) for x in v)); assert abs(n-1.0)<1e-3, f"norm={n}"; print(f"gateway tes_build: dim={d.get('"'"'dim'"'"')} backend={meta.get('"'"'backend'"'"')} model_id={meta.get('"'"'model_id'"'"')}")'

echo "=== Step 4: determinism hash (same payload x2 via gateway) ==="
V1="$(curl -sS -X POST "${GATEWAY_BASE_URL}/tool/embedding.tes_build" -H 'Content-Type: application/json' -d "${TES_REQ}" \
  | python3 -c 'import json,sys,hashlib; d=json.load(sys.stdin); s=",".join(f"{float(x):.6f}" for x in d["vector"]); print(hashlib.sha256(s.encode()).hexdigest())')"
V2="$(curl -sS -X POST "${GATEWAY_BASE_URL}/tool/embedding.tes_build" -H 'Content-Type: application/json' -d "${TES_REQ}" \
  | python3 -c 'import json,sys,hashlib; d=json.load(sys.stdin); s=",".join(f"{float(x):.6f}" for x in d["vector"]); print(hashlib.sha256(s.encode()).hexdigest())')"
echo "hash1=${V1}"
echo "hash2=${V2}"
test "${V1}" = "${V2}"
echo "determinism: PASS"

echo "=== Step 5: agent_runtime /run trace evidence ==="

TMP_RESP="$(mktemp -t taste_aligner_run.XXXXXX.json)"
trap 'rm -f "$TMP_RESP"' EXIT

HTTP_CODE="$(curl -sS -o "$TMP_RESP" -w "%{http_code}" -X POST "$AGENT_RUN_URL" \
  -H 'Content-Type: application/json' \
  -d '{"text":"I want to travel to tokyo for food and ramen.","user_id":"u001"}')"

if [ "$HTTP_CODE" != "200" ]; then
  echo "FAIL: agent_runtime /run returned HTTP $HTTP_CODE"
  echo "URL: $AGENT_RUN_URL"
  echo "Body (first 500 chars):"
  head -c 500 "$TMP_RESP" || true
  echo
  exit 1
fi

python3 - <<'PY' "$TMP_RESP"
import json, sys

path = sys.argv[1]
raw = open(path, 'rb').read()
if not raw.strip():
    raise SystemExit("FAIL: /run returned empty body")

try:
    d = json.loads(raw)
except Exception as e:
    # Print a small prefix for debugging
    prefix = raw[:500].decode('utf-8', errors='replace')
    raise SystemExit(f"FAIL: /run body is not valid JSON: {e}\nBody prefix (500): {prefix}")

dt = d.get("decision_trace") or {}

tb = dt.get("tes_builder") or {}
rr = dt.get("rerank") or {}

ok_tb = (tb.get("backend") == "st_v1")
ok_rr = (rr.get("tes_backend") == "st_v1")

if not (ok_tb or ok_rr):
    raise SystemExit(
        "FAIL: missing st_v1 backend evidence in trace: "
        f"tes_builder.backend={tb.get('backend')}, rerank.tes_backend={rr.get('tes_backend')}"
    )

if rr.get("tes_used") is not True:
    raise SystemExit(f"FAIL: rerank.tes_used={rr.get('tes_used')}")

if tb.get("fallback_used") is True and not tb.get("fallback_reason"):
    raise SystemExit("FAIL: tes_builder fallback_used=true but fallback_reason missing")

print(
    "PASS: /run trace evidence: "
    f"tes_builder.backend={tb.get('backend')} "
    f"rerank.tes_backend={rr.get('tes_backend')} rerank.tes_used={rr.get('tes_used')}"
)
PY

echo "verify_st_v1_e2e: PASS"
