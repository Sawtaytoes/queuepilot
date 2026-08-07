# Episode COUNTS exclude trailers and OP/ED — by Season-0 index range; only real episodes + regular specials + "other" count

- **Status:** Accepted
- **Date:** 2026-08-07
- **Type:** refinement
- **Supersedes:** —
- **Superseded by:** —
- **See also / refines:** [2026-07-17 — A queued/rotated series never plays specials, Season 0 excluded entirely](2026-07-17-anime-series-never-open-on-specials-exclude-season-0.md) (the OPEN-point rule; unchanged). This decision adds the COUNT rule and shares one predicate with it.

## Decision
The web UI's per-series watched/total episode counts (the Start modal's "`N. Series (X/Y watched)`"
member lines) and the playable episode list they reflect now **exclude non-episode extras** and
count only **real episodes + regular specials + Season-0 "other"**. One shared predicate,
`isExtraOrPromo` / `is_extra_or_promo` (server/src/plex.js and queue_builder/plex.py), decides.

Classification is **deterministic, by the Season-0 episode INDEX** (Plex `parentIndex == 0`,
`index` = the number) — the owner's library convention — **not** by duration or title:

| Season-0 index | Kind | Count / eligible? |
| --- | --- | --- |
| 1–99 | regular specials (e.g. an OAD) | **INCLUDE** |
| 100–199 | *unspecified by the owner* | **INCLUDE** (conservative — ⚠️ confirm) |
| 200–299 | trailers | **EXCLUDE** |
| 300–399 | openings / endings (OP/ED theme songs) | **EXCLUDE** (this inflated "25/29") |
| 400–499 | "other" | **INCLUDE** (meant to be played) |

So a Season-0 leaf is an extra **exactly when `200 <= index <= 399`**. Real seasons (>= 1) are
never extras. Plex **Extras/clips** — `type == "clip"` or an `extraType` — are excluded too, if any
appear. There is **no duration or title heuristic** (the owner: *"don't make it timing-based"*).

Consequences, all behind that one predicate:

- **Counts (Node).** A show child's `viewedLeafCount`/`leafCount` are now COMPUTED from its
  `allLeaves` via `countEpisodes` (real episodes only, `viewCount > 0` = watched, a **missing
  `viewCount` is UNWATCHED**) instead of Plex's raw aggregate, which includes the trailers/OP-ED.
- **Playable list (Node + Python).** `nextEpisode`/`showEpisodes` (Node) and `_keep_episode`
  (Python) drop extras too — even when `include_specials` is set — so a series never auto-plays a
  trailer/OP/ED. The 2026-07-17 rule that Season 0 is otherwise excluded by default (a series
  never OPENS on a special) is unchanged.
- **Collection next-up (Node).** Because a series whose only *unwatched* leaves are extras now
  reads as **fully watched**, `collectionNext` correctly **advances to the next member**. Live
  Saiki K.: S1/S2/S3's only unwatched leaves were ED theme songs at index 301–304, so next-up is
  now **S4 E1** (was `null`/stuck), and the counts read S1 **24/24**, S2 fully watched, S3 2/2.

No new env knob — the ranges are library conventions expressed as named constants
(`S0_EXTRA_INDEX_MIN`/`MAX`, `_S0_EXTRA_INDEX_MIN`/`MAX`).

## Context
The owner: *"Opening and ending specials are skipped, as well as trailer, other, etc. Only REGULAR
specials should be included. The total episode counts currently include intro/outro specials."*

Plex's aggregate `leafCount` counts **every** leaf. The four "unwatched" Saiki S1 leaves were **ED
theme songs** (`s0e301 'Seishun wa Zankoku ja Nai'` … `s0e304 'Kokoro'`), `type=episode`. Their
titles are **song names**, so a title regex cannot catch them, and their length is not a reliable
signal either — the owner rejected a duration cutoff. The library instead encodes kind in the
Season-0 **index range**, which is deterministic: 200s trailers, 300s OP/ED (exclude); 1–99
specials and 400s "other" (keep). This also fixed a downstream bug: those phantom-unwatched ED
songs made `collectionNext` believe S1 was incomplete, so the Saiki collection never advanced to S4.

## Why
- **The count should mean "real episodes."** Trailers and OP/ED theme songs are not episodes;
  counting them misreports progress and blocks collection advancement.
- **Deterministic beats heuristic.** The Season-0 index range is an exact library convention — no
  duration threshold to tune, no title regex to misfire.
- **One predicate, two languages.** The Node counts and the Python engine must agree on what a
  playable/countable episode is, so the rule lives in exactly one function per process.

## ⚠️ Needs owner confirmation
- **The 100–199 range** was not specified by the owner. It is currently **INCLUDED** (conservative
  — better to over-count a real special than to hide one). Confirm what lives there.
- The 200–399 exclusion assumes the observed convention holds library-wide (trailers 200s, OP/ED
  300s). If a real special is ever numbered in 200–399, it would be wrongly excluded.

## Composition with PR #13 (in flight)
PR #13 (`fix/resume-in-progress-not-done`) also edits `_keep_episode`/the Season-0 path: it adds a
`specials_ok` keep for a **specials-only show** (no real season, e.g. the Prison School OAD at
s0e1) and an in-progress-leaf keep, treating absent `viewCount` as unwatched. These COMPOSE: the
index-range exclusion is the junk gate (runs first, drops 200–399 + clips), and #13's keep decides
Season-0 inclusion for the survivors — the OAD (s0e1, index 1) is not an extra, so it is kept.
**Merge order matters:** if #13 lands first, this branch needs a small rebase to fold both changes
into the single `_keep_episode` predicate rather than duplicating the Season-0 logic.

## Evidence
- Owner: "Opening and ending specials are skipped, as well as trailer, other, etc. Only REGULAR
  specials should be included. The total episode counts currently include intro/outro specials."
  and (correction) "don't make it timing-based" — use the Season-0 index range.
- Live Anime data (admin token): Saiki K. collection — S1 25/29 (4 unwatched = ED theme songs
  `s0e301`–`s0e304`, `type=episode`), S2 26/28, S3 2/2, S4 "Reawakened" 0/6 (six real
  `type=episode`, `parentIndex=1`). Prison School OAD — Season 0 `s0e1`, a regular special.
- Tests: `e2e/specials-count-test.mjs` (Node — predicate, `countEpisodes`, `isPlayableEpisode`,
  and a cache-seeded `collectionNext` that advances to Saiki S4 E1) and `e2e/specials-count-test.py`
  (Python — predicate + `_keep_episode`). Both wired into `.github/workflows/ci.yml`.
