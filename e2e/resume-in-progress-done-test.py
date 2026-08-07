#!/usr/bin/env python3
"""Engine test: an IN-PROGRESS queued item must never read as finished/done (the OAD bug).

Live-Plex evidence (2026-08, bob_anime): the entry "Prison School: Mad Wax (2016)" is a
1-leaf, Season-0 OAD (ratingKey 363480 -> leaf 363482), and Plex has it mid-episode
(viewOffset 1060898 ms, viewCount ABSENT = 0, no history row). An earlier scan still marked
the entry `done: true`, because `_keep_episode` dropped its only leaf as a front-loading
"special", so it looked finished — and it was then skipped while the owner was mid-episode.

This exercises the REAL resolve_member / next_queue (only the Plex network layer + the
queues.yaml writers are stubbed) and asserts:
  * a specials-only show keeps its Season-0 leaf on the queue path (not dropped);
  * an in-progress leaf is kept even when the set's history counts it watched;
  * an entry flagged `done: true` but actually in-progress is REVIVED (selected, resumed at
    its viewOffset) and its stale flag cleared;
  * a genuinely-watched item (viewCount >= 1) still resolves finished / stays done.

Run:  python3 e2e/resume-in-progress-done-test.py   (from the repo root; non-zero on failure)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from queue_builder import config, plex, queues  # noqa: E402

FAILS = []


def ok(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  -- {detail}" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


# --- fixtures: per-leaf view state, keyed by show ratingKey ----------------------- #
# Each value is the show's allLeaves as show_episodes would shape it (viewCount coerced so an
# ABSENT count is 0). Season 0 => an OAD/special; season >= 1 => a real season.
LEAVES = {
    # The Prison School OAD: one Season-0 leaf, mid-episode, viewCount ABSENT (-> 0).
    "363480": [{"ratingKey": "363482", "title": "OAD", "show": "Prison School: Mad Wax",
                "season": 0, "episode": 1, "duration": 1532964,
                "viewCount": 0, "viewOffset": 1060898}],
    # A genuinely-finished 1-leaf special: watched once, no resume point.
    "900000": [{"ratingKey": "900001", "title": "OVA", "show": "Watched Special",
                "season": 0, "episode": 1, "duration": 1000000,
                "viewCount": 1, "viewOffset": 0}],
    # A normal multi-season show: S1E1 watched, S1E2 in-progress, S1E3 fresh.
    "700000": [{"ratingKey": "700001", "title": "e1", "show": "Real Show", "season": 1,
                "episode": 1, "duration": 1000000, "viewCount": 1, "viewOffset": 0},
               {"ratingKey": "700002", "title": "e2", "show": "Real Show", "season": 1,
                "episode": 2, "duration": 1000000, "viewCount": 0, "viewOffset": 500000},
               {"ratingKey": "700003", "title": "e3", "show": "Real Show", "season": 1,
                "episode": 3, "duration": 1000000, "viewCount": 0, "viewOffset": 0}],
}
TITLES = {"363480": "Prison School: Mad Wax", "900000": "Watched Special", "700000": "Real Show"}

plex.show_episodes = lambda rk, token=None: [dict(e) for e in LEAVES[str(rk)]]
plex.resolve_queue_entry = lambda desc, cfg, token=None: (
    str(desc["ratingKey"]), "show", TITLES[str(desc["ratingKey"])])
plex.item_view_state = lambda rk, token=None: next(
    ((e["viewOffset"], e["viewCount"]) for eps in LEAVES.values() for e in eps
     if e["ratingKey"] == str(rk)), (0, 0))
plex.account_token = lambda uuid: None
plex._watched_for_set = lambda cfg, binding=None: set(WATCHED)

# Record the queues.yaml writers instead of touching a file.
CLEARED, MARKED = [], []
queues.mark_done = lambda set_name, keys: MARKED.extend(keys) or True
queues.clear_done = lambda set_name, keys: CLEARED.extend(keys) or True
queues.sweep_completed = lambda set_name, cfg, now=None: False
queues.entries = lambda set_name: [dict(e) for e in ENTRIES]

config.SETS = {"q": {"source": "queue"}}  # kind != anime -> ordered queue (deterministic head)


def entry(rk, done=False):
    return {"key": f"rk:{rk}", "ratingKey": str(rk), "title": None, "year": None,
            "guid": None, "collection": None, "episodes": None, "start": None, "done": done}


def run():
    global CLEARED, MARKED
    CLEARED, MARKED = [], []
    return plex.next_queue("q")


# 1. resolve_member keeps a specials-only show's Season-0 leaf on the resume path.
r = plex.resolve_member(entry("363480"), config.SETS["q"], set(), resume=True)
ok("specials-only show keeps its Season-0 OAD leaf",
   [i["ratingKey"] for i in r["items"]] == ["363482"], str(r))
# ...and WITHOUT resume (rotation path) the Season-0-only leaf is still dropped, unchanged.
r0 = plex.resolve_member(entry("363480"), config.SETS["q"], set(), resume=False)
ok("rotation path still drops the Season-0 special", r0["items"] == [], str(r0))

# 2. An in-progress leaf is kept even when history counts the whole show watched.
r = plex.resolve_member(entry("363480"), config.SETS["q"], {"363482"}, resume=True)
ok("in-progress leaf survives a watched-history hit",
   [i["ratingKey"] for i in r["items"]] == ["363482"], str(r))

# 3. next_queue REVIVES a done-flagged OAD that is actually in-progress: it plays, resumes at
#    the leaf's viewOffset, clears the stale flag, and is not reported finished.
WATCHED = set()
ENTRIES = [entry("363480", done=True)]
res = run()
ok("done OAD is revived as the play head",
   [i["ratingKey"] for i in res["play"]] == ["363482"], str(res["play"]))
ok("revived OAD resumes at its viewOffset", res["offset"] == 1060898, str(res["offset"]))
ok("revived OAD clears its stale done flag", CLEARED == ["rk:363480"], str(CLEARED))
ok("revived OAD is not listed finished", not res["done"], str(res["done"]))

# 4. A genuinely-watched done special STAYS done: no in-progress item, nothing to revive.
WATCHED = {"900001"}
ENTRIES = [entry("900000", done=True)]
res = run()
ok("watched special stays done (no play)", res["play"] == [], str(res["play"]))
ok("watched special is not revived", CLEARED == [], str(CLEARED))

# 5. A normal series leads with its in-progress episode (S1E2), not the watched S1E1. A queue
#    plays QUEUE_SERIES_DEFAULT (1) episode per scan, so the resumed episode is the play head.
WATCHED = {"700001"}
ENTRIES = [entry("700000")]
res = run()
ok("series leads with the in-progress episode (default batch = 1)",
   [i["ratingKey"] for i in res["play"]] == ["700002"], str(res["play"]))
ok("series reports the in-progress episode's offset", res["offset"] == 500000, str(res["offset"]))


# --------------------------------------------------------------------------- #
# bob_anime is a SHUFFLED channel (kind == "anime"): the in-progress OAD must still LEAD so
# it resumes, not land mid-shuffle behind fresh members. Seed the shuffle so, without the
# hoist, the fresh member would sort first.
# --------------------------------------------------------------------------- #
import random as _random  # noqa: E402

config.SETS = {"q": {"source": "queue", "kind": "anime"}}
WATCHED = set()
ENTRIES = [entry("700000"), entry("363480", done=True)]  # fresh multi-season + revived OAD
res = plex.next_queue("q", rng=_random.Random(0))
ok("anime channel leads with the in-progress OAD",
   res["play"] and res["play"][0]["ratingKey"] == "363482", str(res["play"][:2]))
ok("anime channel resumes the OAD at its offset", res["offset"] == 1060898, str(res["offset"]))
config.SETS = {"q": {"source": "queue"}}  # restore for any later cases


print(f"FAILURES: {len(FAILS)}" if FAILS else "done")
sys.exit(1 if FAILS else 0)
