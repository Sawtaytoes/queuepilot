# Queues vs channels taxonomy + play-first entry IA

- **Status:** Accepted
- **Date:** 2026-07-21
- **Type:** Product/UX + playback semantics
- **Supersedes:** — (refines `2026-07-21-sets-registry-immutable-ids.md`'s presentation; playback
  change to the anime sets from `2026-07-16-anime-queues-retire-ondeck-set.md`)

## Decision

1. **Two set families, split by playback semantics, not by data source:**
   - **Queue** = an ordered curated list where position is the point — top plays next
     (the movie queues: `bob`, `bob_alice`, `family`).
   - **Channel** = anything that plays in random/rotation order, where member order is
     irrelevant: the filtered rotations (**Shows & Shorts**), the weighted-rewatch
     **Movies** channel (now surfaced as its own channel per tier, `movie_ratings`
     decoupled from the shows ratings), and the **curated anime channels**
     (`bob_anime`, `bob_alice_anime`, `family_anime`) — explicit member shows,
     played as a shuffled rotation with a per-show episodes-per-visit knob.
   - In `sets.yaml`, `kind` is the discriminator for curated sets: `movies` = queue,
     `anime` = channel. Rotation-source sets are always channels.
2. **Anime sets change playback**: previously first-not-finished-entry (ordered, like the
   movie queues); now a shuffled rotation across all not-finished members — each visited
   show contributes its `episodes:` batch back-to-back, total capped at
   `ROTATION_LENGTH`. Continue-watching per series and finished-member pruning unchanged.
3. **Play-first entry IA**: `#/` is a posterless **Play** list of every channel and queue
   (with per-row "Play on ▾"); the poster-shelf editor moves to `#/queues` (queues only)
   and the channel configurator lives at `#/channels` with a channel picker
   (Shows & Shorts / Movies / each anime channel) plus a tier (profile) picker for the
   first two. Anime channels configure in the grid view (membership + episodes; no
   ordering UI). Creating offers **queue vs channel** explicitly.

## Context

The 2026-07-21 build shipped queues-first: `#/` was the poster shelves (all six curated
sets, anime included), and Channels was a side page holding only the younger/older
rotations with the movie sample folded into their pool.

## Why

User feedback (2026-07-21, live session):

> "Under the new Channels section, we had 2 of them, right? Movies and Shows/Shorts …
> Those should both be separate channels … And there's no easy way to see how to create a
> new channel vs a new queue. … Instead of just displaying Queues first, you could have it
> list all available queues, dynamic, regular, etc. We don't even need posters or anything
> here. It's the 'Play your Queue' area. Then from there, you can navigate to the Queue
> configurator and the Channel configurator. Technically, the Anime ones we created are
> also channels. They're just channels with specific items right? They're definitely not
> queues because they play in a random order and all we're modifying is how many episodes
> play back for each one. The order of the items is actually irrelevant for those Anime
> Channels."

Note: the anime sets in fact played **ordered, top-first** at the time (the queue-card
code path) — the random-order behavior he describes was the retired On-Deck anime
channel's. This decision makes his stated model the real one.

## Evidence

Direct user message mid-session 2026-07-21 (quoted above), this chat.
