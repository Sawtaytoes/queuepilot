#!/usr/bin/env bash
# Launch both halves of the plex-channels app in one container and tie their lifetimes
# together: if EITHER exits, tear the container down so the orchestrator restarts it
# cleanly (rather than limping along with half the app dead).
set -euo pipefail

echo "[entrypoint] starting plex-channels-queue (python) + plex-channels-web (node)"

/opt/venv/bin/python -m queue_builder.service &
QUEUE_PID=$!

node /app/server/src/server.js &
WEB_PID=$!

# Wait for whichever child exits first, then kill the other and exit non-zero.
wait -n
echo "[entrypoint] a child process exited; shutting the container down"
kill "$QUEUE_PID" "$WEB_PID" 2>/dev/null || true
wait 2>/dev/null || true
exit 1
