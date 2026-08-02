#!/usr/bin/env python3
"""Engine test for the COLLECTION start floor: {series, season, episode}.

`collection_items` must skip every member BEFORE the named series, floor that member's
episodes at {season, episode}, and leave later members untouched. Runs offline — Plex's
children/episode listings are stubbed, so nothing here depends on the live server.

Run:  python3 e2e/collection-start-test.py    (from the repo root; non-zero on failure)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from queue_builder import plex  # noqa: E402

FAILS = []


def ok(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        FAILS.append(name)


CHILDREN = [
    {"ratingKey": "100", "type": "show", "title": "Series One"},
    {"ratingKey": "200", "type": "show", "title": "Series Two"},
    {"ratingKey": "300", "type": "movie", "title": "The Movie"},
]


def episodes(rk, token=None):
    """3 episodes per series, ratingKeys <rk><ep> — enough to see a floor bite."""
    return [{"ratingKey": f"{rk}{i}", "title": f"ep{i}", "show": f"Show {rk}",
             "season": 1, "episode": i, "duration": 1000} for i in (1, 2, 3)]


plex.find_collection = lambda section, name, token=None: "999"
plex.collection_children = lambda rk, token=None: CHILDREN
plex.show_episodes = episodes

CFG = {"queue_sections": [11]}
titles = lambda items: [i["ratingKey"] for i in items]  # noqa: E731


# No start: everything, in collection order.
all_items = plex.collection_items(CFG, "Anything", set())
ok("no start -> every member, in order",
   titles(all_items) == ["1001", "1002", "1003", "2001", "2002", "2003", "300"])

# Start at the SECOND series, episode 2: series one is skipped entirely, series two starts
# at its episode 2, and the movie after it is untouched.
floored = plex.collection_items(CFG, "Anything", set(), start={"series": "200", "season": 1, "episode": 2})
ok("start floors the collection at the named member",
   titles(floored) == ["2002", "2003", "300"])

# The member may be named by TITLE (a hand-written YAML entry), not just by ratingKey.
by_title = plex.collection_items(CFG, "Anything", set(), start={"series": "Series Two", "episode": 3})
ok("member can be named by title", titles(by_title) == ["2003", "300"])

# A start naming a MOVIE member has no episode — it just skips what comes before it.
movie_start = plex.collection_items(CFG, "Anything", set(), start={"series": "300"})
ok("movie member start skips the earlier members", titles(movie_start) == ["300"])

# An unknown member is ignored rather than emptying the collection (a renamed/removed series
# must not silently stop the queue).
unknown = plex.collection_items(CFG, "Anything", set(), start={"series": "404", "episode": 2})
ok("unknown member -> no floor, plays normally", titles(unknown) == titles(all_items))

# The floor never marks anything watched — it only removes earlier items from the pick, and
# already-watched ones still drop out normally.
with_watched = plex.collection_items(CFG, "Anything", {"2002"}, start={"series": "200", "season": 1, "episode": 2})
ok("watched items still drop out at/after the floor", titles(with_watched) == ["2003", "300"])

print(f"FAILURES: {len(FAILS)}" if FAILS else "done")
sys.exit(1 if FAILS else 0)
