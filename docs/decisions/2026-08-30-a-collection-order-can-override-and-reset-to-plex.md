# A collection order can override and reset to Plex

- **Status:** Accepted
- **Date:** 2026-08-30
- **Type:** Product rule / data model
- **Supersedes:** —
- **Superseded by:** —

## Decision

A collection entry can carry a `collection_order:` list of Plex member rating keys. QueuePilot
uses that order for playback and for the next-up tile. The What plays panel edits the order
beside the existing inclusion controls.

The override is sparse. Reset deletes `collection_order:` and immediately restores the latest
order read from Plex. If Plex adds a member while an override exists, QueuePilot appends that
member in Plex order instead of hiding it.

## Context

The member list displayed Plex's order but could only include or exclude a member. A person
could not correct the order for one QueuePilot queue without changing the collection for every
Plex consumer.

## Why

- The queue owns playback policy, so a queue-specific order belongs on its entry.
- Absence has a stable meaning: Plex is the source of order.
- Rating keys distinguish duplicate editions that share a title and year.
- A new Plex member must remain playable even when an older override does not name it.

## Evidence

Owner, 2026-08-29, chat `t3code-864630a7`:

> "We should be able to do that somehow in QueuePilot. But we need to do it in a way where you
> can revert/reset back to the Plex ordering."
