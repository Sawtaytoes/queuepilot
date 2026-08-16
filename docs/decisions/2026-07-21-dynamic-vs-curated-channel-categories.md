# Channels split into two named categories: "Dynamic Channels" and "Curated Channels"

- **Status:** Accepted
- **Date:** 2026-07-21
- **Type:** preference / naming / UX
- **Supersedes:** —
- **Superseded by:** [filtered-pools-curated-pools-ordered-queues](2026-08-16-filtered-pools-curated-pools-ordered-queues.md)
  (the category NAMES; the two-category split itself survives)
- **Builds on:** [queues-vs-channels-taxonomy-play-first-ia](2026-07-21-queues-vs-channels-taxonomy-play-first-ia.md)

## Decision

The Channels screen presents two named categories, distinguished by **how the lineup is chosen**:

- **Dynamic Channels** — rule-based pools computed each scan from filters: Shows & Shorts, Movies, and
  any new `source: rotation` channel created via the Node config form.
- **Curated Channels** — hand-picked member lists played shuffled: the anime channels (`source: queue`,
  `kind: anime`).

Both categories live under the Channels screen and are **reached the same way** — a Dynamic channel
opens its pool + filters view, a Curated channel opens its member grid — and **both expose a config
surface** (inline rename + ⚙ Configure), so neither silently jumps elsewhere. The curated-channel grid
search noun is fixed to say **"channel"**, not "queue" (branch on a `body.channel-mode` class). The Play
landing groups Dynamic / Curated / Queues.

## Context

Two kinds of channel behaved differently and it was confusing: picking Shows & Shorts or Movies stayed
on the Channels screen (rule-based pools), while picking an anime channel navigated to a member grid,
and that grid's search said "search this queue's libraries" — the wrong noun. Bob asked to separate
them into two labeled categories and floated "Specified Channels?" while disliking it.

## Why

- **Names the real distinction** — rule/filter vs. explicit member list — rather than "curation per se"
  (as Bob noted, they're *all* curated in a sense). "Dynamic" vs "Curated" reads clearly and is the
  terminology he approved.
- **One consistent navigation + config surface** removes the "why did this one jump somewhere else?"
  confusion and ties into the universal rename/configure work (§A).
- Fixing the "queue" → "channel" noun matches what the user is actually looking at.

## Evidence

Bob, 2026-07-21, approving the names: *"yes. Technically, they're all curated, but I think that
terminology is good."* (choosing "Dynamic Channels" / "Curated Channels" over "Specified Channels").
Locked in `docs/web-ui-v2-feedback-handoff.md` §F (commit 4993dc7).
