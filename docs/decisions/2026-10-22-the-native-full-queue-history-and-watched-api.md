# The native TV reads the whole queue, starts from any item, reads history by sitting, and marks queue-owned items

- **Status:** Accepted
- **Date:** 2026-10-22
- **Type:** API / native TV / playback semantics
- **Supersedes:** —
- **Superseded by:** In part — its authorization rule, by [The native TV plays each queue as its own profile, and locks chosen queues with a PIN](2026-10-23-the-native-tv-plays-each-queue-as-its-own-profile-and-locks-queues-with-a-pin.md)

## Decision

Four additions to `/api/native`. **The authorization and grant model is unchanged**: every
new route takes `X-Plex-Profile-Token`, verifies it with Plex, and reaches a queue only
through `authorizeQueue()` (`server/src/nativeAccess.ts`), which is the body of the old
`planForProfile()` checks moved verbatim — availability, Plex provider, `requires_profile`,
binding uuid and account, then grants derived from that profile's own proof. A stated
refusal answers 400, 404 or 409 (`NativeRequestError`); every other failure stays the 403
these routes always answered.

1. **`GET /api/native/queues/:setId/full` returns the WHOLE ordered queue**, not the lineup
   window (`server/src/nativeQueueDetail.ts`).
   - Every entry is expanded with the engine's own `resolveMember()`, the batch cap and the
     shuffle taken off and an EMPTY watched set, so an item is listed exactly when the
     engine would consider it. Nothing in the file decides what a queue contains.
   - Item state is read the way `nextQueue()` reads it: the queue's private ledger for a
     `watch_history: queue` entry; otherwise Plex `viewOffset`/`viewCount` (in progress),
     the profile's watched set on the home server, or the item's play count on a shared one.
   - Entry order: entries the current lineup draws from, by their first lineup slot; then the
     rest of the Priority lane; then the rest of the pool; each in file order. A lineup item
     is claimed by the FIRST entry holding it that has not claimed it, so one file listed
     twice stays two rows.
   - `lineup.endPosition` is the flattened position of the last lineup item — where the TV
     draws "tonight's lineup ends here". `isNext` marks the lineup head.
   - The authored section window is stamped on the entry's first item that is not watched,
     which is the unit the engine stamps.
   - `layout` is `grid` when movies outnumber episodes over the whole queue, otherwise `list`;
     a tie is `list`. There is no layout setting.
   - A **Rules** queue has no stored order, so its answer is the lineup alone
     (`kind: rules`, `isWholeQueue: false`). A random-order Picks queue sets
     `isLineupShuffled`, because another session can draw a different lineup.
   - Capped at `FULL_QUEUE_MAX_ITEMS` (2000), the same cap a session uses; `isTruncated`
     says when it bit. Artwork is raw Plex paths per `serverId`, read in batches of 100.
2. **`POST /api/native/sessions` accepts an optional `start`**
   `{entryKey, ratingKey, plexServer?, mode: "continue" | "only"}`. Picks queues only (409
   otherwise).
   - `continue`: the picked item, then the rest of ITS entry that is not watched, then the
     engine's lineup with those removed and with this entry's EARLIER items removed.
   - `only`: the picked item alone, and the plan does not refill.
   - **Nothing is marked or skipped.** Earlier unwatched items keep their state and come up
     in a later sitting. No lead window is spent (`led` is empty), because the viewer chose
     the item rather than the queue leading it.
3. **`GET /api/native/history?days=30` is queue → sitting → items** for the verified profile
   (`server/src/nativeHistory.ts`). `days` is clamped to 1–365.
   - **A sitting** is the plays of ONE queue in time order, cut wherever a play starts more
     than **75 minutes** after the previous one ended (exactly 75 stays in the sitting).
     Queues are newest first; sittings newest first; items in watch order inside a sitting.
   - **Exactly two records count** (see the next section for what that leaves out):
     a **native TV play** — a session item with at least one `playing` event, belonging to
     the profile the session was verified as, `finished` on an `ended` or `section-end`
     event, otherwise `partial` at its last position; and a **queue-ledger completion** — a
     `queue_entry_history` row with `is_completed = 1` and a non-zero `completed_at`,
     counted for the profile the queue PLAYS AS (its `requires_profile`, else its binding,
     else the server owner). A ledger row within 15 minutes of a native play of the same
     item in the same queue is that play's own write and is dropped.
   - `native_tv_events` gains a nullable `recorded_at` (epoch ms). A play recorded before it
     existed is dated by its plan's `createdAt` (new) or `expiresAt − 24 h`, and carries
     `isTimeApproximate: true`.
4. **`POST /api/native/queues/:setId/watched`** `{entryKey, ratingKey, plexServer?,
   isWatched}` marks one item of a **queue-owned** entry. Watched is the web's "complete one
   leaf" (`markCompleted`); unwatched forgets that item's ledger row, position included
   (`clearItem`, new), and clears the entry's `done`. Then the ordinary reconcile runs with
   the profile's scoped provider, and the cache generation is bumped. A provider-history
   entry answers **409**: its watched mark lives in Plex, and QueuePilot has no path that
   writes Plex's watched state. The full queue's `canMarkWatched` says which items qualify.

## Context

The native TV played the engine's lineup window — about a dozen items — and showed nothing
beyond it, kept no viewable history, and could not start anywhere but the head. The owner
chose a full queue whose layout follows its content, a history organized by queue and
sitting, history from other Plex apps only when a queue tracks it, and "start here" that
leaves earlier items unwatched. This record is the server half; the player builds against it.

**What the history leaves out, and why.** QueuePilot records a play against a queue in two
places only: native sessions and the queue-owned ledger. A Plex play of an item on a
`watch_history: provider` entry is in Plex's history, attributed to no queue, so no queue
tracks it — including one QueuePilot itself pushed to another Plex app, whose only record is
Plex's own. A `gated_push` row says what was SENT to a screen, not what was watched. A
partial ledger position has no timestamp. The ledger cannot tell a manual "Mark watched" from
a watched completion, so both appear; and because the ledger has no profile column, a
queue-owned completion is credited to the profile the queue plays as.

## Why

- **One authorization path.** Copying the session checks into three new routes would let them
  drift; moving them into `authorizeQueue()` makes the full queue and the mark ask exactly
  the question a playback session asks.
- **The engine lists the queue.** A second resolver in the native layer would disagree with
  the lineup the first time an entry rule changed.
- **75 minutes** is the interval the selected design used, long enough for a meal between
  episodes, short enough that a morning and an evening are two sittings.
- **No Plex scrobble from a mark.** Writing Plex watched state would be a new capability on
  the owner's account, not an API shape; the 409 keeps the boundary visible.

## Evidence

The owner's selections of 2026-10-22, recorded in the private project-notes repository's
decision on the TV full queue and history: layout chosen automatically by content with a tie
going to the list, history by sitting organized by queue, other-app plays only "if a queue
is tracking that watch history", and "Start here" leaving earlier items unwatched.
Implemented and covered by `server/src/nativeTv.test.ts` ("native TV full queue, item start,
and watched marks") and `server/src/nativeHistory.test.ts` with fixture data.
