# Kids' Plex channels draw from Shows + Shorts only — no Anime

- **Status:** Accepted
- **Date:** 2026-07-08
- **Type:** scope
- **Supersedes:** —
- **Superseded by:** —

## Decision
Both kids' cartoon sets (`younger` and `older`) draw episodes from the **Shows** (section 5)
and **Shorts** (section 15) libraries **only**. The **Anime** library (section 11) is
**excluded from both sets**. In `plexchannels/config.py` this means each set's
`episodic_sections` is `[SEC_SHOWS]` (item bucket stays `[SEC_SHORTS]`); `SEC_ANIME` is kept
defined for reference but must not be added back to any set without a new decision.

## Context
On first live deploy (2026-07-08), the `younger` rotation surfaced borderline-mature anime
(Great Mazinger, Initial D, Den-noh Coil, The Irresponsible Captain Tylor) because those
titles carry kid-tier content ratings in Plex, so the rating allow-list alone didn't keep
them out. The user first said "for younger, keep it safe — no anime; older is fine," then
revised to **"remove anime from both. Let's focus on Shorts and Shows categories."** The
revised instruction is the one in force.

## Why
- Content-rating metadata in the Anime section is unreliable for kid-appropriateness, so a
  rating allow-list can't be trusted to gate it — excluding the section is the safe control.
- The kids' channels are meant to feel like curated kids' TV; Shows + Shorts already cover
  that intent without pulling from Anime.

## Why not (rejected alternatives)
- **Per-title blocklist** — brittle; every new mis-rated anime would leak in until manually
  blocked.
- **Younger-only exclusion** — the user's first message, explicitly revised to both tiers.

## Evidence
- User: "For Younger Kid, let's keep it safe to not do Anime. Older is fine." then
  "Actually, we should just remove Anime from both. Let's focus on Shorts and Shows
  categories." (chat 2026-07-08)
