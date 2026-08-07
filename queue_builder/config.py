"""Runtime config for the plex-channels helper.

All secrets/tunables come from env (nothing sensitive is committed). The `SETS`
dict is the extensible heart of the "Saturday morning cartoons" feature: each
named set is a pool of kid-show library sections minus a blocklist, tied to the
Plex managed user whose profile the Shield plays under.

Both kid sets are live: `younger` (Younger Kids account, G tier) and `older` (Older
Kids account, PG tier only, disjoint from younger). Adding a set later (or a future
adult tier) is a dict entry, no code change.
"""
import json
import os


def _load_host_config():
    """Host/deploy values (real Shield IP, Plex LAN URL, client names) live in a YAML file
    on the persisted /config volume — NOT baked into this (public) image. A missing file is
    fine: every value falls back to a deliberately non-routable placeholder, so a
    misconfigured deploy fails loudly instead of silently reaching a stranger's LAN."""
    path = os.environ.get("CONFIG_PATH", "/config/config.yaml")
    try:
        from ruamel.yaml import YAML
        with open(path, "r", encoding="utf-8") as f:
            return YAML(typ="safe").load(f) or {}
    except FileNotFoundError:
        return {}
    except Exception as e:  # a malformed file must never crash boot
        print(f"[config] could not read {path}: {e}", flush=True)
        return {}


_HOST = _load_host_config()


def _hostval(env_key, yaml_key, default):
    """Resolve a host value: an env override wins, then the /config YAML, then the
    placeholder default. Keeps real IPs/hostnames out of the public image."""
    v = os.environ.get(env_key)
    if v:
        return v
    y = _HOST.get(yaml_key)
    if y is not None and y != "":
        return str(y)
    return default


# --- Plex server (self-signed cert -> TLS unverified, like music-ingest tools) ---
PLEX_URL = _hostval("PLEX_API_SERVER_URL", "plex_api_server_url",
                    "https://plex.example.com").rstrip("/")
# Prefer an officially-minted token (PLEX_TOKEN); fall back to the legacy key name.
PLEX_TOKEN = os.environ.get("PLEX_TOKEN") or os.environ.get("PLEX_API_KEY", "")
# Stable client identifier used when minting per-account (managed-user) tokens. Must be
# consistent so the plex.tv switch → server-scoped access token exchange is repeatable.
PLEX_CLIENT_IDENTIFIER = os.environ.get("PLEX_CLIENT_IDENTIFIER", "plex-channels-helper")

# --- Fallback accounts for "watched"/"rewatchable" ---
# ONLY a default for a set that doesn't name its own `watch_count_accounts`. Every set
# currently does, so nothing uses this: each card reflects its OWN profile's history.
# Unioning across profiles was tried and reverted (2026-07-16) - it let Bob's viewing
# drive the kids' cards. Don't route a new set through this without a reason.
WATCH_COUNT_ACCOUNTS = [
    int(a) for a in os.environ.get(
        "WATCH_COUNT_ACCOUNTS", "1,11111111,22222222"
    ).split(",") if a.strip()
]

# --- Library section ids (verified live) ---
SEC_MOVIES = int(os.environ.get("PLEX_SEC_MOVIES", "1"))
# Documentaries are their own Plex section but count as "Movies" for the curated queues, so
# a doc (e.g. "The Story of Film") entered in a movie queue resolves (user, 2026-07-20).
SEC_DOCS = int(os.environ.get("PLEX_SEC_DOCS", "14"))
SEC_SHORTS = 15
SEC_SHOWS = 5
# SEC_ANIME (11) is intentionally EXCLUDED from both sets — the kids' channels draw
# from Shows + Shorts only (user decision 2026-07-08). Kept here for reference; do not
# add it back to any set's `episodic_sections` without an explicit new decision.
SEC_ANIME = 11

# --- Content-rating allow-lists (applied ON TOP of the account's own library view) ---
# Selection queries as the set's own managed-user account (plex.account_token), so that
# account's real restriction already applies; these lists cap it further. The cap is what
# makes the tiers DISJOINT: the Older Kids account can see the younger tier too, and only
# this list keeps the older card off it.
# TV shows use TV-*; movies/shorts use MPAA G/PG. Missing/None rating => excluded.
# Younger tier = the G/little-kid ratings. Includes the TV-made-movie equivalents (TV-G, and
# TV-Y/TV-Y7 which some kids MOVIES carry) so a made-for-TV G-level movie still counts.
RATINGS_YOUNGER = {"TV-Y", "TV-Y7", "TV-Y7-FV", "TV-G", "G"}
# The "older" set (Older Kids account) is the PG TIER ONLY: exactly PG / TV-PG, and NOT the
# younger ratings (the younger card already covers those; the two tiers are disjoint). Both the
# MPAA "PG" and the made-for-TV equivalent "TV-PG" are included, since some movies carry TV
# ratings. Same allow-list for TV shows, shorts, and movies.
RATINGS_OLDER = {"TV-PG", "PG"}

# --- Named cartoon "sets" (rating-filtered + optional per-show blocklist) ---
# episodic_sections: type=2 shows, each a bucket of ordered unwatched episodes.
# item_sections:     type=1 items (Shorts) — whole section is ONE shuffled bucket.
# blocklist:         ratingKeys to force OUT regardless of rating.
# account_id:        whose profile records watched-state (must match Shield sign-in).
SETS = {
    "younger": {
        "episodic_sections": [SEC_SHOWS],   # Shows only — anime excluded (2026-07-08)
        "item_sections": [SEC_SHORTS],
        "allowed_ratings": RATINGS_YOUNGER,
        "movie_ratings": RATINGS_YOUNGER,   # for the rewatch-movie card
        "blocklist": set(),
        # "Next episode" follows THIS profile's own history, not the household union:
        # counting Bob's watches opened shows mid-series that the kid had never started.
        "watch_count_accounts": [11111111],
        "plex_user": "Younger Kids",
        "account_id": 11111111,
        "user_uuid": "1111111111111111",
        "enabled": True,
    },
    "older": {
        "episodic_sections": [SEC_SHOWS],   # Shows only — anime excluded (2026-07-08)
        "item_sections": [SEC_SHORTS],
        "allowed_ratings": RATINGS_OLDER,         # PG tier only: PG / TV-PG (not younger)
        "movie_ratings": RATINGS_OLDER,           # movies: PG / TV-PG only
        "blocklist": set(),
        # Own history only — see the younger set's note.
        "watch_count_accounts": [22222222],
        "plex_user": "Older Kids",
        "account_id": 22222222,
        "user_uuid": "2222222222222222",
        "enabled": True,
    },
    # NOTE: the old "anime" set (source="ondeck", Bob's Continue-Watching channel) was
    # removed 2026-07-20 — retired for the three curated anime queues (decision
    # 2026-07-16-anime-queues-retire-ondeck-set) and finally deleted once every surface
    # (NFC card, input_button.plex_anime, voice sentences) was repointed to bob_anime.
    # Recover from git if a filtered/dynamic anime channel is ever wanted again.
}

# --- Curated-queue sets (source="queue") -------------------------------------- #
# Six hand-curated wishlists split by audience (movies against section 1, anime
# against section 11). Unlike every other set, the lineup is NOT computed by rule:
# Bob writes an ordered list of ratingKeys into queues.yaml (top = next to play),
# and the service plays the first not-finished entry and prunes finished ones. An
# entry is a MOVIE (plays once, leaves when watched) or a SERIES (plays its next
# unwatched episodes in order, leaves when fully watched). All run as Bob (admin
# token, watch_count_accounts=[1]) so only his own history prunes his queues, and
# carry no rating cap (manual curation replaces the filter).
# Decisions: 2026-07-16-movie-queue-sets-yaml-wishlist.md +
#            2026-07-16-anime-queues-retire-ondeck-set.md.
def _queue_set(sections):
    sections = list(sections)
    return {
        "source": "queue",
        "queue_sections": sections,         # Plex sections entries are resolved/scoped against
        "queue_section": sections[0],       # primary (back-compat / thumb scoping)
        "episodic_sections": sections,      # so config.set_sections()/_watched_for_set cover all
        "item_sections": [],
        "allowed_ratings": None,            # no rating cap: the curated list is the filter
        "movie_ratings": None,
        "blocklist": set(),
        "watch_count_accounts": [1],        # Bob only — keep the queues personal
        "plex_user": "Bob (admin)",
        "account_id": 1,
        "user_uuid": None,                  # None => admin PLEX_TOKEN (Bob)
        "enabled": True,
    }

# Movie queues resolve across Movies + Documentaries; anime queues across the Anime section.
for _name, _sections in (
    ("bob", [SEC_MOVIES, SEC_DOCS]), ("bob_alice", [SEC_MOVIES, SEC_DOCS]),
    ("family", [SEC_MOVIES, SEC_DOCS]),
    ("bob_anime", [SEC_ANIME]), ("bob_alice_anime", [SEC_ANIME]),
    ("family_anime", [SEC_ANIME]),
):
    SETS[_name] = _queue_set(_sections)

# --- Set registry file (sets.yaml) -------------------------------------------- #
# The dicts above are only the BUILT-IN DEFAULTS (and the disaster-recovery fallback).
# The live truth is /config/sets.yaml — written by the web UI (create/rename/delete
# queues, per-set library membership, rotation filters), seeded by the Node process on
# first boot, and re-read here before every MQTT command (service calls reload_sets) so
# a queue created in the browser is playable without a restart. Set `id`s are IMMUTABLE
# (HA/NFC/MQTT reference them); only labels rename.
SETS_PATH = os.environ.get("SETS_PATH", "/config/sets.yaml")

# Library membership is purely opt-in per set: every video library is eligible and a set
# draws only from the sections it lists. There is no global hide-then-opt-back-in list
# anymore (removed 2026-07-21 per Bob — "specify which libraries you want" beats hiding).
# Non-video libraries (Music, Photos) are excluded structurally, in plex.sections().

# File order of sets.yaml = the web Home page's shelf order.
SET_ORDER = list(SETS)


# --- Profile bindings (v3 PR 2) ----------------------------------------------- #
# A function channel works with one or more PROFILES; each profile binding carries that
# channel's per-profile rating caps + account identity. This replaces the single top-level
# binding the legacy `younger`/`older` sets encode. The channel-level fields (sections,
# item_sections, blocklist, kind, behavior) stay on the cfg; only the per-profile pieces
# below move into a binding. `_load_sets_yaml` ALWAYS synthesizes a `profiles` list (a
# legacy set becomes one binding from its top-level fields), so every rotation cfg carries
# `profiles`, and `binding_for()` picks the active one at play time. Decision:
# 2026-07-21-channels-function-first-generalized-members.md.
BINDING_KEYS = (
    "plex_user", "account_id", "user_uuid",
    "allowed_ratings", "movie_ratings", "watch_count_accounts", "movie_excludes",
)


def _binding_from(src):
    """Normalize one profile binding out of a dict (a legacy set entry OR a profiles[] item).

    Same coercions the legacy top-level reader used, so a synthesized binding is byte-for-byte
    equivalent to what a single-binding set produced before (rating sets, int accounts, etc.).
    """
    return {
        "plex_user": src.get("plex_user"),
        "account_id": src.get("account_id"),
        "user_uuid": src.get("user_uuid"),
        "allowed_ratings": set(map(str, src["allowed_ratings"])) if src.get("allowed_ratings") else None,
        "movie_ratings": set(map(str, src["movie_ratings"])) if src.get("movie_ratings") else None,
        "watch_count_accounts": [int(a) for a in (src.get("watch_count_accounts") or [])] or None,
        "movie_excludes": [str(x) for x in (src.get("movie_excludes") or [])],
    }


def binding_for(cfg, profile_title=None):
    """The active profile binding for a set: the one whose plex_user matches `profile_title`,
    else the first (default) binding. Falls back to synthesizing from cfg top-level for a
    hand-built cfg with no `profiles` (the built-in SETS dict / ultra-legacy). This is the
    single accessor every selection helper uses, so a legacy single-binding set always
    resolves to exactly its one binding — identical to pre-PR-2 behavior.
    """
    profiles = cfg.get("profiles")
    if not profiles:
        return _binding_from(cfg)
    if profile_title:
        for b in profiles:
            if b.get("plex_user") == profile_title:
                return b
    return profiles[0]


def channel_for(kind, profile_title):
    """Route a set:"auto" scan (card kind + detected Plex Home profile) to a function
    channel id, or None to fall back to the legacy PROFILE_SET_MAP (v3 PR 4).

    Only a channel that EXPLICITLY binds the profile qualifies: has_explicit_profiles
    (a real profiles[] array, not a synthesized legacy binding) and an exact plex_user
    match — so an unmapped profile (e.g. Bob scanning a kid card) still errors instead
    of silently landing on the default binding, and an un-migrated sets.yaml routes
    through PROFILE_SET_MAP unchanged. kind "movie" wants the behavior:rewatch channel;
    every other kind an episodic one. First match in SET_ORDER (file order) wins.
    """
    is_movie_kind = kind == "movie"
    for sid in SET_ORDER:
        cfg = SETS.get(sid) or {}
        if cfg.get("source") != "rotation" or not cfg.get("enabled"):
            continue
        if not cfg.get("has_explicit_profiles") or cfg.get("superseded_by"):
            continue
        is_rewatch = (cfg.get("behavior") or cfg.get("mode")) == "rewatch"
        if is_rewatch != is_movie_kind:
            continue
        for b in cfg.get("profiles") or []:
            if b.get("plex_user") == profile_title:
                return sid
    return None


def _load_sets_yaml():
    """Parse sets.yaml → (sets_dict, order), or None to keep defaults."""
    try:
        from ruamel.yaml import YAML
        with open(SETS_PATH, "r", encoding="utf-8") as f:
            data = YAML(typ="safe").load(f) or {}
    except FileNotFoundError:
        return None
    except Exception as e:  # noqa: BLE001 — malformed file: keep last-known-good sets
        print(f"[config] {SETS_PATH} unreadable ({e}); keeping current sets", flush=True)
        return None
    entries = data.get("sets") or []
    out, order = {}, []
    for ent in entries:
        if not isinstance(ent, dict):
            continue
        sid = str(ent.get("id") or "").strip()
        if not sid:
            continue
        sections = [int(s) for s in (ent.get("sections") or [])]
        if ent.get("source") == "rotation":
            # Profile bindings (v3 PR 2, back-compat reader): a channel carries a `profiles`
            # list of per-profile bindings. When absent (every legacy set), synthesize ONE
            # binding from the top-level fields — so `younger`/`older` keep working unchanged
            # until PR 4 migrates them. The DEFAULT binding (profiles[0]) is also mirrored to
            # the cfg top-level so any un-migrated reader still sees it.
            raw_profiles = ent.get("profiles")
            has_explicit_profiles = isinstance(raw_profiles, list) and any(
                isinstance(p, dict) for p in raw_profiles)
            if has_explicit_profiles:
                profiles = [_binding_from(p) for p in raw_profiles if isinstance(p, dict)]
            else:
                profiles = [_binding_from(ent)]
            default = profiles[0]
            cfg = {
                "source": "rotation",
                "episodic_sections": sections,
                "item_sections": [int(s) for s in (ent.get("item_sections") or [])],
                "blocklist": {str(b) for b in (ent.get("blocklist") or [])},
                # Explicit curated members (v3 PR 3): raw queues.yaml-style entries (a bare
                # ratingKey, a `Collection: <name>` string, or a {ratingKey,title,episodes}
                # mapping — queues._describe parses them). Non-empty => the channel's pool is
                # these members; [] / absent => the pure dynamic rule below.
                "members": list(ent.get("members") or []),
                "profiles": profiles,
                # PR 4 cutover flags: only a channel with a REAL profiles[] array (not a
                # synthesized legacy binding) may capture set:"auto" scans (channel_for);
                # superseded_by marks a legacy tier kept readable during the soak.
                "has_explicit_profiles": has_explicit_profiles,
                "superseded_by": str(ent["superseded_by"]) if ent.get("superseded_by") else None,
                # Top-level mirror of the default binding (back-compat with any reader that
                # still reads cfg[...] directly; plex.py uses binding_for()).
                "allowed_ratings": default["allowed_ratings"],
                "movie_ratings": default["movie_ratings"],
                "watch_count_accounts": default["watch_count_accounts"],
                "plex_user": default["plex_user"],
                "account_id": default["account_id"],
                "user_uuid": default["user_uuid"],
            }
        else:
            cfg = _queue_set(sections or [SEC_MOVIES])
            # A REEL is a curated queue that replays IN FULL every scan (never marks entries
            # done, keeps file order) — the theater DEMO channel. plex.build_reel handles it;
            # everything else about the set is a normal queue. See do_start's source branch.
            if ent.get("reel"):
                cfg["reel"] = True
        cfg["label"] = ent.get("label") or sid
        cfg["kind"] = ent.get("kind")
        cfg["enabled"] = ent.get("enabled", True)
        # §B.3 TTL auto-remove of completed entries: a per-set override of the global
        # REMOVE_COMPLETED_AFTER window (a duration string like "24h"/"7d"/"90m", or
        # "0"/"never" to disable), plus the keep_completed exemption (a set that keeps its
        # finished entries forever). Both are passed straight through to the cfg;
        # queues.sweep_completed interprets them (a `reel` set is exempt structurally).
        if ent.get("remove_completed_after") is not None:
            cfg["remove_completed_after"] = str(ent.get("remove_completed_after")).strip()
        if ent.get("keep_completed"):
            cfg["keep_completed"] = True
        # A set whose libraries only SOME Plex Home profiles can see (e.g. the demo reel
        # lives in Demos + Movie Clips, hidden from both kid profiles). do_start blocks
        # until the Shield is signed into this profile, so a scan on the wrong one waits
        # for the switch instead of silently failing to play. Exact profile title.
        if ent.get("requires_profile"):
            cfg["requires_profile"] = ent["requires_profile"]
        if ent.get("include_specials"):
            cfg["include_specials"] = True
        # v2 passthrough (applies to rotation AND queue sets):
        #   * mode           -> service.do_start branch: "rewatch" | "episodic" | "both"
        #                       (absent => infer from kind, back-compat) — workstream E.
        #   * audio_language -> playback selects that audio stream on queued items (e.g.
        #                       "jpn" for anime) — workstream I.
        #   * movie_excludes -> ratingKeys pulled from the rewatch/movie pool — workstream I.
        cfg["mode"] = ent.get("mode")
        # behavior (v3 PR 2) supersedes `mode`: progress = advance through unwatched
        # ("next episode"), rewatch = weighted least-watched replay. Absent => fall back to
        # the legacy `mode`/kind inference in service._do_start, so nothing regresses.
        cfg["behavior"] = ent.get("behavior")
        if ent.get("audio_language"):
            cfg["audio_language"] = str(ent["audio_language"]).strip()
        # movie_excludes is per-binding; the cfg top-level mirrors the DEFAULT binding (for a
        # rotation set the binding already carries it), and legacy queue sets keep the
        # top-level list they always had.
        if cfg.get("source") == "rotation":
            cfg["movie_excludes"] = list(cfg["profiles"][0]["movie_excludes"])
        else:
            cfg["movie_excludes"] = [str(x) for x in (ent.get("movie_excludes") or [])]
        # max_items -> per-scan session cap: play at most N items this scan, then stop
        # until the card is scanned again (a fresh do_start). service.do_start truncates
        # SESSION.queue to it; playback drops `continuous` so the client doesn't auto-roll
        # into related content after. Absent/<=0 => no cap (e.g. anime channels).
        try:
            _mi = int(ent.get("max_items"))
            cfg["max_items"] = _mi if _mi > 0 else None
        except (TypeError, ValueError):
            cfg["max_items"] = None
        out[sid] = cfg
        order.append(sid)
    if not out:
        return None
    return out, order


def reload_sets():
    """Refresh SETS/SET_ORDER from sets.yaml, in place.

    In-place (clear+update) so every module holding a `config.SETS` reference sees the
    fresh registry. No-op (defaults/last-good kept) when the file is absent or broken.
    """
    loaded = _load_sets_yaml()
    if loaded is None:
        return False
    sets_by_id, order = loaded
    SETS.clear()
    SETS.update(sets_by_id)
    SET_ORDER[:] = order
    return True


reload_sets()

# Curated-queue store: a hand-edited YAML wishlist in App-Configs, mounted RW here. Read on
# every scan; finished entries are pruned back out. See queues.py + the wishlist decision.
QUEUES_PATH = os.environ.get("QUEUES_PATH", "/config/queues.yaml")
# Episodes queued for a series entry per play, TV-style (it resumes next scan). DEFAULT is
# 1 (one episode, like a TV channel); a queue entry may override per-show with an `episodes:`
# field (e.g. Darker Than Black in pairs -> episodes: 2). QUEUE_SERIES_LENGTH is the hard
# safety cap so a bad override can't queue an entire series at once.
QUEUE_SERIES_DEFAULT = int(os.environ.get("QUEUE_SERIES_DEFAULT", "1"))
QUEUE_SERIES_LENGTH = int(os.environ.get("QUEUE_SERIES_LENGTH", "40"))
# --- Completed-entry TTL (§B.3) ------------------------------------------------ #
# Finished queue entries are kept + tagged `done: true`/`done_at:<epoch>` (queues.mark_done)
# instead of being pruned (decision 2026-07-21-finished-queue-entries-marked-done-not-pruned).
# This is the GLOBAL default window after which a done entry is auto-removed on the next scan;
# a set may override it with `remove_completed_after` in sets.yaml, and `keep_completed: true`
# or `reel: true` exempts a set entirely. A duration string ("24h"/"7d"/"90m"); "0"/"never"
# disables auto-removal fleet-wide. Parsed by queues.parse_duration.
REMOVE_COMPLETED_AFTER = os.environ.get("REMOVE_COMPLETED_AFTER", "24h")

def set_sections(cfg):
    """All library sections a set draws from (episodic + item)."""
    return list(cfg.get("episodic_sections", [])) + list(cfg.get("item_sections", []))


def rewatch_sections(cfg):
    """Libraries a behavior:rewatch channel pools from — ITS OWN, not the Movies library.

    The pool used to be hardwired to SEC_MOVIES, so the channel's library checkboxes were
    stored and ignored and Documentaries/Anime films could never surface (decision
    2026-07-29-rewatch-pool-follows-the-channels-own-libraries). It is now every library
    the channel names: movie libraries land in `item_sections`, show libraries in
    `episodic_sections` (a show library contributes its ONE-EPISODE entries — that is how
    anime films are stored). Empty => SEC_MOVIES, so a channel that names none behaves as
    it always did.

    Only for behavior:rewatch. A legacy tier (`younger`/`older`, no behavior) draws its
    SHOWS from those same fields, so its movie card stays on SEC_MOVIES.
    """
    if (cfg.get("behavior") or cfg.get("mode")) != "rewatch":
        return [SEC_MOVIES]
    secs = list(dict.fromkeys(
        [int(s) for s in (cfg.get("item_sections") or [])]
        + [int(s) for s in (cfg.get("episodic_sections") or [])]
    ))
    return secs or [SEC_MOVIES]

# Movie card also plays under the Kids profile in v1.
MOVIE_SET_DEFAULT = "younger"

# Rotation queue length (episodes queued per cartoons session).
ROTATION_LENGTH = int(os.environ.get("ROTATION_LENGTH", "12"))

# --- Playback target (the Family Room theater Shield) ---
# PLAYBACK_MODE:
#   "cast"   -> Plex Cast to the Shield's Google-Cast receiver AS the set's account token.
#              This is the deterministic per-account path: the receiver plays under the
#              token it's handed, so the watch records on the RIGHT account (Kids / Alice)
#              no matter which user the Shield's Plex app is signed into. (Needs SHIELD_CAST_NAME.)
#   "client" -> remote-control the Shield's Plex app via playMedia. Simpler, but the watch
#              records under whatever user that app is signed into — use only if the app is
#              signed into the matching account.
PLAYBACK_MODE = os.environ.get("PLAYBACK_MODE", "cast")
# Google-Cast friendly name of the theater Shield (as it advertises on the LAN).
SHIELD_CAST_NAME = _hostval("SHIELD_CAST_NAME", "shield_cast_name", "Family Room SHIELD")
# Used by the "client" mode only.
SHIELD_CLIENT_MACHINE_ID = _hostval("SHIELD_CLIENT_MACHINE_ID", "shield_client_machine_id", "")
SHIELD_CLIENT_NAME = _hostval("SHIELD_CLIENT_NAME", "shield_client_name", "Family Room SHIELD")
# Direct Plex Companion endpoint of the Shield (http://<ip>:32500). Blank = resolve it from
# plex.tv's device list at runtime, which is the normal path — see playback.find_client.
SHIELD_CLIENT_URI = _hostval("SHIELD_CLIENT_URI", "shield_client_uri", "")
# LAN address of the Plex server, handed to the client in playMedia so it knows where to
# stream from. Must be reachable FROM the Shield (not from this container).
PLEX_LOCAL_URL = _hostval("PLEX_LOCAL_URL", "plex_local_url",
                          "http://192.0.2.10:32400").rstrip("/")

# --- Profile-driven set selection (set="auto") ---
# The signed-in Plex Home profile on the Shield decides the tier; cards carry only the
# KIND (cartoons/movie). Detection reads the PMS DEBUG log (see profiles.py) - the log
# volume must be mounted read-only at PMS_LOG_PATH's parent.
PMS_LOG_PATH = os.environ.get("PMS_LOG_PATH", "/pms-logs/Plex Media Server.log")
SHIELD_IP = _hostval("SHIELD_IP", "shield_ip", "192.0.2.30")
PROFILE_WAIT_SECONDS = int(os.environ.get("PROFILE_WAIT_SECONDS", "120"))
# Plex Home profile title -> set name. Titles must match plex.tv exactly.
PROFILE_SET_MAP = json.loads(os.environ.get(
    "PROFILE_SET_MAP", '{"Younger Kids": "younger", "Older Kids": "older"}'
))

# --- ADB profile switching (see adb.py) ---
# Closes the loop on a profile gate: instead of only waiting for a human to pick the
# profile on screen, drive the Shield's picker with D-pad events. OFF by default - it
# injects key events into whatever is on the family TV, so it must be opted into
# explicitly (and adb.py guards hard before every press).
ADB_ENABLED = os.environ.get("ADB_ENABLED", "").lower() in ("1", "true", "yes")
ADB_BIN = os.environ.get("ADB_BIN", "adb")
ADB_TARGET = os.environ.get("ADB_TARGET", f"{SHIELD_IP}:5555")
# The Shield only trusts adb keys it has been shown once, via an on-TV prompt. A fresh
# container generates a NEW key and would sit unauthorized with no way to accept it, so
# point this at the already-authorized private key (mounted, NOT baked into the image).
ADB_KEY_PATH = os.environ.get("ADB_KEY_PATH", "/config/.android/adbkey")
# Picker order. DERIVED from plex.tv `/api/v2/home/users`, whose order matches the
# on-screen picker (confirmed 2026-07-26) - not hand-maintained, so adding or removing a
# Home user can't silently leave it stale. Cached to disk so a plex.tv outage doesn't cost
# the ability to switch. Set the env var only as a manual override; empty = derive.
ADB_PROFILE_ORDER = json.loads(os.environ.get("ADB_PROFILE_ORDER", "[]"))
ADB_PROFILE_ORDER_CACHE = os.environ.get(
    "ADB_PROFILE_ORDER_CACHE", "/config/profile-order.json")
ADB_PROFILE_ORDER_TTL = int(os.environ.get("ADB_PROFILE_ORDER_TTL", "3600"))
# Hard bound on D-pad presses before giving up - never spin on a UI that changed.
ADB_MAX_PRESSES = int(os.environ.get("ADB_MAX_PRESSES", "12"))
# How long to keep looking for the picker to appear (the HA script foregrounds Plex
# AFTER publishing the start command, so the picker lags the scan by a few seconds).
ADB_PICKER_WAIT_SECONDS = int(os.environ.get("ADB_PICKER_WAIT_SECONDS", "45"))
# Once Plex is signed in there is NO picker to drive - foregrounding the app lands on
# HomeActivityTV (verified 2026-07-26), so a wrong-profile card could never self-switch.
# A force-stop + relaunch cold-starts the app straight back to the picker. Only ever done
# when a switch is actually needed and the grace period found no picker; it does kill
# whatever Plex was playing, which is why it is a knob.
ADB_RESTART_TO_PICKER = os.environ.get(
    "ADB_RESTART_TO_PICKER", "true").lower() in ("1", "true", "yes")
ADB_TIMEOUT = int(os.environ.get("ADB_TIMEOUT", "15"))
# How long to wait for Plex to reach the foreground after we launch it over ADB. Companion
# playback (:32500) and the picker both need Plex running, so a scan blocks on this.
ADB_PLEX_LAUNCH_WAIT_SECONDS = int(os.environ.get("ADB_PLEX_LAUNCH_WAIT_SECONDS", "20"))

# --- MQTT (Mosquitto HA add-on) ---
MQTT_HOST = os.environ.get("MQTT_HOST", "")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "1883"))
MQTT_USER = os.environ.get("MQTT_USER") or None
MQTT_PASS = os.environ.get("MQTT_PASS") or None

T_CMD_START = os.environ.get("T_CMD_START", "plex-channels/cmd/session/start")
T_CMD_ADVANCE = os.environ.get("T_CMD_ADVANCE", "plex-channels/cmd/session/advance")
T_CMD_SOUNDTRACK = os.environ.get("T_CMD_SOUNDTRACK", "plex-channels/cmd/soundtrack/resolve")
# Rotation-channel preview (the web UI's Channels view): request carries a `reply` topic
# under T_RESP_PREVIEW_BASE; the computed pool is published there (request/response).
T_CMD_PREVIEW = os.environ.get("T_CMD_PREVIEW", "plex-channels/cmd/generic/preview")
T_RESP_PREVIEW_BASE = os.environ.get("T_RESP_PREVIEW_BASE", "plex-channels/resp/preview")
T_RESP_LAST_PLAYED = os.environ.get("T_RESP_LAST_PLAYED", "plex-channels/resp/last-played")
T_RESP_SOUNDTRACK = os.environ.get("T_RESP_SOUNDTRACK", "plex-channels/resp/soundtrack")
T_STATE = os.environ.get("T_STATE", "plex-channels/state")
# MQTT discovery: HA creates sensor.plex_channels_status from T_STATE on its own.
T_DISCOVERY_BASE = os.environ.get("T_DISCOVERY_BASE", "homeassistant")
DISCOVERY_OBJECT_ID = os.environ.get("DISCOVERY_OBJECT_ID", "plex_channels_status")

# --- Device registry (the web UI's "Play on <device>" dropdown) ---
# The service announces castable targets as RETAINED plex-channels/devices/<id> messages:
# the env-default Shield plus every plex.tv device advertising as a player. A start
# command may then carry {"target": "<id>"} to override the default Shield.
T_DEVICES_BASE = os.environ.get("T_DEVICES_BASE", "plex-channels/devices")
DEVICE_ANNOUNCE_SECONDS = int(os.environ.get("DEVICE_ANNOUNCE_SECONDS", "300"))

# --- Soundtrack resolver (Living-Room-reader easter egg) ---
MA_URL = os.environ.get("MA_URL", "")            # Music Assistant base URL (optional)
MA_TOKEN = os.environ.get("MA_TOKEN", "")
OLLAMA_URL = os.environ.get("OLLAMA_URL", "")    # e.g. http://192.0.2.10:11434
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "gemma3:4b")
