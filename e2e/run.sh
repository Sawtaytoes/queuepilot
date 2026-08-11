#!/usr/bin/env bash
# Run the plex-channels-web E2E suites against a LOCAL server + temp data copies.
# Needs: the root agentic .env (PLEX token), mux-magic's node_modules (playwright),
# and PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers (agent-sandbox-base).
# live-smoke.mjs is separate: it drives https://plex-channels.example.com read-only.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source /mnt/TrueNAS-Apps/Repos/agentic/.env; set +a
# The frontend is a Vite build since M6d — server/src/server.js serves web/dist,
# so a stale (or missing) dist means every browser suite drives an empty page.
[ -d web/node_modules ] || npm --prefix web ci --no-audit --no-fund
npm --prefix web run build
unset MQTT_HOST MQTT_PORT MQTT_USER MQTT_PASS   # suites assert the degraded no-broker paths
export QUEUES_PATH=/tmp/queues-ui.yaml SETS_PATH=/tmp/sets-ui.yaml WEB_PORT=18768 \
       CACHE_PATH=/tmp/cache-e2e.sqlite \
       NODE_TLS_REJECT_UNAUTHORIZED=0 PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}
rm -f /tmp/cache-e2e.sqlite /tmp/cache-e2e.sqlite-wal /tmp/cache-e2e.sqlite-shm
TOTAL=0
echo "=== collection-start-test (python, offline) ==="   # engine floor for collection starts
python3 e2e/collection-start-test.py || TOTAL=$((TOTAL+1))
echo "=== resume-in-queue-test (python, offline) ==="   # resume a started-but-unfinished queued item
python3 e2e/resume-in-queue-test.py || TOTAL=$((TOTAL+1))
echo "=== resume-in-progress-done-test (python, offline) ==="   # in-progress OAD never reads finished/done
python3 e2e/resume-in-progress-done-test.py || TOTAL=$((TOTAL+1))
echo "=== history-persist-test ==="   # manages its own server (port 18770) + files
node e2e/history-persist-test.mjs || TOTAL=$((TOTAL+1))
echo "=== api-v2-test ==="   # browserless; manages its own server + temp files (v2 endpoints)
node e2e/api-v2-test.mjs || TOTAL=$((TOTAL+1))
echo "=== sse-resync-test ==="   # browserless; SSE now-playing replay on (re)connect (+ retained snapshot via fake broker)
node e2e/sse-resync-test.mjs || TOTAL=$((TOTAL+1))
echo "=== yaml-roundtrip-test ==="   # browserless; comments survive every queues/sets mutation (Phase E)
node e2e/yaml-roundtrip-test.mjs || TOTAL=$((TOTAL+1))
echo "=== profile-gate-test (node, D1) ==="   # browserless; PMS-log profile detection port
node e2e/profile-gate-test.mjs || TOTAL=$((TOTAL+1))
echo "=== host-config-test ==="   # browserless; env > /config/config.yaml > placeholder
node e2e/host-config-test.mjs || TOTAL=$((TOTAL+1))
echo "=== collection-batch-cap-test ==="   # browserless; a Collection is ONE member = ONE batch
node e2e/collection-batch-cap-test.mjs || TOTAL=$((TOTAL+1))
echo "=== resume-on-advance-test ==="   # browserless; every queued episode resumes, not just the head
node e2e/resume-on-advance-test.mjs || TOTAL=$((TOTAL+1))
echo "=== headers-test ==="   # browserless; asserts compression + cache headers (Phase A)
node e2e/headers-test.mjs || TOTAL=$((TOTAL+1))
echo "=== perf-queues ==="   # browserless; stub Plex + broker, asserts the cache/ETag (Phase B)
node e2e/perf-queues.mjs || TOTAL=$((TOTAL+1))
for t in narrow-scroll-test kbd-undo-test ui-test homedrag-test channels-test sse-test; do
  echo "=== $t ==="
  # Fresh server + files PER SUITE — stale lock dirs / shared servers made runs flaky.
  rm -rf /tmp/sets-ui.yaml /tmp/sets-ui.yaml.lock /tmp/queues-ui.yaml.lock /tmp/.history.json
  cp e2e/fixtures/queues.fixture.yaml /tmp/queues-ui.yaml
  node server/src/server.js >/tmp/web-e2e.log 2>&1 &
  SRV=$!; sleep 1.5
  node "e2e/$t.mjs" || TOTAL=$((TOTAL+1))
  kill $SRV 2>/dev/null; wait $SRV 2>/dev/null || true
done
echo "suites failed: $TOTAL"; exit $TOTAL
