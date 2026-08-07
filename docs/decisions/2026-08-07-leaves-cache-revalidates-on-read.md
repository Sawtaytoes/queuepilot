# The leaves cache re-validates on read against the show's live watch aggregate

- **Status:** Accepted (implemented; not yet deployed)
- **Date:** 2026-08-07
- **Type:** bugfix / caching
- **Supersedes:** —
- **Superseded by:** —
- **Relates to:** [2026-08-03-sqlite-is-a-derived-plex-cache-not-the-store](2026-08-03-sqlite-is-a-derived-plex-cache-not-the-store.md)

## Decision

`plex.allLeaves(showRk)` now **validates** the cached episode list against the show's current
`(updatedAt, viewedLeafCount)` on every read, fetched from the **show-node** metadata endpoint
(`/library/metadata/{rk}` — the show only, not its episodes). If the aggregate still matches the
cached row, the episodes are served with no `allLeaves` call; if it moved, the row is refetched.
When the aggregate call fails (Plex unreachable) the validator is `null` and the existing 24 h
TTL path serves the last-known payload — so the degraded/offline behaviour is unchanged.

The stored validator fields now come from that show-node aggregate, **not** from the `allLeaves`
container.

## Context

A queue/channel tile shows a series' next unwatched episode, computed by `nextEpisode` →
`allLeaves`. `allLeaves` cached the episode list (`cache.leaves`) with a 24 h TTL, busted
precisely and for free only by `cache.dropLeaves`, which fires from the **MQTT now-playing**
subscription — i.e. only for watches the app itself started.

Real failure: `.hack//SIGN` E19 was finished via a **manual Plex play** (playback left and
restarted outside the app). No MQTT now-playing event fired, so the show's leaves row was never
dropped, and for up to 24 h the tile kept showing **"E19 · In Progress"** while live Plex already
had E19 `viewCount=1` and the real next-up was E20. Diagnosed live: the cached row read E19 at
72.5% while Plex showed it watched.

Two aggravating facts made the existing "validator" inert on this path:
- `allLeaves` read the cache with **no validator** (`cache.getLeaves(rk)`), so it relied purely
  on the TTL + MQTT drop — the comment even said the display path "uses the TTL + invalidation."
- The `allLeaves` **container omits** `leafCount`/`viewedLeafCount`/`updatedAt` (verified against
  the live server), so `putLeaves` had been storing `viewedLeafCount: 0`/`updatedAt: 0` — the
  validator identity could never have matched even if a caller had passed one.

## Why

- **Correctness beats a micro-optimization.** The cache existed to avoid the ~2.7 s of one
  `allLeaves` call per show. The validator is one *light* show-node call (no episodes); the
  expensive `allLeaves` is still skipped whenever the show is unchanged. The warmer runs every
  10 min at concurrency 4, so the added calls are negligible.
- **Any-client self-heal.** `viewedLeafCount` increments whenever an episode is marked watched,
  from *any* client, so an out-of-band completion invalidates on the next render — MQTT no longer
  the only trigger. `updatedAt` additionally catches library changes (episodes added/removed).
- **No offline regression.** A failed aggregate call → `null` validator → the pre-existing 24 h
  TTL path, byte-for-byte the old behaviour.
- **Known residual (documented):** a rare net-zero change — unwatch one episode and watch another
  in the same window so `viewedLeafCount` and `updatedAt` both land unchanged — would still read
  stale until the TTL or an MQTT drop. Strictly better than the status quo; the TTL + MQTT drop
  remain as backstops.

## Evidence

- Owner report: the tile said E19 of `.hack//SIGN` after finishing it; "I left the playback and
  started it again manually" (a manual play, outside the app's start→MQTT flow).
- Live Plex vs. cache at diagnosis time: show-node `viewedLeafCount=19` (E19 watched) while the
  cached leaves row had E19 at `viewOffset=1099781`, `viewCount` absent (72.5%, in-progress).
- The `allLeaves` container returned `leafCount/viewedLeafCount/updatedAt = undefined` from the
  live server; the show-node endpoint returned them stable across calls.
- Implementation: `server/src/plex.js` (`showAggregate` + validated `allLeaves`). Regression test:
  `e2e/leaves-revalidate-test.mjs` (fake Plex) — cold fetch, warm-unchanged serves without
  refetch, out-of-band `viewedLeafCount` bump self-heals to the next episode, aggregate-down
  falls back to the cached payload. Wired into CI's browserless e2e.
