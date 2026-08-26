# A scan logs the lineup it built, and playback logs what Plex did with it

- **Status:** Accepted
- **Date:** 2026-08-26
- **Type:** observability
- **Supersedes:** —
- **Superseded by:** —

## Decision

Two unconditional log groups, on every curated scan and every push:

**`[lineup]`** (`engine/resolve.nextQueue`) — four lines at most:

```
[lineup] <set>: add_as=priority (in order), length=12 -> 12 item(s) from 14 entry(s) [priority 14, pool 0, resuming 0]
[lineup] <set> head: "<title>" rk=<key> lane=priority
[lineup] <set> order: 1 <title> | 2 <title> | … (+4 more)
[lineup] <set> held back by their lead window: rk:123
[lineup] <set> not playable: 2 finished, 0 unresolved
```

**`[play]`** (`playback.playRatingKeys`) — what was asked for, and what Plex built:

```
[play] <set>: 12 key(s), head rk=<key>, offset=0s, continuous=true
[play] playQueue 4711: 12 item(s), head rk=<key>
[play] ⚠ Plex reordered the playQueue: asked for head rk=A, playQueue 4711 leads with rk=B (12 item(s))
[play] ⚠ Plex kept 9 of 12 item(s) in playQueue 4711 — the head is right, the tail is short
```

The order line is cut at ten titles and says how many it dropped. The playQueue readback
failing is a log line, never a failed start.

## Context

On 2026-08-25 the owner reported that an ordered queue "kept picking a random movie" —
he had put the film at the top of `Family — Movies`, scanned its card, tried the app
several times, and got something else each time.

The container log could not answer it. A queue scan said only which entries it had
*finished* and which it could not *resolve*; the lineup itself — the order, the head, which
lane anything was in — was never written down. So three different failures were
indistinguishable in the log:

1. the resolver built the wrong order,
2. the resolver built the right order and Plex reordered the playQueue,
3. the right thing played and something else was on screen.

Worse, the container had been redeployed at 18:00 that day, so the evidence from the
earlier attempts was already gone.

## Why

- **A scan is a button press, not a timer**, so this is a handful of lines per sitting —
  cheap enough to be unconditional, and unconditional is the whole point. A `DEBUG` flag is
  no use for a report that arrives the next morning about a container that has since
  restarted.
- **The playQueue readback is the line that did not exist at all.** `createPlayQueue` posts
  a multi-key `library/metadata/K1,K2,…` uri and reads back only the id, so a queue Plex
  reordered, deduplicated, or partly dropped (an item the profile cannot see) looked exactly
  like one it took verbatim — and `playMedia` then starts on whatever is really at the
  front. `readPlayQueue` was already written, for top-up; this reuses it.
- **The head gets its own line** rather than being inferred from a count, because on an
  ordered queue the head is the entire claim being made.

## Evidence

- Owner, 2026-08-25: *"I tried to play the [film] on the family account tonight, and it kept
  picking a random movie … I did have it as the top listing. I added it today and scanned the
  card and even tried a few times from the app, but it was a different movie each time.
  Please add better logging as well."*
- `docker logs ix-queuepilot-queuepilot-1` for that evening: three
  `[mqttd] session/start {"set":"…","kind":"picks"}` lines and one `[finished]`, and nothing
  in between naming a single title.
