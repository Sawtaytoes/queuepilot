#!/usr/bin/env python3
"""Gate tests for _do_start's Plex-profile handling. No Plex, no MQTT, no ADB.

The gate is the thing standing between "the right show" and "the right show billed to
the wrong kid", so it gets tests even though the rest of the service does not yet.
Drives the real `_do_start` against a synthetic PMS log, a fake MQTT client, and stubbed
plex/playback, then asserts on what got published.

Run:  python3 e2e/profile-gate-test.py     (from the repo root; exits non-zero on failure)
"""
import json
import os
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from queue_builder import config  # noqa: E402

LOG = tempfile.NamedTemporaryFile("w", suffix=".log", delete=False)
LOG.write("startup\n")
LOG.flush()
config.PMS_LOG_PATH = LOG.name
config.PROFILE_WAIT_SECONDS = 3
config.ADB_ENABLED = False
config.SHIELD_IP = "192.0.2.30"

from queue_builder import plex, playback, profiles, service  # noqa: E402

profiles._LINE_RE = None  # rebuild against the SHIELD_IP set above

# --- stubs: nothing may reach Plex or a real device -------------------------------
plex.build_rotation = lambda s, binding=None: [{"title": "Ep", "ratingKey": "1", "show": "S"}]
plex.pick_rewatch = lambda s, exclude_rating_key=None, binding=None: {"title": "M", "ratingKey": "2"}
plex.next_queue = lambda s: {"play": [{"title": "Q", "ratingKey": "3"}], "last": {}}
plex.build_reel = plex.next_queue
playback.play_rating_keys = lambda keys, set_name=None, device=None, offset=0: {"ok": True}
config.reload_sets = lambda: None

SETS = {
    # A v3 function channel: rotation source, real profiles[] bindings for both tiers.
    # has_explicit_profiles is what makes channel_for() route set:"auto" here instead of
    # falling back to the legacy PROFILE_SET_MAP tier sets.
    "shows_shorts": {"enabled": True, "source": "rotation", "behavior": "progress",
                     "label": "Shows & Shorts", "has_explicit_profiles": True,
                     "profiles": [{"plex_user": "Older Kids"}, {"plex_user": "Younger Kids"}]},
    "demo": {"enabled": True, "source": "queue", "reel": True, "label": "Demo Reel",
             "requires_profile": "Demo"},
}


class FakeClient:
    def __init__(self):
        self.msgs = []

    def publish(self, topic, payload, qos=0, retain=False):
        self.msgs.append((topic, json.loads(payload) if payload else {}))

    def states(self):
        return [m for t, m in self.msgs if t == config.T_STATE]

    def last_error(self):
        errs = [s.get("error") for s in self.states() if s.get("error")]
        return errs[-1] if errs else None

    def awaiting(self):
        return [s.get("awaiting") for s in self.states() if s.get("awaiting")]

    def played(self):
        return any(s.get("playback") for s in self.states())


def sign_in_as(profile, after=0.4):
    """Append a PMS log line attributing a request to `profile`, shortly from now."""
    def go():
        time.sleep(after)
        LOG.write(f"DEBUG - Request: [{config.SHIELD_IP}:44100 (...)] "
                  f"GET /photo/x Signed-in Token ({profile})\n")
        LOG.flush()
    threading.Thread(target=go, daemon=True).start()


def run(payload, signed_in_as=None):
    config.SETS = {k: dict(v) for k, v in SETS.items()}
    config.SET_ORDER = list(SETS)
    c = FakeClient()
    if signed_in_as:
        sign_in_as(signed_in_as)
    service._do_start(c, payload, threading.Event())
    return c


FAILURES = []


def check(name, cond, detail=""):
    print(f"{'ok  ' if cond else 'FAIL'}  {name}" + (f"  -- {detail}" if detail and not cond else ""))
    if not cond:
        FAILURES.append(name)


# 1. A card naming a profile must WAIT for that profile - not just trust the payload.
c = run({"set": "shows_shorts", "kind": "cartoons", "profile": "Younger Kids"})
check("card profile gates: does not play on a silent log", not c.played())
check("card profile gates: announces the wait",
      "profile:Younger Kids" in c.awaiting(), str(c.awaiting()))
check("card profile gates: names the profile in the error",
      c.last_error() and "Younger Kids" in c.last_error(), str(c.last_error()))

# 2. The WRONG profile signing in must not satisfy it (the mis-attribution case).
c = run({"set": "shows_shorts", "kind": "cartoons", "profile": "Younger Kids"},
        signed_in_as="Older Kids")
check("wrong profile does not clear the gate", not c.played(), str(c.states()))

# 3. The right profile signing in clears it and plays.
c = run({"set": "shows_shorts", "kind": "cartoons", "profile": "Younger Kids"},
        signed_in_as="Younger Kids")
check("right profile clears the gate and plays", c.played(), str(c.last_error()))

# 4. No profile on the card => rotation set stays ungated, exactly as before.
c = run({"set": "shows_shorts", "kind": "cartoons"})
check("ungated rotation set still plays with no profile", c.played(), str(c.last_error()))
check("ungated rotation set never announces a wait", not c.awaiting(), str(c.awaiting()))

# 5. requires_profile still works on its own.
c = run({"set": "demo", "kind": "movie"}, signed_in_as="Demo")
check("requires_profile clears on the required profile", c.played(), str(c.last_error()))
c = run({"set": "demo", "kind": "movie"}, signed_in_as="Older Kids")
check("requires_profile rejects the wrong profile", not c.played())

# 6. A card contradicting the set's requires_profile errors instead of guessing.
c = run({"set": "demo", "kind": "movie", "profile": "Younger Kids"})
check("card/set profile conflict is a clear error",
      c.last_error() and "requires" in c.last_error(), str(c.last_error()))
check("conflict does not play", not c.played())

# 7. set=auto is unchanged: the first signed-in profile decides the tier.
c = run({"set": "auto", "kind": "cartoons"}, signed_in_as="Older Kids")
check("auto still resolves the tier from the log", c.played(), str(c.last_error()))

os.unlink(LOG.name)
print()
if FAILURES:
    print(f"{len(FAILURES)} FAILED: {', '.join(FAILURES)}")
    sys.exit(1)
print("all profile-gate checks passed")
