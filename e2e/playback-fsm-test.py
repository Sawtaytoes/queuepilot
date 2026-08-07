#!/usr/bin/env python3
"""Unit tests for the playback state machine (queue_builder/driver.py). No Plex, no MQTT,
no ADB, no network — every adb / profiles / playback primitive is stubbed, so this drives
driver.drive_to_playing directly and asserts the VERIFIED, RETRIED, NON-DESTRUCTIVE
transitions the design doc promises.

Covers each observed-live failure mode / acceptance criterion:
  (a) already on the right profile + Plex open  -> NO picker walk, plays once
  (b) Plex closed                               -> launches then plays
  (c) Companion refused once (Errno 111)        -> re-open + retry -> plays
  (d) a real profile change is needed           -> switch then play
  (e) cancel mid-flight                          -> aborts cleanly, never plays
  (f) a transition's bounded retries exhaust     -> single spoken-sentence error

Run:  python3 e2e/playback-fsm-test.py     (from the repo root; exits non-zero on failure)
"""
import os
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from queue_builder import adb, config, driver, playback, profiles  # noqa: E402

FAILS = []


def ok(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  -- {detail}" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


# --------------------------------------------------------------------------- #
# A recording test double for every primitive the driver reaches for. Each test
# sets up scripted return values / call logs, then inspects CALLS afterwards.
# --------------------------------------------------------------------------- #
CALLS = []


class Env:
    """Reset all stubs + config knobs to a known baseline before each scenario."""

    def __init__(self):
        CALLS.clear()
        profiles.LAST_SEEN["title"] = None
        config.PLAYBACK_MODE = "client"
        config.ADB_ENABLED = True
        config.SHIELD_IP = "192.0.2.30"
        config.COMPANION_PORT = 32500
        config.SHIELD_CLIENT_URI = ""
        config.PLAYBACK_FSM_PLAY_ATTEMPTS = 3
        config.PLAYBACK_FSM_SWITCH_ATTEMPTS = 2
        config.PLAYBACK_FSM_RETRY_BACKOFF = 0  # no real sleeps in tests
        # Defaults — a scenario overrides what it cares about.
        self.foreground = "com.plexapp.android/.PlayerActivity"  # Plex up by default
        self.companion_up = True
        self.switch_result = (True, "selected on the picker")
        self.same = {}                 # (a, b) -> bool overrides for same_profile
        self.play_results = [{"queued": 1, "played": True, "mode": "client", "client": "SHIELD"}]
        self._wire()

    def _wire(self):
        env = self

        def foreground_activity():
            CALLS.append(("foreground_activity",))
            return env.foreground

        def ensure_plex_open(wait=None):
            CALLS.append(("ensure_plex_open",))
            env.foreground = "com.plexapp.android/.HomeActivityTV"
            env.companion_up = True   # opening Plex brings the Companion port up
            return True

        def same_profile(a, b):
            CALLS.append(("same_profile", a, b))
            if (a, b) in env.same:
                return env.same[(a, b)]
            return a == b

        def switch_to(target, cancel=None, known_current=None):
            CALLS.append(("switch_to", target, known_current))
            return env.switch_result

        def wait_for_profile(timeout=None, cancel=None, poll=0.5, match=None):
            CALLS.append(("wait_for_profile", match))
            return match  # signed in as requested, by default

        def companion_ready(host=None, port=None, timeout=None):
            CALLS.append(("companion_ready", host, port))
            return env.companion_up

        def play_rating_keys(rating_keys, set_name=None, device=None, offset=0):
            CALLS.append(("play", tuple(rating_keys), offset))
            # Pop the next scripted result; the last one repeats if attempts exceed the list.
            return env.play_results[min(len([c for c in CALLS if c[0] == "play"]) - 1,
                                        len(env.play_results) - 1)]

        adb.foreground_activity = foreground_activity
        adb.ensure_plex_open = ensure_plex_open
        adb.same_profile = same_profile
        adb.switch_to = switch_to
        profiles.wait_for_profile = wait_for_profile
        playback.companion_ready = companion_ready
        playback.play_rating_keys = play_rating_keys


def n_calls(name):
    return len([c for c in CALLS if c[0] == name])


def drive(**kw):
    kw.setdefault("rating_keys", ["100"])
    kw.setdefault("required_profile", None)
    kw.setdefault("offset", 0)
    kw.setdefault("device", {"mode": "client"})
    kw.setdefault("set_name", "demo")
    kw.setdefault("cancel", None)
    return driver.drive_to_playing(None, **kw)


# --------------------------------------------------------------------------- #
# (a) Already on the right profile + Plex open -> NO picker walk, plays once
# --------------------------------------------------------------------------- #
env = Env()
profiles.LAST_SEEN["title"] = "Younger Kids"
res = drive(required_profile="Younger Kids")
ok("(a) already-on-profile: plays and reports played", res.get("played") is True)
ok("(a) already-on-profile: NEVER walks the picker (no switch_to)", n_calls("switch_to") == 0)
ok("(a) already-on-profile: plays exactly once", n_calls("play") == 1)

# --------------------------------------------------------------------------- #
# (b) Plex closed -> launches (ensure_plex_open) then plays
# --------------------------------------------------------------------------- #
env = Env()
env.foreground = "com.google.android.tvlauncher/.MainActivity"  # on the launcher, Plex closed
env.companion_up = False  # ... and the Companion port is down until Plex opens
res = drive()
ok("(b) plex-closed: opens Plex before playing", n_calls("ensure_plex_open") >= 1)
ok("(b) plex-closed: play still succeeds", res.get("played") is True)

# --------------------------------------------------------------------------- #
# (c) Companion refused once (Errno 111) -> re-open + retry -> plays
# --------------------------------------------------------------------------- #
env = Env()
refused = {"queued": 1, "played": False, "mode": "client", "client": "SHIELD",
           "error": "URLError: <urlopen error [Errno 111] Connection refused>"}
played = {"queued": 1, "played": True, "mode": "client", "client": "SHIELD"}
env.play_results = [refused, played]  # first attempt refused, second succeeds
res = drive()
ok("(c) companion-refused: retries and eventually plays", res.get("played") is True)
ok("(c) companion-refused: play was attempted twice", n_calls("play") == 2)
ok("(c) companion-refused: re-opened Plex between attempts", n_calls("ensure_plex_open") >= 1)

# --------------------------------------------------------------------------- #
# (d) A real profile change is needed -> switch then play
# --------------------------------------------------------------------------- #
env = Env()
profiles.LAST_SEEN["title"] = "Younger Kids"          # signed in as the WRONG profile
env.same = {("Younger Kids", "Demo"): False}          # not the same slot -> a real change
res = drive(required_profile="Demo")
ok("(d) profile-change: drives the picker exactly once", n_calls("switch_to") == 1)
ok("(d) profile-change: switch happens BEFORE play",
   [c[0] for c in CALLS].index("switch_to") < [c[0] for c in CALLS].index("play"))
ok("(d) profile-change: plays after the switch settles", res.get("played") is True)

# --------------------------------------------------------------------------- #
# (e) Cancel mid-flight -> aborts cleanly, never plays
# --------------------------------------------------------------------------- #
env = Env()
cancel = threading.Event()
cancel.set()  # a newer scan already cancelled this one before it started driving
res = drive(cancel=cancel)
ok("(e) cancel: returns cancelled", res.get("cancelled") is True)
ok("(e) cancel: never fires play", n_calls("play") == 0)

# Cancel that lands DURING the switch retries (switch keeps failing; cancel set after).
env = Env()
profiles.LAST_SEEN["title"] = "Younger Kids"
env.same = {("Younger Kids", "Demo"): False}
env.switch_result = (False, "ran out of time")
cancel = threading.Event()
_orig_switch = adb.switch_to


def _switch_then_cancel(target, cancel_ev=None, known_current=None, **_):
    CALLS.append(("switch_to", target, known_current))
    cancel.set()  # a newer scan arrives mid-switch
    return (False, "ran out of time")


adb.switch_to = _switch_then_cancel
res = drive(required_profile="Demo", cancel=cancel)
ok("(e) cancel mid-switch: aborts cleanly", res.get("cancelled") is True)
ok("(e) cancel mid-switch: never fires play", n_calls("play") == 0)

# --------------------------------------------------------------------------- #
# (f) A transition's bounded retries exhaust -> ONE spoken-sentence error
# --------------------------------------------------------------------------- #
# f1: the switch never lands -> the profile-gate spoken sentence, with the set label filled in.
env = Env()
profiles.LAST_SEEN["title"] = "Younger Kids"
env.same = {("Younger Kids", "Demo"): False}
env.switch_result = (False, "ran out of time after 12 presses")
res = drive(required_profile="Demo", set_label="Demo Reel")
ok("(f) switch-exhausted: returns an error, not a crash", bool(res.get("error")))
ok("(f) switch-exhausted: spoken sentence names the profile + set, ends with an instruction",
   res.get("error") == "'Demo Reel' needs the 'Demo' Plex profile, and the Shield did not "
                       "switch to it. Pick it on the TV.", res.get("error"))
ok("(f) switch-exhausted: NEVER plays after a failed gate", n_calls("play") == 0)
ok("(f) switch-exhausted: honored the bounded switch attempts (2)", n_calls("switch_to") == 2)
ok("(f) switch-exhausted: no diagnostic jargon in the spoken sentence",
   "presses" not in res.get("error", "") and "timeout" not in res.get("error", "").lower())

# f2: the Companion stays refused for every attempt -> the play spoken sentence.
env = Env()
env.play_results = [refused]  # always refused
config.PLAYBACK_FSM_PLAY_ATTEMPTS = 3
res = drive()
ok("(f) play-exhausted: returns the spoken play error",
   res.get("error") == "Plex wasn't ready to play on the Shield. Try the card again.",
   res.get("error"))
ok("(f) play-exhausted: tried the bounded number of times (3)", n_calls("play") == 3)

# --------------------------------------------------------------------------- #
# Extra: cast mode skips the Companion-refusal loop entirely (it's :32500-specific).
# --------------------------------------------------------------------------- #
env = Env()
config.PLAYBACK_MODE = "cast"
res = drive(device={"mode": "cast"})
ok("cast mode: plays once, no Companion probe", res.get("played") is True and n_calls("companion_ready") == 0)

# Extra: a non-connection play error (HTTP) is surfaced as-is, not retried (Plex answered).
env = Env()
env.play_results = [{"queued": 1, "played": False, "mode": "client", "error": "playMedia HTTP 500"}]
res = drive()
ok("http error: surfaced as-is (not a spoken retry error)", res.get("error") == "playMedia HTTP 500")
ok("http error: not retried (Plex answered)", n_calls("play") == 1)


print(f"\nFAILURES: {len(FAILS)}" if FAILS else "\ndone")
sys.exit(1 if FAILS else 0)
