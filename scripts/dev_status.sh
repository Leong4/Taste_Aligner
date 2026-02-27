#!/usr/bin/env bash
# scripts/dev_status.sh  --  Print a status table for all Taste_Aligner services.
#
# Usage:
#   ./scripts/dev_status.sh [--logs-dir PATH] [--strict]
#
# Shows: service name, port, PID (if tracked), HTTP status, and for the
# embedding service the active backend from /health.
#
# Strict mode:
#   --strict  Exit 1 when any CORE service is not UP/healthy.
#             Default mode keeps current behavior (print-only, no strict exit).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOGS_DIR="${LOGS_DIR:-$REPO_ROOT/logs}"
STRICT=false

while [ "$#" -gt 0 ]; do
    case "$1" in
        --logs-dir)
            shift
            LOGS_DIR="${1:?'--logs-dir requires a path'}"
            ;;
        --strict)
            STRICT=true
            ;;
        -h|--help)
            echo "Usage: $0 [--logs-dir PATH] [--strict]"
            exit 0
            ;;
        *)
            echo "[dev_status] ERROR: Unknown option: $1" >&2
            exit 1
            ;;
    esac
    shift
done

PIDS_FILE="$LOGS_DIR/pids.env"

pid_alive()   { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
port_in_use() { lsof -ti tcp:"$1" > /dev/null 2>&1; }

saved_pid() {
    local key="${1}_PID"
    [ -f "$PIDS_FILE" ] || { echo ""; return; }
    grep "^${key}=" "$PIDS_FILE" 2>/dev/null | cut -d= -f2 | head -1 || true
}

# Query an HTTP endpoint; prints "CODE BODY"
# Note: curl already writes "000" via -w when it can't connect, so we must NOT
# use "|| echo '000'" inside $() or the code becomes "000000".
http_health() {
    local url="$1"
    local tmp code body
    tmp="$(mktemp)"
    code="$(curl -so "$tmp" -w '%{http_code}' \
        --connect-timeout 2 --max-time 4 "$url" 2>/dev/null)" || true
    code="${code:-000}"
    body="$(cat "$tmp" 2>/dev/null || true)"
    rm -f "$tmp"
    printf '%s %s' "$code" "$body"
}

json_get() {
    python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(d.get('$2',''))" \
        "$1" 2>/dev/null || echo ""
}

# ---------------------------------------------------------------------------
# Service list
# Format per line: KEY  PORT  HEALTH_URL_OR_DASH  LABEL
# ---------------------------------------------------------------------------
SERVICES="
MEMORY          5001  http://localhost:5001/health  memory
EMBEDDING       5004  http://localhost:5004/health  embedding
RECOMMENDATION  5005  http://localhost:5005/health  recommendation
PLANNER         5006  http://localhost:5006/health  planner
GATEWAY         8080  http://localhost:8080/health  gateway
AGENT_RUNTIME   8787  -                             agent_runtime
VISION          5002  http://localhost:5002/health  vision
ONTOLOGY        5003  http://localhost:5003/health  ontology
"

# ---------------------------------------------------------------------------
# Print table
# ---------------------------------------------------------------------------
SEP="------------------------------------------------------------------------"
printf "\n"
printf "%-22s %-6s %-8s %-10s %s\n" "SERVICE" "PORT" "PID" "STATUS" "DETAIL"
printf "%s\n" "$SEP"

OVERALL_OK=true
CORE_OK=true

while read -r key port health_url label; do
    case "$key" in ""|\#*) continue ;; esac
    [ -n "$key" ] || continue

    our_pid="$(saved_pid "$key")"
    if pid_alive "$our_pid"; then
        pid_disp="$our_pid"
    else
        pid_disp="-"
    fi

    detail=""
    status="DOWN"

    if [ "$health_url" = "-" ]; then
        # TCP-only check (agent_runtime has no /health)
        if port_in_use "$port"; then
            status="UP"
            detail="(tcp only)"
        else
            OVERALL_OK=false
        fi
    else
        read -r code body <<EOF_HH
$(http_health "$health_url")
EOF_HH
        case "$code" in
            2*)
                status="UP"
                if [ "$key" = "EMBEDDING" ]; then
                    be="$(json_get "$body" "backend")"
                    warm="$(json_get "$body" "warm")"
                    detail="backend=$be  warm=$warm"
                fi
                ;;
            000)
                status="DOWN"
                detail="(no response)"
                OVERALL_OK=false
                ;;
            *)
                status="DEGRADED"
                detail="(HTTP $code)"
                OVERALL_OK=false
                ;;
        esac
    fi

    printf "%-22s %-6s %-8s %-10s %s\n" "$label" "$port" "$pid_disp" "$status" "$detail"

    is_core=false
    case "$key" in
        MEMORY|EMBEDDING|RECOMMENDATION|PLANNER|GATEWAY|AGENT_RUNTIME)
            is_core=true
            ;;
    esac
    if [ "$is_core" = "true" ] && [ "$status" != "UP" ]; then
        CORE_OK=false
    fi

done <<EOF
$SERVICES
EOF

printf "%s\n" "$SEP"

if [ "$OVERALL_OK" = "true" ]; then
    echo "  All services healthy"
else
    echo "  One or more services are DOWN or DEGRADED"
fi

printf "\n"
[ -f "$PIDS_FILE" ] \
    && echo "  PIDs file : $PIDS_FILE" \
    || echo "  PIDs file : not found (services may have been started externally)"
echo "  Logs dir  : $LOGS_DIR/"
printf "\n"

if [ "$STRICT" = "true" ] && [ "$CORE_OK" != "true" ]; then
    echo "[dev_status] STRICT: one or more CORE services are not UP" >&2
    exit 1
fi
