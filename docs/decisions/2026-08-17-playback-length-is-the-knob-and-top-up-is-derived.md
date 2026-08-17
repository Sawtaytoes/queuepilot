# Playback Length is the knob, and top-up is derived from it

- **Status:** Accepted
- **Date:** 2026-08-17
- **Type:** feature / ui / architecture
- **Supersedes:** the `refill:` flag from [a lineup refills instead of ending](2026-08-17-a-lineup-refills-instead-of-ending.md) (the top-up MECHANISM in that record stands)
- **Superseded by:** —
- **Extends:** [the lineup knobs live in the pool editor](2026-08-17-the-lineup-knobs-live-in-the-pool-editor.md)

## Decision

**One control: "Playback Length" — 1 / 8 / Infinite / Custom.** How many
things a set plays in one sitting, then stops. It replaces the "Items
queued ahead" knob that shipped hours earlier.

The queue window is no longer configurable. It is env `ROTATION_LENGTH`
(12) and top-up keeps it full — the owner:

> "I think we don't need 'Items queued ahead'. Just default to 12 and use
> top-up to fix it. What we _really_ need is a way to specify or
> configure the number of movies/episodes to watch in a given setting."

**Top-up is DERIVED, never configured beside it.** It turns itself on
exactly when the playback length exceeds one window — every `infinite`
set, and a Custom above 12. The `refill:` checkbox is gone. This removes
the one combination that could only ever be wrong: *infinite with top-up
off*, which silently stops at 12.

**`infinite` is a NAMED value**, on disk and on the wire. Never `0`, never
`999` — a falsy count already reads as *uncapped* in `resolve.ts`'s
`applyBatch`, so a sentinel would turn a typo into a binge. This is the
rule `docs/todos/batch-all-or-infinite.md` settled for the per-entry
batch, applied here.

**Every kind of set has it**, including rewatch pools. That was the ask:

> "Movies are gonna be 1 based on _my_ configuration today, but we
> _should_ be able to change that."

## The unit differs on exactly one path, and it has to

| Set | Counts | Default (= today's behaviour) |
| --- | --- | --- |
| Filtered pool, `progress` | items | 12 |
| Filtered pool, `rewatch` | items (films) | **1** — it returned one film, hardcoded |
| Curated pool (`kind: anime`) | items | 12 |
| **Ordered queue** | **entries** | **1** — it played its head entry and stopped |
| Kavita reading list | items | 12 (a list is not a sitting — see below) |

An ordered queue counts **entries** because a show entry's batch is
already its own knob (`episodes:`). Counting items there would make a
length of 1 truncate a 2-episode entry to a single episode — a silent
behaviour change on every queue that never touched the control. The
first cut did exactly that and `resume-in-queue-test` caught it.

For the owner's own Movies queues the two agree anyway: one entry is one
film.

**Kavita keeps a window fallback.** Its artifact is a persistent reading
list the tablet pulls from over days, not a sitting; the ordered-queue
default of 1 would collapse the list to a single series. A reading queue
that *states* a length still gets it.

## No existing set moves on deploy

Every default above is the behaviour that kind already had, so a file
that never says `length:` builds the same lineup after this change as
before it. That is the claim `e2e/playback-length-test.ts` pins hardest.

The live **Younger Kids — Shorts** card is `length: 12, refill: true` on
disk right now. `refill: true` reads as `infinite` — which is what it
always meant — so the card keeps refilling with its file untouched. The
first save through the editor writes `length: infinite` and drops
`refill`. That is the whole migration.

## Turning the room off

A set may ask, when its sitting finishes, for the room to be shut down —
the other half of a card start, which wakes it.

**QueuePilot announces; it does not switch anything off.** It publishes
`queuepilot/resp/finished` with `power_off`, `played`, `target` and
`isComplete`, and Home Assistant owns anything with a power cable. That
is the workspace rule (services talk over MQTT; HA owns the physical
world), and it is also the right seam: whether to honour the request —
who is still in the room, what time it is — is automation judgement, not
queue-builder judgement.

`isComplete` separates the two endings deliberately: the length was
reached, or the pool ran dry early. A lights-out rule probably wants the
first and not the second.

Nothing fires on an `infinite` set. It never finishes.

## Why

- **The window was never the question.** "How far ahead do you queue" is
  an implementation detail nobody on the sofa has an opinion about;
  "play some and stop" is the thing they actually want.
- **Three of the four paths hardcoded their length**, and two of them
  hardcoded it *differently*. One module (`engine/playbackLength.ts`) is
  now the only place that answers it.
- **A derived top-up cannot be set wrong.** A checkbox beside the length
  could.

## Evidence

- Owner, 2026-08-17, quoted above.
- Gate: `e2e/playback-length-test.ts` — every kind's default, the
  resolution rules, the derived top-up, the legacy `refill` read, and
  the sparse storage. Plus the full offline suite re-run green, including
  the three parity oracles (`curated`, `engine`, `set-passthrough`).
- `resume-in-queue-test` is the one that caught the entries-vs-items
  error, which is why the table above is in this record rather than in a
  comment.
