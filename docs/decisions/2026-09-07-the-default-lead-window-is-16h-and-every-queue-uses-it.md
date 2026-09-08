# The default lead window is 16h, and every queue uses the default

- **Status:** Accepted
- **Date:** 2026-09-07
- **Type:** product rule / playback semantics
- **Supersedes:** the `24h` product default named in
  [the-promote-window-is-a-queue-setting](2026-08-26-the-promote-window-is-a-queue-setting.md)
  — **only** the number. That record's rule, that the window is a QUEUE setting and stays a
  rolling timer, is unchanged and is what this one relies on.
- **Superseded by:** —

## Decision

`DEFAULT_PROMOTE_WINDOW_MS` is **16h**, not 24h. The web mirror `DEFAULT_LEAD_WINDOW` says
`"16h"`.

No queue carries a `promote_window` of its own. The one that did (`kevin_anime`, on `20h`) has
its key removed and follows the default with every other queue.

The precedence is untouched: entry, then queue, then this default. A queue that genuinely needs
a different number may still set one — the control exists and stays.

## Context

The window is a ROLLING timer from the moment playback started. A sitting that starts at 21:10
does not clear a 24h window until 21:10 the following night, which is LATER than the next
night's scan, so the promoted entry silently skips a night. That is the failure the 2026-08-26
record diagnosed, and `20h` was the number offered at the time — "24h is good, but causes
issues. 20h is probably best."

`20h` was then set on one queue and never took effect, because the loader dropped the field
([record](2026-09-07-the-set-loader-carries-every-field-the-engine-reads.md)). So the number
the house has actually been running for two weeks is 24h, and its symptom is exactly the one
the earlier record predicted.

## Why

- **16h clears an ordinary evening and 20h does not, reliably.** Sittings drift. An entry led
  at 21:10 clears at 13:10 the next day on 16h, and at 17:10 on 20h — an evening that starts
  early enough is inside a 20h window and outside a 16h one.
- **It is still long enough to do its job.** A promoted entry is held out of the lead for two
  thirds of a day, so two sittings on the same day do not both get it. That is what the window
  is for.
- **The DEFAULT is the place to put it, not a per-queue key.** A number that is right for every
  queue in the house is a product default. Writing it onto each queue makes the sparse registry
  claim each one has an opinion, and the next change then has to find them all.
- **It reads back honestly.** `leadWindowLabel()` gives an English name only to `24h` and `7d`;
  `16h` has none, so every screen shows the exact number rather than rounding it to "a day" —
  which is the lie the queue-setting control was added to stop telling.

## Evidence

- Owner, 2026-09-07, on a promoted entry that did not play: "Maybe we should change that to
  16h" — then "Make all 16h" and "Default".
- Gate: `e2e/priority-lane-test.ts` case 9 asserts the milliseconds handed to the lead gate,
  and is where the default is pinned (`57_600_000`).
