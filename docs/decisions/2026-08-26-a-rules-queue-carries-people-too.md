# A Rules queue carries people too — the rows were always there, the screen was not

- **Status:** Accepted
- **Date:** 2026-08-26
- **Type:** Product / UI
- **Supersedes:** the `people?: ReactNode` prop comment in `web/src/views/PlayView.tsx`
  ("Null on a Rules card, and that is not an omission"), shipped 2026-08-26 with
  [a landing card says who its queue is for](2026-08-25-a-queue-is-people-plus-an-activity.md)
- **Superseded by:** —

## Decision

**A `source: rotation` pool has the same three trays a `source: queue` queue has, in the same
component, written by the same endpoint.**

1. `DynModal` — the rules editor, reached from `/channels/<id>` → ⚙ Configure — draws
   `PeopleTrays` under Kind tag, as `#dyn-people`. EDIT ONLY, the same constraint
   `#set-people` carries: `queue_people` is keyed on the set id and a set being created has
   not got one yet.
2. A Rules card on the Play landing draws the `PeopleRow` a Picks card draws.
3. **Nothing on the server changed.** `PUT /api/sets/:id/people` never consulted a set's
   kind, `store/migrate/queuePeople.ts` seeds off the group CLAIM and never consulted one
   either, and both are now gated against a rotation pool so neither learns to.

The provider ACCOUNT stays in the card's meta line beside the faces. The two are not
duplicates and must not be folded together — see Why.

## Context

Reported by the owner, 2026-08-26, against the live app:

> "No way to add people to a Rules in QueuePilot. I can't add them here to Shorts nor
> Movies."

Shorts and Movies are the household's two `source: rotation` pools. The Picks editor grew the
trays on 2026-08-25 with WP-5; the Rules editor did not, and the landing card was written to
pass `people={null}` on purpose. So there was no screen anywhere in the app that could file a
person on either pool.

## Why

- **The rows already existed.** Migration day joins a queue to the groups whose `sets:` list
  claims it, and `groups.yaml` claims rotation pools as readily as curated ones — the live
  Younger Kids group claims `shorts`, Older Kids claims `movies_rewatch`. So the data was
  written on the first WP-5 boot and the UI was discarding it. The fixture proves it: the
  landing harness went from zero faces on a Rules card to four, with no migration and no
  write.
- **An account and an audience are two different facts.** The prop comment's argument was
  that a filtered pool is bound to one provider ACCOUNT, which its meta line already names,
  so a tray row would read "Anybody" on every one of them. The first half is true and the
  conclusion does not follow: an account is which Plex profile the Shield signs in as, and a
  tray is who the pool is for. `Shorts` signs in as Younger Kids AND is for Linus — one is a
  credential, the other is a filter. Collapsing them is what made the pools unreachable from
  every people-shaped control in the app.
- **Consistency is not the argument; reachability is.** The people filter, `Tonight`'s Which
  queue? list and Pick all read `queue_people`. A pool nobody can be filed on is a pool none
  of those three can ever offer, and the owner has four of them.
- **It costs the server nothing**, which is the strongest evidence the split was accidental
  rather than designed. There is no kind check to remove.

## Evidence

- Owner quote above, 2026-08-26.
- `e2e/queue-people-test.ts` gains `kids_shorts`, a `source: rotation` pool claimed by the
  `kids` group: migration seeds its trays with the group (count and all), and
  `PUT /api/sets/kids_shorts/people` round-trips a person. 26 assertions, in CI.
- `e2e/shot-rules-people.ts` is the before/after: the landing, and the rules editor with the
  modal open. Before, `#dyn-people` does not exist and no Rules card has a `.qpeople`.
- `e2e/shot-landing-people.ts` asserted the OPPOSITE — "no people row on any Rules card" —
  and warned when one appeared. That line is inverted here rather than deleted, so the
  change of mind is legible in the harness a reader is most likely to run.

## Related

- [A queue is people plus an activity](2026-08-25-a-queue-is-people-plus-an-activity.md) —
  the trays, and the rule that a queue's name is its activity
- [The queue editor is two trays, not a sentence or a roster](2026-08-25-the-queue-editor-is-two-trays-not-a-sentence-or-a-roster.md)
- [A group plays as its own account, not its roster's union](2026-08-25-a-group-plays-as-its-own-account-not-its-rosters-union.md) —
  why a group on a queue must resolve to exactly one provider profile
