"""Detect which Plex Home profile the Shield's app is signed into, from the PMS log.

There is no API for "which profile is the Android TV app on right now": plex.tv's
per-device `lastSeenAt` only updates on playback (verified hours stale), and the
Companion endpoint doesn't expose the signed-in user. The one real-time signal is the
Plex server's own DEBUG log, which stamps every request it serves with the token's
profile:

    ... Request: [192.0.2.30:43248 (...)] GET /photo/... Signed-in Token (Younger Kids)

So: seek to the end of the log when the card is scanned, then watch for the first such
line from the Shield's IP. While the profile picker is on screen nothing is signed in and
no such line appears; the first one after launch IS the pick. If the app is already open
on a profile (no picker), foregrounding it refreshes the home hubs and produces lines for
the current profile - which is equally correct, since attribution follows sign-in state.

Fragility, accepted knowingly: the profile stamp only exists on DEBUG-level PMS log lines,
and this requires the Plex app's log volume mounted read-only into this container. If
Plex's debug logging is ever turned off, waits will time out and the state message says so.
"""
import os
import re
import time

from . import config

_LINE_RE = None

# The most recent profile the Shield was seen acting as, updated by every wait below.
# adb.switch_to uses it to skip its opening ~3.9s uiautomator dump: the picker always
# opens on the currently signed-in user, so this is a very good guess at where the
# selection starts. Only ever a HINT - the switcher still reads back after pressing, and
# nothing that clears a profile gate may be derived from it.
LAST_SEEN = {"title": None}


def _line_re():
    global _LINE_RE
    if _LINE_RE is None:
        ip = re.escape(config.SHIELD_IP)
        _LINE_RE = re.compile(r"\[" + ip + r":\d+[^\]]*\].*Signed-in Token \((.+?)\)")
    return _LINE_RE


def set_for_profile(title):
    """Map a Plex Home profile title to a set name, or None if unmapped."""
    return config.PROFILE_SET_MAP.get(title)


def wait_for_profile(timeout=None, cancel=None, poll=0.5, match=None):
    """Block until the Shield makes a PMS request under a signed-in profile.

    Tails config.PMS_LOG_PATH from its CURRENT end (only lines newer than the call
    count, so a scan never matches yesterday's viewing). Survives log rotation by
    reopening when the file shrinks or its inode changes. Returns the profile title,
    or None on timeout / cancel / unreadable log.

    With `match` set (a set's `requires_profile`), profiles OTHER than that one are
    skipped rather than returned, so the wait spans the on-screen profile switch: the
    caller blocks until the Shield is signed into the profile that can actually see the
    set's libraries. Without it, the FIRST signed-in profile wins (the `auto` cards,
    where whoever is signed in IS the answer).
    """
    timeout = config.PROFILE_WAIT_SECONDS if timeout is None else timeout
    deadline = time.monotonic() + timeout
    path = config.PMS_LOG_PATH
    try:
        f = open(path, "r", errors="replace")
    except OSError as e:
        print(f"[profiles] cannot open {path}: {e}", flush=True)
        return None
    try:
        f.seek(0, os.SEEK_END)
        ino = os.fstat(f.fileno()).st_ino
        while time.monotonic() < deadline:
            if cancel is not None and cancel.is_set():
                return None
            line = f.readline()
            if line:
                m = _line_re().search(line)
                if m:
                    title = m.group(1)
                    LAST_SEEN["title"] = title
                    if match is None or title == match:
                        return title
                    # Signed in, but as the wrong profile: keep waiting for the switch.
                    print(f"[profiles] saw '{title}', holding out for '{match}'", flush=True)
                continue
            # No new data: check for rotation/truncation before sleeping.
            try:
                st = os.stat(path)
                if st.st_ino != ino:
                    # Rotated: the new file's whole content is fresh - read from 0.
                    f.close()
                    f = open(path, "r", errors="replace")
                    ino = os.fstat(f.fileno()).st_ino
                elif st.st_size < f.tell():
                    f.seek(0)  # truncated in place
            except OSError:
                pass
            time.sleep(poll)
        return None
    finally:
        f.close()
