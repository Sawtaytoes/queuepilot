"""Drive the Shield's Plex profile picker over ADB, so a gated card can switch itself.

`requires_profile` (and, since this change, a card's explicit `profile`) blocks a scan
until the Shield is signed into the right Plex Home profile. Without ADB the only way to
satisfy that gate is a human walking to the TV and picking the profile. This module
closes the loop: read the picker, press D-pad toward the target, commit.

**The ADB press is never proof.** `uiautomator dump` reports what is on SCREEN, not who
is signed IN - those are different questions, and only the PMS log answers the second
(see profiles.py). So this module's job ends at "I pressed center on the right tile";
`profiles.wait_for_profile(match=...)` remains the sole thing that clears a gate. A
failure here is therefore never fatal - it just falls back to waiting for a human.

Safety, because this injects key events into whatever is on the family TV:

* Off unless `ADB_ENABLED`.
* Every press batch is guarded by BOTH the foreground activity being Plex's
  `PickUserActivity` AND a named selected tile being present in the dump. The picker is
  transient - it vanishes the moment a profile is chosen - and pressing D-pad after that
  injects into whatever Plex screen came up.
* The press loop is hard-bounded (`ADB_MAX_PRESSES`) and bails the moment a press stops
  moving the selection, which is how a non-wrapping end of the list shows up.

Reading the selection: the dump carries several tiles, but only the selected one exposes
its NAME, as a `com.plexapp.android:id/title_text` TextView. Roughly a dozen nodes carry
`selected="true"` (it propagates down the selected tile's subtree), so the title_text
resource-id is the anchor, not the selected attribute alone. The RecyclerView is
virtualised, so the full profile list is NOT readable from a dump - hence `profile_order()`
derives it from plex.tv instead, always verified by read-back.

Speed: `uiautomator dump` costs ~1.9s here and every other adb call is under 50ms, while
`input` costs ~700ms per invocation regardless of how many keycodes it carries. So the
whole design is "batch every press into one `input` call, and dump as rarely as possible".
"""
import json
import os
import re
import subprocess
import time
import xml.etree.ElementTree as ET

from . import config

_PICKER_ACTIVITY = "PickUserActivity"
_HOME_ACTIVITY = "HomeActivityTV"
_MODAL_ACTIVITY = "ListDualPaneModalActivity"
_PLEX_PKG = "com.plexapp.android"
_TITLE_ID = f"{_PLEX_PKG}:id/title_text"
_DUMP_PATH = "/sdcard/plex-channels-ui.xml"
# How many BACK presses to spend getting from a player/detail screen to Home.
_MAX_BACKS = 3
# The recycler animates the scroll; read back too fast and you sample mid-flight. Kept
# short because the ~1.9s dump that usually follows is itself far more settling time than
# the UI needs.
_SETTLE = 0.35
# HomeActivityTV goes foreground before its hubs can take a D-pad press. Hold still this
# long before walking the sidebar, or the presses land on a screen that is still rendering.
_HOME_SETTLE = 2.0
# How long to let the panel come up after a WAKEUP before re-reading the foreground. A wake
# takes ~1s to settle; a launch issued before then lands behind the still-dissolving dream.
_WAKE_SETTLE = 1.0
# Attempts at Plex's own Switch-user route before falling back to a force-stop. Two,
# because the force-stop kills playback and costs ~20s, while a retry costs ~10s.
_MAX_MENU_TRIES = 2


def _env():
    """Point adb at the key the Shield already trusts.

    A key adb generates itself would be unauthorized, and accepting it needs an on-TV
    prompt nobody is there to answer - so the authorized private key is mounted at
    ADB_KEY_PATH instead.

    Getting adb to actually READ it takes all three of these. adb 1.0.41 (Debian trixie)
    ignores ANDROID_USER_HOME and derives its key dir from $HOME - which is unset for the
    container's 568:568 user, so it tries to mkdir '//.android' and dies before it ever
    connects. HOME is therefore the load-bearing one; the other two cover newer adb
    builds and a key kept somewhere other than <HOME>/.android.
    """
    env = dict(os.environ)
    key = config.ADB_KEY_PATH
    if key and os.path.exists(key):
        key_dir = os.path.dirname(key)
        env["HOME"] = os.path.dirname(key_dir)
        env["ANDROID_USER_HOME"] = key_dir
        env["ADB_VENDOR_KEYS"] = key
    return env


def _run(args, timeout=None):
    """Run an adb command. Returns stdout on success, None on any failure."""
    cmd = [config.ADB_BIN, "-s", config.ADB_TARGET] + list(args)
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, env=_env(),
                           timeout=config.ADB_TIMEOUT if timeout is None else timeout)
    except (OSError, subprocess.TimeoutExpired) as e:
        print(f"[adb] {' '.join(args)}: {e}", flush=True)
        return None
    if p.returncode != 0:
        print(f"[adb] {' '.join(args)}: rc={p.returncode} {p.stderr.strip()[:200]}", flush=True)
        return None
    return p.stdout


def connect():
    """Idempotent - 'already connected' is success. Returns True if the device is up."""
    try:
        subprocess.run([config.ADB_BIN, "connect", config.ADB_TARGET],
                       capture_output=True, text=True, env=_env(), timeout=config.ADB_TIMEOUT)
    except (OSError, subprocess.TimeoutExpired) as e:
        print(f"[adb] connect {config.ADB_TARGET}: {e}", flush=True)
        return False
    out = _run(["get-state"])
    return bool(out and out.strip() == "device")


def foreground_activity():
    """The focused window's component, e.g. 'com.plexapp.android/...PickUserActivity'."""
    # No `grep -m1`: closing the pipe early makes dumpsys fail with a broken pipe, which
    # would surface as a command failure. Let it finish and take the first match here.
    out = _run(["shell", "dumpsys window | grep mCurrentFocus"])
    if not out:
        return None
    m = re.search(r"(\S+/\S+)\}", out)
    return m.group(1) if m else None


def is_awake():
    """True if the Shield's display is awake, False if dozing/asleep, None if unreadable.

    Reads `dumpsys power` wakefulness (Awake / Dozing / Asleep / Dreaming) so ensure_plex_open
    can decide whether a WAKEUP must precede the Plex launch. No `grep -m1` (closing the pipe
    early makes dumpsys fail with a broken pipe); take the first match here. A None (unreadable)
    is treated by the caller as "not known-awake", i.e. wake to be safe.
    """
    out = _run(["shell", "dumpsys power | grep mWakefulness"])
    if not out:
        return None
    m = re.search(r"mWakefulness=(\w+)", out)
    if not m:
        return None
    return m.group(1).strip().lower() == "awake"


def ensure_plex_open(wait=None):
    """Foreground the Shield's Plex app via its `plex://` deep link if it isn't already up.

    This is the reliable launch path for when HA's own `plex://` app link doesn't fire (an
    Android TV remote integration that has lost its adb authorization launches nothing, and
    the Shield just sits on its launcher). Companion playback (:32500) AND the profile
    picker both need Plex running, so this has to succeed before either can.

    Unlike restart_to_picker() this NEVER force-stops: if Plex is already foreground
    (playing or on Home) it is left untouched, so a running movie is never interrupted.
    Best-effort — returns True if Plex is (now) foreground, False if ADB is unreachable or
    Plex didn't come up in time (the caller still tries; HA may have launched it).
    """
    if not connect():
        return False
    act = foreground_activity() or ""
    if _PLEX_PKG in act:
        return True
    # device_on transition: a dozing / screen-off Shield reports a null or screensaver
    # foreground, and `am start plex://` on a SLEEPING device does not bring Plex forward -
    # the launch queues behind the dream, so ensure_plex_open used to log "launching via
    # plex://" -> "Plex did not reach the foreground in time" on every retry until something
    # else happened to wake the panel (e.g. the profile step's WAKEUP). For a non-gated set
    # nothing else wakes it, so Plex never opens. WAKEUP is safe to send blind (it cannot
    # select or dismiss anything) and restores whatever was up behind the screensaver, so
    # wake FIRST when the device isn't already awake, then re-read (the wake alone may have
    # brought Plex back to the foreground).
    if is_awake() is not True or not act:
        print(f"[adb] Shield not awake (foreground '{act or 'unknown'}'); sending WAKEUP",
              flush=True)
        _press("KEYCODE_WAKEUP")
        time.sleep(_WAKE_SETTLE)
        act = foreground_activity() or ""
        if _PLEX_PKG in act:
            print("[adb] Plex is foreground after waking the Shield", flush=True)
            return True
    print(f"[adb] Plex not foreground (on '{act or 'unknown'}'); launching via plex://",
          flush=True)
    if _run(["shell", "am", "start", "-a", "android.intent.action.VIEW",
             "-d", "plex://"]) is None:
        return False
    deadline = time.monotonic() + (
        wait if wait is not None else config.ADB_PLEX_LAUNCH_WAIT_SECONDS)
    while time.monotonic() < deadline:
        if _PLEX_PKG in (foreground_activity() or ""):
            print("[adb] Plex is foreground", flush=True)
            return True
        time.sleep(0.5)
    print("[adb] Plex did not reach the foreground in time", flush=True)
    return False


def _dump():
    """The screen's UI hierarchy as an ElementTree root, or None.

    `uiautomator dump` costs ~1.9s on this Shield while every other adb call is under
    50ms, so it is THE cost of a switch — call it as few times as possible. Dump and cat
    are one shell invocation to save a round trip; `--compressed` is not faster and drops
    the title_text nodes we need, so don't reach for it.
    """
    xml = _run(["shell", f"uiautomator dump {_DUMP_PATH} >/dev/null && cat {_DUMP_PATH}"])
    if not xml:
        return None
    try:
        return ET.fromstring(xml.replace("\r", "").strip())
    except ET.ParseError as e:
        print(f"[adb] unparseable uiautomator dump: {e}", flush=True)
        return None


def selected_profile():
    """The NAME on the currently-highlighted picker tile, or None if not on the picker.

    None means "do not press" - either the dump failed, or the picker is gone.
    """
    root = _dump()
    if root is None:
        return None
    for node in root.iter("node"):
        if (node.get("resource-id") == _TITLE_ID
                and node.get("selected") == "true"
                and (node.get("text") or "").strip()):
            return node.get("text").strip()
    return None


def picker_ready(known=None):
    """(is_ready, selected_name). Both conditions must hold before ANY press.

    `known` skips the ~1.9s dump by trusting a caller-supplied guess at the selection
    (see profiles.LAST_SEEN). Safe only because every caller reads back after pressing.
    """
    act = foreground_activity()
    if not act or _PLEX_PKG not in act or _PICKER_ACTIVITY not in act:
        return False, None
    if known:
        return True, known
    name = selected_profile()
    return (name is not None), name


def _press(*keycodes, settle=0.0):
    """Send key events in ONE `input` call. Pass `(code, n)` to repeat a code n times.

    `settle` is only needed when the NEXT thing done is another press that depends on the
    UI having caught up. When a ~1.9s dump follows, that is already far more settling than
    the UI needs, so the default is not to sleep at all.

    `input` costs ~700ms of JVM startup per invocation and only ~1ms per extra keycode,
    so batching is worth roughly 700ms per press saved. Verified reliable across the
    picker's virtualised scroll: batched 5-press moves landed exactly right 3/3 in both
    directions, with no per-press delay.
    """
    keys = []
    for k in keycodes:
        if isinstance(k, tuple):
            keys.extend([k[0]] * k[1])
        else:
            keys.append(k)
    if not keys:
        return True
    if _run(["shell", "input", "keyevent"] + keys) is None:
        return False
    if settle:
        time.sleep(settle)
    return True


_ORDER = {"titles": None, "at": 0.0}


def _as_groups(order):
    """Normalise an order to alias GROUPS, accepting the old flat list of names.

    A cache written before aliases existed (or a hand-set ADB_PROFILE_ORDER env) is a
    flat ["Bob Smith", ...]; both forms have to keep working.
    """
    return [[g] if isinstance(g, str) else list(g) for g in (order or [])]


def profile_order():
    """Picker order, newest-first by source: manual override > plex.tv > disk cache.

    Returns a list of ALIAS GROUPS (see plex.home_user_names) - one group per picker
    slot, in picker order - because the picker and plex.tv disagree on what to call the
    owner. Match with `_index`, never `in`.

    plex.tv's `/api/v2/home/users` order IS the picker's order, so deriving it beats
    hand-maintaining an env var that goes stale the moment a Home user is added or
    removed. Cached to disk because the Shield and this service can be up while plex.tv
    is not, and a stale order still beats no order (the read-back would catch it).

    Returns [] if every source fails - callers must treat that as "cannot compute a
    direction" rather than guessing.
    """
    if config.ADB_PROFILE_ORDER:
        return _as_groups(config.ADB_PROFILE_ORDER)
    now = time.monotonic()
    if _ORDER["titles"] and now - _ORDER["at"] < config.ADB_PROFILE_ORDER_TTL:
        return _ORDER["titles"]
    from . import plex  # local import: adb must stay importable without a Plex reachable
    try:
        names = plex.home_user_names()
    except Exception as e:  # noqa: BLE001 — plex.tv outage is exactly what the cache is for
        print(f"[adb] plex.tv home users unavailable ({e}); using cached order", flush=True)
        names = []
    if names:
        _ORDER["titles"], _ORDER["at"] = names, now
        try:
            with open(config.ADB_PROFILE_ORDER_CACHE, "w") as f:
                json.dump(names, f)
        except OSError as e:
            print(f"[adb] could not cache the picker order: {e}", flush=True)
        return names
    if _ORDER["titles"]:
        return _ORDER["titles"]
    try:
        with open(config.ADB_PROFILE_ORDER_CACHE) as f:
            cached = _as_groups(json.load(f))
        if cached:
            _ORDER["titles"] = cached
            return cached
    except (OSError, ValueError):
        pass
    return []


def _index(order, name):
    """Position of the picker slot `name` refers to, by any alias, or None."""
    for i, group in enumerate(order):
        if name in group:
            return i
    return None


def same_profile(a, b):
    """Do two names refer to the same picker slot? Falls back to string equality.

    The gate's `requires_profile` is the PMS log's string and the dump reads the picker
    tile's; for the owner those differ ('sawtaytoes' vs 'Bob Smith'), so comparing
    them with == would leave switch_to pressing forever, never satisfied.
    """
    if a == b:
        return True
    if not a or not b:
        return False
    order = profile_order()
    ia, ib = _index(order, a), _index(order, b)
    return ia is not None and ia == ib


def _offset(current, target):
    """Signed press count from current to target, or None if either is unknown.

    Fast path only. The list is NOT assumed to wrap - a shorter wrap-around route is
    never taken, because whether the picker wraps at the ends is unverified.
    """
    order = profile_order()
    i_cur, i_tgt = _index(order, current), _index(order, target)
    if i_cur is None or i_tgt is None:
        return None
    return i_tgt - i_cur


def _wait_activity(fragment, timeout=8.0, poll=0.2):
    """Poll until the foreground activity contains `fragment`. Returns True if it did."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        act = foreground_activity() or ""
        if fragment in act:
            return True
        time.sleep(poll)
    return False


def picker_via_menu(attempt=1):
    """Walk Plex's own "Switch user" path back to the picker. Returns True on success.

    Signing in dismisses the picker for good - foregrounding Plex again lands on
    HomeActivityTV, so a card wanting a different profile would otherwise have nothing to
    drive. Plex's sidebar has the current user pinned at the top; opening it gives a modal
    whose first entry is "Switch user", which reopens the picker.

    Verified 2026-07-26: LEFT (open sidebar) -> UP to the pinned user -> CENTER ->
    ListDualPaneModalActivity -> CENTER on "Switch user" -> PickUserActivity.

    Preferred over a force-stop because it does not kill what Plex is playing. Every step
    is verified before the next, so a Plex UI change stalls this out rather than blindly
    injecting D-pad presses into some other screen.
    """
    print(f"[adb] signed in with no picker; trying Plex's own Switch-user path "
          f"(attempt {attempt}/{_MAX_MENU_TRIES})", flush=True)
    # A previous attempt may have left the sidebar half-open or focus somewhere odd, and
    # this walk assumes it starts on the hubs. BACK returns to a known state; on a clean
    # first attempt there is nothing to undo, so only retries pay for it.
    if attempt > 1 and not _press("KEYCODE_BACK", settle=_SETTLE):
        return False
    # Sidebar open + walk to the pinned user entry, in one `input` call. Extra LEFTs are
    # harmless (focus stops at the sidebar) and UP saturates at the top entry, so this
    # needs no read-back - the modal check below is what proves it worked.
    if not _press(("KEYCODE_DPAD_LEFT", 2), ("KEYCODE_DPAD_UP", 10), settle=_SETTLE):
        return False
    if not _press("KEYCODE_DPAD_CENTER"):
        return False
    if not _wait_activity(_MODAL_ACTIVITY):
        print("[adb] the user modal did not open", flush=True)
        return False
    # "Switch user" is the modal's first and focused entry. Deliberately NOT verified by
    # text: that costs a ~1.9s dump, and landing on the picker below proves it anyway.
    if not _press("KEYCODE_DPAD_CENTER"):
        return False
    return _wait_activity(_PICKER_ACTIVITY)


def restart_to_picker():
    """Last resort: cold-start Plex so the picker comes back. Returns True if issued.

    This is the ONE place ADB launches Plex - the normal launch path stays the HA script's
    `plex://` app link. Only reached when the in-app route above failed, because a
    force-stop kills whatever Plex was playing.
    """
    print("[adb] falling back to force-stopping Plex to get the picker back", flush=True)
    if _run(["shell", "am", "force-stop", _PLEX_PKG]) is None:
        return False
    time.sleep(1.0)
    if _run(["shell", "am", "start", "-a", "android.intent.action.VIEW",
             "-d", "plex://"]) is None:
        return False
    return True


def summon_picker(cancel=None, known_current=None):
    """Get the picker on screen. Returns (selected name, verified), or (None, False).

    `verified` is False when the name is the caller's `known_current` hint rather than a
    real dump. switch_to MUST NOT commit on an unverified name - see the guard there.

    Returning the name matters for more than convenience: the caller would otherwise
    re-read it, costing a second ~1.9s dump AND opening a race - between the two reads the
    picker can be dismissed (a human, or a still-settling previous switch), which showed
    up as a spurious "the picker went away before it could be read".

    **This does not launch Plex** - that stays the HA script's `plex://` app link, which
    runs a beat AFTER the start command publishes and can itself wait up to 30s for the
    Shield's remote to wake. So the job here is mostly to be patient: keep watching until
    Plex shows up, then deal with whichever screen it landed on. Giving up early is the
    bug this loop exists to avoid - on a cold TV (or one on YouTube) Plex can be most of a
    minute away.

    Escalates gently, re-evaluating every pass: picker already up > wake a dozing Shield >
    Plex's own Switch-user menu once it is on Home > force-stop and relaunch.
    """
    deadline = time.monotonic() + config.ADB_PICKER_WAIT_SECONDS
    woken = False
    menu_tries = 0
    home_since = None
    backs = 0
    other_since = time.monotonic()
    while time.monotonic() < deadline:
        if cancel is not None and cancel.is_set():
            return None, False
        ready, name = picker_ready(known=known_current)
        if ready:
            return name, known_current is None
        act = foreground_activity() or ""
        if _PLEX_PKG not in act:
            # A dozing Shield reports the screensaver, not Plex. WAKEUP is not a
            # navigation press - it cannot select or dismiss anything - so it is safe to
            # send blind, and it restores whatever was up behind the dream. Once only;
            # after that just keep waiting for HA's app link to bring Plex up.
            if not woken:
                print(f"[adb] not on Plex (on '{act}'); waking the Shield", flush=True)
                _press("KEYCODE_WAKEUP")
                woken = True
            time.sleep(0.4)
            continue
        if _HOME_ACTIVITY in act:
            other_since = time.monotonic()
            if home_since is None:
                home_since = time.monotonic()
            # Signed in already: no picker will ever appear on its own. Drive Plex's own
            # Switch-user route - and give it more than one shot before force-stopping,
            # because that kills whatever is playing and costs ~20s of relaunch.
            #
            # HomeActivityTV is foregrounded well BEFORE its hubs are interactive: the
            # scan that exposed this walked the sidebar 4s after waking the Shield, the
            # presses landed on a still-rendering screen, and the modal never opened.
            # Waiting for Home to hold still first is what makes the cheap route work.
            if (menu_tries < _MAX_MENU_TRIES
                    and time.monotonic() - home_since >= _HOME_SETTLE):
                menu_tries += 1
                if picker_via_menu(attempt=menu_tries):
                    # Trust the hint here rather than paying a dump: this is the moment
                    # the picker has just animated open, which is exactly when
                    # uiautomator blocks longest waiting for an idle window (~3.9s).
                    if known_current:
                        print(f"[adb] assuming picker opened on '{known_current}' "
                              "(will verify by read-back)", flush=True)
                        return known_current, False
                    return selected_profile(), True
            elif menu_tries < _MAX_MENU_TRIES:
                time.sleep(0.4)  # still settling - come back for the next attempt
                continue
            elif config.ADB_RESTART_TO_PICKER:
                if restart_to_picker():
                    return wait_for_picker(deadline, cancel), True
                return None, False
            else:
                return None, False
        # On Plex but on neither the picker nor Home: a splash still loading, a detail
        # page, or - the case that actually bites - a PLAYER. A card scanned mid-movie
        # would otherwise sit here until the deadline and never switch. Give a splash a
        # moment to resolve on its own, then back out toward Home, which is where the
        # Switch-user route starts. BACK is safe: the whole point of this scan is to play
        # something else, so leaving the current screen is intended.
        if time.monotonic() - other_since > 3.0 and backs < _MAX_BACKS:
            backs += 1
            print(f"[adb] on '{act.rsplit('.', 1)[-1]}'; backing out toward Home "
                  f"({backs}/{_MAX_BACKS})", flush=True)
            _press("KEYCODE_BACK", settle=1.2)
            other_since = time.monotonic()
            continue
        time.sleep(0.4)
    print(f"[adb] gave up waiting for the picker after "
          f"{config.ADB_PICKER_WAIT_SECONDS}s", flush=True)
    return None, False


def wait_for_picker(deadline, cancel=None, known_current=None):
    """Poll until the picker is up. Returns the selected name, or None.

    Reached only after a force-stop relaunch, where the hint is worthless anyway (Plex
    was just killed, so the picker comes up on its own default) - hence known_current
    defaults to None and this reads the selection for real.
    """
    while time.monotonic() < deadline:
        if cancel is not None and cancel.is_set():
            return None
        ready, name = picker_ready(known=known_current)
        if ready:
            return name
        time.sleep(0.4)
    return None


def switch_to(target, cancel=None, known_current=None):
    """Best-effort: drive the picker to `target` and commit. Returns (ok, detail).

    ok=True means "pressed center on a tile reading `target`" - NOT that the Shield is
    signed in as them. The caller must still confirm via the PMS log.
    """
    if not config.ADB_ENABLED:
        return False, "ADB_ENABLED is off"
    if not connect():
        return False, f"cannot reach {config.ADB_TARGET} over adb"

    deadline = time.monotonic() + config.ADB_PICKER_WAIT_SECONDS

    def resummon(why):
        """Losing the picker mid-switch is usually transient - go get it again.

        The scan that exposed this ran while the Shield was still WAKING and HA's
        `plex://` app link was landing, so the foreground activity churned for a moment
        and a single unlucky sample aborted the whole switch 8s into a 45s budget. Every
        read here is a fresh dump, so re-summoning is safe; only the deadline bounds it.
        """
        if time.monotonic() >= deadline:
            return None, False
        print(f"[adb] {why}; re-summoning the picker", flush=True)
        return summon_picker(cancel)  # no hint: re-read for real

    current, verified = summon_picker(cancel, known_current=known_current)
    if current is None:
        return False, ("could not get the Plex profile picker on screen "
                       "(not signed in and no picker, or the Plex UI changed)")
    print(f"[adb] picker is up, on '{current}', want '{target}'", flush=True)

    presses = 0
    while True:
        if time.monotonic() >= deadline:
            return False, (f"ran out of time after {presses} presses, last on "
                           f"'{current}' wanting '{target}'")
        if same_profile(current, target):
            if verified:
                break
            # The hint said we are already there, so the press loop below - and with it
            # every read-back - would be skipped entirely, and CENTER would commit
            # whoever is REALLY highlighted. That is how a stale LAST_SEEN signed the
            # Shield into the wrong profile while this reported "ok". One dump is the
            # price of the fast path being allowed to be wrong.
            live = selected_profile()
            if live is None:
                current, verified = resummon("the picker went before the selection "
                                             "was confirmed")
                if current is None:
                    return False, ("the picker went away before the selection could be "
                                   "confirmed, and did not come back")
                continue
            if live != current:
                print(f"[adb] hint said '{current}', picker is really on '{live}'",
                      flush=True)
            current, verified = live, True
            continue
        if cancel is not None and cancel.is_set():
            return False, "cancelled by a newer scan"
        if presses >= config.ADB_MAX_PRESSES:
            return False, (f"gave up after {presses} presses, stuck on '{current}' "
                           f"(is '{target}' still a Plex Home user?)")

        step = _offset(current, target)
        if step is None:
            if not profile_order():
                return False, ("no picker order available - plex.tv is unreachable and "
                               f"nothing is cached at {config.ADB_PROFILE_ORDER_CACHE}")
            return False, (f"'{current}' or '{target}' is not in the picker order "
                           "(a Home user was added or removed?)")

        # Re-guard immediately before pressing: the picker may have been dismissed by a
        # human between the read-back and now.
        ready, live = picker_ready()
        if not ready:
            current, verified = resummon("the picker went away mid-switch")
            if current is None:
                return False, "the picker went away mid-switch and did not come back"
            continue
        if live != current:
            current, verified = live, True
            continue

        n = min(abs(step), config.ADB_MAX_PRESSES - presses)
        keycode = "KEYCODE_DPAD_RIGHT" if step > 0 else "KEYCODE_DPAD_LEFT"
        if not _press((keycode, n)):
            return False, "a D-pad press failed"
        presses += n

        moved = selected_profile()
        if moved is None:
            # Presses already landed, so where the selection ended up is now unknown -
            # re-read rather than assume, and let the loop re-derive the offset.
            current, verified = resummon("the picker went away after pressing")
            if current is None:
                return False, "the picker went away mid-switch and did not come back"
            continue
        if moved == current:
            # Pressed, nothing moved: an end of a non-wrapping list, or a changed UI.
            return False, (f"'{current}' did not move after {n} x {keycode} "
                           "(end of the list, or the Plex UI changed)")
        print(f"[adb] {n} x {keycode}: '{current}' -> '{moved}'", flush=True)
        current, verified = moved, True

    # Commit straight away. The loop only exits on a VERIFIED read-back showing `target`,
    # moments ago - re-verifying would cost another ~1.9s dump to learn what we just
    # learned.
    if not _press("KEYCODE_DPAD_CENTER"):
        return False, "the commit press failed"
    print(f"[adb] committed '{current}' after {presses} presses", flush=True)
    return True, f"selected '{current}' on the picker"
