# A queue created on a group page joins that group, and the server does the filing

**Status:** Accepted
**Date:** 2026-08-21
**Type:** UX / data model / API
**Supersedes:** —
**Superseded by:** —
**Answers the open question in:**
[2026-08-21 — the Play landing creates a queue from its own link row](2026-08-21-the-play-landing-creates-a-queue-without-un-hiding-the-toolbar.md)
(its Consequences section left this as "a product question for the owner, not something to
infer". He answered it.)
**Builds on, and does not weaken:**
[2026-08-17 — a Group is "who is watching", and explicit membership beats derived](2026-08-17-a-group-is-who-is-watching-not-a-plex-profile.md)
(rule 2 — membership is EXPLICIT-THEN-DERIVED; this writes the explicit half and never
touches the derived one)

## Decision

**1. Creating a set while a group is on screen files that set into that group.** The write is
an append to the group's stored `sets:` — the explicit half of membership. The resolved
`setIds` is derived from `accounts:` at read time and has nowhere to be written, so "file it"
can only ever mean "name it".

**2. The SERVER files it, in the create request.** `POST /api/sets` takes an optional
`group`, writes `sets.yaml`, then appends the new id to `groups.yaml`.

**3. The two writes are ORDERED, not atomic, and the order is the safety.** The set is
written first. A filing that fails therefore leaves an UNFILED queue — visible under `All`,
listed in `GET /api/groups`'s `unassigned`, and one tick away in the groups editor. A failed
filing answers **200 with `groupError`**, never a 400: the queue exists by then, and "Save
failed" would invite a retry that makes a second one. The client says so in the toast.

**4. Every real group qualifies. `all` does not, and is not an error.** `all` is synthesized,
is in no file, and already means "the absence of a filter" everywhere else in the app, so
filing into it is a no-op that returns "filed nowhere". A group whose membership today comes
from `accounts:` rather than by hand **is** a real destination: the append makes the new set
NAMED, so explicit-beats-derived then keeps it there instead of letting an account match pull
it into somebody else's chip. That is the settled rule working, not an exception to it — the
person chose that group by being on its page.

**5. Which group is read off the URL, inside `SetModal`.** Not passed through
`openSetModal`. Three things fall out of that and none of them needed a case:

- The **Ordered Queues toolbar's `#newqueue` is unchanged**, and so is
  **`＋ Curated pool`** on the Pools page. `parsePath` yields a group on the play route
  alone (`/g/<id>`), so on `/queues` and `/channels` there is nothing on screen to join and
  nothing is sent.
- **`＋ Filtered pool` is untouched.** It is `openDynModal`, a different editor, and it lives
  only on `/channels`. Wiring it would be dead code today, not symmetry.
- A **stale bookmark to a deleted group cannot fail a save** — `findGroup` answers null.

**6. The create modal SAYS where it lands** — one line, `Joins <Group> — the group you are
looking at. The groups editor can move it later.` — on create only, and only when a group is
on screen. A **line and not a picker**.

## Context

Reported to the owner, 2026-08-21: a queue created from a group page does not join that
group, it lands in `All`, invisible under the filter that was on screen when it was made.
He answered:

> "It should join wherever I added it."

The gap is older than the button that exposed it. `#154` gave the Play landing its own
`＋ New queue`, and the landing is the **one page in this app that has a group on screen** —
before that, the only create button lived in the Ordered Queues toolbar at `/queues`, where
there is no group and therefore nothing was ever missing. #154 wrote the consequence down and
deliberately refused to guess at it. This record is the answer to that question.

## Why

- **A filter you are standing in is a statement of intent.** The person navigated to Bob,
  looked at Bob's things, and pressed the create button that is *in Bob's chrome*. Filing the
  result anywhere else makes the page lie about itself.
- **Server-side, because a two-request client flow half-fails and nobody is left to notice.**
  The client alternative is `POST /api/sets` then `PATCH /api/groups/:id`. A closed tab, a
  dropped connection or a navigation between the two leaves a queue that exists and belongs
  to nobody — and the only process that knew the intent has gone. One request cannot be
  interrupted between its halves by anything the browser does.
- **The unfiled direction is the recoverable one.** Two YAML files are two writes, so
  something has to be the failure that survives. `unassigned` already exists precisely so an
  unfiled set is *discoverable* rather than lost, which makes it the cheap failure. The
  reverse order — name the id first — could name a set that does not exist.
- **The URL is already the one truth about the active group.** `state/group.ts` is explicit:
  the path wins, storage only answers a `/` that did not say. A second copy travelling
  through the overlay store is a second answer to the same question, and the first thing to
  drift would be a modal opened before a route change.
- **An accounts-only group is not a special case, and treating it as one would be the
  surprise.** Refusing to file into `Kids` because its membership happens to be derived today
  would mean the create button works on some chips and silently not on others, with nothing
  on screen explaining which. The append is exactly the same write in both.
- **A line, not a picker, because the destination is a consequence and not a choice.** A
  control here would offer a decision the route has already made, and would put a second
  membership editor one field away from the real one. The owner asked for "it should join
  wherever I added it" — he did not ask for a filing control. The line is the smaller claim
  and it is the one that stops him guessing.
- **No line when no group is on screen.** With nothing to file into, the app does what it has
  always done: the queue lands in `All`, which is where everything is. A permanent "not
  filed" note on every create from `/queues` would be noise on the common path.

## Evidence

- Owner quote above, 2026-08-21.
- Before/after, driven rather than posed — `e2e/shot-group-create.ts` opens `/g/bob`, presses
  `＋ New queue`, names it and saves, then shoots the same page. Before: `Bob 3`, the card
  absent. After: `Bob 4`, the card first. A third frame shows the everything view on the
  BEFORE build, where the queue *is* present — proof it was created and merely filed nowhere,
  which is the part "the card is missing" does not say by itself.
  **Fixture data, never live** (`e2e/fixtures/landing.*.yaml`, the repo's anonymized cast):
  this repo is public, the frame renders group names, and a PNG is opaque to every grep.
- Gates:
  - `e2e/groups-test.ts` — 19 offline checks, was 14. The five new ones pin the write: a
    created set joins the group that named it and no other; an accounts-only group takes it
    and explicit-beats-derived then keeps it there; filing is idempotent, so a retried save
    cannot double-list an id; `all` and an empty id are no-ops rather than throws; an unknown
    group id throws, so the route can *say* so.
  - `e2e/group-create-test.ts` — new, in CI's always-on browser block. It holds the half
    `groups-test` cannot reach: which group the BROWSER names. Both directions are asserted,
    because they fail opposite ways — filing nothing from `/g/<id>` is the reported bug, and
    filing anything from `/queues` would be a new one that swept every configurator-made
    queue into whichever group the device looked at last.
  - Full suite on the branch: biome clean, four typechecks clean, vitest 121/121, both builds
    clean, `pick-contract` holds, `narrow-scroll` 66/66, `routing` 18/18, `drag-stability` OK,
    `play-reorder`, `pool-editor-keeps-blocked` and `shelf-remove` all pass.
