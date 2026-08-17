# A show can override its pool's `on_complete`, and "drop" never removes anything

- **Status:** Accepted
- **Date:** 2026-08-17
- **Type:** feature / ui / copy
- **Extends:** [a lineup refills instead of ending](2026-08-17-a-lineup-refills-instead-of-ending.md)

## Decision

**`on_complete_by_show`** — a map keyed by ratingKey (`section-<id>` for a
whole item bucket), the same shape and the same keying `starts` and
`weights` already use. A rule-derived show has no stored entry to hang a
field on, so a map on the set is the only place it can live.

**Three states per show, not a boolean:**

| stored | means |
| --- | --- |
| absent | follow the pool's own `on_complete` |
| `restart` | start this show over when it finishes |
| `drop` | let this show finish, even on a pool that restarts |

The third is the entire point. The owner:

> "I agree, it would be good for each show to override this set-level
> config."

and the case he described is a pool set to restart with one show carved
out. A boolean could only ever have expressed the other direction.

An unrecognised value **follows the pool**, rather than inverting it.
`sets.yaml` is hand-edited over SMB, and a typo that silently flips a
show to the opposite of what its pool says is the failure that looks
exactly like the feature working.

Edited from the pool grid, beside the weight picker that already lives
on the same tile.

## And a copy correction

The set-level dropdown said:

> Drop it — it leaves this pool

It does not. The owner caught it:

> "I hope you mean 'drop it' as in 'mark as completed' and don't play it
> again, but it doesn't 'drop it' in terms of removing it unless we
> configured the settings that way for the queue."

He is right, and `select.ts` is unambiguous: a finished show yields an
empty `unwatched`, the `if (eps.length)` guard never pushes a bucket, and
**nothing is written and nothing is deleted**. A filtered pool is
recomputed from libraries and ratings on every scan, so the show returns
by itself the moment a new episode lands.

Removal is a different mechanism on a different kind of set: the curated
queue's `done` flag and its `remove_completed_after` TTL, which really do
delete entries from `queues.yaml`.

So the option now reads **"Let it finish — nothing plays from it"**, and
the hint says outright that nothing is removed.

## Why the wording mattered enough to record

A control that claims to delete something is a control nobody dares
press. The behaviour was always right; the label was inviting the owner
to avoid the safer of the two options.

## Evidence

- Owner quotes above, 2026-08-17.
- Gate: `e2e/on-complete-test.ts` covers both directions (a restarting
  pool with one show told to finish; a dropping pool with one told to
  restart), that an override names ONE show, that junk follows the pool
  on both kinds of pool, and that the spelling is case-insensitive.
- Driven against a live pool: picking "Let it finish" on Alphablocks
  wrote `on_complete_by_show: {"190990": drop}` and read back after a
  reload.
