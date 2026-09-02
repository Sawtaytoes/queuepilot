# A start point carries a position, and `end` is its mirror

- **Status:** Accepted
- **Date:** 2026-09-01
- **Type:** playback semantics / data model / UI
- **Supersedes:** —
- **Superseded by:** —

## Decision

A queue entry can name **where in a playable unit playback begins and where it stops**. This is
one mechanism, expressed as two keys on the entry mapping:

- `start.position_ms` — begin the first played unit at this offset. It joins `series`,
  `season` and `episode` on the existing `start` key, because those already answer "where does
  this entry begin" and an offset is the next term in that sequence.
- `end.position_ms` — stop that same unit at this offset and advance to the next queue entry.
  `end` is a nested mapping rather than a bare `end_ms` so that a later "stop after season 2
  episode 6" is an addition to this key instead of a third one.

**Each is independently optional, and all four combinations are valid:**

| `start.position_ms` | `end.position_ms` | What plays |
| --- | --- | --- |
| absent | absent | the whole unit — today's behaviour, unchanged |
| set | absent | from that offset to the end of the unit |
| absent | set | from the beginning of the unit, stopping at that offset |
| set | set | the window between them |

**The window applies to the FIRST played unit only.** An entry contributing three episodes per
visit takes the offsets on episode one; episodes two and three play in full.

**Validation.** When both are set, `end` must be strictly after `start`; equal ends are refused
by name rather than swapped, because a zero-length section plays nothing and a swap would hide
a typo. When only one is set there is nothing to compare against, so the only check is that it
sits inside the item's duration. An absent or refused value **drops the key**, matching every
other sparse per-entry override in the file.

**The unit is milliseconds**, and the key carries the `_ms` suffix. The UI never shows a
millisecond count; it shows `hh:mm:ss.mmm` through the Charcuterie `TimecodeInput`.

**Playing a section is a provider capability.** Only Plex declares it. It is a seek plus a stop
on a timeline held by a player QueuePilot can command, and Kavita, Board Game Picker, Steam and
MiSTer are all `delivery: 'pull'` — QueuePilot hands over an artifact or a URL and loses
control at that moment. A provider that cannot serve a section offers no control for it, rather
than accepting one and ignoring it.

## Context

Two asks arrived together and turned out to be one feature.

The first is the Theater Demo Reel. It is built today from **pre-clipped files** in a separate
"Movie Clips" library, because the only way to show ninety seconds of a film was to cut a new
file. The reel is a deliberate arc — lights-down logos, reference showpieces, a crescendo, a
quiet outro — and every item in it had to exist as its own file first.

The second is beginning an episode part-way in. The entry-level `start` already picks *which*
unit plays. It has never been able to say *where in that unit*.

Modelling these separately would have produced a `clip: {start_ms, end_ms}` key beside `start`,
leaving two places to answer one question and an entry able to hold both and disagree. It would
also have made "start episode 4 at 12:30" impossible to express without repeating the unit
selection in both keys.

## Why

- **`start` already means "where playback begins".** A position is the next term in a sequence
  that already runs member → season → episode. A movie is not a special case; it is the shape
  where `season` and `episode` are absent, exactly as `start` already behaves for a movie member
  of a collection.
- **Two optional keys give four behaviours with no mode flag.** "Play from here" and "stop here"
  are not two features with a switch between them; they are the presence or absence of two
  independent values.
- **The first-unit rule is the only reading that serves both asks.** "Start episode 4 at 12:30"
  means that episode, not every episode. An entry wanting three separately-windowed sections is
  three entries.
- **Milliseconds match everything else on the server** — `Tile.duration`,
  `queue_entry_history.position_ms`, and Plex's own `viewOffset`. The MQTT now-playing payload
  is the single exception that speaks seconds, and `finished.ts nowPlayingMs()` is already the
  one converter.
- **The capability belongs on the provider because that is where the fact lives**, following
  [`2026-08-30-the-watch-history-source-is-a-provider-capability-and-queuepilot-is-the-fallback`](2026-08-30-the-watch-history-source-is-a-provider-capability-and-queuepilot-is-the-fallback.md).
  A per-queue setting would let a queue be configured into a state its provider cannot serve,
  and the failure would surface as a section that silently played in full.

## Consequences

A section is one more thing QueuePilot stores rather than Plex. Plex holds one `viewOffset` and
one `viewCount` per item per account; a queue that plays two different sections of one film has
two positions in one file and Plex has nowhere to put the second. This is the same reason
[`2026-08-30-a-manual-start-can-own-its-progress`](2026-08-30-a-manual-start-can-own-its-progress.md)
gave the queue its own ledger, and the window lands in that ledger for the same reason. It is
not drift: Plex's model is one position per item, and a queue that curates sections needs one
position per entry.

An entry with a window still follows its queue's `watch_history` setting. Whether playing ninety
seconds counts as watching the film is the queue's call, not this feature's.

## Evidence

- Owner, chat 2026-09-01: *"I wanna add a QueuePilot feature to playback a section of a video in
  the queue… This is useful for demoing content especially parts of movies and shows and demo
  content without having to clip it."*
- Owner, same chat: *"I wanna look at implementing this timecode system with our
  already-configured start episode X at position Y as well. We use Plex, but this is yet another
  situation where we're storing that in QueuePilot."*
- Owner, same chat, on optionality: *"Both should be optional (timecode start and end)."*
- Owner, same chat, on the done rule: the entry follows the queue setting rather than gaining a
  rule of its own.
- `docs/demo-reel.queues.yaml` — twenty entries, every one a ratingKey in the Demos (section 2)
  or Movie Clips (section 7) libraries, i.e. twenty files that exist only because a section
  could not be expressed.
