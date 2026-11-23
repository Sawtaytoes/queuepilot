#!/usr/bin/env bash
# Local dev harness — boots the whole queuepilot web stack OFFLINE for screenshot-driven
# UI iteration: the Node server with the rich YAML fixtures, a FAKE MQTT broker + responder
# (e2e/fake-mqtt.ts — real broker is unreachable), and the REAL Plex server (posters,
# search, ratings, collections all resolve live) reached through e2e/gatehouse-plex.ts, which
# sends each Plex call through gatehouse-request so no token is read here. Foreground; Ctrl-C
# stops every process.
#
# The fake broker's aedes comes from the root `pnpm install` (e2e/broker is a workspace).
# Screenshots without the interactive server: `server/node_modules/.bin/tsx e2e/shots.ts`
# (self-contained).
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${WEB_PORT:-18780}"
FAKE_MQTT_PORT="${FAKE_MQTT_PORT:-11883}"

# The whole e2e/ tree is TypeScript since the Hono conversion, fake-mqtt included, so the
# broker below runs through tsx exactly like the server does. tsx is a server/ devDependency
# (there is no root manifest), hence the explicit bin path — and hydrating server/ has to
# happen BEFORE the first tsx invocation, not just before the server's.
[ -d server/node_modules ] || pnpm install --frozen-lockfile
TSX=server/node_modules/.bin/tsx

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

GATEHOUSE_PLEX_PORT="${GATEHOUSE_PLEX_PORT:-18799}"
export GATEHOUSE_PLEX_PORT
echo "[dev] starting the Gatehouse Plex forwarder on :$GATEHOUSE_PLEX_PORT"
"$TSX" e2e/gatehouse-plex.ts &
PLEXGW=$!
# The forwarder strips any token, and the broker adds the real one; this is a placeholder.
# Tile links to the Plex web client follow PLEX_WEB_URL when it is set (see the forwarder).
export PLEX_API_SERVER_URL="http://127.0.0.1:$GATEHOUSE_PLEX_PORT" PLEX_TOKEN=gatehouse-adds-the-token

echo "[dev] starting fake MQTT broker on :$FAKE_MQTT_PORT"
"$TSX" e2e/fake-mqtt.ts &
BROKER=$!
sleep 1
echo "[dev] starting web server on http://localhost:$PORT (fixtures + fake MQTT + real Plex)"
# server/src is TypeScript too — same tsx, hydrated above.
"$TSX" server/src/index.ts &
SRV=$!

trap 'kill $PLEXGW $BROKER $SRV 2>/dev/null || true' EXIT INT TERM
echo "[dev] up. Open http://localhost:$PORT  (or devshare $PORT \"queuepilot-dev\")"
wait $SRV
