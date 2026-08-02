# Queue entries are human-readable title strings, not ratingKeys

- **Status:** Accepted — **shipped 2026-07-20** (commit `ec9d8e2`; deployed + verified live)
- **Date:** 2026-07-20
- **Type:** reversal / data format
- **Supersedes:** the implicit ratingKey-only entry format shipped in the first
  `queues.py` / `plex.next_queue` cut (2026-07-20).
- **Superseded by:** —

## Decision

A `queues.yaml` entry is a **human-readable title string** — `"Duel (1971)"`,
`"86 Eighty-Six (2021)"`, or the full library folder name `"86 Eighty-Six (2021) [anidb-16172]"`.
The service resolves it to a Plex item at scan time (title + optional `(year)` + optional
`[guid]` hint, searched within that card's section). A bare **ratingKey** (or `{title, ratingKey}`)
stays accepted for AI/UI-added entries, but a **human must never need one**.

## Context

The first backend cut required a Plex ratingKey per entry. The user rejected that for hand-editing:
he wants to type folder names / titles, and only tolerates ratingKeys if the AI or the web UI adds
them for him.

## Why

- **Hand-editable.** A folder name / title is something the user already knows; a ratingKey means
  digging through Plex URLs. The queue file is meant to be his wishlist, so it must read like one.
- **RatingKeys stay valid** so the (Node) web UI and the AI can still write precise, unambiguous
  references, and so resolution can cache title→ratingKey.

## Evidence

- User (chat 2026-07-20): *"I don't want a rating key. Is that something you added? That makes it
  tough. I'd like to just put a string like `86 Eighty-Six (2021) [anidb-16172]` (the folder name)
  or even just `86 Eighty-Six (2021)` and `Duel (1971)` for movies."*

## Build note

**Shipped 2026-07-20.** `queues.py` (entry descriptors + `parse_title_string`/`entry_key`) and
`plex.py` (`_resolve_title` + `resolve_queue_entry`, key-based prune) accept title strings,
ratingKeys, and `{title, ratingKey}` mappings; resolution is verified live against Plex. The six
queues were then seeded from Bob's Watchlist + On Deck as title strings (Task 2). Hand-adding
titles now works.
