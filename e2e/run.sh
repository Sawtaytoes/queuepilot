#!/usr/bin/env bash
# Run the queuepilot-web E2E suites against a LOCAL server + temp data copies.
# Needs: the root agentic .env (PLEX token), mux-magic's node_modules (playwright),
# and PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers (agent-sandbox-base).
# live-smoke.ts is separate: it drives https://plex-channels.example.com read-only.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source /mnt/TrueNAS-Apps/Repos/agentic/.env; set +a
# The frontend is a Vite build since M6d — the server serves web/dist, so a stale (or
# missing) dist means every browser suite drives an empty page.
[ -d web/node_modules ] || npm --prefix web ci --no-audit --no-fund
npm --prefix web run build
# server/src is TypeScript: `node` can neither load an entry point ending .ts nor resolve the
# `./foo.js` specifiers inside it, so every harness AND the server itself run through tsx.
# tsx is a server/ devDependency (there is no root manifest), hence the explicit bin path.
[ -d server/node_modules ] || npm --prefix server ci --no-audit --no-fund
TSX=server/node_modules/.bin/tsx
unset MQTT_HOST MQTT_PORT MQTT_USER MQTT_PASS   # suites assert the degraded no-broker paths
export QUEUES_PATH=/tmp/queues-ui.yaml SETS_PATH=/tmp/sets-ui.yaml WEB_PORT=18768 \
       CACHE_PATH=/tmp/cache-e2e.sqlite \
       NODE_TLS_REJECT_UNAUTHORIZED=0 PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}
rm -f /tmp/cache-e2e.sqlite /tmp/cache-e2e.sqlite-wal /tmp/cache-e2e.sqlite-shm
TOTAL=0
echo "=== history-persist-test ==="   # manages its own server (port 18770) + files
"$TSX" e2e/history-persist-test.ts || TOTAL=$((TOTAL+1))
echo "=== api-v2-test ==="   # browserless; manages its own server + temp files (v2 endpoints)
"$TSX" e2e/api-v2-test.ts || TOTAL=$((TOTAL+1))
echo "=== sse-resync-test ==="   # browserless; SSE now-playing replay on (re)connect (+ retained snapshot via fake broker)
"$TSX" e2e/sse-resync-test.ts || TOTAL=$((TOTAL+1))
echo "=== yaml-roundtrip-test ==="   # browserless; comments survive every queues/sets mutation (Phase E)
"$TSX" e2e/yaml-roundtrip-test.ts || TOTAL=$((TOTAL+1))
echo "=== profile-gate-test (node, D1) ==="   # browserless; PMS-log profile detection port
"$TSX" e2e/profile-gate-test.ts || TOTAL=$((TOTAL+1))
echo "=== host-config-test ==="   # browserless; env > /config/config.yaml > placeholder
"$TSX" e2e/host-config-test.ts || TOTAL=$((TOTAL+1))
echo "=== batch-stops-at-test (node) ==="   # the same table in the Node port
"$TSX" e2e/batch-stops-at-test.ts || TOTAL=$((TOTAL+1))
echo "=== collection-batch-cap-test ==="   # browserless; a Collection is ONE member = ONE batch
"$TSX" e2e/collection-batch-cap-test.ts || TOTAL=$((TOTAL+1))
echo "=== resume-on-advance-test ==="   # browserless; every queued episode resumes, not just the head
"$TSX" e2e/resume-on-advance-test.ts || TOTAL=$((TOTAL+1))
echo "=== headers-test ==="   # browserless; asserts compression + cache headers (Phase A)
"$TSX" e2e/headers-test.ts || TOTAL=$((TOTAL+1))
echo "=== perf-queues ==="   # browserless; stub Plex + broker, asserts the cache/ETag (Phase B)
"$TSX" e2e/perf-queues.ts || TOTAL=$((TOTAL+1))
for t in narrow-scroll-test kbd-undo-test ui-test homedrag-test channels-test sse-test; do
  echo "=== $t ==="
  # Fresh server + files PER SUITE — stale lock dirs / shared servers made runs flaky.
  rm -rf /tmp/sets-ui.yaml /tmp/sets-ui.yaml.lock /tmp/queues-ui.yaml.lock /tmp/.history.json
  cp e2e/fixtures/queues.fixture.yaml /tmp/queues-ui.yaml
  "$TSX" server/src/index.ts >/tmp/web-e2e.log 2>&1 &
  SRV=$!; sleep 1.5
  "$TSX" "e2e/$t.ts" || TOTAL=$((TOTAL+1))
  # `|| true` matters under `set -e`: if this suite's server died on its own (a crash, or an
  # EADDRINUSE from a previous run's leftover) then `kill` reports "no such process" and the
  # bare form aborts the WHOLE script — the remaining suites silently never run and the
  # summary line never prints, which reads like a hang rather than one failed suite.
  kill $SRV 2>/dev/null || true; wait $SRV 2>/dev/null || true
done
echo "suites failed: $TOTAL"; exit $TOTAL
