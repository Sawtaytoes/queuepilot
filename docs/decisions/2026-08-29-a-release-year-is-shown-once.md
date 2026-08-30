# A release year is shown once

- **Status:** Accepted
- **Date:** 2026-08-29
- **Type:** Display rule
- **Supersedes:** —
- **Superseded by:** —

## Decision

When a provider title already ends with the item's release year in parentheses, QueuePilot does
not append that year again. `Fire Force (2020)` remains `Fire Force (2020)`.

A different year in the title is not removed. The release year remains visible after it.

## Context

Plex can provide both a title that contains a year and a separate release-year field. The app
had separate string templates at its search, write and tile surfaces, so it rendered the same
fact twice.

## Why

One release year identifies the item. A duplicate adds no distinction and makes titles harder to
scan.

## Evidence

Owner request, 2026-08-29, current conversation:

> "Just \"Fire Force (2020)\"?"
