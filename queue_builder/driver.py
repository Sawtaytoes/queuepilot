"""Playback state machine: sample the Shield's real state, then drive it to `playing`.

This replaces service._do_start's fire-and-forget tail (ensure_plex_open at the top ->
wait_for_profile -> best-effort `_adb_switch_async` -> join -> play) with a machine that
SAMPLES real state and runs VERIFIED, RETRIED, NON-DESTRUCTIVE transitions toward the target:

    unreachable ──▶ device_on ──▶ plex_foreground ──▶ signed_in(required) ──▶ playing(target)

Every edge verifies it landed before proceeding, retries a bounded number of times, and never
destroys progress it can't recover cheaply (no force-stop of a running movie, no picker walk
when already on the right profile). Play is ALWAYS the last action, and it is verified: the
Companion port is probed and Plex confirmed foreground immediately before playMedia fires.

Gated behind config.PLAYBACK_FSM (default off) so the legacy path in service stays live until
the owner verifies this on the real Shield. Reuses the existing adb / profiles / playback
primitives — it does not re-derive picker or profile logic. See
docs/playback-state-machine-design.md.
"""
import time
import urllib.parse

from . import adb, config, playback, profiles

# Read aloud verbatim by automation.plex_channels_status_announcements, so these stay
# sentences a person would say — no timeout figures, no switcher jargon (the diagnostic
# detail goes to the log). See docs/decisions/2026-07-26-spoken-status-is-a-sentence-not-a-diagnostic.md.
_SWITCH_ERROR = ("'{label}' needs the '{profile}' Plex profile, and the Shield did not "
                 "switch to it. Pick it on the TV.")
_PLAY_ERROR = "Plex wasn't ready to play on the Shield. Try the card again."


def _publish_await(client, awaiting):
    """Surface a mid-flight transition on plex-channels/state (what HA's status sensor shows).

    Lazy service import to avoid a cycle (service imports this module); a None client (unit
    tests) is a no-op, so the driver stays testable without MQTT.
    """
    if client is None:
        return
    from . import service  # local: service imports driver at module load
    service._publish_state(client, awaiting=awaiting)


def _plex_foreground():
    """Is the Shield's Plex app the foreground activity right now? (ADB read, ~50ms.)"""
    return adb._PLEX_PKG in (adb.foreground_activity() or "")


def _ensure_plex(attempts=2):
    """device_on + plex_foreground, retried. Non-fatal: ensure_plex_open never force-stops,
    and a play still tries even if ADB can't confirm Plex came up (HA may have launched it)."""
    for _ in range(max(1, attempts)):
        if adb.ensure_plex_open():
            return True
        time.sleep(config.PLAYBACK_FSM_RETRY_BACKOFF)
    return False


def _companion_addr(device):
    """(host, port) of the target's Companion endpoint, for the readiness probe.

    A start command's `target` device carries its own Companion uri; otherwise the env-default
    Shield's SHIELD_CLIENT_URI, else SHIELD_IP:COMPANION_PORT.
    """
    uri = (device or {}).get("uri") or config.SHIELD_CLIENT_URI
    if uri:
        sp = urllib.parse.urlsplit(uri if "://" in uri else "http://" + uri)
        if sp.hostname:
            return sp.hostname, sp.port or config.COMPANION_PORT
    return config.SHIELD_IP, config.COMPANION_PORT


def _is_conn_refused(result):
    """Did play fail because the Companion port refused the connection (Errno 111)?

    play_rating_keys returns the error as a string (URLError: <urlopen error [Errno 111]
    Connection refused>) rather than raising, so match on the text. Only this failure mode
    warrants a re-open-and-retry; an HTTP error means Plex answered and is a different problem.
    """
    err = ((result or {}).get("error") or "").lower()
    return "connection refused" in err or "errno 111" in err or "urlopen error" in err


def _drive_profile(client, required, cancel):
    """signed_in(required). Returns None on success, or a terminal result (cancelled / error).

    NON-DESTRUCTIVE fast path: if the Shield is already signed into `required`
    (profiles.LAST_SEEN, alias-aware via adb.same_profile), this is a no-op — it never walks
    the picker, which is what used to back a just-started movie out of playback. Only when a
    real change is needed does it drive adb.switch_to, bounded-retried. The gate is satisfied
    by a picker read-back (switch_to ok) OR LAST_SEEN == required — NOT solely a fresh PMS-log
    sign-in line, which never comes when already signed in.
    """
    current = profiles.LAST_SEEN.get("title")
    if current and adb.same_profile(current, required):
        print(f"[driver] already signed in as '{current}' (== '{required}'); no picker walk",
              flush=True)
        return None

    _publish_await(client, f"profile:{required}")

    if not config.ADB_ENABLED:
        # Can't drive the picker — wait for a human/HA to sign in, satisfied by the PMS log.
        title = profiles.wait_for_profile(cancel=cancel, match=required)
        if cancel is not None and cancel.is_set():
            return {"cancelled": True}
        return None if title is not None else {"error": _SWITCH_ERROR, "_profile": required}

    attempts = max(1, config.PLAYBACK_FSM_SWITCH_ATTEMPTS)
    for i in range(attempts):
        if cancel is not None and cancel.is_set():
            return {"cancelled": True}
        ok, detail = adb.switch_to(required, cancel=cancel,
                                   known_current=profiles.LAST_SEEN.get("title"))
        if ok:  # pressed center on a tile reading `required` — the read-back proves the gate
            print(f"[driver] switched to '{required}': {detail}", flush=True)
            return None
        # A human or HA may have signed in meanwhile — a fresh LAST_SEEN also clears the gate.
        seen = profiles.LAST_SEEN.get("title")
        if seen and adb.same_profile(seen, required):
            print(f"[driver] gate cleared out-of-band: signed in as '{seen}'", flush=True)
            return None
        print(f"[driver] switch attempt {i + 1}/{attempts} to '{required}' failed: {detail}",
              flush=True)
        time.sleep(config.PLAYBACK_FSM_RETRY_BACKOFF)
    return {"error": _SWITCH_ERROR, "_profile": required}


def _drive_play(rating_keys, set_name, device, offset, cancel):
    """playing(target). Play is the LAST action and it is VERIFIED.

    The Companion-refused failure mode (#1) is client-mode only: before each attempt the
    driver confirms Plex is foreground AND the Companion port accepts a TCP connect, re-opening
    Plex when either is false; a play that still comes back Errno-111 re-opens and retries, a
    bounded few times. Success (or any non-connection failure, e.g. an HTTP error) returns
    immediately. Exhausting the connection-refused retries returns the spoken play error.

    Cast mode doesn't use Companion :32500 (it drives the Cast receiver on 8009), so the
    refusal loop doesn't apply — play once and return its result.
    """
    mode = (device or {}).get("mode") or config.PLAYBACK_MODE
    if mode != "client":
        return playback.play_rating_keys(rating_keys, set_name=set_name, device=device,
                                         offset=offset)

    host, port = _companion_addr(device)
    attempts = max(1, config.PLAYBACK_FSM_PLAY_ATTEMPTS)
    result = None
    for i in range(attempts):
        if cancel is not None and cancel.is_set():
            return {"cancelled": True}
        # Verify plex_foreground + Companion readiness immediately BEFORE firing play.
        if config.ADB_ENABLED and not _plex_foreground():
            print("[driver] Plex not foreground before play; re-opening", flush=True)
            _ensure_plex()
        if not playback.companion_ready(host, port):
            print(f"[driver] Companion {host}:{port} not accepting a connection; re-opening Plex",
                  flush=True)
            if config.ADB_ENABLED:
                _ensure_plex()
            time.sleep(config.PLAYBACK_FSM_RETRY_BACKOFF)
        result = playback.play_rating_keys(rating_keys, set_name=set_name, device=device,
                                           offset=offset)
        if result.get("played"):
            return result
        if _is_conn_refused(result):
            print(f"[driver] play attempt {i + 1}/{attempts} refused: {result.get('error')}; "
                  "re-opening Plex and retrying", flush=True)
            if config.ADB_ENABLED:
                _ensure_plex()
            time.sleep(config.PLAYBACK_FSM_RETRY_BACKOFF)
            continue
        # A non-connection failure (HTTP, no client advertising): Plex answered — surface it
        # as-is so state/last-played publish exactly as the legacy path did.
        return result
    print(f"[driver] play still refused after {attempts} attempts: "
          f"{(result or {}).get('error')}", flush=True)
    return {"error": _PLAY_ERROR, "_diag": result}


def drive_to_playing(client, *, rating_keys, required_profile, offset, device, set_name,
                     cancel, set_label=None):
    """Drive the target device from wherever it is to `playing(target)`.

    Returns the playback result dict on success (published as-is), {"cancelled": True} when a
    newer scan cancelled this one, or {"error": "<spoken sentence>"} when a transition's
    bounded retries were exhausted (the diagnostic detail is already in the log). Selection
    (which items, which profile binding) is done by the caller and unchanged; this owns only
    the launch + profile gate + verified play.
    """
    if cancel is not None and cancel.is_set():
        return {"cancelled": True}

    # unreachable -> device_on -> plex_foreground. Best-effort head start (the play step
    # re-verifies foreground itself); ADB off/unreachable falls back to whatever HA launched.
    if config.ADB_ENABLED:
        _ensure_plex()

    # plex_foreground -> signed_in(required). Only when the set/card demands a profile.
    if required_profile:
        r = _drive_profile(client, required_profile, cancel)
        if r is not None:
            if r.get("error") == _SWITCH_ERROR:
                r["error"] = _SWITCH_ERROR.format(
                    label=set_label or set_name, profile=r.pop("_profile", required_profile))
            return r

    if cancel is not None and cancel.is_set():
        return {"cancelled": True}

    # signed_in(required) -> playing(target). Play is the last action, verified + retried.
    return _drive_play(rating_keys, set_name, device, offset, cancel)
