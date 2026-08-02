# Bob's "anime" set = On Deck (Continue Watching), not whole-library

- **Status:** Superseded
- **Date:** 2026-07-09
- **Type:** feature / scope
- **Supersedes:** —
- **Superseded by:** [2026-07-16-anime-queues-retire-ondeck-set.md](2026-07-16-anime-queues-retire-ondeck-set.md)

> **The On Deck `anime` set is retired** (2026-07-16). Anime is now three hand-curated queues
> (`bob_anime` / `bob_alice_anime` / `family_anime`), and points 1, 2 and 4 below no
> longer describe the system. **Point 5 (`specials_max_index`, the Season-0 >= 100 rule) survives
> unchanged** and still applies to a queued series - it is a selection rule, not On Deck plumbing.

## Decision
A new `anime` set (`plexchannels/config.py`) gives Bob his own channel from the **Anime**
library (section 11), with selection rules that differ from the kid sets:

1. **Source = On Deck.** The set carries `source: "ondeck"`; `build_rotation` draws only from
   Plex **Continue Watching** (`/library/sections/11/onDeck`) — the shows Bob is mid-watch
   on — then plays each show's next unwatched episodes in order, round-robin across shows.
   The kid sets keep their whole-library "everything unwatched" rotation.
2. **Runs as admin (Bob).** `user_uuid: None` → the admin `PLEX_TOKEN`; `watch_count_accounts:
   [1]` so "watched" and On Deck are Bob's, and playback scrobbles to his account.
3. **No content-rating cap.** `allowed_ratings: None` (adult account) — `_rating_ok` treats
   `None` as "allow all".
4. **Franchise exclusions by title substring** (`exclude_title_substrings`, case-insensitive)
   so all seasons / variants / movies are caught in one rule: Dragon Ball Z, Daemons of the
   Shadow Realm, Azazel, Darker Than Black, Re:Zero, Iruma-kun.
5. **Specials by Season-0 numbering.** `specials_max_index: 100` — S0 episodes E1–99 are real
   specials (kept, in order); E100+ are trailers (2xx), OP/ED music (3xx), music videos (4xx)
   and are dropped. Real seasons (>=1) are never touched, so a long-runner's S1E109 stays.
   Zero-/missing-duration S0 items (script text, CM stubs) are also dropped as unplayable.

## Context
The kids' NFC/voice system already rotates unwatched cartoons; Bob wanted the same "scan a
card (or say it by voice) and it just plays" for his own anime — but only the shows he's
actively watching, picking one then a random other, in order.

## Why
- **On Deck** is Plex's own "Continue Watching," so it needs no extra state and naturally
  respects each show's episode ordering ("in order").
- **Title-substring exclusions** survive new seasons/variants without maintaining ratingKeys;
  verified 2026-07-09 that the six needles catch every DBZ movie, both Darker Than Black
  entries, all Re:Zero/Iruma year-entries, and Azazel OAD/Z.
- **Season-0 ≥100** is the library's actual numbering convention (verified live: Space Dandy
  S0E201–401 = Trailer/OP-ED/Music Video), so it cleanly separates real specials from clips.

## Why not (rejected alternatives)
- **On Deck + never-started shows** — user chose On Deck **only** ("anime I have as Continue
  Watching").
- **Duration-only specials filter** — user specified the numeric rule; duration is kept only
  as a secondary guard for 0-min non-media items.
- **ratingKey blocklist for exclusions** — brittle across new seasons/variants.

## Known behavior to revisit
Because a show's unwatched Season-0 specials sort ahead of Season 1 in Plex order, an
unwatched real special can surface at the front of a show's queue even when Bob is mid-season.
Acceptable under the literal "specials in order" rule; revisit if it should instead only play
specials that fall at/after the current resume point.

## Evidence
- User: "Any anime I have as 'Continue Watching', pick one and play it, then pick a random
  other one Continue Watching… exclude … Dragon Ball Z, Daemons of the Shadow Realm, You're
  Being Summoned Azazel, Darker than Black, Re:ZERO, Welcome to Demon School! Iruma-kun …
  only select specials if they're part of the watch order … Anything numbered episode 100 or
  higher is something other than a special." (chat 2026-07-09)
