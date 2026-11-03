#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
args=()
if [[ $# -gt 0 ]]; then args+=(--projects "$1"); fi
if [[ $# -gt 1 ]]; then args+=(--output "$2"); fi
exec python3 "$SCRIPT_DIR/scan_projects.py" "${args[@]}"
