"""Cast-only MQTT sidecar — subscribes to queuepilot/cmd/cast/play, replies on resp/cast.

When PLAYBACK_ENGINE=node the main queue_builder.service is not started; this process keeps
pychromecast-based cast playback available without carrying the full selection engine.
"""
from __future__ import annotations

import json
import os
import ssl
import sys
import time
import urllib.parse
import urllib.request

import paho.mqtt.client as mqtt

# These two are deliberately NOT bridged across the plex-channels -> queuepilot rename. The
# only publisher to T_CMD is server/src/playback.js, in this same container reading this same
# env, so both halves move prefix on the same deploy; and nothing outside the container
# subscribes to T_RESP. Keep the defaults identical to server/src/env.js.
T_CMD = os.environ.get("T_CMD_CAST_PLAY", "queuepilot/cmd/cast/play")
T_RESP = os.environ.get("T_RESP_CAST", "queuepilot/resp/cast")
HOST = os.environ.get("MQTT_HOST", "")
PORT = int(os.environ.get("MQTT_PORT", "1883"))
USER = os.environ.get("MQTT_USER") or None
PASS = os.environ.get("MQTT_PASS") or None
PLEX_URL = (os.environ.get("PLEX_API_SERVER_URL") or os.environ.get("PLEX_URL") or "").rstrip("/")
PLEX_TOKEN = os.environ.get("PLEX_TOKEN") or os.environ.get("PLEX_API_KEY") or ""
CAST_NAME = os.environ.get("SHIELD_CAST_NAME") or os.environ.get("SHIELD_CLIENT_NAME") or "Family Room SHIELD"


def _cast_play(rating_keys, cast_name=None, offset=0, token=None):
    result = {"queued": len(rating_keys or []), "played": False, "mode": "cast"}
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
    tok = token or PLEX_TOKEN
    try:
        sess = Session()
        sess.verify = False
        server = PlexServer(PLEX_URL, tok, session=sess)
        items = [server.fetchItem(int(rk)) for rk in rating_keys]
        pq = PlayQueue.create(server, items)
        chromecasts, browser = pychromecast.get_listed_chromecasts(
            friendly_names=[cast_name or CAST_NAME])
        if not chromecasts:
            result["error"] = f"cast device '{cast_name or CAST_NAME}' not found"
            return result
        cast = chromecasts[0]
        cast.wait()
        pc = PlexController()
        cast.register_handler(pc)
        pc.block_until_playing(pq)
        if offset:
            try:
                cast.media_controller.seek(float(offset) / 1000.0)
            except Exception:  # noqa: BLE001
                pass
        result["played"] = True
        result["client"] = cast.name
        # Keep process references so the socket stays up (cast stops if GC'd).
        _cast_play._ACTIVE = (cast, browser, pc)  # type: ignore[attr-defined]
    except Exception as e:  # noqa: BLE001
        result["error"] = f"{type(e).__name__}: {e}"
    return result


def on_message(client, userdata, msg):
    try:
        payload = json.loads(msg.payload.decode() or "{}")
    except Exception:  # noqa: BLE001
        payload = {}
    rks = payload.get("rating_keys") or payload.get("ratingKeys") or []
    res = _cast_play(
        rks,
        cast_name=payload.get("cast_name") or payload.get("castName"),
        offset=int(payload.get("offset") or 0),
        token=payload.get("token"),
    )
    client.publish(T_RESP, json.dumps(res), qos=1, retain=False)
    print(f"[cast_sidecar] play {len(rks)} -> played={res.get('played')} err={res.get('error')}", flush=True)


def main():
    if not HOST:
        print("[cast_sidecar] MQTT_HOST unset; exiting", flush=True)
        sys.exit(1)
    c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="queuepilot-cast-sidecar")
    if USER:
        c.username_pw_set(USER, PASS)
    if PORT == 8883:
        c.tls_set()
    c.on_message = on_message
    c.connect(HOST, PORT, 60)
    c.subscribe(T_CMD, qos=1)
    print(f"[cast_sidecar] listening on {T_CMD} via {HOST}:{PORT}", flush=True)
    c.loop_forever()


if __name__ == "__main__":
    main()
