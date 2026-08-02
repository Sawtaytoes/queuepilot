# Dynamic (rotation) channels are created and fully configured in Node, not hardcoded in Python

- **Status:** Accepted
- **Date:** 2026-07-21
- **Type:** architecture / feature
- **Supersedes:** —
- **Superseded by:** —
- **Builds on:** [sets-registry-immutable-ids](2026-07-21-sets-registry-immutable-ids.md) (sets.yaml is
  the single source of truth; Node writes, Python reads)

## Decision

A user can create and fully configure a **dynamic (rule-based, `source: rotation`) channel entirely
from the web UI**, with no Python edit and no redeploy. The Node registry (`server/src/sets.js`) is
extended so `createSet` accepts `source:'rotation'` with the complete knob set, `updateSet` allows the
rotation filter fields, and `normalize` carries every field Python needs.

- **Field contract** (a rotation entry in `sets.yaml`, the exact set `queue_builder/config.py:
  _load_sets_yaml` reads): `id, label, kind, source:"rotation", sections[] (→ episodic_sections),
  item_sections[], allowed_ratings[]|null, movie_ratings[]|null, blocklist[], watch_count_accounts[],
  plex_user, account_id, user_uuid, enabled, include_specials?` — plus three new passthroughs:
  **`mode`** (`"rewatch"` | `"episodic"` | `"both"`; absent = infer from kind, back-compat),
  **`audio_language`** (e.g. `"jpn"`), **`movie_excludes`** (ratingKey strings).
- **`mode` drives the play branch** in `queue_builder/service.py:do_start` (rewatch-movie pool vs
  episodic rotation vs both) instead of a hardcoded `kind`. Absent `mode` preserves today's behavior.
- **Single-writer invariant preserved:** Node remains the only writer of `sets.yaml`; Python only
  reads it (`reload_sets` before each command). A fully-specified rotation entry is playable with no
  Python change beyond the three passthroughs.
- Fixed a latent bug: `normalize()` was dropping `user_uuid`/`watch_count_accounts`, which would
  silently break a rotation set's per-account token + watched-tracking if round-tripped through the API.
- `id` and `source` stay immutable on update.

## Context

The kid rotation channels (`younger`, `older`) and the Movies rewatch pool were seeded from Python
defaults; the Node `createSet` only made curated (`source: queue`) sets, and there was no web form for
a rotation channel's filters. Bob couldn't build a new dynamic channel (a filtered anime rotation, a
second rewatch pool) himself — the knobs lived in Python.

## Why

- **"Full access" without code:** the headline ask — author any dynamic channel from the server UI to
  the user's own spec, no rebuild/redeploy.
- **Keeps one authoring path:** extending Node (the existing sole writer) avoids a second source of
  truth; the 1:1 field mapping to `_load_sets_yaml` means Python needs no new logic to play it.
- **`mode` decouples behavior from `kind`,** so "rewatch movies" vs "episodic rotation" is a user
  choice on a new channel rather than a hardcoded branch.

## Evidence

Bob, 2026-07-21: *"How would I create this myself? … All the filter info simply doesn't exist, and I
can't customize it either… a lot of that is hidden in the Python. We need to make that configurable via
Node.js."* and *"I want full access to create those via the server based on my specifications."*
Captured in `docs/web-ui-v2-feedback-handoff.md` §E.
