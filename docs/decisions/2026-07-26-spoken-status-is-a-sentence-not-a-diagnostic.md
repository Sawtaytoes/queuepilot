# Spoken status is a sentence, not a diagnostic — and it only speaks when something is actually wrong

- **Status:** Accepted
- **Date:** 2026-07-26
- **Type:** UX
- **Supersedes:** —
- **Superseded by:** —

## Decision

`plex-channels/state`'s `error` string is **read aloud verbatim** by
`automation.plex_channels_status_announcements`. It is therefore written as a sentence a
person would say out loud — not as a debugging string.

Two rules follow:

1. **No timeout figures, no switcher jargon in `error`.** "the Shield did not switch to it
   within 120s (auto-switch: selected 'Demo' on the picker)" becomes "…and the Shield did
   not switch to it. Pick it on the TV." The `PROFILE_WAIT_SECONDS` figure and the ADB
   detail go to the container log via `print()`, which is where they get acted on anyway.
   The wait having ended is what "did not switch" already communicates.
2. **The "still waiting" announcement fires at 25s, not 6s.** It must be longer than a
   SUCCESSFUL gated scan, or it narrates every scan including the ones about to work.
3. **At most ONE announcement per scan.** A stalled gated scan goes `waiting` → `error`,
   which spoke twice: once at 25s and again when the 120s profile wait expired. The error
   branch is now skipped when the wait announcement already covered that scan (the state
   was `waiting` for ≥25s before erroring). An error arriving *before* 25s, or with no wait
   at all, has announced nothing yet and still speaks.

Anything added to `error` later gets read to whoever is standing at the reader. Write it
accordingly.

## Context

The announcement was enabled earlier the same day (`b1e725c`) with a 6s threshold, on the
assumption recorded in the automation's own description: *"a successful ADB auto-switch is
faster and stays silent, so this speaks only when someone actually needs to act."*

That assumption was already false when written. `468a09e` had measured the switch itself at
**~9-11s**, and the container log shows the full gated scan — command published → picker
summoned → pressed → PMS log confirms → playback starts — holding `waiting` for **18-21s**
on the runs that *worked*:

```
07:45:52 cmd session/start {'set': 'demo'} ... 07:46:13 playback ok   (21s)
07:46:26 cmd session/start {'set': 'shows_shorts'} ... 07:46:44 ok     (18s)
```

So every gated card tap announced "Plex is waiting for the … profile. Pick it on the TV if
it does not switch by itself" — and then switched by itself, seconds later. The announcement
meant to make a stuck scan audible instead made a working one chatty, which trains you to
ignore it.

## Why

An announcement is a per-room interruption, not a log line. Its cost is paid by whoever is
standing in the kitchen, so it has to clear a higher bar than "some state changed":

- **It must be rare enough to mean something.** One that fires on success is noise, and
  noise gets tuned out — which costs the real failures their audibility.
- **It must be actionable when it does fire.** "Pick it on the TV" is an instruction. "within
  120s (auto-switch: selected 'Demo' on the picker)" is a stack trace read to a person who
  is holding a card in front of a reader.

Keeping the diagnostic detail in the log loses nothing: nobody has ever debugged this from
the kitchen speaker.

## Evidence

> "it's announcing issues every time, but it didn't need to yesterday."

> "You don't need to announce the 120s thing either."

— Bob, 2026-07-26, on the morning's card taps after the announcement went live overnight.

> "And HOLY CRAP, it announced after the 120s thing was up too. It did 2 announcements.
> Once was enough. I don't need a second one 2 min later when I already knew it errored."

— Bob, 2026-07-27, on the first stalled scan after the 25s threshold shipped. Rule 3 is
this one; note that raising the threshold is what made the double audible, since at 6s the
pair had always fired together.

Applied in `queue_builder/service.py` (both gate errors) and, on
`automation.plex_channels_status_announcements`, in the `Waiting` trigger's `for:` (6s →
25s) plus a condition on the `Error` branch — both carrying `note:`s with the measurements
behind them.

The error-branch condition is duration math on `trigger.from_state`
(`(now() - trigger.from_state.last_changed).total_seconds() >= 25`) and the best-practice
checker flags it, suggesting a native `for:`. **Ignore that here:** `for:` on the `error`
trigger would gate on how long the *error* has persisted. What matters is how long the
*previous* state lasted at the instant of the transition, which no native construct
expresses.

---

## Amendment 2026-07-27: the predictive announcement is gone entirely

Rules 2 and 3 above are **superseded by a simpler one: announce only a real failure.**

The 25s threshold was measured against the ~18-21s menu path. It did not account for the
**force-stop recovery path, which takes ~40s** — so a scan that hit a snag, recovered by
itself, and played the right thing still got announced mid-recovery:

```
08:37:23  scan            08:37:45  force-stop      ~08:37:48  ANNOUNCED
08:37:58  profile picked  08:38:03  playing         (zero errors published)
```

Any threshold here is a *prediction* that a running scan will fail, and a prediction is
sometimes wrong. Being wrong means narrating a card tap that was about to work — which is
the exact complaint, now heard three times at three different thresholds (6s, 25s, and the
double). The `error` state is not a prediction: it publishes only after the 120s profile
wait genuinely expires. So the `Waiting` trigger and its branch are **removed**, and the
error branch's suppression condition with them.

**Cost, accepted:** no early warning. A genuinely stuck scan is silent for up to two
minutes. That is the price of never narrating a working one, and the user has consistently
chosen quiet over early.

> "It did work this time, but it _still_ errored and notified me of the error even though
> it ended up working in the end. […] I don't need the error announcement if it's working."

— Bob, 2026-07-27. (What he heard was the *waiting* announcement; no error was ever
published. That the two are indistinguishable from the kitchen is itself the argument.)

If an early warning is ever wanted back, set the threshold above the **slowest** success
path, not the typical one — and re-measure it whenever the escalation ladder changes.
