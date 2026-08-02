# Anime becomes three curated queues; the On Deck set is retired

- **Status:** Accepted
- **Date:** 2026-07-16
- **Type:** reversal / feature
- **Supersedes:** [2026-07-09-anime-continue-watching-set.md](2026-07-09-anime-continue-watching-set.md)
- **Superseded by:** —

## Decision

The `anime` set (source = Plex On Deck / Continue Watching) is **deleted**. Anime gets the same
treatment as movies: three hand-curated queues, one per audience.

1. **Three new sets** - `bob_anime`, `bob_alice_anime`, `family_anime` - all
   `source: "queue"` against the Anime section (11), mirroring `bob` / `bob_alice` /
   `family` against Movies (1). Same store, same prune, same resume
   ([2026-07-16-movie-queue-sets-yaml-wishlist.md](2026-07-16-movie-queue-sets-yaml-wishlist.md)).
2. **Entries are a series or a single film**, resolved from Plex rather than declared - section 11
   holds both. A series plays its next unwatched episodes in order and leaves the queue once fully
   watched; a film plays and leaves once watched.
3. **The existing anime card is repointed, not replaced.** Tag `04-D3-C6-37-22-02-89` moves from
   `Plex Play: anime anime` to `Plex Play: queue bob_anime`, as do `input_button.plex_anime` and
   the voice sentences. Only two new blank cards are needed (Alice, kids).
4. **The "continue watching anime" voice sentence is dropped.** It stops being true once the card
   plays a curated list. "play my anime" / "play my next anime" / "anime time" / "put on my anime"
   all still describe what happens and are kept.
5. **`exclude_title_substrings` is deleted** with the set - a curated list needs no franchise
   blocklist.
6. **`specials_max_index` (and the zero-duration guard) are KEPT.** They are selection rules, not
   On Deck plumbing.
   > **Revised 2026-07-17:** `specials_max_index` is gone — Season 0 is now excluded *entirely*
   > (a series must never open on a special). The zero-duration guard stays. See
   > [2026-07-17-anime-series-never-open-on-specials-exclude-season-0.md](2026-07-17-anime-series-never-open-on-specials-exclude-season-0.md).

## Context

The On Deck set gave Bob "just continue whatever I'm mid-watch on." Having built curated movie
queues split by audience the same day, he asked for anime lists "just like movies" for himself, his
wife, and his kids, and chose to retire the On Deck card rather than run both models side by side.

## Why

- **One mental model.** Every Plex card becomes "a list I curate, top first, finished drops out."
  Two selection philosophies on adjacent cards is the kind of thing nobody remembers in six months.
- **On Deck can't express audience.** Continue Watching is a property of the account, and all of
  these run as Bob, so On Deck could never split into "with Alice" vs "with the kids." Curation
  is what carries the distinction the user actually wants.
- **Curation subsumes the exclusions.** The six franchise needles existed to keep unwanted shows
  out of an automatic rotation. Nothing enters a curated list unless it is put there.
- **The specials rule is orthogonal.** It exists because the library numbers S0 E100+ as trailers /
  OP-ED / music videos. That is true of a queued series exactly as it was of an On Deck one, so
  retiring it with the source would regress a verified 07-09 finding and open a long-runner on a
  trailer.

## Why not (rejected alternatives)

- **Keep the On Deck card as a 4th surface** - offered and declined; the user chose to retire it.
  Reversible: the set was one dict entry plus `ondeck_buckets`, both recoverable from git.
- **Add only 2 anime queues (Alice + kids), leaving Bob's as On Deck** - matches the literal
  "2 more lists," but leaves Bob's anime card behaving unlike his own movie cards.
- **Round-robin across the queued series** (the old cartoons feel) - rejected; the user chose
  ordered, top-first, which makes the list a priority rather than a pool.

## Known behavior this drops

The 07-09 "unwatched special sorts ahead of Season 1" note goes away as a *rotation* concern, but
the same ordering applies inside a queued series: a series whose next unwatched item is an early
special will open on it. Same trade the 07-09 decision accepted under "specials in order."

## Evidence

- User: "Did you get the message about making this configurable via a web app and exposing 2 more
  lists for anime for me, my wife, and my kids? Just like movies." (chat 2026-07-16)
- User chose, when asked: "3 new curated, retire On Deck card" over keeping it as a 4th surface,
  and "Mixed: series or a single film" for entry granularity. (chat 2026-07-16)
- Live surfaces audited before deciding: `automations.yaml:9167` (`04-D3-C6-37-22-02-89` →
  `Plex Play: anime anime`), `:9153` (`input_button.plex_anime`, `Button: Anime`), `:9252-9257`
  (five voice sentences).
