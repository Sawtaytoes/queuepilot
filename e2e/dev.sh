#!/usr/bin/env bash
# Local dev harness — boots the whole queuepilot web stack OFFLINE for screenshot-driven
# UI iteration: the Node server with the rich YAML fixtures, a FAKE MQTT broker + responder
# (e2e/fake-mqtt.mjs — real broker is unreachable), and the REAL Plex server (posters,
# search, ratings, collections all resolve live). Foreground; Ctrl-C stops both processes.
#
# One-time: `cd e2e/broker && npm install` (hydrates aedes for the fake broker).
# Screenshots without the interactive server: `node e2e/shots.mjs` (self-contained).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source /mnt/TrueNAS-Apps/Repos/agentic/.env; set +a

PORT="${WEB_PORT:-18780}"
FAKE_MQTT_PORT="${FAKE_MQTT_PORT:-11883}"

# Never touch real data: fixtures are copied to /tmp and the server writes only there.
cp e2e/fixtures/queues.harness.yaml /tmp/queues-harness.yaml
cp e2e/fixtures/sets.fixture.yaml   /tmp/sets-harness.yaml
rm -rf /tmp/queues-harness.yaml.lock /tmp/sets-harness.yaml.lock /tmp/.history-harness.json

export QUEUES_PATH=/tmp/queues-harness.yaml \
       SETS_PATH=/tmp/sets-harness.yaml \
       HISTORY_PATH=/tmp/.history-harness.json \
       WEB_PORT="$PORT" \
       MQTT_HOST=127.0.0.1 MQTT_PORT="$FAKE_MQTT_PORT" \
       NODE_TLS_REJECT_UNAUTHORIZED=0 \
       PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"

echo "[dev] starting fake MQTT broker on :$FAKE_MQTT_PORT"
node e2e/fake-mqtt.mjs &
BROKER=$!
sleep 1
echo "[dev] starting web server on http://localhost:$PORT (fixtures + fake MQTT + real Plex)"
node server/src/server.js &
SRV=$!

trap 'kill $BROKER $SRV 2>/dev/null || true' EXIT INT TERM
echo "[dev] up. Open http://localhost:$PORT  (or devshare $PORT \"queuepilot-dev\")"
wait $SRV
