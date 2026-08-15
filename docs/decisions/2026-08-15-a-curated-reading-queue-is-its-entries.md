# A curated reading queue is its ENTRIES, not its libraries

- **Status:** Accepted
- **Date:** 2026-08-15
- **Type:** bug / architecture
- **Supersedes:** —
- **Superseded by:** —

## Decision

**`buckets()` takes the set's curated entries, and they beat `libraries`.** A `source: queue`
set IS its entries; `libraries` is the pool a RULE-based channel draws from. A set with no
entries still falls back to its libraries, unchanged.

Three things fall out of actually reading the entries, and all three are part of this
decision:

1. **The per-entry `episodes:` override reaches the lineup**, and the interleave slices each
   bucket's OWN batch. A shared slice width would apply one entry's "read 5" to every other
   series in the queue.
2. **Done entries are dropped**, so a consuming queue does not re-serve what has been read. A
   `keep_completed` / reel queue never marks anything done, so it needs no special case.
3. **A `kind: anime` set shuffles**, which is what its own editor copy promises. The same rule
   `playbackRoutes` already uses to tell the engine a curated set is random.

## Context

The owner, 2026-08-15, after opening the reading list his "Manga & Webtoons" queue had built:

> "Noticed that I have this queue for Kavita, and when I opened it in Kavita, I got this one:
> https://kavita.example.com/lists/153 — And that queue has only ONE of the ones I added."

Read back live, the list held **12** items, in alphabetical order, drawn from the Manga and
Webtoons *libraries*. The queue itself holds **93** hand-added entries. Exactly one of the
twelve was among them, by coincidence.

`launchDescriptor()` called `provider.buckets({ cfg, libraries: block.libraries })` and
`kavita.buckets()` enumerated `seriesForLibrary()`. Nothing on either side ever opened
`queues.yaml`. The 93 entries were decoration.

## Why

- **The Plex side never had this bug**, because its curated resolver is entry-driven by
  construction (`nextQueue` walks descriptors off `queues.yaml`). The reading path grew from
  the *rotation* shape — "everything in these libraries with something unread" — and the
  curated case was never wired. This aligns the two.
- **The cap made it invisible.** `ROTATION_LENGTH` (12) is a sane bound on a launch, and 12
  plausible-looking series in a reading list looks like a working feature. Only counting them
  against what was actually added shows the fault.
- **It is also why two other knobs were dead.** `block.batch` was never passed by the
  launcher, and the per-entry `episodes:` had no path to a pull provider at all. Both are
  live now because there is finally an entry list to hang them on.

## A second bug found in the same queue, fixed with it

**A volume-based manga read as fully read.** Kavita puts NOTHING in `series-detail`'s
`chapters` / `specials` for a volume-based series — every chapter hangs off
`volumes[].chapters[]`. `orderedUnread()` read only the first two, so "Alice in Borderland",
0 of 328 pages read, rendered **"All read"** and could never enter a lineup.

Verified live: that series answers `chapters: 0, specials: 0, volumes: 9`.

Two details the fix has to get right:

- **Dedupe by chapter id.** A chapter-based WEBTOON returns the same chapters in BOTH places
  ("The Sword-Eating Swordmaster": 21 loose AND 21 under volume 1), so a naive union queues
  every webtoon chapter twice. The loose copy wins, which keeps webtoons byte-identical.
- **Sort by (volume, chapter).** Every chapter of a volume-based series carries Kavita's
  `-100000` no-subdivision sentinel, so a sort on the chapter number alone leaves the volumes
  in whatever order the wire chose.

That sentinel must also never reach the UI: a whole volume presents as the VOLUME
(`Volume 1`, number 1, `unit: 'volume'`), not as `Ch -100000`.

**This is also the "97 vs 103" discrepancy `pool()` already documented** between Kavita's own
`unreadCount` and the run parsed here — the missing six were volume-based series, not
"chapters reporting 0 pages" as the comment guessed.

## Consequences

- `BucketsContext` gains `entries` (`{id, batch}[]`) and `isRandomOrder`.
- An entry naming a series Kavita no longer has is skipped, not fatal — one stale entry must
  not make a 93-entry queue unlaunchable.
- `/go/<set>?only=<entryKey>` narrows the same path to a single entry, which is what the
  per-tile ▶ on a reading queue uses.
- A queue larger than the cap now shows a DIFFERENT slice each launch rather than the same
  first twelve forever.

## Evidence

- Owner quote + the live list (`/lists/153`, 12 items) read back through the Kavita API,
  2026-08-15.
- `series-detail` shapes for both a manga (4672) and a webtoon (4577) captured live the same
  day and reproduced verbatim in `e2e/kavita-volumes-and-members-test.ts` (8 cases, HTTP fully
  stubbed), wired into CI.
- Verified end to end against live Kavita after the fix: a 3-entry queue with `episodes: 3`
  produced 3 chapters of one series, 3 volumes of Alice in Borderland, then the next series —
  and never touched `seriesForLibrary`.
- All five golden parity gates pass, so the Plex engine is unmoved.
