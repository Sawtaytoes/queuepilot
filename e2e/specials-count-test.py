#!/usr/bin/env python3
"""Engine test for the specials/extras filter (decision
2026-08-07-specials-count-excludes-op-ed-trailer-extras, refining 2026-07-17).

`is_extra_or_promo` recognises Plex Extras/clips and Season-0 trailers/openings/endings by the
Season-0 episode INDEX (exclude 200-399) — deterministic, not duration/title-based — but NOT
regular Season-0 specials (index 1-99) or "other" (index 400+). `_keep_episode` drops the junk
from every play list even when `include_specials` is set, while keeping the 2026-07-17 default
that Season 0 is otherwise excluded. Runs offline — no Plex, no token.

Run:  python3 e2e/specials-count-test.py    (from the repo root; non-zero on failure)
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


# show_episodes() normalised shape: season, episode (= the index), title, duration, type,
# extraType. Classification is by the Season-0 `episode` index, never by duration.
def ep(rk, season, episode, title, duration=1000, typ=None, extra=None):
    return {"ratingKey": rk, "season": season, "episode": episode, "title": title,
            "duration": duration, "type": typ, "extraType": extra}


NORMAL_1 = ep("11", 1, 1, "The Journey Begins")
NORMAL_2 = ep("12", 1, 2, "A New Ally")
S1_301 = ep("13", 1, 301, "Ep 301")                 # a long-running S1 — index rule must not touch it
SPECIAL = ep("20", 0, 1, "OVA: Hot Springs Special")  # index 1 → regular special → KEEP
OTHER = ep("40", 0, 401, "Recap")                    # index 400+ → "other" → KEEP
# A SONG-NAMED Season-0 ED at index 301 — the title is a song name, so only the INDEX catches it.
ED_SONG = ep("14", 0, 301, "Kokoro")
TRAILER_IDX = ep("21", 0, 201, "Trailer")            # index 200s → trailer → EXCLUDE
CLIP = ep("22", 0, 5, "Menu", typ="clip")            # a Plex clip → EXCLUDE regardless of index
BTS = ep("23", 0, 6, "Behind the Scenes", extra="behindTheScenes")

# --- the predicate ---------------------------------------------------------------------- #
ok("a Season-0 OP/ED at index 301 is an extra", plex.is_extra_or_promo(ED_SONG))
ok("a Season-0 trailer at index 201 is an extra", plex.is_extra_or_promo(TRAILER_IDX))
ok("a clip-typed item is an extra", plex.is_extra_or_promo(CLIP))
ok("an extraType item is an extra", plex.is_extra_or_promo(BTS))
ok("a regular Season-0 special (index 1) is NOT an extra", not plex.is_extra_or_promo(SPECIAL))
ok("a Season-0 'other' (index 401) is NOT an extra", not plex.is_extra_or_promo(OTHER))
ok("a normal S1 episode is NOT an extra", not plex.is_extra_or_promo(NORMAL_1))
# The index rule fires ONLY on Season 0 — a Season-1 episode 301 is kept.
ok("S1 episode 301 survives (index rule is Season-0 only)", not plex.is_extra_or_promo(S1_301))

# --- _keep_episode play-list filtering --------------------------------------------------- #
ALL = [NORMAL_1, NORMAL_2, S1_301, SPECIAL, OTHER, ED_SONG, TRAILER_IDX, CLIP, BTS]

# Default (no include_specials): Season 0 excluded entirely (open-point rule), junk excluded.
default = [e["ratingKey"] for e in ALL if plex._keep_episode(e, {})]
ok("default play list is the 3 S1 episodes", default == ["11", "12", "13"])

# include_specials: the regular special + "other" join; trailer/OP-ED/clip still never do.
with_specials = [e["ratingKey"] for e in ALL if plex._keep_episode(e, {"include_specials": True})]
ok("include_specials adds ONLY the special + other", with_specials == ["11", "12", "13", "20", "40"])

print(f"FAILURES: {len(FAILS)}" if FAILS else "done")
sys.exit(1 if FAILS else 0)
