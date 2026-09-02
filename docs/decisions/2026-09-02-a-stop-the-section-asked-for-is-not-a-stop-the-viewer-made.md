# A stop the section asked for is not a stop the viewer made

- **Status:** Accepted
- **Date:** 2026-09-02
- **Type:** playback semantics / durable data
- **Supersedes:** —
- **Superseded by:** —

## Decision

When QueuePilot itself stops an item at its `end.position_ms` and advances the lineup, that
outcome is recorded as **the entry's line finishing**, not as a play somebody abandoned. The
distinguishing fact is **who stopped it**, and it is recorded at the moment the `skipNext` goes
out rather than inferred afterwards from the position.

What follows from that, in each of the two watch-history settings, and neither is a new rule
for sections — each is the existing rule applied honestly:

- **`watch_history: queue`** — the queue's own ledger records the item **completed**
  (`queue_entry_history.is_completed`). The window played to the end of what the entry asked
  for, so the line is finished. That ledger exists precisely because Plex holds one position
  per item and a queue that curates sections needs one per *entry*.
- **`watch_history: provider`** — **nothing is written, here or anywhere.** That queue asked
  Plex to be the judge, and Plex judges a 40% play as unwatched. The entry stays in the queue
  and plays its section again next sitting.

Two consequences of the same fact, both of which were silent bugs before this:

- **The boundary's entry key is the authority for which LINE just played.**
  `SESSION.queue.find()` matches by ratingKey, so with two sections of one file in one lineup
  it returns the first of them for both.
- **A windowed item saves NO live position.** The live-position writer matches by ratingKey
  too, so while the second section played it addressed the *first* section's ledger row — and
  `savePosition` clears `is_completed`, undoing the completion that section had just earned.
  A windowed entry has no use for a position anyway: it begins at its own start mark every
  sitting.

The related read-side rule, for the same reason: **an entry with a section never counts as
in-progress.** `leadsInProgress` no longer hoists one to the front of a Picks Random pool.

## Context

`finished.ts` decides an item's outcome from where playback stopped, and that has always been
sound: a play that ends at 40% ended because somebody walked away. A section entry ends at 40%
**by design**, and from the position alone the two are identical.

Left to the ordinary path, a two-minute clip of a two-hour film would have been filed as
"somebody walked out 48 minutes in". Three things would have followed, none of them visible as
an error:

1. the queue's ledger would keep a 40% resume position for that entry;
2. `leadsInProgress` would read that as half-watched and hoist the entry to the front of the
   Random pool every sitting, forever;
3. the entry sheet would offer to resume something nobody had stopped.

The equal and opposite mistake was available too: force-marking the item watched so the entry
would complete. That would write a `viewCount` into Plex on the strength of ninety seconds, for
every account sharing that library.

## Why

- **The position cannot answer the question, so stop asking it the question.** "Where did it
  stop" is genuinely ambiguous here. "Did this app issue the skipNext" is not ambiguous at all,
  and it is knowable at zero cost at the moment it happens.
- **Recording completion in the QUEUE's ledger writes nothing anybody else can see.** It is
  QueuePilot's own record of its own line, which is what that table is for.
- **Following the queue's `watch_history` setting is what the data model already decided.**
  [`2026-09-01-a-start-point-carries-a-position-and-end-is-its-mirror`](2026-09-01-a-start-point-carries-a-position-and-end-is-its-mirror.md)
  says an entry with a window still follows its queue's setting, and that whether ninety
  seconds counts as watching the film is the queue's call. A queue that chose `provider` chose
  Plex as its judge; overriding that would be this feature inventing a rule the owner never
  asked for.
- **The boundary is claimed ONCE, with a TTL.** A stop is attributed to one play. A boundary
  nobody claimed within two minutes belonged to a play that ended some other way, and an
  unbounded record would misattribute an ordinary play of the same file later in the evening.

## Consequences

**A windowed entry on `watch_history: provider` never completes.** It replays its section every
sitting until the queue is switched to `watch_history: queue`. This is deliberate and is the
queue's own setting speaking, but it is the surprise a reader will hit first, so it is named in
`AGENTS.md` beside the rule rather than left to be discovered.

A file that appears in one lineup **both** with a window and without one gets no live position
saved for the unwindowed line either, because `isWindowed()` keys on the file. That is the safe
direction: a missing resume point is recoverable, a completion silently undone is not.

## Evidence

- `server/src/finished.ts` — `watchPlaybackEnd()` reads the position off the now-playing feed
  and `finalizeQueueProgress()` reads Plex's verdict; neither has any way to know a stop was
  requested.
- `server/src/store/db/queueEntryHistory.ts` `savePosition` — `is_completed = 0` on every
  write, which is what makes the second-section case destructive rather than merely untidy.
- `server/src/engine/resolve.ts` `leadsInProgress` — reads `queueResumeOffset > 0`, which a
  phantom 40% position satisfies.
- `e2e/section-playback-test.ts` — the boundary ledger, the once-only claim, the TTL, and
  `isWindowed` staying true between the first and second sections of one file.
