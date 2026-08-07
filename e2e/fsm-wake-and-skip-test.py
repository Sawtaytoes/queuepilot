#!/usr/bin/env python3
"""Follow-up unit tests for two FSM bugs found on the real Shield. No Plex, no MQTT, no ADB,
no network — the adb / profiles / playback primitives are stubbed.

Bug 1 — dozing Shield not woken before launch. `adb.ensure_plex_open` did `am start plex://`
        on a sleeping device, which does NOT foreground Plex, so the launch failed until
        something else sent a WAKEUP. FIX: the device_on transition — wake FIRST when the
        Shield isn't awake (or the foreground is unknown), then launch.

Bug 2 — picker walked even when already on the required profile. `_drive_profile`'s
        "already on required -> skip" never had data: the FSM gated path never populated
        `profiles.LAST_SEEN`, so the alias-aware skip couldn't fire and the picker was walked
        on every gated scan. FIX: an alias-aware skip (display-name 'Bob Smith' ==
        username 'sawtaytoes') AND recording the confirmed profile into LAST_SEEN after a
        switch, so subsequent gated scans short-circuit with NO picker.

Run:  python3 e2e/fsm-wake-and-skip-test.py     (from the repo root; exits non-zero on failure)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from queue_builder import adb, config, driver, profiles  # noqa: E402

FAILS = []


def ok(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  -- {detail}" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


# =========================================================================== #
# Bug 1 — ensure_plex_open wakes a dozing Shield BEFORE launching Plex
# =========================================================================== #
# Record every low-level adb call in order so we can assert WAKEUP precedes `am start`.
def make_adb_env(awake, foreground_sequence):
    order = []
    seq = iter(foreground_sequence)
    last = {"v": foreground_sequence[-1] if foreground_sequence else None}

    def _run(args, timeout=None):
        if args[:2] == ["shell", "am"] or (len(args) > 1 and args[0] == "shell"
                                           and args[1].startswith("am ")):
            pass
        # am start plex://
        if args[0] == "shell" and "am" in args and "start" in args:
            order.append("launch")
            return ""  # non-None -> "issued"
        return ""

    def foreground_activity():
        try:
            last["v"] = next(seq)
        except StopIteration:
            pass
        return last["v"]

    def is_awake():
        return awake

    def _press(*keycodes, settle=0.0):
        if "KEYCODE_WAKEUP" in keycodes:
            order.append("wake")
        return True

    adb.connect = lambda: True
    adb._run = _run
    adb.foreground_activity = foreground_activity
    adb.is_awake = is_awake
    adb._press = _press
    adb._WAKE_SETTLE = 0  # no real sleep in the test
    config.ADB_PLEX_LAUNCH_WAIT_SECONDS = 2
    return order


# Asleep/dozing: foreground reads null, then null after wake, then Plex once launched.
_PLEX = "com.plexapp.android/.HomeActivityTV"
order = make_adb_env(awake=False, foreground_sequence=[None, None, _PLEX])
res = adb.ensure_plex_open()
ok("(bug1) asleep: WAKEUP is sent", "wake" in order)
ok("(bug1) asleep: launch happens", "launch" in order)
ok("(bug1) asleep: WAKEUP is sent BEFORE the plex:// launch",
   "wake" in order and "launch" in order and order.index("wake") < order.index("launch"),
   str(order))
ok("(bug1) asleep: ends foreground on Plex -> True", res is True)

# Wake alone brings Plex back (screensaver was over Plex): no launch needed.
order = make_adb_env(awake=False, foreground_sequence=[None, _PLEX])
res = adb.ensure_plex_open()
ok("(bug1) asleep-over-plex: wakes and returns True without launching",
   "wake" in order and "launch" not in order and res is True, str(order))

# Awake on the launcher: no needless WAKEUP, straight to launch.
order = make_adb_env(awake=True, foreground_sequence=["com.google.android.tvlauncher/.X", _PLEX])
res = adb.ensure_plex_open()
ok("(bug1) awake-on-launcher: does NOT send a needless WAKEUP", "wake" not in order, str(order))
ok("(bug1) awake-on-launcher: launches and returns True", "launch" in order and res is True)

# Already on Plex: returns immediately, no wake, no launch.
order = make_adb_env(awake=True, foreground_sequence=[_PLEX])
res = adb.ensure_plex_open()
ok("(bug1) already-on-plex: no wake, no launch, True",
   order == [] and res is True, str(order))


# =========================================================================== #
# Bug 2 — _drive_profile skips the picker when already on `required` (alias-aware),
#         and records the confirmed profile so the NEXT scan skips too.
# =========================================================================== #
SWITCHES = []


def wire_driver(alias_groups=(), switch_ok=True):
    """Stub adb.same_profile / adb.switch_to for the driver; count switch_to calls."""
    SWITCHES.clear()
    config.ADB_ENABLED = True
    config.PLAYBACK_FSM_SWITCH_ATTEMPTS = 2
    config.PLAYBACK_FSM_RETRY_BACKOFF = 0

    groups = [set(g) for g in alias_groups]

    def same_profile(a, b):
        if a == b:
            return True
        for g in groups:
            if a in g and b in g:
                return True
        return False

    def switch_to(target, cancel=None, known_current=None):
        SWITCHES.append((target, known_current))
        return (switch_ok, "selected on the picker" if switch_ok else "ran out of time")

    adb.same_profile = same_profile
    adb.switch_to = switch_to


# (a) LAST_SEEN == required exactly -> no picker walk.
wire_driver()
profiles.LAST_SEEN["title"] = "sawtaytoes"
r = driver._drive_profile(None, "sawtaytoes", None)
ok("(bug2a) exact LAST_SEEN==required: gate satisfied (None)", r is None)
ok("(bug2a) exact LAST_SEEN==required: NO switch_to call", len(SWITCHES) == 0, str(SWITCHES))

# (b) LAST_SEEN is the DISPLAY name, required the USERNAME — alias must short-circuit.
wire_driver(alias_groups=[{"Bob Smith", "sawtaytoes"}])
profiles.LAST_SEEN["title"] = "Bob Smith"
r = driver._drive_profile(None, "sawtaytoes", None)
ok("(bug2b) display-name==username alias: gate satisfied (None)", r is None)
ok("(bug2b) display-name==username alias: NO picker/switch call", len(SWITCHES) == 0, str(SWITCHES))

# (c) A real change: LAST_SEEN cold (None) -> switch once, and LAST_SEEN is then RECORDED as
#     `required` so an immediate second call short-circuits with no further switch.
wire_driver(alias_groups=[{"Bob Smith", "sawtaytoes"}], switch_ok=True)
profiles.LAST_SEEN["title"] = None
r1 = driver._drive_profile(None, "sawtaytoes", None)
ok("(bug2c) cold cache: switch runs once", r1 is None and len(SWITCHES) == 1, str(SWITCHES))
ok("(bug2c) switch records the profile into LAST_SEEN",
   profiles.LAST_SEEN.get("title") == "sawtaytoes", str(profiles.LAST_SEEN))
r2 = driver._drive_profile(None, "sawtaytoes", None)
ok("(bug2c) second gated scan short-circuits: still only ONE switch total",
   r2 is None and len(SWITCHES) == 1, str(SWITCHES))

# (d) Cold cache + a DIFFERENT signed-in profile -> a real switch is still driven.
wire_driver(alias_groups=[{"Bob Smith", "sawtaytoes"}, {"Younger Kids"}])
profiles.LAST_SEEN["title"] = "Younger Kids"  # signed in as someone else
r = driver._drive_profile(None, "sawtaytoes", None)
ok("(bug2d) genuinely-wrong profile: drives the switch once", r is None and len(SWITCHES) == 1,
   str(SWITCHES))


print(f"\nFAILURES: {len(FAILS)}" if FAILS else "\ndone")
sys.exit(1 if FAILS else 0)
