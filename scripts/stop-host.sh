#!/bin/bash
#
# Graceful host shutdown for the FrontLane / nano platform.
#
# Sends SIGTERM (lets the host run its shutdown handlers — stop delivery
# polls, host sweep, span watcher, teardown channel adapters). Falls back
# to SIGKILL only if the process is still holding port 13000 after a grace
# period.
#
# Usage:  bash scripts/stop-host.sh

set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${WEBHOOK_PORT:-13000}"

PIDS=$(pgrep -f "src/index\.ts" || true)
if [[ -z "$PIDS" ]]; then
  echo "No host process (tsx src/index.ts) running."
else
  echo "Sending SIGTERM to host PID(s): $PIDS"
  # shellcheck disable=SC2086
  kill -TERM $PIDS 2>/dev/null || true
fi

# Wait up to 10s for port to free.
for _ in $(seq 1 20); do
  if ! lsof -i ":$PORT" -P 2>/dev/null | grep -q LISTEN; then
    echo "Host stopped, port $PORT free."
    exit 0
  fi
  sleep 0.5
done

# Still holding the port — force kill whatever LISTENs on it.
HOLDER=$(lsof -i ":$PORT" -P 2>/dev/null | grep LISTEN | awk '{print $2}' | head -1)
if [[ -n "$HOLDER" ]]; then
  echo "Port $PORT still held by PID $HOLDER after grace period — SIGKILL."
  kill -9 "$HOLDER" 2>/dev/null || true
  sleep 1
fi
echo "Done."
