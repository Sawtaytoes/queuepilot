# The promote window is a QUEUE setting, and it stays a rolling timer

- **Status:** Accepted
- **Date:** 2026-08-26
- **Type:** product rule / playback semantics
- **Supersedes:** —
- **Superseded by:** —
- **Builds on:**
  [the-lead-window-belongs-to-a-promote-not-to-an-ordered-queue](2026-08-26-the-lead-window-belongs-to-a-promote-not-to-an-ordered-queue.md)
  — that record settled WHICH entries get a window; this one settles who names its length

## Decision

A Picks queue carries its own `promote_window`, and the queue editor edits it. The
precedence is unchanged and is now visible from end to end: **entry, then queue, then the
24h product default**.

The window stays a **rolling timer** from the moment playback started. Two other shapes
were offered and both were declined:

| Offered | Answer |
| --- | --- |
| A day boundary — one lead per viewing day, the day starting at 04:00 local | Declined |
| A debounce — the entry may lead again once N hours of no scan have passed | Declined |

`kevin_anime` is set to `20h`.

The entry sheet may no longer say "once a day". It reads the queue's window and names it,
because the panel described a rule the engine was not running.

## Context

Reported on 2026-08-26: *"Trapped in a Dating Sim is in the QueuePilot priority queue, but
it didn't play today when I scanned the card."*

Nothing was broken. The entry is `placement: priority`, a promoted entry defaults to
`lead: once`, and the book of record held one row:

```
kevin_anime | title:Collection: Trapped in a Dating Sim… | 2026-08-26T05:06:37Z
```

That is **00:06 local time**, and Plex agrees — Season 2 Episode 7 played in that sitting
and was marked watched at 00:28. The 24h window therefore ran to 00:06 the NEXT day. The
scan that was reported came at about 22:30 the same evening, 1 hour 36 minutes short, so
the engine suppressed the lead, dropped the entry back into the pool, and a pool member
led instead.

The failure is structural, not a one-off. The owner's sittings start late and cross
midnight, so **every** lead stamps a time after midnight — later on the clock than the
following night's scan. A flat 24h window makes a promote skip a night, every time.

## Why

- **A rolling timer is correct; 24 hours is not.** The right length is a property of WHEN a
  queue is watched, which the app cannot know and a preset menu cannot guess. Making it a
  setting is the smallest change that fixes the report without inventing a second clock.
- **A day boundary needs a local midnight-ish line the app does not otherwise have.** The
  owner's own framing was *"resetting at 4a my timezone works"*, which is true — and it is a
  second time concept living beside the timer, for a result `20h` already gives.
- **A debounce is worse than either.** Its clock restarts on activity, so a long sitting
  keeps pushing the entry further out — the opposite of the promise a promote makes.
- **The engine already read the queue level.** `leadWindowMs()` has always been
  entry > set > default, and `PATCH /api/sets/:id` has always accepted `promote_window`.
  What was missing was a control, so the knob existed and no screen could reach it. Case 9
  of `e2e/priority-lane-test.ts` is the first test to assert the middle rung.
- **Blank means the default; `never` means no window at all.** The write path drops the OFF
  spellings rather than storing `0`, because `parsePromoteWindow` returns null for an
  unparseable value and null falls through to 24h. A stored `0` would read as the default
  and look like a bug.

## Evidence

- Owner, 2026-08-26, choosing between the three shapes: *"No, debounce is bad too. Yeah,
  just lemme configure the reset time. 24h is good, but causes issues. 20h is probably
  best."*
- The `lead_cooldown` row and the Plex history above, read from the live appliance while the
  report was still open.
- `e2e/priority-lane-test.ts` case 9 — the queue's window reaches the gate (72,000,000 ms
  for `20h`), an entry's window outranks it, and an unparseable one falls back to 24h.
