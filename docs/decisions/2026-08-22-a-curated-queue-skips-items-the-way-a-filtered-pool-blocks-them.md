# A curated queue SKIPS items, the way a filtered pool BLOCKS them

- **Status:** Accepted
- **Date:** 2026-08-22
- **Type:** feature / data format
- **Supersedes:** —
- **Superseded by:** —

## Decision

A **queue** set (`source: queue` — both a Curated Pool and an Ordered Queue) gets a
`skipped:` list in `sets.yaml`. It is the curated twin of a filtered pool's `blocklist`, and
deliberately the same shape:

```yaml
- id: demo
  source: queue
  kind: anime
  skipped: [ '5201', '5203' ]
```

Five rules.

1. **It addresses the LEAF — the thing that plays.** On a show entry that is one episode. On
   a `{collection: X}` entry it is one child: a film, or a whole child show. That is what
   "items inside a member" means, and it is what a curated queue had no way to say.
2. **A member is not skippable.** A movie ENTRY is its own leaf, and the way to stop one is
   **Remove**. Skipping it instead would leave a line in `queues.yaml` that can never play and
   says nothing about why. The tile agrees: a movie has no next-up leaf, so the menu offers
   Remove there and Skip only where there is an item inside a member.
3. **It is permanent until it is cleared**, from the queue's **Skipped** panel. There is no
   skip-once and no expiry.
4. **A skip never marks an entry done.** `nextQueue` reports an empty member as `newlyDone`,
   `markDone` writes `done: true`, and the TTL sweep can then delete the line — so an entry
   retired because its last unwatched episode is skipped would make the skip one-way, with
   nothing left to restore. An entry emptied only by skipping still READS as having nothing to
   play; only the WRITE is withheld (`ResolvedMember.emptiedBySkip`).
5. **One word: Skipped.** The YAML key, the API field, the menu row, the panel heading. Not
   "ignore", not "exclude", not "block" — those three names already mean the rotation-side
   feature, and a second name for a second thing is how `blocklist` and `movie_excludes` came
   to need a paragraph each to tell apart.

`PATCH /api/sets/:id` accepts `skipped` on a queue set and **rejects it on a rotation
channel**, where `blocklist` is the same feature under the name that screen already uses. One
set never carries two exclude lists.

**Both live providers honour it.** Plex applies it in `engine/resolve.ts` (and in
`plex.nextEpisode` / `plex.collectionNext`, so the tile's caption cannot name an episode the
next scan will refuse to play); Kavita applies it in its own `buckets()` and `tiles()`, keyed
on chapter ids. The keys live in the PROVIDER's id space, which is safe only because a queue
draws from exactly one provider
([2026-08-13](2026-08-13-a-queue-draws-from-exactly-one-provider.md)) — and it is why the
Skipped panel does **not** run a Plex lookup for a pull set: the two id spaces overlap, so
that lookup would sometimes succeed and name a completely unrelated film. Board games, Steam
and MiSTer have no shared leaf id and are not offered the action.

## Context

> "Add ignores/skips for random queues in QueuePilot. We have excludes, but only for filtered
> queues and not selected." — owner, 2026-08-22

The asymmetry was real and had been there since the Python service. A **Filtered Pool** has
two exclude lists — `blocklist` (drop a show or a collection from the rule pool) and
`movie_excludes` (drop a film from the rewatch draw), both editable on the Pools screen. A
**Curated Pool**, whose whole promise is "members come up in random order", had neither. The
only ways to stop one episode were to remove the entry outright, or to hand-write
`done: true` on it in `queues.yaml` — which `resolve.ts` has always honoured as "a deliberate
skip", in a file the owner does not open.

Asked which level the skip should apply to, the owner chose **items inside a member** and
**Ordered Queue entries too**, permanent, one word.

## Why

- **Removing the entry is the wrong-sized tool.** "Not this episode" and "not this show" are
  different asks, and only the second had an answer. A queue you have to dismantle to steer is
  one you stop steering.
- **`blocklist` already proved the shape.** A flat list of keys on the SET, whole-array replace
  over `PATCH /api/sets/:id`, chips with an undo. Reusing the shape meant the write path, the
  sparse-key rule and the undo snapshot all came for free — and it is why `skipped` is a set
  field rather than a per-entry flag. The things being skipped are episodes and collection
  children, and neither of those has a line in `queues.yaml` to hang a flag on.
- **The tile has to apply the rule too.** A caption naming the episode the next launch will
  refuse to play is worse than no caption: it reads as the feature not working. So the filter
  lives in the engine AND in the two next-up lookups, and `NextEp` gained the leaf's own
  `ratingKey` so the grid can name the item it is about to drop rather than the container it
  lives in.
- **Rule 4 is the expensive one.** It was not obvious: "empty items" is the FINISHED test, and
  finished is persisted and then swept. Without the `emptiedBySkip` carve-out, skipping a
  show's last unwatched episode would retire the entry and the TTL sweep could delete the line
  the skip was supposed to be undoable from. `e2e/skipped-items-test.ts` gates it, together
  with the control that a genuinely fully-watched entry is still retired on the same set.
- **Filtering runs BEFORE the batch cap.** Skipping E2 on an `episodes: 2` entry queues
  E3 + E4, not E3 alone. Gated.

## Evidence

- Owner, 2026-08-22, quoted above, and the four answers that scoped it (level: items inside a
  member, and Ordered Queues too; duration: permanent until cleared; vocabulary: one word).
- `e2e/skipped-items-test.ts` — eleven offline checks over the real `resolveMember` /
  `nextQueue`, including the two write-side claims and the movie-entry rule.
- `e2e/shot-skipped-items.ts` — the same feature driven in a browser against a stub Plex: the
  tile menu's Skip row, the next-up moving from `E1 · Berth 12` to `E2 · Cargo`, and the
  Skipped panel that appears above the grid. Fixture data throughout.
