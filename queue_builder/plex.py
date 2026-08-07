"""Read-only Plex queries + selection logic.

Mirrors the verified music-ingest pattern (raw urllib + X-Plex-Token, TLS
unverified for the self-signed cert). Everything here is READ-ONLY and fully
testable against the live server without touching playback — that's Phase 1.

Key facts that shape this module:
  * viewCount/viewedAt on /library/sections/* reflect the ADMIN account only, so
    per-kid watched state MUST come from /status/sessions/history/all?accountID=.
  * "watched" is per-SET: each set names its own `watch_count_accounts`, so a card only
    ever reflects its own profile's history (see _watched_for_set).
  * episodes enumerate flat + ordered via /library/metadata/<showRK>/allLeaves.
"""
import json
import ssl
import urllib.parse
import urllib.request

from . import config, queues

# --------------------------------------------------------------------------- #
# Shared "is this a real episode?" predicate (decision
# 2026-08-07-specials-count-excludes-op-ed-trailer-extras, REFINES 2026-07-17).
#
# The owner's library encodes an item's kind in the SEASON-0 episode INDEX (Plex
# `parentIndex == 0`, `index` = the number). That deterministic range — NOT any duration/title
# heuristic — is the rule:
#   * index 1-99    -> regular specials (e.g. an OAD)      -> INCLUDE (count + eligible)
#   * index 100-199 -> unspecified                          -> INCLUDE (conservative; owner to confirm)
#   * index 200-299 -> trailers                             -> EXCLUDE
#   * index 300-399 -> openings/endings (OP/ED theme songs) -> EXCLUDE (this inflated "25/29")
#   * index 400-499 -> "other"                              -> INCLUDE (meant to be played)
# So a Season-0 leaf is an extra exactly when 200 <= index <= 399. Real seasons (>=1) are never
# extras. Plex Extras/clips (a `clip` type or an `extraType`) are excluded too, if any appear.
# --------------------------------------------------------------------------- #
_S0_EXTRA_INDEX_MIN = 200  # trailers (200-299) + OP/ED (300-399)
_S0_EXTRA_INDEX_MAX = 399


def is_extra_or_promo(ep):
    """True if `ep` is a Plex Extra/clip, or a Season-0 trailer/OP/ED (index 200-399).

    Mirrors plex.js `isExtraOrPromo`. A regular Season-0 special (index outside 200-399) does NOT
    match, so it still counts and still resolves. `ep` may be a raw Plex Metadata row
    (`parentIndex`/`index`) or a normalised show_episodes() dict (`season`/`episode`).
    """
    if not ep:
        return False
    if ep.get("type") == "clip":
        return True
    if ep.get("extraType"):
        return True
    season = ep.get("season", ep.get("parentIndex"))
    if str(season) == "0":
        raw = ep.get("index", ep.get("episode"))
        try:
            idx = int(raw)
        except (TypeError, ValueError):
            idx = None
        if idx is not None and _S0_EXTRA_INDEX_MIN <= idx <= _S0_EXTRA_INDEX_MAX:
            return True
    return False

_CTX = ssl.create_default_context()
_CTX.check_hostname = False
_CTX.verify_mode = ssl.CERT_NONE

# --------------------------------------------------------------------------- #
# Corpus record / replay (D3 engine-parity oracle, decision 2026-08-03).
#
# With config.PLEX_RECORD_DIR set, every read-only response is written to disk keyed by
# (kind, path, token-alias); with config.PLEX_REPLAY_DIR set, those recordings are served
# instead of the network so a run is deterministic offline. The corpus is the FIXED oracle the
# Node selection engine is diffed against — the Node engine.parity harness replays the SAME
# files. Tokens are never stored: files are bucketed by a stable alias ("admin"/"acct:<uuid>"),
# and plex.tv bodies are redacted before writing.
# --------------------------------------------------------------------------- #
import hashlib
import os

_TOKEN_ALIAS = {}  # raw token -> stable alias, so an account's calls bucket by uuid not secret


def _token_alias(token):
    tok = token or config.PLEX_TOKEN
    if not tok or tok == config.PLEX_TOKEN:
        return "admin"
    return _TOKEN_ALIAS.get(tok, "tok-" + hashlib.sha1(tok.encode()).hexdigest()[:8])


def _corpus_path(base, kind, path, token):
    h = hashlib.sha1(path.encode("utf-8")).hexdigest()[:16]
    return os.path.join(base, kind, _token_alias(token), h + ".json")


_SECRET_KEYS = {"authToken", "token", "accessToken", "X-Plex-Token"}


def _redact(obj):
    """Deep copy with any token-ish value replaced — corpus files never store a live secret."""
    if isinstance(obj, dict):
        return {k: ("REDACTED" if k in _SECRET_KEYS else _redact(v)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_redact(v) for v in obj]
    return obj


def _corpus_record(kind, path, token, data):
    p = _corpus_path(config.PLEX_RECORD_DIR, kind, path, token)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        json.dump({"kind": kind, "path": path, "alias": _token_alias(token),
                   "data": _redact(data) if kind == "plextv" else data}, f, ensure_ascii=False)


def _corpus_replay(kind, path, token):
    p = _corpus_path(config.PLEX_REPLAY_DIR, kind, path, token)
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)["data"]
    except FileNotFoundError:
        raise RuntimeError(
            f"corpus miss: {kind} {path} (alias {_token_alias(token)}) — re-record with PLEX_RECORD_DIR")


def _get(path, token=None):
    """GET a Plex JSON endpoint. `path` may include a query string."""
    if config.PLEX_REPLAY_DIR:
        return _corpus_replay("get", path, token)
    url = config.PLEX_URL + path
    req = urllib.request.Request(
        url,
        headers={"X-Plex-Token": token or config.PLEX_TOKEN, "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120, context=_CTX) as r:
        data = json.load(r)
    if config.PLEX_RECORD_DIR:
        _corpus_record("get", path, token, data)
    return data


def _container(path, token=None):
    return _get(path, token).get("MediaContainer", {})


def machine_identifier():
    """The server's machineIdentifier (needed to build playQueue URIs)."""
    return _container("/").get("machineIdentifier", "")


# --------------------------------------------------------------------------- #
# Per-account (managed-user) tokens
# --------------------------------------------------------------------------- #
_ACCOUNT_TOKENS = {}  # user_uuid -> server-scoped access token


def _plextv(path, token, method="GET"):
    """Call plex.tv (not the local server) with a stable client identifier."""
    if config.PLEX_REPLAY_DIR:
        return _corpus_replay("plextv", f"{method} {path}", token)
    req = urllib.request.Request(
        "https://plex.tv" + path, method=method,
        headers={"X-Plex-Token": token,
                 "X-Plex-Client-Identifier": config.PLEX_CLIENT_IDENTIFIER,
                 "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60, context=_CTX) as r:
        body = r.read().decode() or ""
        data = json.loads(body) if body else {}
    if config.PLEX_RECORD_DIR:
        _corpus_record("plextv", f"{method} {path}", token, data)
    return data


_COMPANION_TARGET = {}  # cache: name/machine-id -> {"name", "machineIdentifier", "uri"}


def companion_target(name, machine_id=""):
    """Resolve a player's DIRECT Plex Companion endpoint (http://<ip>:32500) via plex.tv.

    The local server's /clients only lists players it found by GDM broadcast, which never
    reaches the Shield here (it stays empty even with the Plex app open), so anything that
    relies on it wrongly concludes "no client". plex.tv tracks the device's advertised
    connection regardless of discovery, so ask it instead and talk to the player directly.
    Returns None if the device isn't listed. Cached per key.
    """
    key = machine_id or name
    if key in _COMPANION_TARGET:
        return _COMPANION_TARGET[key]
    try:
        devices = _plextv("/api/v2/devices", config.PLEX_TOKEN)
    except Exception:  # noqa: BLE001 — network/plex.tv hiccup: caller falls back
        return None
    for d in devices or []:
        if "player" not in (d.get("provides") or ""):
            continue
        if machine_id and d.get("clientIdentifier") != machine_id:
            continue
        if not machine_id and d.get("name") != name:
            continue
        uri = next((c.get("uri") for c in (d.get("connections") or []) if c.get("uri")), None)
        if not uri:
            continue
        target = {"name": d.get("name"), "machineIdentifier": d.get("clientIdentifier"), "uri": uri}
        _COMPANION_TARGET[key] = target
        return target
    return None


def home_user_names():
    """Plex Home profiles in plex.tv's order (= the picker's order), as ALIAS groups.

    Each entry is the set of strings that profile can legitimately be called, because the
    three places we read a profile name from do NOT agree on one:

      * plex.tv `/api/v2/home/users` -> `title` ("Bob Smith")
      * the on-screen picker tile    -> the OWNER's username ("sawtaytoes"), titles for
                                        everyone else
      * the PMS log's Signed-in Token stamp -> same split as the picker

    Matching on `title` alone is what made every switch STARTING from the owner's profile
    fail with "not in the picker order": the dump read 'sawtaytoes', the order held
    'Bob Smith', and `_offset` could not place either end. Rather than encode the
    owner-vs-managed rule (observed on two profiles, and Plex's to change), carry every
    alias and let callers match any of them - no two Home users here share one.

    Order is what matters and is preserved; confirmed against the on-screen picker
    2026-07-26. Raises on any plex.tv failure - callers decide whether to fall back to a
    cache (see adb.profile_order).
    """
    r = _plextv("/api/v2/home/users", config.PLEX_TOKEN)
    users = (r or {}).get("users") or []
    out = []
    for u in users:
        # dict-not-set: insertion order makes the title the display name below.
        names = list({n: None for n in (u.get("title"), u.get("friendlyName"),
                                        u.get("username")) if n})
        if names:
            out.append(names)
    return out


def player_devices():
    """Every plex.tv device advertising as a player: [{name, machineIdentifier, uri}].

    Feeds the MQTT device registry (the web UI's "Play on ▾" dropdown). uri may be None
    for a player with no advertised connection (still castable by name in cast mode).
    """
    devices = _plextv("/api/v2/devices", config.PLEX_TOKEN)
    out = []
    for d in devices or []:
        if "player" not in (d.get("provides") or ""):
            continue
        uri = next((c.get("uri") for c in (d.get("connections") or []) if c.get("uri")), None)
        out.append({"name": d.get("name"), "machineIdentifier": d.get("clientIdentifier"), "uri": uri})
    return out


def account_token(user_uuid):
    """Server-scoped access token for a managed user — usable against THIS local server.

    The raw plex.tv switch token 401s locally; the per-server accessToken from
    /api/v2/resources does not. Using it makes selection see exactly that account's
    restricted library, and makes playback record watched-state under THAT account
    (not admin — the user keeps their own history separate). Cached per uuid.
    """
    if not user_uuid:
        return None
    if user_uuid in _ACCOUNT_TOKENS:
        return _ACCOUNT_TOKENS[user_uuid]
    if config.PLEX_REPLAY_DIR:
        # Offline: skip the plex.tv token dance (its bodies are redacted in the corpus). Hand
        # back a synthetic token whose alias matches the account's recorded _get bucket.
        tok = f"replay-acct-{user_uuid}"
        _TOKEN_ALIAS[tok] = f"acct:{user_uuid}"
        _ACCOUNT_TOKENS[user_uuid] = tok
        return tok
    switch = _plextv(f"/api/v2/home/users/{user_uuid}/switch", config.PLEX_TOKEN, method="POST")
    auth = switch.get("authToken")
    if not auth:
        return None
    resources = _plextv("/api/v2/resources?includeHttps=1", auth)
    rows = resources if isinstance(resources, list) else resources.get("resources", [])
    mid = machine_identifier()
    for r in rows:
        if r.get("clientIdentifier") == mid:
            access = r.get("accessToken")
            _ACCOUNT_TOKENS[user_uuid] = access
            # Bucket this account's subsequent _get recordings by uuid, not by the secret token.
            if config.PLEX_RECORD_DIR and access:
                _TOKEN_ALIAS[access] = f"acct:{user_uuid}"
            return access
    return None


# --------------------------------------------------------------------------- #
# History  →  watched sets and view-count tallies
# --------------------------------------------------------------------------- #
def _iter_history(account_id, section_id=None, page=500):
    """Yield every history row for one account (optionally one library section)."""
    start = 0
    while True:
        q = {
            "accountID": account_id,
            "X-Plex-Container-Start": start,
            "X-Plex-Container-Size": page,
            "sort": "viewedAt:desc",
        }
        if section_id is not None:
            q["librarySectionID"] = section_id
        mc = _container("/status/sessions/history/all?" + urllib.parse.urlencode(q))
        rows = mc.get("Metadata", [])
        for row in rows:
            yield row
        start += len(rows)
        total = mc.get("totalSize", mc.get("size", 0))
        if not rows or start >= total:
            break


# --------------------------------------------------------------------------- #
# Library enumeration (contentRating-filtered = the Kids-account lockdown)
# --------------------------------------------------------------------------- #
def _rating_ok(item, allowed):
    # allowed=None => no content-rating cap (e.g. the adult "anime" set).
    if allowed is None:
        return True
    return str(item.get("contentRating")) in allowed


def episodic_shows(sections, allowed, blocklist=frozenset(), token=None):
    """Shows (type=2) across `sections`, kept only if their contentRating is allowed.

    With a per-account `token`, the section listing is already the account's restricted
    view; the contentRating filter then applies the set's (possibly stricter) cap on top.
    """
    shows = []
    for sec in sections:
        mc = _container(f"/library/sections/{sec}/all?type=2&X-Plex-Container-Size=5000", token)
        for s in mc.get("Metadata", []):
            rk = str(s.get("ratingKey"))
            if rk in blocklist or not _rating_ok(s, allowed):
                continue
            shows.append({"ratingKey": rk, "title": s.get("title"), "section": sec})
    return shows


def section_items(sections, allowed, blocklist=frozenset(), token=None):
    """Standalone items (type=1, e.g. Shorts) across `sections`, rating-filtered."""
    items = []
    for sec in sections:
        mc = _container(f"/library/sections/{sec}/all?type=1&X-Plex-Container-Size=10000", token)
        for m in mc.get("Metadata", []):
            rk = str(m.get("ratingKey"))
            if rk in blocklist or not _rating_ok(m, allowed):
                continue
            items.append({"ratingKey": rk, "title": m.get("title"), "section": sec})
    return items


def _int0(v):
    """int(v), or 0 for None / a non-numeric value. Plex OMITS viewCount when it is 0, so a
    MISSING viewCount reads as 0 = UNWATCHED here — never as watched (the resume-in-queue bug)."""
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


def show_episodes(show_rating_key, token=None):
    """Ordered flat episode list for a show (allLeaves), season/episode preserved.

    Each leaf also carries `viewCount` and `viewOffset` (ms) as Plex reports them under this
    token's account — the raw signal an in-progress leaf resumes from. viewCount is coerced
    through _int0, so an ABSENT viewCount (Plex omits it at 0) is 0 = unwatched, not watched.
    """
    mc = _container(f"/library/metadata/{show_rating_key}/allLeaves", token)
    eps = []
    for e in mc.get("Metadata", []):
        eps.append({
            "ratingKey": str(e.get("ratingKey")),
            "title": e.get("title"),
            "show": e.get("grandparentTitle"),
            "season": e.get("parentIndex"),
            "episode": e.get("index"),
            "duration": e.get("duration"),
            # Carried so is_extra_or_promo can drop Plex Extras/clips (a `clip` type or an
            # `extraType`) from both the count and the play list.
            "type": e.get("type"),
            "extraType": e.get("extraType"),
            "viewCount": _int0(e.get("viewCount")),
            "viewOffset": _int0(e.get("viewOffset")),
        })
    return eps


def _at_or_after_start(ep, start):
    """False if `ep` sorts BEFORE the manual start floor {season, episode}, else True.

    Lets a show begin at a chosen episode — earlier ones are skipped from the pick but NOT
    marked watched on Plex (resume a show seen elsewhere, or skip a saga). No start => True.
    Season defaults to 1 (the single-season anime case stores the sole season anyway).
    """
    if not start or start.get("episode") is None:
        return True   # no start, or a collection start that only names a member series

    def _i(v, d=0):
        try:
            return int(v)
        except (TypeError, ValueError):
            return d

    return (_i(ep.get("season")), _i(ep.get("episode"))) >= (_i(start.get("season"), 1),
                                                              _i(start.get("episode"), 1))


def _multi_season(all_eps):
    """True if a show spans more than one real season (S0 specials don't count).

    Drives the "hide S1 on single-season shows" tile label — every anime is one season, so
    its "S1" is noise. `all_eps` is a show_episodes() list (each carries `season`).
    """
    seasons = {str(e.get("season")) for e in all_eps if str(e.get("season")) not in ("None", "0")}
    return len(seasons) > 1


def movie_title(rating_key):
    mc = _container(f"/library/metadata/{rating_key}")
    md = mc.get("Metadata", [{}])
    return md[0].get("title") if md else None


# --------------------------------------------------------------------------- #
# The rewatch pool: what a behavior:rewatch channel may replay
# --------------------------------------------------------------------------- #
_SECTION_KINDS = {}  # section id (str) -> Plex library type ("movie" | "show" | …)


def section_kind(section):
    """Plex library type of a section — "movie", "show", … . One call, then cached."""
    if not _SECTION_KINDS:
        for d in _container("/library/sections").get("Directory", []):
            _SECTION_KINDS[str(d.get("key"))] = d.get("type")
    return _SECTION_KINDS.get(str(section))


def _movie_films(section, allowed, token=None):
    """{ratingKey: title} for a MOVIE library's rating-allowed films.

    With a per-account `token` the listing is that account's restricted view; `allowed`
    then applies any stricter per-channel ceiling (e.g. older tier movies = PG only).
    """
    mc = _container(f"/library/sections/{section}/all?type=1&X-Plex-Container-Size=10000", token)
    return {str(m.get("ratingKey")): m.get("title")
            for m in mc.get("Metadata", []) if _rating_ok(m, allowed)}


def _show_films(section, allowed, token=None):
    """{showRatingKey: title} for a SHOW library's ONE-EPISODE entries — its films.

    An anime film is scanned as a single-episode series (`Black Jack: The Movie`), not as a
    movie, so a rewatch channel pointed at a show library means exactly those — never a real
    multi-episode series. leafCount is the whole-series episode count, so ==1 is "one file".
    """
    mc = _container(f"/library/sections/{section}/all?type=2&X-Plex-Container-Size=5000", token)
    return {str(s.get("ratingKey")): s.get("title")
            for s in mc.get("Metadata", [])
            if s.get("leafCount") == 1 and _rating_ok(s, allowed)}


def rewatch_counts(sections, allowed, accts=None, token=None):
    """(counts, titles) for every rewatchable item in `sections` these accounts have SEEN.

    History has one row per completed view, so counts[rk] is that account set's view count
    — and because the pool IS the history, the "seen at least once" floor is structural: an
    unwatched film simply never appears (the kids never get a FIRST watch without the user).

    The key is what actually PLAYS: a film's own ratingKey from a movie library, and for a
    show library the single EPISODE inside a one-episode series, recovered from the history
    row's grandparentKey — so the pool costs one listing + one history walk per section and
    never an allLeaves fetch per show.
    """
    counts, titles = {}, {}
    for sec in sections:
        is_show = section_kind(sec) == "show"
        films = (_show_films if is_show else _movie_films)(sec, allowed, token=token)
        if not films:
            continue
        for acct in (accts or config.WATCH_COUNT_ACCOUNTS):
            for row in _iter_history(acct, section_id=sec):
                rk = str(row.get("ratingKey"))
                if is_show:
                    show_rk = str(row.get("grandparentKey") or "").rsplit("/", 1)[-1]
                    if show_rk not in films:
                        continue
                    titles[rk] = films[show_rk]
                elif rk in films:
                    titles[rk] = films[rk]
                else:
                    continue
                counts[rk] = counts.get(rk, 0) + 1
    return counts, titles


# --------------------------------------------------------------------------- #
# Selection: cartoon rotation + rewatch movie
# --------------------------------------------------------------------------- #
def _expanded_blocklist(cfg, token=None):
    """The set's blocklist as concrete ratingKeys to drop from the pool.

    Each entry is either a bare **ratingKey** (block that one show/item) or a
    **"Collection: <name>"** string (block the WHOLE collection — expand it to every member's
    ratingKey via find_collection + collection_children). The collection is searched across
    the set's sections: a shows collection contributes show ratingKeys (episodic_shows then
    drops the whole show), a shorts collection contributes item ratingKeys (dropped in
    section_items). So excluding "So You Want… Shorts" removes every one of its shorts at once.
    Unresolvable collection names are skipped (never crash a scan).
    """
    out = set()
    sections = None
    for entry in cfg.get("blocklist") or ():
        s = str(entry).strip()
        if not s.lower().startswith("collection:"):
            out.add(s)
            continue
        name = s.split(":", 1)[1].strip()
        if not name:
            continue
        if sections is None:
            sections = config.set_sections(cfg) or []
        for sec in sections:
            crk = find_collection(sec, name, token=token)
            if crk:
                for ch in collection_children(crk, token=token):
                    out.add(str(ch.get("ratingKey")))
                break
    return frozenset(out)


def unwatched_buckets(set_name, rng=None, binding=None):
    """Per-bucket ordered lists of NOT-yet-watched items for a set.

    Two bucket kinds:
      * episodic show  -> its ordered unwatched episodes (allLeaves order).
      * an item section (Shorts) -> ONE bucket of unwatched items, shuffled (no
        inherent order), so the rotation sprinkles shorts between real shows.
    Returns [{show, ratingKey, episodes:[...]}] for buckets with >=1 unwatched.

    `binding` selects which profile's ratings/account/history apply (v3 PR 2); default =
    the set's first/synthesized binding, so a legacy single-binding set is unchanged.
    """
    import random as _random
    rng = rng or _random
    cfg = config.SETS[set_name]
    b = binding or config.binding_for(cfg)
    allowed = b["allowed_ratings"]
    # Library view = the binding's own account (its real restriction); watched = that SAME
    # account's own history, so "next episode" tracks this profile's progress and nobody
    # else's. See _watched_for_set for why the global union is wrong here.
    tok = account_token(b.get("user_uuid"))
    watched = _watched_for_set(cfg, b)

    # A blocklist entry may be a ratingKey OR a "Collection: <name>" — expand collections to
    # their members so the whole collection drops out of both the show and the item scan.
    blocked = _expanded_blocklist(cfg, token=tok)

    # Per-show manual start floors (decision 2026-08-07-dynamic-pool-start-override): a
    # ratingKey -> {season, episode} map that lets a rule-pool show begin at a chosen
    # episode. Applied here so BOTH this preview and the play path (channel_buckets ->
    # unwatched_buckets) skip earlier episodes — without marking them watched on Plex.
    starts = cfg.get("starts") or {}

    buckets = []
    # Episodic shows: one bucket each.
    for show in episodic_shows(cfg["episodic_sections"], allowed, blocked, token=tok):
        all_eps = show_episodes(show["ratingKey"], token=tok)
        start = starts.get(str(show["ratingKey"]))
        eps = [e for e in all_eps
               if e["ratingKey"] not in watched and _at_or_after_start(e, start)]
        if eps:
            buckets.append({"show": show["title"], "ratingKey": show["ratingKey"],
                            "episodes": eps, "multi_season": _multi_season(all_eps)})
    # Item sections (Shorts): one shuffled bucket per section.
    for sec in cfg.get("item_sections", []):
        items = [
            {"ratingKey": it["ratingKey"], "title": it["title"], "show": "Shorts",
             "season": None, "episode": None}
            for it in section_items([sec], allowed, blocked, token=tok)
            if it["ratingKey"] not in watched
        ]
        if items:
            rng.shuffle(items)
            buckets.append({"show": "Shorts", "ratingKey": f"section-{sec}", "episodes": items})
    return buckets


# Back-compat alias used by earlier callers/tests.
def unwatched_by_show(set_name):
    return unwatched_buckets(set_name)


# --------------------------------------------------------------------------- #
# Episode-selection helpers (shared by the curated queues + the kid rotations)
# --------------------------------------------------------------------------- #
def _has_real_seasons(all_eps):
    """True if a show has any NON-special season (>= 1).

    A show whose only leaves are Season 0 is a pure OAD / film-scanned-as-single-episode
    series (e.g. "Prison School: Mad Wax") — its "special" IS the whole show. Such a show has
    NO real seasons, so the queue path must NOT drop its sole leaf as a front-loading special
    (that mis-marked it finished and stuck it `done: true` while the owner was mid-episode).
    """
    return any(str(e.get("season")) not in ("0", "None", "") for e in all_eps)


def _in_progress(view_offset, view_count):
    """True if a leaf/item is RESUMABLE: started (viewOffset > 0) and NOT finished.

    "Not finished" is viewCount < 1 — and because Plex OMITS viewCount at 0, a MISSING/None
    viewCount counts as 0 here (via _int0), so a partial view is never mistaken for watched.
    This is the single predicate behind resume + the "don't mark an in-progress item done" fix.
    """
    return (_int0(view_offset) > 0) and (_int0(view_count) < 1)


def _keep_episode(ep, cfg, specials_ok=False):
    """Filter out extras, specials, and unplayable items.

    * Plex **Extras / trailers / OP-ED** (is_extra_or_promo) never play — a clip or `extraType`,
      or a Season-0 leaf whose index is 200-399 (trailers / openings-endings). Dropped even when
      `include_specials` is set, so opting specials back in still never surfaces the junk
      (decision 2026-08-07, refining 2026-07-17). Regular Season-0 specials (index 1-99 / 400+)
      are NOT extras.
    * Specials (Season 0) are otherwise excluded by default: Plex sorts Season 0 ahead of
      Season 1, so an unwatched special would front-load a series and it would "open on a
      special" — which the user explicitly does not want (decision 2026-07-17). Real seasons
      (>=1) are always kept. A set may opt back in with `include_specials: True`, and the
      queue path passes `specials_ok=True` for a show that has NO real seasons (a pure OAD /
      film-as-series) so its sole Season-0 leaf stays playable instead of vanishing.
    * Drop zero-/missing-duration entries (script text, CM stubs — nothing to cast).
    """
    # JUNK GATE FIRST: a clip/extraType or a Season-0 trailer/OP-ED (index 200-399) is never a
    # real episode, so it is dropped even for a specials-only show (specials_ok) or when
    # include_specials is set — the OAD survives (its s0e1 index is 1-99), the ED songs don't.
    if is_extra_or_promo(ep):
        return False
    if not cfg.get("include_specials") and not specials_ok and str(ep.get("season")) == "0":
        return False
    if not ep.get("duration"):
        return False
    return True


def _watched_for_set(cfg, binding=None):
    """Watched ratingKeys for a set, using the active binding's watch_count_accounts if given.

    The two account lists answer DIFFERENT questions. A binding's own accounts answer "where
    is this profile up to?"; the global union answers "has anyone in the house seen this?".
    Episodic rotation needs the former: counting Bob's history made the kid cards open
    mid-series on shows the kid had never started (Batman S1E9 off Bob's 8 watched).
    """
    accts = (binding or config.binding_for(cfg)).get("watch_count_accounts") or config.WATCH_COUNT_ACCOUNTS
    watched = set()
    for acct in accts:
        for sec in config.set_sections(cfg):
            for row in _iter_history(acct, section_id=sec):
                rk = row.get("ratingKey")
                if rk is not None:
                    watched.add(str(rk))
    return watched


def build_rotation(set_name, length=None, rng=None, binding=None):
    """Interleave next-unwatched episodes ACROSS shows (round-robin), TV-style.

    Show A ep1, show B ep1, show C ep1, show A ep2, ...  — so a binge still advances
    that show across rounds, and no two consecutive items are the same show (unless
    only one show has unwatched episodes left). `rng` lets the caller inject a seeded
    Random for deterministic tests. `binding` selects the active profile (v3 PR 2).
    The buckets come from the channel's explicit `members:` when it has them (v3 PR 3),
    else from the dynamic rule — either way the interleave below is identical.
    """
    import random as _random
    rng = rng or _random
    length = length or config.ROTATION_LENGTH

    shows = channel_buckets(set_name, rng=rng, binding=binding)
    if not shows:
        return []
    order = shows[:]
    rng.shuffle(order)                       # vary which show leads each session
    cursors = {s["ratingKey"]: 0 for s in order}

    queue = []
    while len(queue) < length:
        progressed = False
        for s in order:
            i = cursors[s["ratingKey"]]
            if i < len(s["episodes"]):
                queue.append(s["episodes"][i])
                cursors[s["ratingKey"]] = i + 1
                progressed = True
                if len(queue) >= length:
                    break
        if not progressed:                   # every show exhausted
            break
    return queue


def pick_rewatch_movie(set_name=None, exclude_rating_key=None, rng=None, binding=None):
    """A film THIS PROFILE has watched before, weighted toward the least-watched.

    Two-part rule (user, 2026-07-16):
      * HARD FLOOR: view count >= 1 - the kids never see a movie for the FIRST time
        without the user ("I like to watch with them"). Count 0 never qualifies.
      * WEIGHTED PICK: weight = 1/n^2, so seen-exactly-once movies dominate (4x more
        likely than seen-twice, 9x more than three times) without hard-excluding the
        rest - exactly-once alone "might limit them too much".

    Counts the set's own accounts, same as the episodic rotation (the cross-profile
    union was tried and reverted - someone else's viewing drove this card). The
    candidate must also be kid-accessible (contentRating in the set's allow-list) so
    an adult film can never surface on a kids card. The pool spans the channel's OWN
    libraries (config.rewatch_sections), not a fixed Movies section.
    """
    import random as _random
    rng = rng or _random
    cfg = config.SETS[set_name or config.MOVIE_SET_DEFAULT]
    b = binding or config.binding_for(cfg)
    tok = account_token(b.get("user_uuid"))
    counts, titles = rewatch_counts(config.rewatch_sections(cfg), b["movie_ratings"],
                                    b.get("watch_count_accounts"), token=tok)
    # Per-binding movie excludes (ratingKeys Bob pulled from the rewatch pool) — same idea
    # as the channel blocklist, but for the Movies/rewatch card (workstream I).
    excludes = {str(x) for x in (b.get("movie_excludes") or [])}
    candidates = [
        (rk, n) for rk, n in counts.items()
        if rk not in excludes and rk != str(exclude_rating_key or "")
    ]
    if not candidates:
        return None
    rk = rng.choices(
        [rk for rk, _ in candidates],
        weights=[1.0 / (n * n) for _, n in candidates],
        k=1,
    )[0]
    return {"ratingKey": rk, "title": titles.get(rk) or movie_title(rk)}


def member_view_counts(accts=None):
    """View-event tally per ratingKey across an account set's WHOLE history.

    The generalized sibling of movie_view_counts: a members channel can mix shows, shorts
    and movies from ANY section (members resolve by ratingKey globally), so the rewatch
    weighting tallies every view event, unfiltered (history has one row per view).
    """
    counts = {}
    for acct in (accts or config.WATCH_COUNT_ACCOUNTS):
        for row in _iter_history(acct):
            rk = row.get("ratingKey")
            if rk is None:
                continue
            rk = str(rk)
            counts[rk] = counts.get(rk, 0) + 1
    return counts


def _member_rewatch_candidates(cfg, binding, token):
    """(item, view_count) for every playable member item this binding has seen >= once.

    The member pool ignores watched-state (a rewatch REPLAYS); specials / zero-duration
    items are still dropped (_keep_episode), and the binding's movie_excludes apply. Same
    two-part rule as pick_rewatch_movie: HARD FLOOR n>=1, weighting is the caller's 1/n^2.
    """
    counts = member_view_counts(binding.get("watch_count_accounts"))
    excludes = {str(x) for x in (binding.get("movie_excludes") or [])}
    out = []
    for desc in member_descs(cfg):
        if desc.get("collection"):
            items = collection_items(cfg, desc["collection"], set(), token=token,
                                     start=desc.get("start")) or []
        else:
            rk, typ, title = resolve_queue_entry(desc, cfg, token=token)
            if typ is None:
                continue
            if typ == "movie":
                items = [{"title": title, "ratingKey": rk, "show": None,
                          "season": None, "episode": None}]
            else:
                items = [e for e in show_episodes(rk, token=token) if _keep_episode(e, cfg)]
        for it in items:
            rk = str(it["ratingKey"])
            n = counts.get(rk, 0)
            if n >= 1 and rk not in excludes:
                out.append((it, n))
    return out


def pick_rewatch(set_name=None, exclude_rating_key=None, rng=None, binding=None):
    """behavior:rewatch entry point — weighted least-watched replay for ANY member kind.

    With explicit `members:` (v3 PR 3) the candidate pool is every playable member item
    this binding has seen at least once — weight 1/n^2, hard floor n>=1, exactly the movie
    card's two-part rule generalized to shows/shorts/collections. Without members it falls
    through to pick_rewatch_movie (the dynamic Movies-section pool), so the live movie
    card behaves identically to before.
    """
    import random as _random
    rng = rng or _random
    cfg = config.SETS[set_name or config.MOVIE_SET_DEFAULT]
    if not cfg.get("members"):
        return pick_rewatch_movie(set_name, exclude_rating_key=exclude_rating_key,
                                  rng=rng, binding=binding)
    b = binding or config.binding_for(cfg)
    tok = account_token(b.get("user_uuid"))
    candidates = [(it, n) for it, n in _member_rewatch_candidates(cfg, b, tok)
                  if str(it["ratingKey"]) != str(exclude_rating_key or "")]
    if not candidates:
        return None
    it = rng.choices(
        [it for it, _ in candidates],
        weights=[1.0 / (n * n) for _, n in candidates],
        k=1,
    )[0]
    return {"ratingKey": str(it["ratingKey"]), "title": it.get("title")}


def rewatch_pool(set_name=None, limit=500, binding=None):
    """A rewatch channel's eligible pool: every candidate with its view count.

    Same candidate rule as pick_rewatch_movie (seen >= once by the set's accounts, rating
    in the set's movie allow-list, across the channel's own libraries), sorted least-watched
    first — the order the 1/n^2 weighting favors. Feeds the web Channels view; titles come
    from the section listing the pool already walks, so the cap is only a runaway guard now
    (it was 60 back when each title cost its own metadata fetch). A members channel pools
    its member items instead (pick_rewatch's candidates), same floor + ordering.
    """
    cfg = config.SETS[set_name or config.MOVIE_SET_DEFAULT]
    b = binding or config.binding_for(cfg)
    tok = account_token(b.get("user_uuid"))
    if cfg.get("members"):
        candidates = sorted(_member_rewatch_candidates(cfg, b, tok), key=lambda c: c[1])[:limit]
        return [{"ratingKey": str(it["ratingKey"]), "title": it.get("title"), "count": n}
                for it, n in candidates]
    counts, titles = rewatch_counts(config.rewatch_sections(cfg), b["movie_ratings"],
                                    b.get("watch_count_accounts"), token=tok)
    excludes = {str(x) for x in (b.get("movie_excludes") or [])}
    candidates = sorted(
        ((rk, n) for rk, n in counts.items() if rk not in excludes),
        key=lambda c: c[1],
    )[:limit]
    return [{"ratingKey": rk, "title": titles.get(rk), "count": n} for rk, n in candidates]


# --------------------------------------------------------------------------- #
# Curated queues (source="queue"): play the top not-finished entry, mark finished done
# --------------------------------------------------------------------------- #
_ITEM_TYPE = {}  # ratingKey -> ("movie"|"show", title); only resolved (stable) types cached


def item_type(rating_key, token=None):
    """(type, title) for a ratingKey — "movie" or "show" — or (None, None) if unresolved.

    Unresolved = the key isn't a movie/show (deleted item, or a hand-typed entry pointing at
    a season/episode/bad id). Not cached, so a fixed/re-added item resolves on the next scan.
    """
    key = str(rating_key)
    if key in _ITEM_TYPE:
        return _ITEM_TYPE[key]
    try:
        mc = _container(f"/library/metadata/{rating_key}", token)
    except Exception:  # noqa: BLE001 — bad/removed id: treat as unresolved, don't cache
        return (None, None)
    md = mc.get("Metadata", [])
    if not md:
        return (None, None)
    t = md[0].get("type")
    if t not in ("movie", "show"):
        return (None, None)
    res = (t, md[0].get("title"))
    _ITEM_TYPE[key] = res
    return res


def item_view_state(rating_key, token=None):
    """(viewOffset_ms, viewCount) for one item under `token`'s account.

    viewOffset is how far (in ms) into the item that account last got — 0 if it never
    started or was reset — and viewCount its completed-play tally. Read straight off the
    item's metadata, which (like every read here) reflects the passed account token's own
    view state, so a queue set sees ITS profile's resume point (admin/Bob for the people
    queues). (0, 0) on any miss (dead id, network hiccup) so the caller just starts at 0.
    """
    try:
        mc = _container(f"/library/metadata/{rating_key}", token)
    except Exception:  # noqa: BLE001 — bad/removed id or network hiccup: no resume point
        return (0, 0)
    md = mc.get("Metadata", [])
    if not md:
        return (0, 0)
    return (_int0(md[0].get("viewOffset")), _int0(md[0].get("viewCount")))


def resume_offset(rating_key, watched=None, token=None):
    """Milliseconds to resume `rating_key` at — its Plex viewOffset when IN-PROGRESS, else 0.

    Live view-state is AUTHORITATIVE: resumable = viewOffset > 0 AND viewCount < 1 (a missing
    viewCount is 0, so a partial view is never "watched"). A finished item (viewCount >= 1) or
    a fresh one (no offset) returns 0, so it plays from the top. This is what lets a QUEUED
    item that was started but not finished pick up where it left off on the next scan instead
    of restarting (decision 2026-07-16-movie-queue-sets-yaml-wishlist: "resume
    partially-watched"). `watched` (the set's history) is accepted for call-site compatibility
    but deliberately NOT consulted — a history row must never override a live in-progress
    state (that mismatch is exactly what wrongly marked an OAD finished). Queue sets only —
    the rotation / reel / general-playback paths never call this, so they are untouched.
    """
    offset, count = item_view_state(rating_key, token=token)
    return offset if _in_progress(offset, count) else 0


def _head_resume_offset(item, token=None):
    """Resume offset (ms) for a resolved play ITEM, reusing its live state when present.

    A show leaf already carries `viewOffset`/`viewCount` (show_episodes) — use them directly,
    no refetch. A movie / collection-member item carries none, so fall back to resume_offset's
    metadata read. 0 whenever the head is finished or fresh (plays from the top)."""
    if item.get("viewOffset") is not None:
        return item["viewOffset"] if _in_progress(item.get("viewOffset"),
                                                   item.get("viewCount")) else 0
    return resume_offset(item["ratingKey"], token=token)


def _match_guid_hint(hint, guids):
    """True if a `source-id` folder hint (`anidb-16172`, `imdb-tt0067023`) is in `guids`.

    Folder hints join source + id with a dash; Plex's `Guid` ids join them with `://`
    (`anidb://16172`, `imdb://tt0067023`). Split on the FIRST dash so an id that itself
    contains dashes survives. Case-insensitive. Best-effort: some agents (e.g. the Anime
    library) return no `Guid` list, so the hint simply doesn't contribute there.
    """
    if not hint:
        return False
    src, sep, rid = hint.partition("-")
    if not sep or not rid:
        return False
    want = f"{src}://{rid}".lower()
    return any((g or "").lower() == want for g in guids)


# Resolved title→item cache, keyed by (section, title-lower, year, guid-lower). Only
# SUCCESSFUL resolutions are cached; an unresolved title retries every scan so a later
# library add / typo fix resolves without a restart.
_TITLE_RESOLVE = {}


def _resolve_title(section, title, year=None, guid=None, token=None):
    """Resolve a title string to (ratingKey, type, title) within a section, or (None,)*3.

    Queries `/library/sections/<section>/all?title=<q>` (a begins-with/contains filter),
    then scores each movie/show candidate: a guid-hint match dominates, then a year match,
    then an exact (case-insensitive) title match, with a begins-with nudge. Ties break to
    the lowest ratingKey so duplicate library items resolve deterministically. A candidate
    must score > 0 to win, so a title that matches nothing meaningful stays unresolved.
    """
    ck = (section, title.lower(), year, (guid or "").lower())
    if ck in _TITLE_RESOLVE:
        rk, typ, canon = _TITLE_RESOLVE[ck]
        return (rk, typ, canon)
    q = urllib.parse.quote(title)
    try:
        mc = _container(
            f"/library/sections/{section}/all?title={q}&includeGuids=1&X-Plex-Container-Size=50",
            token,
        )
    except Exception:  # noqa: BLE001 — network/query hiccup: treat as unresolved this scan
        return (None, None, None)

    best, best_score = None, 0
    tl = title.lower()
    for e in mc.get("Metadata", []):
        et = e.get("type")
        if et not in ("movie", "show"):
            continue
        cand_title = e.get("title") or ""
        cand_year = e.get("year")
        guids = [g.get("id") for g in e.get("Guid", [])]
        score = 0
        if guid and _match_guid_hint(guid, guids):
            score += 100
        if year is not None and cand_year == year:
            score += 10
        elif year is not None and cand_year is not None and cand_year != year:
            score -= 5
        cl = cand_title.lower()
        if cl == tl:
            score += 5
        elif cl.startswith(tl):
            score += 1
        rk = str(e.get("ratingKey"))
        better = (
            best is None
            or score > best_score
            or (score == best_score and rk.isdigit() and int(rk) < int(best[0]))
        )
        if better:
            best, best_score = (rk, et, cand_title), score

    if best is None or best_score <= 0:
        return (None, None, None)
    _TITLE_RESOLVE[ck] = best
    return best


def resolve_queue_entry(desc, cfg, token=None):
    """Resolve one queue descriptor (from queues.entries) to (ratingKey, type, title).

    A descriptor with a ratingKey resolves via item_type (exact); otherwise its parsed
    title is searched in the set's `queue_section`. Returns (None, None, None) when the
    ratingKey is dead / not a movie|show, or the title matches nothing.
    """
    rk = desc.get("ratingKey")
    if rk:
        typ, title = item_type(rk, token=token)
        if typ is None:
            return (None, None, None)
        return (rk, typ, title)
    title = desc.get("title")
    if not title:
        return (None, None, None)
    # Try each of the set's sections (movies span Movies + Documentaries); first hit wins.
    # A rotation channel has no queue_sections — its members resolve across every section
    # it draws from (shows + shorts/movies), same scope as its watched-state.
    sections = (cfg.get("queue_sections") or config.set_sections(cfg)
                or [cfg.get("queue_section")])
    for sec in sections:
        rk, typ, resolved = _resolve_title(sec, title, desc.get("year"),
                                           desc.get("guid"), token=token)
        if typ is not None:
            return (rk, typ, resolved)
    return (None, None, None)


# --------------------------------------------------------------------------- #
# Plex Collections as ordered queue entries (decision
# 2026-07-21-collections-as-ordered-entries): a `Collection: <name>` entry expands to the
# collection's children IN COLLECTION ORDER. Shorts picked as a Collection fall out of this
# (a shorts Collection behaves like a show entry — a named, ordered group).
# --------------------------------------------------------------------------- #
_COLLECTION_RK = {}  # (section, name-lower) -> ratingKey (only successful lookups cached)


def find_collection(section, name, token=None):
    """ratingKey of the Collection titled `name` in `section` (type=18), or None.

    Case-insensitive exact title match. Cached per (section, name). Unresolved lookups are
    NOT cached, so a collection created later resolves on the next scan without a restart.
    """
    key = (section, name.strip().lower())
    if key in _COLLECTION_RK:
        return _COLLECTION_RK[key]
    try:
        mc = _container(
            f"/library/sections/{section}/collections?X-Plex-Container-Size=1000", token)
    except Exception:  # noqa: BLE001 — network/query hiccup: unresolved this scan
        return None
    for c in mc.get("Metadata", []):
        if (c.get("title") or "").strip().lower() == name.strip().lower():
            rk = str(c.get("ratingKey"))
            _COLLECTION_RK[key] = rk
            return rk
    return None


def collection_children(rating_key, token=None):
    """Ordered child items of a collection.

    `/library/collections/<rk>/children` returns them in the collection's own order
    (`collectionSort` — 0=release, 1=alpha, 2=custom), so no client-side re-sort is needed.
    """
    try:
        mc = _container(f"/library/collections/{rating_key}/children", token)
    except Exception:  # noqa: BLE001
        return []
    return mc.get("Metadata", [])


def _start_member_index(children, start):
    """Index of the collection child a manual start names, or -1.

    A COLLECTION start is {series, season?, episode?}: `series` is the member to begin at —
    its ratingKey (what the web editor writes) or its title (a hand-written YAML entry).
    Members before it in collection order are skipped entirely.
    """
    if not start or start.get("series") in (None, ""):
        return -1
    want = str(start["series"]).strip().lower()
    for i, ch in enumerate(children):
        if str(ch.get("ratingKey")).strip().lower() == want:
            return i
        if (ch.get("title") or "").strip().lower() == want:
            return i
    return -1


def collection_items(cfg, name, watched, token=None, start=None, resume=False):
    """Ordered playable items for a `Collection: <name>` entry, across the set's sections.

    Returns (in collection order):
      * a movie / short / episode child  -> itself, once, dropped once it's in `watched`.
      * a show child                     -> its next unwatched, playable episodes (allLeaves
                                            order), so a collection of series behaves like a
                                            stack of show entries.
    `start` ({series, season?, episode?}) is the manual floor: members BEFORE `series` are
    skipped entirely, and that member's episodes are floored at {season, episode}. Later
    members are unaffected — the collection resumes its normal order after the start point.
    Return value contract (matches how next_queue treats a series):
      * None  -> the named collection wasn't found in any of the set's sections (UNRESOLVED,
                 kept + flagged).
      * []    -> found but every child is watched (FINISHED, mark done).
      * [...] -> the play items.
    """
    sections = (cfg.get("queue_sections") or config.set_sections(cfg)
                or [cfg.get("queue_section")])
    coll_rk, children = None, []
    for sec in sections:
        if sec is None:
            continue
        coll_rk = find_collection(sec, name, token=token)
        if coll_rk:
            children = collection_children(coll_rk, token=token)
            break
    if not coll_rk:
        return None
    floor_at = _start_member_index(children, start)
    items = []
    for i, ch in enumerate(children):
        if 0 <= floor_at and i < floor_at:
            continue                      # member sits before the manual start
        rk = str(ch.get("ratingKey"))
        if ch.get("type") == "show":
            # The episode floor applies only to the member the start names, not to later ones.
            ep_start = start if i == floor_at else None
            child_eps = show_episodes(rk, token=token)
            specials_ok = resume and not _has_real_seasons(child_eps)
            items.extend(
                e for e in child_eps
                if (e["ratingKey"] not in watched
                    or (resume and _in_progress(e.get("viewOffset"), e.get("viewCount"))))
                and _keep_episode(e, cfg, specials_ok=specials_ok)
                and _at_or_after_start(e, ep_start))
        else:  # movie / episode / clip / standalone item
            # A watched member drops out — unless (resume path) it is actually in-progress.
            if rk in watched and not (resume and _in_progress(*item_view_state(rk, token=token))):
                continue
            items.append({"ratingKey": rk, "title": ch.get("title"),
                          "show": ch.get("grandparentTitle") or name,
                          "season": ch.get("parentIndex"), "episode": ch.get("index"),
                          "duration": ch.get("duration")})
    return items


def resolve_member(desc, cfg, watched, token=None, default_batch=None, resume=False):
    """Resolve ONE member descriptor (queues._describe shape) into a play batch.

    THE shared per-type dispatch (v3 PR 3): both a curated set's queues.yaml entries and a
    rotation channel's explicit `members:` list resolve through here, so every member kind
    behaves identically everywhere:
      * a `Collection: <name>`  -> its unwatched children in collection order,
      * a movie / short         -> the item itself, ONE item, dropped once it's in `watched`,
      * a show                  -> its next unwatched playable episodes in order, capped at
                                   the entry's `episodes:` override else `default_batch`
                                   (hard cap QUEUE_SERIES_LENGTH). A queue passes
                                   QUEUE_SERIES_DEFAULT (one episode per play); a channel
                                   bucket passes None = uncapped, so the round-robin can
                                   advance a show across rounds like the dynamic rule.
    Returns None when the descriptor is UNRESOLVED (dead ratingKey, unmatched title, missing
    collection); otherwise {"title", "type", "ratingKey"?, "items": [...]} — empty `items`
    means FINISHED (everything already watched).

    `resume` (queue path only) makes finished-detection IN-PROGRESS-AWARE: a leaf/movie that
    is partially watched (viewOffset > 0, viewCount < 1) is KEPT even when history counts it
    watched, and a specials-only show keeps its sole Season-0 leaf — so a started-but-unfinished
    item is never mistaken for finished. The rotation/reel callers leave `resume` False and are
    unchanged.
    """
    if desc.get("collection"):
        name = desc["collection"]
        items = collection_items(cfg, name, watched, token=token, start=desc.get("start"),
                                 resume=resume)
        if items is None:
            return None
        return {"title": f"Collection: {name}", "type": "collection", "items": items}
    rk, typ, title = resolve_queue_entry(desc, cfg, token=token)
    if typ is None:
        return None
    if typ == "movie":
        # A watched movie is dropped — UNLESS (resume path) it is actually in-progress, in
        # which case it stays so it can be resumed. Padded to the episode-item shape so
        # bucket/preview consumers read the same keys off every item kind.
        keep_movie = rk not in watched
        if not keep_movie and resume:
            off, cnt = item_view_state(rk, token=token)
            keep_movie = _in_progress(off, cnt)
        items = ([{"title": title, "ratingKey": rk, "show": None,
                   "season": None, "episode": None}] if keep_movie else [])
        return {"title": title, "type": "movie", "ratingKey": rk, "items": items}
    all_eps = show_episodes(rk, token=token)
    start = desc.get("start")
    # A pure OAD / film-as-series has no real seasons; on the queue path keep its Season-0
    # leaf playable (specials_ok) instead of dropping it and calling the show "finished".
    specials_ok = resume and not _has_real_seasons(all_eps)
    eps = [e for e in all_eps
           # keep an episode that is unwatched, OR (resume path) one that is IN-PROGRESS even
           # if history flagged it watched — a partial view must never be treated as done.
           if (e["ratingKey"] not in watched
               or (resume and _in_progress(e.get("viewOffset"), e.get("viewCount"))))
           and _keep_episode(e, cfg, specials_ok=specials_ok)
           and _at_or_after_start(e, start)]
    # Per-show batch: the entry's `episodes:` override, else the caller's default, clamped
    # to the hard cap so a bad value can't queue the whole series. No batch at all (a
    # channel member with no override) => the full ordered unwatched list.
    batch = desc.get("episodes") or default_batch
    if batch:
        batch = max(1, min(int(batch), config.QUEUE_SERIES_LENGTH))
        eps = eps[:batch]
    return {"title": title, "type": "show", "ratingKey": rk, "items": eps,
            "multi_season": _multi_season(all_eps)}


def member_descs(cfg):
    """A rotation channel's `members:` list as resolution descriptors (queues._describe)."""
    out = []
    for m in cfg.get("members") or []:
        desc = queues._describe(m)
        if desc["key"] is not None:
            out.append(desc)
    return out


def _watched_all(binding):
    """Watched ratingKeys across the binding's WHOLE history (no section filter).

    Members resolve by ratingKey GLOBALLY — one may live outside the channel's configured
    sections (e.g. a movie member on a shows channel) — so member watched-state must scan
    all history too, unlike the rule pool's section-scoped _watched_for_set. Still one
    paginated walk per account.
    """
    accts = binding.get("watch_count_accounts") or config.WATCH_COUNT_ACCOUNTS
    watched = set()
    for acct in accts:
        for row in _iter_history(acct):
            rk = row.get("ratingKey")
            if rk is not None:
                watched.add(str(rk))
    return watched


def member_buckets(set_name, binding=None):
    """Buckets for a channel's explicit `members:` list, shaped like unwatched_buckets.

    Each member becomes ONE bucket (show -> its next unwatched episode batch, collection ->
    its unwatched children in order, movie/short -> itself once), so build_rotation
    interleaves curated members exactly like the rule pool's shows. An unresolved or
    finished member simply contributes no bucket — a CHANNEL never marks members done
    (unlike a queue entry), so a fully-watched show rejoins the pool when new episodes land.
    """
    cfg = config.SETS[set_name]
    b = binding or config.binding_for(cfg)
    tok = account_token(b.get("user_uuid"))
    watched = _watched_all(b)
    buckets = []
    for desc in member_descs(cfg):
        res = resolve_member(desc, cfg, watched, token=tok)
        if not res or not res["items"]:
            continue
        buckets.append({"show": res["title"],
                        "ratingKey": res.get("ratingKey") or res["title"],
                        "episodes": res["items"],
                        "multi_season": res.get("multi_season", False)})
    return buckets


def channel_buckets(set_name, rng=None, binding=None):
    """A rotation channel's pool: the dynamic rule PLUS its explicit `members:`.

    Curated members are ADDITIVE includes — they play ON TOP of the rule pool, not instead of
    it (decision 2026-07-31-curated-members-are-additive-includes, superseding the earlier
    "curated vs dynamic, no convergence"). So one channel can be "the Shows library PLUS these
    hand-picked shows" — a member is a manual include, the mirror of the blocklist's exclude.
    Two familiar shapes fall out for free:
      * no members            -> purely the rule pool (every channel today; unchanged).
      * no pool libraries     -> purely the members (an empty rule pool), i.e. pure-curated.
    Deduped by ratingKey (members win) so a member that also matches the rule isn't queued
    twice; a member from a library OUTSIDE the pool sections (e.g. an Anime show on a Shows
    channel) resolves globally by ratingKey and simply adds its bucket.
    """
    cfg = config.SETS[set_name]
    rule = unwatched_buckets(set_name, rng=rng, binding=binding)
    if not cfg.get("members"):
        return rule
    members = member_buckets(set_name, binding=binding)
    seen = {str(b["ratingKey"]) for b in members}
    return members + [b for b in rule if str(b["ratingKey"]) not in seen]


def next_queue(set_name, rng=None):
    """Resolve a curated set: build its play items and mark finished entries done.

    Walks the set's `queues.yaml` entries. Each entry is a title string, a ratingKey, a
    {title, ratingKey} mapping, or a `Collection: <name>` (expands to that Plex Collection's
    children in collection order — resolve via collection_items). A MOVIE is finished once
    it's in this profile's watched history; a SERIES/COLLECTION is finished once it has no
    unwatched, playable items left. A series contributes its next unwatched episodes in
    order, capped at the entry's `episodes:` batch (default QUEUE_SERIES_DEFAULT, hard cap
    QUEUE_SERIES_LENGTH); a collection contributes all its unwatched children in order.

    What plays depends on the set's kind (decision
    2026-07-21-queues-vs-channels-taxonomy-play-first-ia):
      * QUEUE (kind != "anime"): ordered — the FIRST not-finished entry's batch plays;
        top of the file is next.
      * CHANNEL (kind == "anime"): the entries are members, their order irrelevant —
        every not-finished member's batch plays back-to-back in a SHUFFLED member
        order, total capped at ROTATION_LENGTH items.

    Finished entries are NO LONGER pruned — they are KEPT and tagged `done: true`
    (queues.mark_done), excluded from the lineup, and only ever removed explicitly (a Node
    endpoint / per-item delete). Anime has no "Season 2", so the finished series must stay
    visible as the anchor Bob adds the sequel next to (decision
    2026-07-21-finished-entries-marked-done-not-pruned, superseding the auto-prune half of
    2026-07-16-movie-queue-sets-yaml-wishlist.md). Already-done entries are skipped up front.
    Unresolvable entries are kept + flagged (never silently dropped). Returns a dict the
    service publishes/plays; `done` lists what is finished (already-done + newly marked).
    """
    import random as _random
    rng = rng or _random
    cfg = config.SETS[set_name]
    descs = queues.entries(set_name)
    if not descs:                                # empty/absent queue: nothing to resolve
        return {"set": set_name, "play": [], "last": None,
                "done": [], "unresolved": [], "remaining": 0, "offset": 0}
    tok = account_token(cfg.get("user_uuid"))    # None => admin PLEX_TOKEN (Bob)
    watched = _watched_for_set(cfg)              # this set's own accounts, over its section

    newly_done, done_flagged, unresolved, revived = [], [], [], []
    remaining = 0                                # not-done entries still active
    batches = []                                 # one not-finished entry each, file order
    for desc in descs:
        # Resolve every entry IN-PROGRESS-AWARE (resume=True) — including ones flagged done, so
        # a stale `done: true` can be caught. A partial view is never treated as watched/done.
        res = resolve_member(desc, cfg, watched, token=tok,
                             default_batch=config.QUEUE_SERIES_DEFAULT, resume=True)
        if desc.get("done"):
            # Stale-done recovery: an entry flagged done whose live Plex state is actually
            # IN-PROGRESS (viewOffset > 0, viewCount 0/None) was mis-marked — the Prison School
            # OAD is the case: a 1-leaf Season-0 special _keep_episode used to drop, so it read
            # "finished" while the owner was mid-episode. Honor live state over the persisted
            # flag: revive it, play/resume it, and clear the stale `done`/`done_at` (below) so it
            # is not skipped or TTL-swept. A genuinely finished entry has no in-progress item, so
            # it stays done + skipped, exactly as before.
            head = res["items"][0] if res and res.get("items") else None
            if head and _head_resume_offset(head, token=tok) > 0:
                revived.append(desc["key"])
                remaining += 1
                batches.append({"title": res["title"], "type": res["type"], "items": res["items"]})
            else:
                done_flagged.append(desc.get("title") or desc.get("ratingKey") or desc["key"])
            continue
        remaining += 1
        if res is None:
            # Show the human's own text (or the ratingKey) so the flag is legible.
            unresolved.append(f"Collection: {desc['collection']}" if desc.get("collection")
                              else desc.get("ratingKey") or desc.get("title") or desc["key"])
            continue
        if not res["items"]:                     # everything watched: finished
            newly_done.append(desc["key"]); done_flagged.append(res["title"])
            remaining -= 1
            continue
        batches.append({"title": res["title"], "type": res["type"], "items": res["items"]})

    def _batch_leads_in_progress(b):
        # A show batch's items carry live per-leaf viewOffset/viewCount (show_episodes), so an
        # in-progress head is free to detect. Movie/collection-movie items don't, and read as
        # not-in-progress here (their resume still works if they happen to lead) — good enough
        # to hoist a resumable series to the front of a shuffled channel.
        it = b["items"][0] if b["items"] else None
        return bool(it and _in_progress(it.get("viewOffset"), it.get("viewCount")))

    if cfg.get("kind") == "anime":
        # Channel: member order is irrelevant AND shuffled — but an in-progress member must
        # still LEAD so it actually resumes (the Prison School OAD), not land mid-shuffle where
        # only the head resumes. Hoist in-progress batches to the front (file order among them),
        # shuffle the rest.
        lead = [b for b in batches if _batch_leads_in_progress(b)]
        rest = [b for b in batches if not _batch_leads_in_progress(b)]
        rng.shuffle(rest)
        ordered = lead + rest
        play_items = []
        for b in ordered:
            play_items.extend(b["items"][:config.ROTATION_LENGTH - len(play_items)])
            if len(play_items) >= config.ROTATION_LENGTH:
                break
        lead_batch = ordered[0] if ordered else None
    else:
        play_items = batches[0]["items"] if batches else []
        lead_batch = batches[0] if batches else None
    last = ({"title": lead_batch["title"], "type": lead_batch["type"],
             "ratingKey": play_items[0]["ratingKey"]} if play_items else None)

    # Resume-in-queue: if the item leading this scan was STARTED but not finished, pick up at
    # its Plex viewOffset rather than restarting at 0. For a show leaf the live per-leaf state
    # is already in hand (no refetch); a movie/collection item has none attached, so fall back
    # to a metadata read (resume_offset). A finished/fresh head yields 0, so it plays from the
    # top — a finished item still advances exactly as before.
    offset = _head_resume_offset(play_items[0], token=tok) if play_items else 0

    # Un-stick any entry we revived above: clear its stale `done`/`done_at` so it stops being
    # skipped AND is no longer eligible for the TTL sweep below. Done BEFORE mark_done/sweep so
    # live state wins the same scan (a re-marked-then-cleared race can't strand it).
    if revived:
        queues.clear_done(set_name, revived)
    # A keep_completed (non-consuming / playlist) set — `reel` implies it — NEVER marks its
    # entries done, so the owner can re-show the whole lineup every scan. No done_at/`done`
    # is ever written, so it is inherently exempt from any finished-entry sweep.
    if newly_done and not (cfg.get("keep_completed") or cfg.get("reel")):
        queues.mark_done(set_name, newly_done)   # keep + tag finished (done: true + done_at)
    # §B.3 TTL auto-remove: on each scan, drop entries whose done_at is older than the set's
    # remove_completed_after (per-set) / config.REMOVE_COMPLETED_AFTER (global default 24h).
    # keep_completed/reel sets are exempt inside sweep_completed. Runs AFTER mark_done, so an
    # entry just marked this scan (done_at=now) is never immediately swept. Reuses prune for
    # the atomic, comment-preserving removal.
    queues.sweep_completed(set_name, cfg)
    return {"set": set_name, "play": play_items, "last": last,
            "done": done_flagged, "unresolved": unresolved, "remaining": remaining,
            "offset": offset}


def build_reel(set_name, limit=60):
    """Resolve a REEL set to an ORDERED play list, ignoring watched-state entirely.

    A reel (source="queue" + `reel: true`, e.g. the theater DEMO channel) is a curated
    showcase you replay every scan: unlike next_queue there is no "finished", nothing is
    ever marked done, and the FILE ORDER is the play order (a deliberate arc — logos, then
    reference showpieces, then a finale). Every entry plays each scan; the run is capped at
    `limit` items only as a safety bound. Entries resolve exactly like a queue (a ratingKey,
    a `Collection: <name>`, or a title string), but a movie is never dropped-when-watched and
    a series contributes its FIRST episodes regardless of history. Demo clips live in the
    globally-excluded Demos / Movie-Clips sections; keying by ratingKey resolves them anyway.

    Returns the same dict shape next_queue does (done is always empty) so do_start can treat
    the two paths identically.
    """
    cfg = config.SETS[set_name]
    descs = queues.entries(set_name)
    if not descs:
        return {"set": set_name, "play": [], "last": None,
                "done": [], "unresolved": [], "remaining": 0, "offset": 0}
    tok = account_token(cfg.get("user_uuid"))    # None => admin PLEX_TOKEN (Bob)
    play_items, unresolved = [], []
    for desc in descs:
        if len(play_items) >= limit:
            break
        if desc.get("done"):                     # a hand-tagged skip is still honored
            continue
        if desc.get("collection"):               # whole Plex Collection, in order (no watched filter)
            items = collection_items(cfg, desc["collection"], set(), token=tok,
                                     start=desc.get("start"))
            if not items:                        # None (not found) or [] (empty): flag + skip
                unresolved.append(f"Collection: {desc['collection']}")
                continue
            play_items.extend(items[:max(0, limit - len(play_items))])
            continue
        rk, typ, title = resolve_queue_entry(desc, cfg, token=tok)
        if typ is None:
            unresolved.append(desc.get("ratingKey") or desc.get("title") or desc["key"])
            continue
        if typ == "movie":
            play_items.append({"title": title, "ratingKey": rk})
        else:                                    # series: its first episodes, ignoring history
            eps = show_episodes(rk, token=tok)
            batch = max(1, min(int(desc.get("episodes") or config.QUEUE_SERIES_DEFAULT),
                               config.QUEUE_SERIES_LENGTH))
            play_items.extend({"title": e.get("title") or title, "ratingKey": e["ratingKey"]}
                              for e in eps[:batch])
    last = ({"title": play_items[0]["title"], "type": "movie",
             "ratingKey": play_items[0]["ratingKey"]} if play_items else None)
    # A reel replays IN FULL from the top every scan (nothing is ever "in progress" to it),
    # so its offset is always 0 — carried only so do_start sees the same result shape.
    return {"set": set_name, "play": play_items, "last": last,
            "done": [], "unresolved": unresolved, "remaining": len(play_items), "offset": 0}
