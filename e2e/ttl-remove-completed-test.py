#!/usr/bin/env python3
"""Engine test for §B.3 — TTL auto-remove of completed queue entries.

Exercises queue_builder.queues directly against a temp queues.yaml (needs ruamel, present
in requirements.txt): mark_done stamps `done_at`, the sweep removes ONLY past-TTL done
entries, `never`/`0` disables it, `keep_completed`/`reel` exempt a set, and non-done (and
timestamp-less done) entries are left untouched. Offline — no Plex, no MQTT.

Run:  python3 e2e/ttl-remove-completed-test.py   (from the repo root; non-zero on failure)
"""
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from queue_builder import config, queues  # noqa: E402

FAILS = []


def ok(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        FAILS.append(name)


TMP = tempfile.mkdtemp(prefix="ttl-test-")
config.QUEUES_PATH = os.path.join(TMP, "queues.yaml")
config.REMOVE_COMPLETED_AFTER = "never"        # global default: keep forever (opt-in per set)


def write(text):
    for suffix in ("", ".lock", ".tmp"):
        p = config.QUEUES_PATH + suffix
        try:
            if suffix == ".lock":
                os.rmdir(p)
            else:
                os.remove(p)
        except OSError:
            pass
    with open(config.QUEUES_PATH, "w", encoding="utf-8") as f:
        f.write(text)


def by_key(key):
    """The descriptor for a set's entry by its stable entry_key, or None."""
    for d in queues.entries("bob"):
        if d["key"] == key:
            return d
    return None


def keys():
    return [d["key"] for d in queues.entries("bob")]


def raw_done_at(d):
    raw = (d or {}).get("raw")
    return raw.get("done_at") if isinstance(raw, dict) else None


# --- parse_duration ----------------------------------------------------------- #
ok("parse_duration 24h -> 86400", queues.parse_duration("24h") == 86400)
ok("parse_duration 7d -> 604800", queues.parse_duration("7d") == 604800)
ok("parse_duration 90m -> 5400", queues.parse_duration("90m") == 5400)
ok("parse_duration bare number -> seconds", queues.parse_duration("45") == 45)
ok("parse_duration 0 -> disabled", queues.parse_duration("0") is None)
ok("parse_duration never -> disabled", queues.parse_duration("never") is None)
ok("parse_duration blank -> disabled", queues.parse_duration("") is None)
ok("parse_duration junk -> disabled", queues.parse_duration("soon") is None)


# --- mark_done stamps done_at ------------------------------------------------- #
write('bob:\n  - "Duel (1971)"\n  - "Cowboy Bebop"\n')
before = time.time()
changed = queues.mark_done("bob", ["title:Duel (1971)"])
after = time.time()
ok("mark_done reported a change", changed is True)
duel = by_key("title:Duel (1971)")
ok("mark_done set done: true", bool(duel and duel.get("done")))
_stamp = raw_done_at(duel)
ok("mark_done stamped a numeric done_at", isinstance(_stamp, int))
ok("done_at is roughly now", bool(_stamp) and (before - 2) <= _stamp <= (after + 2))
bebop = by_key("title:Cowboy Bebop")
ok("un-marked entry stays not-done", bool(bebop) and not bebop.get("done"))
ok("un-marked entry got no done_at", raw_done_at(bebop) is None)


# --- sweep removes ONLY past-TTL done entries (opt-in via remove_completed_after) --- #
NOW = 1_000_000_000
OLD = NOW - 100_000          # ~27.7h ago: past a 24h TTL
RECENT = NOW - 60            # a minute ago: within 24h
SWEEP_FIXTURE = (
    "bob:\n"
    '  - {title: "Old Done", done: true, done_at: %d}\n'
    '  - {title: "Recent Done", done: true, done_at: %d}\n'
    '  - {title: "Legacy Done", done: true}\n'          # no done_at: never auto-removed
    '  - "Active Movie"\n'
) % (OLD, RECENT)

# Default (no remove_completed_after key + global default "never") = KEEP FOREVER: today's
# behavior, so anime channels are never surprise-swept. Nothing is removed.
write(SWEEP_FIXTURE)
removed = queues.sweep_completed("bob", {}, now=NOW)     # cfg {} -> global default (never)
ok("default (no key) keeps everything — no sweep", removed is False)
ok("default: past-TTL done entry survives", "title:Old Done" in keys())

# A set OPTS IN with an explicit window; then only past-TTL done entries go.
write(SWEEP_FIXTURE)
removed = queues.sweep_completed("bob", {"remove_completed_after": "24h"}, now=NOW)
ok("opt-in 24h reported a removal", removed is True)
ok("opt-in removed the past-TTL done entry", "title:Old Done" not in keys())
ok("opt-in kept the recent done entry", "title:Recent Done" in keys())
ok("opt-in kept the timestamp-less done entry", "title:Legacy Done" in keys())
ok("opt-in kept the active (not-done) entry", "title:Active Movie" in keys())


# --- never / 0 disables the sweep --------------------------------------------- #
write(SWEEP_FIXTURE)
removed = queues.sweep_completed("bob", {"remove_completed_after": "never"}, now=NOW)
ok("remove_completed_after=never disables the sweep", removed is False)
ok("never: past-TTL done entry survives", "title:Old Done" in keys())

write(SWEEP_FIXTURE)
removed = queues.sweep_completed("bob", {"remove_completed_after": "0"}, now=NOW)
ok("remove_completed_after=0 disables the sweep", removed is False)
ok("0: past-TTL done entry survives", "title:Old Done" in keys())


# --- keep_completed / reel exempt the whole set (even with a window set) ------- #
# An explicit 24h window would otherwise sweep Old Done — the exemption is the ONLY reason
# nothing goes.
write(SWEEP_FIXTURE)
removed = queues.sweep_completed("bob", {"keep_completed": True, "remove_completed_after": "24h"}, now=NOW)
ok("keep_completed exempts the set", removed is False)
ok("keep_completed: past-TTL done entry survives", "title:Old Done" in keys())

write(SWEEP_FIXTURE)
removed = queues.sweep_completed("bob", {"reel": True, "remove_completed_after": "24h"}, now=NOW)
ok("reel exempts the set", removed is False)
ok("reel: past-TTL done entry survives", "title:Old Done" in keys())


# --- per-set override tightens the window ------------------------------------- #
# RECENT is 60s old; a 30s window makes it past-TTL too.
write(SWEEP_FIXTURE)
removed = queues.sweep_completed("bob", {"remove_completed_after": "30s"}, now=NOW)
ok("tight per-set window sweeps the recent done entry too",
   removed is True and "title:Recent Done" not in keys() and "title:Active Movie" in keys())


print(f"FAILURES: {len(FAILS)}" if FAILS else "done")
sys.exit(1 if FAILS else 0)
