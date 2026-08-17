# Lineup length, infinite, and top-up

- **Status:** Phases 1-3 SHIPPED 2026-08-17. What is left is in `## Still open` at the bottom.
- **Date:** 2026-08-17
- **Asked from:** the Younger Kids Shorts card running dry mid-evening
- **Decision:** [a channel sets its own lineup length](../decisions/2026-08-17-a-channel-sets-its-own-lineup-length.md)

## The ask

> "That should be configurable. Play X or play infinite. So #3 needs to
> be there too. Ideally, this would extend to Kavita."
> — owner, 2026-08-17

Three hardcoded answers to "how many items?" existed, and the owner wants
one configurable one:

| Where | Was | Code |
| --- | --- | --- |
| Rotation channel (episodic) | env `ROTATION_LENGTH` = 12 | `providers/plex.ts` |
| Rotation channel (`behavior: rewatch`) | **literally 1** — `return { play: [item] }` | `providers/plex.ts` |
| Kavita | `limit ?? max_items ?? ROTATION_LENGTH` | `providers/kavita.ts` |

## Phase 1 — `length:` (SHIPPED)

Rotation channels take `length: <int>`, set > env, clamped to
`ROTATION_LENGTH_MAX`. See the decision record. **The rewatch branch and
Kavita were NOT converted** — a rewatch channel still plays exactly one
movie, which is correct today and becomes phase 2's problem.

## Phase 2 — infinite, and what "finished" means (SHIPPED)

**Spelled `refill: true`, NOT `length: all`.** The sentinel plan assumed
one infinite lineup; the owner's own description was a WINDOW ("load up X
number… then add more"), and a single infinite lineup would queue the
whole eligible pool up front — 442 items on the live Shorts channel. So
`length` became the window and `refill` the switch.
[batch-all-or-infinite.md](batch-all-or-infinite.md) stays parked and
unaffected: it is about a per-ENTRY batch, a different axis.

The owner's semantics, verbatim:

> "Wrap into rewatch, but for shows, leave an option to start at ep1 when
> complete or stop that show. If you finish all shows, the queue is truly
> done at that point."

So infinite is **not** "loop forever" — it has a real terminator:

- **A series bucket empties** → the entry's `on_complete:` decides.
  - `restart` — back to ep1, the show re-enters the rotation.
  - `drop` — the show retires from this lineup.
  - Set-level default with per-entry override, stored sparsely the same
    way `episodes:` is (see the entry-count decision).
- **Movies** wrap into the rewatch weighting. `pickRewatch` already does
  least-watched-first; infinite just calls it repeatedly instead of once,
  which also makes the rewatch branch honour `length:` for free.
- **Every bucket dropped or exhausted** → the lineup is genuinely done
  and the queue stops. This is the ONLY terminator.

⚠️ `weightedInterleave` already stops when every bucket is exhausted
(`weight.ts`, "every bucket exhausted"). Phase 2 must not confuse *that*
exhaustion (this lineup's slice is full) with a series being *finished*
(no unwatched episodes remain anywhere) — they are different questions
and only the second one triggers `on_complete`.

## Phase 3 — top-up (SHIPPED)

Infinite is meaningless without this: **a Plex playQueue is a fixed list
once created**, so "infinite" can only mean "kept topped up".

**Trigger: HA over MQTT** (owner's choice). New `queuepilot/cmd/topup`
+ `resp/`, alongside the existing `cmd/start` / `cmd/advance` /
`cmd/preview`. An HA automation watches the Shield's `media_player` and
publishes when the remaining count runs low. This keeps the workspace
rule that **HA owns the schedule** — QueuePilot exposes the command and
does the work, and no TrueNAS cron is involved.

**Plex:** extend the LIVE playQueue in place —
`PUT /playQueues/{id}?uri=…` — not build a new one. A new playQueue
restarts playback; extending is invisible mid-episode. Needs the live
`pqId` stored on `SESSION` (which already tracks `queue` / `cursor`).

> ✅ **SPIKED 2026-08-17** (`e2e/spike-playqueue-extend.ts`). It grows the
> queue in place, keeps the id, and successive adds chain in order — so
> top-up IS invisible mid-episode. **But there is no append-at-end**: it
> inserts after the currently selected item, and `next=0` / `next=1` /
> omitting `next` are identical. Seed `[A,B]` + `C` gives `[A,C,B]`.
> That is why `TOPUP_AT` is 3. Do NOT rebuild the queue to get tail
> ordering — rebuilding restarts playback.

**Kavita:** same MQTT command, different handler. There is no playback
session — the reading list is a persistent artifact the tablet pulls
from — so on tick: read progress **on demand** (this stays inside
[Kavita progress is read on demand](../decisions/2026-08-16-kavita-progress-is-read-on-demand-not-pushed.md);
the "demand" is now an MQTT tick rather than a page load, which NARROWS
that record rather than reversing it — supersede it explicitly when this
lands), and if unread falls below a threshold, append the next batch.

**The list is a SLIDING WINDOW, not an append-only log.** Owner,
2026-08-17:

> "we should probably remove some older list items when topping up to
> prevent the list from getting too long"

So a top-up appends at the tail **and deletes fully-read rows from the
head**, holding the list at roughly `length`. This is what keeps
[the reading list is rebuilt, not appended](../decisions/2026-08-15-the-reading-list-is-rebuilt-not-appended.md)
intact — that record exists because `materialize()` silently unioned
every lineup ever built and the live list reached 23 series. A window
that trims is still "exactly this launch's lineup"; a window that only
grows re-opens the same bug by a different door. Delete via
`POST /api/ReadingList/delete-item` with the **ITEM's** id, not the
chapter's, and keep the list ID stable — it is the `/lists/153` the
owner has bookmarked.

## Gate notes

- Assert on the artifact's **contents**, not its identity. The reading-list
  gate stayed green through the append bug because it only checked
  `lists.length === 1`.
- A top-up test must prove the playQueue was **extended, not replaced**
  (same id, longer), or it proves nothing about the hiccup.
- Any infinite test needs a bounded fixture, or it does not terminate.

## Still open

Not built, and not blocking anything that shipped:

- **No UI control.** `length`, `refill` and `on_complete` are editable
  through `PATCH /api/sets/:id` and by hand in `sets.yaml`, but the set
  editor has no widget for them. The count pickers are the obvious model.
- **The rewatch branch is untouched.** `behavior: rewatch` (the kids'
  Movies card) still returns exactly one item and honours neither
  `length` nor `refill`. "Movies wrap into rewatch weighting" means
  calling `pickRewatch` repeatedly, excluding what it already picked —
  the remaining piece of the owner's semantics.
- **`on_complete` is set-level only.** The per-entry override described
  above was not built; every show on a channel currently shares its
  answer.
