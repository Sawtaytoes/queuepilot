#!/usr/bin/env bash
# Launch both halves of the plex-channels app and tie their lifetimes together.
# PLAYBACK_ENGINE=node (D7/D8): Node owns MQTT session/start + selection; a tiny Python
# cast_sidecar keeps pychromecast available. PLAYBACK_ENGINE=python (default until soak):
# the historic queue_builder.service path.
set -euo pipefail

PLAYBACK_ENGINE="${PLAYBACK_ENGINE:-python}"

if [ "$PLAYBACK_ENGINE" = "node" ]; then
  echo "[entrypoint] PLAYBACK_ENGINE=node — plex-channels-web (+ mqttd) + cast_sidecar"
  /opt/venv/bin/python -m cast_sidecar.service &
  SIDE_PID=$!
  node /app/server/src/server.js &
  WEB_PID=$!
  wait -n
  echo "[entrypoint] a child process exited; shutting the container down"
  kill "$SIDE_PID" "$WEB_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  exit 1
fi

echo "[entrypoint] PLAYBACK_ENGINE=python — plex-channels-queue + plex-channels-web"
/opt/venv/bin/python -m queue_builder.service &
QUEUE_PID=$!
node /app/server/src/server.js &
WEB_PID=$!
wait -n
echo "[entrypoint] a child process exited; shutting the container down"
kill "$QUEUE_PID" "$WEB_PID" 2>/dev/null || true
wait 2>/dev/null || true
exit 1
