# Live migration: `younger`/`older` tiers → `shows_shorts` + `movies` function channels

- **Status:** Accepted (implemented — v3 PR 4; deployed with Bob watching)
- **Date:** 2026-07-23
- **Type:** data model / migration
- **Supersedes:** the two-set-per-tier layout of
  [2026-07-16-plex-kids-watched-state-per-profile-not-union](2026-07-16-plex-kids-watched-state-per-profile-not-union.md)
- **Superseded by:** —

## Decision

The two per-tier rotation sets become **two function channels**, each carrying BOTH
tiers as `profiles[]` bindings (schema:
[2026-07-23-sets-yaml-profiles-array-schema](2026-07-23-sets-yaml-profiles-array-schema.md)):

- **`shows_shorts`** — `behavior: progress`; one binding per tier from its
  `allowed_ratings`/`sections`/`item_sections`.
- **`movies`** — `behavior: rewatch`; the same two bindings, pool from each binding's
  `movie_ratings`.

### id immutability + soak

`younger`/`older` keep their ids and STAY in `sets.yaml`, marked
**`superseded_by: shows_shorts,movies`** — hidden from every web picker and skipped by
the `set:"auto"` router, but still playable by `{"set":"younger"}` (the HA button path)
during the soak. New channels get NEW ids per
[2026-07-21-sets-registry-immutable-ids](2026-07-21-sets-registry-immutable-ids.md); no
id is ever reused. The migration is a one-time idempotent script
(`server/migrate-tiers.mjs` → `sets.migrateLegacyTiers()`), NOT a boot-time transform, so
the harness back-compat fixtures keep the legacy shape.

### `set:"auto"` routing

`config.channel_for(kind, profile_title)` replaces the flat `PROFILE_SET_MAP` lookup:
`(kind + detected profile) → a function channel that EXPLICITLY binds that profile`
(`has_explicit_profiles`, exact `plex_user` match, `behavior` matches the kind — rewatch
for `movie`, else progress). It falls back to `PROFILE_SET_MAP` when no function channel
matches (un-migrated `sets.yaml`), and returns `None` for an unmapped profile so an
unknown scanner (e.g. Bob on a kid card) still errors instead of silently landing on a
default binding.

### `blocklist` stays channel-level (union on migration)

The decision keeps `blocklist` a channel-level field
([the schema decision](2026-07-23-sets-yaml-profiles-array-schema.md)), so the two tiers'
blocklists MERGE into `shows_shorts.blocklist`. This is safe because the tiers' rating
caps are disjoint — a show blocked for one tier is already rating-excluded from the other.
**Proven, not assumed:** the pre-deploy dry-run (below) showed byte-identical pools.

## Context

The final PR of the function-first channel restructure
([2026-07-21-channels-function-first-generalized-members](2026-07-21-channels-function-first-generalized-members.md)).
PRs 1–3 built the dropdown, the `profiles[]` data model, the web bindings sub-editor, and
generalized members — all reading BOTH shapes. PR 4 flips the live registry and rewires
the `#/channels` tier editor + Play-landing tier picker to author per-binding (writing
inside `profiles[]`, since `config.py` ignores top-level fields once `profiles[]` exists —
an un-rewired save would be silently dropped, the concrete reason this waited for PR 4).

## Why

One channel named by FUNCTION with a profile picker (not two profile-named sets) is the
model Bob approved; it makes "add a third kid" a binding, not a new set + card rewire.

## Evidence

Pre-deploy NFC dry-run against the LIVE registry copy, in-container (owner token, real
Plex), for the exact card payloads `{set:"auto", kind:"cartoons"}` and `{kind:"movie"}`
per profile: routing landed on `shows_shorts`/`movies` + the right binding, and the
eligible shows pool (Younger 11 buckets, Older 12) + rewatch pool (Younger 60, Older 27)
were **identical to the legacy `younger`/`older` selection**. `channel_for("cartoons",
"Bob")` → `None`. Web cutover verified by `e2e/verify-pr4-cutover.mjs` (19 checks) +
screenshots; the 7 existing suites stay green on the legacy fixture.
