"""MQTT service: the plex-channels helper's runtime entrypoint.

Subscribes to command topics from Home Assistant, runs the Plex selection +
playback, and publishes results back over MQTT (no REST/shell bridges — see the
root AGENTS.md MQTT rule). Mirrors the mqtt-app-updater sibling's paho structure.

Topics (defaults in config):
  in   plex-channels/cmd/session/start      {"set":"auto|younger|older|<queue set>",
                                             "kind":"cartoons|movie|anime",
                                             "profile":"<Plex Home profile>"  (optional)}
                                            (set omitted/"auto" -> the Shield's signed-in
                                             Plex Home profile decides the tier; a curated
                                             queue set -- bob/bob_alice/family and
                                             their _anime siblings -- plays queues.yaml)
  in   plex-channels/cmd/session/advance    {}                      (the "episode card")
  in   plex-channels/cmd/soundtrack/resolve {"title":..,"type":..}
  out  plex-channels/resp/last-played       {"title","type","ratingKey"}   (retained)
  out  plex-channels/resp/soundtrack        {"command_string","tier","query"}
  out  plex-channels/state                  full session state             (retained)
"""
import json
import os
import threading
import time

import paho.mqtt.client as mqtt

from . import adb, config, driver, plex, playback, profiles, soundtrack


class Session:
    """In-memory session state (ephemeral — a reboot clears it, which is fine)."""

    def __init__(self):
        self.kind = None            # "cartoons" | "movie"
        self.set = None             # "younger" | ...
        self.queue = []             # current rotation items
        self.last_movie_rk = None   # avoid immediate movie repeats
        self.profile = None         # Plex Home profile this session resolved to

    def as_dict(self):
        return {
            "kind": self.kind, "set": self.set,
            "queue_len": len(self.queue),
            "now": self.queue[0] if self.queue else None,
            "last_movie_rk": self.last_movie_rk,
            # Last DETECTED profile, not live state: it is only sampled while a scan is
            # tailing the PMS log, so it goes stale between scans. Never poll it.
            "profile": self.profile,
        }


SESSION = Session()


def _last_played_from_item(item):
    """Map a rotation item / movie pick to the last-played payload HA stores.

    For cartoons we advertise the SHOW name (so the downstairs soundtrack card
    fetches the show's music, not one episode's title).
    """
    return {"title": item.get("show") or item.get("title"),
            "type": "show" if item.get("show") else "movie",
            "ratingKey": item.get("ratingKey")}


# A profile wait can block for minutes; run starts in a worker so the MQTT loop keeps
# servicing keepalives and later commands. A new scan cancels the previous pending wait
# (matching the no-session-lock rule: the LATEST scan always wins).
_PENDING = {"cancel": None}


def do_start(client, payload):
    prev = _PENDING.get("cancel")
    if prev is not None:
        prev.set()
    cancel = threading.Event()
    _PENDING["cancel"] = cancel
    threading.Thread(target=_do_start, args=(client, payload, cancel), daemon=True).start()


def _adb_switch_async(target, cancel):
    """Start a best-effort ADB profile switch. Returns a dict filled in when it finishes.

    Never blocks the caller and never raises: the PMS-log wait is what actually clears
    the gate, so this only ever turns a bare timeout into an actionable message. Returns
    an empty dict (and does nothing) unless ADB_ENABLED.
    """
    result = {}
    if not config.ADB_ENABLED:
        return result

    def run():
        try:
            # The picker opens on whoever is signed in, and the log wait running alongside
            # this has usually just seen exactly that - so hand it over as a starting
            # guess and save the switcher its slowest single step. Still only a hint: it
            # reads back after pressing and corrects itself if the guess was wrong.
            ok, detail = adb.switch_to(target, cancel=cancel,
                                       known_current=profiles.LAST_SEEN.get("title"))
        except Exception as e:  # a switcher bug must not take a scan down with it
            ok, detail = False, f"switcher crashed: {e}"
        result["ok"], result["detail"] = ok, detail
        print(f"[adb] switch to '{target}': {'ok' if ok else 'FAILED'} - {detail}",
              flush=True)

    t = threading.Thread(target=run, daemon=True)
    t.start()
    result["thread"] = t  # so the caller can join it before firing playback
    return result


def _do_start(client, payload, cancel):
    config.reload_sets()  # a queue created/edited in the web UI is playable immediately
    # Playback (Companion :32500) and the profile picker both need the Shield's Plex app
    # running. HA's `plex://` app link is supposed to foreground it, but when that silently
    # fails Plex stays closed and the scan errors out with nothing playing. Open it
    # ourselves over ADB first — never force-stops, so a movie already on screen is
    # untouched. Best-effort: if ADB is off/unreachable we fall back to whatever HA did.
    if config.ADB_ENABLED:
        adb.ensure_plex_open()
    kind = payload.get("kind", "cartoons")
    set_name = payload.get("set", "auto")
    # A per-tier card (or the web Play landing) can name the Plex Home profile to play
    # under. It does two jobs below: picks the binding, AND demands that the Shield
    # actually be signed into that profile before anything plays.
    card_profile = payload.get("profile") or None
    is_auto = set_name in ("auto", "", None)
    profile_title = None  # the detected Plex Home profile (auto path) → picks the binding
    # Only ever set from the PMS log, i.e. what the Shield is ACTUALLY signed into. The
    # payload's `profile` names a binding to play under and is caller-supplied, so it must
    # not satisfy a `requires_profile` gate - that gate is about the real sign-in state.
    detected_profile = None

    if is_auto:
        # Profile-driven: the signed-in Plex Home profile on the Shield picks the tier.
        _publish_state(client, awaiting="profile")
        title = profiles.wait_for_profile(cancel=cancel)
        if cancel.is_set():
            print("[profiles] wait cancelled by a newer scan", flush=True)
            return
        if title is None:
            # Spoken verbatim (see the gate error below): a sentence, not a diagnostic.
            print("[profiles] no profile signed in within "
                  f"{config.PROFILE_WAIT_SECONDS}s (is the Plex app open? is PMS debug "
                  "logging on?)", flush=True)
            _publish_state(client, error=(
                "no profile is signed in on the Shield. Open Plex and pick one."))
            return
        profile_title = detected_profile = title
        # PR 4 routing: (kind + profile) → a function channel that explicitly binds this
        # profile (config.channel_for), else the legacy PROFILE_SET_MAP tier — so a
        # pre-migration sets.yaml behaves exactly as before, and an unmapped profile
        # still errors instead of playing someone else's binding.
        set_name = config.channel_for(kind, title) or profiles.set_for_profile(title)
        if set_name is None:
            _publish_state(client, error=f"profile '{title}' has no set mapped")
            return
        print(f"[profiles] '{title}' + kind '{kind}' -> set '{set_name}'", flush=True)
    else:
        # Explicit set: the web Play landing may also name the binding to play under
        # (a profiles[] function channel); absent → the channel's default binding.
        profile_title = card_profile

    cfg = config.SETS.get(set_name)
    if not cfg or not cfg.get("enabled"):
        _publish_state(client, error=f"set '{set_name}' not enabled")
        return

    # Two different things can demand a specific Plex Home profile:
    #   * the SET declares `requires_profile` - its libraries are hidden from everyone
    #     else (the demo reel's Demos + Movie Clips are invisible to both kid profiles),
    #     so playing it on the wrong profile just stalls;
    #   * the CARD names a `profile` - the per-tier cards name a binding, and playing
    #     that binding while the Shield is signed in as the OTHER tier would attribute
    #     the watch to the wrong account and poison that profile's watched-state.
    #     Rotation sets are ungated on purpose, so `requires_profile` cannot express
    #     this; it has to ride on the payload.
    # Either way `detected_profile` (PMS-log derived, i.e. what the Shield is ACTUALLY
    # signed into) is the ONLY thing that clears the gate. The payload is caller-supplied
    # and must never satisfy its own demand.
    required = cfg.get("requires_profile")
    if required and card_profile and card_profile != required and not is_auto:
        _publish_state(client, error=(
            f"card asks for profile '{card_profile}' but set "
            f"'{cfg.get('label') or set_name}' requires '{required}'"))
        return
    if not required and not is_auto:
        required = card_profile
    switched = {}  # set below if we drive an ADB profile switch; joined before playback
    if config.PLAYBACK_FSM:
        # The FSM (driver.drive_to_playing, below) owns the profile gate: it samples the
        # current profile and only walks the picker on a real change, then verifies + retries.
        # Selection still needs a binding, so point it at the profile we'll be signed in as.
        if required and not profile_title:
            profile_title = required
    elif required and detected_profile != required:
        _publish_state(client, awaiting=f"profile:{required}")
        # Best-effort: drive the picker there ourselves, concurrently with the log wait.
        # Concurrently, not before - the HA script foregrounds Plex AFTER publishing this
        # command, so the picker usually is not on screen yet; adb.switch_to polls for it.
        # A human picking the profile first still wins, and ADB failing costs nothing but
        # a better error message.
        switched = _adb_switch_async(required, cancel)
        title = profiles.wait_for_profile(cancel=cancel, match=required)
        if cancel.is_set():
            print("[profiles] wait cancelled by a newer scan", flush=True)
            return
        if title is None:
            why = switched.get("detail")
            # This is read aloud verbatim by automation.plex_channels_status_announcements,
            # so it stays a sentence a person would say: no timeout figure (the wait having
            # ended is what "did not switch" already means) and no switcher jargon. The
            # diagnostic detail goes to the log, which is where it gets acted on.
            if why:
                print(f"[profiles] gate failed for '{required}' (auto-switch: {why})",
                      flush=True)
            _publish_state(client, error=(
                f"'{cfg.get('label') or set_name}' needs the '{required}' Plex profile, "
                "and the Shield did not switch to it. Pick it on the TV."))
            return
        profile_title = detected_profile = title

    # The active profile binding (v3 PR 2): the one whose plex_user matches the detected
    # profile, else the set's first/default binding. A legacy single-binding set always
    # resolves to its one binding — identical to before. Bindings only matter for rotation
    # sets; queue sets ignore it (their selection path reads the cfg default binding).
    binding = config.binding_for(cfg, profile_title)

    SESSION.kind, SESSION.set, SESSION.profile = kind, set_name, profile_title
    # Resume point (ms) for the first queued item — set only on the curated-queue path below
    # when its lead was started but not finished (plex.next_queue's `offset`). Rotation / reel
    # playback leaves it 0, so they play from the top exactly as before.
    resume_ms = 0
    if cfg.get("source") == "queue":
        # Curated wishlist: play the first not-finished entry (movie, a series' next unwatched
        # episodes, or a Collection in order). Finished entries are KEPT + marked done (not
        # pruned). `kind` is informational here — the set + its queue file decide what plays.
        # A REEL (e.g. the theater DEMO channel) is the exception: an ordered showcase that
        # replays IN FULL every scan, never marking anything done. Same result shape either way.
        res = plex.build_reel(set_name) if cfg.get("reel") else plex.next_queue(set_name)
        if res.get("done"):
            print(f"[queue] {set_name} finished (kept, marked done): "
                  f"{res['done']}", flush=True)
        if res.get("unresolved"):
            print(f"[queue] {set_name} unresolved entries (kept, flagged): "
                  f"{res['unresolved']}", flush=True)
        if not res.get("play"):
            _publish_state(client, error=(
                f"queue '{set_name}' has nothing to play "
                f"(empty, or every entry watched - add entries to queues.yaml)"))
            return
        SESSION.queue = res["play"]
        last = res["last"]
        # A reel never resumes (always 0); a queue carries its lead item's viewOffset when it
        # was started but not finished, so it picks up where it left off instead of restarting.
        resume_ms = res.get("offset") or 0
    else:
        # Rotation set — pick the path by `behavior` (v3 PR 2), falling back to the legacy
        # `mode` field (workstream E) and then to the card's `kind` when neither is set, so
        # nothing regresses: a legacy set with no behavior/mode still infers rewatch for a
        # "movie" card and episodic otherwise. `behavior` maps progress→episodic (advance
        # through unwatched) and rewatch→rewatch (weighted least-watched replay).
        behavior = cfg.get("behavior")
        if behavior == "rewatch":
            mode = "rewatch"
        elif behavior == "progress":
            mode = "episodic"
        else:
            mode = cfg.get("mode") or ("rewatch" if kind == "movie" else "episodic")
        if mode == "rewatch":
            # pick_rewatch generalizes the movie card (v3 PR 3): a members channel replays
            # its least-watched member items; a memberless one is the movie pool as before.
            pick = plex.pick_rewatch(set_name, exclude_rating_key=SESSION.last_movie_rk, binding=binding)
            if not pick:
                _publish_state(client, error="no rewatch candidate found (this profile has no watch history for this channel)")
                return
            SESSION.last_movie_rk = pick["ratingKey"]
            SESSION.queue = [{"title": pick["title"], "ratingKey": pick["ratingKey"]}]
            last = {"title": pick["title"], "type": "movie", "ratingKey": pick["ratingKey"]}
        elif mode == "both":
            # Combination: ONE rewatch movie leads, then the episodic rotation fills the rest
            # (movie first, then shows), total capped at ROTATION_LENGTH. If no movie history,
            # it degrades to a pure rotation; if neither, it errors like each would alone.
            queue = []
            pick = plex.pick_rewatch(set_name, exclude_rating_key=SESSION.last_movie_rk, binding=binding)
            if pick:
                SESSION.last_movie_rk = pick["ratingKey"]
                queue.append({"title": pick["title"], "ratingKey": pick["ratingKey"]})
            queue.extend(plex.build_rotation(set_name, binding=binding)[:max(0, config.ROTATION_LENGTH - len(queue))])
            if not queue:
                _publish_state(client, error="no rewatchable movie or unwatched episodes found (mode=both)")
                return
            SESSION.queue = queue
            last = ({"title": pick["title"], "type": "movie", "ratingKey": pick["ratingKey"]}
                    if pick else _last_played_from_item(queue[0]))
        else:  # episodic (cartoons rotation)
            SESSION.queue = plex.build_rotation(set_name, binding=binding)
            if not SESSION.queue:
                _publish_state(client, error="no unwatched cartoons found")
                return
            last = _last_played_from_item(SESSION.queue[0])

    # Per-channel session cap: play at most max_items this scan, then stop. Because every
    # card scan is a fresh do_start, this is naturally per-scan — watch N, then nothing more
    # until the card is scanned again. Blank/absent => no cap (e.g. anime channels). Applies
    # to every source/mode since it just trims the already-built lineup; playback also drops
    # `continuous` for capped channels so the client won't auto-roll into related content.
    cap = cfg.get("max_items")
    if isinstance(cap, int) and cap > 0:
        SESSION.queue = SESSION.queue[:cap]

    # Optional per-command target (a device-registry id from the web UI's "Play on ▾");
    # absent/unknown -> the env-default Shield, exactly as before.
    device = DEVICES.get(str(payload.get("target") or "")) or None

    if config.PLAYBACK_FSM:
        # State-machine path: sample real device/profile/Plex state and drive VERIFIED,
        # RETRIED, NON-DESTRUCTIVE transitions to playing(target). It owns the launch, the
        # profile gate (no picker walk when already on `required`), and the play — which it
        # fires only after verifying Plex is foreground and the Companion port is accepting,
        # retrying a Companion-refused play a bounded few times. Selection above is unchanged.
        result = driver.drive_to_playing(
            client,
            rating_keys=[i["ratingKey"] for i in SESSION.queue],
            required_profile=required,
            offset=resume_ms,
            device=device,
            set_name=set_name,
            cancel=cancel,
            set_label=cfg.get("label") or set_name,
        )
        if result.get("cancelled"):
            print("[driver] scan cancelled by a newer one", flush=True)
            return
        if result.get("error"):
            _publish_state(client, error=result["error"])
            return
        client.publish(config.T_RESP_LAST_PLAYED, json.dumps(last), qos=1, retain=True)
        _publish_state(client, playback=result)
        return

    # --- Legacy fire-and-forget path (PLAYBACK_FSM off) --------------------------------- #
    # An ADB profile switch drives the Shield's UI - it backs out of whatever is on screen
    # to reach the picker. It runs concurrently with the log-wait above, so by now it may
    # still be mid-navigation. playMedia lands on the client regardless of the current
    # screen, so if we fire it while the switch is still walking the UI, the switch backs
    # out of the movie we just started and playback dies - even when the profile was
    # ALREADY correct (the picker walk happens anyway, committing 0 presses). Join the
    # switch first so play is always the LAST action; the bounded timeout means a hung
    # switch never blocks playback indefinitely.
    _switch_thread = switched.get("thread")
    if _switch_thread:
        _switch_thread.join(timeout=config.ADB_PICKER_WAIT_SECONDS + 10)
    result = playback.play_rating_keys([i["ratingKey"] for i in SESSION.queue],
                                       set_name=set_name, device=device, offset=resume_ms)
    client.publish(config.T_RESP_LAST_PLAYED, json.dumps(last), qos=1, retain=True)
    _publish_state(client, playback=result)


def do_advance(client, _payload):
    """Episode card: switch it up — fresh cartoons lineup, or another movie.

    Mid-session the set + kind are already resolved (including queue sets); with no session
    it falls back to "auto" (profile-driven) cartoons, same as a fresh scan.
    """
    do_start(client, {"kind": SESSION.kind or "cartoons", "set": SESSION.set or "auto"})


# --- device registry: the "Play on <device>" dropdown's source ----------------- #
# Retained plex-channels/devices/<id> announcements: the env-default Shield (always
# present, so nothing regresses with an empty registry) + every plex.tv device that
# advertises as a player. Re-announced every DEVICE_ANNOUNCE_SECONDS.
DEVICES = {}


def _build_devices():
    devices = {}
    default_id = "shield"
    default = {
        "id": default_id,
        "name": (config.SHIELD_CAST_NAME if config.PLAYBACK_MODE == "cast"
                 else config.SHIELD_CLIENT_NAME),
        "machineIdentifier": config.SHIELD_CLIENT_MACHINE_ID or None,
        "uri": config.SHIELD_CLIENT_URI or None,
        "mode": config.PLAYBACK_MODE,
        "default": True,
    }
    devices[default_id] = default
    try:
        for d in plex.player_devices():
            did = d.get("machineIdentifier") or d.get("name")
            if not did:
                continue
            # The env-default Shield also shows up via plex.tv — same machine id, or
            # (when SHIELD_CLIENT_MACHINE_ID isn't set) the same advertised name. Merge
            # it into the default entry instead of listing the device twice, and let it
            # fill in the id/uri the env didn't provide.
            same_id = (config.SHIELD_CLIENT_MACHINE_ID
                       and d.get("machineIdentifier") == config.SHIELD_CLIENT_MACHINE_ID)
            same_name = ((d.get("name") or "").strip().lower()
                         == (default["name"] or "").strip().lower())
            if same_id or same_name:
                default["machineIdentifier"] = default["machineIdentifier"] or d.get("machineIdentifier")
                default["uri"] = default["uri"] or d.get("uri")
                continue
            devices[did] = {"id": did, "name": d.get("name"),
                            "machineIdentifier": d.get("machineIdentifier"),
                            "uri": d.get("uri"), "mode": "client", "default": False}
    except Exception as e:  # noqa: BLE001 — plex.tv hiccup: default entry still announces
        print(f"[devices] plex.tv enumeration failed: {e}", flush=True)
    return devices


def announce_devices(client):
    devices = _build_devices()
    # Retained per-device topics; a device that vanished gets its topic cleared.
    for gone in set(DEVICES) - set(devices):
        client.publish(f"{config.T_DEVICES_BASE}/{gone}", "", qos=1, retain=True)
    DEVICES.clear()
    DEVICES.update(devices)
    for did, dev in devices.items():
        payload = dict(dev, seen=int(time.time()))
        client.publish(f"{config.T_DEVICES_BASE}/{did}", json.dumps(payload), qos=1, retain=True)


def _device_announcer(client):
    while True:
        try:
            announce_devices(client)
        except Exception as e:  # noqa: BLE001 — keep the announcer alive
            print(f"[devices] announce failed: {e}", flush=True)
        time.sleep(config.DEVICE_ANNOUNCE_SECONDS)


def do_preview(client, payload):
    """Channels-view preview: compute a rotation set's eligible pool + a movie sample.

    Request/response over MQTT (the AGENTS.md no-new-REST-bridges rule): the web server
    publishes {"set", "reply"} and we answer on `reply` (must live under the preview
    response base — never let a payload aim us at an arbitrary topic).
    """
    set_name = str(payload.get("set") or "")
    reply = str(payload.get("reply") or "")
    profile_title = str(payload.get("profile") or "") or None  # PR 4: per-binding pools
    if not reply.startswith(config.T_RESP_PREVIEW_BASE):
        print(f"[preview] refused reply topic {reply!r}", flush=True)
        return
    out = {"set": set_name}
    if profile_title:
        out["profile"] = profile_title
    try:
        config.reload_sets()
        cfg = config.SETS.get(set_name)
        if not cfg or cfg.get("source") == "queue":
            out["error"] = f"'{set_name}' is not a rotation channel"
        else:
            binding = config.binding_for(cfg, profile_title)
            behavior = cfg.get("behavior")
            # A behavior:rewatch channel has no episodic pool (and vice versa no movie
            # pool), so skip the half nobody renders; a legacy tier (no behavior)
            # computes both, exactly as before.
            if behavior == "rewatch":
                out["buckets"] = []
            else:
                # Member-aware (v3 PR 3): explicit members[] when curated, else the rule.
                buckets = plex.channel_buckets(set_name, binding=binding)
                out["buckets"] = [{
                    "show": b["show"],
                    "ratingKey": b["ratingKey"],
                    "unwatched": len(b["episodes"]),
                    "next": ({"ratingKey": b["episodes"][0]["ratingKey"],
                              "title": b["episodes"][0]["title"],
                              "season": b["episodes"][0]["season"],
                              "episode": b["episodes"][0]["episode"],
                              "multiSeason": b.get("multi_season", False)}
                             if b["episodes"] else None),
                    # A LIBRARY bucket (Shorts) is one shuffled pile of standalone items, not
                    # a series — "462 unwatched" says nothing about WHAT plays, so send the
                    # items themselves (alphabetical; the bucket's own order is the shuffle
                    # for THIS session). A show bucket stays summarized by `next`.
                    "items": (sorted(
                        ({"ratingKey": e["ratingKey"], "title": e["title"]}
                         for e in b["episodes"]),
                        key=lambda e: (e["title"] or "").lower(),
                    ) if str(b["ratingKey"]).startswith("section-") else None),
                } for b in buckets]
            if behavior == "progress":
                out["movie"], out["movie_pool"] = None, []
            else:
                try:
                    out["movie"] = plex.pick_rewatch(set_name, binding=binding)
                except Exception:  # noqa: BLE001 — movie sample is a nice-to-have
                    out["movie"] = None
                try:
                    # The Movies channel's pool (web Channels view) — same binding.
                    out["movie_pool"] = plex.rewatch_pool(set_name, binding=binding)
                except Exception:  # noqa: BLE001
                    out["movie_pool"] = []
    except Exception as e:  # noqa: BLE001
        out["error"] = f"{type(e).__name__}: {e}"
    client.publish(reply, json.dumps(out), qos=1, retain=False)
    print(f"[preview] {set_name}: {len(out.get('buckets', []))} buckets -> {reply}", flush=True)


def do_soundtrack(client, payload):
    res = soundtrack.resolve(payload.get("title", ""), payload.get("type", "movie"))
    client.publish(config.T_RESP_SOUNDTRACK, json.dumps(res), qos=1, retain=False)
    print(f"[soundtrack] {payload.get('title')!r} -> {res}", flush=True)


def _publish_state(client, error=None, playback=None, awaiting=None):
    state = SESSION.as_dict()
    if error:
        state["error"] = error
    if playback is not None:
        state["playback"] = playback
    if awaiting is not None:
        state["awaiting"] = awaiting
    client.publish(config.T_STATE, json.dumps(state), qos=1, retain=True)
    print(f"[state] {json.dumps(state)}", flush=True)


def publish_discovery(client):
    """Announce a status sensor over MQTT discovery so HA creates it by itself.

    `plex-channels/state` has always carried `awaiting` / `error` / `profile`, and
    nothing consumed any of it - so from the couch a scan that is mid-profile-switch and
    a scan that is broken looked identical. This is the piece that makes the wait
    visible. Discovery (rather than a hand-written MQTT sensor in configuration.yaml)
    keeps the contract owned by the service that publishes it, and means a fresh HA needs
    no manual wiring.

    The state string is deliberately coarse - waiting / error / playing / idle - with the
    full payload hung off json_attributes so automations can read `awaiting` (e.g.
    "profile:Older Kids") and `error` without re-parsing anything.
    """
    topic = f"{config.T_DISCOVERY_BASE}/sensor/{config.DISCOVERY_OBJECT_ID}/config"
    payload = {
        "name": "Status",
        "unique_id": config.DISCOVERY_OBJECT_ID,
        "object_id": config.DISCOVERY_OBJECT_ID,
        "state_topic": config.T_STATE,
        "value_template": (
            "{% if value_json.error %}error"
            "{% elif value_json.awaiting %}waiting"
            "{% elif value_json.playback %}playing"
            "{% else %}idle{% endif %}"),
        "json_attributes_topic": config.T_STATE,
        "icon": "mdi:plex",
        "device": {
            "identifiers": ["plex_channels"],
            "name": "Plex Channels",
            "manufacturer": "plex-channels",
            "model": "Kids NFC / UC3 Plex helper",
        },
    }
    client.publish(topic, json.dumps(payload), qos=1, retain=True)
    print(f"[mqtt] published discovery for {config.DISCOVERY_OBJECT_ID}", flush=True)


def on_connect(client, userdata, flags, rc, properties=None):
    print(f"[mqtt] connected rc={rc}; subscribing", flush=True)
    client.subscribe([(config.T_CMD_START, 0), (config.T_CMD_ADVANCE, 0),
                      (config.T_CMD_SOUNDTRACK, 0), (config.T_CMD_PREVIEW, 0)])
    publish_discovery(client)
    announce_devices(client)


def on_message(client, userdata, msg):
    try:
        payload = json.loads(msg.payload.decode() or "{}")
    except Exception:
        payload = {}
    print(f"[mqtt] {msg.topic} {payload}", flush=True)
    try:
        if msg.topic == config.T_CMD_START:
            do_start(client, payload)
        elif msg.topic == config.T_CMD_ADVANCE:
            do_advance(client, payload)
        elif msg.topic == config.T_CMD_SOUNDTRACK:
            do_soundtrack(client, payload)
        elif msg.topic == config.T_CMD_PREVIEW:
            # History enumeration can take a while; never block the MQTT loop.
            threading.Thread(target=do_preview, args=(client, payload), daemon=True).start()
    except Exception as e:  # noqa: BLE001 — never let one bad command kill the loop
        _publish_state(client, error=f"{type(e).__name__}: {e}")


def main():
    if not config.MQTT_HOST:
        raise SystemExit("MQTT_HOST is required")
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    if config.MQTT_USER:
        client.username_pw_set(config.MQTT_USER, config.MQTT_PASS)
    client.on_connect = on_connect
    client.on_message = on_message
    # TLS on 8883 (broker presents a publicly-trusted Let's Encrypt cert; system CA
    # bundle trusts it, so no CA file needed). Backward-compatible: plaintext on 1883.
    if config.MQTT_PORT == 8883:
        client.tls_set()
    client.connect(config.MQTT_HOST, config.MQTT_PORT, keepalive=60)
    threading.Thread(target=_device_announcer, args=(client,), daemon=True).start()
    print(f"[boot] plex-channels up; broker {config.MQTT_HOST}:{config.MQTT_PORT}; "
          f"plex {config.PLEX_URL}", flush=True)
    client.loop_forever()


if __name__ == "__main__":
    main()
