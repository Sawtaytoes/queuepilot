# A skipped item counts as DEALT WITH, so the entry can complete

- **Status:** Accepted
- **Date:** 2026-08-23
- **Type:** correction / reversal
- **Supersedes:** rule 4 of
  [2026-08-22-a-curated-queue-skips-items-the-way-a-filtered-pool-blocks-them](2026-08-22-a-curated-queue-skips-items-the-way-a-filtered-pool-blocks-them.md)
  ("a skip never marks an entry done"). Every other rule in that record stands.
- **Superseded by:** —

## Decision

**A skipped item counts towards an entry being finished, exactly as a watched one does.**

- Watch a show's first nine episodes, skip the tenth: the show is over. The entry is marked
  complete.
- Watch two films of a three-film collection, skip the middle one: the collection is over.

"Nothing left to play" is the finished test, and *skipped* is a decision about that item — not
a gap waiting to be filled.

The rule is "nothing left", not "something was skipped": an entry with E3 and E4 still to play
is not completed by skipping E2.

**Undoing it needs nothing new.** Press Restore, the entry resolves to something playable
again, and `nextQueue`'s existing stale-done recovery revives it and clears the flag — the same
path a returning show has taken since
[2026-08-15](2026-08-15-a-done-entry-revives-when-there-is-something-to-play.md). The carve-out
this record removes was built to protect an undo that was already there.

⚠️ **The one genuine one-way case is a queue with `remove_completed_after` set.** Four live
queues use `24h`. On those, an entry completed this way is deleted from `queues.yaml` once the
window passes, and Restore then has no entry to bring back — you re-add the show. That is what
the TTL already means for every other completion on those queues, which is the point: a skipped
item is not a special kind of unfinished.

## Context

The 2026-08-22 record shipped the feature with the opposite rule, and reasoned itself into it:
"empty items" is the FINISHED test, finished is persisted by `markDone`, and the TTL sweep can
then delete the line — so retiring an entry because its last episode was skipped looked like it
would make the skip one-way. `ResolvedMember.emptiedBySkip` existed to withhold that write.

The owner read the shipped behaviour and rejected it the same day:

> "I'm not sure I understand, but if you finish a show and the last episode is skipped, that
> will mark it complete, right? And if you have 3 movies in a collection, and you skip the
> second one, watching the first and third will mark it complete? That's what I'd expect."
> — owner, 2026-08-23

## Why

- **It is what the word means.** Skipping is a decision, not a deferral. An entry whose every
  remaining item has been either watched or skipped has nothing left in it, and saying otherwise
  makes the queue disagree with the person using it.
- **The carve-out solved a problem that was already solved.** `nextQueue` revives a `done` entry
  the moment it resolves to anything playable, and a completion written by `markDone` carries a
  `done_at`, which is exactly the case the revival covers. Restore → revive → flag cleared, with
  no new machinery. The first cut did not check.
- **It created a state with no exit.** An entry emptied only by skipping was never complete and
  never removable by "Remove all completed": it sat in the queue forever, greyed, reporting
  nothing to play, and the only way out was to delete it by hand — the exact fate `skipped` was
  built to save an entry from.
- **The remaining risk is a TTL, and a TTL is opt-in and already understood.** Trading a
  permanent zombie entry for "a completed entry on a 24h queue is deleted after 24h" is the
  right trade, and the second half is not new behaviour.

## Evidence

- Owner, 2026-08-23, quoted above.
- `e2e/skipped-items-test.ts` — sixteen offline checks. The three that pin this record are
  "watched-then-skipped-the-last completes the entry", "a collection whose children are all
  watched or skipped completes" (the owner's two examples), and the round trip: "restoring the
  skip REVIVES the completed entry" / "…and it plays the episode that was skipped". The control
  "an entry with items left is not completed by a skip" pins the other half.
