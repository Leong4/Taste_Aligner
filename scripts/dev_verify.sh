#!/usr/bin/env bash
# scripts/dev_verify.sh  --  Verify the running Taste_Aligner stack is healthy.
#
# Usage:
#   ./scripts/dev_verify.sh
#
# Exit codes:
#   0  all checks passed
#   1  one or more checks failed
#
# Steps:
#   1. verify_run_e2e.sh   (port checks + gateway tools + /run decision trace)
#   2. verify_st_v1_e2e.sh (embedding st_v1 + determinism + /run st_v1 evidence)
#   3. Smoke: POST gateway /tool/recommendation.score  -> HTTP 200 + valid JSON
#   4. Smoke: POST agent_runtime /run                  -> HTTP 200 + ok=true
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

GATEWAY_URL="${GATEWAY_BASE_URL:-http://localhost:8080}"
AGENT_URL="${AGENT_RUNTIME_URL:-http://localhost:8787}"

PASS=0
FAIL=0

log()  { echo "[dev_verify] $*"; }
_ok()  { echo "[dev_verify] PASS: $*"; PASS=$((PASS + 1)); }
_fail(){ echo "[dev_verify] FAIL: $*" >&2; FAIL=$((FAIL + 1)); }
_warn(){ echo "[dev_verify] WARN: $*" >&2; }

# Run a sub-script; capture exit code without exiting immediately.
run_subscript() {
    local label="$1" script="$2"
    log ""
    log "-- $label --"
    if [ ! -f "$script" ]; then
        _fail "$label: script not found: $script"
        return
    fi
    if bash "$script"; then
        _ok "$label passed"
    else
        _fail "$label FAILED"
    fi
}

# POST a URL, assert HTTP 200 + valid JSON.
check_post() {
    local label="$1" url="$2" payload="$3"
    local tmp code ok_val
    tmp="$(mktemp)"
    code="$(curl -sS -o "$tmp" -w '%{http_code}' \
        -X POST "$url" \
        -H 'Content-Type: application/json' \
        -d "$payload" \
        --connect-timeout 5 --max-time 15 \
        2>/dev/null)" || true
    code="${code:-000}"

    if [ "$code" != "200" ]; then
        _fail "$label -> HTTP $code (expected 200). Body: $(head -c 200 "$tmp" 2>/dev/null)"
        rm -f "$tmp"
        return
    fi

    if ! python3 -c "import json,sys; json.load(sys.stdin)" < "$tmp" 2>/dev/null; then
        _fail "$label -> HTTP 200 but body is not valid JSON"
        rm -f "$tmp"
        return
    fi

    _ok "$label -> HTTP 200, valid JSON"
    rm -f "$tmp"
}

# ---------------------------------------------------------------------------
# Step 1: Full e2e (port + all gateway tools + /run trace)
# ---------------------------------------------------------------------------
run_subscript "verify_run_e2e" "$SCRIPT_DIR/verify_run_e2e.sh"

# ---------------------------------------------------------------------------
# Step 2: st_v1 path (embedding /health + /tes/build + determinism + /run)
# ---------------------------------------------------------------------------
run_subscript "verify_st_v1_e2e" "$SCRIPT_DIR/verify_st_v1_e2e.sh"

# ---------------------------------------------------------------------------
# Step 3: Gateway smoke -- recommendation.score
# ---------------------------------------------------------------------------
log ""
log "-- Smoke: gateway /tool/recommendation.score --"
check_post \
    "recommendation.score via gateway" \
    "$GATEWAY_URL/tool/recommendation.score" \
    '{"data":{"user_id":"u001","city":"tokyo","tags":["ramen","izakaya"],"intent":"casual","memory_confidence":0.5}}'

# ---------------------------------------------------------------------------
# Step 4: Agent Runtime smoke -- /run -> ok:true
# ---------------------------------------------------------------------------
log ""
log "-- Smoke: agent_runtime POST /run --"

TMP_RUN="$(mktemp)"
RUN_CODE="$(curl -sS -o "$TMP_RUN" -w '%{http_code}' \
    -X POST "$AGENT_URL/run" \
    -H 'Content-Type: application/json' \
    -d '{"text":"I want ramen in Tokyo for dinner","user_id":"u001"}' \
    --connect-timeout 5 --max-time 30 \
    2>/dev/null)" || true
RUN_CODE="${RUN_CODE:-000}"

if [ "$RUN_CODE" != "200" ]; then
    _fail "POST /run -> HTTP $RUN_CODE (expected 200). Body: $(head -c 300 "$TMP_RUN")"
else
    RUN_OK="$(python3 -c \
        "import json,sys; d=json.load(sys.stdin); print(d.get('ok',''))" \
        < "$TMP_RUN" 2>/dev/null || echo '')"
    case "$RUN_OK" in
        True|true)  _ok "POST /run -> HTTP 200, ok=true" ;;
        *)          _fail "POST /run -> HTTP 200 but ok='$RUN_OK'. Body: $(head -c 300 "$TMP_RUN")" ;;
    esac
fi
rm -f "$TMP_RUN"

# ---------------------------------------------------------------------------
# Step 5: Vision smoke tests (gated on vision service being up)
# ---------------------------------------------------------------------------
VISION_URL="${VISION_URL:-http://localhost:5002}"
VISION_UP=false
_vision_code="$(curl -so /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 4 \
    "$VISION_URL/health" 2>/dev/null)" || true
_vision_code="${_vision_code:-000}"
if [ "$_vision_code" = "200" ]; then
    VISION_UP=true
fi

if [ "$VISION_UP" = "true" ]; then
    log ""
    log "-- Smoke: vision.describe gateway (vision service detected on $VISION_URL) --"

    # Tiny 1x1 PNG
    TINY_PNG="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

    TMP_VD="$(mktemp)"
    VD_CODE="$(curl -sS -o "$TMP_VD" -w '%{http_code}' \
        -X POST "$GATEWAY_URL/tool/vision.describe" \
        -H 'Content-Type: application/json' \
        -d "{\"data\":{\"image_base64\":\"$TINY_PNG\",\"top_k\":5}}" \
        --connect-timeout 5 --max-time 20 \
        2>/dev/null)" || true
    VD_CODE="${VD_CODE:-000}"

    if [ "$VD_CODE" != "200" ]; then
        _warn "vision.describe gateway smoke -> HTTP $VD_CODE (non-blocking optional smoke). Body: $(head -c 200 "$TMP_VD")"
    else
        VD_TAGS="$(python3 -c \
            "import json,sys; d=json.load(sys.stdin); print(type(d.get('tags','')).__name__)" \
            < "$TMP_VD" 2>/dev/null || echo '')"
        if [ "$VD_TAGS" = "list" ]; then
            _ok "vision.describe gateway smoke -> HTTP 200, tags=list"
        else
            _warn "vision.describe gateway smoke -> HTTP 200 but tags not a list (non-blocking optional smoke). Body: $(head -c 200 "$TMP_VD")"
        fi
    fi
    rm -f "$TMP_VD"

    # Agent /run with image_base64
    log ""
    log "-- Smoke: agent_runtime POST /run with image_base64 --"
    TMP_VR="$(mktemp)"
    VR_CODE="$(curl -sS -o "$TMP_VR" -w '%{http_code}' \
        -X POST "$AGENT_URL/run" \
        -H 'Content-Type: application/json' \
        -d "{\"text\":\"I want ramen in Tokyo\",\"user_id\":\"u001\",\"image_base64\":\"$TINY_PNG\"}" \
        --connect-timeout 5 --max-time 30 \
        2>/dev/null)" || true
    VR_CODE="${VR_CODE:-000}"

    if [ "$VR_CODE" != "200" ]; then
        _warn "POST /run (with image) -> HTTP $VR_CODE (non-blocking optional smoke). Body: $(head -c 300 "$TMP_VR")"
    else
        VR_VD_USED="$(python3 -c \
            "import json,sys; d=json.load(sys.stdin); dt=d.get('decision_trace',{}); vd=dt.get('vision_describe',{}); print(vd.get('used',''))" \
            < "$TMP_VR" 2>/dev/null || echo '')"
        case "$VR_VD_USED" in
            True|true) _ok "POST /run (with image) -> vision_describe.used=true" ;;
            *) _warn "POST /run (with image) -> vision_describe.used='$VR_VD_USED' (non-blocking optional smoke). Body: $(head -c 300 "$TMP_VR")" ;;
        esac
    fi
    rm -f "$TMP_VR"
else
    log ""
    log "-- Smoke: vision skipped (vision service not running on $VISION_URL) --"
    log "   Start with: ./scripts/dev_up.sh   (default) or ./scripts/dev_up.sh --core --with-vision"
fi

# ---------------------------------------------------------------------------
# Step 6: Ontology normalize smoke (gated on ontology service being up)
# ---------------------------------------------------------------------------
ONTOLOGY_URL="${ONTOLOGY_URL:-http://localhost:5003}"
ONTOLOGY_UP=false
_ontology_code="$(curl -so /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 4 \
    "$ONTOLOGY_URL/health" 2>/dev/null)" || true
_ontology_code="${_ontology_code:-000}"
if [ "$_ontology_code" = "200" ]; then
    ONTOLOGY_UP=true
fi

if [ "$ONTOLOGY_UP" = "true" ]; then
    log ""
    log "-- Smoke: ontology.normalize gateway contract --"
    # Optional by default: ontology is not part of /run critical path.
    if node "$REPO_ROOT/tests/integration/ontology_normalize_gateway_smoke.js"; then
        _ok "ontology.normalize gateway smoke passed"
    else
        _warn "ontology.normalize gateway smoke FAILED (non-blocking optional smoke)"
    fi
else
    log ""
    log "-- Smoke: ontology skipped (ontology service not running on $ONTOLOGY_URL) --"
    log "   Start with: ./scripts/dev_up.sh   (default) or ./scripts/dev_up.sh --core --with-ontology"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
log ""
log "======================================================================"
log "  dev_verify: PASS=$PASS  FAIL=$FAIL"
log "======================================================================"

if [ "$FAIL" -gt 0 ]; then
    echo "[dev_verify] FAILED -- $FAIL check(s) did not pass. See output above." >&2
    exit 1
fi
log "All checks passed."
