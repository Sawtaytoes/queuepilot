# e2e fixtures

Static inputs for the offline gates in `e2e/`. Nothing here talks to Plex.

## `engine-corpus/` + `engine.sets.yaml` + `engine.queues.yaml`

A **synthetic** Plex corpus in the same on-disk scheme the replay client reads
(`get/<alias>/<sha1(path)[:16]>.json`, payload `{"data": {"MediaContainer": …}}`) —
`server/src/engine/plex-replay.js` serves the engine from it. It covers the deterministic
selection core: per-account library views, the content-rating cap, history→watched filtering,
a manual start floor, a multi-season show, Season-0 specials/extras, a fully-watched show, a
shorts item section, and the collection-expansion blocklist (bare ratingKey and
`Collection: <name>`).

**It is committed, not generated.** Until 2026-08-12 a Python script (`gen-synthetic-corpus.py`)
rebuilt it on every gate run; that script went with the rest of the Python
([decision](../../docs/decisions/2026-08-12-python-is-gone-except-the-cast-sidecar.md)), and its
last output is what these files are. Owner decision 2026-08-07 is why it is synthetic:
**CI never sees real library data.** A real recorded corpus stays gitignored (`__corpus__/`).

Editing it: hand-edit the JSON (the path hash is `sha1(path)[:16]`, so a NEW path needs its
filename computed the same way), then re-run every gate that reads it. Adding items changes
what the goldens below expect — that is a behaviour change to reason about, not a refresh.

## `golden/`

The recorded answers of the retired Python engine, frozen the day it was deleted:

| File | Oracle it froze | Gate that reads it |
| --- | --- | --- |
| `routing.json` | `queue_builder.cli route` / `sections` | `e2e/binding-parity.mjs` |
| `passthrough.json` | `config.SETS` per-set passthrough fields | `e2e/set-passthrough-parity.mjs` |
| `engine.json` | `cli buckets` / `rewatch-counts` / `channel-buckets-json` | `e2e/engine-parity.mjs` |
| `curated.json` | `cli next-queue-json` / `reel-json` | `e2e/curated-parity.mjs` |

These are a **contract, not a snapshot to refresh**. A failing gate means the Node engine's
behaviour moved away from the semantics the two engines were proven to share — fix the engine,
or change the golden deliberately, in a commit that says why.

## The rest

`routing.sets.yaml`, `passthrough.sets.yaml`, `sets.fixture.yaml`, `queues.fixture.yaml`,
`queues.harness.yaml` — hand-written YAML inputs for the routing, passthrough, API and
write-side tests.
