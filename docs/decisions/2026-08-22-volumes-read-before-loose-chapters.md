# Volumes read before loose chapters — and a sole-chapter volume is a volume

- **Status:** Accepted
- **Date:** 2026-08-22
- **Type:** bug / playback order / labelling
- **Supersedes:** —
- **Superseded by:** —
- **Extends:** [2026-08-16-a-volume-is-not-a-chapter](2026-08-16-a-volume-is-not-a-chapter.md)

## Decision

**For a series that has both tankobon volumes and loose chapter releases, unread
volumes come first.** Loose weekly chapters follow after every volume, in chapter
number order. Volumes are the catch-up read; chapters are the brand-new releases
that sit ahead of the latest volume.

**A volume with exactly one chapter is the volume itself**, even when Kavita did
not stamp the `-100000` "no subdivision" sentinel on it. The sole chapter is
labelled and counted as `unit: volume` (Volume N), never as "Chapter 1".

**When the same chapter id appears both loose and under a volume, the volume
copy wins the dedupe.** Preferring the loose copy was what stripped the volume
off every tankobon Kavita also listed in `chapters[]`.

## Context

Two live failures on the Manga & Webtoons reading queue, same root cause:

1. **Mixed series opened on the newest chapter.** A series with Volume 1 still
   unread and loose chapters 48.5 / 50 / 51 was queued as chapter 48.5 when the
   queue's chapter batch was 3. Sorting used `(volume?.minNumber ?? 0, chapter)`,
   so every loose chapter sat at "volume 0" and therefore FIRST.

2. **Every tankobon labelled "Chapter 1".** A volume-based series whose files
   parsed as `number: '1'` / title "Chapter 1" (not the `-100000` sentinel)
   rendered every volume as Chapter 1. The chapters also appeared in the
   top-level `chapters[]`, and the loose-wins dedupe threw the volume away
   before the sole-chapter rule could fire.

A third series on the same queue (sentinel volumes, no loose chapters) already
labelled correctly — that is why the bug looked series-specific.

Owner, 2026-08-22:

> "Volumes should be prioritized over chapters as they release later, but
> they're the _real_ read. Chapters are the brand spankin' new ones and 48.5
> is much newer than Vol1."

Confirmed rule for a mixed series: **volumes first, then chapters** (not
"hide chapters until every volume is done" — after the volumes are in the
list, the weekly releases follow naturally).

## Why

- **Catch-up is volumes.** Opening on chapter 48.5 of an unread series skips
  the entire tankobon run the owner actually wants to read.
- **The sentinel is not universal.** Kavita's own series view labels
  sole-chapter volumes as Vol. N regardless of the chapter number; QueuePilot
  has to do the same or the start picker and the tiles disagree with Kavita.
- **Loose-wins was a webtoon convenience that broke manga.** A webtoon still
  sorts correctly when the volume copy wins: its many chapters under volume 1
  stay `unit: chapter` and order by chapter number.
- **One code path.** The continue-point shortcut named a chapter without its
  volume, so a whole-volume item could not be labelled. `series-detail` is
  already what tiles and pool pay for; launch now uses it too.

## Consequences

- `orderedAll()` sorts volumes (by volume number) before loose chapters (by
  chapter number). A queue at `batch: 3` / `volumes: 3` on a mixed series
  draws Volume 1–3, never chapter 48.5.
- `isWholeVolume` is true for the `-100000` sentinel **or** a volume whose
  `chapters.length === 1`.
- Dedupe prefers the volume-associated copy.
- The bare `continue-point` launch shortcut is gone; every launch walks
  `series-detail`.
- Offline gate: `e2e/kavita-volumes-and-members-test.ts` (sole-chapter +
  mixed-series cases).

## Evidence

- Owner quote above, 2026-08-22, with screenshots of the reading list opening
  on chapter 48.5 and of sole-chapter volumes all titled Chapter 1.
- Live `series-detail` shapes recorded in the offline fixtures (`5100` sole-
  chapter volumes, `5200` mixed volumes + chapters) — titles in the fixtures
  are placeholders; the wire shape is the real one.
