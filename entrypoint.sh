#!/usr/bin/env bash
# Launch the app and its cast sidecar in one container and tie their lifetimes together:
# if EITHER exits, tear the container down so the orchestrator restarts it cleanly.
#
#   plex-channels-web  — the Node API, web UI, selection engine, MQTT service (mqttd) and
#                        playback. This is the whole application.
#   cast_sidecar       — a ~100-line Python process that answers plex-channels/cmd/cast/play
#                        with pychromecast, the one thing Node cannot do. Inert unless a
#                        device is in cast mode (decision 2026-08-12).
set -euo pipefail

echo "[entrypoint] starting plex-channels-web (+ mqttd) + cast_sidecar"

/opt/venv/bin/python -m cast_sidecar.service &
SIDE_PID=$!

node /app/server/src/server.js &
WEB_PID=$!

# Wait for whichever child exits first, then kill the other and exit non-zero.
wait -n
echo "[entrypoint] a child process exited; shutting the container down"
kill "$SIDE_PID" "$WEB_PID" 2>/dev/null || true
wait 2>/dev/null || true
exit 1
