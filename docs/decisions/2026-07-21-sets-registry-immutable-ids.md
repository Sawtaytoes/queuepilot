# Sets are data (sets.yaml): immutable ids, renameable labels, per-set libraries, global excludes

- **Status:** Accepted
- **Date:** 2026-07-21
- **Type:** Architecture / data model
- **Supersedes:** the hardcoded `SETS` dicts in `queue_builder/config.py` + `web/src/config.js`
- **Superseded by:** the "cannot be deleted" clause only →
  [2026-07-29-dynamic-channels-first-class-and-deletable](2026-07-29-dynamic-channels-first-class-and-deletable.md)
  (rotation channels are now deletable from the UI). The rest of this decision stands.

## Decision

- Every set (the curated queues **and** the `younger`/`older` rotation channels) lives
  in **`/config/sets.yaml`** — seeded by the Node server on first boot, edited by the
  web UI (create/rename/delete/reorder queues, per-set libraries, rotation filters),
  re-read by the Python service (`config.reload_sets()`) before every MQTT command.
  The old Python/JS dicts remain only as defaults/disaster-recovery fallback.
- Each set has an **immutable generated `id`** (existing ids kept: `bob`,
  `bob_anime`, `younger`, …). HA automations, NFC cards, and MQTT payloads
  (`{"set": "<id>"}`) reference the id; the display **label renames freely** and can
  never break a card. New queues get a slug id derived once from the initial label.
- **Per-set library membership**: each set lists the Plex sections its search/add/
  resolution may use (fixes "a Short can never be queued"). Only movie/show (video)
  sections are ever eligible; `global.excluded_sections` ([2, 7, 8] = Demos, Movie
  Clips, Music Videos) hides junk libraries everywhere unless a set opts one back in.
- File order of `sets:` = shelf order on the web Home page.
- Rotation channels cannot be deleted from the UI (they carry account bindings); their
  filters (ratings/libraries/blocklist) are UI-editable.

## Context

Implements `docs/web-ui-generic-filtered-queues-idea.md` §D/§E, captured from the user
2026-07-20 ("let me specify which libraries are available per queue", "I don't have a
way to add new queues myself", "start a queue by some ID instead of a string name —
if I rename a queue, no big deal").

## Why

One source of truth ends the drift between the two mirrored configs, makes queues
user-manageable end-to-end from the browser, and rename-safe ids protect the physical
card ↔ queue wiring.

## Evidence

User quotes above (2026-07-20 session); shipped + verified live 2026-07-21.
