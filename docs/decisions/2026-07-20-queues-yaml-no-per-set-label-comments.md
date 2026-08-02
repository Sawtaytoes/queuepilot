# `queues.yaml` carries no per-set label comments; audience→key mapping lives in the header

- **Status:** Accepted
- **Date:** 2026-07-20
- **Type:** convention / cleanup
- **Supersedes:** —
- **Superseded by:** —

## Decision

`queues.yaml` must **not** carry per-set `# Plex: <label>` comments (e.g. `# Plex: Bob Movie`
under `bob:`). They are removed. The one place a human needs the audience→key mapping is a
legend in the file's **header** comment block:

```
# QUEUE KEY -> AUDIENCE (...):
#   bob               = Bob - Movies
#   bob_alice        = Bob & Alice - Movies
#   family          = Family - Movies (G/PG)
#   bob_anime         = Bob - Anime
#   bob_alice_anime  = Bob & Alice - Anime
#   family_anime    = Family - Anime
```

Do not re-add per-set label comments. If the display labels change, update `SET_LABELS` in
`web/src/config.js` (the source of truth) and this header legend.

## Context

The seed `queues.yaml` (2026-07-20) labelled each set with a `# Plex: <label>` comment right after
its key. Both writers round-trip the file through comment-preserving YAML libraries — the Node
editor via the `yaml` `Document` API, the Python prune via `ruamel`. Neither library pins a
comment to a map **key**: on save the label re-serialises as a line comment attached to the
sequence or an item, so heavy editing (adds, reorders, cross-queue moves) floated it onto its own
line or down to the bottom of the block. The user was offered a "strip the labels" cleanup; this
records doing it.

## Why

- **The labels were purely cosmetic.** Nothing parses them. The web UI and the NFC cards key off
  the **set names** (`bob`, `bob_anime`, …); display labels come from `SET_LABELS` in
  `web/src/config.js`. The comments only duplicated that.
- **A key-anchored comment can't be kept pinned.** Verified against the `yaml` lib: even
  `bob: # label` re-emits as a line comment on the next line after one round-trip. So "just
  re-anchor them" doesn't actually stop the drift — removal does.
- **The header is stable.** The header block is a document-level comment (`commentBefore` on the
  first key) and survives every round-trip — it's where the big format/seed notes already live —
  so the legend there can never drift.

## Evidence

- The six `# Plex: …` lines were stripped from the live `queues.yaml`
  (`/srv/app-configs/plex-channels/queues.yaml`) and the legend inserted into the
  header, under the same mkdir lock the writers take. A `diff` against the pre-edit backup
  (`queues.yaml.bak-labelstrip-20260720`) showed **only** the six removals + the legend insert —
  no queue entry touched. Both parsers (Python resolver + Node `yaml`) then read the file with zero
  errors.
- Handoff / wiring updated: `docs/web-ui-handoff.md` "Deferred / open" #2, `CARD-REGISTRATION.md`
  §4a.
