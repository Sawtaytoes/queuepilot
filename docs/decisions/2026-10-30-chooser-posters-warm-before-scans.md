# Chooser posters warm before scans

- **Status:** Accepted
- **Date:** 2026-10-30
- **Type:** Design
- **Supersedes:** None
- **Superseded by:** None

## Decision

Resolve queue preview artwork in the existing background warmer and retain bounded successful image bytes while refreshing. A manifest lets configured display consumers prefetch all currently available Plex queue artwork. Matching uses local registry and audience metadata, independently of provider image work. Previews do not reserve random selections or start playback.

## Context

The owner reported slow poster loading and undersized choices after scanning.

## Why

Provider work belongs outside the scan path. Measured geometry uses the space
available on the actual display rather than a fixed tile size. Cache failures
must leave matching and controls usable.

## Evidence

Cache reuse and authorization checks run against fixtures. Browser verification
covers four named windows and the 480 × 480 touch panel.
