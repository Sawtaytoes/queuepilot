# A queued/rotated series never plays specials — Season 0 is excluded entirely

- **Status:** Accepted
- **Date:** 2026-07-17
- **Type:** reversal
- **Supersedes:** the Season-0 `specials_max_index` rule from
  [2026-07-09-anime-continue-watching-set.md](2026-07-09-anime-continue-watching-set.md) (point 5)
  and [2026-07-16-anime-queues-retire-ondeck-set.md](2026-07-16-anime-queues-retire-ondeck-set.md) (point 6)
- **Superseded by:** —
- **Refined by:** [2026-08-07 — Episode counts exclude trailers/OP-ED by Season-0 index range](2026-08-07-specials-count-excludes-op-ed-trailer-extras.md) (adds the COUNT rule + a shared `is_extra_or_promo` predicate; the never-OPEN-on-a-special behavior here is unchanged)

## Decision
`_keep_episode` (the shared per-episode filter used by every series-playing set) now **drops all
Season 0 episodes**, not just `E100+`. Real seasons (`>=1`) are always kept; the zero-/missing-
duration guard is unchanged. A set can opt back in with `include_specials: True`, but no set does.

`specials_max_index` is removed from `config.py`; the anime set's comment now documents the
exclude-all-specials default.

## Context
Under the earlier rule (`specials_max_index: 100`) a series kept its Season-0 `E1–99` "real"
specials. Because Plex sorts Season 0 ahead of Season 1, an unwatched real special sorted to the
**front** of a show's queue, so a series could **open on a special** even when the user was
mid-season. Both the 07-09 and 07-16 decisions flagged this exact trade and accepted it. The user
has now rejected it.

## Why
- **A show should resume where you are, not on a special.** "I don't wanna start playing specials
  because season 00 comes before season 01." There is no reliable per-special "watch-order
  position" in the library metadata, so the honest fix is to exclude Season 0 rather than try to
  place specials correctly.
- **Predictable.** "Specials never auto-play" is a rule anyone remembers; "keep S0 E1–99, drop
  E100+" was subtle and only existed to make the front-loading less bad.
- The `include_specials` opt-in leaves the door open if a future curated entry ever wants them.

## Verification
Read-only `cli.py rotation anime` against live Plex: 12-item queue, **zero `S0E*` items**. Space
Dandy now opens on `S1E1` (was `S0E1` "Pre Air Special"); Detectives resumes at its real `S1E8`.

## Evidence
- User: "Correct. I don't wanna start playing specials because season 00 comes before season 01."
  (chat 2026-07-17)
