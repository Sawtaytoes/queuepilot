# The landing filters by PEOPLE, and the group chips go — a group stays a rule, not an address

- **Status:** Accepted
- **Date:** 2026-08-26
- **Type:** UX / routing
- **Supersedes:** [A Group is "who is watching", it lives in the path, and explicit membership beats derived](2026-08-17-a-group-is-who-is-watching-not-a-plex-profile.md)
  §3 (the group is in the PATH) and §5 (a row inside a group drops the group's own name);
  [All is an address, not the absence of one](2026-08-19-all-is-an-address-not-the-absence-of-one.md)
  in full; [A queue created on a group page joins that group](2026-08-21-a-queue-created-on-a-group-page-joins-that-group.md)
  in full
- **Superseded by:** —

## Decision

**1. The chip row on `/admin` is a chip per PERSON, and it is multi-select.**

`Anyone`, then the roster in roster order, then the two ⚙ editors. Ticking names narrows the
grid to the queues those people are on. The rule is the one already written down and already
running on the What to Watch/Play screen — every ticked person must be on the queue, every
required member must be ticked, nobody ticked is no filter at all, and a queue nobody is
filed on is never filtered out.

**2. The provider chips stay, unchanged**, as the second axis: `All · Plex · Kavita ·
Board Games`, shown only when more than one backend is reachable.

**3. Both filters live in the QUERY STRING** — `/admin?people=ada,grace&only=kavita`. Each
chip is still a real `<a href>`; every one keeps the other filter as it changes its own.

**4. `/g/<id>` is retired and redirects to `/admin`.** The `play` route is deleted with it.
`localStorage` no longer remembers anything about the landing.

**5. A GROUP IS NOT GOING AWAY.** It keeps its id, its label, its `sets:` claim list, its
`accounts:` map, its roster and its `min_present` count. It is what a queue's Must-be-here
tray points at, it is what "at least one of Xander, Darius or Marcus" is expressed as, and it
is what resolves the ONE provider profile a queue signs in as. What it stops being is a
**shelf label and an address**. Its editor stays one tap away, as `⚙ Edit groups` in the same
row.

**6. A new queue joins no group.** `POST /api/sets` still accepts a `group` and
`fileSetIntoGroup` is still gated; the browser simply has nothing to name, because there is
no group on screen to inherit from. A queue's audience comes from its trays.

## Context

The owner, 2026-08-26, on the chip row:

> "this selection of 'All', 'Kevin', 'Older Kids', etc can go away. We were changing this to
> allow selecting people, and then I can narrow it down from there. We also talked about
> narrowing it down based on the category as well (Plex, Kavita, Board Games, etc). The
> current groups are no longer needed!"

Asked how far "no longer needed" goes — delete the Group object, or drop the chip row — he
chose **drop the chip row and keep the object**, and confirmed the category axis is the
**provider**.

## Why

- **A group as a shelf label could only offer the combinations somebody wrote down in
  advance.** `Bob`, `Bob & Alice`, `Bob & Carol`, `Bob & Erin`, `Family`, `Older Kids`,
  `Younger Kids` — seven chips to maintain, and the eighth pairing needs a new group before
  it can be found. Ticking two names composes the same answer with nothing stored.
- **The two jobs a group was doing pull in opposite directions.** As a RULE it wants to be
  precise, named and stable, because a queue signs into a Plex profile through it. As a LABEL
  it wants to be loose and plentiful. Every argument for adding a group as a filter was an
  argument for a group nobody would ever gate a queue on. Splitting them lets the rule stay
  small.
- **The filter already existed and was already better.** What to Watch/Play has ticked people
  since WP-6, over `queue_people`, and it honours "at least one of the kids" — a group MEMBER
  is not flattened to its people. The Admin landing was asking a coarser question about the
  same data. `membersMatchPeople` is now one function with two callers, so the two screens
  cannot answer differently.
- **The row's own name was already wrong.** `2026-08-17` §5 took the group's name off each
  card, and `accountInGroup` took the account off the meta, because the heading said them
  already. Both were display rules that existed only to undo the group page's own repetition.
  With the page gone they had one caller and one answer, so `lib/setLabel.ts` is deleted
  rather than left as a no-op somebody re-wires later.
- **A path filter is single-select by construction.** That is the whole reason the group
  lived in the path and the provider did not (2026-08-17 §4). People are the case the query
  string was already right for.
- **`localStorage` was answering a question nobody asks any more.** A remembered GROUP made
  sense because a group was a place, and typing the bare domain landed you nowhere in
  particular. A remembered people FILTER is a search field that comes back pre-typed, hiding
  most of the app on a visit that asked for nothing. Bare `/` is the mode landing now, so
  there is no "did not say" to answer.

## What this costs, stated plainly

- **A group page is no longer bookmarkable.** `/g/bob` was linkable, phone-home-screenable
  and shareable, and that was most of the argument for putting it in the path. The nearest
  replacement is `/admin?people=bob`, which is not the same assertion — it says "queues Bob is
  on" rather than "queues filed under the Bob group" — so old bookmarks land on `/admin`
  rather than being translated. Guessing a translation would be worse than not having one.
- **`e2e/group-create-test.ts` is deleted**, along with `shot-groups.ts` and
  `shot-group-create.ts`. It pinned a browser behaviour of a control that no longer exists.
  `groups-test.ts` still pins the WRITE it sat beside.
- **The `All` chip's own decision is superseded outright.** `Anyone` is its replacement and
  keeps the lesson that made it: it is an ADDRESS (the query with `people` removed), not a
  state nothing can navigate to, so tapping it from a filtered view actually clears.

## Evidence

- Owner quote above, 2026-08-26, plus his answers to the three scoping questions.
- `web/src/state/landingFilter.test.ts` — 10 assertions on the two filters as URLs. The one
  that matters is that each keeps the other: ticking a second person must not drop the Kavita
  chip.
- `web/src/state/route.test.ts` — `/g/<id>` parses to `admin` and `canonicalPath` rewrites it.
- `e2e/shot-landing-filter.ts` — the before/after. On the landing fixture, `?people=linus`
  narrows 17 cards to 5: the four rules pools he reaches through the Younger Kids group's
  "at least one of them" rule, plus the one queue nobody is filed on.

## Related

- [A queue is people plus an activity](2026-08-25-a-queue-is-people-plus-an-activity.md) §5 —
  choosing people is a FILTER, and nothing detects presence
- [A queue nobody is filed on is never filtered out](2026-08-25-a-queue-nobody-is-filed-on-is-never-filtered-out.md)
- [A group plays as its own account, not its roster's union](2026-08-25-a-group-plays-as-its-own-account-not-its-rosters-union.md) —
  the job a group keeps
- [A Rules queue carries people too](2026-08-26-a-rules-queue-carries-people-too.md) — what
  makes the rules pools reachable from this filter at all
- [QueuePilot starts with a mode landing](2026-08-26-queuepilot-starts-with-a-mode-landing.md) —
  why this page is `/admin` and not `/`
