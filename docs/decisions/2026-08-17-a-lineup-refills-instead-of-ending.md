# A lineup refills instead of ending, and HA ticks it

- **Status:** Accepted
- **Date:** 2026-08-17
- **Type:** feature / architecture
- **Supersedes:** —
- **Superseded by:** —
- **Extends:** [a channel sets its own lineup length](2026-08-17-a-channel-sets-its-own-lineup-length.md)
- **Narrows:** [Kavita progress is read on demand](2026-08-16-kavita-progress-is-read-on-demand-not-pushed.md)

## Decision

**`refill: true`** on a rotation channel keeps its lineup topped up
instead of letting it end. `length` stops meaning "the whole evening"
and becomes the **WINDOW** — how far ahead to stay.

**Not `length: all`.** A single infinite lineup means queueing the whole
eligible pool up front — 442 items on the live Shorts channel — which is
a slow scan on a card someone just tapped and is stale the moment
progress moves. The owner described the window shape exactly:

> "it'd load up X number in the queue, and then add more as you started
> getting close to the end of the queue"

**`on_complete: restart | drop`** for a series with nothing unwatched
left. **Default stays `drop`**, which is what every channel has silently
done since the beginning (a finished show contributes no bucket).
`restart` puts it back at its start floor. It fires only when a show is
GENUINELY finished — never when the current window merely stopped drawing
from it. Those are different questions, and `weightedInterleave` already
has its own "every bucket exhausted" condition that means the other one.

**The queue is done only when every bucket is dropped or exhausted.**
That is the real terminator, per the owner: "If you finish all shows, the
queue is truly done at that point."

**HA owns the schedule.** An automation publishes
`queuepilot/cmd/session/topup` every 5 minutes while a session is live;
the app answers on `queuepilot/resp/topup`. The tick is a **wake-up, not
an instruction** — the payload is empty on purpose, because the
automation cannot see the live playQueue, the viewer's position in it, or
whether the channel opted in. No cron, no in-app poll loop.

**Top-up measures the LIVE playQueue, never `SESSION.queue`.** The
session remembers what it *sent*; the viewer has been skipping around
since.

**Kavita's reading list is a SLIDING WINDOW** — append at the tail, then
`remove-read` to drop fully-read rows.

## Context

The owner, 2026-08-17, when phase 1 shipped a fixed `length:`:

> "There's no lineup length. I thought we programmed it to keep going
> forever. So it'd load up X number in the queue, and then add more as
> you started getting close to the end of the queue."

We had not. Phase 1 made the number per-channel; it was still a number,
and a number runs out.

## Why

- **A wake-up, not an instruction.** Putting "add 12" in the payload
  would split the decision across two systems, and the half that lives in
  HA is the half that cannot see the queue. Every guard — opted in? how
  much is left? already topped up recently? — is in the app, so the
  automation can be as dumb as a 5-minute timer.
- **Extend, never rebuild.** A new playQueue restarts playback. The whole
  point is that the kids never notice.
- **The trim is what keeps the reading-list decision intact.** [The
  reading list is rebuilt, not appended](2026-08-15-the-reading-list-is-rebuilt-not-appended.md)
  exists because `materialize()` silently unioned every lineup ever built
  and the live list reached 23 series — "stuff I absolutely did NOT add".
  A window that trims is still exactly this launch's lineup. A window
  that only grows is that bug by another door.
- **`drop` stays the default** because flipping it would make every
  existing channel start replaying old episodes, silently, on deploy.

## Evidence

⚠️ **Plex has no append-at-end.** Spiked against this server before any
of phase 3 was built (`e2e/spike-playqueue-extend.ts`, 2026-08-17):

| What | Result |
| --- | --- |
| `PUT /playQueues/{id}?uri=…` grows the queue in place | ✅ id preserved, size 2 → 3 |
| Successive adds keep their order | ✅ chains via `playQueueLastAddedItemID` |
| One PUT with several ratingKeys | ✅ same result, one round trip |
| Appends at the **end** | ❌ inserts after the CURRENTLY SELECTED item |
| `next=0` / `next=1` / omitted change that | ❌ all three behave identically |

Seed `[A, B]` + append `C` yields **`[A, C, B]`**, not `[A, B, C]`.

This is why `TOPUP_AT` is **3** and not, say, 20: at three items left
there is almost no tail for the new items to jump ahead of, and a
rotation channel's tail is a shuffle anyway. **Do not "fix" this by
rebuilding the queue** — that restarts playback, which is the hiccup the
whole path exists to avoid.

## Narrowing the Kavita no-poll rule

[Kavita progress is read on demand](2026-08-16-kavita-progress-is-read-on-demand-not-pushed.md)
says there is "no poll, no SignalR listener". That still holds: Kavita
cannot push (`UserProgressUpdate` is admin-only), and QueuePilot still
subscribes to nothing. What changes is that a page load is no longer the
only thing that constitutes *demand* — an MQTT tick is one too. Progress
is read at the tick, once, and not cached.

## Follow-up

- No UI control yet for `refill` / `on_complete` / `length` — all three
  are API- and YAML-editable, and the set editor should grow them.
- The rewatch branch (`behavior: rewatch`, movies) still returns exactly
  one item and does not honour `length` or refill. Wrapping it into
  repeated `pickRewatch` calls is the remaining piece of "movies wrap
  into rewatch weighting".
