# Curated members are ADDITIVE includes on top of the rule pool — a channel can be a mix

- **Status:** Accepted
- **Date:** 2026-07-31
- **Type:** behavior / data model
- **Supersedes:** the "Curated vs Dynamic — no convergence" resolved point of
  [channels-function-first-generalized-members](2026-07-21-channels-function-first-generalized-members.md)
- **Superseded by:** —

## Decision

A rotation channel's explicit `members:` list plays **ON TOP OF** its rule-based eligible
pool — it does **not** replace it. A curated member is a **manual include**: the mirror
image of the blocklist's exclude. One channel can therefore be a **mix** — e.g. "the whole
**Shows** library, PLUS these hand-picked Anime shows (GaoGaiGar, Blue Lock)."

The old model was an either/or: any member switched the channel to members-only and dropped
the rule pool entirely (`channel_buckets` returned `member_buckets` **else** `unwatched_buckets`).
Now `channel_buckets` returns `member_buckets + unwatched_buckets`, **deduped by ratingKey**
(a member that also matches the rule isn't queued twice; members win). Two familiar shapes
still fall out for free:

- **no members** → purely the rule pool (every channel today; unchanged).
- **no pool libraries selected** → an empty rule pool, so the channel plays purely its
  members — the "pure curated" mode, now expressed as "a mix with an empty pool" rather than
  a separate channel type.

Because a member resolves **globally by ratingKey**, it may come from a library that is **not**
one of the channel's pool `sections` (an Anime show on a Shows-only channel). The
**member-picker search therefore spans ALL libraries** (`/api/search?scope=all`), not just the
channel's own — a manual include is not bound to the pool's libraries.

## Context

Bob, building the Older Kids channel: *"I wanna select 'Shows' for the 'Eligible pool' and
manually add members from other libraries as curated entries. So this would be a curated +
eligible mix channel. Think of the curated entries like a manual 'include' as the opposite of
'Blocked'."* Then: *"gaogaigar isn't showing up in the search because 'Anime' isn't a library,
but this is a curated 'manual include' entry, so it should be there."* And: *"For the older
kids, I want GaoGaiGar and Blue Lock."* (chat 2026-07-31)

He confirmed the additive model over an explicit per-channel toggle.

## Why

- Matches the mental model he stated: include ⇄ exclude are symmetric, and neither should
  wholesale replace the rule pool.
- No existing channel relies on the old replace behavior — every rotation channel currently
  has zero members — so the change is behaviorally inert for the current fleet and only shapes
  future mixed channels.
- Preserves both prior "modes" without a new config flag: pure-rule (no members), pure-curated
  (no pool libraries), and the new mix (both).

## Compatibility with the kids "no Anime" rule

[kids-channels-shows-and-shorts-only-no-anime](2026-07-08-kids-channels-shows-and-shorts-only-no-anime.md)
excludes the **Anime library** from the kids channels' **rule pool** because Plex content
ratings can't be trusted to gate mass anime. That still holds: the pool stays Shows + Shorts.
Individually **hand-vetted** anime entering via an explicit manual include is the opposite of
"mass anime leaking in on unreliable ratings" — it's Bob picking specific, tier-appropriate
titles (GaoGaiGar TV-Y7, Blue Lock TV-PG). This decision refines, and does not conflict with,
that one.

## Evidence

- Code: `queue_builder/plex.py` `channel_buckets` (union + dedup); `server/src/server.js`
  `/api/search?scope=all`; `web/app.js` `wireMemberAdd` (scope=all).
- User quotes above, chat 2026-07-31.
