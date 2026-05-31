#!/usr/bin/env bash
# scripts/dev_restart.sh  --  Restart Taste_Aligner local development services.
#
# Usage:
#   ./scripts/dev_restart.sh [OPTIONS]
#
# Passes startup options through to dev_up.sh. Examples:
#   ./scripts/dev_restart.sh
#   ./scripts/dev_restart.sh --all --with-llm
#   ./scripts/dev_restart.sh --core --with-vision --with-ontology --with-llm
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UP_ARGS=("$@")
DOWN_ARGS=()

while [ "$#" -gt 0 ]; do
    case "$1" in
        --logs-dir)
            shift
            DOWN_ARGS+=("--logs-dir" "${1:?'--logs-dir requires a path argument'}")
            ;;
        -h|--help)
            sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
            echo ""
            "$SCRIPT_DIR/dev_up.sh" --help
            exit 0
            ;;
    esac
    shift
done

echo "[dev_restart] === Taste_Aligner Dev Restart ==="
if [ "${#DOWN_ARGS[@]}" -gt 0 ]; then
    "$SCRIPT_DIR/dev_down.sh" "${DOWN_ARGS[@]}"
else
    "$SCRIPT_DIR/dev_down.sh"
fi

if [ "${#UP_ARGS[@]}" -gt 0 ]; then
    "$SCRIPT_DIR/dev_up.sh" "${UP_ARGS[@]}"
else
    "$SCRIPT_DIR/dev_up.sh"
fi
