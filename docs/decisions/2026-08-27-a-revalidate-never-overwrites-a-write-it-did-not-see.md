# A revalidate never overwrites a write it did not see

- **Status:** Accepted
- **Date:** 2026-08-27
- **Type:** bugfix / client state
- **Supersedes:** —
- **Superseded by:** —
- **Builds on:** [a provider read is cached and the page revalidates after it paints](2026-08-26-a-provider-read-is-cached-and-the-page-revalidates-after-it-paints.md)
  — which added the pass this rule constrains

## Decision

`revalidate()` — phase 3, the `/api/queues?fresh=1` pass — commits its payload **only if the
page has written nothing since the request went out**. It records `writeCount()` before the
fetch, reads it again after, and drops the payload when the number moved. It also refuses to
commit while `uiBusy()`, which is the rule `state/live.ts` already follows.

`writeCount()` lives in `lib/api.ts` and counts every non-GET call at CALL time, so a write
still in flight counts too.

Dropping the payload is the whole remedy. There is no retry: the copy on screen is complete,
the only thing the fresh pass adds is newer provider fields, and the next page load runs the
pass again.

## Context

The read cache landed on 2026-08-27 (#234) and put a slow full-payload GET behind every page
load. `e2e/tile-menu-test` started failing on the FIRST CI run that carried both it and the
tile menu (#227), on an assertion that had nothing to do with either change:

```
ok   "Move to the Random pool" PATCHes placement: random
ok   placement is written BEFORE the order, as the drag does
FAIL and the tile is in the pool on screen — it stayed put
Error: nothing in the pool to promote
```

Instrumented locally, the timing is plain: the phase-3 request goes out at **t+2.96 s** and
its answer lands at **t+5.8 s**, which is inside the second the test spends demoting a tile.
The answer describes `queues.yaml` as it was at t+2.96 s — before the write — and
`setState({ data })` painted the entry straight back into the Priority queue it had just left.
The FILE kept the move. Only the screen undid it, and only until the next load.

It reproduced 2 times in 3 locally once `web/dist` was rebuilt. **The stale bundle is why the
first local run of this suite passed:** the e2e harness serves `web/dist`, so a suite run
against a bundle built before the cache landed exercises a frontend with no phase 3 in it at
all.

The live path had already met this race and solved it twice, and neither solution reaches
here:

- the conditional GET 304s when the YAML has not moved — `?fresh=1` re-reads the providers,
  so it always answers 200 with a body;
- `uiBusy()` defers a commit that would land mid-gesture — a tap on a menu row is not a
  gesture and leaves nothing busy.

## Why

- **A write is newer than any answer to a question asked before it.** That is true of every
  in-flight read, not just this one; phase 3 is where it BITES because the pass takes about
  seven seconds, which is long enough for somebody to do something.
- **The screen and the file must not disagree.** A promote that undoes itself a second later
  while `queues.yaml` says otherwise is worse than a slow refresh: the user re-does a move
  that was already saved, and the second write is the one that looks wrong.
- **Drop, do not retry.** A retry costs 566 provider calls against somebody's self-hosted
  Plex and Kavita, and buys a fresher poster on a page that already has one.
- **Count at call time, not on completion.** A PATCH that is still open is the same race one
  beat earlier, and counting on completion would let it through.

## Evidence

- CI run 33050645342 (PR #227, first run carrying both changes) — the failure above.
- `web/src/state/revalidate.test.ts` — three cases: the payload commits when nothing was
  written, it is dropped when a write landed in flight, and `isRevalidating` clears either
  way. The middle one fails without the guard; checked by removing it.
- `e2e/tile-menu-test.ts` — 4 runs of 4 pass with the guard, against a REBUILT `web/dist`;
  2 of 3 failed without it.
