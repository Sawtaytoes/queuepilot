# A queue nobody is filed on is never filtered out — and the people filter is written twice

- **Status:** Accepted
- **Date:** 2026-08-25
- **Type:** Bugfix / product rule
- **Supersedes:** —
- **Superseded by:** —

## Decision

The Tonight surface's **Queues** half now applies the people filter, which it never did. Two
rules make that safe, and both are exceptions to the filter as it is usually stated.

### 1. TWO empties are not the same empty

The rule is: a queue shows when **every selected person is on the queue** and **every required
person is selected**. "Nice to have" is the hatch — somebody there never removes the queue.

Read strictly, that rule is false in two cases where it must be true:

| Empty | Strict reading | What it has to do |
| --- | --- | --- |
| **Nobody ticked** | "every required person is selected" is false, so every queue that names anybody is hidden | show everything — a filter with nothing in it matches everything |
| **A queue NOBODY is filed on** | "every selected person is on the queue" is false against an empty roster, so one tick hides it | show it — always |

The first was already known. The second is new, and it is not a corner case: a queue no group
claimed comes up with nobody, which the migration calls the honest answer, and several live
queues are in exactly that state. Hiding them makes them unreachable from this screen.

Both branches live in `queueMatchesSelection()` rather than at either caller, because the draw
and the Which queue? list both read it.

### 2. A GROUP is one member carrying its own count, never its people flattened out

A kids group is "at least one of them". Flattened into its person ids that becomes "all of
them", which is the rule inverted, and the queue would then never come up — the people it names
are hardly ever all in one room at once. `TonightQueue` therefore carries **resolved** members —
a group's required roster plus its `minPresent` — and not two flat lists of person ids.

### 3. The filter is written twice, and a gate compares the two copies

`server/src/queuePeople.ts queueMatchesSelection()` and `web/src/lib/tonight.ts
queueMatchesPeople()` are the same rule in two workspaces that cannot import each other. This is
the same shape as the activity → backend map, and it gets the same treatment:
`e2e/tonight-routing-test.ts` §5b asks both the same questions over one fixture — the server
through a real draw, the browser through `queuesForTonight()` over `/api/sets` +
`/api/queue-people` + `/api/people`.

## Context

WP-5 wrote and tested `queueMatchesSelection()`. WP-7 wired it into `POST /api/tonight/pick`.
Nothing wired it into the form, so **Pick** was people-aware and **Queues** was not: ticking two
people narrowed the draw and left the list beside it offering queues those people are not on.

The peopleless-queue defect was found by the parity gate on its first run, not by reading. The
server hid a peopleless queue as soon as anybody was ticked, which meant Pick could not draw one
either. That had never been asserted either way.

## Why

**The list and the draw answer the same question.** A queue the list offers and the draw would
never choose is a screen disagreeing with itself, and the host cannot see which half is wrong.

**An over-inclusive list is bad; a silently empty one is worse.** So the empty state says which
of the two empties it is. Nobody ticked and no matches means the activity has no queue at all,
and telling the host to untick somebody would send them hunting for a tick that is not there.

**Choosing people is a FILTER, not presence detection.** Nothing in this app detects who is in
the room and nothing may pretend to. Ticking a name narrows the list the way a search field
does — which is also why a filter is never the only way in: scanning an NFC card goes straight
to its queue and never comes near any of this.

## Evidence

- `server/src/queuePeople.test.ts` — "shows a queue NOBODY is filed on, whoever is selected".
- `web/src/lib/tonight.test.ts` — the two empties, the optional hatch, the group's own number,
  and a group nothing knows about taking the queue out of the list.
- `e2e/tonight-routing-test.ts` §5b — ten selections over two tiles, both copies compared, plus
  the group cases the flattened form gets wrong in both directions.
- `e2e/tonight-test.ts` §4b — the three branches of step 5, driven in a browser.
- `e2e/tonight-harness.ts TONIGHT_TRAYS` — the fixture's audience, including one queue with
  nobody, one with a "Nice to have" member and one carrying a group.
