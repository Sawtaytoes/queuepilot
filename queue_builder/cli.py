"""Dry-run CLI for Phase 1 verification (read-only, no playback, no MQTT).

  python -m queue_builder.cli rotation younger        # show the interleaved queue
  python -m queue_builder.cli rotation shows_shorts "Older Kids"   # ...under one binding
  python -m queue_builder.cli movie                    # show a rewatch-movie pick
  python -m queue_builder.cli movie movies "Younger Kids"          # ...under one binding
  python -m queue_builder.cli shows younger            # shows in the set + unwatched counts
  python -m queue_builder.cli route cartoons "Younger Kids"  # set:"auto" routing dry-run
  python -m queue_builder.cli sections                 # per-set section pools as JSON (parity oracle)
  python -m queue_builder.cli watched-count movies "Younger Kids"  # rewatch-pool histogram
  python -m queue_builder.cli queue bob                # curated-queue pick + prune preview
  python -m queue_builder.cli reel demo                # reel (DEMO) ordered lineup, read-only
  python -m queue_builder.cli resolve bob "Duel (1971)"   # dry-run: resolve one title string
  python -m queue_builder.cli machine-id               # server machineIdentifier
  python -m queue_builder.cli channel-buckets-json kidsplus  # rule pool + members, deduped (parity oracle)
  python -m queue_builder.cli next-queue-json bobq      # next_queue deterministic result (parity oracle)
  python -m queue_builder.cli reel-json demo            # build_reel ordered lineup (parity oracle)
"""
import json
import shutil
import sys
import tempfile

from . import config, plex


def _binding(set_name, profile=None):
    """The binding a profile title selects on a set (None profile = the default binding)."""
    return config.binding_for(config.SETS[set_name], profile)


def _rotation(set_name="younger", profile=None):
    q = plex.build_rotation(set_name, binding=_binding(set_name, profile))
    print(f"rotation[{set_name}{f' × {profile}' if profile else ''}] length={len(q)}")
    for i, e in enumerate(q, 1):
        print(f"  {i:2}. {e['show']} — S{e['season']}E{e['episode']} · {e['title']} (rk={e['ratingKey']})")


def _shows(set_name="younger", profile=None):
    shows = plex.unwatched_buckets(set_name, binding=_binding(set_name, profile))
    shows.sort(key=lambda s: -len(s["episodes"]))
    print(f"shows[{set_name}{f' × {profile}' if profile else ''}] with unwatched episodes: {len(shows)}")
    for s in shows:
        print(f"  {len(s['episodes']):4} unwatched · {s['show']} (rk={s['ratingKey']})")


def _movie(set_name="younger", profile=None):
    # pick_rewatch = the behavior:rewatch entry point (v3 PR 3): member-pool weighted
    # replay for a members channel, the classic movie pool otherwise.
    pick = plex.pick_rewatch(set_name, binding=_binding(set_name, profile))
    print(json.dumps(pick, ensure_ascii=False))


def _route(kind="cartoons", *title_parts):
    """Dry-run the set:"auto" routing: (card kind + profile title) → channel + binding."""
    from . import profiles as _profiles
    title = " ".join(title_parts)
    sid = config.channel_for(kind, title)
    via = "channel_for"
    if sid is None:
        sid = _profiles.set_for_profile(title)
        via = "PROFILE_SET_MAP"
    if sid is None:
        print(f"route[{kind} × {title!r}] -> NO MAPPING (would error, as today)")
        return
    b = config.binding_for(config.SETS[sid], title)
    print(f"route[{kind} × {title!r}] -> set '{sid}' (via {via}), "
          f"binding plex_user={b.get('plex_user')!r} account_id={b.get('account_id')}")


def _buckets(set_name="kids", *profile_parts):
    """Dump a set's unwatched_buckets as deterministic JSON — the parity oracle for the Node
    engine's unwatchedBuckets (e2e/engine-parity.mjs). Episodic buckets keep allLeaves order;
    the shorts bucket is emitted SORTED (it is rng-shuffled, so parity compares the set)."""
    profile = " ".join(profile_parts) or None
    buckets = plex.unwatched_buckets(set_name, binding=_binding(set_name, profile))
    out = []
    for bk in buckets:
        eps = [e["ratingKey"] for e in bk["episodes"]]
        if str(bk["ratingKey"]).startswith("section-"):
            eps = sorted(eps)  # shorts are shuffled — compare as a set
        out.append({"show": bk["show"], "ratingKey": bk["ratingKey"],
                    "multi_season": bool(bk.get("multi_season", False)), "episodes": eps})
    print(json.dumps(out, ensure_ascii=False))


def _channel_buckets_json(set_name="kidsplus", *profile_parts):
    """Dump a channel's channel_buckets (rule pool + curated members, deduped) as deterministic
    JSON — the parity oracle for the Node engine's channelBuckets (e2e/engine-parity.mjs). Same
    normalization as _buckets (episodic in allLeaves order; a shorts bucket sorted, as it is
    rng-shuffled). The member/rule interleave (build_rotation) is rng and stays a per-language test;
    only this pre-shuffle pool cross-checks."""
    profile = " ".join(profile_parts) or None
    buckets = plex.channel_buckets(set_name, binding=_binding(set_name, profile))
    out = []
    for bk in buckets:
        eps = [str(e["ratingKey"]) for e in bk["episodes"]]
        if str(bk["ratingKey"]).startswith("section-"):
            eps = sorted(eps)  # shorts are shuffled — compare as a set
        out.append({"show": bk["show"], "ratingKey": str(bk["ratingKey"]),
                    "multi_season": bool(bk.get("multi_season", False)), "episodes": eps})
    print(json.dumps(out, ensure_ascii=False))


def _rewatch_counts(set_name="kids", *profile_parts):
    """Dump the rewatch pool's per-item view counts as deterministic JSON (sorted by ratingKey)
    — the parity oracle for the Node engine's rewatchCounts (e2e/engine-parity.mjs). The weighted
    PICK is rng and stays a per-language seeded test; only these counts cross-check."""
    profile = " ".join(profile_parts) or None
    cfg = config.SETS[set_name]
    b = _binding(set_name, profile)
    counts, titles = plex.rewatch_counts(config.rewatch_sections(cfg), b["movie_ratings"],
                                         b.get("watch_count_accounts"),
                                         token=plex.account_token(b.get("user_uuid")))
    out = [{"ratingKey": rk, "count": counts[rk], "title": titles.get(rk)} for rk in sorted(counts)]
    print(json.dumps(out, ensure_ascii=False))


def _sections():
    """Dump set_sections + rewatch_sections per set as JSON — the parity oracle for the Node
    port's routing.setSections / routing.rewatchSections (e2e/binding-parity.mjs). Calls the
    real config functions, so it can never drift from what the scan actually pools."""
    out = {
        sid: {
            "set_sections": config.set_sections(config.SETS[sid]),
            "rewatch_sections": config.rewatch_sections(config.SETS[sid]),
        }
        for sid in config.SET_ORDER
    }
    print(json.dumps(out, ensure_ascii=False))


def _queue(set_name="bob"):
    """Resolve a curated queue read-only (this DOES mark finished entries done in the file)."""
    res = plex.next_queue(set_name)
    print(f"queue[{set_name}] remaining={res['remaining']} "
          f"done={len(res['done'])} unresolved={len(res['unresolved'])}")
    if res["done"]:
        print("  done (kept, marked): " + ", ".join(str(x) for x in res["done"]))
    if res["unresolved"]:
        print("  unresolved (kept, flagged): " + ", ".join(str(x) for x in res["unresolved"]))
    if not res["play"]:
        print("  nothing to play (queue empty or every entry finished)")
        return

    def _se(e):
        return f"S{e['season']}E{e['episode']} · " if e.get("season") is not None else ""

    if config.SETS[set_name].get("kind") == "anime":
        # A channel: the lineup spans members in a shuffled order (lead member first).
        print(f"  -> CHANNEL rotation (lead: {res['last']['title']}) — {len(res['play'])} item(s) queued")
        for i, e in enumerate(res["play"], 1):
            print(f"     {i:2}. {_se(e)}{e['title']} (rk={e['ratingKey']})")
    elif res["last"]["type"] == "movie":
        print(f"  -> MOVIE: {res['last']['title']} (rk={res['last']['ratingKey']})")
    else:  # series or collection
        label = res["last"]["type"].upper()
        print(f"  -> {label}: {res['last']['title']} — {len(res['play'])} item(s) queued")
        for i, e in enumerate(res["play"], 1):
            print(f"     {i:2}. {_se(e)}{e['title']} (rk={e['ratingKey']})")


def _reel(set_name="demo"):
    """Resolve a reel set read-only: the ORDERED lineup, no prune, no mark-done, no playback."""
    res = plex.build_reel(set_name)
    print(f"reel[{set_name}] items={len(res['play'])} unresolved={len(res['unresolved'])}")
    if res["unresolved"]:
        print("  unresolved (skipped): " + ", ".join(str(x) for x in res["unresolved"]))
    if not res["play"]:
        print("  nothing to play (reel empty or every entry unresolved)")
        return
    total = 0
    for i, e in enumerate(res["play"], 1):
        print(f"  {i:2}. {e['title']} (rk={e['ratingKey']})")
    print(f"  -> {len(res['play'])} clip(s) queued in file order (plays in full every scan)")


def _resolve(set_name, *title_parts):
    """Dry-run title-string resolution for a curated-queue set (no prune, no playback)."""
    from . import queues
    text = " ".join(title_parts)
    cfg = config.SETS.get(set_name, {})
    if cfg.get("source") != "queue":
        print(f"'{set_name}' is not a curated-queue set (no section to resolve against)")
        return
    d = queues._describe(text)
    rk, typ, resolved = plex.resolve_queue_entry(d, cfg)
    print(f"section={cfg['queue_section']}  parsed: title={d['title']!r} year={d['year']} guid={d['guid']}")
    if typ is None:
        print("  UNRESOLVED — nothing in that section matches (would be kept + flagged)")
    else:
        print(f"  -> {typ.upper()}: {resolved!r} (rk={rk})")


def _next_queue_json(set_name="bobq"):
    """Dump next_queue's DETERMINISTIC result as JSON — the parity oracle for the Node engine's
    nextQueue (e2e/curated-parity.mjs). next_queue mutates queues.yaml (mark_done/sweep) as a side
    effect, so run it against a THROWAWAY copy: the returned dict is identical and the real file is
    untouched (and the Node side, which never mutates, reads the pristine file). Non-anime queues
    are fully deterministic (no rng); the play list is projected to ratingKeys for a stable diff."""
    orig = config.QUEUES_PATH
    tmp = tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False)
    tmp.close()
    shutil.copyfile(orig, tmp.name)
    try:
        config.QUEUES_PATH = tmp.name
        res = plex.next_queue(set_name)
    finally:
        config.QUEUES_PATH = orig
    print(json.dumps({
        "set": res["set"],
        "play": [str(e["ratingKey"]) for e in res["play"]],
        "last": res["last"], "done": res["done"], "unresolved": res["unresolved"],
        "remaining": res["remaining"], "offset": res["offset"],
    }, ensure_ascii=False))


def _reel_json(set_name="demo"):
    """Dump build_reel's ORDERED lineup as JSON — the parity oracle for the Node engine's buildReel
    (e2e/curated-parity.mjs). build_reel never marks anything done, so no copy is needed. Play items
    are projected to {ratingKey, title} (movie/series/collection shapes normalize to that)."""
    res = plex.build_reel(set_name)
    print(json.dumps({
        "set": res["set"],
        "play": [{"ratingKey": str(e["ratingKey"]), "title": e.get("title")} for e in res["play"]],
        "last": res["last"], "unresolved": res["unresolved"], "remaining": res["remaining"],
    }, ensure_ascii=False))


def _watched_count(set_name="younger", profile=None):
    # Same accounts + libraries the card itself uses, so this reports what the service
    # will actually do (the pool follows the channel's own libraries, not a fixed one).
    cfg = config.SETS[set_name]
    b = _binding(set_name, profile)
    counts, _ = plex.rewatch_counts(config.rewatch_sections(cfg), b["movie_ratings"],
                                    b.get("watch_count_accounts"),
                                    token=plex.account_token(b.get("user_uuid")))
    hist = {}
    for n in counts.values():
        hist[n] = hist.get(n, 0) + 1
    print(f"sections={config.rewatch_sections(cfg)}  movies with history: {len(counts)}")
    for n in sorted(hist):
        print(f"  seen {n}x: {hist[n]} movies")


def main(argv=None):
    argv = argv or sys.argv[1:]
    if not argv:
        print(__doc__)
        return
    cmd, rest = argv[0], argv[1:]
    if cmd == "rotation":
        _rotation(*rest)
    elif cmd == "shows":
        _shows(*rest)
    elif cmd == "movie":
        _movie(*rest)
    elif cmd == "queue":
        _queue(*rest)
    elif cmd == "reel":
        _reel(*rest)
    elif cmd == "resolve":
        _resolve(*rest)
    elif cmd == "route":
        _route(*rest)
    elif cmd == "sections":
        _sections()
    elif cmd == "buckets":
        _buckets(*rest)
    elif cmd == "rewatch-counts":
        _rewatch_counts(*rest)
    elif cmd == "channel-buckets-json":
        _channel_buckets_json(*rest)
    elif cmd == "next-queue-json":
        _next_queue_json(*rest)
    elif cmd == "reel-json":
        _reel_json(*rest)
    elif cmd == "watched-count":
        _watched_count(*rest)
    elif cmd == "machine-id":
        print(plex.machine_identifier())
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
