# Channels are function-first with a profile selector; members generalize and behavior is progress-vs-rewatch

- **Status:** Accepted (direction — implementation pending)
- **Date:** 2026-07-21
- **Type:** direction / IA / data model
- **Supersedes:** tightens [dynamic-vs-curated-channel-categories](2026-07-21-dynamic-vs-curated-channel-categories.md) and [dynamic-channels-fully-configurable-in-node](2026-07-21-dynamic-channels-fully-configurable-in-node.md) (the `mode` enum was too narrow)
- **Superseded by:** the "Curated vs Dynamic — no convergence" point only, by
  [curated-members-are-additive-includes](2026-07-31-curated-members-are-additive-includes.md)
  (members are now additive includes on top of the rule pool; a channel can be a mix)

## Decision (the target model — Bob confirmed the restructure, not the minimal fix)

### 1. Channels are named by FUNCTION; profile is a selectable attribute
A dynamic channel's identity is its **function** ("Shows & Shorts", "Movies"), never a profile name.
The **profile** (which Plex Home user's account/ratings apply) is a separate attribute, chosen from a
**dropdown of the account's Plex users** (selecting one fills `plex_user`/`account_id`/`user_uuid`);
the three free-text fields remain as an **advanced/manual fallback**. This is the **restructure**, not
the minimal "just relabel" fix — Bob: *"I do [want the restructure]."* The generic channels stop
being the profile-named `younger`/`older` sets and become function-first with a profile selector.

### 2. Members generalize — "next item" is per-member-type
A channel's members can be **heterogeneous**: shows, Plex Collections, movies, and shorts mixed
together (*"We have shorts in there mixed with shows, so it makes sense."*). "Play next" resolves per
member type:
- **Show** → its next unwatched **episode** (today's behavior).
- **Collection** → the next unwatched item **in collection order**.
- **Movie** → the film itself, counted as **one "episode"/item**.
- **Short** → the short, as one item.

Bob: *"'next episode' could be the next one in the collection. In fact, 'next episode' could also be
a single movie which we'd count as a single episode. It all depends on how someone configures it."*

### 3. "Rewatch" is a BEHAVIOR, not a content type
A **rewatch** channel (weighted toward least-watched, replays watched content) is a *behavior*
selectable for a channel of **any** members — it does **not** have to be movie-only. Bob: *"the
movie-only rewatch channel doesn't have to be movie-only… I need to be able to create a rewatch
channel and specify specifics."* So a channel's config exposes:
- **behavior**: *progress* ("next episode", advances through unwatched, leaves when done) vs
  *rewatch* (weighted least-watched replay), plus its knobs (rotation length, rewatch weighting).
- **members**: an explicit member list and/or a rule (libraries + rating/blocklist filters).
- **profile**, **audio language**, excludes, etc.
This replaces the too-narrow `mode ∈ {rewatch, episodic, both}` enum with a richer, configurable model.

## Context

Bob drove the v2 dynamic-channel form and found (a) it named the channel after the profile ("Older
Kids") instead of the function, (b) it asked him to hand-type `plex_user`/`account_id`/`user_uuid`
(*"I'm not gonna know how to fill this out. Gimme a dropdown."*), and (c) it framed rewatch as
movie-only. He wants a single flexible channel model where behavior and member types are configured,
not hardcoded.

## Resolved design decisions (Bob, 2026-07-21)
- **Ratings ↔ profile — RESOLVED: the rating cap is PER (function-channel × profile).** A function
  channel is configured to work with one or more **profiles**; for **each** profile you set that
  channel's allowed ratings (and movie ratings), and the ratings **offered in the picker are scoped to
  that profile's Plex-available ratings** (per-account, workstream D). At play time the Tier/profile
  selector chooses which profile config applies. Data model: a function channel carries a list of
  profile bindings `[{ profile (plex_user/account_id/user_uuid), allowed_ratings, movie_ratings, … }]`
  — which is exactly what `younger`/`older` encode today, reframed as one "Shows & Shorts" channel
  with a Younger config (G-tier) + an Older config (PG-tier). Bob: *"you can specify the ratings for
  each function channel per profile you've configured to work with it, and the ratings that show up
  when selecting that profile for configuration are specific to that profile's available ratings."*
- **Curated vs Dynamic — RESOLVED: keep both; no convergence.** The only distinction is *how members
  are chosen*: **Curated** = hand-picked explicit member list; **Dynamic** = members from a
  rule/filter (libraries + ratings). Generalized members (show/collection/movie/short) and behaviors
  (progress vs rewatch) apply to **both**.
- **Identity:** members are stored by **ratingKey** (canonical), per
  [drop-human-readable-yaml-canonical-ids](2026-07-21-drop-human-readable-yaml-canonical-ids.md) —
  which also enables the metadata cache (fast queue loads). Collections/movies/shorts each need a
  stable stored identity + a resolver that knows their "next item" rule.

## Evidence

Bob, 2026-07-21: *"the dynamic channel is named Shows & Shorts or Movies, not 'Older Kids'; that's
the profile associated."* · *"Gimme a dropdown. You should have all profiles on my account."* · *"the
movie-only rewatch channel doesn't have to be movie-only… create a rewatch channel and specify
specifics… 'next episode' could be the next one in the collection… also a single movie which we'd
count as a single episode… shorts in there mixed with shows."* · *"I do [want the restructure]."*
