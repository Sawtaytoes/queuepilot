# The reading list is a MAINTAINED window: 12 up front, then add and remove

- **Status:** Accepted
- **Date:** 2026-08-17
- **Type:** bug / feature
- **Supersedes:** —
- **Extends:** [2026-08-15-the-reading-list-is-rebuilt-not-appended](2026-08-15-the-reading-list-is-rebuilt-not-appended.md),
  [2026-08-17-playback-length-is-the-knob-and-top-up-is-derived](2026-08-17-playback-length-is-the-knob-and-top-up-is-derived.md)
- **Superseded by:** —

## Decision

**A reading list holds one window (12 by default) and is KEPT there.** The
top-up tick appends the next chapters and drops the rows that are fully read,
so the list the tablet pulls from stays about 12 unread, indefinitely.

Owner, 2026-08-17, on the Kavita cap:

> "Yes, make it 12, then add items."

> "Add and remove*"

That is what `topupList` has done since it shipped — appending at the tail and
calling `remove-read` after. **It had simply never run.**

## Context

`topup()` refused a reading list three separate ways, each of which is a rule
about a PUSH lineup:

1. `SESSION.set` — a top-up asked about *what is playing*. Nobody "starts" a
   reading list; the launcher hands over a URL and no session exists at all, so
   every tick answered `no active session`.
2. `cfg.source !== 'rotation'` — the live `manga_webtoons` pool is a CURATED
   queue, rejected as "not a rotation channel".
3. `needsTopup(target)` — derived, and correctly `false` for a set whose length
   is one window. For a *sitting* that is the point ("plays 12 and stops"); for
   a persistent artifact it is meaningless, because the list is a sliding
   window by construction.

And the HA automation only ticks while `sensor.queuepilot_status` names a
running set, which a reading launch never does.

So the list was seeded once per launch and then only ever shrank as chapters
were read — the exact opposite of the sliding window the 2026-08-17 top-up
record describes.

## Why

- **A reading list is not a sitting.** `playbackLength`'s Kavita `fallback`
  argument already says this in code: the list is "a sliding window of many
  series that the tablet pulls from over days". The tick now treats it that
  way instead of asking a push question about it.
- **The tick sweeps rather than being told.** `queuepilot/cmd/session/topup`
  keeps its empty payload — the wake-up-not-an-instruction contract — and the
  app finds the pull sets itself. Naming `manga_webtoons` in an HA automation
  would put a second copy of the set registry in a place that cannot see it.
- **One builder for launch and top-up.** The top-up's own `buckets()` call
  omitted `entries`, which for a curated reading queue means the library shelf
  instead of the owner's ninety-three series — the bug `buckets()` already
  records from the launch path. Both now call `pullLineup()`.
- **The cooldown is per set.** One shared timestamp meant a reading top-up put
  the kids' Shorts channel into cooldown, and whichever tick arrived first
  owned the next minute.

## Consequences

- The reading tick runs whether or not anything is playing, so HA gets a second
  time-pattern branch with no session condition. Every tick that finds nothing
  to do costs one Kavita list read.
- A set that has never been launched has no list, and `topupList` answers "no
  reading list for this set yet" — that is the guard against building a lineup
  in front of a reader who did not ask for one.
- `resp/topup` gains an optional `lists: [...]` array. `ok` is the AND of
  everything attempted, so HA's failure branch means exactly what it did.

## Evidence

- Owner quotes above, 2026-08-17.
- `e2e/topup-test.ts`: a curated reading set with no session and no `length:`
  tops up to a window of 12 at `TOPUP_AT`, and the sweep finds it unaided.
- Live: `/lists/153` held 4 unread rows and had not grown since launch.
