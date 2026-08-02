# A rewatch channel's pool follows the libraries IT names — and a show library contributes its one-episode films

- **Status:** Accepted (implemented)
- **Date:** 2026-07-29
- **Type:** Selection logic / data model
- **Supersedes:** clause 3 ("A rewatch channel hides its (inert) library pickers") of
  [2026-07-29-dynamic-channels-first-class-and-deletable](2026-07-29-dynamic-channels-first-class-and-deletable.md)
- **Superseded by:** —

## Decision

1. **`behavior: rewatch` pools from the channel's own libraries, not `SEC_MOVIES`.**
   `config.rewatch_sections(cfg)` returns the channel's `item_sections` + `episodic_sections`
   (empty ⇒ `SEC_MOVIES`, so a channel naming none behaves exactly as before), and
   `plex.rewatch_counts` walks those sections. `kid_movie_rating_keys` and
   `movie_view_counts` — both pinned to section 1 — are gone.

2. **A show library contributes its ONE-EPISODE entries, as films.** Anime films are scanned
   into the Anime library as single-episode series (`Black Jack: The Movie`), never as movies,
   so no movie-type query could ever reach them. `_show_films` takes a show library's
   `leafCount == 1` entries; the pool keys them on the **episode** that actually plays,
   recovered from the history row's `grandparentKey` (no per-show `allLeaves` fetch), and
   displays the show's title. A multi-episode series can never enter a rewatch pool.

3. **The rating cap is unchanged and still per binding** (`movie_ratings`), applied to the
   movie listing and to the one-episode show listing alike.

4. **The library pickers are shown and saved for a rewatch channel** (reversing clause 3 of
   the superseded record — they are no longer inert). Both the Channels filter panel and the
   Configure modal pre-check from the **union** of `sections` + `item_sections`, because the
   live `movies` channel stored its library under `sections` back when the pool was hardwired;
   a save then writes the normal split (movie libraries → `item_sections`, show libraries →
   `sections`). The seeded default is written in the new shape.

5. **A legacy tier keeps the old pool.** `younger`/`older` carry no `behavior`, and their
   `sections`/`item_sections` are the SHOWS pool (Shows + Shorts) — pooling rewatch from those
   would replay shorts as "movies". `rewatch_sections` therefore returns `[SEC_MOVIES]` for
   anything that isn't `behavior: rewatch`.

## Context

Bob asked why the Movies channel was hardwired: *"We are hardcoding something? Why doing
that? Is it just movie type libraries as a whole or it's tied specifically to the name
'Movies'? I'd like to be more selective about what I pick for it."*

It was neither — it was the section **id** `1` (`PLEX_SEC_MOVIES`, env-overridable), read in
two places: the candidate listing (`/library/sections/1/all?type=1`) and the history tally
(`librarySectionID=1`). The constant predates configurable channels; when members-based
rewatch was generalized in v3 PR 3 (`_member_rewatch_candidates` / `member_view_counts` are
section-agnostic), only the curated path was generalized and the dynamic path kept the
constant. So Documentaries — accepted in a curated movie *queue* since 2026-07-20 — could
never appear in the Movies *channel*, and the library checkboxes were stored but ignored.

An earlier session told Bob anime movies couldn't surface "because the pool is hardwired to
section 1". Half right: Ghibli-style films (Spirited Away, Totoro, Your Name, Ponyo) are in
**Movies** and were always eligible; what is unreachable is the ~187 anime films that live in
the **Anime** library as one-episode series — unreachable by *type*, not only by section.

## Why

- **A control that is stored and ignored is a lie.** The channel already carried libraries;
  the pool ignoring them is the bug, and hiding the pickers (the previous fix) only hid it.
- **"Rewatch" is a behavior, not a library.** That was settled in
  [2026-07-21-channels-function-first-generalized-members](2026-07-21-channels-function-first-generalized-members.md);
  a behavior pinned to one hardcoded section contradicts it.
- **Free speedup.** Titles now come from the section listing the pool already walks, so
  `rewatch_pool` no longer costs one metadata fetch per title (the reason it was capped at 60;
  the cap is now a 500-item runaway guard).

## Evidence

- Bob, 2026-07-29 session: the quote above; chose *"The libraries you check"* and *"Yes —
  treat 1-episode shows as films"* over keeping section 1 / reorganizing Plex.
- Live read-only verification (`plex.rewatch_counts` against the real server): `movies ×
  Younger Kids` = 116 eligible films, `× Older Kids` = 27 — matching today's behavior for
  `sections=[1]`; the Anime library alone yields 35 films Bob has seen (Dragon Ball movies,
  *Vampire Hunter D: Bloodlust*, the SAO Progressive films), each keyed on its playable
  episode ratingKey with the film's title.
- e2e: `suites failed: 0`; `channels-test` now asserts the movies channel shows its library
  pickers with Movies pre-checked; `verify-pr4-cutover` green (screenshot reviewed).

## See also

- [2026-07-29-shorts-preview-lists-each-short.md](2026-07-29-shorts-preview-lists-each-short.md)
- [2026-07-21-channels-function-first-generalized-members.md](2026-07-21-channels-function-first-generalized-members.md)
