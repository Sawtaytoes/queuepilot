# Design: playback as a state machine (proposed)

Status: proposed — captures the intended direction. The current code is a partial,
increment-by-increment version of this; the goal below is what "reliable, no manual
babysitting" looks like.

## The problem

A scan today is a mostly-open-loop sequence: publish `session/start`, foreground Plex (via
HA's `plex://` app link), wait for a PMS-log sign-in line, best-effort drive the ADB picker,
send `playMedia`. Each step assumes the prior one succeeded. When any link is degraded the
scan **errors out with no retry and nothing playing**, and — because the steps race — it can
also *start* a movie and then navigate away from it. Observed failure modes:

- HA's `plex://` app link doesn't fire (its AndroidTV-integration ADB auth lapsed) → Plex
  stays closed → Companion `:32500` never exists → `playMedia` has nowhere to land.
- The profile gate waits on a *fresh* PMS-log sign-in line that never comes when the Shield
  is already signed into the right profile → gate never clears → returns before playback.
- The ADB profile "switch" walks to the picker even when already on the correct profile,
  backing out of a movie that just started.
- Repeated scans cancel each other's waits; the net result is nondeterministic.

The through-line: the helper **acts blindly instead of reading state and reacting to it.**

## The model the helper should use

Before (and during) a scan, sample the real state of the target device, then drive it toward
`playing(target)` one transition at a time, each transition **verified and retried** rather
than fired and forgotten.

State to sample (all already reachable — ADB + Plex Companion/PMS + plex.tv):

| Dimension        | How to read it                                                        |
| ---------------- | --------------------------------------------------------------------- |
| Device power/on  | ADB reachable + `dumpsys power` / foreground activity exists          |
| Foreground app   | `adb shell dumpsys window mCurrentFocus` (launcher? Plex? other app?) |
| Plex app state   | Companion `:32500` open? foreground activity = Plex? which Activity?   |
| Active profile   | picker read-back (`selected_profile`) and/or PMS-log last sign-in      |
| Now-playing      | Companion / PMS session, or HA's mirrored `now-playing` MQTT topic     |

States → target `playing(set's next item, under required profile)`:

```
unreachable ──wake──▶ device_on
device_on ──launch plex://──▶ plex_foreground        (never force-stop if already up)
plex_foreground ─need switch?─▶ picker ──commit──▶ signed_in(required)
                └─already right profile─────────────▶ signed_in(required)
signed_in(required) ──playMedia──▶ playing(target)   (play is ALWAYS the last action)
```

Each edge:

- **verifies** it landed (read back the new state) before proceeding,
- **retries with backoff** a bounded number of times,
- **never destroys** progress it can't recover cheaply (don't force-stop a running movie;
  don't navigate away from `PlayerActivity` unless a real profile change is needed),
- emits a **specific** terminal error naming which transition failed (for the spoken
  status announcement) only after retries are exhausted.

The gate should be satisfied by *whatever* proves the profile — a picker read-back OR a log
line — not solely the log line. "Already on the right profile" is the common, fast path and
must be a no-op, not a picker walk.

## What already exists toward this (do not re-derive)

- `adb.ensure_plex_open()` — the `plex_foreground` transition (launch via `plex://`, verify
  foreground, don't force-stop). Wired at the top of `_do_start`.
- `service.py` joins the ADB switch thread before `playMedia` so **play is the last action**
  (kills the "started then backed out" race).
- `adb.summon_picker` / `switch_to` / `same_slot` — the picker transitions + display-name↔key
  aliasing already read back and self-correct; they are the seed of the verified-transition
  pattern.
- Host/deploy values resolve `env > /config/config.yaml > placeholder` (`config._hostval`).

## What's left to make it a real FSM

1. Sample **current profile without a destructive walk** (cache last picker read + PMS
   `LAST_SEEN`; only open the picker when a *change* is required).
2. A single **retry/backoff driver** wrapping each transition, replacing the scattered
   one-shot waits, so a transient failure self-heals instead of erroring the scan.
3. Treat a **picker read-back** as gate-satisfying (decouple from the fragile fresh-sign-in
   log dependency).
4. Idempotent re-entry: a second scan mid-flight should re-sample and converge, not just
   cancel the first and start blind.
5. (Later, explicitly deferred by the owner) **auto-discover** the Shield IP / client rather
   than reading it from `config.yaml`.
