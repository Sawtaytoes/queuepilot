# Skipped items follow the queue view

- **Status:** Accepted
- **Date:** 2026-08-30
- **Type:** UI / correction
- **Supersedes:** the placement and text-row shape in [2026-08-22-a-curated-queue-skips-items-the-way-a-filtered-pool-blocks-them](2026-08-22-a-curated-queue-skips-items-the-way-a-filtered-pool-blocks-them.md); its data and playback rules stand
- **Superseded by:** —

## Decision

Skipped is the last collapsible section on a queue page. When opened, its items use the same Posters, Cards or List density as the active queue. Each item has artwork, a title link to its own Plex page, and a badge that names the show or collection it came from. The ordinary play position becomes Restore.

## Context

The first panel sat above the queue as full-width text rows. It did not carry artwork and ignored the density chosen for everything else on the page.

## Why

Skipped items are still media items from this queue. Reusing the queue's view makes them recognisable and removes a separate display language. Putting the review surface last keeps it out of the active queue's path while preserving its existing collapsed default.

## Evidence

Owner, 2026-08-29: “Instead, put this at the bottom of the queue screen, when you open it, have it list them in the same view mode as the queue (like posters or list, etc) and then have the ‘play’ on them be the Restore button. The titles should also still link to Plex directly, and we can display them with some indicator of which collection or show they're from.”

The owner approved the served HTML preview on 2026-08-30: “Perfect!”
