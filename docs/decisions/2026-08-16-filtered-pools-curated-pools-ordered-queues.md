# The three Play groups are "Filtered Pools", "Curated Pools" and "Ordered Queues"

- **Status:** Accepted
- **Date:** 2026-08-16
- **Type:** preference / naming / UX
- **Supersedes:** [dynamic-vs-curated-channel-categories](2026-07-21-dynamic-vs-curated-channel-categories.md)
- **Superseded by:** —
- **Builds on:** [queues-have-orthogonal-mode-knobs-not-named-types](2026-08-12-queues-have-orthogonal-mode-knobs-not-named-types.md)

## Decision

The Play landing's three groups are renamed, and the word **"channel" leaves the UI**:

| Was | Is | What it means |
| --- | --- | --- |
| Dynamic Channels | **Filtered Pools** | Members are *computed from rules* each scan (`source: rotation`). |
| Curated Channels | **Curated Pools** | Members are *picked by hand*, played as a rotation. |
| Queues | **Ordered Queues** | Members are picked by hand and played *in order*. |

The configurator that holds the two pool kinds is the **Pools** screen (heading, document
title, back-label, and the toolbar's `Pools ›` link). Its two create buttons are
**＋ Filtered pool** and **＋ Curated pool**.

The false "**random rotation**" meta line under each Curated Pool tile is corrected to
"rotation", and the Pools-screen note "the real rotation *shuffles* fresh every scan"
becomes "*re-draws* fresh every scan".

**Scope: user-visible strings only.** Internal identifiers — the `#/channels` route, the
`channel-mode` / `movies-channel` body classes, `ChannelsView.tsx`, `channelSetIds`,
`kind: 'anime'` — are deliberately untouched. Renaming those is the code migration the
knobs ADR already carved out as separate work.

## Context

The 2026-08-12 knobs ADR deleted the `queue` vs `channel` split at the data-model level,
but shipped as design only — so the UI kept saying "Dynamic Channels" / "Curated
Channels" four days later. The owner noticed the drift from a screenshot of the live app
and asked for the names to be fixed.

## Why

- **"Channel" was already retired**, and for a reason that has not gone away: Plex,
  Jellyfin and Emby all ship a real Live TV *channel*. An internal "channel" meaning
  something else is permanent confusion as QueuePilot grows past Plex.
- **"Dynamic" named the wrong axis.** The 2026-07-21 ADR said out loud that it was
  naming "rule/filter vs. explicit member list" — and then chose a word about *behaviour*.
  Every group is dynamic in some sense; only one is *filtered*. "Filtered" is also the
  word the app's own meta text already uses ("rotation · ratings-filtered").
- **"Pool" is the accurate noun for an unordered set of shows**, which is what both pool
  kinds are — and it forces the third group to say what actually distinguishes it, hence
  **Ordered** Queues. The pair now reads off two different axes cleanly: *how members get
  in* (filtered / curated) and *how they come out* (pool / ordered queue).
- Fixing "random rotation" in the same pass: Correction 1 of the knobs ADR proved that
  rotation shuffles only **which show leads**, once per session
  (`server/src/engine/rotation.js:76`), then emits strict round-robin. The tile was
  advertising a mode that does not exist in the codebase.

## Evidence

- Owner, 2026-08-16, from a screenshot of `queuepilot.example.com`: *"I thought we renamed
  QueuePilot 'Channel' already. … The Curated 'Pool' would work better because it's a pool
  of shows. 'Dynamic' doesn't make sense though. I think we need to fix the names."*
- Owner, same session, on the third group: *"Maybe rename the 3rd one to Ordered Queues
  because it's no longer a pool but a real ordered queue."*
- "Filtered Pools" chosen over "Smart Pools" and "Auto Pools".
