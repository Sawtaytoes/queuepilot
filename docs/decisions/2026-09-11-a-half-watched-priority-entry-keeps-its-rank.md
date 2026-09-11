# A half-watched Priority entry keeps its rank

- **Status:** Accepted
- **Date:** 2026-09-11
- **Type:** correctness / playback semantics / product rule
- **Supersedes:** nothing. It completes
  [Priority leads a sitting, ahead of an in-progress resume](2026-09-11-priority-leads-a-sitting-ahead-of-an-in-progress-resume.md),
  written the same day, which moved Priority ahead of the pool and left this case open.
- **Superseded by:** —

## Decision

A Priority entry that is IN PROGRESS is not asked the lead gate. It keeps its rank, it is not
reported in `suppressed`, and it is not reported in `led`.

A lead window means *this entry has had its turn*. An entry somebody stopped part way through
has not had its turn. The promise is still owed, so it is neither spent nor re-charged.

The full order is now: the Priority lane in rank order, then in-progress members of the Random
pool, then the shuffled rest.

## Context

The owner asked what happens when he starts the Rank 1 film, closes Plex, eats dinner, and scans
the card again. The answer before this change was Rank 2, and on his real queue it was Rank 2
every time.

Rank 1 leads at 18:00 and spends its 16h window. The rescan at 20:00 is inside that window, so
the gate demotes Rank 1 into the pool and Rank 2 takes the head.

`kevin`, `kevin_ashlee` and `kevin_kids` are all `add_as: random` with `length: 1`. Only the
head contributes on a one-item lineup, so only the head ever spends a window — which means
Rank 2's window is permanently fresh and Rank 2 wins every rescan.

The earlier order hid this. With `resuming` ahead of `priority`, a demoted Rank 1 was hoisted
back to the head by the in-progress rule, so the wrong answer produced the right lineup. Moving
Priority to the front removed the accident and exposed the gate.

## Why

- **The rank is the owner's instruction.** He numbered the lane. A cooldown is a fairness device
  inside that instruction, not a competitor to it.
- **A window is about a COMPLETED turn.** Suppressing an entry the viewer is 40 minutes into
  punishes him for stopping to eat, which is the exact behaviour a rolling window was introduced
  to avoid.
- **The one-item movie queue makes it systematic, not occasional.** A queue where only the head
  contributes can never spend the second entry's window, so the failure repeats on every rescan
  rather than once.
- **It spends nothing.** Re-stamping on each resume would keep pushing a window the entry never
  consumed. A finished film leaves the lane by being done, which is the honest exit.
- **A permanently abandoned entry behaves as it always did.** Before this change an in-progress
  item led every sitting through the pool hoist. It still leads every sitting, now through its
  rank. Demote it or mark it done to move on.

## Evidence

- Owner, 2026-09-11: "If I'm in the middle of the movie, close Plex, eat dinner, then I scan
  again, what will play? Rank 2 in Priority or Rank 1 again? It should be Rank 1. … Priority rank
  first, then half-watched, then random." Chat `t3code-6bb5abbb`.
- Repro against the merged engine, Rank 1 half-watched with only its own window spent:
  `play: [Rank2, Rank1, PoolFilm]`. After the change: `play: [Rank1, Rank2, PoolFilm]`.
- `sets.yaml`: `kevin`, `kevin_ashlee` and `kevin_kids` each carry `add_as: random` and
  `length: 1`.
- `e2e/priority-lane-test.ts` case 6b pins four statements: the head on a spent own window, an
  empty `suppressed`, `led` naming only the fresh promote behind it, and the both-windows-spent
  lineup.
