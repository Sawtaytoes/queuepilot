# Copy is authored in Plex words and rewritten per provider

- **Status:** Accepted
- **Date:** 2026-08-16
- **Type:** architecture / ui
- **Supersedes:** —
- **Superseded by:** —
- **Extends:** [2026-08-15-a-provider-carries-its-own-vocabulary](2026-08-15-a-provider-carries-its-own-vocabulary.md)

## Decision

**UI copy is written once, in Plex's vocabulary.** A replacement engine
(`applyVocab`) rewrites those strings from the provider's words:

```
"Earlier episodes are skipped — nothing is marked watched on Plex."
  → Kavita: "Earlier chapters are skipped — nothing is marked read on Kavita."
```

The engine is derived from the existing `ProviderVocabulary` (`verb`, `unit`,
`units`, `member`, `done`) plus a new `name` slot (`"Plex"` / `"Kavita"`). A
new backend is still one map entry in `providers/config.ts`. Applying Plex's
own words is a no-op, so a stale or missing vocabulary degrades to today's
rendering.

`a`/`an` in front of a swapped noun is repaired (`an episode` → `a chapter`).
`Play` → `Read` also rewrites `Playback` → `Reading`, because "Playback" is
not the verb and a word-boundary on `Play` would leave it sitting on a
reading queue.

**Do not run the engine over a title or any other string the user or the
backend supplied.** `\bPlay\b` would rewrite "The Play". It is for OUR copy
only.

This does not replace the interpolated templates already using `vocab.units`
etc. It is how leftover *complete sentences* consume the same vocabulary
without every screen growing a second set of strings.

## Context

The owner, 2026-08-16, on the "Start from…" modal of a live Kavita tile
(Multi-mind Mayhem, Ch 88):

> "QueuePilot issue showing starting chapter in Kavita. Also, all the text
> refers to Plex. We need to add a text replacement engine to take these
> strings and allow swapping them per provider. Plex is Kavita here and
> episode is chapter."

The vocabulary ADR the day before had already fixed the tiles that *knew*
to read `vocab`. The start modal did not: its hint, its failure note, its
picker labels and the tile-menu actions were still Plex sentences. The
failure note was also *true* — `/api/show/:id/episodes` only ever asked
Plex, so a Kavita series id came back empty.

## Why

- **The user named the mechanism.** Interpolation per sentence is what the
  2026-08-15 ADR already does. The leftover copy is whole sentences, and
  rewriting them is what "take these strings and allow swapping them"
  asked for.
- **The fallback stays the same.** Identity on Plex's words is the same
  safety the vocabulary ADR already relies on.
- **Article agreement is the engine's job.** Leaving "an chapter" in a
  menu the owner taps would be worse than a one-line repair.

## What it fixed, concretely

| | before | after |
| --- | --- | --- |
| start-modal hint | "Earlier episodes… marked watched on Plex" | "Earlier chapters… marked read on Kavita" |
| load failure | "Could not read this series' episodes from Plex." | chapters load from Kavita; the note, if it fires, names Kavita |
| tile menu | "Start from an episode…" | "Start from a chapter…" |
| picker labels | Episode / Watched / E88 | Chapter / Read / Ch 88 |
| start floor | saved, then ignored on launch | Kavita `buckets()` skips earlier unread chapters |

## Consequences

- `ProviderVocabulary.name` is `"Plex"` / `"Kavita"`.
- `Provider.listUnits(id)` is the media-neutral "Start from…" list.
  `/api/show/:id/episodes?set=` dispatches to the set's provider.
- A curated Kavita entry's stored `start` is honoured as a floor, same
  as Plex: earlier unread items are skipped, never marked read.

## Evidence

- Owner quote above, 2026-08-16, with a screenshot of the Plex-worded
  modal on a Kavita series that failed to list its chapters.
