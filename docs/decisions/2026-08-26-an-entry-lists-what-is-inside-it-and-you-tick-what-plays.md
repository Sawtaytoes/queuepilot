# An entry lists what is inside it, and you tick what plays

- **Status:** Accepted
- **Date:** 2026-08-26
- **Type:** UI / product rule
- **Supersedes:** —
- **Superseded by:** —

Extends [a curated queue skips items the way a filtered pool blocks
them](2026-08-22-a-curated-queue-skips-items-the-way-a-filtered-pool-blocks-them.md) and its
[correction](2026-08-23-a-skipped-item-counts-as-dealt-with-so-the-entry-can-complete.md). The
data model is unchanged: one flat `skipped:` list of leaf keys on the SET. What changes is that
you can now see the list an entry is made of, and answer it in one pass.

## Decision

1. **An entry that has items inside it opens a MEMBER LIST** — "What plays in *X*". A
   collection's rows are its members; a show's rows are its episodes, every season at once,
   under a season heading. A movie has no list, because a movie is its own item and Remove is
   the answer there.
2. **Ticked plays, unticked is skipped, and Save writes once.** One `PATCH /api/sets/:id`,
   one re-resolve. The panel owns only the keys it shows: every other key on the set is
   carried through untouched (`web/src/lib/skipList.ts`).
3. **Two ways in, and one of them is visible.** The tile menu gets *Choose what plays…* /
   *Choose which episodes play…*, and the entry sheet — which a poster tap opens — gets a
   **What plays** field saying `2 skipped` with a *Choose…* button beside it.
4. **A skip is visible on the tile.** `Tile.skippedCount` counts the SET's skips that are
   inside this entry, and the tile wears an `N skipped` setting tag, alongside every other
   deviation-from-default tag.
5. **A duplicate is told apart by its EDITION.** `CollectionChild`, `ItemLabel` and
   `NextEp.memberEdition` all carry Plex's edition now, so the member rows, the Skipped panel
   and the collection tile each name the cut rather than the film.
6. **A row with no leaf id of its own carries no control.** It reads. A provider that cannot
   name a leaf cannot skip one, and an inert checkbox is worse than none. Kavita's
   `listUnits` now names its chapter ids, so a reading queue gets the list as well.

## Context

Skipping shipped on 2026-08-22 as ONE tile-menu action that drops the item the entry is about
to play. That answers "not tonight's episode" and nothing else. The owner met the case it
cannot answer on 2026-08-26 (chat 2026-08-26, this session):

> "I don't see the skips/ignore feature in QueuePilot. I added 'Man with No Name' trilogy, and
> it won't let me skip the duplicate 'Good Bad Ugly' ones and select only the one I want."

Both halves of that are true, and they are different defects.

**The feature was invisible.** It was on the right-click / long-press menu and nowhere else —
no chip, no field, nothing on the tile that said an entry had ever skipped anything.

**And it could not reach past the next-up item.** The live collection holds FIVE members, three
of them the same film in three Plex editions (`456914` International Cut, `456938` Extended
Cut, `456934` Extended Everything Cut). Through the tile menu, "play this one, never those two"
is two skips in a fixed order, each behind a next-up re-resolve, and the Skipped panel then
lists two rows reading `The Good, the Bad and the Ugly (1966)` twice.

The engine needed nothing: `collectionNext` has skipped a member whole since the day the list
shipped, and `nextEpisode` has always filtered leaves. Every gap was above it — the UI could not
address a leaf the tile was not already pointing at, `showEpisodes` rows carried no `ratingKey`
at all, and `collectionChildren` dropped the edition one layer short of the wire.

## Why

- **A list you tick is the shape of the question.** "Which of these should play" is asked of
  the whole entry at once, so a per-item action asked N times, each with a round trip in
  between, is the wrong control — and it makes the ORDER of the skips matter, which it is not.
- **Save-at-the-end, not save-on-change.** Every other control in the entry sheet writes on
  change, and this one deliberately does not: a skip forces a Plex re-resolve of the entry, so
  ticking three boxes would cost three of them and reorder the rows under the pointer between
  them.
- **The edition is the only field that differs.** Title, year and poster are shared across
  three cuts of one film. Naming the runtime as well is what makes the rows readable at a
  glance even when Plex has not tagged an edition.
- **The count belongs on the entry, not only in the panel.** The `skipped` list is per SET, so
  nothing on an entry said whether any of those keys were its own. `skippedCount` is that tie,
  and it is what lets the sheet print a fact instead of a hedge. It costs no extra Plex I/O —
  both reads are the cached ones the next-up lookup has already made — and it short-circuits
  to 0 on a set that skips nothing.
- **Direct members only.** A skipped EPISODE of a member show inside a collection is not
  counted and not listed, because reaching it means walking every member's leaves. The count
  is of the rows the panel shows. A drill-in is the obvious next step and is deliberately not
  in this change.

## Evidence

Owner, 2026-08-26 (this session): *"I don't see the skips/ignore feature in QueuePilot. I added
'Man with No Name' trilogy, and it won't let me skip the duplicate 'Good Bad Ugly' ones and
select only the one I want."* — and, asked which shape to build: *"Collection members list and
do the same for shows."*

Verified against the live library before the change: `GET /api/collection/296320/children`
returns five members, three of them `The Good, the Bad and the Ugly (1966)` differing only by
`editionTitle` and runtime.

Gates: `web/src/lib/skipList.test.ts` (the merge, including "another entry's skips survive a
save"), `web/src/lib/tileFace.test.ts` (a collection face wears its MEMBER's edition, and still
never the collection's own), and `e2e/shot-member-list.ts` + `e2e/stubs/plex-member-list.mjs` —
a before/after shot against a fixture collection holding three cuts of one public-domain film.
That shot caught a real bug before review: Charcuterie's `Checkbox` is uncontrolled, so seeding
the ticks in an effect AFTER the rows painted left two rows badged "Skipped" with the box still
on. The seed is now written in the same commit as the rows.

⚠️ `cache.ts` `SCHEMA_VERSION` goes 3 → 4. A cached payload's shape is a schema change: the
rows are stored as JSON, so `editionTitle` reads back `undefined` from every collection-children
row written before this, which looks exactly like Plex not having an edition.
