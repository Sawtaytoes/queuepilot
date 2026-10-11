# Curated lineups batch fresh entry metadata

- **Status:** Accepted
- **Date:** 2026-10-11
- **Type:** Performance / provider reads
- **Supersedes:** —
- **Superseded by:** —

## Decision

For a curated Plex lineup with multiple direct home-server rating keys, read their metadata
in batches of at most 50 using the selected profile's token. Map each returned row by rating
key, then resolve entries sequentially against that fresh snapshot. Discard it after the
lineup. Do not prefetch shared-server keys through the home server.

Missing or duplicate rows and failed batches fall back to the original individual read.
Different tokens, query parameters, episode lists and collection reads also retain their
original reads. Empty queues, single-entry starts, remote-only queues, reels and rotation
pools do not gain a prefetch. Keep watched-history reads, fresh episode resolution,
queue-owned progress, lead gates, ordering and RNG consumption unchanged.

## Context

After improving navigation in the updated Plex app, queue construction still made one
metadata request per entry before it could choose the head. Plex already accepts a
comma-separated metadata path; the application uses that endpoint for live view states.
The network requests were sequential even though their metadata reads are independent.

## Why

Grouping the reads removes round trips without running the resolver concurrently. Resolving
entries concurrently would change shared RNG consumption and could change the chosen lineup.
A fresh snapshot per construction avoids introducing a TTL or serving a previous sitting's
watch state. Preserving individual fallback keeps an incomplete batch from turning a valid
entry into an unresolved one. Server and token scope prevent numeric-key collisions from
crossing a provider boundary.

## Evidence

Owner request in chat `af086239-eb25-442f-a6f7-35dbdcf1752d`:

> "We need to figure out why it's so slow to use Plex now and speed that up if possible."

A live construction benchmark over a consistent copy of the durable store reduced metadata
requests from 58 to 15. Initial lineup resolution took 5.863 seconds before and 3.923 seconds
after; the warm pass took 4.490 seconds before and 3.234 seconds after (28% faster). Binding
and token minting were measured separately. No playback or durable queue mutation was
performed by the construction benchmark. These measurements cover lineup resolution, not
total startup or remote-control navigation.

Tests compare the complete seeded lineup before and after batching, including mixed history
sources, shared-server identity and a shuffled episode entry. They also cover bounded batches,
response reordering, token separation, fresh subsequent constructions, missing/duplicate
rows, transport failures and unchanged live episode reads.
