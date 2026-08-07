"""Curated-queue store: read + prune the hand-edited `queues.yaml` wishlist.

The six `source="queue"` sets (bob / bob_alice / family and their _anime
siblings) are NOT computed by rule — Bob writes an ordered list per set into
`queues.yaml` (top = next to play). The file lives in App-Configs, mounted RW at
`config.QUEUES_PATH`, and is re-read on every scan. A finished entry is KEPT and tagged
`done: true` (mark_done), never auto-pruned — anime has no "Season 2", so the finished
series stays visible as the anchor Bob adds the sequel next to (decision
2026-07-21-finished-entries-marked-done-not-pruned, superseding the auto-prune half of
2026-07-16-movie-queue-sets-yaml-wishlist.md). Removal is explicit only (`prune`, driven
by a Node endpoint / per-item delete).

Round-trip via ruamel.yaml so hand-written comments + ordering survive the prune. If
ruamel is unavailable (e.g. the read-only dry-run env without the image deps), we fall
back to PyYAML for READS; a prune-rewrite is skipped with a warning rather than
clobbering the file's formatting.

## Entry formats (decision 2026-07-20-queue-entries-are-title-strings.md)

An entry is any of:

  * a **human-readable title string** — the primary, hand-editable form:
      - `- Duel (1971)`                         title + year
      - `- 86 Eighty-Six (2021) [anidb-16172]`  title + year + a `[source-id]` guid hint
      - `- Cowboy Bebop`                         bare title
    resolved against the set's Plex section at scan time (see plex._resolve_title).
  * a bare **ratingKey** (`- 12345`) — precise; what the web UI / AI write.
  * a **mapping** carrying either/both (`- {ratingKey: 12345, title: "Megamind (2010)"}`)
    — a ratingKey with a human label. The `title:` value is itself parsed as a title
    string (so a mapping can also carry `(year)`/`[guid]` if it has no ratingKey).

A human never needs a ratingKey; titles resolve fresh each scan and their exact text is
never rewritten (an unresolved title is kept + flagged, not clobbered).
"""
import errno
import os
import re
import threading
import time
from contextlib import contextmanager

from . import config

# Intra-process guard: the prune runs in the Python service; this RLock serializes it
# against itself across the service's own threads.
_LOCK = threading.RLock()

# CROSS-process guard: the Node web editor (plex-channels-web) writes the SAME file from a
# SEPARATE process in the same container, so the RLock can't cover both. Both writers take
# a mkdir-based advisory lock on `<queues.yaml>.lock` (mkdir is atomic everywhere). The
# Node side implements the identical convention in web/src/queues.js — keep them in sync.
_LOCK_STALE_S = 15.0     # a holder older than this is presumed dead; steal it
_LOCK_WAIT_S = 10.0      # give up acquiring after this


@contextmanager
def _file_lock():
    lock_dir = config.QUEUES_PATH + ".lock"
    deadline = time.monotonic() + _LOCK_WAIT_S
    while True:
        try:
            os.mkdir(lock_dir)
            break
        except OSError as e:
            if e.errno != errno.EEXIST:
                raise
            try:                                 # steal a stale lock (crashed holder)
                if time.time() - os.stat(lock_dir).st_mtime > _LOCK_STALE_S:
                    try:
                        os.rmdir(lock_dir)
                    except OSError:
                        pass
                    continue
            except OSError:
                pass                             # lock vanished mid-check: retry mkdir
            if time.monotonic() > deadline:
                raise TimeoutError("timed out acquiring queues.yaml lock")
            time.sleep(0.05)
    try:
        yield
    finally:
        try:
            os.rmdir(lock_dir)
        except OSError:
            pass

SET_KEYS = ("bob", "bob_alice", "family",
            "bob_anime", "bob_alice_anime", "family_anime")

# `Title (YEAR) [source-id]` — year and guid hint both optional, stripped from the END so
# a title that itself contains parentheses/brackets earlier is left intact.
_YEAR_RE = re.compile(r"\s*\((\d{4})\)\s*$")
_GUID_RE = re.compile(r"\s*\[([^\]]+)\]\s*$")
# `Collection: <name>` — a title string that plays a whole Plex Collection in order
# (decision 2026-07-21-collections-as-ordered-entries). Case-insensitive prefix.
_COLLECTION_RE = re.compile(r"^\s*collection:\s*(.+)$", re.IGNORECASE)


def parse_title_string(text):
    """Split a title string into (title, year|None, guid_hint|None).

    Peels an optional trailing `[source-id]` guid hint, then an optional trailing
    `(YEAR)`, leaving the bare title. Order-tolerant because both are matched at the
    end and stripped in turn.
    """
    s = str(text).strip()
    guid = None
    m = _GUID_RE.search(s)
    if m:
        guid = m.group(1).strip()
        s = s[:m.start()].rstrip()
    year = None
    m = _YEAR_RE.search(s)
    if m:
        year = int(m.group(1))
        s = s[:m.start()].rstrip()
    return s.strip(), year, guid


# Duration strings for the completed-entry TTL (§B.3): `24h`, `7d`, `90m`, a bare number of
# seconds; a trailing unit is optional. `0`/`never`/blank disables (returns None).
_DURATION_RE = re.compile(r"^(\d+)\s*([smhdw]?)$")
_DURATION_UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800, "": 1}


def parse_duration(value):
    """Parse a duration string to whole seconds, or None when auto-removal is disabled.

    Accepts `24h` / `7d` / `90m` / `45` (bare = seconds). `0`, `never`, `off`, `none`,
    empty, or an unparseable value all return None (disabled) — the safe default, so a
    typo never deletes anything. Mirrors parseDuration in server/src/queues.js.
    """
    if value is None:
        return None
    s = str(value).strip().lower()
    if s in ("", "0", "never", "off", "none", "disabled"):
        return None
    m = _DURATION_RE.match(s)
    if not m:
        return None
    n = int(m.group(1))
    if n == 0:
        return None
    return n * _DURATION_UNITS[m.group(2)]


def _is_rating_key(value):
    """True if `value` is (or stringifies to) a bare numeric ratingKey."""
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, str) and value.strip().isdigit()


def entry_key(entry):
    """Stable identity for a queue entry, used to match file lines during prune.

    A ratingKey (scalar or mapping) keys as `rk:<n>`; a title (scalar string or a
    mapping's `title:`) keys as `title:<verbatim text>`. So a `- 12345` and a
    `{ratingKey: 12345}` collide (same entry), and a hand-typed title line keys on its
    exact text — which is what prune compares, so the human's line is never rewritten.
    """
    if isinstance(entry, dict):
        rk = entry.get("ratingKey")
        if rk is not None:
            return f"rk:{rk}"
        coll = entry.get("collection")
        if coll:
            # A `{collection: X}` mapping keys identically to a `Collection: X` string, so
            # the two spellings collide (same entry) and mark-done can round-trip either.
            return f"title:Collection: {str(coll).strip()}"
        title = entry.get("title")
        return f"title:{str(title).strip()}" if title else None
    if _is_rating_key(entry):
        return f"rk:{str(entry).strip()}"
    text = str(entry).strip()
    return f"title:{text}" if text else None


def _describe(entry):
    """Normalize a raw queue entry into a resolution descriptor.

    Returns {key, ratingKey|None, title|None, year|None, guid|None, collection|None,
    episodes|None, done, raw}. `title` is the PARSED bare title (year/guid peeled into
    their own fields); `collection` is the name from a `Collection: <name>` string or a
    `{collection: <name>}` mapping (plays that whole Plex Collection in order); `done` is
    True for a finished-but-kept entry (marked, not pruned — see mark_done); `raw` is the
    original file value (unused by resolution, handy for debugging).
    """
    if isinstance(entry, dict):
        rk = entry.get("ratingKey")
        coll = entry.get("collection")
        title, year, guid = (None, None, None)
        if entry.get("title"):
            title, year, guid = parse_title_string(entry["title"])
        # A `Collection: X` string may also arrive inside a mapping's `title:`; peel it out.
        if coll is None and title:
            cm = _COLLECTION_RE.match(title)
            if cm:
                coll = cm.group(1).strip()
        return {"key": entry_key(entry),
                "ratingKey": None if rk is None else str(rk),
                "title": title or None, "year": year, "guid": guid,
                "collection": str(coll).strip() if coll else None,
                "episodes": entry.get("episodes"),
                # Manual START floor {season, episode}: begin the show here, skipping earlier
                # episodes WITHOUT marking them watched (resume-from-Crunchyroll / skip-a-saga).
                "start": entry.get("start"),
                "done": bool(entry.get("done")), "raw": entry}
    if _is_rating_key(entry):
        return {"key": entry_key(entry), "ratingKey": str(entry).strip(),
                "title": None, "year": None, "guid": None, "collection": None,
                "episodes": None, "done": False, "raw": entry}
    title, year, guid = parse_title_string(entry)
    cm = _COLLECTION_RE.match(title)
    coll = cm.group(1).strip() if cm else None
    return {"key": entry_key(entry), "ratingKey": None,
            "title": title or None, "year": year, "guid": guid,
            "collection": coll, "episodes": None, "done": False, "raw": entry}


def _ruamel():
    """Return a configured ruamel YAML round-trip handler, or None if unavailable."""
    try:
        from ruamel.yaml import YAML
    except Exception:  # noqa: BLE001 — dry-run env may lack ruamel; caller falls back
        return None
    y = YAML()
    y.preserve_quotes = True
    y.indent(mapping=2, sequence=2, offset=0)
    return y


def _load_raw():
    """Parse queues.yaml. Returns (data, handler) — data is the ruamel/py object (mutable
    for ruamel), handler is the ruamel YAML or None when PyYAML-read fallback was used."""
    path = config.QUEUES_PATH
    if not os.path.exists(path):
        return {}, None
    y = _ruamel()
    with open(path, "r", encoding="utf-8") as f:
        if y is not None:
            return (y.load(f) or {}), y
        import yaml  # PyYAML read fallback (loses comments on any later rewrite)
        return (yaml.safe_load(f) or {}), None


def entries(set_name):
    """Ordered list of resolution descriptors for a set, [] if the set/file is empty.

    Each descriptor (see _describe) carries a stable `key`, plus a ratingKey OR a parsed
    (title, year, guid) for title-string resolution. Blank/keyless entries are dropped.
    """
    with _LOCK:
        data, _ = _load_raw()
    seq = (data or {}).get(set_name) or []
    out = []
    for e in seq:
        desc = _describe(e)
        if desc["key"] is not None:
            out.append(desc)
    return out


def prune(set_name, keep_keys):
    """Rewrite `set_name`'s list to only entries whose `entry_key` is in `keep_keys`.

    Re-reads off disk first (an SMB edit may have landed), filters that set's sequence to
    the kept entries (in the file's own order, verbatim text preserved), and atomically
    os.replace()s the result so a reader never sees a half-written file. No-op (returns
    False) if ruamel is missing or the file doesn't exist — we never clobber formatting
    with a lesser writer.
    """
    keep = set(keep_keys)
    with _LOCK, _file_lock():
        y = _ruamel()
        path = config.QUEUES_PATH
        if y is None or not os.path.exists(path):
            return False
        with open(path, "r", encoding="utf-8") as f:
            data = y.load(f) or {}
        seq = data.get(set_name)
        if seq is None:
            return False
        # Delete finished entries in place (high→low index) so remaining items keep their
        # comments/anchors; ruamel handles CommentedSeq item deletion.
        for i in range(len(seq) - 1, -1, -1):
            if entry_key(seq[i]) not in keep:
                del seq[i]
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            y.dump(data, f)
        try:
            os.replace(tmp, path)                # atomic: a reader never sees a half file
        except OSError:
            # os.replace can't rename OVER a single-file bind-mount (EBUSY) or across devices.
            # The deploy mounts the DIRECTORY (so this path shouldn't hit), but fall back to a
            # direct in-place rewrite so a single-file mount still prunes. Non-atomic, but the
            # lock + re-read-before-write already bound the risk to one lost line.
            with open(path, "w", encoding="utf-8") as f:
                y.dump(data, f)
            try:
                os.remove(tmp)
            except OSError:
                pass
        return True


def _ttl_for(cfg):
    """Resolve a set's completed-entry TTL in seconds, or None when auto-removal is off.

    The per-set `remove_completed_after` (from sets.yaml → config cfg) wins; absent → the
    global config.REMOVE_COMPLETED_AFTER default. Either way it is parsed by parse_duration,
    so `0`/`never`/blank disables. See the §B.3 config notes.
    """
    raw = (cfg or {}).get("remove_completed_after")
    if raw is None:
        raw = config.REMOVE_COMPLETED_AFTER
    return parse_duration(raw)


def sweep_completed(set_name, cfg, now=None):
    """Auto-remove entries finished longer ago than the set's TTL (§B.3). Returns True if
    anything was removed.

    Complements mark_done: a finished entry is first KEPT + tagged `done: true`/`done_at`
    (so the finished-series anchor stays visible), then removed automatically once it is
    older than `remove_completed_after` (per-set) / config.REMOVE_COMPLETED_AFTER (global,
    default 24h). A set with `keep_completed: true` or `reel: true` is EXEMPT — its finished
    entries are never swept. Only entries carrying a numeric `done_at` are eligible, so a
    hand-marked `done: true` with no timestamp (or a not-done entry) is left untouched.

    Reuses `prune` for the actual atomic, comment-preserving removal: we compute the keys to
    KEEP (everything except the past-TTL done entries) and hand them to prune. No-op (False)
    when auto-removal is disabled/exempt or nothing is past its TTL.
    """
    if cfg.get("keep_completed") or cfg.get("reel"):
        return False
    ttl = _ttl_for(cfg)
    if ttl is None:
        return False
    now = time.time() if now is None else now
    keep, remove = [], []
    for desc in entries(set_name):
        raw = desc.get("raw")
        done_at = raw.get("done_at") if isinstance(raw, dict) else None
        past = False
        if desc.get("done") and done_at is not None:
            try:
                past = (now - float(done_at)) >= ttl
            except (TypeError, ValueError):
                past = False           # unparseable done_at: never auto-remove
        (remove if past else keep).append(desc["key"])
    if not remove:
        return False
    return prune(set_name, keep)


def mark_done(set_name, keep_keys):
    """Tag the given entries **done** in place — kept in the file, excluded from play.

    This replaces the auto-prune of finished entries (decision
    2026-07-21-finished-entries-marked-done-not-pruned): anime has no "Season 2", so a
    finished series must stay visible as the anchor Bob adds the sequel next to. Removal
    is now explicit (a Node endpoint / per-item delete), never automatic.

    Mirrors prune's round-trip discipline (re-read off disk, transform, atomic rewrite). A
    scalar entry is converted to a mapping so it can carry the flag — a ratingKey scalar ->
    `{ratingKey: <n>, done: true, done_at: <epoch>}`, a title/`Collection:` scalar ->
    `{title: <text>, done: true, done_at: <epoch>}`; a mapping simply gains `done: true` +
    `done_at`, preserving its other fields/comments. `done_at` (epoch seconds, stamped
    alongside `done`) is what queues.sweep_completed measures the TTL against — an entry
    marked done here becomes eligible for auto-removal once it is older than the set's
    remove_completed_after. Match is by `entry_key`, so the human's own text is never
    rewritten (only wrapped). No-op (False) if ruamel is missing, the file/set is absent, or
    nothing changed — we never clobber formatting with a lesser writer.
    """
    want = set(keep_keys)
    if not want:
        return False
    with _LOCK, _file_lock():
        y = _ruamel()
        path = config.QUEUES_PATH
        if y is None or not os.path.exists(path):
            return False
        from ruamel.yaml.comments import CommentedMap
        with open(path, "r", encoding="utf-8") as f:
            data = y.load(f) or {}
        seq = data.get(set_name)
        if seq is None:
            return False
        now = int(time.time())
        changed = False
        for i in range(len(seq)):
            item = seq[i]
            if entry_key(item) not in want:
                continue
            if isinstance(item, dict):
                if not item.get("done"):
                    item["done"] = True
                    item["done_at"] = now      # TTL clock starts now (§B.3)
                    changed = True
            else:
                m = CommentedMap()
                if _is_rating_key(item):
                    m["ratingKey"] = str(item).strip()
                else:
                    m["title"] = str(item).strip()
                m["done"] = True
                m["done_at"] = now             # TTL clock starts now (§B.3)
                seq[i] = m
                changed = True
        if not changed:
            return False
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            y.dump(data, f)
        try:
            os.replace(tmp, path)
        except OSError:
            with open(path, "w", encoding="utf-8") as f:
                y.dump(data, f)
            try:
                os.remove(tmp)
            except OSError:
                pass
        return True


def clear_done(set_name, keep_keys):
    """Un-mark the given entries — strip `done` + `done_at`, keeping every other field/comment.

    The inverse of mark_done, for STALE-DONE recovery: an entry mis-marked `done: true` whose
    live Plex state is actually in-progress (a Season-0 OAD the specials filter used to drop,
    or a partial view that briefly looked finished) must rejoin the lineup. Clearing the flag
    here also lifts the TTL clock, so queues.sweep_completed can't auto-remove it while the
    owner is mid-episode. A one-time write on the transition back to active — once genuinely
    watched, next_queue re-marks it done normally.

    Mirrors mark_done's round-trip discipline (re-read off disk, transform, atomic rewrite),
    matched by `entry_key`. A scalar entry (never carrying `done`) is left untouched. No-op
    (False) if ruamel is missing, the file/set is absent, or nothing changed.
    """
    want = set(keep_keys)
    if not want:
        return False
    with _LOCK, _file_lock():
        y = _ruamel()
        path = config.QUEUES_PATH
        if y is None or not os.path.exists(path):
            return False
        with open(path, "r", encoding="utf-8") as f:
            data = y.load(f) or {}
        seq = data.get(set_name)
        if seq is None:
            return False
        changed = False
        for item in seq:
            if not isinstance(item, dict) or entry_key(item) not in want:
                continue
            for field in ("done", "done_at"):
                if field in item:
                    del item[field]
                    changed = True
        if not changed:
            return False
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            y.dump(data, f)
        try:
            os.replace(tmp, path)
        except OSError:
            with open(path, "w", encoding="utf-8") as f:
                y.dump(data, f)
            try:
                os.remove(tmp)
            except OSError:
                pass
        return True
