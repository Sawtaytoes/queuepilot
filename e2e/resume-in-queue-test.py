#!/usr/bin/env python3
"""Engine test for RESUME-IN-QUEUE (docs ROADMAP §B.2).

A curated queue (`source: queue`) whose lead item was STARTED but not finished must resume
THAT item at its Plex viewOffset on the next scan — not advance, not restart at 0. A
finished item still advances; a fresh (0-offset) item still starts at 0. And the resume
offset must be threaded all the way to the Companion `playMedia` call.

Runs fully offline: Plex reads (entries / watched / resolve / per-item view state) and the
device call are all stubbed, so nothing here touches the live server.

Run:  python3 e2e/resume-in-queue-test.py    (from the repo root; non-zero on failure)
"""
import os
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from queue_builder import config, playback, plex, queues  # noqa: E402

FAILS = []


def ok(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  -- {detail}" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


# --------------------------------------------------------------------------- #
# resume_offset: the in-progress predicate (viewOffset > 0 AND not finished)
# --------------------------------------------------------------------------- #
VIEW_STATE = {}  # ratingKey -> (viewOffset_ms, viewCount)
plex.item_view_state = lambda rk, token=None: VIEW_STATE.get(str(rk), (0, 0))

VIEW_STATE.update({
    "inprog": (45000, 0),   # started, not finished -> resume at 45000
    "fresh": (0, 0),        # never started -> 0
    "rewound": (30000, 1),  # finished once then rewound -> a completed view, so NOT resumed
})

ok("resume_offset: in-progress item returns its viewOffset",
   plex.resume_offset("inprog", set()) == 45000)
ok("resume_offset: fresh item returns 0",
   plex.resume_offset("fresh", set()) == 0)
ok("resume_offset: viewCount>0 (finished, then rewound) returns 0",
   plex.resume_offset("rewound", set()) == 0)
# Live view-state is authoritative: an in-progress item RESUMES even if the set's history
# flagged it watched (the OAD bug — a history row must never override a live partial view).
ok("resume_offset: in-progress resumes even if history flagged it watched",
   plex.resume_offset("inprog", {"inprog"}) == 45000)


# --------------------------------------------------------------------------- #
# next_queue: selects the in-progress lead and reports its offset
# --------------------------------------------------------------------------- #
config.SETS = {"bob": {"kind": "movie", "source": "queue"}}  # kind != anime -> ordered queue
plex.account_token = lambda uuid: None
plex._watched_for_set = lambda cfg, binding=None: set(WATCHED)
queues.mark_done = lambda set_name, keys: True   # never write a file in the test
queues.clear_done = lambda set_name, keys: True
queues.sweep_completed = lambda set_name, cfg, now=None: False
WATCHED = set()

# A tiny descriptor + resolver stand-in: each queues.yaml entry maps to a canned batch.
RESOLVE = {}  # key -> {"title","type","items":[...]} | None (unresolved)


def fake_entries(set_name):
    return ENTRIES


def fake_resolve_member(desc, cfg, watched, token=None, default_batch=None, resume=False):
    return RESOLVE.get(desc["key"])


queues.entries = fake_entries
plex.resolve_member = fake_resolve_member


def desc(key, done=False):
    return {"key": key, "done": done, "title": key, "ratingKey": None, "collection": None}


def item(rk):
    return {"ratingKey": rk, "title": rk, "show": None, "season": None, "episode": None}


# 1. In-progress MOVIE lead: chosen, and its offset reported.
ENTRIES = [desc("movieA")]
RESOLVE = {"movieA": {"title": "Movie A", "type": "movie", "items": [item("inprog")]}}
WATCHED = set()
res = plex.next_queue("bob")
ok("in-progress movie is the play head",
   [i["ratingKey"] for i in res["play"]] == ["inprog"], str(res["play"]))
ok("in-progress movie reports its viewOffset", res["offset"] == 45000, str(res["offset"]))

# 2. In-progress SERIES: the started episode leads and its offset is reported (later
#    episodes stay in the batch and play from 0 after it).
ENTRIES = [desc("showX")]
RESOLVE = {"showX": {"title": "Show X", "type": "show",
                     "items": [item("inprog"), item("fresh")]}}
res = plex.next_queue("bob")
ok("in-progress episode leads the series batch",
   [i["ratingKey"] for i in res["play"]] == ["inprog", "fresh"], str(res["play"]))
ok("series resume reports the episode's viewOffset", res["offset"] == 45000, str(res["offset"]))

# 3. Finished lead still ADVANCES: entry 1 is fully watched (empty items -> done), so the
#    next entry leads and, being fresh, starts at 0.
ENTRIES = [desc("movieDone"), desc("movieNext")]
RESOLVE = {"movieDone": {"title": "Done", "type": "movie", "items": []},
           "movieNext": {"title": "Next", "type": "movie", "items": [item("fresh")]}}
res = plex.next_queue("bob")
ok("finished entry advances to the next entry",
   [i["ratingKey"] for i in res["play"]] == ["fresh"], str(res["play"]))
ok("advanced-to fresh item starts at 0", res["offset"] == 0, str(res["offset"]))

# 4. Fresh lead: a queued item never started plays from 0.
ENTRIES = [desc("movieFresh")]
RESOLVE = {"movieFresh": {"title": "Fresh", "type": "movie", "items": [item("fresh")]}}
res = plex.next_queue("bob")
ok("fresh lead starts at 0", res["offset"] == 0, str(res["offset"]))


# --------------------------------------------------------------------------- #
# play_rating_keys: the offset reaches the Companion playMedia call (client path)
# --------------------------------------------------------------------------- #
CALLS = []


def fake_req(method, path, token=None, host=None, extra_headers=None):
    CALLS.append(path)
    return {"MediaContainer": {"playQueueID": 77}}


playback._req = fake_req
playback.find_client = lambda device=None: {"name": "Shield", "machineIdentifier": "mid", "uri": "http://x:32500"}
playback.create_play_queue = lambda rks, token=None, continuous=True: 77
plex.machine_identifier = lambda: "server-mid"
config.SETS = {"bob": {"source": "queue"}}
config.PLEX_LOCAL_URL = "http://192.0.2.5:32400"


def playmedia_query():
    path = next((p for p in CALLS if "playMedia" in p), "")
    return dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(path).query))


# Resume: a non-zero offset is passed straight through as Companion's `offset` (ms).
CALLS.clear()
playback.play_rating_keys(["inprog", "fresh"], set_name="bob",
                          device={"mode": "client"}, offset=45000)
ok("offset is threaded to the playMedia call",
   playmedia_query().get("offset") == "45000", str(playmedia_query()))

# Fresh: no offset -> plays from 0, exactly as before.
CALLS.clear()
playback.play_rating_keys(["fresh"], set_name="bob", device={"mode": "client"}, offset=0)
ok("a 0 offset still starts playback at 0",
   playmedia_query().get("offset") == "0", str(playmedia_query()))


print(f"FAILURES: {len(FAILS)}" if FAILS else "done")
sys.exit(1 if FAILS else 0)
