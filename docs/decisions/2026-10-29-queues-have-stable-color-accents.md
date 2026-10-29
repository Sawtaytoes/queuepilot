# Queues have stable color accents

- **Status:** Accepted
- **Date:** 2026-10-29
- **Type:** Product
- **Supersedes:** None
- **Superseded by:** None

## Decision

Give Picks and Rules queues an accent derived from the queue ID through
Charcuterie’s getCategoricalIndex. Use the same algorithm and palette as CastKit’s
queue chooser. Titles and provider status colors retain their roles. A queue’s
accent does not depend on its title, selection, or position in the filtered list.

Queue chooser metadata also supplies optional artworkPath values through an on-demand
poster endpoint. It samples the existing read-only provider lineup under the queue
profile, uses the parent show poster for episodes, and preserves shared-server
identity. It does not materialize playback, mutate history, reserve random draws,
or slow down catalog matching. Images are served directly, without redirects,
through CastKit’s existing authorized media proxy.

## Why

The owner requested different colors for queue choices and asked for them in
QueuePilot as well. Similar queue names require visible identity cues.

## Consequences

Queue shelves gain a colored leading edge. The existing finite palette can repeat;
queue titles and people remain the authoritative identity. There is no new stored
setting or account change. Provider indicators retain their existing colors.

Missing artwork leaves the colored tile selectable. Randomized queues draw again
at playback, so a poster is a sample rather than a guaranteed next item.

## Evidence

Four-window fixture browser checks verify colored Picks and Rules shelves and
stable accents after reload. Before/after images: docs/images/queue-colors/.
