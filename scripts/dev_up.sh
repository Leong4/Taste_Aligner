#!/usr/bin/env bash
# scripts/dev_up.sh  --  Start Taste_Aligner services for local development.
#
# Usage:
#   ./scripts/dev_up.sh [OPTIONS]
#
# Options:
#   --core           Start core 6 only (disable vision + ontology)
#   --all            Start core + vision + ontology
#   --with-vision    Enable vision service (useful after --core)
#   --with-ontology  Enable ontology service (useful after --core)
#   --with-llm       Enable real LLM (openai_compat). Reads LLM_API_KEY /
#                    LLM_BASE_URL / LLM_MODEL from env or .env.local.
#                    Without this flag the adapter stays mock even if
#                    .env.local contains LLM_API_KEY (opt-in by design).
#   --no-verify      Skip the post-start dev_verify step
#   --logs-dir PATH  Log/PID directory  (default: ./logs)
#   -h, --help       Show this help
#
# Default starts ALL services:
#   core + vision + ontology
#
# CORE-only mode:
#   ./scripts/dev_up.sh --core
#
# CORE services:
#   memory (5001), embedding/st_v1 (5004), recommendation (5005),
#   planner (5006), gateway (8080), agent_runtime (8787)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_DIR="$REPO_ROOT/.venv"
PYTHON_BIN="$VENV_DIR/bin/python"
PIP_BIN="$VENV_DIR/bin/pip"

LOGS_DIR="$REPO_ROOT/logs"
START_VISION=true
START_ONTOLOGY=true
ENABLE_LLM=false
RUN_VERIFY=true
DEV_UP_DEBUG="${DEV_UP_DEBUG:-0}"

# ---------------------------------------------------------------------------
# Argument parsing  (POSIX-compatible [ ] to avoid bash 3.2 [[]] quirks)
# ---------------------------------------------------------------------------
while [ "$#" -gt 0 ]; do
    case "$1" in
        --core)          START_VISION=false; START_ONTOLOGY=false ;;
        --all)           START_VISION=true; START_ONTOLOGY=true ;;
        --with-vision)   START_VISION=true ;;
        --with-ontology) START_ONTOLOGY=true ;;
        --with-llm)      ENABLE_LLM=true ;;
        --no-verify)     RUN_VERIFY=false ;;
        --logs-dir)
            shift
            LOGS_DIR="${1:?'--logs-dir requires a path argument'}"
            ;;
        -h|--help)
            grep '^#' "$0" | grep -v '#!/' | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "[dev_up] ERROR: Unknown option: $1" >&2
            exit 1
            ;;
    esac
    shift
done

# ---------------------------------------------------------------------------
# LLM env loading (opt-in)
# Only load secrets from .env.local when --with-llm is explicitly passed.
# This prevents accidental API spending.
# ---------------------------------------------------------------------------
if [ "$ENABLE_LLM" = "true" ]; then
    if [ -f "$REPO_ROOT/.env.local" ]; then
        set -a
        # shellcheck disable=SC1091
        . "$REPO_ROOT/.env.local" || true
        set +a
    fi
    # If user didn't set a provider explicitly, default to openai_compat when LLM is enabled.
    export LLM_PROVIDER="${LLM_PROVIDER:-openai_compat}"
fi

# ---------------------------------------------------------------------------
# LLM opt-in enforcement
# Clear any LLM credentials that may have been loaded from .env.local unless
# --with-llm was explicitly passed.  This prevents accidental API spending.
# ---------------------------------------------------------------------------
if [ "$ENABLE_LLM" = "false" ]; then
    unset LLM_API_KEY LLM_PROVIDER LLM_BASE_URL LLM_MODEL LLM_MAX_RETRIES 2>/dev/null || true
fi

PIDS_FILE="$LOGS_DIR/pids.env"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log()  { echo "[dev_up] $*"; }
warn() { echo "[dev_up] WARN: $*" >&2; }
die()  { echo "[dev_up] ERROR: $*" >&2; exit 1; }
debug() {
    if [ "$DEV_UP_DEBUG" = "1" ]; then
        echo "[dev_up][debug] $*" >&2
    fi
}

port_in_use() {
    debug "check LISTEN port: lsof -nP -tiTCP:$1 -sTCP:LISTEN"
    lsof -nP -tiTCP:"$1" -sTCP:LISTEN > /dev/null 2>&1
}
port_pid() {
    debug "resolve LISTEN pid: lsof -nP -tiTCP:$1 -sTCP:LISTEN"
    lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1 || true
}
pid_alive()   { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
pid_listens_on_port() {
    local pid="$1" port="$2"
    [ -n "${pid:-}" ] || return 1
    debug "check pid listens: lsof -nP -a -p $pid -iTCP:$port -sTCP:LISTEN"
    lsof -nP -a -p "$pid" -iTCP:"$port" -sTCP:LISTEN > /dev/null 2>&1
}

saved_pid() {
    local key="${1}_PID"
    [ -f "$PIDS_FILE" ] || { echo ""; return; }
    grep "^${key}=" "$PIDS_FILE" 2>/dev/null | cut -d= -f2 | head -1 || true
}

# Write/overwrite a KEY_PID=value line  (macOS safe: no sed -i '')
save_pid() {
    local key="${1}_PID" pid="$2"
    mkdir -p "$(dirname "$PIDS_FILE")"
    if [ -f "$PIDS_FILE" ]; then
        local tmp="${PIDS_FILE}.tmp"
        grep -v "^${key}=" "$PIDS_FILE" > "$tmp" 2>/dev/null || true
        mv "$tmp" "$PIDS_FILE"
    fi
    echo "${key}=${pid}" >> "$PIDS_FILE"
}

clear_saved_pid() {
    local key="${1}_PID"
    [ -f "$PIDS_FILE" ] || return 0
    local tmp="${PIDS_FILE}.tmp"
    grep -v "^${key}=" "$PIDS_FILE" > "$tmp" 2>/dev/null || true
    mv "$tmp" "$PIDS_FILE"
}

port_process_details() {
    local port="$1"
    local pid
    pid="$(port_pid "$port")"
    [ -n "$pid" ] || return 0
    ps -p "$pid" -o pid=,command= 2>/dev/null | sed 's/^ *//' || true
}

# Returns 0 = proceed, 1 = skip (already ours), exits on unknown conflict
check_port_idempotent() {
    local key="$1" port="$2" label="$3"
    local our_pid
    our_pid="$(saved_pid "$key")"
    if pid_alive "$our_pid"; then
        if pid_listens_on_port "$our_pid" "$port"; then
            log "  -> $label already running (PID=$our_pid, port=$port) -- skipping"
            return 1
        fi
        warn "Removing stale PID entry for $label: PID=$our_pid is alive but not listening on port $port"
        clear_saved_pid "$key"
    elif [ -n "$our_pid" ]; then
        warn "Removing stale PID entry for $label: PID=$our_pid is not alive"
        clear_saved_pid "$key"
    fi
    if port_in_use "$port"; then
        local intruder
        local details
        intruder="$(port_pid "$port")"
        details="$(port_process_details "$port")"
        die "Port $port is occupied by a LISTEN process (PID=$intruder).
  Process: ${details:-unknown}
  Stop it first or run: ./scripts/dev_down.sh
  Tip: set DEV_UP_DEBUG=1 to print port-check commands."
    fi
    return 0
}

wait_http() {
    local label="$1" url="$2" max="${3:-40}" delay="${4:-3}" loghint="${5:-}"
    local i=0
    log "  Waiting for $label ..."
    while [ "$i" -lt "$max" ]; do
        if curl -sf --connect-timeout 2 --max-time 4 "$url" > /dev/null 2>&1; then
            log "  OK: $label ready"
            return 0
        fi
        i=$((i + 1))
        printf "    attempt %d/%d\r" "$i" "$max"
        sleep "$delay"
    done
    printf "\n"
    die "$label did not become healthy after $((max * delay))s.${loghint:+ Check $loghint}"
}

wait_tcp() {
    local label="$1" host="$2" port="$3" max="${4:-30}" delay="${5:-2}"
    local i=0
    log "  Waiting for $label (tcp $host:$port) ..."
    while [ "$i" -lt "$max" ]; do
        if /usr/bin/nc -z -w1 "$host" "$port" 2>/dev/null; then
            log "  OK: $label ready"
            return 0
        fi
        i=$((i + 1))
        printf "    attempt %d/%d\r" "$i" "$max"
        sleep "$delay"
    done
    printf "\n"
    die "$label did not accept connections after $((max * delay))s."
}

tail_service_log() {
    local logfile="$1"
    [ -f "$logfile" ] || return 0
    echo "----- tail -n 30 $logfile -----" >&2
    tail -n 30 "$logfile" >&2 || true
    echo "--------------------------------" >&2
}

health_probe_once() {
    local label="$1" url="$2" logfile="$3"
    debug "health probe: curl -sf --connect-timeout 2 --max-time 4 $url"
    if curl -sf --connect-timeout 2 --max-time 4 "$url" > /dev/null 2>&1; then
        log "  health OK: $label -> $url"
        return 0
    fi
    warn "$label health check failed: $url"
    tail_service_log "$logfile"
    return 1
}

print_port_snapshot() {
    local ports="5001 5002 5003 5004 5005 5006 8080 8787"
    log "-- Port snapshot --"
    for port in $ports; do
        if port_in_use "$port"; then
            log "  port $port -> LISTEN ($(port_process_details "$port"))"
        else
            log "  port $port -> free"
        fi
    done
}

# Start a background service and record its PID.
# Usage: start_bg  KEY  LABEL  PORT  LOGFILE  CMD [ARGS...]
start_bg() {
    local key="$1" label="$2" port="$3" logfile="$4"
    shift 4
    check_port_idempotent "$key" "$port" "$label" || return 0
    log "Starting $label on port $port ..."
    "$@" > "$logfile" 2>&1 &
    local pid=$!
    save_pid "$key" "$pid"
    log "  PID=$pid  log -> $logfile"
}

ensure_python_module() {
    local module="$1" req_file="$2"
    if "$PYTHON_BIN" -c "import ${module}" >/dev/null 2>&1; then
        return 0
    fi
    log "Python module '${module}' missing -> installing from ${req_file}"
    [ -f "$req_file" ] || die "Requirements file not found: $req_file"
    "$PIP_BIN" install -r "$req_file" >/dev/null || die "Failed to install dependencies from $req_file"
}

# ---------------------------------------------------------------------------
# Bootstrap checks
# ---------------------------------------------------------------------------
cd "$REPO_ROOT"
mkdir -p "$LOGS_DIR"

log "=== Taste_Aligner Dev Up ==="
log "  REPO_ROOT : $REPO_ROOT"
log "  LOGS_DIR  : $LOGS_DIR"

for _tool in curl mvn npm; do
    command -v "$_tool" > /dev/null 2>&1 || die "Required tool not in PATH: $_tool"
done
command -v "$PYTHON_BIN" >/dev/null 2>&1 || die "Missing Python venv interpreter: $PYTHON_BIN"
command -v "$PIP_BIN" >/dev/null 2>&1 || die "Missing Python venv pip: $PIP_BIN"

command -v nc > /dev/null 2>&1 || warn "nc (netcat) not found -- agent_runtime TCP probe disabled"

# Seed recommendation DB on first run
RECO_DB="$REPO_ROOT/services/recommendation/data/reco.db"
if [ ! -f "$RECO_DB" ]; then
    log "Seeding recommendation database (first run) ..."
    "$PYTHON_BIN" "$REPO_ROOT/scripts/seed_reco_db.py"
    log "  OK: DB seeded -> $RECO_DB"
fi

# Install agent_runtime Node deps if absent
if [ ! -d "$REPO_ROOT/agent_runtime/node_modules" ]; then
    log "Installing agent_runtime Node.js dependencies ..."
    (cd "$REPO_ROOT/agent_runtime" && npm install --silent)
    log "  OK: npm install done"
fi

# ---------------------------------------------------------------------------
# CORE services
# ---------------------------------------------------------------------------
log ""
log "-- Starting CORE services --"

# Python dependencies (install only when missing)
ensure_python_module fastapi "$REPO_ROOT/services/memory/requirements.txt"
ensure_python_module sentence_transformers "$REPO_ROOT/services/embedding/requirements.txt"
ensure_python_module requests "$REPO_ROOT/services/recommendation/requirements.txt"
ensure_python_module requests "$REPO_ROOT/services/planner/requirements.txt"

start_bg MEMORY "memory" 5001 "$LOGS_DIR/memory.log" \
    "$PYTHON_BIN" -m uvicorn services.memory.main:app --host 0.0.0.0 --port 5001

start_bg EMBEDDING "embedding (st_v1)" 5004 "$LOGS_DIR/embedding.log" \
    env \
        EMBEDDING_BACKEND=st_v1 \
        ST_MODEL_ID=sentence-transformers/all-MiniLM-L6-v2 \
        DEVICE=cpu \
    "$PYTHON_BIN" -m uvicorn services.embedding.main:app --host 0.0.0.0 --port 5004

start_bg RECOMMENDATION "recommendation" 5005 "$LOGS_DIR/recommendation.log" \
    "$PYTHON_BIN" -m uvicorn services.recommendation.main:app --host 0.0.0.0 --port 5005

start_bg PLANNER "planner" 5006 "$LOGS_DIR/planner.log" \
    "$PYTHON_BIN" -m uvicorn services.planner.main:app --host 0.0.0.0 --port 5006

start_bg GATEWAY "gateway" 8080 "$LOGS_DIR/gateway.log" \
    bash -c "cd \"$REPO_ROOT/gateway\" && mvn -q exec:java -Dexec.mainClass=gateway.GatewayServer"

if [ "$ENABLE_LLM" = "true" ]; then
    log "  [LLM] ENABLED  provider=${LLM_PROVIDER:-openai_compat}  model=${LLM_MODEL:-gpt-4o-mini}  key=${LLM_API_KEY:+set (hidden)}"
    [ -n "${LLM_API_KEY:-}" ] || warn "[LLM] --with-llm passed but LLM_API_KEY is not set -- adapter will fall back to mock"
else
    log "  [LLM] Mock (default). Use --with-llm to enable real LLM."
fi

start_bg AGENT_RUNTIME "agent_runtime" 8787 "$LOGS_DIR/agent_runtime.log" \
    bash -c "cd \"$REPO_ROOT/agent_runtime\" && PORT=8787 GATEWAY_BASE_URL=http://localhost:8080 npm run dev"

# ---------------------------------------------------------------------------
# OPTIONAL services
# ---------------------------------------------------------------------------
if [ "$START_VISION" = "true" ]; then
    log ""
    log "-- Starting vision --"
    [ -f "$REPO_ROOT/services/vision/main.py" ] \
        || die "services/vision/main.py not found. Use ./scripts/dev_up.sh --core if you only want core services."
    VISION_BACKEND="${VISION_BACKEND:-clip_v1}"
    if [ "$VISION_BACKEND" != "clip_v1" ] && [ "$VISION_BACKEND" != "hybrid" ]; then
        die "Unsupported VISION_BACKEND=$VISION_BACKEND. Supported values: clip_v1, hybrid."
    fi
    if ! "$PYTHON_BIN" -c "import open_clip" >/dev/null 2>&1; then
        die "VISION_BACKEND=clip_v1 requires open_clip_torch. Install with 'pip install open_clip_torch'."
    fi
    if ! "$PYTHON_BIN" -c "import services.vision.main" >/dev/null 2>&1; then
        die "Vision import failed. Install dependencies with 'pip install -r services/vision/requirements.txt' or run './scripts/dev_up.sh --core'."
    fi
    start_bg VISION "vision" 5002 "$LOGS_DIR/vision.log" \
        env VISION_BACKEND="$VISION_BACKEND" DEVICE="${DEVICE:-cpu}" \
        OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
        "$PYTHON_BIN" -m uvicorn services.vision.main:app --host 0.0.0.0 --port 5002
fi

if [ "$START_ONTOLOGY" = "true" ]; then
    log ""
    log "-- Starting ontology --"
    [ -f "$REPO_ROOT/services/ontology/main.py" ] \
        || die "services/ontology/main.py not found. Use ./scripts/dev_up.sh --core if you only want core services."
    if ! "$PYTHON_BIN" -c "import services.ontology.main" >/dev/null 2>&1; then
        die "Ontology import failed. Install missing deps (e.g. fastapi/uvicorn/pyyaml) in your venv, or run './scripts/dev_up.sh --core'."
    fi
    log "  NOTE: ontology is standalone only -- NOT wired into /run pipeline"
    start_bg ONTOLOGY "ontology" 5003 "$LOGS_DIR/ontology.log" \
        "$PYTHON_BIN" -m uvicorn services.ontology.main:app --host 0.0.0.0 --port 5003
fi

# ---------------------------------------------------------------------------
# Health checks
# ---------------------------------------------------------------------------
log ""
log "-- Health checks --"

# Fast Python services (ready in ~2-5 s)
wait_http "memory"         "http://localhost:5001/health" 20 2 "$LOGS_DIR/memory.log"
wait_http "recommendation" "http://localhost:5005/health" 20 2 "$LOGS_DIR/recommendation.log"
wait_http "planner"        "http://localhost:5006/health" 20 2 "$LOGS_DIR/planner.log"

# Embedding: all-MiniLM-L6-v2 downloads ~90 MB on first run -- allow 3 min
wait_http "embedding" "http://localhost:5004/health" 60 3 "$LOGS_DIR/embedding.log"

# Confirm st_v1 backend
EMBED_JSON="$(curl -sf --max-time 5 "http://localhost:5004/health" 2>/dev/null || echo '{}')"
EMBED_BACKEND="$("$PYTHON_BIN" -c "import json,sys; d=json.loads(sys.argv[1]); print(d.get('backend','?'))" "$EMBED_JSON" 2>/dev/null || echo '?')"
EMBED_WARM="$("$PYTHON_BIN" -c "import json,sys; d=json.loads(sys.argv[1]); print(d.get('warm','?'))" "$EMBED_JSON" 2>/dev/null || echo '?')"
if [ "$EMBED_BACKEND" != "st_v1" ]; then
    die "Embedding backend='$EMBED_BACKEND', expected 'st_v1'. See $LOGS_DIR/embedding.log"
fi
log "  OK: embedding backend=$EMBED_BACKEND  warm=$EMBED_WARM"

# Warm up embedding /tes/build so the first /run does not pay model cold-start.
# Keep this best-effort and non-blocking for developer ergonomics.
sleep 2
log "[warmup] embedding tes_build..."
curl -s --max-time 10 \
    -X POST http://localhost:5004/tes/build \
    -H "Content-Type: application/json" \
    -d '{"tags":["warmup"],"normalize":true}' > /dev/null || true
log "[warmup] done"

# Gateway: Maven + JVM startup ~20-40 s; allow 2 min
wait_http "gateway" "http://localhost:8080/health" 40 3 "$LOGS_DIR/gateway.log"

# Agent Runtime: no /health endpoint -- probe TCP then HTTP fallback
if command -v nc > /dev/null 2>&1; then
    wait_tcp "agent_runtime" 127.0.0.1 8787 30 2
else
    log "  Waiting for agent_runtime on :8787 (HTTP fallback) ..."
    AR_I=0
    AR_READY=false
    while [ "$AR_I" -lt 30 ]; do
        AR_CODE="$(curl -so /dev/null -w '%{http_code}' --max-time 3 \
            -X POST http://localhost:8787/run \
            -H 'Content-Type: application/json' \
            -d '{}' 2>/dev/null || echo '000')"
        case "$AR_CODE" in
            2*|4*) log "  OK: agent_runtime ready (HTTP $AR_CODE)"; AR_READY=true; break ;;
        esac
        AR_I=$((AR_I + 1))
        sleep 2
    done
    if [ "$AR_READY" != "true" ]; then
        die "agent_runtime did not start on :8787. Check $LOGS_DIR/agent_runtime.log"
    fi
fi

# Optional services
if [ "$START_VISION" = "true" ] && [ -f "$REPO_ROOT/services/vision/main.py" ]; then
    # clip_v1 loads CLIP model at startup; allow 3 min for first run
    wait_http "vision" "http://localhost:5002/health" 60 3 "$LOGS_DIR/vision.log"
    VISION_JSON="$(curl -sf --max-time 5 "http://localhost:5002/health" 2>/dev/null || echo '{}')"
    VISION_BACKEND="$("$PYTHON_BIN" -c "import json,sys; d=json.loads(sys.argv[1]); print(d.get('backend','?'))" "$VISION_JSON" 2>/dev/null || echo '?')"
    VISION_WARM="$("$PYTHON_BIN" -c "import json,sys; d=json.loads(sys.argv[1]); print(d.get('warm','?'))" "$VISION_JSON" 2>/dev/null || echo '?')"
    log "  OK: vision backend=$VISION_BACKEND  warm=$VISION_WARM"
fi
if [ "$START_ONTOLOGY" = "true" ] && [ -f "$REPO_ROOT/services/ontology/main.py" ]; then
    wait_http "ontology" "http://localhost:5003/health" 15 2 "$LOGS_DIR/ontology.log"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
log ""
log "------------------------------------------------------------------------"
if [ "$START_VISION" = "true" ] && [ "$START_ONTOLOGY" = "true" ]; then
    log "  ALL UP"
else
    log "  CORE UP"
fi
log "------------------------------------------------------------------------"
log "  memory         ->  http://localhost:5001"
log "  embedding      ->  http://localhost:5004   (backend=st_v1)"
log "  recommendation ->  http://localhost:5005"
log "  planner        ->  http://localhost:5006"
log "  gateway        ->  http://localhost:8080"
log "  agent_runtime  ->  http://localhost:8787"
if [ "$START_VISION" = "true" ] && [ -f "$REPO_ROOT/services/vision/main.py" ]; then
    log "  vision         ->  http://localhost:5002   (backend=${VISION_BACKEND:-?}, wired into /run)"
fi
if [ "$START_ONTOLOGY" = "true" ] && [ -f "$REPO_ROOT/services/ontology/main.py" ]; then
    log "  ontology       ->  http://localhost:5003   (standalone only)"
fi
log ""
log "  Logs : $LOGS_DIR/"
log "  PIDs : $PIDS_FILE"
log "------------------------------------------------------------------------"
print_port_snapshot
health_probe_once "memory" "http://localhost:5001/health" "$LOGS_DIR/memory.log" || true
health_probe_once "embedding" "http://localhost:5004/health" "$LOGS_DIR/embedding.log" || true
health_probe_once "recommendation" "http://localhost:5005/health" "$LOGS_DIR/recommendation.log" || true
health_probe_once "planner" "http://localhost:5006/health" "$LOGS_DIR/planner.log" || true
health_probe_once "gateway" "http://localhost:8080/health" "$LOGS_DIR/gateway.log" || true
if [ "$START_VISION" = "true" ] && [ -f "$REPO_ROOT/services/vision/main.py" ]; then
    health_probe_once "vision" "http://localhost:5002/health" "$LOGS_DIR/vision.log" || true
fi
if [ "$START_ONTOLOGY" = "true" ] && [ -f "$REPO_ROOT/services/ontology/main.py" ]; then
    health_probe_once "ontology" "http://localhost:5003/health" "$LOGS_DIR/ontology.log" || true
fi

# ---------------------------------------------------------------------------
# Optional post-start verification
# ---------------------------------------------------------------------------
if [ "$RUN_VERIFY" = "true" ]; then
    log ""
    log "-- Post-start verification (use --no-verify to skip) --"
    "$SCRIPT_DIR/dev_verify.sh"
fi
