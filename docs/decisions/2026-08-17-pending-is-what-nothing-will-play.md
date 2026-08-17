# Pending lists what nothing is going to play — the subtraction IS the feature

- **Status:** Accepted
- **Date:** 2026-08-17
- **Type:** feature

## Decision

A **Pending** screen (`/pending`) lists items added to the libraries that **no pool rule and no
queue entry covers**, newest first. Three affordances, one per reason something is on the list:
**Add to ▾** (it should be queued), **Dismiss** (no — per item), **Mark all as seen** (none of
this).

State lives in `/config/pending.yaml`:

| Field | Why it is shaped that way |
| --- | --- |
| `seen_through` | One epoch second. Clearing the list costs one line, not one line per item. |
| `dismissed` | Per-item ratingKeys. Skipping one film must not hide the twelve added after it. |

**Covered** means the same thing it means to the engine:

- a **curated** set names its ratingKey — a queue entry or a pool member — or names a
  **collection** that contains it;
- or a **filtered pool's rule** would sweep it up: its section, past its rating cap, not on its
  blocklist.

**Plex "Other Videos" libraries are skipped unless a set draws from them.**

## Context

> "I'm wondering if we could separately add a 'Pending' or 'New' area to show if there are new
> movies or shows added and allow me to specify the queues to add them **if** they're not
> already picked up by one." — owner, 2026-08-17

He added the reason it matters: *"In the future, I feel like I won't use filtered pools anymore
and will switch fully over to curated pools. That way, I can specify exactly which shows and
anime the kids will see."* Curated everything only works if nothing arrives unnoticed.

## Why

- **The `if` is the whole feature.** A list of everything recently added is Plex's own Recently
  Added and needs no app. The useful list is the one that has already subtracted what the
  household is going to see anyway — so the gate asserts what is **absent**, not what is
  present.
- **A watermark AND per-item dismissals, because they answer different questions.** "I have
  looked at all of this" is one fact; "not this one, specifically" is another, and encoding the
  second as the first would hide everything newer than the thing you skipped.
- **`pending.yaml`, not the SQLite cache.** A dismissal is a decision. It is not recomputable
  from Plex, and it belongs in a file the owner can read and edit, like every other decision
  this app stores.
- **Both Plex reads are parameters**, not imports — the same seam the selection engine uses.
  That is what lets the subtraction rules be tested with no server and no network, and it was
  forced early: ES modules cannot be monkey-patched, so the first draft's internal
  `import('./plex.js')` was untestable.
- **Skipping Other Videos is not tidiness.** On the first real run they were **7 of 11 rows** —
  eleven `[Betterman QC] … x265-10bit {SD SDR}` variants of one clip — burying a film someone
  might actually want. "Nothing plays this" is true of a test encode and completely
  uninteresting. It stays **conditional**, because the judgement belongs to the config: name
  one of those libraries in a queue and its new items are reported again.

## Evidence

- Owner quote above.
- Gate: `e2e/pending-test.ts` — hermetic, offline, 16 checks, all of them about subtraction:
  a show a pool rule sweeps up, a film a queue names by ratingKey, a film inside a named
  collection, and an item added **on** the watermark (pinning the boundary as `<=`) are all
  absent; a show outside the pool's rating cap, a show the pool **blocked** (blocked means
  nothing plays it), and a library no set draws from are all present. Plus dismissal being
  per-item and idempotent, and the watermark being a floor rather than an off switch — a later
  arrival is new again.
- Verified against the live libraries: **4 real rows** (a 1957 film, two seasons of one anime,
  Reservoir Dogs) out of thousands of items — and the "Other Videos" rule is what took it from
  11 to 4.

## Still open

- **No notification.** You have to open the screen; nothing tells you the list is non-empty.
- **Filtered-pool coverage is judged per SET, not per binding** — if any binding's rating cap
  accepts the item, it counts as covered.
- Adding from here always appends to the **bottom** of the chosen queue.
