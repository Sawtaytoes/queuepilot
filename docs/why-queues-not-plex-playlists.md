# Why plex-channels uses its own "queues" instead of native Plex Playlists

**Audience:** anyone asking "you're basically rebuilding Plex Playlists — why not just use
Playlists?" This is the standing answer.

**TL;DR:** A plex-channels *queue* is not a Playlist and shouldn't be one. A Playlist is a
**static list of concrete items**. A queue is a **declarative, watched-state-aware recipe**
that resolves — per profile, at play time — into the specific items to play next. Native
Playlists can't express any of the things the queue exists to do. The Playlist-shaped part
of the job (ordered, sequential playback) we already get for free from Plex's *playQueue*,
which the service builds on the fly.

## The three objects, kept straight

Plex has two different things people both call "a queue," and this project adds a third.
Confusing them is the root of the question.

| | **plex-channels queue** | **Plex Playlist** | **Plex playQueue** |
| --- | --- | --- | --- |
| What it is | A list in `queues.yaml` (our source of truth) | A saved server object | The transient "Up Next" list |
| Lifetime | Persists; hand-editable | Persists | Ephemeral — dies when playback ends |
| Entry form | Title strings (`"Duel (1971)"`), `Collection: <name>`, or ratingKeys | Concrete items (ratingKeys) | Concrete items (ratingKeys) |
| Can hold | Movies, **shows** (→ next unwatched episode), **collections** (→ items in order) | Only concrete items | Only concrete items |
| Watched-aware | **Yes** — per profile: rotates, prunes/marks-done, weights rewatches | No | No |
| Who materializes playback | `queue_builder/playback.py` builds a playQueue from the resolved list | — | Built at `POST /playQueues` |

The queue sits at a **higher altitude** than a Playlist: the queue is the *policy*, and the
playQueue is the *runtime artifact* the service generates from it each time a card is tapped.

## What a queue does that a Playlist fundamentally can't

1. **It's a recipe, not a list.** One line like `"86 Eighty-Six (2021)"` or
   `Collection: Pixar Shorts` **expands at scan time** into the concrete items to play — the
   next unwatched episode of that show, or that collection's children in collection order.
   A Playlist can only contain items you've already picked. This expansion (`plex.next_queue`,
   `resolve_queue_entry`) is the entire reason the service exists.

2. **It's watched-state-aware, and that state is per-profile.** The kids' cards play the
   *next unwatched* thing for **the signed-in Plex Home profile** (Younger vs Older Kids —
   different tokens, different history, different rating caps). Movies drop once watched;
   rewatch candidates are weighted `1/n²` toward the least-watched; shows round-robin across a
   rotation. A single static Playlist can't be two different things for two profiles, and has
   no notion of "the next unwatched item for *this* viewer."

3. **Shows and Collections are single entries.** One entry can mean "the next episode of this
   series" (with a per-show `episodes:` knob) or "this collection, in its own order." Playlists
   flatten everything to fixed members — you'd lose the show/collection semantics and have to
   re-expand by hand every time something is watched.

4. **It's meant to be hand-edited.** The deliberate design choice is that a human types folder
   names into a wishlist file
   ([queue entries are title strings](decisions/2026-07-20-queue-entries-are-title-strings.md)).
   A Playlist means digging through Plex to add ratingKeys — the exact workflow the user
   rejected.

5. **We already get Playlist-style playback for free.** Ordered, sequential, auto-advancing
   playback comes from the ephemeral **playQueue** that `playback.py` builds and hands to the
   Shield. So we get the good part of a Playlist (it just plays in order) *without* the
   rigidity of a saved Playlist.

## Why we don't store or mirror this in native Playlists

- **Semantic mismatch / lossy sync.** Queue entries carry things a Playlist can't represent:
  show entries, collection entries, title-only strings, `done` tags, per-show `episodes:`
  counts. Every sync to a Playlist would drop information.
- **Single source of truth.** `queues.yaml` is authoritative, written by two cooperating
  processes (the Node editor and the Python pruner) under a shared cross-process lock
  (`server/src/queues.js`). Making Plex a *second* writer of the same intent creates a
  two-master sync problem for no benefit.
- **The UI's taxonomy doesn't exist in Plex.** The editor distinguishes **queues** (order is
  the point — top plays next) from **channels** (random/rotation, order irrelevant); see
  [queues vs channels taxonomy](decisions/2026-07-21-queues-vs-channels-taxonomy-play-first-ia.md).
  Plex Playlists model none of that.

## The one case where a native Playlist *would* make sense

Purely as a **downstream, one-way render target** — never as the store. If you wanted a
resolved queue to be **visible and playable inside the stock Plex app** (not just via the NFC
cards), you could *publish* a read-only Playlist as a projection of a resolved queue:
regenerated from `queues.yaml`, never edited in Plex. That's a "publish/export" feature, not a
"keep the data in Plex" one. It hasn't been built and isn't needed for the card experiences.

## Bottom line

Keep maintaining `queues.yaml` (which the web UI does well). A native Plex Playlist is at best
an optional downstream *view* of a resolved queue — useful only if you ever want stock-Plex-app
visibility — and never the place the intent lives.

## See also

- [Movie-queue sets are a hand-edited YAML wishlist](decisions/2026-07-16-movie-queue-sets-yaml-wishlist.md)
- [Queue entries are human-readable title strings](decisions/2026-07-20-queue-entries-are-title-strings.md)
- [Plex Collections are first-class queue entries, expanded in order](decisions/2026-07-21-plex-collections-as-ordered-queue-entries.md)
- [Finished queue entries are kept + marked `done`, not pruned](decisions/2026-07-21-finished-queue-entries-marked-done-not-pruned.md)
- [Queues vs channels taxonomy + play-first entry IA](decisions/2026-07-21-queues-vs-channels-taxonomy-play-first-ia.md)
- Code: `queue_builder/plex.py` (`next_queue`, `resolve_queue_entry`), `queue_builder/playback.py` (playQueue build), `server/src/queues.js` (the YAML editor).
