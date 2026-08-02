# `sets.yaml` rotation channels carry a `profiles[]` binding array + a `behavior` field

- **Status:** Accepted (implemented — v3 PR 2a, back-compat reader; migration is PR 4)
- **Date:** 2026-07-23
- **Type:** data model / schema
- **Supersedes:** —
- **Superseded by:** —

## Decision

A `source: rotation` channel's per-profile configuration lives in a **`profiles[]`** array;
a channel-level **`behavior`** field (`progress` | `rewatch`) supersedes the old `mode`
enum. Both the Node writer (`server/src/sets.js`) and the Python service
(`queue_builder/config.py`) **read BOTH shapes**: when `profiles` is absent, they synthesize
**one** binding from the legacy top-level fields, so the live `younger`/`older` sets keep
working byte-for-byte until PR 4 migrates them. This implements the data model from
[2026-07-21-channels-function-first-generalized-members](2026-07-21-channels-function-first-generalized-members.md).

### On-disk shape

```yaml
- id: shows_shorts
  label: Shows & Shorts          # FUNCTION name, never a profile name
  source: rotation
  behavior: progress             # progress | rewatch  (supersedes `mode`)
  kind: cartoons                 # display tag (kept)
  sections: [5]                  # CHANNEL-level: dynamic member rule (show libs)
  item_sections: [15]            # CHANNEL-level: shorts / movie libs
  blocklist: []                  # CHANNEL-level: forced-out ratingKeys
  audio_language: null           # CHANNEL-level
  profiles:                      # >=1 PER-PROFILE binding
    - plex_user: Younger Kids
      account_id: 11111111
      user_uuid: 1111111111111111
      allowed_ratings: [TV-Y, TV-Y7, TV-Y7-FV, TV-G, G]
      movie_ratings:  [TV-Y, TV-Y7, TV-Y7-FV, TV-G, G]
      watch_count_accounts: [11111111]
      movie_excludes: []
    - plex_user: Older Kids
      account_id: 22222222
      user_uuid: 2222222222222222
      allowed_ratings: [TV-PG, PG]
      movie_ratings:  [TV-PG, PG]
      watch_count_accounts: [22222222]
```

### Field ownership (what is per-binding vs channel-level)

- **Per-binding (in `profiles[]`):** `plex_user`, `account_id`, `user_uuid`,
  `allowed_ratings`, `movie_ratings`, `watch_count_accounts`, `movie_excludes` — the rating
  cap is per **(channel × profile)** per the decision above.
- **Channel-level (stay at the top):** `sections`, `item_sections`, `blocklist`, `kind`,
  `behavior`, `audio_language`, `max_items`, `enabled`, `label`, `id`.

### Rules

- The two shapes are **mutually exclusive on disk**: writing `profiles[]` drops the legacy
  top-level binding keys (`sets.js` deletes them). Reading either yields a `profiles` list
  ≥1 in the API response and in `config.SETS[id]["profiles"]`.
- **Default binding = `profiles[0]`.** `config.binding_for(cfg, profile_title)` returns the
  binding whose `plex_user` matches `profile_title`, else the first. The service resolves the
  active profile at play time (the detected Plex Home profile for `set:"auto"`), and threads
  that binding through the `plex.py` selection helpers. A legacy single-binding set always
  resolves to its one binding — identical to pre-PR-2 selection (verified live: the migrated
  `profiles[]` shape with the Younger binding reproduces the exact `younger` show set).
- `config.py` mirrors the default binding to the cfg top-level for any un-migrated reader;
  `plex.py` uses `binding_for()`.

## Context

PR 1 shipped the profile dropdown; PR 2 is the data model that lets one function channel
carry several profiles, each with its own rating cap. Shipped in two CI-green slices: **2a**
= this schema + reader/writer + selection threading (no UI, no migration); **2b** = the web
per-profile sub-editor. `younger`/`older` are migrated last (PR 4, live cutover).

## Evidence

Live read-only dry-run (2026-07-23): `unwatched_buckets` for the `profiles[]` set returned an
identical show set to legacy `younger` under the Younger binding, and a distinct PG-tier pool
under the Older binding — proving back-compat and real per-binding selection.
