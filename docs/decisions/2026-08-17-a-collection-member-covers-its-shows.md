# A collection member COVERS its shows, and a pool chooses whether it stays whole

- **Status:** Accepted
- **Date:** 2026-08-17
- **Type:** fix / feature
- **Supersedes:** —
- **Superseded by:** —
- **Builds on:** [a `Collection:` entry contributes ONE batch](2026-08-11-collection-entries-contribute-one-batch-like-show-entries.md),
  [Plex Collections as ordered queue entries](2026-07-21-plex-collections-as-ordered-queue-entries.md)

## Decision

**A `Collection:` member covers its children.** Every show inside a collection member leaves
the filtered pool's rule pool. This is not optional and not a mode — it is the fix for a
collection being in the pool twice.

**How it comes in IS a choice**, per pool, stored as `collection_members`:

| YAML | UI | What the pool gets |
| --- | --- | --- |
| absent (default) / `whole` | **Use collections** | One member, playing through in the collection's own order |
| `split` | **Don't use collections** | One member per child show, each taking its own turn |

Stored **sparsely** — `whole` is the absence of the key — the rule `refill` and `on_complete`
already follow. `GET /api/sets` reports the EFFECTIVE value so the editor's picker never keeps
its own copy of the default.

Strict on write, tolerant on read: `updateSet` **throws** on an unrecognised value, while the
engine reads anything it does not recognise as `whole`. A typo must not silently leave a pool
playing the shape the owner just tried to change, but a hand-edited file must still play.

The control lives in **⚙ Configure**, which is the filtered-pool editor — so "filtered pools
only" holds by construction. Hidden on a `behavior: rewatch` pool, the same call the Lineup box
gets: a rewatch pool draws from watch history, not from members, so the knob would do nothing.

## Context

Owner, 2026-08-17, with a screenshot of the Older Kids Shows pool:

> "if I add the Batman collection which includes some of the shows, I want those shows to not
> show up in the list. What I'm signifying here is I'd prefer the shows get added in-order via
> the collection rather than playing random parts of them."

The screenshot shows **Batman: The Animated Series** twice — once as the collection member, and
again in the Eligible pool as a standalone show alongside Batman Beyond.

`channelBuckets` deduped members against the rule pool by **bucket ratingKey**, and a
collection's bucket key is the *collection's*, which can never equal a child show's. So the
pool played the same shows both ways at once: the collection in order, and its shows again at
random.

The blocklist has always done this correctly — `expandedBlocklist` expands a
`Collection: <name>` entry to its children's ratingKeys. The member path simply never got the
same treatment.

## Why

- **At pool level a collection IS its members.** That is already the blocklist's rule; having
  the include side disagree with the exclude side was the bug.
- **The cover is applied in BOTH modes on purpose.** In `split` it is a no-op for any child
  that resolved — that child is already a member bucket keyed by its own ratingKey. Applying it
  unconditionally leaves one rule to state and to test, rather than a rule with a mode-shaped
  exception.
- **The owner asked for the knob, and named it.** He offered "Preferred Queued items" / "Use
  Collections" / "Don't use Collections" and said *"Not sure how to word this at all"*; shown
  three phrasings he chose his own. The labels are his, the explanatory hint carries the
  meaning, and the hint changes with the selection so each option explains itself.
- **`whole` is the default because it is what he wants** and because it is the reading the
  word "collection" already implies. It does change existing behaviour for a pool that has a
  collection member — which is the point: that behaviour was the bug.
- **A split collection's children inherit its `weight`.** The weight was the collection's share
  of a round; after the split each child asks for that share.

## Evidence

- Owner quote and screenshot above.
- Gate: `e2e/collection-covers-its-shows-test.ts` — hermetic fake client, offline, in CI. Three
  shows, two of them in a collection, and Beast Wars as the control that must survive every
  mode. It fails on the pre-fix engine with exactly the reported shape:

  ```
  FAIL whole: the collection and the show it does not cover — nothing else
    got ["Batman Beyond","Batman: The Animated Series","Beast Wars","Collection: …"]
   want ["Beast Wars","Collection: …"]
  ```

  It also pins that an explicit `whole` equals the absent default, that `splt` reads as `whole`
  rather than as `split`, that split keys each child by its OWN ratingKey and gives it only its
  own episodes, and that a pool with no members keeps its entire rule pool (so the cover cannot
  reach a pool that named no collection).
