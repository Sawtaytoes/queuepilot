# Queue web UI: Plex-style UX, ratingKey writes, docs count as movies

- **Status:** Accepted — shipped 2026-07-20
- **Date:** 2026-07-20
- **Type:** UX + data-format refinements (from live user feedback on the first UI cut)
- **Amends:** [2026-07-20-queue-entries-are-title-strings.md](2026-07-20-queue-entries-are-title-strings.md)
  (the "human-readable titles are *preferred*" emphasis — see Write format below) and
  [2026-07-20-queue-web-ui-monorepo-single-container.md](2026-07-20-queue-web-ui-monorepo-single-container.md).
- **Superseded by:** —

## Decisions

**UX shape (like Plex).** The editor is two views:
- **Home** — every queue is a horizontal poster **shelf** (`overflow-x` scroll + arrows),
  so all six queues are glanceable but only one is "expanded" at a time.
- **Queue** — tapping a shelf opens that one queue as a wrapped grid of **large posters**.

**Moving between queues = multi-select, not (only) drag.** In a queue you select tiles and
hit **"Move to `<queue>`"** (or Remove). Drag is kept for **reorder within a queue**, via the
**Pointer Events API** off a grip handle, so it works with a **finger on touch**, not just a
mouse. Bigger posters and a phone-responsive layout throughout.

**Add to the TOP by default** (top plays next), with a Top/Bottom selector.

**Write format = ratingKey.** Now that the UI is the editor, a search-pick writes the exact
`{ratingKey, title}` — precise, no scan-time title guessing. Human-readable YAML is **no
longer required** (the user: *"You also don't need the titles to be human-readable in the
YAML anymore because we have the Web UI."*). Hand-typed **title strings still resolve** — the
resolver accepts titles, ratingKeys, and mappings — so the file stays hand-editable too.

**"Movies" spans Movies + Documentaries.** A movie queue resolves across the Movies (1) and
Documentaries (14) sections, so a doc entered in a movie queue (e.g. "The Story of Film")
resolves instead of flagging not-in-library (user: *"it's claiming I don't have The Story of
Film, but that's under Documentaries. For 'Movies' it should include those too."*). Anime
queues stay scoped to the Anime section (11).

## Evidence

- User (chat 2026-07-20): the Plex-home screenshot + *"only have 1 queue visible at a time or
  a home screen showing all of the queues … horizontal scroll for the 'all queues' page like
  Plex"*; *"easier to select a bunch and say 'move to <queue_name>'"*; *"add things to the top
  of the queue with the option of adding them to the bottom"*; *"you don't need the titles to
  be human-readable … we have the Web UI"*; *"For 'Movies', it should … include those
  Documentaries as well."*
