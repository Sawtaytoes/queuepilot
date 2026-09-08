# A queue can clear its own watched state on a date each year

**Status:** Accepted
**Date:** 2026-09-08
**Type:** feature / product rule / durable data
**Supersedes:** —
**Superseded by:** —

## Decision

A queue may carry a **reset date**. On the first read after that date passes, every
completion the queue owns is cleared and the queue plays from the start again. Nothing is
removed, and nothing is written to a provider.

Four rules, and the last two are the ones a re-implementation gets wrong.

- **It is evaluated on a READ, never on a timer.** There is no scheduler, no cron and no
  `setInterval`. The check is a comparison against today's date at the moment a queue is
  played, exactly the way `promote_window` is already read at play time. A missed day
  corrects itself: if nobody plays the queue until December, the reset happens in December,
  which is the same answer arriving later.
- **A reset clears THREE things, and only the first is obvious.** The `done` / `done_at`
  flags on each entry; every `queue_entry_history` row for the set, which is where the
  completions live when `watch_history` is `queue`; and the `lead_cooldown` rows, so an
  entry that led last season can lead again. Clearing only the flags leaves a partly
  watched series stuck at the episode it reached, with no badge to explain why.
- **A reset never writes to a provider.** No Plex play count changes, in either direction.
  This is not a courtesy — it is the reason the feature is safe on a household server where
  other people's watch state lives in the same profile.
- **`remove_completed_after` DEFEATS this feature, and it defeats it silently.** That
  setting does not tag an entry, it deletes the entry from the queue. A seasonal queue with
  a TTL set has nothing left to reset by the time the date arrives. The two settings are
  mutually exclusive in practice, and the editor says so where they sit.

## Context

The owner built a Halloween queue for the kids and set its watched state in QueuePilot
rather than in Plex (`watch_history: queue`). The kids watch a few entries a day through
October. The problem is next year: every entry is marked Completed and the queue is spent.

> "Ideally, we'd have some way to reset the watch history in this queue at November, so the
> kids can rewatch it again next year without anything being marked as Completed in
> QueuePilot."

**Demo reel is not the answer, and the reason is specific.** `reel` ignores watched state,
so it would replay entries the kids saw yesterday. The requirement is that nothing repeats
*within* a season and everything repeats *between* seasons, which is a third behaviour
neither existing flag has. See
[completion behaviour is one picker](2026-09-08-completion-behaviour-is-one-picker-not-two-checkboxes.md).

The live Halloween queue was found carrying `remove_completed_after: "24h"`, which is what
produced the fourth rule above.

## Why

- **The rule belongs where the queue is.** Open the queue in a year and the screen says it
  resets, and when. An automation in another system says nothing here.
- **A read-time check has no failure mode a timer does not have, and loses one.** A timer
  that does not fire is invisible until somebody notices a repeat. A comparison against the
  date cannot silently not happen.
- **It generalises for free.** A Christmas queue, a birthday queue or an advent queue is the
  same row with a different date.

## Alternatives rejected

- **Home Assistant publishes the reset on 1 November.** Rejected as the primary mechanism —
  see [the reset is exposed on the API](2026-09-08-the-reset-is-exposed-on-the-api-and-mqtt-without-a-home-assistant-automation.md),
  which keeps the trigger and drops the dependency.
- **Reset when the season opens, as part of the season window.** Rejected by the owner:
  hiding is display and resetting is data, and folding them makes one setting answer two
  questions. See [a season window gates the enabled flag](2026-09-08-a-season-window-gates-the-existing-enabled-flag.md).

## Evidence

Owner, 2026-09-08, on where the schedule belongs:

> "I know I put all these automations in Home Assistant, but this one seems very much like
> it belongs in QueuePilot. […] I could just as well use Home Assistant, but it feels like
> tight coupling, and wouldn't work well for others using QueuePilot."

And on the split from the display option:

> "Option 3 is more of a display one, not a 'reset the queue' one. So I'd see those two as
> different options."
