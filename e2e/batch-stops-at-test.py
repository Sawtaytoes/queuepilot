#!/usr/bin/env python3
"""Engine test for `batch_stops_at` — WHERE a multi-episode batch may stop.

The count cap (`episodes:`) says how many; this says where the batch may end. The case that
motivated it (owner, 2026-08-12): a two-episode batch sitting on a season finale queued the
finale AND the next season's premiere — or, inside a `Collection:`, the finale AND episode 1
of the NEXT member show. Watchable, but not what you want right after an emotional finale.

  "none"   (default) - fills across anything (today's behavior, must not regress)
  "member" - never spans two collection members
  "season" - also never spans a season boundary, INCLUDING inside one show

Pinned here: both boundaries, the entry > set > global precedence, the floor of ONE item (an
empty batch is the FINISHED signal — a boundary cut must never retire a show mid-run), and
that the uncapped rotation caller is untouched.

Mirrors e2e/batch-stops-at-test.mjs, which pins the same table in the Node port.

Run:  python3 e2e/batch-stops-at-test.py    (from the repo root; non-zero on failure)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from queue_builder import config, plex  # noqa: E402

FAILS = []


def ok(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  -- {detail}" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


def eq(name, got, want):
    ok(name, got == want, f"got {got!r}, want {want!r}")


# --------------------------------------------------------------------------- #
# Fixtures: two shows, "Alpha" with two seasons (S1 x2, S2 x2) and "Beta" (S1 x2),
# sitting in one collection in that order.
# --------------------------------------------------------------------------- #
SECTION = 11
CFG = {"queue_sections": [SECTION], "episodic_sections": [SECTION], "item_sections": []}


def leaf(show, season, episode, rk):
    return {"ratingKey": str(rk), "title": f"{show} S{season}E{episode}", "show": show,
            "season": season, "episode": episode, "duration": 1_400_000, "type": "episode",
            "extraType": None, "viewCount": 0, "viewOffset": 0}


ALPHA = [leaf("Alpha", 1, 1, 101), leaf("Alpha", 1, 2, 102),
         leaf("Alpha", 2, 1, 201), leaf("Alpha", 2, 2, 202)]
BETA = [leaf("Beta", 1, 1, 301), leaf("Beta", 1, 2, 302)]
LEAVES = {"600": ALPHA, "700": BETA}

# Two movie members, to prove they are never fused into one segment (their `show` is the
# collection name, so a boundary keyed on `show` alone would treat the pair as one member).
MOVIES = [{"ratingKey": "801", "title": "Movie One", "type": "movie", "duration": 1},
          {"ratingKey": "802", "title": "Movie Two", "type": "movie", "duration": 1}]

# Fresh dicts per call, exactly like the real show_episodes — resolve tags `member_key` in
# place, and a shared list would leak that tag between cases.
plex.show_episodes = lambda rk, token=None: [dict(e) for e in LEAVES.get(str(rk), [])]
plex.item_view_state = lambda rk, token=None: (0, 0)
# A bare-ratingKey entry resolves through item_type; both fixture shows are shows.
plex.item_type = lambda rk, token=None: ("show", "Alpha" if str(rk) == "600" else "Beta")
plex.find_collection = lambda sec, name, token=None: "5000" if sec == SECTION else None
plex.collection_children = lambda rk, token=None: list(CHILDREN)
CHILDREN = [{"ratingKey": "600", "title": "Alpha", "type": "show"},
            {"ratingKey": "700", "title": "Beta", "type": "show"}]

COLL = {"collection": "Both Shows", "key": "title:Collection: Both Shows"}
SHOW = {"ratingKey": "600", "key": "rk:600"}


def items(desc, cfg=None, batch=1, watched=()):
    res = plex.resolve_member(desc, dict(CFG, **(cfg or {})), set(watched),
                              default_batch=batch, resume=True)
    return [e["title"] for e in res["items"]]


# --------------------------------------------------------------------------- #
# 1. Default ("none") — today's behavior, across BOTH boundary kinds
# --------------------------------------------------------------------------- #
eq("default: a 2-batch spans the member boundary (Alpha finale + Beta ep 1)",
   items(COLL, batch=2, watched={"101", "102", "201"}),
   ["Alpha S2E2", "Beta S1E1"])
eq("default: a 2-batch spans the SEASON boundary inside one show",
   items(SHOW, batch=2, watched={"101"}),
   ["Alpha S1E2", "Alpha S2E1"])

# --------------------------------------------------------------------------- #
# 2. "member" — a batch never spans two collection members
# --------------------------------------------------------------------------- #
eq("member: the collection's last Alpha episode plays ALONE",
   items(COLL, {"batch_stops_at": "member"}, batch=2, watched={"101", "102", "201"}),
   ["Alpha S2E2"])
eq("member: a batch WITHIN one member is still filled",
   items(COLL, {"batch_stops_at": "member"}, batch=2, watched={"101"}),
   ["Alpha S1E2", "Alpha S2E1"])   # same member, so the season boundary is not its business
eq("member: is a no-op for a plain show entry (one member by definition)",
   items(SHOW, {"batch_stops_at": "member"}, batch=2, watched={"101"}),
   ["Alpha S1E2", "Alpha S2E1"])

# --------------------------------------------------------------------------- #
# 3. "season" — also cuts at a season boundary, inside a show as well
# --------------------------------------------------------------------------- #
eq("season: a show at its finale queues the finale ALONE",
   items(SHOW, {"batch_stops_at": "season"}, batch=2, watched={"101"}),
   ["Alpha S1E2"])
eq("season: mid-season, the batch still fills",
   items(SHOW, {"batch_stops_at": "season"}, batch=2, watched=()),
   ["Alpha S1E1", "Alpha S1E2"])
eq("season: implies the member boundary too",
   items(COLL, {"batch_stops_at": "season"}, batch=2, watched={"101", "102", "201"}),
   ["Alpha S2E2"])

# --------------------------------------------------------------------------- #
# 4. Two movie members are two segments, never one
# --------------------------------------------------------------------------- #
CHILDREN = list(MOVIES)
eq("member: two movie members are NOT fused into one segment",
   items(COLL, {"batch_stops_at": "member"}, batch=2),
   ["Movie One"])
eq("default: the same pair still fills across, as it always did",
   items(COLL, batch=2),
   ["Movie One", "Movie Two"])
CHILDREN = [{"ratingKey": "600", "title": "Alpha", "type": "show"},
            {"ratingKey": "700", "title": "Beta", "type": "show"}]

# --------------------------------------------------------------------------- #
# 5. The floor of ONE item: a boundary cut must never empty a live batch, because
#    next_queue reads empty items as FINISHED and marks the entry done.
# --------------------------------------------------------------------------- #
for stop in ("none", "member", "season"):
    eq(f"{stop}: one episode left still yields exactly that one (never [] = finished)",
       items(SHOW, {"batch_stops_at": stop}, batch=2, watched={"101", "102", "201"}),
       ["Alpha S2E2"])
    eq(f"{stop}: a batch of 1 is unaffected",
       items(SHOW, {"batch_stops_at": stop}, batch=1), ["Alpha S1E1"])
eq("a genuinely finished show is still FINISHED (empty items), stop or no stop",
   items(SHOW, {"batch_stops_at": "season"}, batch=2,
         watched={"101", "102", "201", "202"}), [])

# --------------------------------------------------------------------------- #
# 6. Precedence: entry override > set > global default
# --------------------------------------------------------------------------- #
eq("entry override wins over the set (entry 'none' on a 'season' set)",
   items(dict(SHOW, batch_stops_at="none"), {"batch_stops_at": "season"},
         batch=2, watched={"101"}),
   ["Alpha S1E2", "Alpha S2E1"])
eq("entry override wins over the set (entry 'season' on an unset set)",
   items(dict(SHOW, batch_stops_at="season"), batch=2, watched={"101"}),
   ["Alpha S1E2"])
# An unrecognised value is IGNORED at that level, so a typo falls back to the set's intent
# instead of silently switching the feature off.
eq("a typo'd entry value falls back to the set, not to off",
   items(dict(SHOW, batch_stops_at="seasons"), {"batch_stops_at": "season"},
         batch=2, watched={"101"}),
   ["Alpha S1E2"])
eq("'off'/'' spellings read as none",
   items(dict(SHOW, batch_stops_at="off"), {"batch_stops_at": "season"},
         batch=2, watched={"101"}),
   ["Alpha S1E2", "Alpha S2E1"])

_saved = config.BATCH_STOPS_AT
config.BATCH_STOPS_AT = "season"
eq("the global default applies when neither entry nor set says anything",
   items(SHOW, batch=2, watched={"101"}), ["Alpha S1E2"])
eq("…and a set value still overrides the global",
   items(SHOW, {"batch_stops_at": "none"}, batch=2, watched={"101"}),
   ["Alpha S1E2", "Alpha S2E1"])
config.BATCH_STOPS_AT = _saved

# --------------------------------------------------------------------------- #
# 7. The uncapped rotation / member-bucket caller is untouched — its round-robin
#    needs the FULL ordered list to advance a show across rounds.
# --------------------------------------------------------------------------- #
eq("rotation path (no default batch) stays uncapped under 'season'",
   items(SHOW, {"batch_stops_at": "season"}, batch=None),
   ["Alpha S1E1", "Alpha S1E2", "Alpha S2E1", "Alpha S2E2"])
eq("rotation path (no default batch) stays uncapped under 'member'",
   items(COLL, {"batch_stops_at": "member"}, batch=None),
   ["Alpha S1E1", "Alpha S1E2", "Alpha S2E1", "Alpha S2E2", "Beta S1E1", "Beta S1E2"])

# --------------------------------------------------------------------------- #
# 8. The count cap still wins where it is smaller, and the hard cap still applies
# --------------------------------------------------------------------------- #
eq("a 3-batch under 'season' still stops at the season boundary",
   items(SHOW, {"batch_stops_at": "season"}, batch=3, watched=()),
   ["Alpha S1E1", "Alpha S1E2"])
eq("QUEUE_SERIES_LENGTH still clamps an absurd override",
   len(items(dict(SHOW, episodes=9999), batch=1)), len(ALPHA))

print(f"batch-stops-at FAILED ({len(FAILS)}): {FAILS}" if FAILS else "batch-stops-at OK")
sys.exit(1 if FAILS else 0)
