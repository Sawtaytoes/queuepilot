# Priority leads a sitting, ahead of an in-progress resume

- **Status:** Accepted
- **Date:** 2026-09-11
- **Type:** product rule / playback semantics / correction
- **Supersedes:** clause §4.4 of
  [Kind is picks or rules](2026-08-23-kind-is-picks-or-rules.md) ("In-progress resume still
  leads when it already would today"), and the sentence in
  [A Priority cooldown is spent only when Priority leads](2026-09-08-a-priority-cooldown-is-spent-only-when-priority-leads.md)
  that calls the in-progress precedence settled and unchanged. Everything else in both records
  stands, including the two-part `led` rule, which this makes easier to satisfy rather than
  weaker.
- **Superseded by:** —

## Decision

The Priority lane supplies the lineup head whenever it holds an eligible entry. An in-progress
member of the Random pool no longer takes the head from it.

The assembly order becomes `priority`, then `resuming`, then the shuffled rest. It was
`resuming`, then `priority`, then the rest.

The in-progress hoist itself is unchanged and still runs. It now orders the POOL only: a
half-watched pool member still leads the shuffled rest, so a sitting with nothing promoted
behaves exactly as it did. An Ordered Queue (`add_as: priority`, empty pool) never reached the
hoist and is untouched.

## Context

The owner scanned the Kevin / Anime card on 2026-09-11 at 05:50, his first scan in days. The
queue holds two promoted entries. The lineup opened on two half-watched shows from the pool and
placed both promoted entries fourth and fifth.

```
[lineup] kevin_anime: add_as=random (shuffled), length=12 -> 12 item(s) from 73 entry(s) [priority 2, pool 71, resuming 3]
[lineup] kevin_anime head: "…" lane=resuming
```

Neither cooldown was involved. Both entries had last led on 2026-09-05 and 2026-09-07, against
a 16h window, so both were eligible and both appear in the lineup. The rule that held them back
was §4.4 alone.

## Why

- **The lane is called Priority.** The owner named it, and the name states the contract: first
  in line. A rule that puts something else first makes the feature look broken, which is how
  this was reported twice in four days.
- **The old rule protected the wrong thing.** It read a half-watched episode as a commitment the
  app must honour first. A promote is the stronger and more recent statement: it is a thing the
  owner did on purpose, for this queue, since the last sitting.
- **Nothing is lost.** The resumed show is still in the lineup, one place lower, and it still
  keeps its resume position. Priority entries are few and the lineup is twelve items.
- **The half of the rule that earned its keep survives.** Inside the pool, a half-watched member
  still leads the shuffle. Without that, a sitting that stopped mid-episode would roll a new
  title instead of finishing the one in progress, which is a different and real complaint.
- **`led` gets simpler, not looser.** Priority now supplies the head whenever the lane is
  non-empty, so the first half of the two-part rule is satisfied by construction. The playback
  cap remains the real test, and the empty-lane guard stays.

## Evidence

- Owner, 2026-09-11: "I scanned the Kevin Anime card for QueuePilot, but it didn't start with my
  priority queue, it started on some other random shows. Why? Priority means it happens first
  before anything else." Then, after the cause was stated and three options were offered, he
  chose *Priority always leads* and added: "You came up with the name 'priority'. It means it's
  first in line." Chat `t3code-6bb5abbb`.
- The production scan above, from the container log at 2026-09-11T05:50:42Z.
- `lead_cooldown` rows for that set: `rk:363034` at 2026-09-07T02:10Z, the Collection entry at
  2026-09-05T02:08Z. Both outside the 16h window.
- `server/src/engine/resolve.ts` — one line: `priority.concat(resuming, rest)`.
- `e2e/priority-lane-test.ts` case 6 pins both halves: a promote leads a half-watched pool
  member and spends its window, and with nothing promoted the half-watched member still leads
  the pool.
