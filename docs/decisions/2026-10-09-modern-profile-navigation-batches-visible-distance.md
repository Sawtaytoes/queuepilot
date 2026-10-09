# Modern profile navigation batches the visible distance

- **Status:** Accepted
- **Date:** 2026-10-09
- **Type:** Performance / device control
- **Supersedes:** —
- **Superseded by:** —

## Decision

On the modern Plex profile picker, use the focused and target tile indices to send a
bounded batch of direction keys in one ADB input command. Re-read both endpoints before
sending the batch, then read the actual landing and replan if events were missed. Count
individual arrows against the existing navigation budget. A target absent from the screen
uses the roster only as a direction hint and advances one slot at a time.

Carry the opening picker tree and each navigation read-back into the next decision instead
of dumping the same screen again. Keep a fresh read before CENTER and require signed-in
navigation afterwards. The modern adapter owns its settling delay; the shared transport
must not add a second delay. Preserve the legacy adapter and independent playback account
audit. Unknown screens, onboarding, foreground changes and cancellation remain stop gates.

## Context

The adapter introduced for Plex's single-activity Android TV UI sent one arrow at a time.
Each intermediate move incurred a planning dump, a guard dump, a landing dump, and another
planning dump. Both the transport and adapter also slept after the same arrow.

## Why

Screen dumps and Android input startup dominate the cost of moving across accounts.
A visible distance can be sent in one command without guessing the off-screen roster order.
Actual landing verification handles missed events without selecting an unintended account.

## Evidence

Owner report in chat `cd7b2c89-6abf-4c07-b90a-e30427d3e702`:

> "Profile swapping is insanely slow in QueuePilot after the Plex update. Please fix."

`server/src/plexControlModern.test.ts` covers batched movement in both directions, a changed
target or focused index, missed events, off-screen targets, the individual-arrow budget,
cancellation and leaving the picker. The two-slot fixture reduces screen dumps from ten to
five and input invocations from three to two. These are automated operation counts, not a
live-device timing claim. Live testing waits until the current viewer releases the player.
