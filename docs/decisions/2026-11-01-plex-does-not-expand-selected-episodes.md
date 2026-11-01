# Plex does not expand selected episodes

- **Status:** Accepted
- **Date:** 2026-11-01
- **Type:** playback correctness
- **Supersedes:** —
- **Superseded by:** —

## Decision

QueuePilot creates Plex video play queues with `continuous=0`. This applies to finite
and infinite sittings, including a lineup with one episode. QueuePilot owns selection,
ordering, skips, and refill; Plex must not replace that selection with subsequent episodes
from the same series. Infinite playback continues through QueuePilot's existing top-up.

## Context

Plex's continuous mode can expand a single episode key into a series queue. The earlier
`max_items` check disabled it only for legacy caps, leaving the playback-length setting
and ordinary mixed queues exposed. An episode rating key alone does not prevent expansion.

## Why

Explicit item selection must preserve queue membership and episode identity.

## Evidence

Regression coverage exercises single-episode queue creation and a synthetic seasonal pool
containing an episode and a movie. Live catalog values belong in private deployment notes.
