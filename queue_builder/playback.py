"""Playback: build a Plex playQueue and tell the Family Room Shield to play it.

Playback runs under the **set's own managed-user account** (Younger Kids / Older Kids) via
the server-scoped access token (`plex.account_token`) — NOT admin. So watched-state
records under that kid/older account and the owner's (Bob's) history stays separate,
and the queue only ever contains items that account can access. If the account token
can't be minted it falls back to admin (degraded — attribution would then be wrong).

Everything here needs the Shield's Plex app foregrounded (advertising as a client);
until then `play_rating_keys` degrades gracefully and reports that no client was
reachable — the selection + last-played publish still succeed.
"""
import json
import ssl
import urllib.error
import urllib.parse
import urllib.request

from . import config, plex

_CTX = ssl.create_default_context()
_CTX.check_hostname = False
_CTX.verify_mode = ssl.CERT_NONE

CLIENT_ID = config.PLEX_CLIENT_IDENTIFIER

# The Plex Cast receiver ends its session when the sender (us) disconnects. So we must
# KEEP the pychromecast connection + its discovery browser alive after casting, or the
# Shield bounces back to the home screen the moment cast_play() returns and the locals get
# garbage-collected (socket_client thread dies). We stash them here and only tear the
# previous one down when we start a new cast. Module-global on purpose: the service is a
# single long-lived MQTT loop.
_ACTIVE = {"cast": None, "browser": None, "controller": None}


def _teardown_active(pychromecast):
    """Disconnect the previously-held cast + stop its discovery browser (best-effort)."""
    cast = _ACTIVE.get("cast")
    browser = _ACTIVE.get("browser")
    if cast is not None:
        try:
            cast.disconnect(timeout=5)
        except Exception:
            pass
    if browser is not None:
        try:
            pychromecast.discovery.stop_discovery(browser)
        except Exception:
            pass
    _ACTIVE.update({"cast": None, "browser": None, "controller": None})


def _play_token(set_name=None):
    """Token used to build/drive playback: the set's managed-user account token.

    Falls back to admin only if the account token can't be minted.
    """
    cfg = config.SETS.get(set_name or "")
    if cfg:
        tok = plex.account_token(cfg.get("user_uuid"))
        if tok:
            return tok
    return config.PLEX_TOKEN


def _req(method, path, token=None, host=None, extra_headers=None):
    base = host or config.PLEX_URL
    url = base + path
    headers = {
        "X-Plex-Token": token or _play_token(),
        "X-Plex-Client-Identifier": CLIENT_ID,
        "Accept": "application/json",
    }
    headers.update(extra_headers or {})
    req = urllib.request.Request(url, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=60, context=_CTX) as r:
        body = r.read().decode() or ""
        try:
            return json.loads(body)
        except ValueError:
            return {"_raw": body}


def find_client(device=None):
    """Return the target player as {"name", "machineIdentifier", "uri"}, or None.

    `device` (from the MQTT device registry, via a start command's `target`) overrides the
    env-default Shield. `uri` is the player's DIRECT Companion endpoint; commands go
    straight to it rather than being relayed by the server. The server's /clients is only
    a last-resort fallback: it lists just GDM-discovered players, and the Shield never
    appears there (that empty list is what used to surface as the bogus "client not
    advertising" error while the Plex app was open and perfectly reachable).
    """
    if device:
        if device.get("uri"):
            return {"name": device.get("name"),
                    "machineIdentifier": device.get("machineIdentifier"),
                    "uri": str(device["uri"]).rstrip("/")}
        return plex.companion_target(device.get("name") or "", device.get("machineIdentifier") or "")
    if config.SHIELD_CLIENT_URI:
        return {"name": config.SHIELD_CLIENT_NAME,
                "machineIdentifier": config.SHIELD_CLIENT_MACHINE_ID,
                "uri": config.SHIELD_CLIENT_URI.rstrip("/")}
    target = plex.companion_target(config.SHIELD_CLIENT_NAME, config.SHIELD_CLIENT_MACHINE_ID)
    if target:
        return target
    mc = _req("GET", "/clients").get("MediaContainer", {})
    clients = mc.get("Server", []) or mc.get("Device", [])
    want_id = config.SHIELD_CLIENT_MACHINE_ID
    want_name = (config.SHIELD_CLIENT_NAME or "").lower()
    for c in clients:
        if ((want_id and c.get("machineIdentifier") == want_id)
                or (want_name and want_name in str(c.get("name", "")).lower())):
            return {"name": c.get("name"), "machineIdentifier": c.get("machineIdentifier"), "uri": None}
    return None


def create_play_queue(rating_keys, token=None, continuous=True):
    """Create a video playQueue from an ordered list of ratingKeys; return its id.

    A comma-joined metadata URI builds one ordered queue that the client auto-
    advances through — this is what bakes in the show rotation. `continuous=False`
    tells the client to STOP when the queue ends instead of auto-rolling into
    related "Up Next" content — used for channels with a per-scan cap (max_items).
    """
    if not rating_keys:
        return None
    mid = plex.machine_identifier()
    keys = ",".join(str(k) for k in rating_keys)
    uri = f"server://{mid}/com.plexapp.plugins.library/library/metadata/{keys}"
    q = urllib.parse.urlencode({
        "type": "video",
        "uri": uri,
        "continuous": 1 if continuous else 0,
        "X-Plex-Client-Identifier": CLIENT_ID,
    })
    mc = _req("POST", f"/playQueues?{q}", token=token).get("MediaContainer", {})
    return mc.get("playQueueID")


def cast_play(rating_keys, set_name=None, cast_name=None):
    """Deterministic per-account playback: Plex Cast to the Shield AS the account token.

    Launches the Plex Cast receiver on the Shield's Google-Cast interface and hands it a
    playQueue built under the set's managed-user token. The receiver plays + scrobbles with
    THAT token, so the watch records on the correct account (Kids / Alice) regardless of
    which user the Shield's Plex app is signed into. Deps (plexapi, pychromecast) are
    imported lazily so the module still loads without them.

    Must run on the LAN with the Shield awake (Cast advertises on 8009). Degrades to an
    error dict if the cast device isn't found.
    """
    result = {"queued": len(rating_keys), "played": False, "mode": "cast", "client": None}
    if not rating_keys:
        result["error"] = "nothing to play"
        return result
    try:
        from requests import Session
        from plexapi.server import PlexServer
        from plexapi.playqueue import PlayQueue
        import pychromecast
        from pychromecast.controllers.plex import PlexController
    except Exception as e:  # noqa: BLE001
        result["error"] = f"cast deps unavailable: {e}"
        return result

    tok = _play_token(set_name)
    sess = Session()
    sess.verify = False
    server = PlexServer(config.PLEX_URL, tok, session=sess)
    items = [server.fetchItem(int(rk)) for rk in rating_keys]
    pq = PlayQueue.create(server, items)

    # Tear down the previous session (if any) before opening a new one, so we don't leak a
    # socket/browser per scan. Disconnecting the old cast also frees the receiver cleanly.
    _teardown_active(pychromecast)

    target_name = cast_name or config.SHIELD_CAST_NAME
    casts, browser = pychromecast.get_listed_chromecasts(friendly_names=[target_name])
    try:
        if not casts:
            try:
                pychromecast.discovery.stop_discovery(browser)
            except Exception:
                pass
            result["error"] = f"cast device '{target_name}' not found on the LAN"
            return result
        cast = casts[0]
        cast.wait(timeout=20)
        result["client"] = cast.name
        pc = PlexController()
        cast.register_handler(pc)
        pc.block_until_playing(pq)
        result["played"] = True
        result["playQueueID"] = pq.playQueueID
        # KEEP the connection + discovery browser alive — the Plex receiver stops the moment
        # the sender disconnects, so hold refs at module scope until the next cast replaces them.
        _ACTIVE.update({"cast": cast, "browser": browser, "controller": pc})
        return result
    except Exception as e:  # noqa: BLE001
        # On failure, don't leak the just-opened browser/connection.
        try:
            pychromecast.discovery.stop_discovery(browser)
        except Exception:
            pass
        result["error"] = f"{type(e).__name__}: {e}"
        return result


def _apply_audio_language(rating_keys, token, lang):
    """Best-effort: select the `lang` audio stream on each queued item, so it plays in that
    language (workstream I — e.g. anime in Japanese, `audio_language: "jpn"`).

    MECHANISM (and its limitation): plexapi has no per-playQueue audio override that the Plex
    Cast receiver honors, so we set the SELECTED audio stream on each item's media part
    server-side, under the SET'S OWN account token. That selection persists as that account's
    preference for those items (it is NOT scoped to this one play) — acceptable because the
    account is the set's dedicated profile and it should always play that language, and it has
    the bonus that BOTH the cast and client paths then honor it. Matches on the stream's
    languageCode or language (3- or 2-letter, case-insensitive). Fully guarded: missing
    plexapi, a stream with no match, or any API error just leaves the item's default alone.
    """
    if not lang or not rating_keys:
        return
    try:
        from requests import Session
        from plexapi.server import PlexServer
    except Exception as e:  # noqa: BLE001 — deps absent (dry-run env): skip, don't fail play
        raise RuntimeError(f"plexapi unavailable: {e}")
    want = str(lang).strip().lower()
    sess = Session()
    sess.verify = False
    server = PlexServer(config.PLEX_URL, token, session=sess)
    for rk in rating_keys:
        try:
            item = server.fetchItem(int(rk))
            item.reload()
            for media in getattr(item, "media", []) or []:
                for part in getattr(media, "parts", []) or []:
                    streams = part.audioStreams()
                    match = next(
                        (s for s in streams
                         if want in ((s.languageCode or "").lower(),
                                     (s.language or "").lower())
                         or (s.languageCode or "").lower().startswith(want)),
                        None,
                    )
                    if match:
                        part.setSelectedAudioStream(match)
        except Exception:  # noqa: BLE001 — per-item best-effort; keep going
            continue


def play_rating_keys(rating_keys, set_name=None, device=None):
    """Play the queue on the target player. Dispatches on the device's mode (a registry
    entry passed via the start command's `target`), else config.PLAYBACK_MODE on the
    env-default Shield.

    "cast" (default) → per-account Plex Cast (correct-account attribution).
    "client"         → remote-control the player's Plex app (records under its signed-in user).
    Degrades gracefully: on the client path, if the client isn't advertising we still return
    the queue id + first item so the caller can publish last-played and surface the state.
    If the set carries an `audio_language`, the matching audio stream is selected on each item
    first (best-effort, both paths — see _apply_audio_language).
    """
    cfg = config.SETS.get(set_name or "") or {}
    lang = cfg.get("audio_language")
    if lang:
        try:
            _apply_audio_language(rating_keys, _play_token(set_name), lang)
        except Exception as e:  # noqa: BLE001 — never let audio prefs block playback
            print(f"[audio] language '{lang}' not applied: {e}", flush=True)
    mode = (device or {}).get("mode") or config.PLAYBACK_MODE
    if mode == "cast":
        return cast_play(rating_keys, set_name, cast_name=(device or {}).get("name"))

    result = {"queued": len(rating_keys), "played": False, "mode": "client", "client": None}
    tok = _play_token(set_name)
    client = find_client(device)
    # A per-scan cap (max_items) means "play exactly these and stop": drop `continuous` so
    # the client doesn't auto-advance into related content once the queue ends. Uncapped
    # channels keep today's endless auto-advance. (The cast path already stops at queue end.)
    _cap = cfg.get("max_items")
    _capped = isinstance(_cap, int) and _cap > 0
    pq_id = create_play_queue(rating_keys, token=tok, continuous=not _capped)
    result["playQueueID"] = pq_id
    if not client:
        result["error"] = "target Shield not listed as a player (is its Plex app installed/signed in?)"
        return result
    result["client"] = client.get("name")
    srv = urllib.parse.urlsplit(config.PLEX_LOCAL_URL)
    first = rating_keys[0]
    params = urllib.parse.urlencode({
        "key": f"/library/metadata/{first}",
        "offset": 0,
        "machineIdentifier": plex.machine_identifier(),
        # Where the Shield should stream FROM — it can't infer this when we bypass the
        # server's relay, so hand it the LAN address explicitly.
        "address": srv.hostname,
        "port": srv.port or (443 if srv.scheme == "https" else 32400),
        "protocol": srv.scheme,
        "containerKey": f"/playQueues/{pq_id}",
        "token": tok,
        "X-Plex-Target-Client-Identifier": client.get("machineIdentifier"),
        "X-Plex-Client-Identifier": CLIENT_ID,
        "commandID": 1,
    })
    try:
        # Companion answers 200 with a body of "Failure: 200 OK" even when playback DOES
        # start, so the body is not a usable success signal — only the HTTP status is.
        _req("GET", f"/player/playback/playMedia?{params}", token=tok, host=client.get("uri"),
             extra_headers={"X-Plex-Device-Name": "plex-channels",
                            "X-Plex-Product": "plex-channels",
                            "X-Plex-Version": "1.0"})
        result["played"] = True
    except urllib.error.HTTPError as e:
        result["error"] = f"playMedia HTTP {e.code}"
    except Exception as e:  # noqa: BLE001
        result["error"] = f"{type(e).__name__}: {e}"
    return result
