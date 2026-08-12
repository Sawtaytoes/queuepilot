# Design: playback as a state machine

> **Updated 2026-08-12.** The FSM now lives in `server/src/driver.js` (the Python `driver.py`
> this doc describes is deleted). The design below still holds; the tests are
> `e2e/playback-fsm-test.mjs` + `e2e/fsm-wake-and-skip-test.mjs`.

Status: **implemented behind the `PLAYBACK_FSM` flag** (default off) — `queue_builder/driver.py`
+ its wiring in `service._do_start`. The pre-FSM incremental version stays live and unchanged
until `PLAYBACK_FSM=true` is verified on the real Shield (see "Rollout" at the bottom). The
goal below is what "reliable, no manual babysitting" looks like.

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
- **Companion refused (Errno 111).** Plex was closed / mid-navigation when `playMedia` fired,
  so the Companion port (`SHIELD_IP:32500`) wasn't listening and the GET died with
  `URLError <urlopen error [Errno 111] Connection refused>` — the scan errored with nothing
  playing. Play was fired blind, assuming the launch/switch that ran before it had landed.
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

## What the FSM implements (`queue_builder/driver.py`, behind `PLAYBACK_FSM`)

`drive_to_playing(client, *, rating_keys, required_profile, offset, device, set_name, cancel,
set_label)` samples state and runs the transitions, reusing the `adb` / `profiles` / `playback`
primitives. `service._do_start` keeps ALL its selection logic and, when the flag is on, replaces
only the launch + profile gate + `_adb_switch_async` + join + `play_rating_keys` block with one
call to it. Each observed failure mode → how it's fixed:

0. **Device asleep — Plex never launches (the `device_on` transition).** `adb.ensure_plex_open`
   reads wakefulness (`adb.is_awake`, `dumpsys power`); when the Shield is dozing/screen-off (or
   the foreground reads unknown) it sends `KEYCODE_WAKEUP` and settles BEFORE `am start plex://`
   — a launch issued to a sleeping panel queues behind the screensaver and never foregrounds, so
   pre-fix a non-gated set (which has no later profile-step WAKEUP) never opened Plex at all.
   WAKEUP is safe to send blind and often restores Plex on its own (no launch needed). *(Fixed
   post-live-test, 2026-08-07.)*
1. **Companion refused (Errno 111).** `_drive_play` verifies Plex is foreground AND the
   Companion port is accepting a TCP connect (`playback.companion_ready`) *immediately before*
   `playMedia`; if either is false it `ensure_plex_open()`s + waits, and it RETRIES a
   connection-refused play a bounded few times (`PLAYBACK_FSM_PLAY_ATTEMPTS`), re-opening Plex
   between attempts. Play is the LAST action and it is verified. Client-mode only (cast doesn't
   use `:32500`). Confirmed zero Errno-111 across live runs.
2. **Destructive switch when already on the right profile.** `_drive_profile` reads the current
   profile from `profiles.LAST_SEEN` (alias-aware via `adb.same_profile`, so the picker's
   display name 'Bob Smith' == the username 'sawtaytoes' the log + `requires_profile` use)
   FIRST and, when it already matches `required`, is a no-op — it never summons or walks the
   picker. Only a real change drives `adb.switch_to`. **The cache is load-bearing:** the FSM
   gated path never calls `wait_for_profile`, so nothing else populates `LAST_SEEN` — a
   successful switch therefore RECORDS `required` into it so the next gated scan short-circuits
   with no picker flash (without this it walked the picker on every gated scan). *(Fixed
   post-live-test, 2026-08-07.)*
3. **Gate never clears when already signed in.** The gate is satisfied by a picker read-back
   (`switch_to` returning ok) OR `LAST_SEEN == required` — not solely a fresh PMS-log sign-in
   line. With ADB off it still falls back to `wait_for_profile`.
4. **Play raced the switch.** Play runs only after the profile transition has SETTLED (verified),
   never concurrently — the concurrent `_adb_switch_async` + join dance is gone on this path.
5. **Repeated scans.** The existing `cancel` event is threaded through every transition; a newer
   scan cancels and the machine returns `{"cancelled": True}` from wherever it was, and the new
   scan re-samples and converges (no blind restart).

On exhausting a transition's bounded retries it returns ONE spoken-sentence `error` (the
diagnostic detail is `print`ed to the log), matching
`docs/decisions/2026-07-26-spoken-status-is-a-sentence-not-a-diagnostic.md`.

## Still deferred

- Idempotent *mid-flight* re-entry beyond cancel-and-reconverge (the machine re-samples on the
  next scan, but does not yet hand a running transition off to a newer scan in place).
- (Explicitly deferred by the owner) **auto-discover** the Shield IP / client rather than
  reading it from `config.yaml`.

## Rollout

`PLAYBACK_FSM` defaults to **off** — `service._do_start` behaves exactly as before. Set
`PLAYBACK_FSM=true` (env, or `playback_fsm: true` is not read — it's env-only) to route scans
through the state machine. Verify on the real Shield first: tap a gated card while already on
the right profile (should play with no picker flash), a card while Plex is closed (should launch
then play), and a card mid-navigation (should not error with Errno 111). Tunables:
`PLAYBACK_FSM_PLAY_ATTEMPTS` (3), `PLAYBACK_FSM_SWITCH_ATTEMPTS` (2), `COMPANION_PORT` (32500),
`PLAYBACK_FSM_COMPANION_TIMEOUT` (1.5s), `PLAYBACK_FSM_RETRY_BACKOFF` (1.0s).
