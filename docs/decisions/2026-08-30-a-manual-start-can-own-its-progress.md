# A manual start can own its progress

- **Status:** Accepted
- **Date:** 2026-08-30
- **Type:** playback semantics / durable data / UI
- **Supersedes:** The single-mode clause of
  [`2026-07-31-per-entry-start-episode-override`](2026-07-31-per-entry-start-episode-override.md)
- **Superseded by:** [`2026-08-30-plex-decides-completion-and-the-queue-owns-the-resume-point`](2026-08-30-plex-decides-completion-and-the-queue-owns-the-resume-point.md) (the fixed completion threshold only)

## Decision

A Plex show or collection start point has an explicit progress source:

- **Keep progress in this queue** uses a durable completion ledger keyed by queue id, entry key
  and episode rating key. Plex watched marks do not remove an episode from that entry.
- **Skip episodes already watched in Plex** keeps the original start-floor behavior.

The start editor defaults a newly saved start to queue-owned progress. An older start with no
mode keeps the original Plex-history behavior. This compatibility rule prevents an unattended
upgrade from restarting every manually floored series.

Saving a queue-owned start clears that entry's prior private ledger. Moving the start backwards
therefore begins a new run instead of retaining completions from the old run. QueuePilot records
an episode as complete when the live player reaches 90 percent of its duration. A manual skip
before that boundary does not advance the private ledger.

The ledger lives in `queuepilot.sqlite`, not `cache.sqlite`. It is household state, not a derived
copy of Plex state. Two queues that contain the same series have independent rows.

## Context

The original start control was a floor over provider history. That supports a series started on
another service: episodes before the floor are skipped, and episodes already watched in Plex at
or after it are also skipped. It cannot support a shared Plex profile that is rewatching a series
with one audience while continuing later episodes with another audience. Moving the floor back
does not remove the later Plex marks, so the resolver jumps to the later unwatched season.

Both meanings are valid. The start point must select between them instead of assigning one global
meaning to every series.

## Why

- Queue identity is the boundary the product already presents. Progress attached to that identity
  matches the audience and activity represented by the queue.
- A separate ledger does not corrupt or rewrite Plex history.
- An explicit provider-history mode preserves the watched-elsewhere and skip-an-arc use cases that
  created the original floor.
- A completion threshold distinguishes a completed replay from an early stop or manual skip even
  when Plex had already marked the episode watched before this QueuePilot run began.

## Evidence

- Owner, chat 2026-08-30: *"When I specify a different starting position, it needs to store its
  own watch history and start from that point. Unless I specify 'start here, skip watched' or
  something. Basically, this should be configurable."*
- Live-state diagnosis immediately before the request: a collection start pointed at its first
  episode, every episode in that member already carried a Plex watched mark, and the next member
  had no watched marks. The existing resolver therefore selected the next member's first episode.
