# Playing a SECTION of an item — design

> **Status:** design, 2026-09-01. The decision records this doc argues for are
> `docs/decisions/2026-09-01-*`. Read those for the settled rules; this file is the reasoning
> and the implementation map behind them.

## The ask

Play only part of a queued video, and let the same file sit in one queue several times with
different sections at different positions. The motivating case is the Theater Demo Reel
(`docs/demo-reel-channel.md`): today that reel is built from **pre-clipped files** in a
separate "Movie Clips" library, because the only way to show 90 seconds of a film was to cut a
new file. A section is the same reel without the cutting step.

A second ask arrived with the first, and it is the same feature: **begin an episode part-way
in.** The entry-level `start` already picks *which* unit plays (`{series, season, episode}`).
It cannot say *where in that unit* playback begins. "Start season 2 episode 4 at 12:30" and
"play 1:01:00 to 1:06:00 of this film" are one mechanism with two shapes, and building them as
two features would put two half-answers on the same tile.

## The model — `start` gains a position, `end` is its mirror

One idea, two keys, both on the entry mapping:

```yaml
# A film section — the demo-reel case. The unit is the whole item.
# 1:01:00 to 1:06:00.
- ratingKey: 1001
  title: "A Loud Film (2019)"
  start: {position_ms: 3660000}
  end: {position_ms: 3960000}

# The SAME film again, a different section, further down the same queue.
# It carries an `id` because its `rk:` key is already taken by the line above.
- id: 8f3a2c
  ratingKey: 1001
  title: "A Loud Film (2019)"
  start: {position_ms: 5400000}
  end: {position_ms: 5520000}

# An episode, part-way in. `start` already picked the unit; now it picks the offset too.
- ratingKey: 1002
  title: "A Long Show (2024)"
  start: {season: 2, episode: 4, position_ms: 750000}
  end: {position_ms: 1020000}

# Half-open: play from 12:30 to the end of the unit. No `end` key at all.
- ratingKey: 1003
  title: "Another Show (2022)"
  start: {season: 1, episode: 1, position_ms: 750000}
```

### Each end is independently optional

`start.position_ms` and `end.position_ms` are separate keys and neither requires the other.
All four states are meaningful and all four must work:

| `start.position_ms` | `end.position_ms` | What plays |
| --- | --- | --- |
| absent | absent | the whole unit — today's behaviour, unchanged |
| set | absent | from that offset to the end of the unit |
| absent | set | from the beginning of the unit, stopping at that offset |
| set | set | the window between them |

This falls out of the shape rather than being bolted on: they are two keys, and the sparse
rule already says an absent key means "no override". It also means the two asks are literally
the same feature — "start episode 4 at 12:30" is the second row, "play 1:01:00 to 1:06:00" is
the fourth, and neither needs a mode flag to tell them apart.

The consequence for the UI is that the paired timecode control must accept an open value at
**either** end, not just an open end.

Why this shape rather than a separate `clip: {start_ms, end_ms}`:

- **`start` is already "where playback begins".** It names a member, a season and an episode.
  A position is the next term in that same sequence, not a different concept. A sibling `clip`
  key would leave two places to answer one question, and an entry could hold both and disagree.
- **`end` is symmetric and has room to grow.** It is nested (`end: {position_ms}`) rather than a
  bare `end_ms` so that "stop after season 2 episode 6" is a later addition to the same key
  instead of a second one.
- **A movie is not a special case.** It is the shape where the unit is the whole item and
  `season`/`episode` are absent — exactly how `start` already behaves for a movie member of a
  collection.

### The window applies to the FIRST played unit only

An entry that contributes three episodes per visit takes its `start.position_ms` on the first
episode; episodes two and three play in full. `end.position_ms` stops that same first unit.

This is the only reading that makes both asks work. "Start episode 4 at 12:30" means *this*
episode, not every episode. A section of a film is one unit by construction. An entry that
wants three separately-windowed sections is three entries — which is what the identity change
below exists to allow.

### Validation

Validation follows from that table: when BOTH are set, `end` must be strictly after `start`.
When only one is set there is nothing to compare it against, so the only check is that it sits
inside the item duration. A window whose two ends are equal is refused rather than swapped —
a zero-length section plays nothing, and silently swapping it would hide a typo.

### Units

`position_ms` is **milliseconds**, matching every other duration on the server
(`Tile.duration`, `queue_entry_history.position_ms`, Plex's own `viewOffset`). The MQTT
now-playing payload is the one place that speaks seconds, and `finished.ts nowPlayingMs()` is
already the single converter. The `_ms` suffix is carried on the key because a bare `position`
gives the reader no way to know the unit.

The UI never shows milliseconds as a number. It shows `hh:mm:ss.mmm` through the new
Charcuterie `TimecodeInput`.

## Entry identity — the same file, more than once

Today one queue cannot hold the same file twice. `queues.entryKey()` returns `rk:<ratingKey>`,
so a second copy is refused by `addItem` and, if it existed, would be addressed ambiguously by
every mutation.

**The change: an optional `id:` on the entry mapping, read as the FIRST branch of `entryKey()`,
falling back to `rk:`/`title:` when absent.** `addItem` mints an `id` only for an add that would
otherwise collide. A legacy entry keeps its `rk:` key byte-for-byte, so nothing re-keys and no
fixture moves.

This restores the invariant the ~60 key-addressed call sites were written against — one key,
one line — rather than teaching all of them a new one. It is what makes the rest cheap:

- Every `rewriteEntry` setter (first match) and every `removeItem`/`markDone`/`clearDone`
  (all matches) converge on the same single line, so neither has to change.
- `applyOrder`'s `Map` and `moveItem`'s destination guard stop collapsing two lines into one.
- `queue_entry_history (set_id, entry_key, item_key)` and `lead_cooldown (set_id, entry_key)`
  become correct with **no migration** — two sections of one film get independent progress and
  independent lead cooldowns, which is the whole point.
- Every React key, selection id, drag `data-key` and `?only=` URL segment in the web app
  becomes unique again.

### What this supersedes, and what it does not

`docs/decisions/2026-08-21-a-queue-entry-names-an-item-not-a-line.md` says a queue entry names
an ITEM, and refuses a second copy. A section entry names a LINE. That clause is superseded.

Its stated reason for pinning `entryKey` no longer holds, and this is worth recording because
it is repeated in a dozen comments across the tree:

1. *"the Python prune addresses the same lines by it"* — `queue_builder/` was **deleted** in
   `7bf01e0`. There is no second writer. Only `cast_sidecar/` is tracked Python and it never
   reads an entry key.
2. *"`e2e/fixtures/golden/` records what it returns"* — it does not. None of the four golden
   files contains an `rk:` or `title:` key. The contract those fixtures pin does not cover
   entry identity.

The third reason — *"`removeItem`/`reorder`/`moveItem` address a line by it"* — stands, and is
exactly why `id:` is additive rather than a change to the existing key format.

**Not superseded:** coverage. `pending.ts` asks "does a queue already name this item?", and two
sections of one film still cover one film. That logic is item-keyed and stays item-keyed.

### The duplicate guard stays, with a door in it

`entryIdentity.findDuplicateItem` refuses adding a film a queue already names, and the web app
badges the search row "In this queue". That guard is right for the ordinary case — an
accidental second copy in a watch queue is a bug, not a feature. So:

- An add that **carries a window** bypasses the check, the way a collection add already does.
- An add that does not gets an explicit **"Add another"** action on the already-here row. The
  refusal stops being a dead end without becoming silent.

## Playback

### Starting at a position

Two paths, because Plex gives us two.

- **The head item** — free. Companion `playMedia` already takes an `offset` that applies to the
  item it starts on (`playback.ts:1033`), and `PlexArtifact.offset` already carries it. A head
  section's start is that offset. No extra round trip, no seek, no delay.
- **Every other item** — a seek after the player advances, which is what `resume.ts` already
  does for resume points.

`resume.ts` cannot be reused as it stands, and the reason is structural rather than a
tuning problem:

- Its plan is `Map<ratingKey, ms>` (`resume.ts:83`), so a second section of the same file
  **overwrites** the first.
- Its `seen: Set<string>` considers each ratingKey **once** (`resume.ts:152, 171`), so the
  second occurrence is answered `already considered` and never seeks.
- Its filters drop exactly the values a section needs: `RESUME_MIN_MS` (30 s) would discard a
  section starting at 0:12; `RESUME_MAX_FRACTION` (0.95) would discard a closing-gag section;
  `viewCount >= 1` would discard any section of a film already watched.

Those filters are all correct **for a resume marker**, which is inferred data. A section is
authored data. So the section plan is its own thing, keyed by **playQueue index** rather than
ratingKey — `readPlayQueue().selectedOffset` (`playback.ts:506-525`) is the only signal that
says which *occurrence* is playing, and it is already read by the top-up path.

### Stopping at a position

Nothing stops playback at a mark today. The mechanism is `transport('next')` →
Companion `skipNext` (`playback.ts:871-881`), which exists and is used by the Now-playing bar's
next button. Nothing server-side calls it on its own yet.

`advanceSession()` is the wrong tool: it rebuilds the whole playQueue and restarts playback,
which `topup.ts` names as the thing to avoid.

### Latency — why a section that starts 5 seconds late is a broken section

The owner reports seeking takes 4–5 seconds. That number is not mysterious, and it is almost
entirely one line:

```
RESUME_POLL_MS = 5_000        # env.ts:143
```

The seek cannot fire before the next tick after the player advances, so mean detection is
**2.5 s** and worst case **5 s** before a byte goes out. Then `considerSession` may decline once
with `retry: true` when `/status/sessions` still reports the previous item's position against
the new ratingKey — a documented live observation (`resume.ts:161-165`) — which costs **another
full poll**. 5 s and 10 s are both reachable and both match "4–5 seconds".

The rest of the budget, in order of size:

| Term | Cost | Where |
| --- | --- | --- |
| the poll interval | 0–5 000 ms | `env.ts:143` |
| a `retry` decline | +5 000 ms | `resume.ts:161-165` |
| `companionTarget()` MISS is never cached | a plex.tv WAN round trip **per poll** | `playback.ts:304-326` |
| `plexReq` default timeout on the poll path | 60 000 ms, no retry | `playback.ts:380` |
| `findClient()` re-resolved per poll AND per seek | 0 hops when `SHIELD_CLIENT_URI` is set | `playback.ts:423-441` |
| the seek itself | one LAN HTTP round trip, tens of ms | `playback.ts:889-918` |

**The seek is not slow. Finding out that it is due is slow.** The fixes, cheapest first:

1. **Negative-cache the `companionTarget` miss** with a short TTL. Today a Shield that is not
   advertising a connection costs a WAN round trip to `plex.tv/api/v2/devices` on every poll,
   every seek and every transport verb — and "not advertising" is precisely the state the system
   is in while Plex is mid-navigation, which is when a section is about to start.
2. **Resolve the client target ONCE at arm time** and hand it to the watcher, instead of
   re-resolving per tick and again per seek. `resume.arm()` already stores the device.
3. **Give the poll path its own short timeout.** 60 s on a 5 s cadence means one hung socket
   stalls the watcher for twelve ticks.
4. **Drive the section boundary off the push feed, not a poll.** `queuepilot/now-playing` is
   already subscribed (`mqttc.ts:94-98`), already carries `position` + `positionAt`, and
   `NowPlayingBar.tsx:133-142` already extrapolates it at 1 Hz to paint a live scrub bar.
   `finished.ts` already trusts those fields. A local 1 Hz timer over an extrapolated position
   beats a 5 s HTTP poll for the stop-at, with no new transport.
   ⚠️ `resume.ts:16-23` records that this same topic was rejected for the *resume* trigger
   because it reported `{"state":"playing","ratingKey":null}` on this setup. Verify the live
   payload before trusting `ratingKey`; the position fields are already trusted in production,
   the naming fields are not.
5. **Cut `RESUME_POLL_MS`** for the fallback path. It is a plain env int with no other consumer.

One hazard to check before shipping: `commandID` is hardcoded to `'1'` on every Companion
command (`playback.ts:840, 907, 1044`). Companion expects a monotonically increasing per-client
id. It has never mattered because commands are isolated — a section fires **seek then skipNext
in quick succession**, which is the first time this codebase sends two close together.

### Measured — what the fixes actually bought (2026-09-02)

Fixes 1, 2, 3, 4 and 5 above shipped, latency-only, ahead of the section work. The numbers are
from `e2e/resume-latency-test.ts`, which drives the **real** `startWatch()` against a virtual
clock and the injected `fetchSession`/`seek` seam. Run it to reproduce them.

Four numbers around the loop are modelled, not measured, and the harness prints all four: a
`/status/sessions` GET at 25 ms, a plex.tv round trip at 250 ms, a 1 000 ms window in which
`/status/sessions` still reports the previous item's position after an advance, and a 300 ms
PMS → Home Assistant → MQTT push delay. So the DECISION latency below is exact and the
transport latency is by assumption — which is the right split, because the transport was never
the slow part.

| Applied | Mean | Worst case | Detection only, mean / worst |
| --- | --- | --- | --- |
| today (5 000 ms poll, no fast retry, target re-resolved per call) | 3 789 ms | 6 519 ms | 3 029 / 5 524 ms |
| + target cached at arm time, and a MISS negative-cached | 3 504 ms | 6 019 ms | 2 529 / 5 024 ms |
| + poll cut to 1 500 ms | 1 765 ms | 2 519 ms | 779 / 1 524 ms |
| + a declined read re-reads after 400 ms | 1 244 ms | 1 524 ms | 779 / 1 524 ms |
| + the now-playing push wake-up (all of them) | **1 175 ms** | **1 199 ms** | **296 / 325 ms** |

**The diagnosis above holds.** The poll interval plus the `retry` decline are 3 029 ms of the
3 789 ms mean — about 80% of it, and effectively all of the variance. Cutting them is what
moved the number.

**One correction to the ordering.** The list is introduced as "in the order they pay off", and
on LATENCY that order is backwards: the `companionTarget` negative cache is the *smallest* of
the five, worth about 285 ms of the mean, while `RESUME_POLL_MS` alone is worth about 1 700 ms
and the push wake-up takes detection from 779 ms to 296 ms. The negative cache is still worth
doing first — it is the cheapest change, and a WAN round trip on every poll is a cost question
as well as a latency one — but it is not where the seconds were.

**What is left is not the schedule.** With every fix applied, detection is 296 ms mean and
325 ms worst. The remaining ~880 ms is the modelled window during which `/status/sessions`
still answers with the previous item's position, which no amount of polling can shorten. If
that number needs to come down, the lever is PMS's own `/:/websockets/notifications` timeline
feed, not a faster poll.

### Measured — the stop at the end mark (2026-09-02)

The section path shipped on top of the latency work above. The stop is not a poll: the read
before the mark says "the end is 87 s away at this position", so the next read is BOOKED for
then — the `mark` trigger. What is left is the two round trips either side of the decision,
plus however stale the position that decision was made on can be.

One number is modelled and it dominates the answer: `/status/sessions` reports `viewOffset`
from the player's timeline rather than continuously, so a read landing exactly on the mark can
answer with a position up to **one grain** old. Modelled at 1 000 ms, and printed with the
results. From `e2e/resume-latency-test.ts`, sweeping the phase of the mark against the booked
read.

| Stopping at the end mark | Mean | Worst case |
| --- | --- | --- |
| the read is BOOKED for the mark (shipped) | **475 ms** | **900 ms** |
| the same stop on a plain 1 500 ms poll | 925 ms | 1 400 ms |
| booked, with an exact position source | 50 ms | 50 ms |

**The scheduling is not what is left.** With an exact position source the overshoot is 50 ms —
the `/status/sessions` GET and the `skipNext`, and nothing else. The other ~425 ms is the grain,
which no cadence can shorten. If that number ever needs to come down, the lever is the same one
the seek latency has: PMS's own `/:/websockets/notifications` timeline feed.

**It never fires early.** The position a decision is made on is at or behind the truth, so the
overshoot floor is zero and a clip is never cut short. A player PAUSED short of the mark is
re-booked rather than advanced, which the harness pins separately.

## Provider capability

A section is a seek plus a stop on a **timeline held by a player QueuePilot can command**. Only
Plex qualifies. Kavita is manga pages; Board Game Picker is a physical table; Steam and MiSTer
are a launch URL and then QueuePilot loses control. All four are `delivery: 'pull'`.

So the flag goes on the provider, following `stampsQueuedAt` exactly
(`types.ts:1309-1318`), plus a kind-keyed map in `providers/config.ts` so the API can report the
capability **without instantiating a provider** — which is what lets the web app hide the
control for a reading queue before any token is needed.

This matches `docs/decisions/2026-08-30-the-watch-history-source-is-a-provider-capability-and-queuepilot-is-the-fallback.md`:
a provider that cannot serve a thing offers no control for it, rather than accepting one and
silently ignoring it.

## Watch history — and why this is one more thing QueuePilot stores

An entry with a window plays part of a file. Whether that counts as watching it is the queue's
call, not this feature's: the entry follows its queue's `watch_history` setting, unchanged.

It is worth naming the pattern, because this is the third time it has come up. Plex holds one
`viewOffset` and one `viewCount` per item per account. A queue that plays 90 seconds of a film
at 1:01:00 and another 40 seconds of it at 1:30:00 has **two positions in one file**, and Plex
has nowhere to put the second. The same was already true of a start point
(`2026-08-30-a-manual-start-can-own-its-progress`) and of two queues holding the same series
(`queue_entry_history` exists so they advance independently).

So the ledger is QueuePilot's, deliberately, and the window lands in it: `queue_entry_history`
is keyed `(set_id, entry_key, item_key)`, and once `entry_key` is unique per line, two sections
of one film get two rows without a schema change. That is the same reason `watch_history: queue`
exists. It is not drift — Plex's model is one position per item, and a queue that curates
sections needs one position per *entry*.

## Not in scope — music queues

A music queue is Music Assistant, not QueuePilot, and QueuePilot has no audio provider. A music
**video** is an ordinary Plex video item and gets sections for free the day this ships, because
it goes down the same Plex push path as any other video.

Pulling a section out of an audio track for a queue is a real and separate question. It is
written up in `docs/todos/music-queue-sections.md` rather than built here.

## Implementation map

| Concern | Where |
| --- | --- |
| the key | `server/src/queues.ts:57` `entryKey()` **and its byte-identical twin** `server/src/engine/resolve.ts:319` — both change together |
| minting an `id` | `server/src/queues.ts:258` `addItem` (only when it would otherwise refuse) |
| refusing a hand-written window with no `id` | `server/src/engine/resolve.ts:428` `loadEntries()`, using the `legacyEntryMessage` shape |
| the duplicate bypass | `server/src/entryIdentity.ts:101` `findDuplicateItem`, beside the collection bypass |
| the fields | `server/src/types.ts:144` `Start`, `:649` `EntryExtras` |
| normalise + write | `server/src/queues.ts:785` `normalizeStart`/`setStart`, plus a new `setEnd`; sparse rule — an absent/invalid value DROPS the key |
| the route | `server/src/routes/queuesRoutes.ts:720` is the template; `PATCH /api/queues/:set/items/:key/end` is its sibling |
| the wire | `server/src/routes/queuesRoutes.ts:29` `startOf` + the `queueTile` literal at `:95` |
| the descriptor | `server/src/engine/resolve.ts:334` `describe()` — **all three arms**, or `tsc` fails |
| head offset | `server/src/engine/resolve.ts:1306` `headResumeOffset`, `server/src/providers/plex.ts:362` `PlexArtifact.offset` |
| the section plan | `server/src/section.ts`, keyed by playQueue index — SHIPPED |
| the window on the first unit | `server/src/engine/resolve.ts` `sectionOf()`, applied in `nextQueue` and `buildReel` — SHIPPED |
| stop + advance | `server/src/playback.ts` `transport('next')`, wired from `session.ts` — SHIPPED |
| completion at a boundary | `server/src/section.ts` `recordBoundary`/`takeBoundary` + `finished.ts finalizeSectionBoundary()` — SHIPPED |
| capability | `server/src/types.ts:1309` (interface) + `server/src/providers/config.ts:82` (kind map) |
| store | **nothing.** `queue_entries.data` is the whole mapping as JSON; `start` has no generated column and neither does `end` |

The SQLite store needs no migration. `store/db/queues.ts` shreds the entry mapping into `data`
and re-assembles it, so an unknown key round-trips — a property `e2e/store-backend-parity-test.ts`
already pins, and `e2e/entry-objects-test.ts` already asserts for "a field this code has never
heard of".
