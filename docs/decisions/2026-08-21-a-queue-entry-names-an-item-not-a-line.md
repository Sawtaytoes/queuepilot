# A queue entry names an ITEM, not a line — and Pending subtracts what you have watched

- **Status:** Accepted
- **Date:** 2026-08-21
- **Type:** fix / semantics
- **Supersedes:** —
- **Superseded by:** —
- **Extends:** [2026-08-17-pending-is-what-nothing-will-play](2026-08-17-pending-is-what-nothing-will-play.md)

## Decision

Three rules, all of them repairs to the definition of **covered** that the 2026-08-17 record
already set. That record is unchanged; this one adds what it did not say.

1. **A queue entry that names a TITLE covers the item that title resolves to.** Coverage read
   rating keys and collections only, so a bare-string entry contributed nothing. The lookup is
   the ENGINE's own (`engine/resolve.resolveQueueEntry`), so "covered" keeps meaning "is going
   to play" rather than "some item shares this title".
2. **A watched item is not pending.** A **movie** is watched when Plex reports any view
   activity — `viewCount > 0` (Completed) or a `viewOffset > 0` resume point (In Progress);
   both are excluded. A **show** is watched only when `viewedLeafCount >= leafCount`; a series
   with one unplayed episode stays on the list. The state is the **admin's**.
3. **Adding an item a queue already names does not add a second copy.** The check is a
   SECOND, looser identity test (`entryIdentity.findDuplicateItem`) at the add route.
   `queues.entryKey` is **not changed**.

Two things are deliberately out of scope, and both are the owner's call rather than the
implementation's:

- **A queued COLLECTION does not block adding one of its films.** That is coverage, not
  identity, and refusing there would refuse an add he may well mean.
- **Nothing is written to `queues.yaml`.** Backfilling rating keys into the 84 title-only
  entries would make coverage exact and permanent, and it is proposed in the pull request as a
  proposal, not performed.

## Context

> "https://queuepilot.octen.dev/pending, that page shouldn't show stuff I've watched already
> nor stuff already in another queue. I was able to double-add [a show] to my ... anime queue
> (and removed one) because I had 2 copies in there." — owner, 2026-08-21

Three symptoms, one cause. An entry has two possible identities on disk — a rating key or a
bare title — and nothing reconciled them.

Measured against the live config, read-only, with the owner's own watermark (`seen_through: 0`,
so every item in the libraries is "new"): the page listed **2595 rows** and now lists **2162**.
Of the 433 that leave, **366 were already watched** and **67 were already named by a title-only
queue entry**.

## Why

**Why the engine's resolver and not a title index.** The full section listing is already in
memory when Pending runs, so matching titles against it would have cost nothing. It would also
have been a THIRD title matcher, free to disagree with the two that decide what actually plays.
The fixture case that settles it: two library items answer to the same title, and
`resolveTitle` breaks the tie on the LOWEST rating key — so a new arrival that shares a title
with an older film is genuinely **not** what that entry plays, and must stay on the list. An
index would have hidden it.

**Why it is still fast.** The listing is used as a cheap PRE-FILTER instead: a title entry is
looked up only when some new arrival could plausibly be the thing it names, scored with the
engine's own rule and deliberately over-inclusive (a guid hint short-circuits to "resolve it",
because the listing carries no `Guid` and a +100 guid match can ride on a title that matches
nothing). `resolveTitle` never returns an item it scored at or below zero, so nothing the
engine would resolve is dropped by the filter. With a normal watermark the filter suppresses
every lookup and the page costs what it always did.

**Why an unresolvable title covers NOTHING.** A hand-typed title Plex no longer answers to is a
broken entry. Nothing is going to play it — which is exactly what this screen reports — so its
item stays visible rather than being hidden by a guess. The failure direction is "you are told
about something you may already have", never "something disappears".

**Why `entryKey` is untouched.** It is the LINE identity: the Python prune addresses the same
lines by it and `e2e/fixtures/golden/` records what it returns. Widening it to mean "the same
item" would silently re-key existing entries and break parity for a gain that a separate check
gets for free. The five parity oracles pass unchanged.

**Why the duplicate check is at the ROUTE.** `queues.addItem` stays a pure YAML editor with no
Plex dependency, which is what lets every offline gate keep calling it. The route is the one
place every user-initiated add passes through (Pending, the toolbar search, the queue search
row), and it already holds a Plex client and the set's cfg. The check has a **time budget** and
**fails open**: with Plex unreachable an add lands as it always did rather than appearing to
freeze, because this check only ever PREVENTS work.

**Why a started movie counts as watched and a partly-watched show does not.** The asymmetry is
real, not an oversight. A film you stopped 20 minutes in is one film and you have seen part of
it; Plex's own Continue Watching is where it belongs, and Pending is for arrivals you have not
noticed. A series with one unplayed episode still has something to play, which is the entire
reason to queue a series.

**Whose watched state, and the part that is open.** The admin's. `pending.yaml` holds one
watermark and one dismissal list for the whole household, the listing runs on the admin token,
and the owner asked about his own viewing. Plex Home means this is a real question — a
per-profile Pending screen would need an `AccountScope` and per-profile state — and it is
flagged for him to confirm rather than settled here.

## Evidence

- Owner quote above.
- Live config, read-only: 327 entries across 16 queues — **225 by rating key, 79 bare strings
  that are not collections, 18 collections, 5 title-only mappings**. So 84 entries covered
  nothing.
- Gate: `e2e/pending-test.ts`, hermetic and offline, **35 checks**. Against the unfixed server
  it fails 9 of them, and the items it wrongly lists are exactly the reported ones: the show a
  bare-title entry names, the show a `{title:}` mapping names, the fully-watched show, the
  watched movie and the movie left at a resume point. New cases: a title-only entry covers its
  item; a `{title:}` mapping does too; a collection entry still covers its children; a title
  resolves to the item the ENGINE picks and not to a same-titled new arrival; an unresolvable
  title leaves its item pending; only the entries a new arrival could match are looked up; a
  watched movie, a movie at a resume point and a fully-watched show are absent while a show
  with one episode left is present; and adding a rating key that a title line already names is
  refused, while a show the queue does not hold is still added.
- Parity: `engine-parity`, `curated-parity`, `binding-parity`, `set-passthrough-parity` and
  `mark-done-parity` all pass — `entryKey` is byte-identical.
- Timings, `GET /api/pending` against the live Plex with the owner's config copied to `/tmp`,
  median of nine warm runs:

  | Watermark | Before | After | Rows before → after |
  | --- | --- | --- | --- |
  | `seen_through: 0` (his live state; the whole library is "new") | 1.470 s | 1.843 s | 2595 → 2162 |
  | 14 days (3 new arrivals) | 1.446 s | 1.501 s | 3 → 3 |

  The first row is the worst case the code can have: every item is new, so every title entry
  has a plausible candidate and all 84 are resolved. The second is what opening the page
  normally costs.
- Before/after of the list, from fixtures (`e2e/shot-pending-coverage.ts` +
  `e2e/stubs/plex-pending-coverage.mjs`): six arrivals become three, and the three that leave
  are one covered by a bare-title entry, one watched movie and one fully-watched series.

## Still open

- **Whose watched state** — admin today. The owner has not been asked whether a Plex Home
  profile should get its own Pending list.
- **A partly-watched MOVIE is hidden.** Defensible, and the one judgement here he may want the
  other way.
- **The data repair is not done.** 84 live entries still name a title with no rating key.
- **A queued collection still does not block adding one of its films.**
