#!/usr/bin/env bash
# Record a deterministic Plex CORPUS off the live server — the fixed oracle the Node selection
# engine (D3) is diffed against (see docs/d3-engine-parity-corpus.md). Every read-only response
# plex.py makes is written under $OUT, token-bucketed, secrets redacted (queue_builder/plex.py
# _corpus_record). Replay it with PLEX_REPLAY_DIR=$OUT — no network, byte-identical output.
#
# PRIVACY: a corpus contains real library titles + watch history + account ids. It is
# .gitignored (__corpus__/) and must NEVER be committed to this public repo. CI runs
# engine-parity against a SYNTHETIC or scrubbed corpus, not this one.
#
# Usage: source the Plex creds, then run.
#   set -a; source /path/to/agentic/.env; set +a
#   SETS_PATH=/mnt/TrueNAS-Apps/App-Configs/plex-channels/sets.yaml \
#   QUEUES_PATH=/mnt/TrueNAS-Apps/App-Configs/plex-channels/queues.yaml \
#   PYTHONPATH=/tmp/pylibs:. ./e2e/record-corpus.sh
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${OUT:-__corpus__/default}"
: "${SETS_PATH:?set SETS_PATH to the live sets.yaml}"
: "${QUEUES_PATH:?set QUEUES_PATH to the live queues.yaml}"

# NEVER mutate production: the `queue` subcommand marks finished entries done in the file, so
# record against COPIES. sets.yaml is read-only for these commands but copy it too for symmetry.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp "$SETS_PATH" "$WORK/sets.yaml"
cp "$QUEUES_PATH" "$WORK/queues.yaml"
export SETS_PATH="$WORK/sets.yaml" QUEUES_PATH="$WORK/queues.yaml"

rm -rf "$OUT"
export PLEX_RECORD_DIR="$OUT"

# Derive the set lists from the same config the engine reads (no hand-maintained list).
mapfile -t ROTATION < <(python3 -c "import queue_builder.config as c; print('\n'.join(s for s in c.SET_ORDER if c.SETS[s].get('source')=='rotation'))")
mapfile -t QUEUES   < <(python3 -c "import queue_builder.config as c; print('\n'.join(s for s in c.SET_ORDER if c.SETS[s].get('source')=='queue'))")

run() { echo "  rec: $*"; python3 -m queue_builder.cli "$@" >/dev/null 2>&1 || echo "    (skipped: $*)"; }

echo "[corpus] server metadata + routing"
run machine-id
for p in "Younger Kids" "Older Kids"; do run route cartoons "$p"; run route movie "$p"; done

echo "[corpus] rotation channels (unwatched buckets + rewatch pools)"
for s in "${ROTATION[@]}"; do
  for p in "Younger Kids" "Older Kids"; do
    run shows "$s" "$p"          # unwatched_buckets / channel_buckets — the deterministic input
    run watched-count "$s" "$p"  # rewatch weighting histogram
  done
done

echo "[corpus] curated queues (resolution + collection expansion)"
for s in "${QUEUES[@]}"; do run queue "$s"; run reel "$s"; done

echo "[corpus] done → $OUT ($(find "$OUT" -type f | wc -l) files)"
echo "         replay: PLEX_REPLAY_DIR=$OUT python3 -m queue_builder.cli shows <set> <profile>"
