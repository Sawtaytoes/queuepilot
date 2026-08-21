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

## `landing.sets.yaml` + `landing.queues.yaml` + `landing.groups.yaml`

The Play landing at the **density the household actually has** — 17 sets across all three
kinds (4 filtered pools, 5 curated pools, 8 ordered queues), two providers, six groups — for
`e2e/shot-landing.ts`. The three-column layout looked fine on a 5-set fixture and fell apart
on this one, which is the whole reason it exists.

**Anonymized, and that is load-bearing.** The landing renders set NAMES, so a screenshot of
the real thing carries the household's names into a public repo. Everything here is the
repo's own cast — Bob, Alice, Carol, Dave, Erin, Family, Younger/Older Kids — in the same
SHAPES as the real sets (long two-person names, a reel, a Kavita reading list) so the layout
is stressed the same way
([decision](../../docs/decisions/2026-08-19-the-landing-is-one-wrapped-grid-of-typed-cards.md)).

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

**Every queue ENTRY in here is a mapping.** A bare `- "Some Title"` / `- 12345` /
`- "Collection: X"` is the pre-2026-08-21 form, and the engine now refuses one by name
([decision](../../docs/decisions/2026-08-21-a-queue-entry-is-an-object-and-carries-its-rating-key.md)),
so a fixture that still holds one fails the gate that reads it. Write `{title: …}`,
`{ratingKey: …, title: …}` or `{collection: …}` — flow style, so a per-entry comment can stay
on its own line. The rewrite of these files was a SPELLING change and nothing else: `entryKey()`
returns the same key for each of them as it did for the scalar it replaced, which is why the
goldens below did not move.

`batch-stops-at.queues.yaml` — one queue per entry SHAPE for `e2e/batch-stops-at-test.ts`, which
resolves them through `loadEntries()` so the per-entry `batch_stops_at:` override is read the way
the service reads it. It used to hand-build descriptor literals instead, and so passed against a
field `describe()` never wrote.
