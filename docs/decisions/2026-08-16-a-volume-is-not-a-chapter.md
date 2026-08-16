# A volume is not a chapter — it has its own read count

- **Status:** Accepted
- **Date:** 2026-08-16
- **Type:** data model / playback
- **Supersedes:** —
- **Superseded by:** —
- **Extends:** [2026-08-15-a-queue-sets-its-own-batch](2026-08-15-a-queue-sets-its-own-batch-and-the-search-box-accepts-a-year.md)

## Decision

**A volume is a collection of chapters, not a chapter.** The queue's chapter
count (`episodes:` / "Chapters per series each visit") must not apply to a
volume-based series.

Volumes get their own knob:

> **entry `volumes:` > set `volumes:` > 1**

Default is **1**. Not the chapter count, not `KAVITA_BATCH_DEFAULT`, not
"uncapped". Stored sparsely the same way `episodes:` is: `<= 1` drops the
key.

The engine picks which count by the *item*: `unit === 'volume'` reads the
volume count, everything else reads the chapter count. One Kavita queue
holds both (Alice in Borderland is volumes; a webtoon is chapters).

## Context

The owner, 2026-08-16, on the set editor of a live reading queue sitting at
"Chapters per series each visit: 3":

> "A Volume isn't a chapter, it's a collection of chapters. The chapter
> read count shouldn't affect volumes. They should have their own
> mechanism for 'read count'. Also default 1"

`episodes: 3` was being applied to every series in the queue. For a
volume-based manga that meant three whole volumes (hundreds of pages) in
one visit — the same number that is a comfortable sitting of webtoon
chapters.

## Why

- **The units are not interchangeable.** Three chapters of a webtoon is a
  sitting. Three volumes of Alice in Borderland is a weekend. Reusing the
  chapter count was a lie about what a volume is, which the 2026-08-15
  vocabulary ADR already knew at the *label* layer (`unit: volume` on the
  item) but not at the *count* layer.
- **Default 1 matches the chapter default.** The owner has already said,
  about chapters, "3 should not be the default, 1 should be." Volumes
  inherit that rule, and they do not inherit the *value* he set for
  chapters.
- **Two knobs, not a branch on the one knob.** A mixed queue has both
  kinds, so the editor shows both counts when the provider's unit is
  `chapter`. A Plex queue never sees the volume control.

## Consequences

- `sets.yaml` may carry `volumes:` next to `episodes:`. A queue that never
  touches it is byte-identical.
- A leftover `episodes: 3` on a volume-based *entry* no longer widens that
  series. The override for a volume is `volumes:`.
- The set editor on a reading queue grows "Volumes per series each visit",
  default 1, with a hint that a volume is not a chapter.

## Evidence

- Owner quote above, 2026-08-16, with a screenshot of the set editor at 3
  chapters.
- Offline gate: a volume series with `batch: 3` and no `volumes:` yields
  **one** volume; a webtoon beside it still takes the chapter count.
