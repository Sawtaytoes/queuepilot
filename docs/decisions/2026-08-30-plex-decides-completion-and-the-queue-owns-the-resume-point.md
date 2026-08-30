# Plex decides completion, and the queue owns the resume point

- **Status:** Accepted
- **Date:** 2026-08-30
- **Type:** playback semantics / correction / durable data
- **Supersedes:** The fixed 90-percent completion clause of
  [`2026-08-30-a-manual-start-can-own-its-progress`](2026-08-30-a-manual-start-can-own-its-progress.md)
- **Superseded by:** —

## Decision

A queue-owned series stores both facts that make progress:

- the queue entry's own resume position for each episode;
- whether Plex completed that particular play.

QueuePilot writes the live player position to `queue_entry_history` while playback runs. The
next play of that queue entry seeks to this position, even if the same Plex profile has a
different position or watched mark from another viewing.

QueuePilot does not implement a percentage or credits-marker rule. After an item leaves the
player, it reads that item's state under the queue's Plex profile. A play-count increment means
Plex completed this play; QueuePilot marks the episode complete and clears its private position.
An unchanged play count with a non-zero `viewOffset` means partial; QueuePilot stores that exact
offset. An unchanged count and zero offset means Plex retained no progress; QueuePilot resets the
private offset and does not complete the episode.

The comparison is against the play count captured before handoff. Testing `viewCount > 0` is
wrong for a rewatch because it was already non-zero before QueuePilot started the episode.

## Context

Plex exposes two server settings. **Video played threshold** defaults to 90 percent. **Video play
completion behavior** can instead use credit markers. The live server uses “earliest between
threshold percent and first credits marker,” so a fixed 90-percent test disagrees whenever the
first credits marker is earlier. Plex already resolves that policy and reflects it in the item's
play count and resume offset.

The first queue-owned implementation kept completed episode keys but continued to seek from
Plex's shared `viewOffset`. That made completion independent by queue but left mid-episode resume
shared by profile, which was only half of the requested model.

## Why

- Plex remains the one implementation of its configurable percentage and marker rules.
- Comparing play counts works for first watches and rewatches.
- A queue-specific position prevents another audience's later viewing from moving this queue.
- A partial stop survives a restart because the position lives in the book-of-record database.
- A short play that Plex discards does not become complete merely because the provider offset is
  zero.

## Evidence

- Owner, chat 2026-08-30: *“We should make sure this matches Plex.”*
- Owner, same chat: *“If we track that, then when you play the queue on that file, it can seek you
  to the correct spot as well.”*
- Plex Support, **Library**: `Video played threshold` defaults to 90 percent, while `Video play
  completion behavior` can use first or final credits markers or the earlier of the threshold and
  first marker: <https://support.plex.tv/articles/200289526-library/>.
- Live server preferences read on 2026-08-30: `LibraryVideoPlayedThreshold=90` and
  `LibraryVideoPlayedAtBehaviour=3` (earliest between threshold and first credits marker).
