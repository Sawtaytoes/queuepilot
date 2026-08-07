# D3 — the engine-parity corpus (record/replay oracle)

**Status: the record/replay oracle is landed; the Node selection-engine port + `engine-parity.mjs`
gate are the remaining D3 work.** Companion to
[decisions/2026-08-03-retiring-python-except-the-cast-sidecar.md](decisions/2026-08-03-retiring-python-except-the-cast-sidecar.md)
and [handoff-python-port-status.md](handoff-python-port-status.md).

## Why a corpus

The Python selection engine (`queue_builder/plex.py`, ~1,400 lines) is what D3 ports to Node.
The only honest way to prove the port matches is to diff it against the Python engine over the
**same Plex inputs** — but those inputs are a live server that changes hour to hour. So we
**record** every read-only Plex response once, then **replay** that fixed snapshot into both
engines. The corpus is the oracle; the port is correct iff it reproduces the corpus's answers.

## How record/replay works (`queue_builder/plex.py`)

- `PLEX_RECORD_DIR=<dir>` — while set, every `_get` (local server) and `_plextv` (plex.tv)
  response is written under `<dir>/<kind>/<token-alias>/<sha1(path)>.json`.
- `PLEX_REPLAY_DIR=<dir>` — while set, those files are served instead of the network. A missing
  file raises `corpus miss: …` (re-record), never a silent live call.
- **No secrets on disk.** Files are bucketed by a stable **alias** (`admin` / `acct:<uuid>`),
  never the token; plex.tv bodies are redacted (`authToken`/`accessToken` → `REDACTED`). In
  replay, `account_token()` short-circuits to a synthetic per-uuid token whose alias matches the
  account's recorded `_get` bucket, so the managed-user library views replay without any plex.tv
  round trip.
- Both unset in normal operation — zero overhead, live server.

Proven determinism: recording `shows shows_shorts "Older Kids"` then replaying it with a **bogus
URL + token** (so any network call would fail) reproduces the live output **byte-for-byte**.

## Recording a corpus

```sh
set -a; source /path/to/agentic/.env; set +a           # PLEX creds
SETS_PATH=/mnt/TrueNAS-Apps/App-Configs/plex-channels/sets.yaml \
QUEUES_PATH=/mnt/TrueNAS-Apps/App-Configs/plex-channels/queues.yaml \
PYTHONPATH=/tmp/pylibs:. OUT=__corpus__/default ./e2e/record-corpus.sh
```

`record-corpus.sh` derives the rotation/queue sets from `config.SETS` (no hand-maintained list),
records against **copies** of the YAML (the `queue` subcommand marks entries done — never point
it at production), and writes ~400 files covering every set's unwatched buckets, rewatch
histograms, curated resolution and collection expansion.

## PRIVACY — a corpus is never committed

A corpus holds real library **titles, watch history, and account ids**. `__corpus__/` is
`.gitignored` and must **never** land in this public repo. The engine-parity gate therefore runs
against one of:
- a **synthetic** corpus (hand-authored minimal Plex responses covering each engine branch — the
  same approach as `e2e/fixtures/routing.sets.yaml` for D2), committed and CI-safe; or
- a **scrubbed** corpus (titles/ratingKeys/account-ids remapped) generated from a real recording.

**Decided 2026-08-07 (owner): SYNTHETIC.** CI's engine-parity corpus is hand-authored minimal
Plex responses (the `e2e/fixtures/routing.sets.yaml` approach), private by construction — no real
library data ever enters this public repo. A real recorded corpus stays a *local* convenience for
spot-checking, never the CI oracle. The synthetic corpus must cover each engine branch
(multi-show rotation, in-progress vs unwatched, Season-0 specials/extras index rules, rewatch
weighting buckets, a curated queue, a collection expansion, a reel).

## The RNG caveat (shapes what parity can compare)

`build_rotation` shuffles show order and `pick_rewatch*` draw weighted-random — seeded by an
injected `rng`. Python's Mersenne Twister will **never** byte-match a JS RNG, so `engine-parity`
must compare the **deterministic intermediates**, not the shuffled/'picked result:

- `_watched_for_set` → the watched ratingKey set
- `channel_buckets` / `unwatched_buckets` → per-show ordered unwatched episodes (pre-shuffle)
- `rewatch_counts` / `rewatch_pool` → the weighted candidate pool + counts (pre-pick)
- `next_queue` / collection expansion / title resolution → fully deterministic (no rng)

The final shuffle/weighted-pick stays covered by each language's own seeded unit tests (the
existing Python ones; Node equivalents land with the port), not by cross-language byte-compare.

## Remaining D3 work

1. Port `plex.js` replay support (read the same corpus dir + alias scheme) so the Node engine can
   run offline against the oracle.
2. Port the selection engine module-by-module (buckets → watched-state → rewatch pool → curated
   resolution → collection expansion), each with a deterministic-intermediate diff in
   `e2e/engine-parity.mjs`.
3. Settle the CI-corpus decision (synthetic vs scrubbed) and add engine-parity as a CI step.
4. Wire the Node engine onto the `ENGINE=node` preview seam D2 already established
   (`engineRouting.forSet` → the pool), logging divergence for the one-week soak before cutover.
