# Provider watch history is the default, and entries can opt out

- **Status:** Accepted
- **Date:** 2026-08-30
- **Type:** playback semantics / durable data / UI / correction
- **Supersedes:** The progress-source placement and new-start default in
  [`2026-08-30-a-manual-start-can-own-its-progress`](2026-08-30-a-manual-start-can-own-its-progress.md)
- **Superseded by:** —

## Decision

Every Picks queue has a watch-history default. The default is **Use provider watch history**.
A queue may instead default to **Keep separate QueuePilot history**.

Every entry follows its queue unless it stores an explicit override. An entry can select either
source, including the opposite of its queue. The override is independent of a manual start point.
Clearing or moving a start point does not change which history source the entry uses.

Provider history is the safe default. A play started directly in Plex or another Plex client is
visible to QueuePilot without any attribution step. Queue-owned history is an explicit opt-out for
the case where two audiences share one provider profile but need independent progress.

Queue-owned entries have manual controls in QueuePilot. A person can mark the next item complete,
undo the latest completion, or attach the Plex item that is playing now to this queue entry. The
last action lets QueuePilot capture the live position and let Plex decide completion even when the
play was started directly in Plex.

The stored entry override is `watch_history: provider|queue`. The stored queue default is the same
field. Both are sparse: an absent queue value means `provider`, and an absent entry value means
follow the queue. The former `start.history` field remains a read-compatible entry override and is
promoted to the entry field on the next related write.

## Context

The first queue-owned implementation placed the source choice inside **Start from…**. That made the
choice unavailable to a movie and made it disappear when a start point was cleared. It also made a
new manual start opt out of Plex history by default, although most entries must continue to notice a
play that happened outside QueuePilot.

QueuePilot already knows the queue and entry for a play it starts. A play started directly in Plex
has no QueuePilot queue identity. Provider-history entries need none. Queue-owned entries therefore
need an explicit attribution or a manual completion control.

## Why

- Plex history keeps working when QueuePilot is unavailable, bypassed or forgotten.
- The exceptional shared-profile rewatch stays isolated by queue and entry.
- Queue and entry defaults express the rule once instead of repeating it on every start point.
- A manual action closes the unavoidable attribution gap for a play started outside QueuePilot.
- Keeping Plex as the completion judge preserves its configured threshold and credits-marker rule.

## Evidence

Owner, chat 2026-08-30:

> “I want it to be opt-out, not opt-in UNLESS the global setting for the queue is the opposite.”

> “Basically, if QueuePilot controls the watch history, then we need to be able to control the
> watch history in QueuePilot manually.”
