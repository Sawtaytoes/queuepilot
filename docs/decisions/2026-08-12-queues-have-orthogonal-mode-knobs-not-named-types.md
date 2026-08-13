# A queue is ONE object with orthogonal mode knobs — not a named "queue vs channel" type

- **Status:** Accepted
- **Date:** 2026-08-12
- **Type:** data model / playback semantics
- **Supersedes:** [2026-07-21-queues-vs-channels-taxonomy-play-first-ia.md](2026-07-21-queues-vs-channels-taxonomy-play-first-ia.md)
  (the *taxonomy*; its play-first entry IA survives — see "What survives")
- **Superseded by:** —

## Decision

**Delete the `queue` vs `channel` split.** There is one object — a **queue** — with five
independent knobs. Its behaviour is a *combination*, not a type name.

| Knob | Values | Meaning |
| --- | --- | --- |
| `pick_order` | `in-order` · `rotate` · `shuffle` | list order / round-robin across series / random |
| `repeats` | `exhaust-first` · `allow` | must the pool empty before a series can recur |
| `repeat_scope` | `session` · `forever` | how long `exhaust-first` remembers |
| `batch` | N | items per turn before switching — **the "read X chapters before switching" knob** |
| `stop_after` | `one-pass` · `N items` · `keep-going` | the end condition |

All five knobs are **enum- or count-valued**, deliberately. AGENTS.md's `is_`/`has_` prefix rule
applies to booleans; none of these are booleans, and they must not be flattened into booleans
(`is_shuffled`, `is_endless`) because that is exactly the trap this decision exists to escape —
a boolean can only ever express two of the five behaviours below. Any *genuinely* boolean flag
added later does follow the `is_`/`has_` rule.

### Every requested behaviour falls out of a combination — nothing bespoke

| Wanted, in the owner's words | Knobs |
| --- | --- |
| "1 episode of all these shows tonight and no more" | `rotate` · `batch 1` · `stop_after: one-pass` |
| "play this queue in order, 1 episode each" | `in-order` · `batch 1` |
| "random, don't repeat a show until the list is gone" | `shuffle` · `exhaust-first` · `repeat_scope: forever` |
| "full random, can repeat the same night" | `shuffle` · `repeats: allow` |
| "random, no repeats this session, repeats next session" | `shuffle` · `exhaust-first` · `repeat_scope: session` |
| "next chapter of series A, then B, 3 chapters each" | `rotate` · `batch 3` |

That last row is the reading use case, and it needs **no new concept** — which is the strongest
evidence the knobs are cut at the right joints.

### Two implementation rules that come with this

1. **Only `stop_after: keep-going` may emit `continuous: 1`.** Every bounded mode must set
   `continuous: 0`, or the Plex client appends its own "Up Next" suggestions once the lineup
   runs out — which is precisely the behaviour that reads to a viewer as "it plays forever"
   (see Correction 2 below). This is the single highest-risk detail in the whole model.
2. **`repeat_scope: session` is nearly free; `forever` is not.** The session object is in
   memory (`server/src/session.js:19`, `SESSION`), so `session` scope is a field on it.
   `forever` needs **persisted per-pool state that does not exist today** — a new store, with
   the usual YAML-is-the-source-of-truth constraint. Ship `session` first; `forever` is its own
   piece of work.

## Context — correcting the record on what "channel" does TODAY

This decision is only safe to make because two widely-held beliefs about the current behaviour
turned out to be wrong. Both were re-verified on `main` at `621534d` on 2026-08-12.

> **Note on line references.** `queue_builder/` was **deleted** on 2026-08-12 (#60, "Node is the
> only implementation"). Every citation below is to the **Node** engine, which is now the only
> implementation. Earlier documents citing `queue_builder/plex.py` / `playback.py` /
> `config.py` are pointing at files that no longer exist; the behaviour is unchanged, the
> location is not.

### Correction 1 — a channel is a strict round-robin, NOT random

`buildRotation` (`server/src/engine/rotation.js:76`) shuffles **only which show leads**, once
per session, and then emits **one episode per show per round**:

```js
const order = shows.slice();
if (rng) rng.shuffle(order);              // vary which show leads each session
const cursors = new Map(order.map((s) => [s.ratingKey, 0]));
while (queue.length < length) {
  for (const s of order) {
    const i = cursors.get(s.ratingKey);
    if (i < s.episodes.length) { queue.push(s.episodes[i]); cursors.set(s.ratingKey, i + 1); … }
  }
}
```

The output is A-ep1, B-ep1, C-ep1, A-ep2… The *only* randomness is the starting order.
**There is no random-selection mode anywhere in the codebase.** The 2026-07-21 decision
described anime channels as playing "in a random order"; they do not, and never did — which
that decision itself half-caught in its own closing note.

This is why `pick_order` has **three** values, not two: `rotate` (what exists) and `shuffle`
(what was believed to exist) are genuinely different, and both are wanted.

### Correction 2 — it does NOT play forever; the *client* does

The lineup is capped at `ROTATION_LENGTH`, default **12** (`server/src/env.js:81`). But
`createPlayQueue` defaults to `continuous = true` (`server/src/playback.js:266`, emitting
`continuous: '1'` at `:274`), so when those 12 run out the **Plex client rolls into its own
"Up Next" suggestions**. The endlessness is the client's, not ours.

Setting `max_items` already flips it (`server/src/playback.js:516-522`):

```js
// A per-scan cap (max_items) means "play exactly these and stop": drop continuous so the
// client doesn't auto-advance into related content once the queue ends.
const cap = cfg.max_items;
const isCapped = Number.isInteger(cap) && cap > 0;
pqId = await createPlayQueue(ratingKeys, { token: tok, continuous: !isCapped });
```

So **"one episode of each, then stop" is already reachable today** via `max_items`. What is
*not* reachable is **"stop after one full pass"**, because `max_items` is a **count**, not a
pass — with a pool whose size changes as shows are finished, no fixed count expresses "one
round". That gap is exactly `stop_after: one-pass`.

### What `batch` has to do with what already exists

A per-entry batch is already implemented for **curated** entries: `applyBatch`
(`server/src/engine/resolve.js:413`) caps a member to `desc.episodes || defaultBatch`, clamped
to `QUEUE_SERIES_LENGTH` (default 40, `server/src/env.js:72`), and `batch_stops_at`
(`resolve.js:388`, entry > set > env precedence) forbids a batch from spanning a member or
season boundary.

But the **rotation path deliberately passes no batch** — `memberBuckets`
(`rotation.js:43`) calls `resolveMember` with no `defaultBatch`, so each bucket keeps its full
ordered list, and `buildRotation` then takes exactly **one** item per show per round
(`rotation.js:88`).

So `batch` is not a new mechanism; it is **wiring the existing per-entry knob into the
rotation loop**, where today a `1` is hardcoded by construction. `batch_stops_at` composes with
it unchanged and should keep working the same way.

## Why

The old taxonomy split on **playback semantics** — ordered-queue vs random-channel — and then
made the split a *type* (`kind: movies` = queue, `kind: anime` = channel). Three things broke it:

1. **The type never matched the behaviour.** "Channel" was defined as random; the code is
   round-robin. A type name that lies is worse than no type name.
2. **The requested behaviours don't partition into two buckets.** Five distinct behaviours were
   asked for; they need three orthogonal dimensions to express. Two type names can encode at
   most two of them, so every additional behaviour would have become a third type, then a
   fourth — `channel`, `shuffle-channel`, `no-repeat-channel`.
3. **"Channel" collides with the backends.** Plex, Jellyfin and Emby all have real **Live TV**
   channel features. As the app grows past Plex (see the
   [rename ADR](2026-08-12-plex-channels-becomes-queuepilot.md) and the
   [Kavita feasibility record](../kavita-feasibility.md)), an internal "channel" that means
   something different from the host app's "channel" is a permanent source of confusion. The
   same objection killed `tuner` as a product name.

Orthogonal knobs also make the **reading** case fall out for free (`rotate` + `batch 3`) rather
than requiring a "reading channel" type — the test any good factoring should pass.

## What survives from 2026-07-21

Only the **taxonomy** is superseded. Explicitly still in force:

- **Play-first entry IA** — the front door is a play list of everything, and the editors are
  reached *from* it. This decision keeps it and develops it into the queue deck
  ([UI design](../queuepilot-ui-design.md)).
- **Anime sets play as a rotation with a per-show batch** — that is now `rotate` + `batch`,
  the same behaviour under knobs instead of a type name.
- The `sets.yaml` / `queues.yaml` schemas, immutable ids, and everything the
  [sets-registry decision](2026-07-21-sets-registry-immutable-ids.md) settled.

## Scope

**This ADR is design only. No code, schema, or `sets.yaml` change ships with it** — the
migration from `kind`-as-discriminator to explicit knobs (including what each existing set maps
to, and the back-compat read of old files) is a separate piece of work.

## Evidence

- Owner, on the behaviours wanted, including "read at least X chapters before switching" and
  the five rotation/repeat modes tabulated above (2026-08-12 session).
- Correction 1 and 2 verified by reading `main` at `621534d`: `rotation.js:76`, `env.js:81`,
  `playback.js:266,274,516-522`, `resolve.js:388,413`, `session.js:19`.
- The 2026-07-21 decision's own closing note already recorded that the anime sets played
  ordered/top-first at the time, not randomly — the belief it ratified was never true of the
  code.
