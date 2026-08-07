#!/usr/bin/env python3
"""Engine test for the non-consuming `keep_completed` queue flag (decision
2026-08-07-non-consuming-keep-completed-queue-flag).

Two guarantees, both offline (Plex resolution stubbed, no token/network):

  1. config parsing: `keep_completed: true` lands on the cfg, and `reel: true` IMPLIES
     keep_completed.
  2. plex.next_queue: a finished entry marks the set `done` for a NORMAL queue, but NEVER
     for a keep_completed set nor a reel set.

Run:  python3 e2e/keep-completed-test.py    (from the repo root; non-zero on failure)
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from queue_builder import config, plex, queues  # noqa: E402

FAILS = []


def ok(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        FAILS.append(name)


# --- 1. config parsing: the flag round-trips and `reel` implies it -------------------- #
SETS_YAML = """\
sets:
  - id: normalq
    label: Normal Queue
    source: queue
    sections: [1]
  - id: playlistq
    label: Playlist Queue
    source: queue
    sections: [1]
    keep_completed: true
  - id: demo
    label: Demo Reel
    source: queue
    sections: [1]
    reel: true
"""

with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as _f:
    _f.write(SETS_YAML)
    _sets_path = _f.name
config.SETS_PATH = _sets_path
loaded = config._load_sets_yaml()
ok("sets.yaml parses", loaded is not None)
by_id = loaded[0] if loaded else {}
ok("normal queue is NOT keep_completed", not by_id.get("normalq", {}).get("keep_completed"))
ok("keep_completed: true lands on the cfg", by_id.get("playlistq", {}).get("keep_completed") is True)
ok("reel: true IMPLIES keep_completed", by_id.get("demo", {}).get("keep_completed") is True)
os.unlink(_sets_path)


# --- 2. next_queue: mark_done fires only for a consuming set --------------------------- #
# Stub every Plex/queue dependency so next_queue runs offline and we can observe whether
# mark_done was called. Each set has ONE entry that resolves as FINISHED (no unwatched
# items), which is exactly what triggers the mark_done branch for a normal queue.
_marked = []
queues.mark_done = lambda set_name, keys: _marked.append((set_name, list(keys)))
queues.entries = lambda set_name: [{"key": "rk:1", "done": False, "title": "Movie", "ratingKey": "1"}]
plex.account_token = lambda user_uuid: None
plex._watched_for_set = lambda cfg, binding=None: set()
plex.resolve_member = lambda desc, cfg, watched, token=None, default_batch=None, resume=False: {
    "items": [], "title": "Movie", "type": "movie"}


def run(cfg):
    _marked.clear()
    config.SETS = {"s": cfg}
    res = plex.next_queue("s")
    return res, list(_marked)


base = {"source": "queue", "kind": "movies", "user_uuid": None}

_, marked = run(dict(base))
ok("normal queue marks the finished entry done", marked == [("s", ["rk:1"])])

_, marked = run(dict(base, keep_completed=True))
ok("keep_completed set never marks done", marked == [])

_, marked = run(dict(base, reel=True))
ok("reel set never marks done", marked == [])

print(f"FAILURES: {len(FAILS)}" if FAILS else "done")
sys.exit(1 if FAILS else 0)
