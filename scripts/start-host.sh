#!/bin/bash
#
# Standard host launcher for the FrontLane / nano platform.
#
# Why this exists: running `pnpm dev` directly in a terminal leaves the
# host's stdout in that terminal — it never lands in logs/, so the
# `logs/host-current.log` symlink can't track it. This script always
# redirects to a timestamped file and exports FRONTLANE_LOG_FILE so the
# host wires the symlink to the exact right file on startup.
#
# Usage:
#   bash scripts/start-host.sh            # start in background, return
#   bash scripts/start-host.sh --fg       # start in foreground (Ctrl-C to stop)
#
# Stop:  bash scripts/stop-host.sh
# Tail:  tail -f logs/host-current.log
#
# Env passthrough — set before invoking, they reach the host process:
#   LOG_FORMAT=json   NDJSON output instead of text
#   LOG_LEVEL=debug   verbose
#   NO_COLOR=1        force-disable ANSI (auto-disabled anyway when piped)

set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p logs

# Refuse to start a second host if port 13000 is already held.
PORT="${WEBHOOK_PORT:-13000}"
if lsof -i ":$PORT" -P 2>/dev/null | grep -q LISTEN; then
  echo "ERROR: port $PORT already in use — a host is likely already running." >&2
  echo "       Run 'bash scripts/stop-host.sh' first, or check 'lsof -i :$PORT -P'." >&2
  exit 1
fi

LOG="logs/host-restart-$(date +%Y%m%d-%H%M%S).log"
echo "Host log: $LOG"

if [[ "${1:-}" == "--fg" ]]; then
  # Foreground: still tee to the log file so host-current.log works, but
  # keep output visible in the terminal too.
  exec env FRONTLANE_LOG_FILE="$LOG" pnpm dev 2>&1 | tee "$LOG"
fi

# Background (default).
env FRONTLANE_LOG_FILE="$LOG" nohup pnpm dev > "$LOG" 2>&1 &
HOST_PID=$!
echo "Host started in background — PID $HOST_PID"
echo "  tail -f logs/host-current.log    # follow"
echo "  bash scripts/stop-host.sh        # stop"
