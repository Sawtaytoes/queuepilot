# Defer the queue_builder Python → Node port (revisit later, not now)

- **Status:** Accepted
- **Date:** 2026-07-21
- **Type:** architecture / scope
- **Supersedes:** —
- **Superseded by (in part):**
  [2026-08-03-retiring-python-except-the-cast-sidecar](2026-08-03-retiring-python-except-the-cast-sidecar.md).
  The stated blocker was *"Plex Cast + account-token minting is high-risk"* — account-token
  minting is **already ported** (`server/src/plex.js:48`), and the cast half is preserved as a
  minimal Python sidecar rather than reimplemented.

## Decision

Do **not** port the Python playback engine (`queue_builder/`) to Node now. Mark it as a
later revisit. Bob: *"Mark the Python → Node port for later then."*

The layers stay as they are: **Node owns config + the web API + MQTT bridge** (sets.yaml is
Node-written; dynamic channels are fully Node-configurable), and **Python stays the playback
executor** — Plex cast/PlayQueue, per-account token minting, and Google-Cast to the Shield.

## Context

Bob re-floated consolidating everything into one Node server (originally an open item in
`web-ui-handoff.md` #6). The motivation was *"the logic is hidden in Python"* — but that pain is
being addressed a different way: config authority has already moved to Node, so the *knobs* are in
Node and only the *runtime executor* is Python.

## Why

- The risky, working core in Python is the **cast/playback stack** (`plexapi` + `pychromecast`
  casting to the Shield *as each account's token* — the deterministic per-account path that records
  the kids' watches on the right profile). Node has no mature equivalent; reimplementing Plex Cast +
  account-token minting is high-risk in the one area that must never break for the family.
- The split isn't causing friction — the layers coordinate cleanly through sets.yaml/queues.yaml
  (single-writer Node, read-only Python).
- Revisit only if the cast stack gains a solid Node story, or the split starts causing real pain.

## Evidence

Bob, 2026-07-21: *"Mark the Python → Node port for later then."* (after agreeing the cast-stack
risk makes a port unwise right now).
