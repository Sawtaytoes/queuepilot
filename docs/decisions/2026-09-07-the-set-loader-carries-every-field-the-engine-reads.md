# The set loader carries EVERY field the engine reads, and the parity gate lists them

- **Status:** Accepted
- **Date:** 2026-09-07
- **Type:** correctness / loader contract
- **Supersedes:** —
- **Superseded by:** —
- **Builds on:** [the-promote-window-is-a-queue-setting](2026-08-26-the-promote-window-is-a-queue-setting.md),
  [kind-is-picks-or-rules](2026-08-23-kind-is-picks-or-rules.md)

## Decision

`engine/routing.ts loadSets()` carries `promote_window` and `add_as` onto the set config, and
`e2e/set-passthrough-parity.ts` pins both.

A field that `engine/resolve.ts`, `session.ts` or `playback.ts` reads off a set config is a
field the loader must copy. There is no second reader of `sets.yaml` on the scan path. When a
new set-level knob is added, it is added to the loader and to the parity gate in the same
change.

The gate keeps two lists, and they have different provenance:

- `FIELDS` is checked against `e2e/fixtures/golden/passthrough.json` — the frozen recording of
  the retired `config.py`.
- `POST_PYTHON` holds the knobs added after Python was deleted, with expectations authored in
  the gate. They are **not** added to the golden. The golden is a recording of an interpreter
  that never had these fields, and a row claiming otherwise would make it a fiction.

## Context

`kevin_anime` carries `promote_window: 20h`. On 2026-09-07 at 20:33 the scan logged:

```
[lineup] kevin_anime held back by their lead window: rk:NNNNNN
```

`rk:NNNNNN` is a promoted entry in that queue. Its `lead_cooldown` row said it last led at
21:10 the previous night — a gap of **23 hours 23 minutes**, which is well past the queue's
20h window.

The window the engine used was not 20h. `loadSets()` never copied `promote_window`, so
`leadWindowMs()` read `undefined` and fell through to the product default, which was 24h at the
time. 23h23m is inside 24h, so the entry was held back. Proved by running the real loader over
a fixture copy of that set:

```
promote_window in cfg = undefined
add_as in cfg         = undefined
effective window hours = 24
```

`add_as` was missing the same way, and is the more serious of the two. With it absent,
`kind.normalizeAddAs()` re-derives the lane from `kind`, and `kind: picks` with no `add_as`
resolves to `random`. Five sets in the live registry ask for `add_as: priority`, including
three ordered movie queues. All five were running as a shuffled pool.

## Why

- **A dropped passthrough does not throw.** It reads `undefined` at the consumer and silently
  disables the feature. This is the third time: `requires_profile` in 2026-08-11 left twelve
  profile-gated sets ungated, and the header of `set-passthrough-parity.ts` was written about
  exactly that failure.
- **Every existing test of these two fields hands the engine a cfg DIRECTLY.**
  `e2e/priority-lane-test.ts` case 9 asserts the whole entry > set > default precedence and
  passes; `e2e/kind-normalize-test.ts` asserts the write side and passes. Neither runs
  `loadSets()`. The feature was covered at both ends and broken in the middle.
- **The parity gate is the only place the loader is the subject.** Adding to it is cheap; the
  fixture is synthetic and the assertion is one line per field.

## Evidence

- Container log, `ix-queuepilot-queuepilot-1`, 2026-09-08T01:33:54Z and 01:34:03Z.
- The entry's `lead_cooldown` row: last led 2026-09-06 21:10 local.
- Owner, 2026-09-07: "Started QueuePilot a bit ago, and it didn't play [a promoted entry].
  Why? It's been 20h right?"
