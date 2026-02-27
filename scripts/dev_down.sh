#!/usr/bin/env bash
# scripts/dev_down.sh  --  Stop all services started by dev_up.sh.
#
# Usage:
#   ./scripts/dev_down.sh [--logs-dir PATH]
#
# Reads PIDs from $LOGS_DIR/pids.env (written by dev_up.sh).
# Falls back to port-based detection when the PID file is absent, but only
# kills processes whose command name matches the expected service binary.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOGS_DIR="${LOGS_DIR:-$REPO_ROOT/logs}"

while [ "$#" -gt 0 ]; do
    case "$1" in
        --logs-dir)
            shift
            LOGS_DIR="${1:?'--logs-dir requires a path'}"
            ;;
        -h|--help)
            echo "Usage: $0 [--logs-dir PATH]"
            exit 0
            ;;
        *)
            echo "[dev_down] ERROR: Unknown option: $1" >&2
            exit 1
            ;;
    esac
    shift
done

PIDS_FILE="$LOGS_DIR/pids.env"

log()  { echo "[dev_down] $*"; }
warn() { echo "[dev_down] WARN: $*" >&2; }

pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

# Kill a PID and its children.  SIGTERM first, SIGKILL after 5 s.
stop_pid() {
    local pid="$1" label="${2:-process}"
    if ! pid_alive "$pid"; then
        log "  $label (PID=$pid) -- already stopped"
        return
    fi
    log "  Stopping $label (PID=$pid) ..."
    # Kill children first (handles bash wrappers around mvn/node)
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill -TERM  "$pid"    2>/dev/null || true
    local i=0
    while [ "$i" -lt 10 ] && pid_alive "$pid"; do
        sleep 0.5
        i=$((i + 1))
    done
    if pid_alive "$pid"; then
        warn "$label still alive -- sending SIGKILL"
        pkill -KILL -P "$pid" 2>/dev/null || true
        kill -KILL   "$pid"   2>/dev/null || true
    fi
    log "  OK: $label stopped"
}

# ---------------------------------------------------------------------------
# Primary path: use pids.env
# ---------------------------------------------------------------------------
if [ -f "$PIDS_FILE" ]; then
    log "Reading PIDs from $PIDS_FILE"

    # Collect entries in a temp file so we can reverse the order
    _TMP_ENTRIES="$(mktemp)"
    while IFS='=' read -r key pid; do
        case "$key" in
            ""|\#*) continue ;;       # blank / comment
            *_PID)  ;;                # expected
            *)      continue ;;       # unrecognised key
        esac
        [ -n "${pid:-}" ] || continue
        echo "${key%_PID}:$pid" >> "$_TMP_ENTRIES"
    done < "$PIDS_FILE"

    # Reverse: stop in reverse start order (agent_runtime and gateway last to die)
    if command -v tac > /dev/null 2>&1; then
        _REVERSED="$(tac "$_TMP_ENTRIES")"
    else
        _REVERSED="$(tail -r "$_TMP_ENTRIES")"   # macOS tail supports -r
    fi
    rm -f "$_TMP_ENTRIES"

    while IFS=: read -r label pid; do
        [ -n "$label" ] && [ -n "$pid" ] && stop_pid "$pid" "$label"
    done <<EOF
$_REVERSED
EOF

    rm -f "$PIDS_FILE"
    log "PID file removed: $PIDS_FILE"

else
    # ---------------------------------------------------------------------------
    # Fallback: scan known ports and verify command before killing
    # ---------------------------------------------------------------------------
    warn "PID file not found at $PIDS_FILE"
    warn "Falling back to port scan -- only confirmed service processes will be killed."

    # port:cmd_fragment:label
    KNOWN_LIST="
8787:node:agent_runtime
8080:java:gateway
5006:uvicorn:planner
5005:uvicorn:recommendation
5004:uvicorn:embedding
5001:uvicorn:memory
5002:uvicorn:vision
5003:uvicorn:ontology
"
    while IFS=: read -r port cmd_frag label; do
        case "$port" in ""|\#*) continue ;; esac
        [ -n "$port" ] || continue
        _pid="$(lsof -ti tcp:"$port" 2>/dev/null | head -1 || true)"
        [ -n "$_pid" ] || continue
        _cmd="$(ps -p "$_pid" -o comm= 2>/dev/null || true)"
        case "$_cmd" in
            *${cmd_frag}*)
                log "  Port $port: $label (PID=$_pid, cmd=$_cmd)"
                stop_pid "$_pid" "$label"
                ;;
            *)
                warn "Port $port: unexpected process (PID=$_pid, cmd='$_cmd') -- skipping"
                ;;
        esac
    done <<EOF
$KNOWN_LIST
EOF
fi

log ""
log "Done. All known services stopped."
